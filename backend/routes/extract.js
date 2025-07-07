const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { v4: uuidv4 } = require("uuid");

const REGION       = process.env.AWS_REGION;
const QUEUE_URL    = process.env.EXTRACTION_QUEUE_URL;
const TABLE_NAME   = process.env.EXTRACTIONS_TABLE;

const sqs = new SQSClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

async function createExtraction(req, res) {
  try {
    const { appName, fromDate, toDate } = req.body;
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
      MessageBody: JSON.stringify({ userId, extractionId })
    }));

    // 3. Répondre immédiatement avec l’ID
    return res.status(202).json({ extractionId });
  } catch (err) {
    console.error("Erreur createExtraction:", err);
    return res.status(500).json({ error: "Impossible de lancer l’extraction" });
  }
}

module.exports = { createExtraction };

