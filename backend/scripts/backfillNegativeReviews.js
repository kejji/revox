// scripts/backfillNegativeReviews.js
// ---------------------------------------------------------------------------
// Backfill / réconciliation du compteur `negative_reviews` dans la table
// metadata, à partir du STOCK réel des reviews.
//
// Pourquoi : `negative_reviews` est maintenu de façon incrémentale à
// l'ingestion (worker.js), mais il part de 0 pour les apps dont les reviews
// ont été ingérées avant l'ajout du compteur. Ce script recompte le vrai total
// depuis APP_REVIEWS_TABLE et écrit la valeur via SET.
//
// Idempotent : recompte toujours depuis la source de vérité, donc ré-exécutable
// sans risque de double comptage. À lancer de préférence dans une fenêtre calme
// (une review ingérée pendant le scan d'une app peut être écrasée par le SET ;
//  une nouvelle exécution corrige l'écart).
//
// Usage :
//   AWS_REGION=eu-west-3 \
//   APPS_METADATA_TABLE=... APP_REVIEWS_TABLE=... \
//   node scripts/backfillNegativeReviews.js [--dry-run] [--app-pk=ios#123]
// ---------------------------------------------------------------------------

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import { NEGATIVE_RATING_MAX } from "../ratings.js";

const REGION = process.env.AWS_REGION || "eu-west-3";
const METADATA_TABLE = process.env.APPS_METADATA_TABLE;
const REVIEWS_TABLE = process.env.APP_REVIEWS_TABLE;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY_APP_PK = args.find((a) => a.startsWith("--app-pk="))?.split("=")[1];

if (!METADATA_TABLE || !REVIEWS_TABLE) {
  console.error("APPS_METADATA_TABLE et APP_REVIEWS_TABLE sont requis.");
  process.exit(1);
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

// Compte les reviews négatives (rating <= NEGATIVE_RATING_MAX) d'une app.
// Select: COUNT => on paie la lecture mais on ne rapatrie pas les items.
async function countNegativeReviews(appPk) {
  let count = 0;
  let lastKey;

  do {
    const q = await ddb.send(
      new QueryCommand({
        TableName: REVIEWS_TABLE,
        KeyConditionExpression: "app_pk = :pk",
        FilterExpression: "#r <= :max",
        ExpressionAttributeNames: { "#r": "rating" },
        ExpressionAttributeValues: {
          ":pk": appPk,
          ":max": NEGATIVE_RATING_MAX,
        },
        Select: "COUNT",
        ExclusiveStartKey: lastKey,
      })
    );

    count += q.Count || 0;
    lastKey = q.LastEvaluatedKey;
  } while (lastKey);

  return count;
}

async function* iterateAppPks() {
  if (ONLY_APP_PK) {
    yield ONLY_APP_PK;
    return;
  }

  let lastKey;
  do {
    const out = await ddb.send(
      new ScanCommand({
        TableName: METADATA_TABLE,
        ProjectionExpression: "app_pk",
        ExclusiveStartKey: lastKey,
      })
    );

    for (const item of out.Items || []) {
      if (item.app_pk) yield item.app_pk;
    }
    lastKey = out.LastEvaluatedKey;
  } while (lastKey);
}

async function run() {
  let apps = 0;
  let updated = 0;

  for await (const appPk of iterateAppPks()) {
    apps++;
    try {
      const negative = await countNegativeReviews(appPk);

      if (DRY_RUN) {
        console.log(`[DRY] ${appPk} negative_reviews=${negative}`);
        continue;
      }

      await ddb.send(
        new UpdateCommand({
          TableName: METADATA_TABLE,
          Key: { app_pk: appPk },
          UpdateExpression: "SET negative_reviews = :n",
          ExpressionAttributeValues: { ":n": negative },
        })
      );

      updated++;
      console.log(`[OK] ${appPk} negative_reviews=${negative}`);
    } catch (e) {
      console.error(`[ERR] ${appPk}:`, e?.message || e);
    }
  }

  console.log(
    `\nTerminé. Apps parcourues: ${apps}, mises à jour: ${updated}${DRY_RUN ? " (dry-run)" : ""}.`
  );
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
