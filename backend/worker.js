import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const s3 = new S3Client({ region: "eu-west-3" });
const db = new DynamoDBClient({ region: "eu-west-3" });

exports.handler = async (event) => {
  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body);
      const { userId, extractionId, appName, fromDate, toDate } = message;

      // 🔧 Étape 1 : générer le contenu CSV fictif
      const content = `app_name,from,to,data\n${appName},${fromDate},${toDate},123`;

      // 🔧 Étape 2 : envoyer vers S3
      const s3Key = `csv/${userId}/${extractionId}.csv`;
      await s3.send(new PutObjectCommand({
        Bucket: "revox-csv", // ajuste si ton bucket a un autre nom
        Key: s3Key,
        Body: content,
        ContentType: "text/csv",
      }));

      // 🔧 Étape 3 : mettre à jour DynamoDB
      await db.send(new UpdateItemCommand({
        TableName: "revox_extractions",
        Key: {
          user_id: { S: userId },
          extraction_id: { S: extractionId },
        },
        UpdateExpression: "SET #s = :s, s3_key = :k",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": { S: "done" },
          ":k": { S: s3Key }
        }
      }));
    } catch (error) {
      console.error("Erreur dans le worker", error);
      if (message?.user_id && message?.extraction_id) {
        try {
          await db.send(new UpdateItemCommand({
            TableName: "revox_extractions",
            Key: {
              user_id: { S: message.user_id },
              extraction_id: { S: message.extraction_id },
            },
            UpdateExpression: "SET #s = :s, error_message = :msg, updated_at = :now",
            ExpressionAttributeNames: {
              "#s": "status"
            },
            ExpressionAttributeValues: {
              ":s":   { S: "error" },
              ":msg": { S: error.message || "Erreur inconnue" },
              ":now": { S: new Date().toISOString() }
            }
          }));
        } catch (updateErr) {
          console.error("Échec de mise à jour du statut d'erreur :", updateErr);
        }
      }
    }
  }
};

