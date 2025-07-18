const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const scrape = require("./scrape");
const s3 = new S3Client({ region: "eu-west-3" });
const db = new DynamoDBClient({ region: "eu-west-3" });

exports.handler = async (event) => {
  for (const record of event.Records) {
    let message = null;

    try {
      message = JSON.parse(record.body);
      const { userId, extractionId, appName, iosAppId, androidAppId, fromDate, toDate } = message;

      console.log("🛠️ Traitement extraction", extractionId);

      // Étape 1 : générer le contenu CSV
      const content = await scrape.processApp(appName, iosAppId, androidAppId,fromDate,toDate);

      // Étape 2 : envoyer vers S3
      const s3Key = `${appName}/${userId}/${extractionId}.csv`;

      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET, // Utilise la var env définie dans Terraform
        Key: s3Key,
        Body: content,
        ContentType: "text/csv",
      }));

      console.log("CSV généré et envoyé à S3 :", s3Key);

      // Étape 3 : mise à jour DynamoDB
      await db.send(new UpdateItemCommand({
        TableName: process.env.EXTRACTIONS_TABLE,
        Key: {
          user_id: { S: userId },
          extraction_id: { S: extractionId },
        },
        UpdateExpression: "SET #s = :s, s3_key = :k, updated_at = :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": { S: "done" },
          ":k": { S: s3Key },
          ":now": { S: new Date().toISOString() },
        }
      }));

      console.log("Table DynamoDB mise à jour");
    } catch (error) {
      console.error("Erreur dans le worker :", error);

      if (message?.userId && message?.extractionId) {
        try {
          await db.send(new UpdateItemCommand({
            TableName: process.env.EXTRACTIONS_TABLE,
            Key: {
              user_id: { S: message.userId },
              extraction_id: { S: message.extractionId },
            },
            UpdateExpression: "SET #s = :s, error_message = :msg, updated_at = :now",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: {
              ":s":   { S: "error" },
              ":msg": { S: error.message || "Erreur inconnue" },
              ":now": { S: new Date().toISOString() },
            }
          }));
          console.log("Statut mis à jour dans DynamoDB en erreur");
        } catch (updateErr) {
          console.error("Échec de mise à jour du statut d'erreur :", updateErr);
        }
      }
    }
  }
};
