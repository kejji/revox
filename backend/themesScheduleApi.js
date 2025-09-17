// backend/themesScheduleApi.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const TABLE = process.env.APPS_THEMES_SCHEDULE_TABLE;
const DEFAULT_INTERVAL = parseInt(process.env.THEMES_DEFAULT_INTERVAL_MINUTES || "1440", 10); // 1/jour

function withIsoDates(item) {
  if (!item) return item;
  return {
    ...item,
    last_enqueued_at_iso: item.last_enqueued_at ? new Date(item.last_enqueued_at).toISOString() : null,
    next_run_at_iso: item.next_run_at ? new Date(item.next_run_at).toISOString() : null,
  };
}

const appPk = (platform, bundleId) => `${String(platform).toLowerCase()}#${bundleId}`;

export async function upsertThemesSchedule(req, res) {
  try {
    const userId = req.auth?.sub;
    if (!userId) return res.status(401).json({ error: "unauthorized" });

    const { appName, platform, bundleId, interval_minutes, enabled } = req.body || {};
    if (!appName || !platform || !bundleId) return res.status(400).json({ error: "appName, platform and bundleId are required" });
    if (!TABLE) return res.status(500).json({ error: "missing_APPS_THEMES_SCHEDULE_TABLE" });

    const pk = appPk(platform, bundleId);
    const current = await ddb.send(new GetCommand({ TableName: TABLE, Key: { app_pk: pk } }));
    const now = Date.now();

    const interval = Number.isFinite(interval_minutes) ? Number(interval_minutes) : (current.Item?.interval_minutes ?? DEFAULT_INTERVAL);
    const isEnabled = typeof enabled === "boolean" ? enabled : (current.Item?.enabled ?? true);

    if (!current.Item) {
      const item = {
        app_pk: pk,
        due_pk: "DUE",
        appName,
        interval_minutes: interval,
        enabled: isEnabled,
        next_run_at: now,
        last_enqueued_at: 0
      };
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(app_pk)"
      }));
      return res.status(201).json({ ok: true, schedule: withIsoDates(item), created: true });
    }

    const expr = [];
    const values = {};
    if (current.Item.interval_minutes !== interval) { expr.push("interval_minutes = :interval"); values[":interval"] = interval; }
    if (current.Item.enabled !== isEnabled) { expr.push("enabled = :enabled"); values[":enabled"] = isEnabled; }

    if (expr.length === 0) return res.json({ ok: true, schedule: withIsoDates(current.Item), updated: false });

    const update = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { app_pk: pk },
      UpdateExpression: "SET " + expr.join(", "),
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW"
    }));

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

    const { platform, bundleId } = req.query || {};
    if (!platform || !bundleId) return res.status(400).json({ error: "platform and bundleId are required" });

    const pk = appPk(platform, bundleId);
    const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { app_pk: pk } }));
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
    const exclusiveStartKey = req.query?.cursor ? JSON.parse(Buffer.from(String(req.query.cursor), "base64").toString("utf8")) : undefined;

    const out = await ddb.send(new ScanCommand({
      TableName: TABLE,
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey
    }));

    const nextCursor = out.LastEvaluatedKey ? Buffer.from(JSON.stringify(out.LastEvaluatedKey)).toString("base64") : null;
    return res.json({ ok: true, items: (out.Items || []).map(withIsoDates), nextCursor });
  } catch (e) {
    console.error("listThemesSchedules error", e);
    return res.status(500).json({ error: "internal_error", details: String(e?.message || e) });
  }
}
