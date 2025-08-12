import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

function encodeCursor(key) {
  return key ? Buffer.from(JSON.stringify(key)).toString("base64") : undefined;
}
function decodeCursor(cursor) {
  return cursor ? JSON.parse(Buffer.from(cursor, "base64").toString("utf-8")) : undefined;
}

export async function listReviews(req, res) {
  try {
    const { platform, bundleId, limit = "20", order = "desc", from, to, cursor } = req.query;
    if (!platform || !bundleId) {
      return res.status(400).json({ error: "platform et bundleId sont requis" });
    }

    const app_pk = `${String(platform).toLowerCase()}#${bundleId}`;
    const Limit = Math.max(1, Math.min(parseInt(limit, 10) || 20, 100));
    const ScanIndexForward = order !== "desc"; // 'desc' => false

    const hasRange = !!(from && to);
    const KeyConditionExpression = hasRange
      ? "app_pk = :pk AND ts_review BETWEEN :from AND :to"
      : "app_pk = :pk";

    const ExpressionAttributeValues = hasRange
      ? { ":pk": app_pk, ":from": `${from}#`, ":to": `${to}#z` }
      : { ":pk": app_pk };

    const ExclusiveStartKey = decodeCursor(cursor);

    const out = await ddb.send(new QueryCommand({
      TableName: process.env.APP_REVIEWS_TABLE,
      KeyConditionExpression,
      ExpressionAttributeValues,
      ScanIndexForward,
      Limit,
      ExclusiveStartKey
    }));

    res.json({
      items: out.Items ?? [],
      nextCursor: encodeCursor(out.LastEvaluatedKey),
      count: (out.Items ?? []).length
    });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erreur serveur" });
  }
}
