// backend/followApp.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  GetCommand,
  UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import { searchAppMetadata } from "./searchAppMetadata.js";
import { getLinks } from "./appLinks.js";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const REGION = process.env.AWS_REGION;
const USER_FOLLOWS_TABLE = process.env.USER_FOLLOWS_TABLE;
const APPS_METADATA_TABLE = process.env.APPS_METADATA_TABLE;
const APPS_INGEST_SCHEDULE_TABLE = process.env.APPS_INGEST_SCHEDULE_TABLE;
const DEFAULT_INTERVAL_MIN = Number.isFinite(parseInt(process.env.DEFAULT_INGEST_INTERVAL_MINUTES, 10))
  ? parseInt(process.env.DEFAULT_INGEST_INTERVAL_MINUTES, 10)
  : 60; // fallback 60 min

const QUEUE_URL = process.env.EXTRACTION_QUEUE_URL; // <-- fix: déclaration propre

const sqs = new SQSClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const nowMs = () => Date.now();
const minutes = (n) => n * 60 * 1000;

/* ===================== SCHEDULE ===================== */

async function ensureScheduleForApp(appKey, bundleId, platform) {
  // On initialise l'item s'il n'existe pas, sans écraser s'il existe déjà
  const now = nowMs();
  await ddb.send(new UpdateCommand({
    TableName: APPS_INGEST_SCHEDULE_TABLE,
    Key: { app_pk: appKey, due_pk: "DUE" },
    UpdateExpression: "SET appName = if_not_exists(appName, :appName), interval_minutes = if_not_exists(interval_minutes, :interval), enabled = if_not_exists(enabled, :enabled), created_at = if_not_exists(created_at, :now), next_run_at = if_not_exists(next_run_at, :now)",
    ExpressionAttributeValues: {
      ":appName": null,
      ":interval": DEFAULT_INTERVAL_MIN,
      ":enabled": true,
      ":now": now
    }
  }));

  const res = await ddb.send(new GetCommand({
    TableName: APPS_INGEST_SCHEDULE_TABLE,
    Key: { app_pk: appKey, due_pk: "DUE" }
  }));
  return { created: !res.Item?.created_at || res.Item?.created_at === now, schedule: res.Item };
}

async function enqueueImmediateIngest({ appName, platform, bundleId, backfillDays = 2 }) {
  if (!QUEUE_URL) throw new Error("Missing EXTRACTION_QUEUE_URL");
  const payload = {
    mode: "incremental",
    appName,
    platform,
    bundleId,
    backfillDays,
    requestedAt: new Date().toISOString()
  };
  await sqs.send(new SendMessageCommand({
    QueueUrl: QUEUE_URL,
    MessageBody: JSON.stringify(payload),
    MessageAttributes: {
      appName: { DataType: "String", StringValue: String(appName ?? "") },
      platform: { DataType: "String", StringValue: String(platform) },
      bundleId: { DataType: "String", StringValue: String(bundleId) }
    }
  }));
}

/* =============== METADATA (UPSERT + LAZY REFRESH) =============== */

async function upsertAppMetadata(appKey, bundleId, platform) {
  try {
    const meta = await searchAppMetadata(bundleId, platform);
    if (!meta) return;
    await ddb.send(new UpdateCommand({
      TableName: APPS_METADATA_TABLE,
      Key: { app_pk: appKey },
      UpdateExpression: [
        "SET",
        "name = if_not_exists(name, :name)",
        "icon = if_not_exists(icon, :icon)",
        "platform = :platform",
        "bundleId = :bundleId",
        "version = :version",
        "rating = :rating",
        "ratingCount = :ratingCount",
        "releaseNotes = :releaseNotes",
        "lastUpdatedAt = :lastUpdatedAt",
        "lastUpdated = :now"
      ].join(" "),
      ExpressionAttributeValues: {
        ":name": meta.name ?? null,
        ":icon": meta.icon ?? null,
        ":platform": platform,
        ":bundleId": bundleId,
        ":version": meta.version ?? null,
        ":rating": meta.rating ?? null,
        ":ratingCount": meta.ratingCount ?? null,
        ":releaseNotes": meta.releaseNotes ?? null,
        ":lastUpdatedAt": meta.lastUpdatedAt ?? null,
        ":now": new Date().toISOString()
      }
    }));
  } catch (e) {
    console.warn("upsertAppMetadata: skipped", appKey, e?.message || e);
  }
}

/**
 * Si meta absente/incomplète au moment du GET, on relit le store et on upsert.
 * Renvoie toujours l’état courant (après éventuel refresh).
 */
async function getOrRefreshMetadata(appKey, platform, bundleId) {
  const current = await ddb.send(new GetCommand({
    TableName: APPS_METADATA_TABLE,
    Key: { app_pk: appKey }
  }));
  const hasEnough =
    current.Item &&
    (current.Item.icon || current.Item.name || current.Item.version || current.Item.rating != null || current.Item.releaseNotes);

  if (hasEnough) return current.Item;

  // Lazy refresh
  const fresh = await searchAppMetadata(bundleId, platform);
  if (fresh) {
    await ddb.send(new UpdateCommand({
      TableName: APPS_METADATA_TABLE,
      Key: { app_pk: appKey },
      UpdateExpression: [
        "SET",
        "name = :name",
        "icon = :icon",
        "platform = :platform",
        "bundleId = :bundleId",
        "version = :version",
        "rating = :rating",
        "ratingCount = :ratingCount",
        "releaseNotes = :releaseNotes",
        "lastUpdatedAt = :lastUpdatedAt",
        "lastUpdated = :now"
      ].join(" "),
      ExpressionAttributeValues: {
        ":name": fresh.name ?? null,
        ":icon": fresh.icon ?? null,
        ":platform": platform,
        ":bundleId": bundleId,
        ":version": fresh.version ?? null,
        ":rating": fresh.rating ?? null,
        ":ratingCount": fresh.ratingCount ?? null,
        ":releaseNotes": fresh.releaseNotes ?? null,
        ":lastUpdatedAt": fresh.lastUpdatedAt ?? null,
        ":now": new Date().toISOString()
      }
    }));
    return { ...(current.Item || {}), ...fresh };
  }
  return current.Item || null;
}

/* ========================= ROUTES ========================= */

export async function followApp(req, res) {
  const userId = req.auth?.sub;
  const { bundleId, platform } = req.body || {};

  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  if (!bundleId || !platform) return res.status(400).json({ error: "bundleId et platform sont requis" });

  const appKey = `${String(platform).toLowerCase()}#${bundleId}`;
  const nowIso = new Date().toISOString();

  try {
    // 1) Lien user → app (idempotent)
    try {
      await ddb.send(new PutCommand({
        TableName: USER_FOLLOWS_TABLE,
        Item: { user_id: userId, app_pk: appKey, followed_at: nowIso },
        ConditionExpression: "attribute_not_exists(user_id) AND attribute_not_exists(app_pk)"
      }));
    } catch (e) {
      if (e?.name !== "ConditionalCheckFailedException") throw e;
    }

    // 2) Upsert metadata (name, icon, version, rating, releaseNotes…)
    await upsertAppMetadata(appKey, bundleId, platform); //  [oai_citation:1‡followApp.js](file-service://file-Wcd5ptB7WhixaMXDTtsYAr)

    // 3) Assure un planning d’ingestion
    const sched = await ensureScheduleForApp(appKey, bundleId, platform); //  [oai_citation:2‡followApp.js](file-service://file-Wcd5ptB7WhixaMXDTtsYAr)

    // 4) Déclenche ingestion immédiate puis décale next_run_at
    try {
      await enqueueImmediateIngest({ appName: sched?.schedule?.appName, platform, bundleId, backfillDays: 2 });
      const now = nowMs();
      const next = now + minutes(sched?.schedule?.interval_minutes ?? DEFAULT_INTERVAL_MIN);
      await ddb.send(new UpdateCommand({
        TableName: APPS_INGEST_SCHEDULE_TABLE,
        Key: { app_pk: appKey, due_pk: "DUE" },
        UpdateExpression: "SET last_enqueued_at = :now, next_run_at = :next, enabled = :enabled, interval_minutes = if_not_exists(interval_minutes, :interval)",
        ExpressionAttributeValues: {
          ":now": now, ":next": next, ":enabled": true, ":interval": DEFAULT_INTERVAL_MIN
        }
      }));
    } catch (e) {
      console.warn("followApp: immediate enqueue failed", e?.message || e);
    }

    return res.status(201).json({
      ok: true,
      followed: { bundleId, platform, followedAt: nowIso },
      schedule: sched
    });
  } catch (err) {
    console.error("Erreur followApp:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

export async function unfollowApp(req, res) {
  const userId = req.auth?.sub;
  const { bundleId, platform } = req.body || {};
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  if (!bundleId || !platform) return res.status(400).json({ error: "bundleId et platform sont requis" });

  const appKey = `${String(platform).toLowerCase()}#${bundleId}`;
  try {
    await ddb.send(new DeleteCommand({
      TableName: USER_FOLLOWS_TABLE,
      Key: { user_id: userId, app_pk: appKey }
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
      ExpressionAttributeValues: { ":uid": userId }
    }));

    const items = result.Items ?? [];
    if (!items.length) return res.status(200).json({ followed: [] });

    const linksMap = await getLinks(userId); // { [app_pk]: string[] }
    const dedup = (arr) => Array.from(new Set(Array.isArray(arr) ? arr : []));

    // Garde uniquement les clés "réelles" (pas APP_LINKS)
    const follows = items.filter(it => it.app_pk && it.app_pk !== "APP_LINKS");

    // ⬇️ Enrichissement: si meta manquante/incomplète, on relit le store (lazy refresh)
    const enriched = await Promise.all(follows.map(async (it) => {
      const appKey = it.app_pk;
      const [platform, bundleId] = appKey.split("#", 2);

      const meta = await getOrRefreshMetadata(appKey, platform, bundleId); // <-- clé du correctif

      return {
        bundleId,
        platform,
        name: meta?.name ?? null,
        icon: meta?.icon ?? null,
        version: meta?.version ?? null,
        rating: meta?.rating ?? null,
        ratingCount: meta?.ratingCount ?? null,
        releaseNotes: meta?.releaseNotes ?? null,
        lastUpdatedAt: meta?.lastUpdatedAt ?? null,
        linked_app_pks: dedup(linksMap[appKey])
      };
    }));

    return res.status(200).json({ followed: enriched });
  } catch (err) {
    console.error("Erreur getFollowedApps:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}