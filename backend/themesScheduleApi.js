// backend/themesScheduleApi.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const REGION = process.env.AWS_REGION;
const TABLE  = process.env.APPS_THEMES_SCHEDULE_TABLE;
const DEFAULT_INTERVAL = parseInt(
  process.env.THEMES_DEFAULT_INTERVAL_MINUTES || "1440",
  10
); // 1/jour

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

// --- helpers ---
function normalizeAppPkList(app_pk_raw) {
  const parts = String(app_pk_raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set(parts)).sort().join(",");
}
function singleAppPk(platform, bundleId) {
  if (!platform || !bundleId) return null;
  return `${String(platform).toLowerCase()}#${bundleId}`;
}
function resolveAppPkFromBody(body) {
  if (body?.app_pk) return normalizeAppPkList(body.app_pk);
  const one = singleAppPk(body?.platform, body?.bundleId);
  return one ? normalizeAppPkList(one) : null;
}
function resolveAppPkFromQuery(qs) {
  if (qs?.app_pk) return normalizeAppPkList(qs.app_pk);
  const one = singleAppPk(qs?.platform, qs?.bundleId);
  return one ? normalizeAppPkList(one) : null;
}
function withIsoDates(item) {
  if (!item) return item;
  const tsToIso = (ts) => (Number.isFinite(+ts) && +ts > 0 ? new Date(+ts).toISOString() : null);
  return {
    ...item,
    last_enqueued_at_iso: item.last_enqueued_at_iso ?? tsToIso(item.last_enqueued_at),
    next_run_at_iso: item.next_run_at_iso ?? tsToIso(item.next_run_at),
  };
}

// --- API ---
export async function upsertThemesSchedule(req, res) {
  try {
    const userId = req.auth?.sub;
    if (!userId) return res.status(401).json({ error: "unauthorized" });
    if (!TABLE) return res.status(500).json({ error: "missing_APPS_THEMES_SCHEDULE_TABLE" });

    const body = req.body || {};
    const app_pk = resolveAppPkFromBody(body);
    if (!app_pk) {
      return res
        .status(400)
        .json({ error: "Provide app_pk (comma-separated) OR platform & bundleId" });
    }

    const appName = body.appName ?? null;
    const interval = Number.isFinite(+body.interval_minutes) ? +body.interval_minutes : DEFAULT_INTERVAL;
    const isEnabled = typeof body.enabled === "boolean" ? body.enabled : true;

    const now = Date.now();
    // ⬇️ Prochain run = demain (ou maintenant + interval)
    const nextRunAt = now + interval * 60_000;

    const item = {
      app_pk,
      due_pk: "DUE",
      appName,
      interval_minutes: interval,
      enabled: isEnabled,
      last_enqueued_at: 0,
      next_run_at: nextRunAt,
      last_enqueued_at_iso: null,
      next_run_at_iso: new Date(nextRunAt).toISOString(),
    };

    await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));

    const resp = { ok: true, schedule: withIsoDates(item), created: true };

    // ⬇️ RUN NOW (par défaut). Désactive avec ?run_now=false
    const runNowFlag = (req.query.run_now ?? "true").toString().toLowerCase() !== "false";
    if (runNowFlag) {
      try {
        const lambda = new LambdaClient({ region: REGION });
        await lambda.send(
          new InvokeCommand({
            FunctionName: process.env.THEMES_SCHEDULER_FUNCTION_NAME, // "revox-themes-scheduler"
            InvocationType: "Event", // async
            Payload: Buffer.from(JSON.stringify({})),
          })
        );
        resp.run_now = { ok: true };
      } catch (e) {
        console.error("[themes.schedule] run_now invoke error:", e?.message || e);
        resp.run_now = { ok: false, error: "invoke_failed" };
      }
    } else {
      resp.run_now = { ok: false, skipped: true };
    }

    return res.status(201).json(resp);
  } catch (e) {
    console.error("upsertThemesSchedule error", e);
    return res.status(500).json({ error: "internal_error", details: String(e?.message || e) });
  }
}

export async function getThemesSchedule(req, res) {
  try {
    const userId = req.auth?.sub;
    if (!userId) return res.status(401).json({ error: "unauthorized" });
    if (!TABLE) return res.status(500).json({ error: "missing_APPS_THEMES_SCHEDULE_TABLE" });

    const app_pk = resolveAppPkFromQuery(req.query || {});
    if (!app_pk) {
      return res
        .status(400)
        .json({ error: "Provide app_pk (comma-separated) OR platform & bundleId" });
    }

    const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { app_pk } }));
    if (!out.Item) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true, schedule: withIsoDates(out.Item) });
  } catch (e) {
    console.error("getThemesSchedule error", e);
    return res.status(500).json({ error: "internal_error", details: String(e?.message || e) });
  }
}

export async function listThemesSchedules(req, res) {
  try {
    const userId = req.auth?.sub;
    if (!userId) return res.status(401).json({ error: "unauthorized" });
    if (!TABLE) return res.status(500).json({ error: "missing_APPS_THEMES_SCHEDULE_TABLE" });

    const limit = Math.max(1, Math.min(200, parseInt(req.query?.limit || "50", 10)));
    const exclusiveStartKey = req.query?.cursor
      ? JSON.parse(Buffer.from(String(req.query.cursor), "base64").toString("utf8"))
      : undefined;

    const out = await ddb.send(
      new ScanCommand({ TableName: TABLE, Limit: limit, ExclusiveStartKey: exclusiveStartKey })
    );

    const nextCursor = out.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(out.LastEvaluatedKey)).toString("base64")
      : null;
    return res.json({ ok: true, items: (out.Items || []).map(withIsoDates), nextCursor });
  } catch (e) {
    console.error("listThemesSchedules error", e);
    return res.status(500).json({ error: "internal_error", details: String(e?.message || e) });
  }
}