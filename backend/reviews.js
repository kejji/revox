import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const REVIEWS_TABLE = process.env.APP_REVIEWS_TABLE;

function b64(obj) { return Buffer.from(JSON.stringify(obj)).toString("base64"); }
function unb64(s) { return s ? JSON.parse(Buffer.from(s, "base64").toString("utf-8")) : undefined; }

function parseAppsFromQuery(qs) {
  const v = qs.app_pk;
  if (!v) return [];
  const arr = String(v).split(",").map(x => x.trim()).filter(Boolean);
  return Array.from(new Set(arr));
}

export async function listReviews(req, res) {
  try {
    const qs = req.query || {};
    const limit = Math.min(parseInt(qs.limit || "50", 10), 200);
    const appPks = parseAppsFromQuery(qs);
    if (!appPks.length) {
      return res.status(400).json({ error: "Paramètre requis: app_pk (valeur unique ou liste séparée par des virgules)" });
    }

    const cursor = unb64(qs.cursor);
    const perAppFromCursor = (cursor && cursor.perApp) || {};

    // 1) Précharger jusqu'à `limit` éléments par app (DESC)
    const buffers = {};
    await Promise.all(appPks.map(async (app_pk) => {
      const ExclusiveStartKey = perAppFromCursor[app_pk]?.ExclusiveStartKey;
      const out = await ddb.send(new QueryCommand({
        TableName: REVIEWS_TABLE,
        KeyConditionExpression: "app_pk = :apk",
        ExpressionAttributeValues: { ":apk": app_pk },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey
      }));
      buffers[app_pk] = out.Items || [];
    }));

    // 2) k-way merge par `date` (ISO) sinon `ts_review`
    const pickKey = (r) => r?.date || r?.ts_review || "";
    const heads = Object.fromEntries(appPks.map(pk => [pk, 0]));
    const merged = [];
    const nextPerApp = {}; // { [pk]: { ExclusiveStartKey } }

    while (merged.length < limit) {
      let best = null, bestPk = null;
      for (const pk of appPks) {
        const i = heads[pk];
        const arr = buffers[pk];
        if (!arr || i >= arr.length) continue;
        const cand = arr[i];
        if (!best || String(pickKey(cand)) > String(pickKey(best))) {
          best = cand; bestPk = pk;
        }
      }
      if (!best) break;

      merged.push(best);
      heads[bestPk]++;

      // prépare l'ESK pour la prochaine page de CETTE app
      nextPerApp[bestPk] = {
        ExclusiveStartKey: {
          app_pk: best.app_pk || bestPk,
          ts_review: best.ts_review
        }
      };
    }

    const nextCursor = Object.keys(nextPerApp).length ? b64({ perApp: nextPerApp }) : undefined;

    return res.json({
      items: merged,
      nextCursor,
      count: merged.length
    });
  } catch (e) {
    console.error("listReviews error:", e);
    return res.status(500).json({ error: e.message || "Erreur serveur" });
  }
}