// backend/themesResult.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION;
const THEMES_TABLE = process.env.APPS_THEMES_TABLE;

const ddbDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

function setNoCacheHeaders(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  // utile pour le front web JS : expose ces headers
  res.setHeader("Access-Control-Expose-Headers", "Cache-Control, Pragma, Expires");
}

const todayYMD = () => new Date().toISOString().slice(0, 10);
function normalizeAppPkList(app_pk_raw) {
  const parts = String(app_pk_raw || "").split(",").map(s => s.trim()).filter(Boolean);
  return Array.from(new Set(parts)).sort().join(",");
}
function parseDayFromSk(sk) {
  const m = /^(?:theme|pending)#(\d{4}-\d{2}-\d{2})#/.exec(String(sk || ""));
  return m?.[1] || null;
}
function parseJobFromSk(sk) {
  const m = /^(?:theme|pending)#\d{4}-\d{2}-\d{2}#(.+)$/.exec(String(sk || ""));
  return m?.[1] || null;
}

async function getFinal(ddbDoc, app_pk, day, job_id) {
  const resp = await ddbDoc.send(new GetCommand({
    TableName: THEMES_TABLE,
    Key: { app_pk, sk: `theme#${day}#${job_id}` },
  }));
  return resp?.Item || null;
}

async function getPending(ddbDoc, app_pk, day, job_id) {
  const resp = await ddbDoc.send(new GetCommand({
    TableName: THEMES_TABLE,
    Key: { app_pk, sk: `pending#${day}#${job_id}` },
  }));
  return resp?.Item || null;
}

async function getLatestWithPrefix(ddbDoc, app_pk, prefix) {
  const out = await ddbDoc.send(new QueryCommand({
    TableName: THEMES_TABLE,
    KeyConditionExpression: "app_pk = :pk AND begins_with(sk, :pref)",
    ExpressionAttributeValues: { ":pk": app_pk, ":pref": prefix },
    ScanIndexForward: false, // plus récent d'abord
    Limit: 1
  }));
  return out?.Items?.[0] || null;
}

/**
 * GET /themes/result
 * Modes:
 *  A) ?app_pk=...&job_id=...&day=YYYY-MM-DD → renvoie l'état du job (pending/failed/done) + result quand done
 *  B) ?app_pk=...                           → renvoie le dernier (pending prioritaire s'il est aussi récent)
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

    // ----- Mode A: état d’un job précis
    if (job_id) {
      // 1) Tente le résultat final
      const final = await getFinal(ddbDoc, app_pk, day, job_id);
      if (final) {
        setNoCacheHeaders(res);
        return res.json({
          ok: true,
          mode: "job",
          app_pk,
          day: parseDayFromSk(final.sk) || day,
          job_id: final.job_id || parseJobFromSk(final.sk) || job_id,
          status: "done",
          created_at: final.created_at,
          finished_at: final.finished_at || null,
          selection: final.selection,
          total_reviews_considered: final.total_reviews_considered ?? 0,
          top_positive_axes: final.result?.top_positive_axes || [],
          top_negative_axes: final.result?.top_negative_axes || []
        });
      }

      // 2) Sinon, regarde le pending (le worker écrit pending dès le démarrage)
      const pending = await getPending(ddbDoc, app_pk, day, job_id);
      if (pending) {
        setNoCacheHeaders(res);
        return res.json({
          ok: true,
          mode: "job",
          app_pk,
          day: parseDayFromSk(pending.sk) || day,
          job_id: pending.job_id || parseJobFromSk(pending.sk) || job_id,
          status: pending.status || "pending", // pending | failed
          created_at: pending.created_at,
          finished_at: pending.finished_at || null,
          selection: pending.selection || null,
          total_reviews_considered: 0,
          top_positive_axes: [],
          top_negative_axes: [],
          error: pending.error || null
        });
      }

      // 3) Rien trouvé (pas encore écrit, ou clé day erronée)
      setNoCacheHeaders(res);
      return res.status(404).json({ ok: false, error: "not_found", app_pk, day, job_id });
    }

    // ----- Mode B: dernier état disponible
    // On regarde le dernier "theme#" ET le dernier "pending#", puis on choisit.
    const [latestFinal, latestPending] = await Promise.all([
      getLatestWithPrefix(ddbDoc, app_pk, "theme#"),
      getLatestWithPrefix(ddbDoc, app_pk, "pending#"),
    ]);

    if (!latestFinal && !latestPending) {
      setNoCacheHeaders(res);
      return res.json({
        ok: true, mode: "latest", app_pk, empty: true,
        status: null, job_id: null, day: null,
        top_positive_axes: [], top_negative_axes: []
      });
    }

    // Compare par day (YYYY-MM-DD), le plus récent gagne; en cas d'égalité on préfère pending (car en cours)
    const dayF = latestFinal ? parseDayFromSk(latestFinal.sk) : null;
    const dayP = latestPending ? parseDayFromSk(latestPending.sk) : null;

    const pickPending =
      (!!latestPending && (!latestFinal || (dayP && (!dayF || dayP >= dayF))));

    if (pickPending) {
      setNoCacheHeaders(res);
      return res.json({
        ok: true,
        mode: "latest",
        app_pk,
        day: dayP,
        job_id: latestPending.job_id || parseJobFromSk(latestPending.sk),
        status: latestPending.status || "pending", // pending | failed
        created_at: latestPending.created_at,
        finished_at: latestPending.finished_at || null,
        selection: latestPending.selection || null,
        total_reviews_considered: 0,
        top_positive_axes: [],
        top_negative_axes: [],
        error: latestPending.error || null
      });
    }

    // Sinon, on renvoie le dernier résultat final
    setNoCacheHeaders(res);
    return res.json({
      ok: true,
      mode: "latest",
      app_pk,
      day: dayF,
      job_id: latestFinal.job_id || parseJobFromSk(latestFinal.sk),
      status: "done",
      created_at: latestFinal.created_at,
      finished_at: latestFinal.finished_at || null,
      selection: latestFinal.selection,
      total_reviews_considered: latestFinal.total_reviews_considered ?? 0,
      top_positive_axes: latestFinal.result?.top_positive_axes || [],
      top_negative_axes: latestFinal.result?.top_negative_axes || []
    });
  } catch (e) {
    console.error("[/themes/result] error:", e?.message || e);
    setNoCacheHeaders(res);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
}