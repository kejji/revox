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
import { parseAppPks, canonicalAppKey } from "./appKeys.js";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const REVIEWS_TABLE = process.env.APP_REVIEWS_TABLE;
const METADATA_TABLE = process.env.APPS_METADATA_TABLE;

const DEFAULT_SAMPLE = 500; // avis les plus récents envoyés au modèle
const MAX_SAMPLE = 1000;

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

// Longueur maximale du commentaire type, comptée HORS espaces.
const MAX_COMMENT_NONSPACE = 250;

const nonSpaceLen = (s) => s.replace(/\s/g, "").length;

// Garde-fou : le modèle est peu fiable pour compter les caractères, donc on
// applique la limite côté serveur. Coupe sur une frontière de mot et ajoute "…"
// tout en garantissant un total (ellipse comprise) <= MAX_COMMENT_NONSPACE.
export function capComment(comment) {
  const text = String(comment || "").trim();
  if (nonSpaceLen(text) <= MAX_COMMENT_NONSPACE) return text;

  let out = "";
  for (const word of text.split(/\s+/)) {
    const candidate = out ? `${out} ${word}` : word;
    // +1 réserve la place de l'ellipse (un caractère hors espace).
    if (nonSpaceLen(candidate) + 1 > MAX_COMMENT_NONSPACE) break;
    out = candidate;
  }

  return `${(out || text.slice(0, 1)).trimEnd()}…`;
}

// Normalise la sortie du modèle : commentaire trim + plafond + note bornée 1..5.
export function sanitizeRevoxRead(ai, reviewsCount, model) {
  const rating = Number(ai?.rating);
  return {
    comment: capComment(ai?.comment),
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
      ProjectionExpression: "rating, #t, #d",
      ExpressionAttributeNames: { "#t": "text", "#d": "date" },
      ScanIndexForward: false,
      Limit: limit,
    })
  );
  return out.Items || [];
}

// Échantillon pour N apps : jusqu'à `limit` avis récents par app, fusionnés,
// puis on garde les `limit` plus récents au TOTAL. Contrairement à /mentions,
// on plafonne le total (et pas par app) car cet échantillon part vers OpenAI :
// le coût en tokens doit rester borné quel que soit le nombre d'apps.
async function fetchRecentReviewsForApps(appPks, limit) {
  const perApp = await Promise.all(appPks.map((pk) => fetchRecentReviews(pk, limit)));
  const pickKey = (r) => r?.date || r?.ts_review || "";
  return perApp
    .flat()
    .sort((a, b) => String(pickKey(b)).localeCompare(String(pickKey(a))))
    .slice(0, limit);
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
        "dans la langue majoritaire des avis, en 1 à 2 phrases courtes.",
        "Le commentaire ne doit JAMAIS dépasser 250 caractères hors espaces — sois concis.",
        "N'invente pas de faits absents des avis.",
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
    const appPks = parseAppPks(req.body?.app_pk || req.query?.app_pk);
    if (!appPks.length) return res.status(400).json({ error: "Paramètre requis: app_pk" });

    const limit = Math.min(
      Number(req.body?.limit || req.query?.limit || DEFAULT_SAMPLE) || DEFAULT_SAMPLE,
      MAX_SAMPLE
    );

    const reviews = await fetchRecentReviewsForApps(appPks, limit);
    if (!reviews.length) {
      return res.status(404).json({ error: "Aucun avis pour cette/ces app(s)" });
    }

    const ai = await callOpenAIJson(buildMessages(reviews));
    const revoxRead = sanitizeRevoxRead(ai, reviews.length, process.env.OPENAI_MODEL);
    revoxRead.app_pks = appPks;
    const computedAt = new Date().toISOString();
    const key = canonicalAppKey(appPks);

    // Upsert sur la ligne metadata (clé = app_pk unique, ou clé canonique de la
    // combinaison pour plusieurs apps).
    await ddb.send(
      new UpdateCommand({
        TableName: METADATA_TABLE,
        Key: { app_pk: key },
        UpdateExpression: "SET revox_read = :r, revox_read_at = :at",
        ExpressionAttributeValues: { ":r": revoxRead, ":at": computedAt },
      })
    );

    return res.json({
      ok: true,
      app_pk: key,
      app_pks: appPks,
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
    const appPks = parseAppPks(req.query?.app_pk);
    if (!appPks.length) return res.status(400).json({ error: "Paramètre requis: app_pk" });

    const key = canonicalAppKey(appPks);

    const out = await ddb.send(
      new GetCommand({
        TableName: METADATA_TABLE,
        Key: { app_pk: key },
        ProjectionExpression: "revox_read, revox_read_at",
      })
    );

    const item = out.Item;
    if (!item?.revox_read) {
      return res.json({ ok: true, found: false, app_pk: key, app_pks: appPks, revox_read: null });
    }

    return res.json({
      ok: true,
      found: true,
      app_pk: key,
      app_pks: appPks,
      revox_read: item.revox_read,
      revox_read_at: item.revox_read_at || null,
    });
  } catch (e) {
    console.error("getRevoxRead error:", e);
    return res.status(500).json({ error: e.message || "Erreur serveur" });
  }
}
