// worker.js — Ingestion incrémentale des reviews vers DynamoDB (APP_REVIEWS)
// ---------------------------------------------------------------------------
// Ce worker lit des messages SQS contenant { appName, platform, appId, backfillDays? }
// 1) Lit en base la dernière review connue pour l'app
// 2) Calcule une fenêtre [fromISO, toISO] (avec petit backfill de sécurité)
// 3) Scrape le store (Android/iOS) sur la fenêtre
// 4) Ecrit les nouvelles reviews dans APP_REVIEWS en Put idempotent
//
// ENV attendues :
//   - AWS_REGION
//   - APP_REVIEWS_TABLE
//
// Permissions IAM (Lambda):
//   - dynamodb:Query sur la table APP_REVIEWS
//   - dynamodb:PutItem sur la table APP_REVIEWS
//
// ---------------------------------------------------------------------------

const https = require("https");
const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

// Région & table
const AWS_REGION = process.env.AWS_REGION;
const APP_REVIEWS_TABLE = process.env.APP_REVIEWS_TABLE;

// Doc client DynamoDB
const ddbDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

// ---------------------------------------------------------------------------
// Normalisation + écriture DDB (idempotente)
// ---------------------------------------------------------------------------

function normalizeReview(raw) {
  return {
    app_name: raw.app_name,
    platform: String(raw.platform || "").toLowerCase(), // "ios" | "android"
    date: new Date(raw.date).toISOString(),
    rating: raw.rating != null ? Number(raw.rating) : undefined,
    text: raw.text,
    user_name: raw.user_name,
    app_version: raw.app_version,
    app_id: raw.app_id,
    bundle_id: raw.bundle_id || raw.app_id,
    review_id: String(raw.review_id),
  };
}

function toDdbItem(rv) {
  const app_pk = `${rv.platform}#${rv.bundle_id}`;
  const ts_review = `${rv.date}#${rv.review_id}`;
  return {
    app_pk,
    ts_review,
    review_id: rv.review_id,
    date: rv.date,
    rating: rv.rating,
    text: rv.text,
    user_name: rv.user_name,
    app_version: rv.app_version,
    platform: rv.platform,
    app_name: rv.app_name,
    app_id: rv.app_id,
    bundle_id: rv.bundle_id,
    ingested_at: new Date().toISOString(),
    source: "store-scraper-v1",
  };
}

async function saveReviewToDDB(rawReview) {
  const rv = normalizeReview(rawReview);
  const item = toDdbItem(rv);

  await ddbDoc.send(new PutCommand({
    TableName: APP_REVIEWS_TABLE,
    Item: item,
    ConditionExpression: "attribute_not_exists(app_pk) AND attribute_not_exists(ts_review)", // idempotence
  }));
}

// ---------------------------------------------------------------------------
// Helpers incrémental : clé d'app, dernière review, fenêtre
// ---------------------------------------------------------------------------

function appPk(platform, bundleId) {
  return `${String(platform).toLowerCase()}#${bundleId}`;
}

async function getLatestReviewItem(platform, bundleId) {
  const pk = appPk(platform, bundleId);
  const out = await ddbDoc.send(new QueryCommand({
    TableName: APP_REVIEWS_TABLE,
    KeyConditionExpression: "app_pk = :pk",
    ExpressionAttributeValues: { ":pk": pk },
    ScanIndexForward: false, // plus récent d'abord
    Limit: 1,
  }));
  return (out.Items && out.Items[0]) || null;
}

function computeWindow(latestItem, backfillDays = 1) {
  const toISO = new Date().toISOString();
  if (!latestItem) {
    // Premier run : remonte large (30 jours) — ajuste au besoin
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - 30);
    return { fromISO: from.toISOString(), toISO };
  }
  const last = new Date(latestItem.date);
  // Petit backfill (= on repart 1–2 jours en arrière pour éviter les trous)
  last.setUTCDate(last.getUTCDate() - Math.max(0, Number(backfillDays) || 1));
  return { fromISO: last.toISOString(), toISO };
}

function isWithin(dateISO, fromISO, toISO) {
  const t = new Date(dateISO).getTime();
  return t >= new Date(fromISO).getTime() && t <= new Date(toISO).getTime();
}

async function processInBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    await Promise.allSettled(slice.map(fn));
  }
}

// ---------------------------------------------------------------------------
// iOS : resolve bundleId via iTunes Lookup si besoin
// ---------------------------------------------------------------------------

async function resolveIosBundleId(appId) {
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(appId)}`;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const bundleId = json?.results?.[0]?.bundleId;
          if (!bundleId) return reject(new Error("bundleId iOS introuvable"));
          resolve(bundleId);
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

async function resolveBundleId(platform, appId) {
  if (String(platform).toLowerCase() === "ios") {
    return resolveIosBundleId(appId);
  }
  // Android : bundleId === packageName
  return appId;
}

// ---------------------------------------------------------------------------
// Scrapers (Android / iOS) — pagination + filtrage par fenêtre
// On utilise les libs dynamiquement importées dans le handler.
// ---------------------------------------------------------------------------

async function scrapeAndroidReviews({ gplay, appName, appId, fromISO, toISO }) {
  // appId = packageName (ex: "com.fortuneo.android")
  const pageSize = 100;
  let token = undefined;
  let results = [];
  let keepPaging = true;

  // Helpers robustes
  const toMillis = (v) => {
    const t = typeof v === "number" ? v : Date.parse(v);
    return Number.isFinite(t) ? t : Date.now();
  };
  const toISODate = (v) => new Date(toMillis(v)).toISOString();

  while (keepPaging) {
    const resp = await gplay.reviews({
      appId,
      sort: gplay.sort.NEWEST,
      num: pageSize,
      paginate: true,
      nextPaginationToken: token,
      lang: "fr",
      country: "fr",
    });

    const list = (resp?.data || []).map((r) => {
      const dateISO = toISODate(r?.date);
      // review_id: privilégie l'ID fourni, sinon fallback stable basé sur timestamp
      const rid = r?.reviewId || `${appId}_${toMillis(r?.date)}`;

      return {
        app_name: appName,
        platform: "android",
        date: dateISO,
        rating: r?.score,
        text: r?.text,
        user_name: r?.userName ?? "",
        app_version: r?.appVersion ?? "",
        app_id: appId,
        bundle_id: appId,
        review_id: String(rid),
      };
    });

    // Filtrer sur la fenêtre (et stopper si on est passé avant fromISO)
    for (const it of list) {
      if (isWithin(it.date, fromISO, toISO)) {
        results.push(it);
      } else if (new Date(it.date).getTime() < new Date(fromISO).getTime()) {
        keepPaging = false;
        break;
      }
    }

    token = resp?.nextPaginationToken;
    if (!token) break;
  }

  return results;
}

async function scrapeIosReviews({ store, appName, appId, bundleId, fromISO, toISO }) {
  const MAX_PAGES = 10;      // app-store-scraper autorise 1..10
  let page = 1;
  let results = [];

  const toMillis = (v) => {
    if (v instanceof Date) return v.getTime();
    const t = typeof v === "number" ? v : Date.parse(v);
    return Number.isFinite(t) ? t : Date.now();
  };
  const toISODate = (v) => new Date(toMillis(v)).toISOString();

  while (page <= MAX_PAGES) {
    const resp = await store.reviews({
      id: appId,                 // id numérique iOS (ex: "310790181")
      sort: store.sort.RECENT,   // plus récent → plus ancien
      page,                      // 1..10
      country: "fr",
      lang: "fr",
    });

    const arr = Array.isArray(resp) ? resp : [];
    console.log(`[iOS] page=${page} items=${arr.length}`);

    if (arr.length === 0) break;

    let sawOlder = false;

    for (const r of arr) {
      const dateISO = toISODate(r?.date);
      const t = new Date(dateISO).getTime();

      if (t >= new Date(fromISO).getTime() && t <= new Date(toISO).getTime()) {
        results.push({
          app_name: appName,
          platform: "ios",
          date: dateISO,
          rating: r?.score ?? r?.rating,   // selon versions de la lib
          text: r?.text,
          user_name: r?.userName ?? "",
          app_version: r?.version ?? "",
          app_id: appId,
          bundle_id: bundleId,
          review_id: String(r?.id ?? `${appId}_${page}_${t}`),
        });
      } else if (t < new Date(fromISO).getTime()) {
        sawOlder = true;
      }
    }

    if (sawOlder) break; // les pages suivantes seront encore plus anciennes
    page += 1;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Orchestration incrémentale : calcule fenêtre -> scrape -> insert
// ---------------------------------------------------------------------------

async function runIncremental({ appName, platform, appId, backfillDays, gplay, store }) {
  const platformL = String(platform).toLowerCase();
  const bundleId = await resolveBundleId(platformL, appId);

  // 1) Dernière review en base
  const latest = await getLatestReviewItem(platformL, bundleId);
  const { fromISO, toISO } = computeWindow(latest, backfillDays);
  console.log(`[INC] ${platformL} ${bundleId} window: ${fromISO} → ${toISO}`);

  // 2) Scrape
  let fetched = [];
  if (platformL === "android") {
    fetched = await scrapeAndroidReviews({ gplay, appName, appId: bundleId, fromISO, toISO });
  } else {
    fetched = await scrapeIosReviews({ store, appName, appId, bundleId, fromISO, toISO });
  }

  // 3) Insertions idempotentes (tri par date croissante pour la cohérence)
  const toInsert = (fetched || []).sort((a, b) => new Date(a.date) - new Date(b.date));
  let ok = 0, dup = 0, ko = 0;

  await processInBatches(toInsert, 15, async (r) => {
    try {
      await saveReviewToDDB(r);
      ok++;
    } catch (e) {
      if (e?.name === "ConditionalCheckFailedException") dup++;
      else { ko++; console.error("saveReviewToDDB error:", e?.message || e); }
    }
  });

  console.log(`[INC] inserted=${ok} dups=${dup} errors=${ko}`);
  return { inserted: ok, duplicates: dup, errors: ko, totalFetched: fetched.length };
}

// ---------------------------------------------------------------------------
// Handler SQS — route messages "incremental"
// ---------------------------------------------------------------------------

exports.handler = async (event) => {
  // Import dynamique des libs de scraping (garde le cold start raisonnable)
  const { default: gplay } = await import("google-play-scraper");
  const { default: store } = await import("app-store-scraper");

  for (const record of event.Records || []) {
    let message = null;
    try {
      message = JSON.parse(record.body || "{}");
    } catch {
      console.error("Message SQS invalide:", record.body);
      continue;
    }

    const { appName, platform, appId, backfillDays } = message || {};
    if (!appName || !platform || !appId) {
      console.error("Message incomplet, ignoré:", message);
      continue;
    }

    try {
      const stats = await runIncremental({ appName, platform, appId, backfillDays, gplay, store });
      console.log("[INC] Résultat:", stats);
    } catch (error) {
      console.error("Erreur dans le worker (message):", error);
      // Pas de mise à jour d'une table d'extraction ici : ce worker est désormais "DB-first"
    }
  }
};