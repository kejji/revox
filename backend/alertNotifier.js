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

    const subject = `Revox alert — ${message.reviews.length} review(s) detected`;
    const body = buildEmailText(message);

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

  if (message.criteria?.triggerOnNewReview) criteria.push("nouveau commentaire");

  if (message.criteria?.maxRating !== null && message.criteria?.maxRating !== undefined) {
    criteria.push(`note <= ${message.criteria.maxRating}`);
  }

  if (message.criteria?.keywords?.length) {
    criteria.push(`mots-clés: ${message.criteria.keywords.join(", ")}`);
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
    `${message.reviews.length} new comment(s) match your Revox alert.`,
    "",
    `Application: ${message.appName || message.bundleId}`,
    `Platform: ${message.platform}`,
    `Crtieria: ${criteria.join(" / ") || "N/A"}`,
    "",
    "Reviews:",
    "",
    reviewsText,
    "",
    "—",
    "Revox",
  ].join("\n");
}