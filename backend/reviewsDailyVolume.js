// backend/reviewsDailyVolume.js
// ---------------------------------------------------------------------------
// GET /reviews/daily-volume?app_pk=...&days=30
//
// Renvoie le nombre d'avis par jour sur une fenêtre glissante, plus la baseline
// (moyenne/jour) et le pic. Alimente le graphe "volume/jour".
//
// Efficace : la table reviews est clé app_pk (PK) + ts_review (SK = "YYYY-MM-DD#sig"),
// donc on borne la fenêtre directement dans la KeyConditionExpression (BETWEEN)
// et on ne projette que ts_review (le jour se lit sur ses 10 premiers caractères).
// ---------------------------------------------------------------------------

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const REVIEWS_TABLE = process.env.APP_REVIEWS_TABLE;

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

function parseAppPks(qs) {
  const v = qs.app_pk;
  if (!v) return [];
  const arr = String(v).split(",").map((x) => x.trim()).filter(Boolean);
  return Array.from(new Set(arr));
}

function dayOf(item) {
  // ts_review = "YYYY-MM-DD#sig" ; fallback sur date si présent.
  const src = item.ts_review || item.date || "";
  return String(src).slice(0, 10);
}

// Compte les avis d'une app par jour sur [fromDay, toBound], en paginant la Query.
async function countDaysForApp(appPk, fromDay, toBound, counts) {
  let lastKey;

  do {
    const out = await ddb.send(
      new QueryCommand({
        TableName: REVIEWS_TABLE,
        KeyConditionExpression:
          "app_pk = :pk AND ts_review BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":pk": appPk,
          ":from": fromDay,
          ":to": toBound,
        },
        ProjectionExpression: "ts_review",
        ExclusiveStartKey: lastKey,
      })
    );

    for (const item of out.Items || []) {
      const day = dayOf(item);
      if (day) counts[day] = (counts[day] || 0) + 1;
    }

    lastKey = out.LastEvaluatedKey;
  } while (lastKey);
}

export async function getDailyReviewVolume(req, res) {
  try {
    const qs = req.query || {};
    const appPks = parseAppPks(qs);
    if (!appPks.length) {
      return res.status(400).json({
        error: "Paramètre requis: app_pk (valeur unique ou liste séparée par des virgules)",
      });
    }

    const days = Math.min(
      Math.max(parseInt(qs.days || String(DEFAULT_DAYS), 10) || DEFAULT_DAYS, 1),
      MAX_DAYS
    );

    const now = new Date();
    const todayDay = now.toISOString().slice(0, 10);
    const start = new Date(now.getTime() - (days - 1) * 86400000);
    const fromDay = start.toISOString().slice(0, 10);
    // Borne haute inclusive de tous les avis d'aujourd'hui (n'importe quel sig).
    const toBound = `${todayDay}#￿`;

    // Somme des comptes par jour à travers toutes les apps demandées.
    const counts = {};
    await Promise.all(
      appPks.map((pk) => countDaysForApp(pk, fromDay, toBound, counts))
    );

    // Série continue du plus ancien au plus récent (jours à 0 inclus).
    const series = [];
    let total = 0;
    let peak = { day: fromDay, count: 0 };
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getTime() + i * 86400000)
        .toISOString()
        .slice(0, 10);
      const count = counts[d] || 0;
      series.push({ day: d, count });
      total += count;
      if (count > peak.count) peak = { day: d, count };
    }

    const baseline = Math.round(total / days);

    return res.json({
      app_pk: appPks,
      from: fromDay,
      to: todayDay,
      days,
      total,
      baseline,
      peak,
      series,
    });
  } catch (e) {
    console.error("getDailyReviewVolume error:", e);
    return res.status(500).json({ error: e.message || "Erreur serveur" });
  }
}
