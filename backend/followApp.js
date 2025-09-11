// followApp.js
import express from "express";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { searchAppMetadata } from "./searchAppMetadata.js";
import { getLinks } from "./appLinks.js";

const router = express.Router();

// ---------- Env & clients

const {
  AWS_REGION,
  USER_FOLLOWS_TABLE,
  APPS_METADATA_TABLE,
  APPS_INGEST_SCHEDULE_TABLE,
  EXTRACTION_QUEUE_URL,
  DEFAULT_INGEST_INTERVAL_MINUTES,
} = process.env;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));
const sqs = new SQSClient({ region: AWS_REGION });

const DEFAULT_INTERVAL_MIN = Number.isFinite(parseInt(DEFAULT_INGEST_INTERVAL_MINUTES, 10))
  ? parseInt(DEFAULT_INGEST_INTERVAL_MINUTES, 10)
  : 60; // fallback 60 minutes

// ---------- Utils

const nowMs = () => Date.now();
const minutes = (n) => n * 60 * 1000;

const toAppKey = (platform, bundleId) => `${platform}#${bundleId}`;

function requireAuth(req) {
  // decodeJwtSub middleware doit poser req.userSub (ou req.user.sub)
  const userSub = req.userSub || req.user?.sub;
  if (!userSub) {
    const err = new Error("Unauthorized");
    err.status = 401;
    throw err;
  }
  return userSub;
}

function dedup(arr) {
  return Array.isArray(arr) ? Array.from(new Set(arr.filter(Boolean))) : [];
}

// ---------- Métadonnées: upsert enrichi

async function upsertAppMetadata(appKey, bundleId, platform) {
  try {
    const meta = await searchAppMetadata(bundleId, platform);
    if (!meta) return;

    await ddb.send(
      new UpdateCommand({
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
          "lastUpdated = :now",
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
          ":now": new Date().toISOString(),
        },
      })
    );
  } catch (e) {
    console.warn("upsertAppMetadata: skipped", appKey, e?.message || e);
  }
}

// ---------- Schedule helpers

async function ensureSchedule(appKey, payload = {}) {
  // Crée si absent, sinon ne touche pas next_run_at; on renverra l'item pour usage ultérieur
  await ddb.send(
    new UpdateCommand({
      TableName: APPS_INGEST_SCHEDULE_TABLE,
      Key: { app_pk: appKey, due_pk: "DUE" },
      UpdateExpression: "SET appName = if_not_exists(appName, :appName), interval_minutes = if_not_exists(interval_minutes, :interval), enabled = if_not_exists(enabled, :enabled), created_at = if_not_exists(created_at, :now), next_run_at = if_not_exists(next_run_at, :now)",
      ExpressionAttributeValues: {
        ":appName": payload.appName ?? null,
        ":interval": payload.interval_minutes ?? DEFAULT_INTERVAL_MIN,
        ":enabled": payload.enabled ?? true,
        ":now": nowMs(),
      },
    })
  );

  const res = await ddb.send(
    new GetCommand({
      TableName: APPS_INGEST_SCHEDULE_TABLE,
      Key: { app_pk: appKey, due_pk: "DUE" },
    })
  );
  return res.Item;
}

async function enqueueImmediateIngest({ appName, platform, bundleId, backfillDays = 2 }) {
  if (!EXTRACTION_QUEUE_URL) throw new Error("Missing EXTRACTION_QUEUE_URL");

  const body = JSON.stringify({
    mode: "incremental",
    appName,
    platform,
    bundleId,
    backfillDays,
    requestedAt: new Date().toISOString(),
  });

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: EXTRACTION_QUEUE_URL,
      MessageBody: body,
      MessageAttributes: {
        appName: { DataType: "String", StringValue: appName ?? "" },
        platform: { DataType: "String", StringValue: String(platform) },
        bundleId: { DataType: "String", StringValue: String(bundleId) },
      },
    })
  );
}

// ---------- Routes

/**
 * POST /follow-app
 * Body: { bundleId, platform }
 */
router.post("/follow-app", async (req, res) => {
  try {
    const userSub = requireAuth(req);
    const { bundleId, platform } = req.body || {};

    if (!bundleId || !platform) {
      return res.status(400).json({ ok: false, error: "bundleId and platform are required" });
    }

    const appKey = toAppKey(platform, bundleId);

    // 1) Lien user → app (idempotent)
    try {
      await ddb.send(
        new PutCommand({
          TableName: USER_FOLLOWS_TABLE,
          Item: {
            user_id: userSub,
            app_pk: appKey,
            followed_at: new Date().toISOString(),
          },
          ConditionExpression: "attribute_not_exists(user_id) AND attribute_not_exists(app_pk)",
        })
      );
    } catch (e) {
      // Idempotence: si déjà suivi, on ignore l'erreur
      if (e?.name !== "ConditionalCheckFailedException") {
        console.warn("follow-app Put failed:", e?.message || e);
        // On continue quand même (l'utilisateur peut relancer)
      }
    }

    // 2) Upsert metadata (name, icon, version, rating, releaseNotes…)
    await upsertAppMetadata(appKey, bundleId, platform);

    // 3) Assure un planning d’ingestion
    const schedItem = await ensureSchedule(appKey, {
      appName: null,
      interval_minutes: DEFAULT_INTERVAL_MIN,
      enabled: true,
    });

    // 4) Déclenche une ingestion immédiate (SQS) puis décale next_run_at
    try {
      await enqueueImmediateIngest({ appName: schedItem?.appName, platform, bundleId, backfillDays: 2 });

      const now = nowMs();
      const next = now + minutes(schedItem?.interval_minutes ?? DEFAULT_INTERVAL_MIN);

      await ddb.send(
        new UpdateCommand({
          TableName: APPS_INGEST_SCHEDULE_TABLE,
          Key: { app_pk: appKey, due_pk: "DUE" },
          UpdateExpression:
            "SET last_enqueued_at = :now, next_run_at = :next, enabled = :enabled, interval_minutes = if_not_exists(interval_minutes, :interval)",
          ExpressionAttributeValues: {
            ":now": now,
            ":next": next,
            ":enabled": true,
            ":interval": DEFAULT_INTERVAL_MIN,
          },
        })
      );
    } catch (e) {
      console.warn("follow-app immediate enqueue failed:", e?.message || e);
    }

    return res.status(200).json({
      ok: true,
      followed: { bundleId, platform, followedAt: new Date().toISOString() },
      schedule: { created: true },
    });
  } catch (e) {
    const code = e?.status || 500;
    return res.status(code).json({ ok: false, error: e?.message || "internal_error" });
  }
});

/**
 * DELETE /follow-app
 * Body: { bundleId, platform }
 */
router.delete("/follow-app", async (req, res) => {
  try {
    const userSub = requireAuth(req);
    const { bundleId, platform } = req.body || {};

    if (!bundleId || !platform) {
      return res.status(400).json({ ok: false, error: "bundleId and platform are required" });
    }

    const appKey = toAppKey(platform, bundleId);

    await ddb.send(
      new DeleteCommand({
        TableName: USER_FOLLOWS_TABLE,
        Key: { user_id: userSub, app_pk: appKey },
      })
    );

    return res.status(200).json({ ok: true, unfollowed: { bundleId, platform } });
  } catch (e) {
    const code = e?.status || 500;
    return res.status(code).json({ ok: false, error: e?.message || "internal_error" });
  }
});

/**
 * GET /follow-app
 * Retourne toutes les apps suivies pour l’utilisateur courant, enrichies avec metadata et liens.
 */
router.get("/follow-app", async (req, res) => {
  try {
    const userSub = requireAuth(req);

    // 1) Liste des follows (par user)
    const q = await ddb.send(
      new QueryCommand({
        TableName: USER_FOLLOWS_TABLE,
        KeyConditionExpression: "user_id = :u",
        ExpressionAttributeValues: { ":u": userSub },
      })
    );

    const items = q.Items || [];
    // 2) Carte des liens (fusion)
    const linksMap = await getLinks(userSub); // { [app_pk]: string[] }

    // 3) Enrichissement par metadata
    const result = [];
    for (const it of items) {
      const appKey = it.app_pk;
      const [platform, bundleId] = (appKey || "").split("#");

      const meta = await ddb.send(
        new GetCommand({
          TableName: APPS_METADATA_TABLE,
          Key: { app_pk: appKey },
        })
      );

      result.push({
        bundleId,
        platform,
        name: meta.Item?.name ?? null,
        icon: meta.Item?.icon ?? null,
        version: meta.Item?.version ?? null,
        rating: meta.Item?.rating ?? null,
        ratingCount: meta.Item?.ratingCount ?? null,
        releaseNotes: meta.Item?.releaseNotes ?? null,
        lastUpdatedAt: meta.Item?.lastUpdatedAt ?? null,
        linked_app_pks: dedup(linksMap[appKey]),
      });
    }

    return res.status(200).json({ followed: result });
  } catch (e) {
    const code = e?.status || 500;
    return res.status(code).json({ ok: false, error: e?.message || "internal_error" });
  }
});

export default router;