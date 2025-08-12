import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const USERS_TABLE = process.env.REVOX_USERS_TABLE;

/**
 * S'assure qu'un enregistrement RevoxUsers existe pour l'utilisateur Cognito actuel.
 * - Si absent: crée { user_id=sub, email, name, created_at, last_seen_at, plan:"free", status:"active" }
 * - Si présent: met à jour last_seen_at
 * Retourne l'objet utilisateur (nouveau ou existant).
 */
export async function ensureUser(req) {
  if (!req?.auth?.sub) throw new Error("Unauthorized");

  const user_id = req.auth.sub;

  // 1) Lookup
  const got = await ddb.send(new GetCommand({
    TableName: USERS_TABLE,
    Key: { user_id }
  }));

  // Extraire quelques claims (si dispo selon ton middleware)
  const email = req.auth.email || req.auth.username || req.auth["cognito:username"];
  const name =
    req.auth.name ||
    [req.auth.given_name, req.auth.family_name].filter(Boolean).join(" ") ||
    undefined;

  const now = new Date().toISOString();

  if (!got.Item) {
    const item = {
      user_id,
      email,
      name,
      created_at: now,
      last_seen_at: now,
      plan: "free",
      status: "active",
    };
    await ddb.send(new PutCommand({ TableName: USERS_TABLE, Item: item }));
    return item;
  }

  // 2) Update last_seen_at (et rafraîchir email/name si on les découvre)
  await ddb.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: { user_id },
    UpdateExpression: "SET last_seen_at = :now"
      + (email ? ", email = if_not_exists(email, :email)" : "")
      + (name ? ", #nm = if_not_exists(#nm, :name)" : ""),
    ExpressionAttributeValues: {
      ":now": now,
      ...(email ? { ":email": email } : {}),
      ...(name ? { ":name": name } : {}),
    },
    ExpressionAttributeNames: name ? { "#nm": "name" } : undefined,
  }));

  return { ...(got.Item || {}), last_seen_at: now, email: got.Item?.email ?? email, name: got.Item?.name ?? name };
}
