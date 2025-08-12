// backend/userSync.js
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

function extractFamilyName(attrs) {
  return (attrs.family_name || "").trim() || undefined;
}

function extractGivenName(attrs) {
  return (attrs.given_name || "").trim() || undefined;
}

exports.handler = async (event) => {
  try {
    if (!USERS_TABLE) {
      console.warn("user-sync: USERS_TABLE is not set");
      return event;
    }
    // Exécuter UNIQUEMENT lors de la confirmation de sign-up
    if (event?.triggerSource !== "PostConfirmation_ConfirmSignUp") {
      console.log("user-sync: skipped triggerSource =", event?.triggerSource);
      return event;
    }

    const attrs = event?.request?.userAttributes || {};
    const sub = attrs.sub;
    if (!sub) {
      console.error("user-sync: missing sub in userAttributes");
      return event;
    }
    const key = { id: String(sub) };
    console.log("user-sync: processing", { table: USERS_TABLE, key, email: attrs.email });
    // 1) Vérifie si l'utilisateur existe déjà (lecture seule)
    const got = await ddb.send(new GetCommand({
      TableName: USERS_TABLE,
      Key: key
    }));
    if (got.Item) {
      console.log("user-sync: already exists");
      return event;
    }
    // 2) Crée l'utilisateur (une seule fois)
    const now = new Date().toISOString();
    await ddb.send(new PutCommand({
      TableName: USERS_TABLE,
      Item: {
        ...key,
        email: attrs.email || undefined,
        family_name: extractFamilyName(attrs),
        given_name: extractGivenName(attrs),
        created_at: now,
        plan: "free",
        status: "active",
      },
      // évite les doublons en cas de retry
      ConditionExpression: "attribute_not_exists(id)"
    }));
    console.log("user-sync: put ok");
  } catch (e) {
    console.error("user-sync error:", e?.message || e);
  }
  return event;
};
