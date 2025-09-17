// backend/themesResult.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION;
const THEMES_TABLE = process.env.APPS_THEMES_TABLE;

const ddbDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

function todayYMD() { return new Date().toISOString().slice(0, 10); }
function normalizeAppPkList(app_pk_raw) {
  const parts = String(app_pk_raw || "").split(",").map(s => s.trim()).filter(Boolean);
  return Array.from(new Set(parts)).sort().join(",");
}

/**
 * GET /themes/result
 * Modes:
 *  A) ?app_pk=...&job_id=...&day=YYYY-MM-DD?  → résultat EXACT du job
 *  B) ?app_pk=...                              → dernier "theme#..." (remplace /themes/latest)
 */
export async function getThemesResult(req, res) {
  try {
    if (!req.auth?.sub) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (!THEMES_TABLE) return res.status(500).json({ ok: false, error: "missing_APPS_THEMES_TABLE" });

    const rawPk = req.query.app_pk;
    if (!rawPk) return res.status(400).json({ ok: false, error: "app_pk is required" });
    const app_pk = normalizeAppPkList(rawPk);

    const job_id = req.query.job_id && String(req.query.job_id).trim();
    const day = (req.query.day && String(req.query.day).trim()) || todayYMD();

    // ----- Mode A: résultat d’un job précis
    if (job_id) {
      const resp = await ddbDoc.send(new GetCommand({
        TableName: THEMES_TABLE,
        Key: { app_pk, sk: `theme#${day}#${job_id}` },
      }));
      const item = resp?.Item;
      if (!item) {
        return res.status(404).json({ ok: false, error: "not_found", app_pk, day, job_id });
      }
      const { result, selection, total_reviews_considered, created_at, sk } = item;
      return res.json({
        ok: true, mode: "job",
        app_pk, day, job_id, sk, created_at, selection, total_reviews_considered,
        top_positive_axes: result?.top_positive_axes || [],
        top_negative_axes: result?.top_negative_axes || []
      });
    }

    // ----- Mode B: dernier disponible (remplace /themes/latest)
    const out = await ddbDoc.send(new QueryCommand({
      TableName: THEMES_TABLE,
      KeyConditionExpression: "app_pk = :pk AND begins_with(sk, :pref)",
      ExpressionAttributeValues: { ":pk": app_pk, ":pref": "theme#" },
      ScanIndexForward: false, // plus récent d'abord
      Limit: 1
    }));
    const item = out?.Items?.[0];
    if (!item) {
      return res.json({ ok: true, mode: "latest", app_pk, empty: true, top_positive_axes: [], top_negative_axes: [] });
    }
    const { result, selection, total_reviews_considered, created_at, sk } = item;
    return res.json({
      ok: true, mode: "latest",
      app_pk, sk, created_at, selection, total_reviews_considered,
      top_positive_axes: result?.top_positive_axes || [],
      top_negative_axes: result?.top_negative_axes || []
    });
  } catch (e) {
    console.error("[/themes/result] error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
}
