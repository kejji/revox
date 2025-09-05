import { linkPair, unlinkPair, getLinks, ensureLinksDoc } from "./appLinks.js";

function validateAppPks(input) {
  if (!input || !Array.isArray(input.app_pks)) return "Body attendu: { app_pks: [\"android#...\",\"ios#...\"] }";
  const { app_pks } = input;
  if (app_pks.length !== 2) return "app_pks doit contenir exactement 2 éléments";
  const [a, b] = app_pks.map(x => String(x || "").trim());
  if (!a || !b) return "Les deux app_pks sont requis";
  if (a === b) return "Les deux app_pks doivent être différents";
  return null;
}

export async function mergeApps(req, res) {
  const userId = req.auth?.sub;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const err = validateAppPks(req.body);
  if (err) return res.status(400).json({ error: err });

  const [a, b] = req.body.app_pks.map(x => String(x).trim());

  try {
    await ensureLinksDoc(userId);
    await linkPair(userId, a, b);

    const links = await getLinks(userId);
    return res.status(201).json({
      ok: true,
      linked: {
        [a]: Array.isArray(links[a]) ? Array.from(new Set(links[a])) : [],
        [b]: Array.isArray(links[b]) ? Array.from(new Set(links[b])) : []
      }
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
