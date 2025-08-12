// backend/ingest.js
import dotenv from "dotenv";
dotenv.config();

import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const REGION    = process.env.AWS_REGION;
const QUEUE_URL = process.env.EXTRACTION_QUEUE_URL; // à renommer plus tard -> INGEST_QUEUE_URL

const sqs = new SQSClient({ region: REGION });

// POST /reviews/ingest
export async function dispatchIncrementalIngest(req, res) {
  try {
    const { appName, platform, bundleId, backfillDays } = req.body || {};
    if (!appName || !platform || !bundleId) {
      return res.status(400).json({ error: "appName, platform et bundleId sont requis" });
    }

    const payload = {
      mode: "incremental",
      appName: String(appName),
      platform: String(platform).toLowerCase(), // "android" | "ios"
      bundleId: String(bundleId),
      backfillDays: Number.isFinite(Number(backfillDays)) ? Number(backfillDays) : 2
    };

    await sqs.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(payload)
    }));
    return res.status(202).json({ ok: true, queued: payload });
  } catch (err) {
    console.error("Erreur dispatchIncrementalIngest:", err);
    return res.status(500).json({ error: "Impossible d’enqueuer le job incrémental" });
  }
}
