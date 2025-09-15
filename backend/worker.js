// worker.js — Ingestion simple & idempotente de reviews vers DynamoDB
// -------------------------------------------------------------------
// SQS message attendu: { platform: "android"|"ios", bundleId, backfillDays? }
//
// ENV requises:
//   - AWS_REGION
//   - APP_REVIEWS_TABLE
// -------------------------------------------------------------------

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand, GetCommand } = require("@aws-sdk/lib-dynamodb");

// ---------- Config ----------
const REGION = process.env.AWS_REGION;
const REVIEWS_TABLE = process.env.APP_REVIEWS_TABLE;
const FIRST_RUN_DAYS = 150;
const MAX_BACKFILL_DAYS = 30;
const METADATA_TABLE = process.env.APPS_METADATA_TABLE;
const THEMES_TABLE = process.env.APPS_THEMES_TABLE;
// ---------- Clients ----------
const ddbDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);


// ---------- Helper ----------
async function bumpAppReviewCounter({ platform, bundleId, inserted }) {
  if (!inserted || inserted <= 0) return;
  const pk = appPk(platform, bundleId);
  try {
    await ddbDoc.send(new UpdateCommand({
      TableName: METADATA_TABLE,
      Key: { app_pk: pk },
      // ADD est atomique; on set aussi un "last_ingest_at" pour info
      UpdateExpression: `ADD total_reviews :inc SET last_ingest_at = :now`,
      ExpressionAttributeValues: { ":inc": inserted, ":now": new Date().toISOString() },
    }));
    console.log(`[COUNTER] ${pk} += ${inserted}`);
  } catch (e) {
    console.error("[COUNTER] update error:", e?.message || e);
  }
}

function todayYMD() { return new Date().toISOString().slice(0, 10); }

// ---------- Compteurs : self-heal si pré-remplissage ----------
async function countAllReviewsByPk(app_pk) {
  let count = 0, lastKey;
  do {
    const q = await ddbDoc.send(new QueryCommand({
      TableName: REVIEWS_TABLE,
      KeyConditionExpression: "app_pk = :pk",
      ExpressionAttributeValues: { ":pk": app_pk },
      Select: "COUNT",
      ExclusiveStartKey: lastKey
    }));
    count += q.Count || 0;
    lastKey = q.LastEvaluatedKey;
  } while (lastKey);
  return count;
}

async function ensureTotalInitialized({ platform, bundleId, inserted }) {
  const pk = appPk(platform, bundleId);
  try {
    // Si on a inséré quelque chose, l'ADD du compteur suffit.
    if (inserted > 0) return;
    // Vérifie l'état courant du compteur
    const meta = await ddbDoc.send(new GetCommand({
      TableName: METADATA_TABLE,
      Key: { app_pk: pk },
      ProjectionExpression: "total_reviews"
    }));
    const current = meta.Item?.total_reviews;
    if (Number.isFinite(current) && current > 0) return; // déjà initialisé
    // Compte réel en base (peut paginer si >1 Mo)
    const accurate = await countAllReviewsByPk(pk);
    // Écrit une seule fois si 0/absent (idempotent)
    await ddbDoc.send(new UpdateCommand({
      TableName: METADATA_TABLE,
      Key: { app_pk: pk },
      UpdateExpression: "SET total_reviews = :n, last_ingest_at = :now",
      ConditionExpression: "attribute_not_exists(total_reviews) OR total_reviews = :zero",
      ExpressionAttributeValues: {
        ":n": accurate,
        ":now": new Date().toISOString(),
        ":zero": 0
      }
    }));
    console.log(`[COUNTER_INIT] ${pk} total_reviews set to ${accurate}`);
  } catch (e) {
    console.warn("[COUNTER_INIT] skipped:", e?.message || e);
  }
}

// ---------- Lookup helpers ----------
async function getAppNameFromMetadata(platform, bundleId) {
  if (!METADATA_TABLE) return null;
  try {
    const pk = appPk(platform, bundleId);
    const out = await ddbDoc.send(new QueryCommand({
      TableName: METADATA_TABLE,
      // NB: on a une PK simple sur app_pk → GetItem serait suffisant, mais on garde la même lib
      // Si tu préfères: use GetCommand avec Key: { app_pk: pk }
    }));
  } catch { }
  try {
    const pk = appPk(platform, bundleId);
    const { GetCommand } = require("@aws-sdk/lib-dynamodb");
    const got = await ddbDoc.send(new GetCommand({
      TableName: METADATA_TABLE,
      Key: { app_pk: pk },
      ProjectionExpression: "#n",
      ExpressionAttributeNames: { "#n": "name" }
    }));
    return got?.Item?.name ?? null;
  } catch (e) {
    console.warn("[worker] getAppNameFromMetadata error:", e?.message || e);
    return null;
  }
}

// ---------- Utils ----------
const toMillis = (v) => (v instanceof Date) ? v.getTime() : (Number.isFinite(+v) ? +v : Date.parse(v));
const toISODate = (v) => new Date(toMillis(v)).toISOString();
const norm = (s) => (s ?? "").toString().trim().toLowerCase();
function hashFNV1a(str = "") { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; } return h.toString(36); }
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
    TableName: REVIEWS_TABLE,
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
  };
  const pk = appPk(rv.platform, rv.bundle_id);
  const sk = `${rv.date}#${sig3(rv.date, rv.text, rv.user_name)}`;
  return {
    app_pk: pk,
    ts_review: sk,
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
    TableName: REVIEWS_TABLE,
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
      app_version: r?.version ?? "",
      bundle_id: bundleId,
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
      bundle_id: bundleId,
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

// ---------- Analyse des thèmes ----------
async function handleAnalyzeThemes({ app_pk, from, to, limit }) {
  // Import ESM au moment de l’appel (interop simple & sûr)
  const { fetchReviewsRange, fetchReviewsLatest } = await import("./reviewsThemes.js");
  const { analyzeThemesWithOpenAI } = await import("./openaiThemes.js");

  let reviews, selection = {};

  if (from || to) {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(new Date(end).setUTCDate(end.getUTCDate() - 90));
    const fromISO = start.toISOString();
    const toISO = end.toISOString();
    reviews = await fetchReviewsRange(app_pk, fromISO, toISO, 2000);
    selection = { from: fromISO, to: toISO };
  } else if (limit) {
    // appeler bien fetchReviewsLatest (sans "2")
    reviews = await fetchReviewsLatest(app_pk, Number(limit));
    selection = { limit: Number(limit) };
  } else {
    const end = new Date();
    const start = new Date(new Date().setUTCDate(end.getUTCDate() - 90));
    const fromISO = start.toISOString();
    const toISO = end.toISOString();
    reviews = await fetchReviewsRange(app_pk, fromISO, toISO, 2000);
    selection = { from: fromISO, to: toISO };
  }

  const result = await analyzeThemesWithOpenAI({
    appPks: [app_pk],
    from: selection.from,
    to: selection.to,
    lang: "fr",
    posCutoff: 4,
    negCutoff: 3,
    topN: 3
  }, reviews);

  await ddbDoc.send(new PutCommand({
    TableName: THEMES_TABLE,
    Item: {
      app_pk,
      sk: `theme#${todayYMD()}`,
      selection,
      total_reviews_considered: reviews.length,
      result,
      created_at: new Date().toISOString()
    },
    ConditionExpression: "attribute_not_exists(app_pk) AND attribute_not_exists(sk)"
  }));

  console.log(`[ANALYZE_THEMES] done for ${app_pk} reviews=${reviews.length}`);
}

// ---------- Handler ----------
exports.handler = async (event) => {
  const { default: gplay } = await import("google-play-scraper");
  const { default: store } = await import("app-store-scraper");

  for (const rec of event.Records || []) {
    let msg;
    try { msg = JSON.parse(rec.body || "{}"); }
    catch { console.error("SQS message invalide:", rec.body); continue; }

    if (msg.mode === "ANALYZE_THEMES") {
      try {
        await handleAnalyzeThemes(msg);
      } catch (e) {
        console.error("[ANALYZE_THEMES] error:", e?.message || e);
      }
      continue;
    }
    const { appName, platform, bundleId, backfillDays } = msg || {};
    if (!platform || !bundleId) { console.error("Message incomplet (platform/bundleId requis):", msg); continue; }

    // Résolution robuste du nom d'app si manquant
    let resolvedName = appName;
    if (!resolvedName) {
      resolvedName = await getAppNameFromMetadata(platform, bundleId);
      if (!resolvedName) {
        resolvedName = bundleId;
      }
    }
    try {
      const stats = await runIncremental({ appName: resolvedName, platform, bundleId, backfillDays, gplay, store });
      console.log("[INC] Résultat:", stats);
      await bumpAppReviewCounter({ platform, bundleId, inserted: stats.inserted });
      await ensureTotalInitialized({ platform, bundleId, inserted: stats.inserted });
    } catch (e) {
      console.error("Erreur worker:", e?.message || e);
    }
  }
};