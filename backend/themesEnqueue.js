// backend/themesEnqueue.js
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const sqs = new SQSClient({ region: process.env.AWS_REGION });
const THEMES_QUEUE_URL = process.env.THEMES_QUEUE_URL;

// ... tes helpers toAppPk / normalizeAppPkList restent inchangés ...

export async function enqueueThemes(req, res) {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });

  // ✅ log de debug: queue + région (temporaire)
  console.log("[enqueue] REGION =", process.env.AWS_REGION);
  console.log("[enqueue] THEMES_QUEUE_URL =", THEMES_QUEUE_URL);

  if (!THEMES_QUEUE_URL) {
    return res.status(500).json({ error: "THEMES_QUEUE_URL not configured" });
  }
  const isFifo = THEMES_QUEUE_URL.endsWith(".fifo");

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
    const params = {
      QueueUrl: THEMES_QUEUE_URL,
      MessageBody: JSON.stringify(msg),
    };
    // ✅ requis si queue FIFO
    if (isFifo) {
      params.MessageGroupId = pk; // ou "themes"
      params.MessageDeduplicationId = `themes#${pk}#${Date.now()}`;
    }

    console.log("[enqueue] send params (short) =", {
      QueueUrl: params.QueueUrl,
      hasGroup: !!params.MessageGroupId,
      hasDedup: !!params.MessageDeduplicationId,
    });

    const resp = await sqs.send(new SendMessageCommand(params));
    console.log("[enqueue] MessageId =", resp?.MessageId);

    return res.status(202).json({ ok: true, queued: msg, messageId: resp?.MessageId });
  } catch (e) {
    // ✅ loger l’erreur exacte pour diagnostiquer
    console.error("[/themes/enqueue] SendMessage error:", e?.name, e?.message);
    return res.status(500).json({ error: "enqueue_failed", reason: e?.message || "unknown" });
  }
}