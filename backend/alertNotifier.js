// backend/alertNotifier.js
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const REGION = process.env.AWS_REGION || "eu-west-3";
const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL;

const ses = new SESClient({ region: REGION });

export async function handler(event) {
  console.log("[ALERT_NOTIFIER] records:", event.Records?.length || 0);

  if (!SES_FROM_EMAIL) {
    throw new Error("Missing required env var: SES_FROM_EMAIL");
  }

  for (const record of event.Records || []) {
    const message = JSON.parse(record.body);

    const isAnomaly = message.type === "REVIEW_ANOMALY_DETECTED";

    const subject = isAnomaly
      ? `Revox alert — possible incident on ${message.appName || message.bundleId}`
      : `Revox alert — ${message.reviews.length} review(s) detected`;
    
    const body = isAnomaly
      ? buildAnomalyEmailText(message)
      : buildEmailText(message);

    await ses.send(
      new SendEmailCommand({
        Source: SES_FROM_EMAIL,
        Destination: {
          ToAddresses: [message.email],
        },
        Message: {
          Subject: {
            Data: subject,
            Charset: "UTF-8",
          },
          Body: {
            Text: {
              Data: body,
              Charset: "UTF-8",
            },
          },
        },
      })
    );

    console.log(`[ALERT_NOTIFIER] email sent to=${message.email} alert=${message.alertId}`);
  }

  return { ok: true };
}

function buildEmailText(message) {
  const criteria = [];

  if (message.criteria?.triggerOnNewReview) criteria.push("new review");

  if (message.criteria?.maxRating !== null && message.criteria?.maxRating !== undefined) {
    criteria.push(`rating <= ${message.criteria.maxRating}`);
  }

  if (message.criteria?.keywords?.length) {
    criteria.push(`keywords: ${message.criteria.keywords.join(", ")}`);
  }

  const reviewsText = (message.reviews || [])
    .map((review, index) =>
      [
        `Review ${index + 1}`,
        `Rating: ${review.rating}/5`,
        `Author: ${review.userName || "N/A"}`,
        `Date: ${review.date || "N/A"}`,
        `App version: ${review.appVersion || "N/A"}`,
        "",
        review.text || "",
      ].join("\n")
    )
    .join("\n\n-------------------------\n\n");

  return [
    "Hello,",
    "",
    `${message.reviews.length} new review(s) match your Revox alert.`,
    "",
    `Application: ${message.appName || message.bundleId}`,
    `Platform: ${message.platform}`,
    `Criteria: ${criteria.join(" / ") || "N/A"}`,
    "",
    "Reviews:",
    "",
    reviewsText,
    "",
    "—",
    "Revox",
  ].join("\n");
}

function formatDuration(minutes) {
  if (minutes === null || minutes === undefined) return "N/A";

  const rounded = Math.round(minutes);

  if (rounded < 60) return `${rounded} min`;

  const hours = Math.round(rounded / 60);
  if (hours < 48) return `${hours} h`;

  const days = Math.round(hours / 24);
  return `${days} day(s)`;
}

function buildAnomalyEmailText(message) {
  const anomaliesText = (message.anomalies || [])
    .map((a) => {
      if (a.type === "volume_spike") {
        return [
          "- Abnormal review volume",
          `  Current: ${formatDuration(a.currentDurationMinutes)} for ${message.sampleSize} reviews`,
          `  Usual: ${formatDuration(a.baselineDurationMinutes)} for ${message.sampleSize} reviews`,
          `  Acceleration: x${Number(a.multiplier || 0).toFixed(1)}`,
        ].join("\n");
      }

      if (a.type === "negative_rate_increase") {
        return [
          "- Increase in negative reviews",
          `  Current negative rate: ${Math.round((a.currentNegativeRate || 0) * 100)}%`,
          `  Usual negative rate: ${Math.round((a.baselineNegativeRate || 0) * 100)}%`,
          `  Increase: +${Math.round((a.increase || 0) * 100)} points`,
        ].join("\n");
      }

      return `- ${a.label || a.type}`;
    })
    .join("\n\n");

  return [
    "Hello,",
    "",
    "Revox detected a possible incident on one of your monitored apps.",
    "",
    `Application: ${message.appName || message.bundleId}`,
    `Platform: ${message.platform}`,
    `Sample analyzed: ${message.sampleSize} new reviews`,
    "",
    "Detected anomaly:",
    "",
    anomaliesText || "N/A",
    "",
    "Baseline:",
    `- Average reviews/day: ${Number(message.baseline?.avgReviewsPerDay || 0).toFixed(1)}`,
    `- Usual negative rate: ${message.baseline?.negativeRatePercent ?? "N/A"}%`,
    `- Usual time for sample: ${formatDuration(message.baseline?.durationMinutesForSample)}`,
    "",
    "Current:",
    `- Current negative rate: ${message.current?.negativeRatePercent ?? "N/A"}%`,
    `- Current time for sample: ${formatDuration(message.current?.durationMinutes)}`,
    "",
    "—",
    "Revox",
  ].join("\n");
}