// backend/themesWorker.js
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");

const REGION        = process.env.AWS_REGION;
const THEMES_TABLE  = process.env.APPS_THEMES_TABLE;

const ddbDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const { fetchReviewsRange, fetchReviewsLatest } = require("./reviewsThemes");
const { analyzeThemesWithOpenAI } = require("./openaiThemes");

function todayYMD() { return new Date().toISOString().slice(0,10); }

async function handleAnalyzeThemes({ app_pk, from, to, limit }) {
  let reviews;
  let selection = {};

  if (from || to) {
    // Mode période
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(new Date(end).setUTCDate(end.getUTCDate() - 90));
    const fromISO = start.toISOString();
    const toISO   = end.toISOString();
    reviews   = await fetchReviewsRange(app_pk, fromISO, toISO, 2000);
    selection = { from: fromISO, to: toISO };
  } else if (limit) {
    // Mode derniers N avis
    const n = Math.max(1, Math.min(2000, Number(limit)));
    reviews   = await fetchReviewsLatest(app_pk, n);
    selection = { limit: n };
  } else {
    // Défaut: 90 jours
    const end   = new Date();
    const start = new Date(new Date().setUTCDate(end.getUTCDate() - 90));
    const fromISO = start.toISOString();
    const toISO   = end.toISOString();
    reviews   = await fetchReviewsRange(app_pk, fromISO, toISO, 2000);
    selection = { from: fromISO, to: toISO };
  }

  const result = await analyzeThemesWithOpenAI(
    {
      appPks: [app_pk],
      from: selection.from,
      to: selection.to,
      lang: "fr",
      posCutoff: 4,
      negCutoff: 3,
      topN: 3,
    },
    reviews
  );

  await ddbDoc.send(new PutCommand({
    TableName: THEMES_TABLE,
    Item: {
      app_pk,
      sk: `theme#${todayYMD()}`,
      selection,
      total_reviews_considered: reviews.length,
      result,
      created_at: new Date().toISOString(),
    },
    ConditionExpression: "attribute_not_exists(app_pk) AND attribute_not_exists(sk)",
  }));

  console.log(`[THEMES] done for ${app_pk} reviews=${reviews.length}`);
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