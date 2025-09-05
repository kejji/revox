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
function parseAppsFromQuery(qs) {
  const v = qs.app_pk;
  if (!v) return [];
  const arr = String(v).split(",").map(x => x.trim()).filter(Boolean);
  return Array.from(new Set(arr));
}

export async function exportReviewsCsv(req, res) {
  try {
    const qs = req.query || {};
    const appPks = parseAppsFromQuery(qs);
    if (!appPks.length) {
      return res.status(400).json({ error: "Paramètre requis: app_pk (valeur unique ou liste séparée par des virgules)" });
    }

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="reviews.csv"`);

    // En-tête CSV (adapte si besoin)
    res.write([
      "app_pk","platform","bundle_id","date","ts_review","rating","user_name","app_version","source","text"
    ].join(",") + "\n");

    const pickKey = (r) => r?.date || r?.ts_review || "";
    const perAppKeys = Object.fromEntries(appPks.map(pk => [pk, undefined])); // ESK par app
    const buffers = Object.fromEntries(appPks.map(pk => [pk, []]));
    const heads = Object.fromEntries(appPks.map(pk => [pk, 0]));

    const refill = async (pk, limit=200) => {
      const out = await ddb.send(new QueryCommand({
        TableName: REVIEWS_TABLE,
        KeyConditionExpression: "app_pk = :apk",
        ExpressionAttributeValues: { ":apk": pk },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: perAppKeys[pk]
      }));
      buffers[pk] = out.Items || [];
      heads[pk] = 0;
      perAppKeys[pk] = out.LastEvaluatedKey;
    };

    // prime buffers
    await Promise.all(appPks.map(pk => refill(pk)));

    while (true) {
      let best = null, bestPk = null;
      for (const pk of appPks) {
        const buf = buffers[pk];
        const i = heads[pk];
        if (i >= buf.length) continue;
        const cand = buf[i];
        if (!best || String(pickKey(cand)) > String(pickKey(best))) {
          best = cand; bestPk = pk;
        }
      }

      if (!best) {
        let refilled = false;
        for (const pk of appPks) {
          if (heads[pk] >= buffers[pk].length && perAppKeys[pk]) {
            await refill(pk);
            if (buffers[pk].length) refilled = true;
          }
        }
        if (!refilled) break;
        continue;
      }

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