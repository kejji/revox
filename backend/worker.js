// worker.js — Ingestion simple & idempotente de reviews vers DynamoDB
// -------------------------------------------------------------------
// SQS message attendu: { appName, platform: "android"|"ios", appId, backfillDays? }
//
// ENV requises:
//   - AWS_REGION
//   - APP_REVIEWS_TABLE
//
// Idempotence sans lecture: PK = platform#bundleId, SK = dateISO#sig(date,text,user)
// -> Même review => même SK => Put conditionnel refuse toute réinsertion.
//
// -------------------------------------------------------------------

const https = require("https");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

// ---------- Config ----------
const REGION = process.env.AWS_REGION || "eu-west-3";
const TABLE  = process.env.APP_REVIEWS_TABLE;

const FIRST_RUN_DAYS   = 150; // fenêtre au premier run
const MAX_BACKFILL_DAYS = 30;

// ---------- Clients ----------
const ddbDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

// ---------- Utils ----------
const toMillis = (v) => {
  if (v instanceof Date) return v.getTime();
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : Date.now();
};
const toISODate = (v) => new Date(toMillis(v)).toISOString();
const norm = (s) => (s ?? "").toString().trim().toLowerCase();

// petit hash stable (FNV-1a)
function hashFNV1a(str = "") {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

// signature anti-doublon (sans lecture, sans GSI)
const sig3 = (dateISO, text, user) => hashFNV1a(`${dateISO}#${norm(text)}#${norm(user)}`);

const appPk = (platform, bundleId) => `${String(platform).toLowerCase()}#${bundleId}`;

const isWithin = (dateISO, fromISO, toISO) => {
  const t = new Date(dateISO).getTime();
  return t >= new Date(fromISO).getTime() && t <= new Date(toISO).getTime();
};

const processInBatches = async (items, size, fn) => {
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    await Promise.allSettled(slice.map(fn));
  }
};

// ---------- Fenêtre d’ingestion ----------
function normalizeBackfillDays(v, def = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(0, Math.floor(n)), MAX_BACKFILL_DAYS);
}

async function getLatestReviewItem(platform, bundleId) {
  const out = await ddbDoc.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "app_pk = :pk",
    ExpressionAttributeValues: { ":pk": appPk(platform, bundleId) },
    ScanIndexForward: false,
    Limit: 1
  }));
  return (out.Items && out.Items[0]) || null;
}

function computeWindow(latestItem, backfillDaysRaw) {
  const backfillDays = normalizeBackfillDays(backfillDaysRaw, 2);
  const now = new Date();

  if (!latestItem) {
    const from = new Date(now);
    from.setUTCDate(from.getUTCDate() - FIRST_RUN_DAYS);
    return { fromISO: from.toISOString(), toISO: now.toISOString(), reason: "first-run" };
  }
  const from = new Date(latestItem.date);
  from.setUTCDate(from.getUTCDate() - backfillDays);
  if (from.getTime() > now.getTime()) from.setTime(now.getTime());
  return { fromISO: from.toISOString(), toISO: now.toISOString(), reason: "incremental" };
}

// ---------- Normalisation + écriture ----------
function toDdbItem(raw) {
  const rv = {
    app_name: raw.app_name,
    platform: String(raw.platform || "").toLowerCase(),
    date: toISODate(raw.date),
    rating: raw.rating != null ? Number(raw.rating) : undefined,
    text: raw.text,
    user_name: raw.user_name,
    app_version: raw.app_version,
    app_id: raw.app_id,
    bundle_id: raw.bundle_id || raw.app_id,
    review_id: raw.review_id != null ? String(raw.review_id) : undefined, // informatif
  };

  const pk = appPk(rv.platform, rv.bundle_id);
  const sk = `${rv.date}#${sig3(rv.date, rv.text, rv.user_name)}`;

  return {
    app_pk: pk,
    ts_review: sk,
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

async function saveReviewToDDB(raw, { cache }) {
  const item = toDdbItem(raw);

  // dédup locale (ultra cheap)
  const cacheKey = item.ts_review; // clé réelle d’unicité
  if (cache && cache.has(cacheKey)) return;

  await ddbDoc.send(new PutCommand({
    TableName: TABLE,
    Item: item,
    ConditionExpression: "attribute_not_exists(app_pk) AND attribute_not_exists(ts_review)"
  }));

  cache && cache.add(cacheKey);
}

// ---------- Résolution bundleId ----------
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
        } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}
async function resolveBundleId(platform, appId) {
  return (String(platform).toLowerCase() === "ios") ? resolveIosBundleId(appId) : appId;
}

// ---------- Scrapers ----------
async function scrapeAndroidReviews({ gplay, appName, appId, fromISO, toISO }) {
  const pageSize = 100;
  let token;
  const out = [];

  while (true) {
    const resp = await gplay.reviews({
      appId,
      sort: gplay.sort.NEWEST,
      num: pageSize,
      paginate: true,
      nextPaginationToken: token,
      lang: "fr",
      country: "fr",
    });

    const mapped = (resp?.data || []).map((r) => ({
      app_name: appName,
      platform: "android",
      date: toISODate(r?.date),
      rating: r?.score,
      text: r?.text,
      user_name: r?.userName ?? "",
      app_version: r?.appVersion ?? "",
      app_id: appId,
      bundle_id: appId,
      review_id: r?.reviewId ? `android_${appId}_${r.reviewId}` : undefined, // info only
    }));

    // filtre fenêtre + arrêt quand on passe sous fromISO
    let passedFrom = false;
    for (const it of mapped) {
      if (isWithin(it.date, fromISO, toISO)) out.push(it);
      else if (new Date(it.date).getTime() < new Date(fromISO).getTime()) { passedFrom = true; }
    }
    if (passedFrom) break;

    token = resp?.nextPaginationToken;
    if (!token) break;
  }

  return out;
}

async function scrapeIosReviews({ store, appName, appId, bundleId, fromISO, toISO }) {
  const MAX_PAGES = 10;
  let page = 1;
  const out = [];
  let useBundleParam = false;

  while (page <= MAX_PAGES) {
    const args = {
      sort: store.sort.RECENT,
      page,
      country: "fr",
      lang: "fr",
      ...(useBundleParam ? { appId: bundleId } : { id: appId }),
    };

    let resp = [];
    try {
      resp = await store.reviews(args);
    } catch (e) {
      if (page === 1 && !useBundleParam) { useBundleParam = true; continue; }
      console.error(`[iOS] page=${page} error:`, e?.message || e);
      break;
    }

    if (!Array.isArray(resp) || resp.length === 0) {
      if (page === 1 && !useBundleParam) { useBundleParam = true; continue; }
      break;
    }

    // map
    const mapped = resp.map((r) => ({
      app_name: appName,
      platform: "ios",
      date: toISODate(r?.updated ?? r?.date),
      rating: r?.score ?? r?.rating,
      text: r?.text,
      user_name: r?.userName ?? "",
      app_version: r?.version ?? "",
      app_id: appId,       // id numérique
      bundle_id: bundleId, // reverse-DNS
      review_id: r?.id ? `ios_${bundleId}_${r.id}` : undefined, // info only
    }));

    // filtre fenêtre + arrêt si on passe sous fromISO
    let passedFrom = false;
    for (const it of mapped) {
      if (isWithin(it.date, fromISO, toISO)) out.push(it);
      else if (new Date(it.date).getTime() < new Date(fromISO).getTime()) { passedFrom = true; }
    }
    if (passedFrom) break;

    page += 1;
  }

  return out;
}

// ---------- Orchestration ----------
async function runIncremental({ appName, platform, appId, backfillDays, gplay, store }) {
  const plat = String(platform).toLowerCase();
  const bundleId = await resolveBundleId(plat, appId);

  const latest = await getLatestReviewItem(plat, bundleId);
  const { fromISO, toISO, reason } = computeWindow(latest, backfillDays);
  console.log(`[INC] app=${appName} plat=${plat} bundle=${bundleId} reason=${reason} window=${fromISO}→${toISO}`);

  let fetched = [];
  if (plat === "android") fetched = await scrapeAndroidReviews({ gplay, appName, appId: bundleId, fromISO, toISO });
  else fetched = await scrapeIosReviews({ store, appName, appId, bundleId, fromISO, toISO });

  // tri ascendant (cohérence), dédup locale (rare)
  const ordered = (fetched || []).sort((a, b) => new Date(a.date) - new Date(b.date));
  const cache = new Set();
  let ok = 0, dup = 0, ko = 0;

  await processInBatches(ordered, 15, async (r) => {
    try { await saveReviewToDDB(r, { cache }); ok++; }
    catch (e) {
      if (e?.name === "ConditionalCheckFailedException") dup++;
      else { ko++; console.error("Put error:", e?.message || e); }
    }
  });

  console.log(`[INC] fetched=${fetched.length} inserted=${ok} ddbDups=${dup} errors=${ko}`);
  return { fetched: fetched.length, inserted: ok, ddbDups: dup, errors: ko };
}

// ---------- Handler ----------
exports.handler = async (event) => {
  const { default: gplay } = await import("google-play-scraper");
  const { default: store } = await import("app-store-scraper");

  for (const rec of event.Records || []) {
    let msg;
    try { msg = JSON.parse(rec.body || "{}"); }
    catch { console.error("SQS message invalide:", rec.body); continue; }

    const { appName, platform, appId, backfillDays } = msg || {};
    if (!appName || !platform || !appId) { console.error("Message incomplet:", msg); continue; }

    try {
      const stats = await runIncremental({ appName, platform, appId, backfillDays, gplay, store });
      console.log("[INC] Résultat:", stats);
    } catch (e) {
      console.error("Erreur worker:", e?.message || e);
    }
  }
};