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

export async function generateMentions(req, res) {
  try {
    const appPk = req.body?.app_pk || req.query?.app_pk;
    const limit = Math.min(
      Number(req.body?.limit || req.query?.limit || 1000),
      3000
    );

    if (!appPk) {
      return res.status(400).json({ error: "Paramètre requis: app_pk" });
    }

    const reviews = await fetchReviews(appPk, limit);

    const mentions = extractFrequentMentions(reviews, {
      minCount: 3,
      maxResults: 40
    });

    const computedAt = new Date().toISOString();

    const item = {
      app_pk: appPk,
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
    const appPk = req.query?.app_pk;

    if (!appPk) {
      return res.status(400).json({ error: "Paramètre requis: app_pk" });
    }

    const out = await ddb.send(
      new QueryCommand({
        TableName: MENTIONS_TABLE,
        KeyConditionExpression: "app_pk = :appPk",
        ExpressionAttributeValues: {
          ":appPk": appPk
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
        app_pk: appPk,
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