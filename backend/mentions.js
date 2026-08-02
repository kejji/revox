// backend/mentions.js

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand
} from "@aws-sdk/lib-dynamodb";

import { extractFrequentMentions } from "./frequentMentions.js";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const REVIEWS_TABLE = process.env.APP_REVIEWS_TABLE;
const MENTIONS_TABLE = process.env.FREQUENT_MENTIONS_TABLE;

async function fetchReviews(appPk, limit = 1000) {
  const out = await ddb.send(
    new QueryCommand({
      TableName: REVIEWS_TABLE,
      KeyConditionExpression: "app_pk = :appPk",
      ExpressionAttributeValues: {
        ":appPk": appPk
      },
      ScanIndexForward: false,
      Limit: limit
    })
  );

  return out.Items || [];
}

// app_pk unique ou liste séparée par des virgules (ex. "android#x,ios#y"),
// dédupliqué. Comme GET /reviews.
export function parseAppPks(value) {
  return Array.from(
    new Set(
      String(value || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    )
  );
}

// Clé de stockage canonique pour une combinaison d'apps : la liste triée et
// jointe par virgule. Pour une seule app, la clé = l'app_pk (rétro-compatible
// avec les snapshots existants). Triée pour que l'ordre des apps n'ait pas
// d'importance ("ios#a,android#b" == "android#b,ios#a").
export function canonicalAppKey(appPks) {
  return [...appPks].sort().join(",");
}

// Récupère les avis des N apps (jusqu'à `limit` par app) et renvoie leur UNION.
// Chaque app est donc pleinement représentée — comme si on faisait le run solo
// de chacune — ce qui rend les counts fusionnés ≈ additifs. Pas de plafond
// global : l'entrée de l'extraction vaut ~`limit × nombre d'apps` (borné, le
// nombre d'apps est petit). Tri par date décroissante pour un ordre déterministe.
async function fetchReviewsForApps(appPks, limit) {
  const perApp = await Promise.all(appPks.map((pk) => fetchReviews(pk, limit)));
  const pickKey = (r) => r?.date || r?.ts_review || "";
  return perApp
    .flat()
    .sort((a, b) => String(pickKey(b)).localeCompare(String(pickKey(a))));
}

export async function generateMentions(req, res) {
  try {
    const appPks = parseAppPks(req.body?.app_pk || req.query?.app_pk);
    const limit = Math.min(
      Number(req.body?.limit || req.query?.limit || 1000),
      3000
    );

    if (!appPks.length) {
      return res.status(400).json({ error: "Paramètre requis: app_pk" });
    }

    const reviews = await fetchReviewsForApps(appPks, limit);

    const mentions = extractFrequentMentions(reviews, {
      minCount: 3,
      maxResults: 40
    });

    const computedAt = new Date().toISOString();

    const item = {
      app_pk: canonicalAppKey(appPks),
      app_pks: appPks,
      computed_at: computedAt,
      reviews_count: reviews.length,
      mentions
    };

    await ddb.send(
      new PutCommand({
        TableName: MENTIONS_TABLE,
        Item: item
      })
    );

    return res.json({
      ok: true,
      ...item
    });
  } catch (error) {
    console.error("generateMentions error:", error);
    return res.status(500).json({
      error: error.message || "Erreur serveur"
    });
  }
}

export async function getMentionsResult(req, res) {
  try {
    const appPks = parseAppPks(req.query?.app_pk);

    if (!appPks.length) {
      return res.status(400).json({ error: "Paramètre requis: app_pk" });
    }

    const key = canonicalAppKey(appPks);

    const out = await ddb.send(
      new QueryCommand({
        TableName: MENTIONS_TABLE,
        KeyConditionExpression: "app_pk = :appPk",
        ExpressionAttributeValues: {
          ":appPk": key
        },
        ScanIndexForward: false,
        Limit: 1
      })
    );

    const latest = out.Items?.[0];

    if (!latest) {
      return res.json({
        ok: true,
        found: false,
        app_pk: key,
        app_pks: appPks,
        mentions: []
      });
    }

    return res.json({
      ok: true,
      found: true,
      ...latest
    });
  } catch (error) {
    console.error("getMentionsResult error:", error);
    return res.status(500).json({
      error: error.message || "Erreur serveur"
    });
  }
}