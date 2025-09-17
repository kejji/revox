// backend/themesWorker.js
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const REGION = process.env.AWS_REGION;
const THEMES_TABLE = process.env.APPS_THEMES_TABLE;

const ddbDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const reviewsMod = require("./reviewsThemes");
const openaiMod = require("./openaiThemes");

// Résolution robuste (CJS/ESM)
const fetchReviewsRange =
  reviewsMod.fetchReviewsRange || reviewsMod.default?.fetchReviewsRange;

const fetchReviewsLatest =
  reviewsMod.fetchReviewsLatest || reviewsMod.default?.fetchReviewsLatest;

const analyzeThemesWithOpenAI =
  openaiMod.analyzeThemesWithOpenAI || openaiMod.default?.analyzeThemesWithOpenAI;

function todayYMD() { return new Date().toISOString().slice(0, 10); }

function splitAppPks(app_pk) {
  return String(app_pk || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}
function normalizePkList(raw) {
  return String(raw || "")
    .split(",").map(s => s.trim()).filter(Boolean)
    .sort().join(",");
}

async function handleAnalyzeThemes({ app_pk, from, to, limit, job_id, day }) {
  const appPks = splitAppPks(app_pk);
  if (appPks.length === 0) throw new Error("No app_pk provided");

  let reviews = [];
  let selection = {};
  const curDay = day || todayYMD();
  const pkStable = normalizePkList(appPks.join(","));
  const job = job_id || "nojob";
  const nowISO = new Date().toISOString();

  // ---- Sélection des avis (inchangé)
  if (from || to) {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(new Date(end).setUTCDate(end.getUTCDate() - 90));
    const fromISO = start.toISOString();
    const toISO   = end.toISOString();
    const perApp  = 1200;
    const batches = await Promise.all(appPks.map(pk => fetchReviewsRange(pk, fromISO, toISO, perApp)));
    reviews = batches.flat().sort((a, b) => new Date(b.date||0) - new Date(a.date||0));
    selection = { from: fromISO, to: toISO };
  } else if (limit) {
    const n      = Math.max(1, Math.min(2000, Number(limit)));
    const perApp = Math.ceil(n / appPks.length);
    const batches = await Promise.all(appPks.map(pk => fetchReviewsLatest(pk, perApp)));
    reviews = batches.flat().sort((a, b) => new Date(b.date||0) - new Date(a.date||0)).slice(0, n);
    selection = { limit: n };
  } else {
    const end    = new Date();
    const start  = new Date(new Date().setUTCDate(end.getUTCDate() - 90));
    const fromISO = start.toISOString();
    const toISO   = end.toISOString();
    const perApp  = 1200;
    const batches = await Promise.all(appPks.map(pk => fetchReviewsRange(pk, fromISO, toISO, perApp)));
    reviews = batches.flat().sort((a, b) => new Date(b.date||0) - new Date(a.date||0));
    selection = { from: fromISO, to: toISO };
  }

  const skPending = `pending#${curDay}#${job}`;
  const skFinal   = `theme#${curDay}#${job}`;

  // ---- 1) Écrire l’item "pending" (idempotent sur sk)
  try {
    await ddbDoc.send(new PutCommand({
      TableName: THEMES_TABLE,
      Item: {
        app_pk: pkStable,
        sk: skPending,
        status: "pending",
        selection,
        created_at: nowISO,
        job_id: job,
      },
      ConditionExpression: "attribute_not_exists(app_pk) AND attribute_not_exists(sk)",
    }));
  } catch (e) {
    // S'il existe déjà, on continue; sinon log d'info
    if (e?.name !== "ConditionalCheckFailedException") {
      console.warn("[THEMES] pending put warn:", e?.message || e);
    }
  }

  try {
    // ---- 2) Analyse
    const result = await analyzeThemesWithOpenAI(
      { appPks, from: selection.from, to: selection.to, lang: "fr", posCutoff: 4, negCutoff: 3, topN: 3 },
      reviews
    );

    // ---- 3) Écrire le résultat final (idempotent)
    await ddbDoc.send(new PutCommand({
      TableName: THEMES_TABLE,
      Item: {
        app_pk: pkStable,
        sk: skFinal,
        selection,
        total_reviews_considered: reviews.length,
        result,
        created_at: nowISO,
        finished_at: new Date().toISOString(),
        job_id: job,
      },
      ConditionExpression: "attribute_not_exists(app_pk) AND attribute_not_exists(sk)",
    }));

    // ---- 4) Supprimer le pending (best-effort)
    try {
      await ddbDoc.send(new DeleteCommand({
        TableName: THEMES_TABLE,
        Key: { app_pk: pkStable, sk: skPending },
      }));
    } catch (_) {}

    console.log(`[THEMES] done for ${pkStable} day=${curDay} job=${job} apps=${appPks.length} reviews=${reviews.length}`);
  } catch (err) {
    // ---- 5) En cas d’échec, marquer le pending en failed (utile pour polling)
    try {
      await ddbDoc.send(new UpdateCommand({
        TableName: THEMES_TABLE,
        Key: { app_pk: pkStable, sk: skPending },
        UpdateExpression: "SET #s = :s, error = :e, finished_at = :t",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": "failed",
          ":e": String(err?.message || err),
          ":t": new Date().toISOString(),
        },
      }));
    } catch (_) {}
    throw err;
  }
}

exports.handler = async (event) => {
  console.log("[THEMES] batch size:", Array.isArray(event?.Records) ? event.Records.length : 0);
  if (event?.Records?.[0]) console.log("[THEMES] first body:", event.Records[0].body);

  for (const rec of event.Records || []) {
    let msg;
    try { msg = JSON.parse(rec.body || "{}"); }
    catch { console.error("[THEMES] invalid SQS body:", rec.body); continue; }

    if (!msg?.app_pk) { console.error("[THEMES] missing app_pk:", msg); continue; }

    try {
      await handleAnalyzeThemes(msg);
    } catch (e) {
      if (e?.name === "ConditionalCheckFailedException") {
        console.log(`[THEMES] skip (already exists) app_pk=${msg.app_pk}`);
        continue;
      }
      console.error("[THEMES] error:", e?.message || e);
    }
  }
};