// backend/alerts.js
import { randomUUID } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION;
const ALERTS_TABLE = process.env.ALERTS_TABLE;

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const appPkOf = (platform, bundleId) =>
  `${String(platform).toLowerCase()}#${String(bundleId)}`;

function cleanKeywords(keywords) {
  if (!Array.isArray(keywords)) return [];
  return keywords
    .map((k) => String(k).trim().toLowerCase())
    .filter(Boolean);
}

function validateAlertBody(body) {
  const {
    platform,
    bundleId,
    email,
    alertType = "review_match",
    triggerOnNewReview = false,
    keywords = [],
    maxRating,
    enabled = true,
  } = body || {};

  if (!platform || !bundleId) {
    return { error: "platform et bundleId sont requis" };
  }

  if (!email) {
    return { error: "email est requis" };
  }

  const normalizedAlertType = String(alertType || "review_match");

  if (!["review_match", "review_anomaly"].includes(normalizedAlertType)) {
    return { error: "alertType doit être review_match ou review_anomaly" };
  }

  const cleanedKeywords = cleanKeywords(keywords);

  const parsedMaxRating =
    maxRating === undefined || maxRating === null || maxRating === ""
      ? null
      : Number(maxRating);

  if (
    parsedMaxRating !== null &&
    (!Number.isFinite(parsedMaxRating) || parsedMaxRating < 1 || parsedMaxRating > 5)
  ) {
    return { error: "maxRating doit être compris entre 1 et 5" };
  }

  if (
    normalizedAlertType === "review_match" &&
    !triggerOnNewReview &&
    cleanedKeywords.length === 0 &&
    parsedMaxRating === null
  ) {
    return {
      error:
        "Au moins un critère est requis : triggerOnNewReview, keywords ou maxRating",
    };
  }

  return {
    value: {
      alertType: normalizedAlertType,
      platform: String(platform).toLowerCase(),
      bundleId: String(bundleId),
      email: String(email).trim(),
      triggerOnNewReview: Boolean(triggerOnNewReview),
      keywords: cleanedKeywords,
      maxRating: parsedMaxRating,
      enabled: Boolean(enabled),
    },
  };
}

export async function createAlert(req, res) {
  const userId = req.auth?.sub;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const validation = validateAlertBody(req.body);
  if (validation.error) return res.status(400).json({ error: validation.error });

  const alertId = randomUUID();
  const now = new Date().toISOString();
  const value = validation.value;

  const item = {
    user_id: userId,
    alert_id: alertId,
    alert_type: value.alertType,
    app_pk: appPkOf(value.platform, value.bundleId),
    platform: value.platform,
    bundle_id: value.bundleId,
    email: value.email,
    enabled: value.enabled,
    trigger_on_new_review: value.triggerOnNewReview,
    keywords: value.keywords,
    max_rating: value.maxRating,
    created_at: now,
    updated_at: now,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: ALERTS_TABLE,
        Item: item,
      })
    );

    return res.status(201).json({ ok: true, alert: item });
  } catch (err) {
    console.error("createAlert error:", err);
    return res.status(500).json({ error: "Impossible de créer l’alerte" });
  }
}

export async function listAlerts(req, res) {
  const userId = req.auth?.sub;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const out = await ddb.send(
      new QueryCommand({
        TableName: ALERTS_TABLE,
        KeyConditionExpression: "user_id = :uid",
        ExpressionAttributeValues: {
          ":uid": userId,
        },
      })
    );

    return res.status(200).json({ alerts: out.Items || [] });
  } catch (err) {
    console.error("listAlerts error:", err);
    return res.status(500).json({ error: "Impossible de récupérer les alertes" });
  }
}

export async function updateAlert(req, res) {
  const userId = req.auth?.sub;
  const { alertId } = req.params || {};
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  if (!alertId) return res.status(400).json({ error: "alertId est requis" });

  const validation = validateAlertBody(req.body);
  if (validation.error) return res.status(400).json({ error: validation.error });

  const value = validation.value;

  try {
    const out = await ddb.send(
      new UpdateCommand({
        TableName: ALERTS_TABLE,
        Key: {
          user_id: userId,
          alert_id: alertId,
        },
        UpdateExpression:
        "SET alert_type = :alertType, app_pk = :appPk, platform = :platform, bundle_id = :bundleId, email = :email, enabled = :enabled, trigger_on_new_review = :trigger, keywords = :keywords, max_rating = :maxRating, updated_at = :updatedAt",
        ExpressionAttributeValues: {
          ":appPk": appPkOf(value.platform, value.bundleId),
          ":platform": value.platform,
          ":bundleId": value.bundleId,
          ":email": value.email,
          ":enabled": value.enabled,
          ":trigger": value.triggerOnNewReview,
          ":keywords": value.keywords,
          ":maxRating": value.maxRating,
          ":updatedAt": new Date().toISOString(),
          ":alertType": value.alertType,
        },
        ReturnValues: "ALL_NEW",
      })
    );

    return res.status(200).json({ ok: true, alert: out.Attributes });
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      return res.status(404).json({ error: "Alerte introuvable" });
    }
    console.error("updateAlert error:", err);
    return res.status(500).json({ error: "Impossible de modifier l’alerte" });
  }
}

export async function deleteAlert(req, res) {
  const userId = req.auth?.sub;
  const { alertId } = req.params || {};
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  if (!alertId) return res.status(400).json({ error: "alertId est requis" });

  try {
    await ddb.send(
      new DeleteCommand({
        TableName: ALERTS_TABLE,
        Key: {
          user_id: userId,
          alert_id: alertId,
        },
      })
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("deleteAlert error:", err);
    return res.status(500).json({ error: "Impossible de supprimer l’alerte" });
  }
}
