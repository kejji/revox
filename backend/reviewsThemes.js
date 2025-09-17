// backend/reviewsThemes.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION;
const REVIEWS_TABLE = process.env.APP_REVIEWS_TABLE;

if (!REGION) console.warn("[reviewsThemes] Missing AWS_REGION");
if (!REVIEWS_TABLE) console.warn("[reviewsThemes] Missing APP_REVIEWS_TABLE");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

const toNum = (x) => (Number.isFinite(+x) ? +x : null);
const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : (s || ""));
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
    ScanIndexForward: false,
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
 */
async function fetchReviewsLatest(appPk, count) {
  const cmd = new QueryCommand({
    TableName: REVIEWS_TABLE,
    KeyConditionExpression: "app_pk = :pk",
    ExpressionAttributeValues: { ":pk": appPk },
    ScanIndexForward: false,
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

export default { fetchReviewsRange, fetchReviewsLatest };
export { fetchReviewsRange, fetchReviewsLatest };