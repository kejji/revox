// backend/followApp.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { searchAppMetadata } from "./searchAppMetadata.js";
import { getLinks } from "./appLinks.js";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const REGION = process.env.AWS_REGION;
const USER_FOLLOWS_TABLE = process.env.USER_FOLLOWS_TABLE;
const APPS_METADATA_TABLE = process.env.APPS_METADATA_TABLE;
const APPS_INGEST_SCHEDULE_TABLE = process.env.APPS_INGEST_SCHEDULE_TABLE;
const DEFAULT_INTERVAL_MIN = parseInt(process.env.DEFAULT_INGEST_INTERVAL_MINUTES, 10);
const QUEUE_URL = process.env.EXTRACTION_QUEUE_URL;
const sqs = new SQSClient({ region: REGION });

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

async function ensureScheduleForApp(appKey, bundleId, platform) {
  // Récupérer un appName si possible (depuis apps_metadata) — optionnel
  let appName = null;
  try {
    const meta = await ddb.send(new GetCommand({
      TableName: APPS_METADATA_TABLE,
      Key: { app_pk: appKey }
    }));
    appName = meta.Item?.name ?? null;
  } catch (e) {
    console.warn("ensureScheduleForApp: meta lookup failed", e?.message || e);
  }

  const nowMs = Date.now();
  const item = {
    app_pk: appKey,
    due_pk: "DUE",
    appName,
    interval_minutes: DEFAULT_INTERVAL_MIN,
    enabled: true,
    next_run_at: nowMs,
    last_enqueued_at: 0
  };

  try {
    await ddb.send(new PutCommand({
      TableName: APPS_INGEST_SCHEDULE_TABLE,
      Item: item,
      ConditionExpression: "attribute_not_exists(app_pk)"
    }));
    return { created: true, schedule: item };
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") {
      // le planning existe déjà — rien à faire
      return { created: false, already: true };
    }
    console.warn("ensureScheduleForApp: error", e?.message || e);
    return { created: false, error: e?.message || String(e) };
  }
}


export async function followApp(req, res) {
  const userId = req.auth?.sub;
  const { bundleId, platform } = req.body || {};

  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  if (!bundleId || !platform) {
    return res.status(400).json({ error: "bundleId et platform sont requis" });
  }

  const appKey = `${platform.toLowerCase()}#${bundleId}`;
  const nowIso = new Date().toISOString();

  try {
    // 1. Insérer dans user_follows
    await ddb.send(new PutCommand({
      TableName: USER_FOLLOWS_TABLE,
      Item: {
        user_id: userId,
        app_pk: appKey,
        followed_at: nowIso,
      },
      ConditionExpression: "attribute_not_exists(user_id) AND attribute_not_exists(app_pk)"
    }));

    // 2. Tenter d'enrichir apps_metadata si l'app n'existe pas encore
    await enrichAppMetadataIfNeeded(appKey, bundleId, platform);
    // 3. Créer automatiquement un planning d'ingestion si absent
    const sched = await ensureScheduleForApp(appKey, bundleId, platform);
    // 4. Déclenche une ingestion immédiate (fire & schedule)
    try {
      const payload = {
        mode: "incremental",
        appName: sched?.schedule?.appName ?? undefined, // si récupéré depuis apps_metadata
        platform,
        bundleId,
        backfillDays: 2
      };
      await sqs.send(new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(payload)
      }));
      // Met à jour le schedule: on décale next_run_at de l'intervalle et on log last_enqueued_at
      const now = Date.now();
      const next = now + (sched?.schedule?.interval_minutes ?? DEFAULT_INTERVAL_MIN) * 60 * 1000;
      await ddb.send(new PutCommand({
        TableName: APPS_INGEST_SCHEDULE_TABLE,
        Item: {
          app_pk: appKey,
          due_pk: "DUE",
          appName: sched?.schedule?.appName ?? null,
          interval_minutes: sched?.schedule?.interval_minutes ?? DEFAULT_INTERVAL_MIN,
          enabled: true,
          next_run_at: next,
          last_enqueued_at: now
        }
      }));
    } catch (e) {
      console.warn("followApp: immediate enqueue failed", e?.message || e);
      // On ne casse pas la création du follow pour autant
    }
    return res.status(201).json({
      ok: true,
      followed: { bundleId, platform, followedAt: nowIso },
      schedule: sched
    });
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      // déjà suivi : on tente quand même de s'assurer du planning (idempotent)
      const sched = await ensureScheduleForApp(appKey, bundleId, platform);
      return res.status(200).json({ ok: true, already: true, schedule: sched });
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
    // Charger les liens (fusions) une seule fois
    const linksMap = await getLinks(userId); // { [app_pk]: string[] }
    const dedup = (arr) => Array.from(new Set(Array.isArray(arr) ? arr : []));
    // Filtrer pour ne garder que les lignes de suivi (SK = app_pk réel)
    const follows = items.filter(it => it.app_pk && it.app_pk !== "APP_LINKS");

    // Enrichissement apps_metadata + ajout linked_app_pks
    const enriched = await Promise.all(follows.map(async (it) => {
      const appKey = it.app_pk;
      const [platform, bundleId] = appKey.split("#", 2);
      try {
        const meta = await ddb.send(new GetCommand({
          TableName: APPS_METADATA_TABLE,
          Key: { app_pk: appKey }
        }));
        return {
          bundleId,
          platform,
          name: meta.Item?.name || null,
          icon: meta.Item?.icon || null,
          linked_app_pks: dedup(linksMap[appKey])
        };
      } catch (err) {
        console.warn("getFollowedApps: erreur meta pour", appKey, err.message);
        return { bundleId, platform, name: null, icon: null, linked_app_pks: dedup(linksMap[appKey]) };
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
