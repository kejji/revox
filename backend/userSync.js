// backend/user-sync.js
// Lambda Cognito PostConfirmation -> crée l'utilisateur dans DynamoDB `RevoxUsers`
// Ne s'exécute qu'au moment "PostConfirmation_ConfirmSignUp" (une seule fois par user)

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const REGION = process.env.AWS_REGION;
const USERS_TABLE = process.env.REVOX_USERS_TABLE;

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

function extractName(attrs) {
  const gn = (attrs.given_name || "").trim();
  const fn = (attrs.family_name || "").trim();
  const full = [gn, fn].filter(Boolean).join(" ");
  return full || (attrs.name || undefined);
}

exports.handler = async (event) => {
  try {
    if (!USERS_TABLE) return event;

    // Exécuter UNIQUEMENT lors de la confirmation de sign-up
    if (event?.triggerSource !== "PostConfirmation_ConfirmSignUp") {
      return event;
    }

    const attrs = event?.request?.userAttributes || {};
    const user_id = attrs.sub;
    if (!user_id) return event;

    // 1) Vérifie si l'utilisateur existe déjà (lecture seule)
    const got = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: { user_id }
    }));
    if (got.Item) return event; // déjà présent -> on ne fait rien

    // 2) Crée l'utilisateur (une seule fois)
    const now = new Date().toISOString();
    await ddb.send(new PutCommand({
      TableName: USERS_TABLE,
      Item: {
        user_id,
        email: attrs.email,
        name: extractName(attrs),
        created_at: now,
        last_seen_at: now,
        plan: "free",
        status: "active",
      }
    }));
  } catch (e) {
    console.error("user-sync error:", e?.message || e);
    // On ne bloque jamais la confirmation Cognito
  }
  return event;
};
