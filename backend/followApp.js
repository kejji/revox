// backend/followApp.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION;
const TABLE = process.env.USER_FOLLOWS_TABLE;

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

export async function followApp(req, res) {
  const userId = req.auth?.sub;
  const { appId, platform } = req.body || {};

  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  if (!appId || !platform) {
    return res.status(400).json({ error: "appId et platform sont requis" });
  }

  const appKey = `${appId}#${platform.toLowerCase()}`;
  const now = new Date().toISOString();

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        userId,
        appKey,
        followedAt: now,
      },
      ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(appKey)"
    }));

    return res.status(201).json({ ok: true, followed: { appId, platform, followedAt: now } });
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      return res.status(200).json({ ok: true, already: true });
    }
    console.error("Erreur followApp:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}
