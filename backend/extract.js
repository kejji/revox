import dotenv from "dotenv";
dotenv.config();

import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient, PutItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { v4 as uuidv4 } from "uuid";

const REGION       = process.env.AWS_REGION;
const QUEUE_URL    = process.env.EXTRACTION_QUEUE_URL;
const TABLE_NAME   = process.env.EXTRACTIONS_TABLE;
const BUCKET_NAME  = process.env.S3_BUCKET;

const sqs = new SQSClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
console.log("EXTRACTIONS_TABLE =", TABLE_NAME);

export async function createExtraction(req, res) {
  try {
    const { appName, bundleId, platform, fromDate, toDate } = req.body;
    const userId      = req.auth.sub;           // récupéré par express-jwt
    const extractionId = uuidv4();
    const nowISO      = new Date().toISOString();

    // 1. Écrire l’item "pending" dans DynamoDB
    await ddb.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: {
        user_id:       { S: userId },
        extraction_id: { S: extractionId },
        app_name:      { S: appName },
        platform:      { S: platform },
        app_id:        { S: bundleId },
        from_date:     { S: fromDate },
        to_date:       { S: toDate },
        status:        { S: "pending" },
        created_at:    { S: nowISO },
        updated_at:    { S: nowISO }
      }
    }));

    console.log("Envoi SQS avec :", { platform, bundleId });
    // 2. Publier le message dans SQS
    await sqs.send(new SendMessageCommand({
      QueueUrl:    QUEUE_URL,
      MessageBody: JSON.stringify({
        userId,
        extractionId,
        appName,
        platform,
        bundleId,
        fromDate,
        toDate
      })
    }));

    // 3. Répondre immédiatement avec l’ID
    return res.status(202).json({ extractionId });
  } catch (err) {
    console.error("Erreur createExtraction:", err);
    return res.status(500).json({ error: "Impossible de lancer l’extraction" });
  }
}

export async function getExtractionStatus(req, res) {
  try {
    const extractionId = req.params.id;
    const userId = req.auth.sub;

    const data = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        user_id:       { S: userId },
        extraction_id: { S: extractionId }
      }
    }));

    if (!data.Item) {
      return res.status(404).json({ error: "Extraction not found" });
    }

    const item = unmarshall(data.Item);
    return res.json({ status: item.status });
  } catch (err) {
    console.error("Erreur getExtractionStatus:", err);
    return res.status(500).json({ error: "Impossible de récupérer le statut" });
  }
}

export async function downloadExtraction(req, res) {
  try {
    const extractionId = req.params.id;
    const userId = req.auth.sub;

    // Vérifier que l’extraction existe
    const data = await ddb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        user_id:       { S: userId },
        extraction_id: { S: extractionId }
      }
    }));

    if (!data.Item) {
      return res.status(404).json({ error: "Extraction not found" });
    }

    const item = unmarshall(data.Item);

    // Gérer le cas d'erreur
    if (item.status === "error") {
      return res.status(500).json({ error: "Extraction failed" });
    }

    // Seul le statut "done" permet le téléchargement
    if (item.status !== "done") {
      return res.status(400).json({ error: "Extraction not completed yet" });
    }

    if (!item.s3_key) {
      return res.status(500).json({ error: "No S3 key available" });
    }

    // Générer l’URL signée
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: item.s3_key
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 }); // 1h
    return res.json({ url: signedUrl });

  } catch (err) {
    console.error("Erreur downloadExtraction:", err);
    return res.status(500).json({ error: "Impossible de générer le lien de téléchargement" });
  }
}

// --- Dispatcher pour l’ingestion incrémentale vers APP_REVIEWS ---
// Objectif: pousser un message SQS compris par le worker "incremental"
// Corps attendu (POST): { appName, platform, bundleId, backfillDays? }

export async function dispatchIncrementalIngest(req, res) {
  try {
    const { appName, platform, bundleId, backfillDays } = req.body || {};

    if (!appName || !platform || !bundleId) {
      return res.status(400).json({
        error: "appName, platform et bundleId sont requis"
      });
    }

    const payload = {
      mode: "incremental",
      appName: String(appName),
      platform: String(platform).toLowerCase(),       // "android" | "ios"
      bundleId: String(bundleId),
      backfillDays: Number.isFinite(Number(backfillDays)) ? Number(backfillDays) : 2
    };

    await sqs.send(new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: JSON.stringify(payload)
    }));

    return res.status(202).json({
      ok: true,
      queued: payload
    });
  } catch (err) {
    console.error("Erreur dispatchIncrementalIngest:", err);
    return res.status(500).json({ error: "Impossible d’enqueuer le job incrémental" });
  }
}


