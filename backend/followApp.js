// backend/followApp.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  GetCommand,
  UpdateCommand,
  BatchGetCommand
} from "@aws-sdk/lib-dynamodb";
import { searchAppMetadata } from "./searchAppMetadata.js";
import { getLinks } from "./appLinks.js";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { upsertThemesSchedule } from "./themesScheduleApi.js";

const REGION = process.env.AWS_REGION;
const USER_FOLLOWS_TABLE = process.env.USER_FOLLOWS_TABLE;
const APPS_METADATA_TABLE = process.env.APPS_METADATA_TABLE;
const APPS_INGEST_SCHEDULE_TABLE = process.env.APPS_INGEST_SCHEDULE_TABLE;
const DEFAULT_INTERVAL_MIN = Number.isFinite(parseInt(process.env.DEFAULT_INGEST_INTERVAL_MINUTES, 10))
  ? parseInt(process.env.DEFAULT_INGEST_INTERVAL_MINUTES, 10)
  : 60; // fallback 60 min

const QUEUE_URL = process.env.EXTRACTION_QUEUE_URL;
const sqs = new SQSClient({ region: REGION });
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const nowMs = () => Date.now();
const minutes = (n) => n * 60 * 1000;
const appKeyOf = (platform, bundleId) => `${String(platform).toLowerCase()}#${bundleId}`;

/* ------------------- helpers: app name ------------------- */
async function getAppName(appKey) {
  try {
    const out = await ddb.send(new GetCommand({
      TableName: APPS_METADATA_TABLE,
      Key: { app_pk: appKey },
      ProjectionExpression: "#n, bundleId",
      ExpressionAttributeNames: { "#n": "name" }
    }));
    const fallback = appKey.split("#")[1] || null; // bundleId
    return out?.Item?.name ?? fallback;
  } catch {
    return appKey.split("#")[1] || null;
  }
}

/* ===================== SCHEDULE ===================== */

async function ensureScheduleForApp(appKey) {
  const now = nowMs();
  const nowIso = new Date().toISOString();
  await ddb.send(new UpdateCommand({
    TableName: APPS_INGEST_SCHEDULE_TABLE,
    Key: { app_pk: appKey },
    UpdateExpression: "SET interval_minutes = if_not_exists(interval_minutes, :interval), enabled = if_not_exists(enabled, :enabled), created_at = if_not_exists(created_at, :now), created_at_iso = if_not_exists(created_at_iso, :nowIso), next_run_at = if_not_exists(next_run_at, :now), next_run_at_iso = if_not_exists(next_run_at_iso, :nowIso), due_pk = if_not_exists(due_pk, :due)",
    ExpressionAttributeValues: {
      ":interval": DEFAULT_INTERVAL_MIN,
      ":enabled": true,
      ":now": now,
      ":nowIso": nowIso,
      ":due": "DUE"
    }
  }));

  const res = await ddb.send(new GetCommand({
    TableName: APPS_INGEST_SCHEDULE_TABLE,
    Key: { app_pk: appKey }
  }));
  return { created: !res.Item?.created_at || res.Item?.created_at === now, schedule: res.Item };
}

/* =============== SQS ENQUEUE =============== */
async function enqueueImmediateIngest({ platform, bundleId, backfillDays = 2 }) {
  if (!QUEUE_URL) throw new Error("Missing EXTRACTION_QUEUE_URL");
  const key = appKeyOf(platform, bundleId);

  let appName = null;
  try {
    const metaRes = await ddb.send(new GetCommand({
      TableName: APPS_METADATA_TABLE,
      Key: { app_pk: key },
      ProjectionExpression: "#n",
      ExpressionAttributeNames: { "#n": "name" }
    }));
    appName = metaRes.Item?.name ?? null;
  } catch (e) {
    console.warn("enqueueImmediateIngest: metadata read failed", e?.message || e);
  }

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
    await ddb.send(
      new UpdateCommand({
        TableName: APPS_METADATA_TABLE,
        Key: { app_pk: appKey },
        UpdateExpression:
          "SET #name = if_not_exists(#name, :name), " +
          "#icon = if_not_exists(#icon, :icon), " +
          "#platform = :platform, " +
          "#bundleId = :bundleId, " +
          "#version = :version, " +
          "#rating = :rating, " +
          "#releaseNotes = :releaseNotes, " +
          "#lastUpdatedAt = :lastUpdatedAt, " +
          "#lastUpdated = :now",
        ExpressionAttributeNames: {
          "#name": "name",
          "#icon": "icon",
          "#platform": "platform",
          "#bundleId": "bundleId",
          "#version": "version",
          "#rating": "rating",
          "#releaseNotes": "releaseNotes",
          "#lastUpdatedAt": "lastUpdatedAt",
          "#lastUpdated": "lastUpdated",
        },
        ExpressionAttributeValues: {
          ":name": meta.name ?? null,
          ":icon": meta.icon ?? null,
          ":platform": platform,
          ":bundleId": bundleId,
          ":version": meta.version ?? null,
          ":rating": meta.rating ?? null,
          ":releaseNotes": meta.releaseNotes ?? null,
          ":lastUpdatedAt": meta.lastUpdatedAt ?? null,
          ":now": new Date().toISOString()
        }
      }));
  } catch (e) {
    console.warn("upsertAppMetadata: skipped", appKey, e?.message || e);
  }
}

async function getOrRefreshMetadata(appKey, platform, bundleId) {
  const current = await ddb.send(new GetCommand({
    TableName: APPS_METADATA_TABLE,
    Key: { app_pk: appKey }
  }));
  const hasEnough =
    current.Item &&
    (current.Item.icon || current.Item.name || current.Item.version || current.Item.rating != null || current.Item.releaseNotes);

  if (hasEnough) return current.Item;

  const fresh = await searchAppMetadata(bundleId, platform);
  if (fresh) {
    await ddb.send(new UpdateCommand({
      TableName: APPS_METADATA_TABLE,
      Key: { app_pk: appKey },
      UpdateExpression:
        "SET #name = :name, " +
        "#icon = :icon, " +
        "#platform = :platform, " +
        "#bundleId = :bundleId, " +
        "#version = :version, " +
        "#rating = :rating, " +
        "#releaseNotes = :releaseNotes, " +
        "#lastUpdatedAt = :lastUpdatedAt, " +
        "#lastUpdated = :now",
      ExpressionAttributeNames: {
        "#name": "name",
        "#icon": "icon",
        "#platform": "platform",
        "#bundleId": "bundleId",
        "#version": "version",
        "#rating": "rating",
        "#releaseNotes": "releaseNotes",
        "#lastUpdatedAt": "lastUpdatedAt",
        "#lastUpdated": "lastUpdated",
      },
      ExpressionAttributeValues: {
        ":name": fresh.name ?? null,
        ":icon": fresh.icon ?? null,
        ":platform": platform,
        ":bundleId": bundleId,
        ":version": fresh.version ?? null,
        ":rating": fresh.rating ?? null,
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

  const appKey = appKeyOf(platform, bundleId);
  const nowIso = new Date().toISOString();
  const app = await ddb.send(new GetCommand({
    TableName: APPS_METADATA_TABLE,
    Key: { app_pk: appKey },
    ProjectionExpression: "app_pk, #c",
    ExpressionAttributeNames: { "#c": "total_reviews" }
  }));
  const total = app.Item?.["total_reviews"] || 0;

  try {
    // 1) Lien user → app (idempotent)
    try {
      await ddb.send(new PutCommand({
        TableName: USER_FOLLOWS_TABLE,
        Item: {
          user_id: userId,
          app_pk: appKey,
          followed_at: nowIso,
          last_seen_total: total,
          last_seen_at: new Date().toISOString()
        },
        ConditionExpression: "attribute_not_exists(user_id) AND attribute_not_exists(app_pk)"
      }));
    } catch (e) {
      if (e?.name !== "ConditionalCheckFailedException") throw e;
    }

    // 2) Upsert metadata
    await upsertAppMetadata(appKey, bundleId, platform);

    // 3) Assure un planning d’ingestion
    const sched = await ensureScheduleForApp(appKey);

    // 4) Déclenche ingestion immédiate puis décale next_run_at
    try {
      await enqueueImmediateIngest({ platform, bundleId, backfillDays: 2 });
      const now = nowMs();
      const next = now + minutes(sched?.schedule?.interval_minutes ?? DEFAULT_INTERVAL_MIN);
      await ddb.send(new UpdateCommand({
        TableName: APPS_INGEST_SCHEDULE_TABLE,
        Key: { app_pk: appKey },
        UpdateExpression: "SET due_pk = if_not_exists(due_pk, :due), last_enqueued_at = :now, last_enqueued_at_iso = :nowIso, next_run_at = :next, next_run_at_iso = :nextIso, enabled = :enabled, interval_minutes = if_not_exists(interval_minutes, :interval)",
        ExpressionAttributeValues: {
          ":due": "DUE",
          ":now": now,
          ":nowIso": new Date(now).toISOString(),
          ":next": next,
          ":nextIso": new Date(next).toISOString(),
          ":enabled": true,
          ":interval": DEFAULT_INTERVAL_MIN
        }
      }));
    } catch (e) {
      console.warn("followApp: immediate enqueue failed", e?.message || e);
    }

    // 5) Run themes schedule (internal) avec appName renseigné
    let run_now = { job_id: null, day: null };
    try {
      const appName = await getAppName(appKey);
      const fakeReq = {
        auth: req.auth,
        body: { app_pk: appKey, enabled: true, appName },
        query: { run_now: "true" }
      };
      let captured = null;
      const fakeRes = {
        status: (code) => ({
          json: (payload) => {
            captured = { code, body: payload };
            return captured;
          }
        }),
        json: (payload) => { captured = { code: 200, body: payload }; return captured; }
      };
      await upsertThemesSchedule(fakeReq, fakeRes);
      const body = captured?.body ?? null;
      const rn = body?.run_now ?? body ?? {};
      run_now.job_id = rn?.job_id ?? null;
      run_now.day = rn?.day ?? rn?.date ?? null;
    } catch (e) {
      console.warn("followApp: upsertThemesSchedule (internal) failed", e?.message || e);
    }

    return res.status(201).json({
      ok: true,
      followed: { bundleId, platform, followedAt: nowIso },
      schedule: sched,
      run_now
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

    const linksMap = await getLinks(userId);
    const dedup = (arr) => Array.from(new Set(Array.isArray(arr) ? arr : []));

    const follows = items.filter(it => it.app_pk && it.app_pk !== "APP_LINKS");

    const seenMap = new Map(follows.map(it => [it.app_pk, {
      last_seen_total: Number.isFinite(it.last_seen_total) ? it.last_seen_total : 0,
      last_seen_at: it.last_seen_at || null
    }]));

    const keys = follows.map(f => ({ app_pk: f.app_pk }));
    const bg = await ddb.send(new BatchGetCommand({
      RequestItems: {
        [APPS_METADATA_TABLE]: {
          Keys: keys,
          ProjectionExpression: "app_pk, #c",
          ExpressionAttributeNames: { "#c": "total_reviews" }
        }
      }
    }));
    const totals = new Map((bg.Responses?.[APPS_METADATA_TABLE] || []).map(i => [i.app_pk, i["total_reviews"] || 0]));

    const enriched = await Promise.all(follows.map(async (it) => {
      const appKey = it.app_pk;
      const [platform, bundleId] = appKey.split("#", 2);

      const meta = await getOrRefreshMetadata(appKey, platform, bundleId);
      const total = totals.get(appKey) ?? 0;
      const rawSeen = seenMap.get(appKey)?.last_seen_total ?? 0;
      const lastSeenAt = seenMap.get(appKey)?.last_seen_at ?? null;
      const effectiveSeen = (rawSeen === -1) ? total : rawSeen;
      const badge = Math.max(0, total - effectiveSeen);

      if (rawSeen === -1 && total > 0) {
        try {
          await ddb.send(new UpdateCommand({
            TableName: USER_FOLLOWS_TABLE,
            Key: { user_id: userId, app_pk: appKey },
            UpdateExpression: "SET last_seen_total = :seen",
            ConditionExpression: "attribute_exists(user_id) AND attribute_exists(app_pk) AND last_seen_total = :minusOne",
            ExpressionAttributeValues: { ":seen": total, ":minusOne": -1 }
          }));
        } catch (e) {}
      }

      return {
        bundleId,
        platform,
        name: meta?.name ?? null,
        icon: meta?.icon ?? null,
        version: meta?.version ?? null,
        rating: meta?.rating ?? null,
        releaseNotes: meta?.releaseNotes ?? null,
        lastUpdatedAt: meta?.lastUpdatedAt ?? null,
        linked_app_pks: dedup(linksMap[appKey]),
        badge_count: badge,
        total_reviews: total,
        last_seen_total: effectiveSeen,
        last_seen_at: lastSeenAt
      };
    }));

    return res.status(200).json({ followed: enriched });
  } catch (err) {
    console.error("Erreur getFollowedApps:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

export async function markFollowRead(req, res) {
  const userId = req.auth?.sub;
  const { platform, bundleId } = req.body || {};
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  if (!platform || !bundleId) {
    return res.status(400).json({ error: "platform et bundleId sont requis" });
  }
  const pk = appKeyOf(platform, bundleId);

  try {
    const meta = await ddb.send(new GetCommand({
      TableName: APPS_METADATA_TABLE,
      Key: { app_pk: pk },
      ProjectionExpression: "app_pk, #c",
      ExpressionAttributeNames: { "#c": "total_reviews" }
    }));
    const total = Number.isFinite(meta.Item?.["total_reviews"]) ? meta.Item.total_reviews : 0;
    const nowIso = new Date().toISOString();

    const updateWhenZero = new UpdateCommand({
      TableName: USER_FOLLOWS_TABLE,
      Key: { user_id: userId, app_pk: pk },
      UpdateExpression: "SET last_seen_total = :seen, last_seen_at = :at",
      ConditionExpression: "attribute_exists(user_id) AND attribute_exists(app_pk)",
      ExpressionAttributeValues: { ":seen": -1, ":at": nowIso }
    });

    const updateWhenPositive = new UpdateCommand({
      TableName: USER_FOLLOWS_TABLE,
      Key: { user_id: userId, app_pk: pk },
      UpdateExpression: "SET last_seen_total = :seen, last_seen_at = :at REMOVE suppress_badge_until",
      ConditionExpression: "attribute_exists(user_id) AND attribute_exists(app_pk)",
      ExpressionAttributeValues: { ":seen": total, ":at": nowIso }
    });

    await ddb.send(total === 0 ? updateWhenZero : updateWhenPositive);

    return res.status(200).json({
      ok: true,
      app_pk: pk,
      last_seen_total: total,
      last_seen_at: nowIso
    });
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      return res.status(404).json({ ok: false, error: "not_following" });
    }
    console.error("Erreur markFollowRead:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}