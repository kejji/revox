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

// Paramétres pour la fenêtre de scraping
const MAX_BACKFILL_DAYS = 30;
const FIRST_RUN_DAYS = 30;

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

async function saveReviewToDDB(rawReview, { cache } = {}) {
  const rv = normalizeReview(rawReview);
  const item = toDdbItem(rv);
  const rid = item.review_id;

  if (cache && cache.has(rid)) return; // dédup locale

  await ddbDoc.send(new PutCommand({
    TableName: APP_REVIEWS_TABLE,
    Item: item,
    ConditionExpression: "attribute_not_exists(app_pk) AND attribute_not_exists(ts_review)"
  }));

  cache && cache.add(rid);
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

function normalizeBackfillDays(v, def = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(0, Math.floor(n)), MAX_BACKFILL_DAYS);
}

function computeWindow(latestItem, backfillDaysRaw) {
  const backfillDays = normalizeBackfillDays(backfillDaysRaw, 2);
  const to = new Date();

  if (!latestItem) {
    // Premier run : on récupère un historique raisonnable (configurable)
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - FIRST_RUN_DAYS);
    return { fromISO: from.toISOString(), toISO: to.toISOString(), reason: "first-run" };
  }

  // On repart depuis la dernière date connue - backfillDays
  const from = new Date(latestItem.date);
  from.setUTCDate(from.getUTCDate() - backfillDays);

  // Protection horloge (si last > now suite à skew)
  if (from.getTime() > to.getTime()) {
    from.setTime(to.getTime());
  }

  return { fromISO: from.toISOString(), toISO: to.toISOString(), reason: "incremental" };
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

// hash déterministe (FNV-1a) pour fallback d'ID
function hashFNV1a(str = "") {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

/**
 * Règle d'ID canonique (sans lecture en base) :
 * - iOS    -> ios_${bundleId}_${storeId}    (legacy iOS)
 * - Android-> android_${bundleId}_${ts}_${hash(text|user)} (legacy Android)
 */
function buildReviewId({ platform, bundleId, storeId, dateISO, text, user_name }) {
  const p = String(platform).toLowerCase();
  if (p === "ios" && storeId) {
    return `ios_${bundleId}_${String(storeId)}`;
  }
  // ANDROID (et fallback iOS au pire) : legacy canonique
  const ts = toMillisSafe(dateISO);
  const sig = hashFNV1a(`${(text || "").trim().slice(0,200)}|${(user_name || "").trim().toLowerCase()}`);
  return `${p}_${bundleId}_${ts}_${sig}`;
}

async function existsByReviewId(reviewId) {
  const out = await ddbDoc.send(new QueryCommand({
    TableName: APP_REVIEWS_TABLE,
    IndexName: "by_review_id",
    KeyConditionExpression: "review_id = :rid",
    ExpressionAttributeValues: { ":rid": String(reviewId) },
    Limit: 1
  }));
  return !!(out.Items && out.Items.length);
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
  const pageSize = 100;
  let token = undefined;
  let results = [];
  let keepPaging = true;

  // Helpers robustes
  // date -> timestamp en ms (robuste: string/Date/number)
  function toMillis(v) {
    if (v instanceof Date) return v.getTime();
    const t = typeof v === "number" ? v : Date.parse(v);
    return Number.isFinite(t) ? t : Date.now();
  }
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
      const rid = buildReviewId({
        platform: "android",
        bundleId: appId,
        storeId: r?.reviewId,
        dateISO: dateISO,
        text: r?.text,
        user_name: r?.userName
      });

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
        review_id: rid,
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

  // Helpers dates robustes
  const toMillis = (v) => {
    if (v instanceof Date) return v.getTime();
    const t = typeof v === "number" ? v : Date.parse(v);
    return Number.isFinite(t) ? t : Date.now();
  };
  const toISODate = (v) => new Date(toMillis(v)).toISOString();

  // Certaines versions attendent { id: <num> }, d'autres { appId: <bundle> }.
  // On tente d'abord "id", puis si page1 vide on bascule sur "appId".
  let useBundleParam = false;

  while (page <= MAX_PAGES) {
    const args = {
      sort: store.sort.RECENT,
      page,
      country: "fr",
      lang: "fr",
      ...(useBundleParam ? { appId: bundleId } : { id: appId }),
    };

    let resp;
    try {
      resp = await store.reviews(args);
    } catch (e) {
      // Si la 1ère page échoue avec "id", retente avec "appId"
      if (page === 1 && !useBundleParam) {
        useBundleParam = true;
        continue; // relance cette page avec appId=bundleId
      }
      console.error(`[iOS] erreur page=${page} (${useBundleParam ? "appId" : "id"}):`, e.message || e);
      break;
    }

    const arr = Array.isArray(resp) ? resp : [];
    // Si 1ère page vide avec "id", retente avec "appId"
    if (page === 1 && !useBundleParam && arr.length === 0) {
      useBundleParam = true;
      continue; // relance page 1
    }

    if (arr.length === 0) break;

    let sawOlder = false;

    for (const r of arr) {
      // Certaines versions renvoient r.updated, d'autres r.date
      const dateISO = toISODate(r?.updated ?? r?.date);
      const t = new Date(dateISO).getTime();

      if (t >= new Date(fromISO).getTime() && t <= new Date(toISO).getTime()) {
        const rid = buildReviewId({
          platform: "ios",
          bundleId: bundleId,
          storeId: r?.id,                      // prioritaire si présent
          dateISO,
          text: r?.text,
          user_name: r?.userName
        });

        results.push({
          app_name: appName,
          platform: "ios",
          date: dateISO,
          rating: r?.score ?? r?.rating ?? undefined,
          text: r?.text,
          user_name: r?.userName ?? "",
          app_version: r?.version ?? "",
          app_id: appId,        // id numérique
          bundle_id: bundleId,  // reverse-DNS
          review_id: rid,
        });
      } else if (t < new Date(fromISO).getTime()) {
        sawOlder = true; // on est passé sous la fenêtre; pages suivantes seront encore plus anciennes
      }
    }

    if (sawOlder) break;

    page += 1;
    // petite pause anti‑rate limit (facultatif)
    await new Promise((r) => setTimeout(r, 500));
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
  const { fromISO, toISO, reason } = computeWindow(latest, backfillDays);
  console.log(`[INC] app=${appName} plat=${platformL} bundle=${bundleId} ` +
    `reason=${reason} window=${fromISO} → ${toISO} (backfillDays=${normalizeBackfillDays(backfillDays, 2)})`);
  // 2) Scrape
  let fetched = [];
  if (platformL === "android") {
    fetched = await scrapeAndroidReviews({ gplay, appName, appId: bundleId, fromISO, toISO });
  } else {
    fetched = await scrapeIosReviews({ store, appName, appId, bundleId, fromISO, toISO });
  }

  // 3) Insertions idempotentes (tri par date croissante pour la cohérence)
  const toInsert = (fetched || []).sort((a, b) => new Date(a.date) - new Date(b.date));

  // 4) Dédup
  const seenInBatch = new Set();
  const uniqByRid = [];
  for (const it of toInsert) {
    if (seenInBatch.has(it.review_id)) continue;
    seenInBatch.add(it.review_id);
    uniqByRid.push(it);
  }
  
  const cache = new Set();
  await processInBatches(uniqByRid, 15, (r) => saveReviewToDDB(r, { cache }));

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