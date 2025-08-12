// backend/reviewsExport.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

// Petit helper CSV (échappement basique: " → "" et mettre entre guillemets si nécessaire)
function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  const mustQuote = /[",\n\r]/.test(str);
  const escaped = str.replace(/"/g, '""');
  return mustQuote ? `"${escaped}"` : escaped;
}

function writeHeader(res, fileBaseName = "reviews_export") {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${fileBaseName}_${ts}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // BOM UTF-8 pour Excel
  res.write("\uFEFF");
  // Entêtes
  res.write([
    "app_name","platform","date","rating","text","user_name",
    "app_version","bundle_id"
  ].join(",") + "\n");
}

export async function exportReviewsCsv(req, res) {
  try {
    const { platform, bundleId, from, to, order = "desc", pageSize = "200" } = req.query;
    if (!platform || !bundleId) {
      return res.status(400).json({ error: "platform et bundleId sont requis" });
    }
    if (!!from !== !!to) {
      return res.status(400).json({ error: "from et to doivent être fournis ensemble (ISO 8601)" });
    }

    // Sécurité/limites : taille de page max et garde-fou sur le nombre de pages pour ne pas dépasser le timeout
    const Limit = Math.max(1, Math.min(parseInt(pageSize, 10) || 200, 500));
    const MAX_PAGES = 2000; // ~2000*200 = 400k lignes max, ajuste selon ton timeout

    const app_pk = `${String(platform).toLowerCase()}#${bundleId}`;
    const ScanIndexForward = order !== "desc"; // desc => false

    const hasRange = !!(from && to);
    const KeyConditionExpression = hasRange
      ? "app_pk = :pk AND ts_review BETWEEN :from AND :to"
      : "app_pk = :pk";

    const ExpressionAttributeValues = hasRange
      ? { ":pk": app_pk, ":from": `${from}#`, ":to": `${to}#z` }
      : { ":pk": app_pk };

    writeHeader(res, `${platform}_${bundleId}`);

    let ExclusiveStartKey = undefined;
    let pages = 0;
    do {
      const out = await ddb.send(new QueryCommand({
        TableName: process.env.APP_REVIEWS_TABLE,
        KeyConditionExpression,
        ExpressionAttributeValues,
        ScanIndexForward,
        Limit,
        ExclusiveStartKey
      }));

      const items = out.Items ?? [];
      for (const it of items) {
        // Écrire une ligne CSV
        res.write([
          csvEscape(it.app_name),
          csvEscape(it.platform),
          csvEscape(it.date),
          csvEscape(it.rating),
          csvEscape(it.text),
          csvEscape(it.user_name),
          csvEscape(it.app_version),
          csvEscape(it.bundle_id)
        ].join(",") + "\n");
      }

      ExclusiveStartKey = out.LastEvaluatedKey;
      pages += 1;

      // Garde-fou
      if (pages >= MAX_PAGES && ExclusiveStartKey) {
        // On indique au client qu'il reste des données (taille trop grande pour un export synchrone)
        res.write(`# TRUNCATED after ${pages} pages - please use async export\n`);
        break;
      }
    } while (ExclusiveStartKey);

    res.end();
  } catch (e) {
    console.error("Export CSV error:", e);
    // Si on a déjà écrit des headers, on ne peut plus changer le code HTTP — on termine proprement.
    if (!res.headersSent) {
      res.status(500).json({ error: e.message || "Erreur serveur" });
    } else {
      res.end(`\n# ERROR: ${e.message || "Erreur serveur"}`);
    }
  }
}
