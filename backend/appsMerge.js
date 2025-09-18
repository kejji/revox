// backend/appsMerge.js
import { linkPair, unlinkPair, getLinks, ensureLinksDoc } from "./appLinks.js";
import { upsertThemesSchedule } from "./themesScheduleApi.js";

function validateAppPks(input) {
  if (!input || !Array.isArray(input.app_pks)) return 'Body attendu: { app_pks: ["android#...","ios#..."] }';
  const { app_pks } = input;
  if (app_pks.length !== 2) return "app_pks doit contenir exactement 2 éléments";
  const [a, b] = app_pks.map(x => String(x || "").trim());
  if (!a || !b) return "Les deux app_pks sont requis";
  if (a === b) return "Les deux app_pks doivent être différents";
  return null;
}

// Normalise une clé de groupe pour les thèmes (ordre stable)
const groupKey = (arr) => {
  const clean = (arr || []).map(s => String(s || "").trim()).filter(Boolean);
  clean.sort(); // ordre alphabétique pour stabilité/idempotence
  return clean.join(",");
};

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

    // 2) Lancer l'analyse Thèmes sur le groupe fusionné (a+b)
    //    -> on appelle directement le handler upsertThemesSchedule (sans HTTP)
    //       avec run_now=true pour avoir immédiatement un job.
    const merged = groupKey([a, b]); // ex: "android#...,ios#..."
    let run_now = { job_id: null, day: null };
    try {
      const fakeReq = {
        auth: req.auth, // propage l'auth si ton handler la vérifie
        body: { app_pk: merged, enabled: true },
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
        json: (payload) => { // au cas où le handler fait res.json(payload)
          captured = { code: 200, body: payload };
          return captured;
        }
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