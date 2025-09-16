// backend/themesWorker.js
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

const REGION = process.env.AWS_REGION;
const THEMES_TABLE = process.env.APPS_THEMES_TABLE;

const ddbDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const reviewsMod = require("./reviewsThemes");
const openaiMod = require("./openaiThemes");

// Log de diagnostic pour voir ce que Node charge vraiment
try {
  console.log("[THEMES] reviewsThemes exports keys:", Object.keys(reviewsMod));
  if (reviewsMod.default) console.log("[THEMES] reviewsThemes.default keys:", Object.keys(reviewsMod.default));
  console.log("[THEMES] openaiThemes exports keys:", Object.keys(openaiMod));
  if (openaiMod.default) console.log("[THEMES] openaiThemes.default keys:", Object.keys(openaiMod.default));
} catch (_) { }

// Résolution robuste (CJS, ESM, alias éventuels)
const fetchReviewsRange =
  reviewsMod.fetchReviewsRange ||
  reviewsMod.default?.fetchReviewsRange;

const fetchReviewsLatest =
  reviewsMod.fetchReviewsLatest ||
  reviewsMod.fetchReviewsLatest2 ||                 // compat ancien symbole
  reviewsMod.default?.fetchReviewsLatest ||
  reviewsMod.default?.fetchReviewsLatest2;          // compat si exporté sous default

const analyzeThemesWithOpenAI =
  openaiMod.analyzeThemesWithOpenAI ||
  openaiMod.default?.analyzeThemesWithOpenAI;

function todayYMD() { return new Date().toISOString().slice(0, 10); }

async function handleAnalyzeThemes({ app_pk, from, to, limit }) {

  function splitAppPks(app_pk) {
    return String(app_pk || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
  }

  async function handleAnalyzeThemes({ app_pk, from, to, limit }) {
    const appPks = splitAppPks(app_pk);
    if (appPks.length === 0) throw new Error("No app_pk provided");
    let reviews = [];
    let selection = {};

    if (from || to) {
      // --- Mode période (merge multi-apps)
      const end = to ? new Date(to) : new Date();
      const start = from ? new Date(from) : new Date(new Date(end).setUTCDate(end.getUTCDate() - 90));
      const fromISO = start.toISOString();
      const toISO = end.toISOString();
      const perApp = 1200; // plafond sécurité
      const batches = await Promise.all(appPks.map(pk => fetchReviewsRange(pk, fromISO, toISO, perApp)));
      reviews = batches.flat().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
      selection = { from: fromISO, to: toISO };
    } else if (limit) {
      // --- Mode "N derniers avis" (répartir le quota entre apps)
      const n = Math.max(1, Math.min(2000, Number(limit)));
      const perApp = Math.ceil(n / appPks.length);
      const batches = await Promise.all(appPks.map(pk => fetchReviewsLatest(pk, perApp)));
      reviews = batches.flat().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0)).slice(0, n);
      selection = { limit: n };
    } else {
      // --- Défaut: 90 jours
      const end = new Date();
      const start = new Date(new Date().setUTCDate(end.getUTCDate() - 90));
      const fromISO = start.toISOString();
      const toISO = end.toISOString();
      const perApp = 1200;
      const batches = await Promise.all(appPks.map(pk => fetchReviewsRange(pk, fromISO, toISO, perApp)));
      reviews = batches.flat().sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
      selection = { from: fromISO, to: toISO };
    }

    const result = await analyzeThemesWithOpenAI(
      {
        appPks: appPks,
        from: selection.from,
        to: selection.to,
        lang: "fr",
        posCutoff: 4,
        negCutoff: 3,
        topN: 3,
      },
      reviews
    );

    // Clé PK stable pour l’item agrégé (ordre déterministe)
    const pkStable = appPks.slice().sort().join(",");
    await ddbDoc.send(new PutCommand({
      TableName: THEMES_TABLE,
      Item: {
        app_pk: pkStable,
        sk: `theme#${todayYMD()}`,
        selection,
        total_reviews_considered: reviews.length,
        result,
        created_at: new Date().toISOString(),
      },
      ConditionExpression: "attribute_not_exists(app_pk) AND attribute_not_exists(sk)",
    }));

    console.log(`[THEMES] done for ${pkStable} apps=${appPks.length} reviews=${reviews.length}`);
  }
}

exports.handler = async (event) => {
  for (const rec of event.Records || []) {
    let msg;
    try { msg = JSON.parse(rec.body || "{}"); }
    catch { console.error("[THEMES] invalid SQS body:", rec.body); continue; }

    if (!msg?.app_pk) { console.error("[THEMES] missing app_pk:", msg); continue; }

    try {
      await handleAnalyzeThemes(msg);
    } catch (e) {
      console.error("[THEMES] error:", e?.message || e);
    }
  }
};