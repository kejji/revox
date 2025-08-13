// backend/followApp.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION;
const TABLE = process.env.USER_FOLLOWS_TABLE;

console.log("FollowApp: using table =", TABLE);

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

export async function followApp(req, res) {
  const userId = req.auth?.sub;
  const { bundleId, platform } = req.body || {};

  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  if (!bundleId || !platform) {
    return res.status(400).json({ error: "bundleId et platform sont requis" });
  }

  const appKey = `${bundleId}#${platform.toLowerCase()}`;
  const now = new Date().toISOString();

  try {
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        user_id: userId,
        app_pk: appKey,
        followed_at: now,
      },
      ConditionExpression: "attribute_not_exists(userId) AND attribute_not_exists(appKey)"
    }));

    return res.status(201).json({ ok: true, followed: { bundleId, platform, followedAt: now } });
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      return res.status(200).json({ ok: true, already: true });
    }
    console.error("Erreur followApp:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

export async function unfollowApp(req, res) {
  const userId = req.auth?.sub;
  const { bundleId, platform } = req.body || {};

  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  if (!bundleId || !platform) {
    return res.status(400).json({ error: "bundleId et platform sont requis" });
  }

  const appKey = `${bundleId}#${platform.toLowerCase()}`;

  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE,
      Key: {
        user_id: userId,
        app_pk: appKey
      }
    }));

    return res.status(200).json({ ok: true, unfollowed: { bundleId, platform } });
  } catch (err) {
    console.error("Erreur unfollowApp:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}
