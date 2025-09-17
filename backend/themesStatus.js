// backend/themesStatus.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION;
const THEMES_TABLE = process.env.APPS_THEMES_TABLE;

const ddbDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

function todayYMD(){ return new Date().toISOString().slice(0,10); }
function normalizeAppPkList(app_pk_raw){
  const parts = String(app_pk_raw || "").split(",").map(s=>s.trim()).filter(Boolean);
  return Array.from(new Set(parts)).sort().join(",");
}

/**
 * GET /themes/status
 *  - Mode A (recommandé): ?job_id=...&app_pk=...
 *  - Mode B (legacy):     ?app_pk=...           (status du jour)
 *
 * Réponses:
 *  { ok, mode:"job"|"app", app_pk, date, status:"ready"|"pending"|"none", last_result_at? }
 */
export async function getThemesStatus(req, res) {
  try {
    if (!req.auth?.sub) return res.status(401).json({ ok:false, error: "unauthorized" });
    if (!THEMES_TABLE) return res.status(500).json({ ok:false, error: "missing_APPS_THEMES_TABLE" });

    const rawPk = req.query.app_pk && String(req.query.app_pk);
    const job_id = req.query.job_id && String(req.query.job_id);
    const today = todayYMD();

    if (job_id) {
      if (!rawPk) return res.status(400).json({ ok:false, error: "app_pk is required with job_id" });
      const app_pk = normalizeAppPkList(rawPk);

      // ready ?
      const theme = await ddbDoc.send(new GetCommand({
        TableName: THEMES_TABLE,
        Key: { app_pk, sk: `theme#${today}#${job_id}` },
        ProjectionExpression: "app_pk"
      }));
      if (theme?.Item) {
        return res.json({ ok:true, mode:"job", app_pk, date: today, status: "ready" });
      }

      // pending ?
      const pend = await ddbDoc.send(new GetCommand({
        TableName: THEMES_TABLE,
        Key: { app_pk, sk: `pending#${today}#${job_id}` },
        ProjectionExpression: "app_pk"
      }));
      if (pend?.Item) {
        // renvoie dernière dispo
        const last = await ddbDoc.send(new QueryCommand({
          TableName: THEMES_TABLE,
          KeyConditionExpression: "app_pk = :pk AND begins_with(sk, :p)",
          ExpressionAttributeValues: { ":pk": app_pk, ":p": "theme#" },
          ScanIndexForward: false,
          Limit: 1
        }));
        const lastSk = last?.Items?.[0]?.sk || null; // ex theme#YYYY-MM-DD#job
        const lastDate = lastSk ? lastSk.split("#")[1] : null;
        return res.json({ ok:true, mode:"job", app_pk, date: today, status: "pending", last_result_at: lastDate });
      }

      return res.json({ ok:true, mode:"job", app_pk, date: today, status: "none" });
    }

    // ---- Mode "par app_pk" (du jour, sans job_id)
    if (!rawPk) return res.status(400).json({ ok:false, error: "app_pk is required" });
    const app_pk = normalizeAppPkList(rawPk);

    // ready today (compat nojob)
    const gotToday = await ddbDoc.send(new GetCommand({
      TableName: THEMES_TABLE,
      Key: { app_pk, sk: `theme#${today}#nojob` },
      ProjectionExpression: "app_pk"
    }));
    if (gotToday?.Item) {
      return res.json({ ok:true, mode:"app", app_pk, date: today, status: "ready" });
    }

    // pending today (compat nojob)
    const pend = await ddbDoc.send(new GetCommand({
      TableName: THEMES_TABLE,
      Key: { app_pk, sk: `pending#${today}#nojob` },
      ProjectionExpression: "app_pk"
    }));
    if (pend?.Item) {
      const last = await ddbDoc.send(new QueryCommand({
        TableName: THEMES_TABLE,
        KeyConditionExpression: "app_pk = :pk AND begins_with(sk, :p)",
        ExpressionAttributeValues: { ":pk": app_pk, ":p": "theme#" },
        ScanIndexForward: false,
        Limit: 1
      }));
      const lastSk = last?.Items?.[0]?.sk || null;
      const lastDate = lastSk ? lastSk.split("#")[1] : null;
      return res.json({ ok:true, mode:"app", app_pk, date: today, status: "pending", last_result_at: lastDate });
    }

    // none + last available
    const last = await ddbDoc.send(new QueryCommand({
      TableName: THEMES_TABLE,
      KeyConditionExpression: "app_pk = :pk AND begins_with(sk, :p)",
      ExpressionAttributeValues: { ":pk": app_pk, ":p": "theme#" },
      ScanIndexForward: false,
      Limit: 1
    }));
    const lastSk = last?.Items?.[0]?.sk || null;
    const lastDate = lastSk ? lastSk.split("#")[1] : null;

    return res.json({ ok:true, mode:"app", app_pk, date: today, status: "none", last_result_at: lastDate });
  } catch (e) {
    console.error("[/themes/status] error:", e?.message || e);
    return res.status(500).json({ ok:false, error: "internal_error" });
  }
}