// backend/themesEnqueue.js
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";

const REGION = process.env.AWS_REGION;
const THEMES_QUEUE_URL = process.env.THEMES_QUEUE_URL;
const THEMES_TABLE = process.env.APPS_THEMES_TABLE;

const sqs = new SQSClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

function todayYMD() { return new Date().toISOString().slice(0, 10); }
function normalizeAppPkList(app_pk_raw) {
  const parts = String(app_pk_raw || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  return Array.from(new Set(parts)).sort().join(",");
}
function toAppPk({ app_pk, platform, bundleId }) {
  if (app_pk) return normalizeAppPkList(app_pk);
  if (platform && bundleId) return `${String(platform).toLowerCase()}#${bundleId}`;
  return null;
}
function makeJobId({ app_pk, limit, from, to, day }) {
  const payload = JSON.stringify({ app_pk, limit: limit ?? null, from: from ?? null, to: to ?? null, day });
  return "job_" + crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export async function enqueueThemes(req, res) {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
  if (!THEMES_QUEUE_URL) return res.status(500).json({ error: "missing_THEMES_QUEUE_URL" });
  if (!THEMES_TABLE) return res.status(500).json({ error: "missing_APPS_THEMES_TABLE" });

  // paramètres d’entrée
  const pk = toAppPk(req.body || {});
  if (!pk) return res.status(400).json({ error: "app_pk or (platform,bundleId) required" });

  const limit = (req.body && Number(req.body.limit)) || undefined;
  const from = (req.body && req.body.from) || undefined;
  const to = (req.body && req.body.to) || undefined;

  try {
    const day = todayYMD();
    const pkStable = normalizeAppPkList(pk);
    const job_id = makeJobId({ app_pk: pkStable, limit, from, to, day });

    const msg = { app_pk: pkStable, limit, from, to, job_id, day };

    // 1) enqueue SQS
    const resp = await sqs.send(new SendMessageCommand({
      QueueUrl: THEMES_QUEUE_URL,
      MessageBody: JSON.stringify(msg),
    }));
    console.log("[enqueue] MessageId =", resp?.MessageId, "job_id=", job_id);

    // 2) marqueur pending (idempotent)
    await ddbDoc.send(new PutCommand({
      TableName: THEMES_TABLE,
      Item: {
        app_pk: pkStable,
        sk: `pending#${day}#${job_id}`,
        job_id,
        selection: { limit: limit ?? undefined, from: from ?? undefined, to: to ?? undefined },
        created_at: new Date().toISOString(),
      },
      ConditionExpression: "attribute_not_exists(app_pk) AND attribute_not_exists(sk)"
    })).catch(e => {
      if (e?.name === "ConditionalCheckFailedException") {
        console.log("[enqueue] pending déjà présent → OK (idempotent)");
      } else {
        console.warn("[enqueue] pending write failed:", e?.name, e?.message);
      }
    });

    return res.status(202).json({ ok: true, job_id, day, messageId: resp?.MessageId });
  } catch (e) {
    console.error("[/themes/enqueue] error:", e?.name, e?.message);
    return res.status(500).json({ error: "enqueue_failed", reason: e?.message || "unknown" });
  }
}