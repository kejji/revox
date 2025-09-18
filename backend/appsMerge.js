// backend/appsMerge.js
import { linkPair, unlinkPair, getLinks, ensureLinksDoc } from "./appLinks.js";
import { upsertThemesSchedule } from "./themesScheduleApi.js";

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION;
const APPS_METADATA_TABLE = process.env.APPS_METADATA_TABLE;

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

function validateAppPks(input) {
  if (!input || !Array.isArray(input.app_pks)) return 'Body attendu: { app_pks: ["android#...","ios#..."] }';
  const { app_pks } = input;
  if (app_pks.length !== 2) return "app_pks doit contenir exactement 2 éléments";
  const [a, b] = app_pks.map(x => String(x || "").trim());
  if (!a || !b) return "Les deux app_pks sont requis";
  if (a === b) return "Les deux app_pks doivent être différents";
  return null;
}

// Clé de groupe stable pour thèmes
const groupKey = (arr) => {
  const clean = (arr || []).map(s => String(s || "").trim()).filter(Boolean);
  clean.sort();
  return clean.join(",");
};

// --- helpers: appName du groupe (lit APPS_METADATA_TABLE) ---
async function getSingleName(app_pk) {
  try {
    const out = await ddb.send(new GetCommand({
      TableName: APPS_METADATA_TABLE,
      Key: { app_pk },
      ProjectionExpression: "#n, bundleId",
      ExpressionAttributeNames: { "#n": "name" }
    }));
    return out?.Item?.name ?? (app_pk.split("#")[1] || null);
  } catch {
    return app_pk.split("#")[1] || null;
  }
}
async function getMergedAppName(app_pks) {
  const names = [];
  for (const pk of app_pks) {
    const n = await getSingleName(pk);
    if (n) names.push(n);
  }
  const unique = Array.from(new Set(names));
  return unique.length ? unique.join(" + ") : null; // ex: "Fortuneo + Fortuneo Pro"
}

export async function mergeApps(req, res) {
  const userId = req.auth?.sub;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const err = validateAppPks(req.body);
  if (err) return res.status(400).json({ error: err });

  const [a, b] = req.body.app_pks.map(x => String(x).trim());

  try {
    // 1) Lier les deux apps pour l'utilisateur
    await ensureLinksDoc(userId);
    await linkPair(userId, a, b);

    // 2) Lancer l'analyse Thèmes sur le groupe fusionné (a+b) avec appName renseigné
    const merged = groupKey([a, b]); // ex: "android#...,ios#..."
    let run_now = { job_id: null, day: null };
    try {
      const appName = await getMergedAppName([a, b]);
      const fakeReq = {
        auth: req.auth,
        body: { app_pk: merged, enabled: true, appName },
        query: { run_now: "true" }
      };
      let captured = null;
      const fakeRes = {
        status: (code) => ({
          json: (payload) => {
            captured = { code, body: payload };
            return captured;
          }
        }),
        json: (payload) => { captured = { code: 200, body: payload }; return captured; }
      };

      await upsertThemesSchedule(fakeReq, fakeRes);

      const body = captured?.body ?? null;
      const rn = body?.run_now ?? body ?? {};
      run_now.job_id = rn?.job_id ?? null;
      run_now.day = rn?.day ?? rn?.date ?? null;
    } catch (e) {
      console.warn("mergeApps: themes run_now failed", e?.message || e);
    }

    // 3) Répondre avec les liens à jour + info run_now
    const links = await getLinks(userId);
    return res.status(201).json({
      ok: true,
      linked: {
        [a]: Array.isArray(links[a]) ? Array.from(new Set(links[a])) : [],
        [b]: Array.isArray(links[b]) ? Array.from(new Set(links[b])) : []
      },
      run_now
    });
  } catch (e) {
    console.error("mergeApps error:", e);
    return res.status(500).json({ error: e.message || "Erreur serveur" });
  }
}

export async function unmergeApps(req, res) {
  const userId = req.auth?.sub;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const err = validateAppPks(req.body);
  if (err) return res.status(400).json({ error: err });

  const [a, b] = req.body.app_pks.map(x => String(x).trim());

  try {
    await unlinkPair(userId, a, b);
    const links = await getLinks(userId);
    return res.status(200).json({
      ok: true,
      linked: {
        [a]: Array.isArray(links[a]) ? Array.from(new Set(links[a])) : [],
        [b]: Array.isArray(links[b]) ? Array.from(new Set(links[b])) : []
      }
    });
  } catch (e) {
    console.error("unmergeApps error:", e);
    return res.status(500).json({ error: e.message || "Erreur serveur" });
  }
}