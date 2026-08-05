// backend/userProfile.js
// Profil de l'utilisateur courant : lecture (profil + plan/abonnement +
// préférences) et écriture des SEULES préférences (jamais plan/status, qui
// restent contrôlés côté serveur — future facturation).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import { getLinks } from "./appLinks.js";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const USERS_TABLE = process.env.REVOX_USERS_TABLE;
const USER_FOLLOWS_TABLE = process.env.USER_FOLLOWS_TABLE;

const MAX_HOME_ORDER = 500;

// Nettoie une liste d'app_pk : strings trim, dédupliquées, bornées.
export function cleanHomeOrder(arr) {
  if (!Array.isArray(arr)) return null;
  return Array.from(
    new Set(arr.map((x) => String(x).trim()).filter(Boolean))
  ).slice(0, MAX_HOME_ORDER);
}

// Construit les CARDS ordonnées de l'écran d'accueil.
// Une card = une composante connexe du graphe de liens (`links`) parmi les apps
// suivies (apps mergées = une seule card ; app non liée = card singleton).
// Ordre : la position d'une card = la position la plus précoce de l'un de ses
// membres dans l'ordre stocké ; les cards dont aucun membre n'est dans l'ordre
// stocké sont ajoutées en fin (les plus récemment suivies d'abord). Les membres
// d'une card sont eux-mêmes ordonnés selon l'ordre stocké puis la récence.
export function buildOrderedCards(storedOrder, follows, links = {}) {
  const followList = Array.isArray(follows) ? follows : [];
  const followedSet = new Set(followList.map((f) => f.app_pk));
  const followedByPk = new Map(followList.map((f) => [f.app_pk, f]));

  // 1) composantes connexes (cards) parmi les apps suivies
  const visited = new Set();
  const cards = [];
  for (const { app_pk: start } of followList) {
    if (visited.has(start)) continue;
    const comp = [];
    const stack = [start];
    visited.add(start);
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      for (const nb of links[cur] || []) {
        if (followedSet.has(nb) && !visited.has(nb)) {
          visited.add(nb);
          stack.push(nb);
        }
      }
    }
    cards.push(comp);
  }

  // 2) ordonnancement via l'ordre stocké (+ récence en repli)
  const pos = new Map(
    (Array.isArray(storedOrder) ? storedOrder : []).map((pk, i) => [pk, i])
  );
  const INF = Number.MAX_SAFE_INTEGER;
  const posOf = (pk) => (pos.has(pk) ? pos.get(pk) : INF);
  const recencyOf = (pk) => String(followedByPk.get(pk)?.followed_at || "");

  for (const card of cards) {
    card.sort((a, b) => posOf(a) - posOf(b) || recencyOf(b).localeCompare(recencyOf(a)));
  }

  const minPos = (card) => Math.min(...card.map(posOf));
  const maxRecency = (card) => card.reduce((m, pk) => (recencyOf(pk) > m ? recencyOf(pk) : m), "");

  cards.sort((a, b) => minPos(a) - minPos(b) || maxRecency(b).localeCompare(maxRecency(a)));

  return cards;
}

async function getFollows(userId) {
  const out = await ddb.send(
    new QueryCommand({
      TableName: USER_FOLLOWS_TABLE,
      KeyConditionExpression: "user_id = :uid",
      ExpressionAttributeValues: { ":uid": userId },
      ProjectionExpression: "app_pk, followed_at",
    })
  );
  return (out.Items || []).filter(
    (it) => it.app_pk && it.app_pk !== "APP_LINKS"
  );
}

export async function getMe(req, res) {
  const userId = req.auth?.sub;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const [userOut, follows, links] = await Promise.all([
      ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { id: userId } })),
      getFollows(userId),
      getLinks(userId),
    ]);

    const user = userOut.Item || { id: userId };
    const preferences = user.preferences || {};

    // Seule sortie d'ordre pour le rendu : les cards ordonnées (apps mergées
    // regroupées), calculées à partir de l'ordre stocké + des liens.
    // `preferences` reste l'objet brut stocké (pas d'ordre réconcilié dupliqué).
    const home_cards = buildOrderedCards(preferences.home_order, follows, links);

    return res.status(200).json({
      id: userId,
      email: user.email ?? null,
      given_name: user.given_name ?? null,
      family_name: user.family_name ?? null,
      plan: user.plan ?? null,
      status: user.status ?? null,
      preferences,
      home_cards,
    });
  } catch (err) {
    console.error("getMe error:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}

export async function updatePreferences(req, res) {
  const userId = req.auth?.sub;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const body = req.body || {};
  if (!("home_order" in body)) {
    return res.status(400).json({ error: "home_order est requis" });
  }

  const home_order = cleanHomeOrder(body.home_order);
  if (home_order === null) {
    return res.status(400).json({ error: "home_order doit être un tableau d'app_pk" });
  }

  try {
    // Read-modify-write pour préserver les autres clés de preferences (à venir)
    // sans écraser plan/status.
    const cur = await ddb.send(
      new GetCommand({
        TableName: USERS_TABLE,
        Key: { id: userId },
        ProjectionExpression: "preferences",
      })
    );
    const preferences = { ...(cur.Item?.preferences || {}), home_order };

    await ddb.send(
      new UpdateCommand({
        TableName: USERS_TABLE,
        Key: { id: userId },
        UpdateExpression: "SET preferences = :p, updated_at = :now",
        ConditionExpression: "attribute_exists(id)",
        ExpressionAttributeValues: {
          ":p": preferences,
          ":now": new Date().toISOString(),
        },
      })
    );

    return res.status(200).json({ ok: true, preferences });
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }
    console.error("updatePreferences error:", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
}
