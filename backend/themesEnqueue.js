// backend/themesEnqueue.js
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({ region: process.env.AWS_REGION });
const THEMES_QUEUE_URL = process.env.THEMES_QUEUE_URL;

// Normaliser app_pk à partir de (app_pk) ou (platform + bundleId)
function toAppPk({ app_pk, platform, bundleId }) {
  if (app_pk) return String(app_pk);
  if (platform && bundleId) return `${String(platform).toLowerCase()}#${bundleId}`;
  return null;
}

// Contrôleur Express
export async function enqueueThemes(req, res) {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });

  if (!THEMES_QUEUE_URL) {
    return res.status(500).json({ error: "THEMES_QUEUE_URL not configured" });
  }

  const { app_pk, platform, bundleId, from, to, limit } = req.body || {};
  const pk = toAppPk({ app_pk, platform, bundleId });
  if (!pk) {
    return res.status(400).json({ error: "Provide either app_pk or (platform and bundleId)" });
  }

  const msg = { app_pk: pk };
  if (from) msg.from = new Date(from).toISOString();
  if (to)   msg.to   = new Date(to).toISOString();
  if (limit != null) {
    const n = Math.max(1, Math.min(2000, Number(limit)));
    if (!Number.isFinite(n)) return res.status(400).json({ error: "limit must be a number" });
    msg.limit = n;
  }

  try {
    await sqs.send(new SendMessageCommand({
      QueueUrl: THEMES_QUEUE_URL,
      MessageBody: JSON.stringify(msg),
      // si ta queue est FIFO : décommente
      // MessageGroupId: pk,
      // MessageDeduplicationId: `themes#${pk}#${Date.now()}`
    }));

    return res.status(202).json({ ok: true, queued: msg });
  } catch (e) {
    console.error("[/themes/enqueue] error:", e?.message || e);
    return res.status(500).json({ error: "enqueue_failed" });
  }
}
