// backend/followApp.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { searchAppMetadata } from "./searchAppMetadata.js";


const REGION = process.env.AWS_REGION;
const USER_FOLLOWS_TABLE = process.env.USER_FOLLOWS_TABLE;
const APPS_METADATA_TABLE = process.env.APPS_METADATA_TABLE;

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

  const appKey = `${platform.toLowerCase()}#${bundleId}`;
  const now = new Date().toISOString();

  try {
    // 1. Insérer dans user_follows
    await ddb.send(new PutCommand({
      TableName: USER_FOLLOWS_TABLE,
      Item: {
        user_id: userId,
        app_pk: appKey,
        followed_at: now,
      },
      ConditionExpression: "attribute_not_exists(user_id) AND attribute_not_exists(app_pk)"
    }));

    // 2. Tenter d'enrichir apps_metadata si l'app n'existe pas encore
    await enrichAppMetadataIfNeeded(appKey, bundleId, platform);

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

  const appKey = `${platform.toLowerCase()}#${bundleId}`;

  try {
    await ddb.send(new DeleteCommand({
      TableName: USER_FOLLOWS_TABLE,
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

export async function getFollowedApps(req, res) {
  const userId = req.auth?.sub;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = await ddb.send(new QueryCommand({
      TableName: USER_FOLLOWS_TABLE,
      KeyConditionExpression: "user_id = :uid",
      ExpressionAttributeValues: {
        ":uid": userId
      }
    }));

    const items = result.Items ?? [];
    if (!items.length) return res.status(200).json({ followed: [] });

    // Récupérer toutes les app_pk
    const appKeys = items.map(item => item.app_pk);

    // Récupérer les métadonnées en parallèle
    const enriched = await Promise.all(appKeys.map(async (appKey) => {
      const [platform, bundleId] = appKey.split("#");
      try {
        const meta = await ddb.send(new GetCommand({
          TableName: APPS_METADATA_TABLE,
          Key: { app_pk: appKey }
        }));

        return {
          bundleId,
          platform,
          name: meta.Item?.name || null,
          icon: meta.Item?.icon || null
        };
      } catch (err) {
        console.warn("getFollowedApps: erreur meta pour", appKey, err.message);
        return { bundleId, platform, name: null, icon: null };
      }
    }));

    return res.status(200).json({ followed: enriched });
  } catch (err) {
    console.error("Erreur getFollowedApps:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

async function enrichAppMetadataIfNeeded(appKey, bundleId, platform) {
  try {
    const existing = await ddb.send(new GetCommand({
      TableName: APPS_METADATA_TABLE,
      Key: { app_pk: appKey }
    }));
    if (existing.Item) return;

    const meta = await searchAppMetadata(bundleId, platform);
    if (!meta) return;

    await ddb.send(new PutCommand({
      TableName: APPS_METADATA_TABLE,
      Item: {
        app_pk: appKey,
        name: meta.name,
        icon: meta.icon,
        platform,
        bundleId,
        lastUpdated: new Date().toISOString()
      },
      ConditionExpression: "attribute_not_exists(app_pk)"
    }));
  } catch (e) {
    console.warn("enrichAppMetadataIfNeeded: skipped", e.message);
  }
}
