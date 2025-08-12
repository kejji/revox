// worker.js — Ingestion simple & idempotente de reviews vers DynamoDB
// -------------------------------------------------------------------
// SQS message attendu: { appName, platform: "android"|"ios", bundleId, backfillDays? }
//
// ENV requises:
//   - AWS_REGION
//   - APP_REVIEWS_TABLE
// -------------------------------------------------------------------

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require("@aws-sdk/lib-dynamodb");

// ---------- Config ----------
const REGION = process.env.AWS_REGION || "eu-west-3";
const TABLE  = process.env.APP_REVIEWS_TABLE;
const FIRST_RUN_DAYS = 150;
const MAX_BACKFILL_DAYS = 30;

// ---------- Clients ----------
const ddbDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

// ---------- Utils ----------
const toMillis = (v) => (v instanceof Date) ? v.getTime() : (Number.isFinite(+v) ? +v : Date.parse(v));
const toISODate = (v) => new Date(toMillis(v)).toISOString();
const norm = (s) => (s ?? "").toString().trim().toLowerCase();
function hashFNV1a(str = "") { let h = 0x811c9dc5>>>0; for (let i=0;i<str.length;i++){ h^=str.charCodeAt(i); h=(h+((h<<1)+(h<<4)+(h<<7)+(h<<8)+(h<<24)))>>>0;} return h.toString(36); }
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
    const from = new Date(now); from.setUTCDate(from.getUTCDate() - FIRST_RUN_DAYS);
    return { fromISO: from.toISOString(), toISO: now.toISOString(), reason: "first-run", effectiveBackfillDays: FIRST_RUN_DAYS };
  }
  const from = new Date(latestItem.date);
  from.setUTCDate(from.getUTCDate() - backfillDays);
  if (from.getTime() > now.getTime()) from.setTime(now.getTime());
  return { fromISO: from.toISOString(), toISO: now.toISOString(), reason: "incremental", effectiveBackfillDays: backfillDays };
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
    app_id: raw.app_id,                 // Android = bundleId, iOS = facultatif
    bundle_id: raw.bundle_id || raw.app_id,
    review_id: raw.review_id != null ? String(raw.review_id) : undefined,
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
  const cacheKey = item.ts_review;
  if (cache && cache.has(cacheKey)) return;
  await ddbDoc.send(new PutCommand({
    TableName: TABLE,
    Item: item,
    ConditionExpression: "attribute_not_exists(app_pk) AND attribute_not_exists(ts_review)"
  }));
  cache && cache.add(cacheKey);
}

// ---------- Scrapers ----------
async function scrapeAndroidReviews({ gplay, appName, bundleId, fromISO, toISO }) {
  const pageSize = 100;
  let token, out = [];
  while (true) {
    const resp = await gplay.reviews({
      appId: bundleId,
      sort: gplay.sort.NEWEST,
      num: pageSize,
      paginate: true,
      nextPaginationToken: token,
      lang: "fr",
      country: "fr",
    });
    const mapped = (resp?.data || []).map(r => ({
      app_name: appName,
      platform: "android",
      date: toISODate(r?.date),
      rating: r?.score,
      text: r?.text,
      user_name: r?.userName ?? "",
      app_version: r?.appVersion ?? "",
      app_id: bundleId,
      bundle_id: bundleId,
      review_id: r?.reviewId ? `android_${bundleId}_${r.reviewId}` : undefined,
    }));
    let passedFrom = false;
    for (const it of mapped) {
      if (isWithin(it.date, fromISO, toISO)) out.push(it);
      else if (new Date(it.date) < new Date(fromISO)) passedFrom = true;
    }
    if (passedFrom) break;
    token = resp?.nextPaginationToken;
    if (!token) break;
  }
  return out;
}

async function scrapeIosReviews({ store, appName, bundleId, fromISO, toISO }) {
  const MAX_PAGES = 10;
  let page = 1, out = [];
  while (page <= MAX_PAGES) {
    let resp = [];
    try {
      resp = await store.reviews({
        appId: bundleId,           // on passe TOUJOURS le bundleId ici
        sort: store.sort.RECENT,
        page,
        country: "fr",
        lang: "fr",
      });
    } catch (e) {
      console.error(`[iOS] page=${page} error:`, e?.message || e);
      break;
    }
    if (!Array.isArray(resp) || resp.length === 0) break;

    const mapped = resp.map(r => ({
      app_name: appName,
      platform: "ios",
      date: toISODate(r?.updated ?? r?.date),
      rating: r?.score ?? r?.rating,
      text: r?.text,
      user_name: r?.userName ?? "",
      app_version: r?.version ?? "",
      // app_id absent (numérique inconnu), c'est volontaire
      bundle_id: bundleId,
      review_id: r?.id ? `ios_${bundleId}_${r.id}` : undefined,
    }));
    let passedFrom = false;
    for (const it of mapped) {
      if (isWithin(it.date, fromISO, toISO)) out.push(it);
      else if (new Date(it.date) < new Date(fromISO)) passedFrom = true;
    }
    if (passedFrom) break;
    page += 1;
  }
  return out;
}

// ---------- Orchestration ----------
async function runIncremental({ appName, platform, bundleId, backfillDays, gplay, store }) {
  const plat = String(platform).toLowerCase();

  const latest = await getLatestReviewItem(plat, bundleId);
  const { fromISO, toISO, reason, effectiveBackfillDays } = computeWindow(latest, backfillDays);
  console.log(`[INC] app=${appName} plat=${plat} bundle=${bundleId} reason=${reason} backfillDays=${effectiveBackfillDays} window=${fromISO}→${toISO} latest=${latest ? latest.date : "none"}`);

  const fetched = plat === "android"
    ? await scrapeAndroidReviews({ gplay, appName, bundleId, fromISO, toISO })
    : await scrapeIosReviews({ store, appName, bundleId, fromISO, toISO });

  const ordered = (fetched || []).sort((a, b) => new Date(a.date) - new Date(b.date));
  const toInsert = ordered.filter(it => isWithin(it.date, fromISO, toISO));
  console.log(`[INC] after-filter count=${toInsert.length} min=${toInsert[0]?.date || null} max=${toInsert.at(-1)?.date || null}`);

  const cache = new Set();
  let ok = 0, dup = 0, ko = 0;
  await processInBatches(toInsert, 15, async (r) => {
    try { await saveReviewToDDB(r, { cache }); ok++; }
    catch (e) { if (e?.name === "ConditionalCheckFailedException") dup++; else { ko++; console.error("Put error:", e?.message || e); } }
  });
  console.log(`[INC] fetched=${fetched.length} sent=${toInsert.length} inserted=${ok} ddbDups=${dup} errors=${ko}`);
  return { fetched: fetched.length, sent: toInsert.length, inserted: ok, ddbDups: dup, errors: ko };
}

// ---------- Handler ----------
exports.handler = async (event) => {
  const { default: gplay } = await import("google-play-scraper");
  const { default: store } = await import("app-store-scraper");

  for (const rec of event.Records || []) {
    let msg;
    try { msg = JSON.parse(rec.body || "{}"); }
    catch { console.error("SQS message invalide:", rec.body); continue; }

    const { appName, platform, bundleId, backfillDays } = msg || {};
    if (!appName || !platform || !bundleId) { console.error("Message incomplet:", msg); continue; }

    try {
      const stats = await runIncremental({ appName, platform, bundleId, backfillDays, gplay, store });
      console.log("[INC] Résultat:", stats);
    } catch (e) {
      console.error("Erreur worker:", e?.message || e);
    }
  }
};