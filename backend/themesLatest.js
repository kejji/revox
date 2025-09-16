// backend/themesLatest.js
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const ddbDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);
const TABLE = process.env.APPS_THEMES_TABLE;

// Normalise "app_pk" (support multi-apps) pour matcher la PK utilisée au stockage
function normalizePk(app_pk_raw) {
  const parts = String(app_pk_raw || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const uniq = Array.from(new Set(parts));
  uniq.sort(); // même ordre stable que côté worker
  return uniq.join(",");
}

// Fallback si top_… absents : extrait un top N depuis result.axes
function pickTopFromAxes(axes = [], kind = "positive", n = 3) {
  const key = kind === "positive" ? "positive" : "negative";
  const sign = kind === "positive" ? -1 : 1; // tie-break par avg_rating
  return axes
    .map(a => ({
      axis_id: a.axis_id,
      axis_label: a.axis_label,
      count: a?.[key]?.count ?? 0,
      avg_rating: a?.[key]?.avg_rating ?? 0,
      examples: a?.[key]?.examples ?? []
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      // en cas d’égalité: privilégier notes + hautes en positif, + basses en négatif
      return sign * (a.avg_rating - b.avg_rating);
    })
    .slice(0, n);
}

// GET /themes/latest?app_pk=ios#...,android#...
export async function getLatestThemes(req, res) {
  if (!req.auth?.sub) return res.status(401).json({ error: "Unauthorized" });

  const raw = req.query.app_pk;
  if (!raw) return res.status(400).json({ error: "app_pk requis" });

  const pk = normalizePk(raw);

  try {
    // Dernier item (sk tri descendant) : couvre aussi le cas "force" (sk avec suffixe)
    const out = await ddbDoc.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "app_pk = :pk",
      ExpressionAttributeValues: { ":pk": pk },
      ScanIndexForward: false, // sk décroissant
      Limit: 1
    }));

    const item = out.Items?.[0];
    if (!item) return res.status(404).json({ ok: false, error: "not_found" });

    const { result = {}, selection, total_reviews_considered, created_at } = item;

    // Utilise ce que le worker a déjà calculé, sinon fallback depuis axes
    const topPos = Array.isArray(result.top_positive_axes) && result.top_positive_axes.length
      ? result.top_positive_axes.slice(0, 3)
      : pickTopFromAxes(result.axes, "positive", 3);

    const topNeg = Array.isArray(result.top_negative_axes) && result.top_negative_axes.length
      ? result.top_negative_axes.slice(0, 3)
      : pickTopFromAxes(result.axes, "negative", 3);

    return res.json({
      ok: true,
      app_pk: pk,
      sk: item.sk,
      selection,
      total_reviews_considered,
      created_at,
      top_positive_axes: topPos,
      top_negative_axes: topNeg,
      // si le front veut tout le détail, on peut aussi exposer `axes` :
      // axes: result.axes
    });
  } catch (e) {
    console.error("[GET /themes/latest] error:", e?.message || e);
    return res.status(500).json({ error: "read_failed" });
  }
}
