// backend/schedule.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import dotenv from "dotenv";
dotenv.config();

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const TABLE = process.env.APPS_INGEST_SCHEDULE_TABLE || "apps_ingest_schedule";
const DEFAULT_INTERVAL = parseInt(process.env.DEFAULT_INGEST_INTERVAL_MINUTES || "120", 10);

// Normalise le format de clé unifiée: "<platform>#<bundleId>"
const appPk = (platform, bundleId) => `${String(platform).toLowerCase()}#${bundleId}`;

export async function upsertSchedule(req, res) {
  try {
    const userId = req.auth?.sub; // protégé par JWT
    if (!userId) return res.status(401).json({ error: "unauthorized" });

    const { appName, platform, bundleId, interval_minutes, enabled } = req.body || {};
    if (!appName || !platform || !bundleId) return res.status(400).json({ error: "appNae, platform and bundleId are required" });

    const pk = appPk(platform, bundleId);

    // On lit l'existant
    const current = await ddb.send(new GetCommand({ TableName: TABLE, Key: { app_pk: pk } }));
    const now = Date.now();

    // Valeurs résolues
    const interval = Number.isFinite(interval_minutes) ? Number(interval_minutes) : (current.Item?.interval_minutes ?? DEFAULT_INTERVAL);
    const isEnabled = typeof enabled === "boolean" ? enabled : (current.Item?.enabled ?? true);

    // S'il n'existe pas, on le crée avec due_pk et un next_run_at légèrement échelonné
    if (!current.Item) {
      const jitter = Math.floor(Math.random() * interval * 60 * 1000); // 0..interval
      const item = {
        app_pk: pk,
        due_pk: "DUE",
        appName: appName,
        interval_minutes: interval,
        enabled: isEnabled,
        next_run_at: now + jitter,
        last_enqueued_at: 0
      };
      await ddb.send(new PutCommand({
        TableName: TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(app_pk)"
      }));
      return res.status(201).json({ ok: true, schedule: item, created: true });
    }

    // Sinon, mise à jour partielle (on ne touche pas next_run_at sauf si on vient de désactiver)
    const expr = [];
    const values = {};
    if (current.Item.interval_minutes !== interval) { expr.push("interval_minutes = :interval"); values[":interval"] = interval; }
    if (current.Item.enabled !== isEnabled)         { expr.push("enabled = :enabled");           values[":enabled"]  = isEnabled; }

    if (expr.length === 0) return res.json({ ok: true, schedule: current.Item, updated: false });

    const update = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { app_pk: pk },
      UpdateExpression: "SET " + expr.join(", "),
      ExpressionAttributeValues: values,
      ReturnValues: "ALL_NEW"
    }));

    return res.json({ ok: true, schedule: update.Attributes, updated: true });
  } catch (e) {
    console.error("upsertSchedule error", e);
    return res.status(500).json({ error: "internal_error", details: String(e?.message || e) });
  }
}

export async function getSchedule(req, res) {
  try {
    const userId = req.auth?.sub;
    if (!userId) return res.status(401).json({ error: "unauthorized" });

    const { platform, bundleId } = req.query || {};
    if (!platform || !bundleId) return res.status(400).json({ error: "platform and bundleId are required" });

    const pk = appPk(platform, bundleId);
    const out = await ddb.send(new GetCommand({ TableName: TABLE, Key: { app_pk: pk } }));
    if (!out.Item) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true, schedule: out.Item });
  } catch (e) {
    console.error("getSchedule error", e);
    return res.status(500).json({ error: "internal_error", details: String(e?.message || e) });
  }
}

// Liste paginée simple (scan) — pratique pour audit ; pour gros volumes, on pourra lister par GSI/curseur
export async function listSchedules(req, res) {
  try {
    const userId = req.auth?.sub;
    if (!userId) return res.status(401).json({ error: "unauthorized" });

    const limit = Math.max(1, Math.min(200, parseInt(req.query?.limit || "50", 10)));
    const exclusiveStartKey = req.query?.cursor ? JSON.parse(Buffer.from(String(req.query.cursor), "base64").toString("utf8")) : undefined;

    const out = await ddb.send(new ScanCommand({
      TableName: TABLE,
      Limit: limit,
      ExclusiveStartKey: exclusiveStartKey
    }));

    const nextCursor = out.LastEvaluatedKey ? Buffer.from(JSON.stringify(out.LastEvaluatedKey)).toString("base64") : null;

    return res.json({ ok: true, items: out.Items || [], nextCursor });
  } catch (e) {
    console.error("listSchedules error", e);
    return res.status(500).json({ error: "internal_error", details: String(e?.message || e) });
  }
}
