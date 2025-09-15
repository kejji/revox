// backend/reviewsThemes.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { analyzeThemesWithOpenAI } from "./openaiThemes.js";

const REGION = process.env.AWS_REGION;
const REVIEWS_TABLE = process.env.APP_REVIEWS_TABLE;

if (!REGION) console.warn("[/reviews/themes] Missing AWS_REGION");
if (!REVIEWS_TABLE) console.warn("[/reviews/themes] Missing APP_REVIEWS_TABLE");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const toNum = (x) => (Number.isFinite(+x) ? +x : null);
const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : (s || ""));
const parseISO = (s, fallbackISO) => {
  const d = new Date(s);
  return isNaN(d.getTime()) ? fallbackISO : d.toISOString();
};
const makeSKBounds = (fromISO, toISO) => ({ lo: `${fromISO}#\u0000`, hi: `${toISO}#\uFFFF` });

/**
 * Query par plage de dates (utilisé pour from/to)
 */
async function fetchReviewsRange(appPk, fromISO, toISO, limit = 1500) {
  const { lo, hi } = makeSKBounds(fromISO, toISO);
  const cmd = new QueryCommand({
    TableName: REVIEWS_TABLE,
    KeyConditionExpression: "app_pk = :pk AND ts_review BETWEEN :lo AND :hi",
    ExpressionAttributeValues: { ":pk": appPk, ":lo": lo, ":hi": hi },
    ScanIndexForward: false, // plus récents d'abord
    Limit: limit,
  });
  const out = await ddb.send(cmd);
  return (out.Items || []).map((it) => ({
    app_pk: it.app_pk,
    date: it.date || (it.ts_review ? String(it.ts_review).split("#")[0] : null),
    rating: toNum(it.rating),
    text: truncate(it.text || "", 3000),
  }));
}

/**
 * Query des N derniers avis (sans borne temporelle)
 * -> nécessite que ts_review soit triable par date (ex: "YYYY-MM-DD...#...").
 */
async function fetchReviewsLatest(appPk, count) {
  const cmd = new QueryCommand({
    TableName: REVIEWS_TABLE,
    KeyConditionExpression: "app_pk = :pk",
    ExpressionAttributeValues: { ":pk": appPk },
    ScanIndexForward: false, // décroissant = plus récents d’abord
    Limit: count,
  });
  const out = await ddb.send(cmd);
  return (out.Items || []).map((it) => ({
    app_pk: it.app_pk,
    date: it.date || (it.ts_review ? String(it.ts_review).split("#")[0] : null),
    rating: toNum(it.rating),
    text: truncate(it.text || "", 3000),
  }));
}

export async function getReviewsThemes(req, res) {
  try {
    if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });
    if (!REVIEWS_TABLE) return res.status(500).json({ error: "Missing APP_REVIEWS_TABLE" });

    const rawAppPk = req.query.app_pk;
    if (!rawAppPk) return res.status(400).json({ ok: false, error: "app_pk is required (comma-separated)" });
    const appPks = String(rawAppPk).split(",").map((s) => s.trim()).filter(Boolean);

    const posCutoff = Math.max(0, Math.min(5, parseFloat(req.query.pos_cutoff || "4")));
    const negCutoff = Math.max(0, Math.min(5, parseFloat(req.query.neg_cutoff || "3")));
    const topN = Math.max(1, Math.min(5, parseInt(req.query.topn || "3", 10)));

    // Si 'count' est fourni => mode "N derniers avis"
    const count = req.query.count ? Math.max(1, parseInt(req.query.count, 10)) : null;

    let reviews = [];
    let fromForParams = null;
    let toForParams = null;

    if (count != null) {
      // Répartit le quota par app, merge et tronque à 'count'
      const perApp = Math.ceil(count / appPks.length);
      const batches = await Promise.all(appPks.map((pk) => fetchReviewsLatest(pk, perApp)));
      reviews = batches
        .flat()
        .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
        .slice(0, count);
      // from/to restent null en mode count
    } else {
      // Mode plage de dates (from/to) – défaut: derniers 30 jours
      const nowIso = new Date().toISOString();
      const fromIso = parseISO(req.query.from, new Date(Date.now() - 30 * 864e5).toISOString());
      const toIso = parseISO(req.query.to, nowIso);
      fromForParams = fromIso;
      toForParams = toIso;

      const perApp = 1200;
      const batches = await Promise.all(appPks.map((pk) => fetchReviewsRange(pk, fromIso, toIso, perApp)));
      reviews = batches
        .flat()
        .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    }

    // Filtrer les textes vides
    reviews = reviews.filter((r) => (r.text || "").trim().length > 0);

    const out = await analyzeThemesWithOpenAI(
      { appPks, from: fromForParams, to: toForParams, lang: "fr", posCutoff, negCutoff, topN },
      reviews
    );

    return res.json({
      ok: true,
      params: {
        app_pks: appPks,
        from: fromForParams,
        to: toForParams,
        count: count || null,
        total_reviews: reviews.length,
        pos_cutoff: posCutoff,
        neg_cutoff: negCutoff,
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      },
      top_negative_axes: out.top_negative_axes,
      top_positive_axes: out.top_positive_axes,
      axes: out.axes,
    });
  } catch (e) {
    console.error("getReviewsThemes (OpenAI) error:", e);
    return res.status(500).json({ ok: false, error: e?.message || "internal_error" });
  }
}