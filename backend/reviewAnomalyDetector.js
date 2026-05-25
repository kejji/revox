// backend/reviewAnomalyDetector.js
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const REGION = process.env.AWS_REGION || "eu-west-3";
const REVIEWS_TABLE = process.env.APP_REVIEWS_TABLE;
const ALERTS_TABLE = process.env.ALERTS_TABLE;
const ANOMALY_STATE_TABLE = process.env.ANOMALY_STATE_TABLE;
const ALERTS_QUEUE_URL = process.env.ALERTS_QUEUE_URL;

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const sqs = new SQSClient({ region: REGION });

const MIN_SAMPLE_SIZE = 10;
const MAX_SAMPLE_SIZE = 100;
const BASELINE_LIMIT = 500;
const VOLUME_SPIKE_MULTIPLIER = 3;
const NEGATIVE_RATE_INCREASE_THRESHOLD = 0.3;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseReviewDate(review) {
  const value = review.date || review.ts_review;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function negativeRate(reviews) {
  if (!reviews.length) return null;
  const negativeCount = reviews.filter((r) => Number(r.rating) <= 2).length;
  return negativeCount / reviews.length;
}

function durationMinutes(reviews) {
  const dates = reviews
    .map(parseReviewDate)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (dates.length < 2) return null;
  return (dates[dates.length - 1] - dates[0]) / 60000;
}

function computeAvgReviewsPerDay(reviews) {
  const dates = reviews
    .map(parseReviewDate)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (dates.length < 2) return reviews.length;

  const days = Math.max((dates[dates.length - 1] - dates[0]) / 86400000, 1);
  return reviews.length / days;
}

function computeSampleSize(avgReviewsPerDay) {
  return clamp(
    Math.round(avgReviewsPerDay * 0.5),
    MIN_SAMPLE_SIZE,
    MAX_SAMPLE_SIZE
  );
}

function formatPercent(value) {
  if (value === null || value === undefined) return null;
  return Math.round(value * 100);
}

async function getLatestReviews(appPk, limit) {
  const out = await ddb.send(
    new QueryCommand({
      TableName: REVIEWS_TABLE,
      KeyConditionExpression: "app_pk = :appPk",
      ExpressionAttributeValues: {
        ":appPk": appPk,
      },
      ScanIndexForward: false,
      Limit: limit,
    })
  );

  return out.Items || [];
}

async function getAnomalyState(appPk) {
  const out = await ddb.send(
    new GetCommand({
      TableName: ANOMALY_STATE_TABLE,
      Key: { app_pk: appPk },
    })
  );

  return out.Item || null;
}

async function saveAnalyzedState(appPk, latestReviewId) {
  const now = Date.now();

  await ddb.send(
    new UpdateCommand({
      TableName: ANOMALY_STATE_TABLE,
      Key: { app_pk: appPk },
      UpdateExpression: `
        SET last_analyzed_review_id = :latestReviewId,
            last_analyzed_at = :now,
            last_analyzed_at_iso = :nowIso
      `,
      ExpressionAttributeValues: {
        ":latestReviewId": latestReviewId,
        ":now": now,
        ":nowIso": new Date(now).toISOString(),
      },
    })
  );
}

async function getActiveAnomalyAlerts(appPk) {
  const out = await ddb.send(
    new QueryCommand({
      TableName: ALERTS_TABLE,
      IndexName: "GSI_AppAlerts",
      KeyConditionExpression: "app_pk = :appPk",
      FilterExpression: "enabled = :enabled AND alert_type = :alertType",
      ExpressionAttributeValues: {
        ":appPk": appPk,
        ":enabled": true,
        ":alertType": "review_anomaly",
      },
    })
  );

  return out.Items || [];
}

async function sendAnomalyNotification(payload) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: ALERTS_QUEUE_URL,
      MessageBody: JSON.stringify(payload),
    })
  );
}

async function detectReviewAnomaly({
  appPk,
  appName,
  platform,
  bundleId,
}) {
  if (!REVIEWS_TABLE || !ALERTS_TABLE || !ANOMALY_STATE_TABLE || !ALERTS_QUEUE_URL) {
    console.warn("[ANOMALY] missing env vars, skip");
    return { checked: false, reason: "missing_env" };
  }

  const anomalyAlerts = await getActiveAnomalyAlerts(appPk);

  if (!anomalyAlerts.length) {
    console.log("[ANOMALY] no active anomaly alerts", { appPk });
    return { checked: false, reason: "no_active_anomaly_alert" };
  }

  const reviews = await getLatestReviews(appPk, BASELINE_LIMIT);

  if (reviews.length < MIN_SAMPLE_SIZE * 2) {
    return { checked: false, reason: "not_enough_history" };
  }

  const state = await getAnomalyState(appPk);
  const lastAnalyzedId = state?.last_analyzed_review_id;

  const lastAnalyzedIndex = lastAnalyzedId
    ? reviews.findIndex((r) => r.ts_review === lastAnalyzedId)
    : -1;

  const newReviews =
    lastAnalyzedIndex === -1 ? reviews : reviews.slice(0, lastAnalyzedIndex);

  const avgReviewsPerDay = computeAvgReviewsPerDay(reviews);
  const sampleSize = computeSampleSize(avgReviewsPerDay);

  if (newReviews.length < sampleSize) {
    console.log("[ANOMALY] skip, not enough new reviews", {
      appPk,
      newReviews: newReviews.length,
      sampleSize,
    });
  
    return {
      checked: false,
      reason: "not_enough_new_reviews",
      newReviews: newReviews.length,
      sampleSize,
    };
  }

  const currentReviews = newReviews.slice(0, sampleSize);
  const baselineReviews = reviews.slice(sampleSize);

  if (baselineReviews.length < sampleSize) {
    return { checked: false, reason: "not_enough_baseline" };
  }

  const latestReviewId = currentReviews[0]?.ts_review;

  const currentNegativeRate = negativeRate(currentReviews);
  const baselineNegativeRate = negativeRate(baselineReviews);

  const currentDurationMinutes = durationMinutes(currentReviews);

  const baselineDurationMinutes =
    (sampleSize / Math.max(avgReviewsPerDay, 0.001)) * 24 * 60;

  const anomalies = [];

  if (
    currentDurationMinutes &&
    baselineDurationMinutes / currentDurationMinutes >= VOLUME_SPIKE_MULTIPLIER
  ) {
    anomalies.push({
      type: "volume_spike",
      label: "Afflux anormal de commentaires",
      multiplier: baselineDurationMinutes / currentDurationMinutes,
      currentDurationMinutes,
      baselineDurationMinutes,
    });
  }

  if (
    baselineNegativeRate !== null &&
    currentNegativeRate !== null &&
    currentNegativeRate - baselineNegativeRate >= NEGATIVE_RATE_INCREASE_THRESHOLD
  ) {
    anomalies.push({
      type: "negative_rate_increase",
      label: "Hausse anormale des commentaires négatifs",
      currentNegativeRate,
      baselineNegativeRate,
      increase: currentNegativeRate - baselineNegativeRate,
    });
  }

  await saveAnalyzedState(appPk, latestReviewId);

  if (!anomalies.length) {
    console.log("[ANOMALY] checked, no anomaly", {
      appPk,
      sampleSize,
      currentNegativeRate,
      baselineNegativeRate,
      currentDurationMinutes,
      baselineDurationMinutes,
    });

    return { checked: true, anomaly: false, sampleSize };
  }

  for (const alert of anomalyAlerts) {
    await sendAnomalyNotification({
      type: "REVIEW_ANOMALY_DETECTED",
      userId: alert.user_id,
      alertId: alert.alert_id,
      email: alert.email,
      appPk,
      appName,
      platform,
      bundleId,
      sampleSize,
      current: {
        negativeRate: currentNegativeRate,
        negativeRatePercent: formatPercent(currentNegativeRate),
        durationMinutes: currentDurationMinutes,
      },
      baseline: {
        avgReviewsPerDay,
        negativeRate: baselineNegativeRate,
        negativeRatePercent: formatPercent(baselineNegativeRate),
        durationMinutesForSample: baselineDurationMinutes,
      },
      anomalies,
      createdAt: new Date().toISOString(),
    });
  }

  console.log("[ANOMALY] notification queued", {
    appPk,
    sampleSize,
    alerts: anomalyAlerts.length,
    anomalies: anomalies.map((a) => a.type),
  });

  return {
    checked: true,
    anomaly: true,
    sampleSize,
    notified: anomalyAlerts.length,
    anomalies: anomalies.map((a) => a.type),
  };
}

module.exports = {
  detectReviewAnomaly,
};