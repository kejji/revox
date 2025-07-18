const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { DynamoDBClient, PutItemCommand, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { v4: uuidv4 } = require("uuid");

const REGION       = process.env.AWS_REGION;
const QUEUE_URL    = process.env.EXTRACTION_QUEUE_URL;
const TABLE_NAME   = process.env.EXTRACTIONS_TABLE;
const BUCKET_NAME  = process.env.S3_BUCKET;

const sqs = new SQSClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });
const s3  = new S3Client({ region: REGION });

async function createExtraction(req, res) {
  try {
    const { appName, iosAppId, androidAppId, fromDate, toDate } = req.body;
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
        ios_app_id:    { S: iosAppId },
        android_app_id:{ S: androidAppId },
        from_date:     { S: fromDate },
        to_date:       { S: toDate },
        status:        { S: "pending" },
        created_at:    { S: nowISO },
        updated_at:    { S: nowISO }
      }
    }));

    // 2. Publier le message dans SQS
    await sqs.send(new SendMessageCommand({
      QueueUrl:    QUEUE_URL,
      MessageBody: JSON.stringify({
        userId,
        extractionId,
        appName,
        iosAppId,
        androidAppId,
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

module.exports = { createExtraction, getExtractionStatus, downloadExtraction };

async function getExtractionStatus(req, res) {
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
    return res.json({ status: item.status, s3Key: item.s3_key });
  } catch (err) {
    console.error("Erreur getExtractionStatus:", err);
    return res.status(500).json({ error: "Impossible de récupérer le statut" });
  }
}

async function downloadExtraction(req, res) {
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
    if (item.status !== "done" || !item.s3_key) {
      return res.status(400).json({ error: "Extraction not ready" });
    }

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: item.s3_key
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
    return res.json({ url });
  } catch (err) {
    console.error("Erreur downloadExtraction:", err);
    return res.status(500).json({ error: "Impossible de récupérer le fichier" });
  }
}


