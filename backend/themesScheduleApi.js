// backend/themesScheduleApi.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const TABLE = process.env.APPS_THEMES_SCHEDULE_TABLE;
const DEFAULT_INTERVAL = parseInt(
  process.env.THEMES_DEFAULT_INTERVAL_MINUTES || "1440",
  10
); // 1/jour

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
  // PRIORITÉ: si app_pk est fourni, on le normalise (gère multi-apps).
  if (body?.app_pk) return normalizeAppPkList(body.app_pk);
  // fallback: (platform,bundleId)
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
  return {
    ...item,
    last_enqueued_at_iso: item.last_enqueued_at
      ? new Date(item.last_enqueued_at).toISOString()
      : null,
    next_run_at_iso: item.next_run_at ? new Date(item.next_run_at).toISOString() : null,
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

    // appName devient libre: pour un duo on peut mettre "Fortuneo (iOS+Android)" par ex.
    const appName = body.appName ?? null;
    const wantedInterval = Number.isFinite(+body.interval_minutes)
      ? +body.interval_minutes
      : undefined;
    const wantedEnabled =
      typeof body.enabled === "boolean" ? body.enabled : undefined;

    const current = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { app_pk } })
    );

    const now = Date.now();
    const interval =
      wantedInterval ?? current.Item?.interval_minutes ?? DEFAULT_INTERVAL;
    const isEnabled =
      wantedEnabled ?? (current.Item?.enabled ?? true);

    if (!current.Item) {
      const item = {
        app_pk,
        due_pk: "DUE",
        appName,
        interval_minutes: interval,
        enabled: isEnabled,
        next_run_at: now,
        last_enqueued_at: 0,
      };
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: item,
          ConditionExpression: "attribute_not_exists(app_pk)",
        })
      );
      return res.status(201).json({ ok: true, schedule: withIsoDates(item), created: true });
    }

    const expr = [];
    const values = {};
    if (appName !== null && current.Item.appName !== appName) {
      expr.push("appName = :appName");
      values[":appName"] = appName;
    }
    if (current.Item.interval_minutes !== interval) {
      expr.push("interval_minutes = :interval");
      values[":interval"] = interval;
    }
    if (current.Item.enabled !== isEnabled) {
      expr.push("enabled = :enabled");
      values[":enabled"] = isEnabled;
    }

    if (expr.length === 0) {
      return res.json({ ok: true, schedule: withIsoDates(current.Item), updated: false });
    }

    const update = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { app_pk },
        UpdateExpression: "SET " + expr.join(", "),
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      })
    );

    return res.json({ ok: true, schedule: withIsoDates(update.Attributes), updated: true });
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

    const out = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { app_pk } })
    );
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
      new ScanCommand({
        TableName: TABLE,
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey,
      })
    );

    const nextCursor = out.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(out.LastEvaluatedKey)).toString("base64")
      : null;
    return res.json({
      ok: true,
      items: (out.Items || []).map(withIsoDates),
      nextCursor,
    });
  } catch (e) {
    console.error("listThemesSchedules error", e);
    return res.status(500).json({ error: "internal_error", details: String(e?.message || e) });
  }
}