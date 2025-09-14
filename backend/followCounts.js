// backend/followCounts.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, BatchGetCommand, UpdateCommand, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import dotenv from "dotenv";
dotenv.config();

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

const USER_FOLLOWS_TABLE = process.env.USER_FOLLOWS_TABLE;
const METADATA_TABLE = process.env.APPS_METADATA_TABLE;

const appPk = (platform, bundleId) => `${String(platform).toLowerCase()}#${bundleId}`;

// GET /follow-app/badges
export async function getFollowBadges(req, res) {
  try {
    const userId = req.auth?.sub;
    if (!userId) return res.status(401).json({ error: "unauthorized" });

    // 1) Toutes les apps suivies par l'user
    const q = await ddb.send(new QueryCommand({
      TableName: USER_FOLLOWS_TABLE,
      KeyConditionExpression: "user_id = :u",
      ExpressionAttributeValues: { ":u": userId },
      ProjectionExpression: "app_pk, last_seen_total, last_seen_at"
    }));

    // Filtre côté code : ignorer l'item système et ne garder que les vrais app_pk
    const follows = (q.Items || []).filter(
      f => typeof f.app_pk === "string" && f.app_pk.includes("#") && f.app_pk !== "APP_LINKS"
    );
    if (follows.length === 0) return res.json({ ok: true, items: [] });

    // 2) Batch get des compteurs apps
    const keys = follows.map(f => ({ app_pk: f.app_pk }));
    const bg = await ddb.send(new BatchGetCommand({
      RequestItems: {
        [METADATA_TABLE]: { Keys: keys, ProjectionExpression: "app_pk, #c", ExpressionAttributeNames: { "#c": "total_reviews" } }
      }
    }));
    const counters = new Map((bg.Responses?.[METADATA_TABLE] || []).map(i => [i.app_pk, i["total_reviews"] || 0]));

    // 3) Calcule le badge
    const items = follows.map(f => {
      const total = counters.get(f.app_pk) || 0;
      const seen = Number.isFinite(f.last_seen_total) ? f.last_seen_total : 0;
      const badge = Math.max(0, total - seen);
      return { app_pk: f.app_pk, badge_count: badge, total_reviews: total, last_seen_total: seen, last_seen_at: f.last_seen_at || null };
    });

    return res.json({ ok: true, items });
  } catch (e) {
    console.error("getFollowBadges error", e);
    return res.status(500).json({ error: "internal_error", details: String(e?.message || e) });
  }
}

// PUT /follow-app/mark-read  { "platform": "...", "bundleId": "..." }
export async function markFollowRead(req, res) {
  try {
    const userId = req.auth?.sub;
    if (!userId) return res.status(401).json({ error: "unauthorized" });

    const { platform, bundleId } = req.body || {};
    if (!platform || !bundleId) return res.status(400).json({ error: "platform and bundleId are required" });

    const pk = appPk(platform, bundleId);

    // 1) Lire compteur courant
    const app = await ddb.send(new GetCommand({ TableName: METADATA_TABLE, Key: { app_pk: pk }, ProjectionExpression: "app_pk, #c", ExpressionAttributeNames: { "#c": "total_reviews" } }));
    const total = app.Item?.["total_reviews"] || 0;

    // 2) Upsert du suivi avec last_seen_total aligné (utile si l'item follow existait pas encore)
    const nowIso = new Date().toISOString();
    await ddb.send(new UpdateCommand({
      TableName: USER_FOLLOWS_TABLE,
      Key: { user_id: userId, app_pk: pk },
      UpdateExpression: "SET last_seen_total = :seen, last_seen_at = :at",
      ConditionExpression: "attribute_exists(user_id) AND attribute_exists(app_pk)",
      ExpressionAttributeValues: { ":seen": total, ":at": nowIso },
    }));

    return res.json({ ok: true, app_pk: pk, last_seen_total: total, last_seen_at: nowIso });
  } catch (e) {
    console.error("markFollowRead error", e);
    return res.status(500).json({ error: "internal_error", details: String(e?.message || e) });
  }
}
