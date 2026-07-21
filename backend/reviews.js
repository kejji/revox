import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const REVIEWS_TABLE = process.env.APP_REVIEWS_TABLE;
const METADATA_TABLE = process.env.APPS_METADATA_TABLE;

const VALID_PLATFORMS = new Set(["ios", "android"]);

// Taille de page interne des Query DynamoDB quand un filtre est actif : on
// balaie plus large pour limiter les allers-retours (le filtrage est applicatif).
const FILTERED_PAGE_SIZE = 300;
// Garde-fou : nb max de pages balayées par app et par requête, pour borner le
// coût sur les grosses partitions quand un filtre est très sélectif.
const MAX_PAGES_PER_APP = 40;

function b64(obj) { return Buffer.from(JSON.stringify(obj)).toString("base64"); }
function unb64(s) { return s ? JSON.parse(Buffer.from(s, "base64").toString("utf-8")) : undefined; }

function parseAppsFromQuery(qs) {
  const v = qs.app_pk;
  if (!v) return [];
  const arr = String(v).split(",").map(x => x.trim()).filter(Boolean);
  return Array.from(new Set(arr));
}

/* ------------------------------------------------------------------ *
 * Helpers de filtrage (fonctions pures, testées dans reviews.test.js) *
 * ------------------------------------------------------------------ */

// Minuscules + suppression des accents/diacritiques, pour une comparaison
// `contains` insensible à la casse ET aux accents.
export function normalizeText(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Borne basse : début de journée si date seule.
function toLowerBound(v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Borne haute inclusive : fin de journée si date seule (sinon l'instant fourni).
function toUpperBound(v) {
  if (DATE_ONLY_RE.test(v)) {
    const d = new Date(`${v}T23:59:59.999Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Parse et valide les query params.
 * Retourne { appPks, limit, cursor, filters } ou { error } (message 400).
 */
export function parseReviewFilters(qs = {}) {
  const appPks = parseAppsFromQuery(qs);
  if (!appPks.length) {
    return { error: "Paramètre requis: app_pk (valeur unique ou liste séparée par des virgules)" };
  }

  const parsedLimit = parseInt(qs.limit ?? "", 10);
  const limit = Math.min(Math.max(Number.isNaN(parsedLimit) ? 50 : parsedLimit, 1), 200);
  const cursor = unb64(qs.cursor);

  // q : mots-clés séparés par virgule, normalisés + trim (OU entre eux).
  const q = qs.q
    ? String(qs.q).split(",").map(x => normalizeText(x).trim()).filter(Boolean)
    : [];

  // rating : notes séparées par virgule (OU), chacune ∈ 1..5.
  let ratings = null;
  if (qs.rating !== undefined && String(qs.rating).trim() !== "") {
    const parsed = String(qs.rating).split(",").map(x => x.trim()).filter(Boolean);
    const nums = [];
    for (const p of parsed) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        return { error: `rating invalide: "${p}" (attendu un entier entre 1 et 5)` };
      }
      nums.push(n);
    }
    if (nums.length) ratings = new Set(nums);
  }

  const version = qs.version ? String(qs.version).trim() : null;

  let platform = null;
  if (qs.platform !== undefined && String(qs.platform).trim() !== "") {
    platform = String(qs.platform).trim().toLowerCase();
    if (!VALID_PLATFORMS.has(platform)) {
      return { error: `platform invalide: "${qs.platform}" (attendu "ios" ou "android")` };
    }
  }

  let fromBound = null;
  if (qs.from !== undefined && String(qs.from).trim() !== "") {
    fromBound = toLowerBound(String(qs.from).trim());
    if (!fromBound) return { error: `from invalide: "${qs.from}" (date ISO attendue)` };
  }

  let toBound = null;
  if (qs.to !== undefined && String(qs.to).trim() !== "") {
    toBound = toUpperBound(String(qs.to).trim());
    if (!toBound) return { error: `to invalide: "${qs.to}" (date ISO attendue)` };
  }

  const hasAny =
    q.length > 0 || ratings !== null || version !== null ||
    platform !== null || fromBound !== null || toBound !== null;

  return {
    appPks,
    limit,
    cursor,
    filters: { q, ratings, version, platform, fromBound, toBound, hasAny },
  };
}

function itemDate(item) {
  if (item?.date) return item.date;
  const sk = item?.ts_review;
  return sk ? String(sk).split("#")[0] : "";
}

/**
 * Prédicat unique — SOURCE DE VÉRITÉ des filtres.
 * Combinaison en ET entre familles ; OU à l'intérieur de `q` et de `rating`.
 */
export function reviewMatches(item, filters) {
  if (!filters || !filters.hasAny) return true;

  // q : OU — le text contient au moins un des mots-clés (casse/accents insensibles)
  if (filters.q.length) {
    const hay = normalizeText(item?.text);
    if (!filters.q.some(kw => hay.includes(kw))) return false;
  }

  // rating : OU — la note appartient à l'ensemble
  if (filters.ratings && !filters.ratings.has(Number(item?.rating))) return false;

  // version : ET — égalité stricte
  if (filters.version && item?.app_version !== filters.version) return false;

  // platform : ET — égalité (les valeurs stockées sont déjà en minuscules)
  if (filters.platform && String(item?.platform ?? "").toLowerCase() !== filters.platform) return false;

  // plage de dates : ET — bornes incluses
  if (filters.fromBound || filters.toBound) {
    const d = itemDate(item);
    if (!d) return false;
    if (filters.fromBound && d < filters.fromBound) return false;
    if (filters.toBound && d > filters.toBound) return false;
  }

  return true;
}

/* ------------------------------------------------------------------ *
 * Accès DynamoDB                                                       *
 * ------------------------------------------------------------------ */

/**
 * Récupère jusqu'à `needed` avis matchant les filtres pour une app (DESC),
 * en paginant la Query. Filtrage applicatif (cf. limite MVP documentée).
 * Retourne { matches, lastKey, exhausted }.
 */
async function collectMatchesForApp(appPk, startKey, needed, filters) {
  const matches = [];
  let lastKey = startKey;
  let pages = 0;
  const pageLimit = filters.hasAny ? FILTERED_PAGE_SIZE : needed;

  do {
    const out = await ddb.send(new QueryCommand({
      TableName: REVIEWS_TABLE,
      KeyConditionExpression: "app_pk = :apk",
      ExpressionAttributeValues: { ":apk": appPk },
      ScanIndexForward: false,
      Limit: pageLimit,
      ExclusiveStartKey: lastKey,
    }));

    for (const it of out.Items || []) {
      if (reviewMatches(it, filters)) matches.push(it);
    }

    lastKey = out.LastEvaluatedKey;
    pages += 1;
  } while (lastKey && matches.length < needed && pages < MAX_PAGES_PER_APP);

  return { matches, lastKey, exhausted: !lastKey };
}

/**
 * Compte TOUS les avis matchant les filtres pour une app (scan complet de la
 * partition, projeté sur les seuls champs du prédicat).
 * ⚠️ Limite MVP : coût O(taille de la partition). Si le volume explose, on
 * branchera un index de recherche (OpenSearch/GSI) plutôt que ce scan.
 */
async function countMatchesForApp(appPk, filters) {
  let count = 0;
  let lastKey;

  do {
    const out = await ddb.send(new QueryCommand({
      TableName: REVIEWS_TABLE,
      KeyConditionExpression: "app_pk = :apk",
      ExpressionAttributeValues: { ":apk": appPk },
      ExpressionAttributeNames: {
        "#t": "text", "#r": "rating", "#v": "app_version",
        "#p": "platform", "#d": "date",
      },
      ProjectionExpression: "#t, #r, #v, #p, #d, ts_review",
      ScanIndexForward: false,
      Limit: FILTERED_PAGE_SIZE,
      ExclusiveStartKey: lastKey,
    }));

    for (const it of out.Items || []) {
      if (reviewMatches(it, filters)) count += 1;
    }
    lastKey = out.LastEvaluatedKey;
  } while (lastKey);

  return count;
}

// Total sans filtre : somme des compteurs pré-agrégés `total_reviews`.
async function totalFromMetadata(appPks) {
  if (!METADATA_TABLE) return 0;
  const bg = await ddb.send(new BatchGetCommand({
    RequestItems: {
      [METADATA_TABLE]: {
        Keys: appPks.map(app_pk => ({ app_pk })),
        ProjectionExpression: "app_pk, #c",
        ExpressionAttributeNames: { "#c": "total_reviews" },
      },
    },
  }));
  const rows = bg.Responses?.[METADATA_TABLE] || [];
  return rows.reduce((sum, r) => sum + (Number(r.total_reviews) || 0), 0);
}

/* ------------------------------------------------------------------ *
 * Handler                                                             *
 * ------------------------------------------------------------------ */

export async function listReviews(req, res) {
  try {
    const parsed = parseReviewFilters(req.query || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const { appPks, limit, cursor, filters } = parsed;
    const perAppFromCursor = (cursor && cursor.perApp) || {};

    // 1) Récupère jusqu'à `limit` matchs par app (DESC), en repartant du curseur.
    const perApp = {};
    await Promise.all(appPks.map(async (pk) => {
      const startKey = perAppFromCursor[pk]?.ExclusiveStartKey;
      perApp[pk] = await collectMatchesForApp(pk, startKey, limit, filters);
    }));

    // 2) k-way merge par date (DESC) pour composer la page globale.
    const pickKey = (r) => r?.date || r?.ts_review || "";
    const heads = Object.fromEntries(appPks.map(pk => [pk, 0]));
    const merged = [];

    while (merged.length < limit) {
      let best = null, bestPk = null;
      for (const pk of appPks) {
        const arr = perApp[pk].matches;
        const i = heads[pk];
        if (i >= arr.length) continue;
        const cand = arr[i];
        if (!best || String(pickKey(cand)) > String(pickKey(best))) {
          best = cand; bestPk = pk;
        }
      }
      if (!best) break;
      merged.push(best);
      heads[bestPk] += 1;
    }

    // 3) Curseur : par app, point de reprise = dernier item CONSOMMÉ ; si rien
    //    consommé, on reporte la position d'entrée ; si tout consommé mais non
    //    épuisé, on reprend là où le scan s'est arrêté.
    const nextPerApp = {};
    for (const pk of appPks) {
      const { matches, lastKey, exhausted } = perApp[pk];
      const consumed = heads[pk];

      if (consumed < matches.length) {
        // il reste des matchs bufferisés non consommés → reprendre au dernier consommé
        const anchor = consumed > 0 ? matches[consumed - 1] : null;
        const esk = anchor
          ? { app_pk: anchor.app_pk || pk, ts_review: anchor.ts_review }
          : perAppFromCursor[pk]?.ExclusiveStartKey;
        if (esk) nextPerApp[pk] = { ExclusiveStartKey: esk };
      } else if (!exhausted) {
        // tout le buffer consommé mais la partition n'est pas épuisée
        if (lastKey) nextPerApp[pk] = { ExclusiveStartKey: lastKey };
      }
      // sinon : app épuisée et tout consommé → pas de reprise
    }
    const nextCursor = Object.keys(nextPerApp).length ? b64({ perApp: nextPerApp }) : undefined;

    const response = {
      items: merged,
      nextCursor,
      count: merged.length,
    };

    // 4) total (indépendant de la pagination) — calculé UNIQUEMENT sur la 1re
    //    page (curseur absent). Le front l'affiche une fois ("143 reviews") ;
    //    inutile de re-scanner la partition à chaque page de l'infinite scroll.
    const isFirstPage = !cursor;
    if (isFirstPage) {
      response.total = filters.hasAny
        ? (await Promise.all(appPks.map(pk => countMatchesForApp(pk, filters))))
            .reduce((a, b) => a + b, 0)
        : await totalFromMetadata(appPks);
    }

    return res.json(response);
  } catch (e) {
    console.error("listReviews error:", e);
    return res.status(500).json({ error: e.message || "Erreur serveur" });
  }
}
