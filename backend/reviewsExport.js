import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const REVIEWS_TABLE = process.env.REVIEWS_TABLE || process.env.REVOX_REVIEWS_TABLE || "revox_app_reviews";

function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  const mustQuote = /[",\n\r]/.test(s);
  const esc = s.replace(/"/g, '""');
  return mustQuote ? `"${esc}"` : esc;
}

// Tolère '|' au lieu de '#', id iOS nu, bundle Android nu, et liste séparée par virgules
function normalizeAppKey(s) {
  const v = String(s || "").trim().replace("|", "#");
  if (!v) return null;
  if (v.includes("#")) return v;
  if (/^\d+$/.test(v) || v.startsWith("id")) return v.startsWith("id") ? `ios#${v.slice(2)}` : `ios#${v}`;
  return `android#${v}`;
}
function parseAppsFromQuery(qs) {
  const raw = qs.app_pk;
  if (!raw) return [];
  const arr = String(raw).split(",").map(normalizeAppKey).filter(Boolean);
  return Array.from(new Set(arr));
}

// Construit KeyCondition/Values selon from/to
function buildQueryInput({ tableName, app_pk, from, to, order = "desc", limit = 200, ExclusiveStartKey }) {
  // ts_review est de la forme "YYYY-MM-DDTHH:mm:ss.sssZ#..." → on bornes avec "#", "#z"
  const hasFrom = !!from;
  const hasTo = !!to;

  let KeyConditionExpression = "app_pk = :apk";
  const ExpressionAttributeValues = { ":apk": app_pk };

  if (hasFrom && hasTo) {
    KeyConditionExpression = "app_pk = :apk AND ts_review BETWEEN :from AND :to";
    ExpressionAttributeValues[":from"] = `${from}#`;
    ExpressionAttributeValues[":to"]   = `${to}#z`;
  } else if (hasFrom) {
    KeyConditionExpression = "app_pk = :apk AND ts_review >= :from";
    ExpressionAttributeValues[":from"] = `${from}#`;
  } else if (hasTo) {
    KeyConditionExpression = "app_pk = :apk AND ts_review <= :to";
    ExpressionAttributeValues[":to"] = `${to}#z`;
  }

  return {
    TableName: tableName,
    KeyConditionExpression,
    ExpressionAttributeValues,
    ScanIndexForward: String(order || "desc").toLowerCase() !== "desc", // desc => false
    Limit: limit,
    ExclusiveStartKey
  };
}

export async function exportReviewsCsv(req, res) {
  try {
    const qs = req.query || {};
    const appPks = parseAppsFromQuery(qs);
    if (!appPks.length) {
      return res.status(400).json({ error: "Paramètre requis: app_pk (valeur unique ou liste séparée par des virgules)" });
    }

    // bornes & options
    const from = qs.from; // ex "2025-07-01T00:00:00.000Z"
    const to   = qs.to;   // ex "2025-09-05T23:59:59.999Z"
    const order = String(qs.order || "desc").toLowerCase();
    const pageSize = Math.max(1, Math.min(parseInt(qs.pageSize || "200", 10), 1000)); // taille par Query

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="reviews.csv"`);

    // En-tête CSV
    res.write([
      "app_pk","platform","bundle_id","date","ts_review","rating","user_name","app_version","source","text"
    ].join(",") + "\n");

    // Par app : ESK, buffer, head
    const perAppKeys = Object.fromEntries(appPks.map(pk => [pk, undefined]));
    const buffers    = Object.fromEntries(appPks.map(pk => [pk, []]));
    const heads      = Object.fromEntries(appPks.map(pk => [pk, 0]));

    const refill = async (pk) => {
      const out = await ddb.send(new QueryCommand(buildQueryInput({
        tableName: REVIEWS_TABLE,
        app_pk: pk,
        from, to, order,
        limit: pageSize,
        ExclusiveStartKey: perAppKeys[pk]
      })));
      buffers[pk] = out.Items || [];
      heads[pk] = 0;
      perAppKeys[pk] = out.LastEvaluatedKey;
    };

    // prime buffers
    await Promise.all(appPks.map(pk => refill(pk)));

    // merge en flux: on choisit à chaque fois l'item le plus récent (ou plus ancien selon 'order')
    const pickKey = (r) => r?.date || r?.ts_review || "";

    while (true) {
      let best = null, bestPk = null;
      for (const pk of appPks) {
        const buf = buffers[pk];
        const i = heads[pk];
        if (i >= buf.length) continue;
        const cand = buf[i];
        if (!best) { best = cand; bestPk = pk; continue; }
        const cmp = String(pickKey(cand)).localeCompare(String(pickKey(best)));
        // order=desc -> on veut la clé max; order=asc -> la clé min
        const take = order === "desc" ? (cmp > 0) : (cmp < 0);
        if (take) { best = cand; bestPk = pk; }
      }

      if (!best) {
        // Recharger si certaines apps ont encore des pages
        let refilled = false;
        for (const pk of appPks) {
          if (heads[pk] >= buffers[pk].length && perAppKeys[pk]) {
            await refill(pk);
            if (buffers[pk].length) refilled = true;
          }
        }
        if (!refilled) break; // terminé
        continue;
      }

      // Écrire la ligne CSV
      const platform = best.platform || String(best.app_pk || bestPk).split("#", 2)[0];
      const bundleId = best.bundle_id || String(best.app_pk || bestPk).split("#", 2)[1];

      res.write([
        csvEscape(best.app_pk || bestPk),
        csvEscape(platform),
        csvEscape(bundleId),
        csvEscape(best.date || ""),
        csvEscape(best.ts_review || ""),
        csvEscape(best.rating ?? ""),
        csvEscape(best.user_name || ""),
        csvEscape(best.app_version || ""),
        csvEscape(best.source || ""),
        csvEscape(best.text || "")
      ].join(",") + "\n");

      // avancer
      heads[bestPk]++;
      if (heads[bestPk] >= buffers[bestPk].length && perAppKeys[bestPk]) {
        await refill(bestPk);
      }
    }

    res.end();
  } catch (e) {
    console.error("exportReviewsCsv error:", e);
    if (!res.headersSent) res.status(500).json({ error: e.message || "Erreur serveur" });
    else res.end(`\n# ERROR: ${e.message || "Erreur serveur"}`);
  }
}