// backend/revoxRead.js
// Revox Read : synthétise l'ensemble des avis d'une app en UN commentaire type,
// via OpenAI. Résultat stocké sur la ligne apps_metadata de l'app
// (champs revox_read + revox_read_at).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";

import { callOpenAIJson } from "./openaiClient.js";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const REVIEWS_TABLE = process.env.APP_REVIEWS_TABLE;
const METADATA_TABLE = process.env.APPS_METADATA_TABLE;

const DEFAULT_SAMPLE = 500; // avis les plus récents envoyés au modèle
const MAX_SAMPLE = 1000;

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

// Normalise la sortie du modèle : commentaire trim + note entière bornée 1..5.
export function sanitizeRevoxRead(ai, reviewsCount, model) {
  const rating = Number(ai?.rating);
  return {
    comment: String(ai?.comment || "").trim(),
    rating: Number.isFinite(rating)
      ? Math.min(5, Math.max(1, Math.round(rating)))
      : null,
    reviews_count: reviewsCount,
    model: model || null,
  };
}

async function fetchRecentReviews(appPk, limit) {
  const out = await ddb.send(
    new QueryCommand({
      TableName: REVIEWS_TABLE,
      KeyConditionExpression: "app_pk = :apk",
      ExpressionAttributeValues: { ":apk": appPk },
      ProjectionExpression: "rating, #t",
      ExpressionAttributeNames: { "#t": "text" },
      ScanIndexForward: false,
      Limit: limit,
    })
  );
  return out.Items || [];
}

function buildMessages(reviews) {
  const lines = reviews
    .map((r) =>
      JSON.stringify({
        rating: Number(r.rating) || null,
        text: truncate(String(r.text || "").replace(/\s+/g, " ").trim(), 400),
      })
    )
    .join("\n");

  return [
    {
      role: "system",
      content: [
        "Tu es un analyste Voice of Customer.",
        "À partir d'un ensemble d'avis d'une application mobile, rédige UN SEUL commentaire type,",
        "comme si un utilisateur représentatif résumait l'expérience générale de la base.",
        "Il doit synthétiser les points récurrents (positifs ET négatifs), rester naturel et crédible,",
        "dans la langue majoritaire des avis, en 2 à 4 phrases. N'invente pas de faits absents des avis.",
        "Donne aussi une note représentative de 1 à 5 (entier) reflétant le ressenti global.",
        "Réponds STRICTEMENT en JSON conforme au schéma fourni.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        "Avis (JSONL, un par ligne) :",
        lines,
        "",
        "JSON attendu :",
        JSON.stringify({ comment: "string", rating: 0 }, null, 2),
      ].join("\n"),
    },
  ];
}

export async function generateRevoxRead(req, res) {
  try {
    const appPk = req.body?.app_pk || req.query?.app_pk;
    if (!appPk) return res.status(400).json({ error: "Paramètre requis: app_pk" });

    const limit = Math.min(
      Number(req.body?.limit || req.query?.limit || DEFAULT_SAMPLE) || DEFAULT_SAMPLE,
      MAX_SAMPLE
    );

    const reviews = await fetchRecentReviews(appPk, limit);
    if (!reviews.length) {
      return res.status(404).json({ error: "Aucun avis pour cette app" });
    }

    const ai = await callOpenAIJson(buildMessages(reviews));
    const revoxRead = sanitizeRevoxRead(ai, reviews.length, process.env.OPENAI_MODEL);
    const computedAt = new Date().toISOString();

    // Upsert sur la ligne metadata de l'app.
    await ddb.send(
      new UpdateCommand({
        TableName: METADATA_TABLE,
        Key: { app_pk: appPk },
        UpdateExpression: "SET revox_read = :r, revox_read_at = :at",
        ExpressionAttributeValues: { ":r": revoxRead, ":at": computedAt },
      })
    );

    return res.json({
      ok: true,
      app_pk: appPk,
      revox_read: revoxRead,
      revox_read_at: computedAt,
    });
  } catch (e) {
    console.error("generateRevoxRead error:", e);
    return res.status(500).json({ error: e.message || "Erreur serveur" });
  }
}

export async function getRevoxRead(req, res) {
  try {
    const appPk = req.query?.app_pk;
    if (!appPk) return res.status(400).json({ error: "Paramètre requis: app_pk" });

    const out = await ddb.send(
      new GetCommand({
        TableName: METADATA_TABLE,
        Key: { app_pk: appPk },
        ProjectionExpression: "revox_read, revox_read_at",
      })
    );

    const item = out.Item;
    if (!item?.revox_read) {
      return res.json({ ok: true, found: false, app_pk: appPk, revox_read: null });
    }

    return res.json({
      ok: true,
      found: true,
      app_pk: appPk,
      revox_read: item.revox_read,
      revox_read_at: item.revox_read_at || null,
    });
  } catch (e) {
    console.error("getRevoxRead error:", e);
    return res.status(500).json({ error: e.message || "Erreur serveur" });
  }
}
