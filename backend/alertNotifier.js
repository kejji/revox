// backend/alertNotifier.js
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");

const REGION = process.env.AWS_REGION || "eu-west-3";
const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL;

const ses = new SESClient({ region: REGION });

exports.handler = async (event) => {
  console.log("[ALERT_NOTIFIER] records:", event.Records?.length || 0);

  for (const record of event.Records || []) {
    const message = JSON.parse(record.body);

    const subject = `Nouvelle alerte Revox — ${message.reviews.length} commentaire(s) détecté(s)`;

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

    console.log(
      `[ALERT_NOTIFIER] email sent to=${message.email} alert=${message.alertId}`
    );
  }

  return { ok: true };
};

function buildEmailText(message) {
  const criteria = [];

  if (message.criteria?.triggerOnNewReview) {
    criteria.push("nouveau commentaire");
  }

  if (message.criteria?.maxRating !== null && message.criteria?.maxRating !== undefined) {
    criteria.push(`note <= ${message.criteria.maxRating}`);
  }

  if (message.criteria?.keywords?.length) {
    criteria.push(`mots-clés: ${message.criteria.keywords.join(", ")}`);
  }

  const reviewsText = (message.reviews || [])
    .map((review, index) => {
      return [
        `Commentaire ${index + 1}`,
        `Note: ${review.rating}/5`,
        `Auteur: ${review.userName || "N/A"}`,
        `Date: ${review.date || "N/A"}`,
        `Version app: ${review.appVersion || "N/A"}`,
        "",
        review.text || "",
      ].join("\n");
    })
    .join("\n\n-------------------------\n\n");

  return [
    "Bonjour,",
    "",
    `${message.reviews.length} nouveau(x) commentaire(s) correspondent à votre alerte Revox.`,
    "",
    `Application: ${message.appName || message.bundleId}`,
    `Plateforme: ${message.platform}`,
    `Critères: ${criteria.join(" / ") || "N/A"}`,
    "",
    "Commentaires:",
    "",
    reviewsText,
    "",
    "—",
    "Revox",
  ].join("\n");
}
