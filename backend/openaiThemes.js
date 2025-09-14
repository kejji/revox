// backend/openaiThemes.js
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// --- Config OpenAI ---
const OPENAI_URL   = process.env.OPENAI_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL;
let OPENAI_KEY   = process.env.OPENAI_API_KEY;

async function ensureOpenAIKey() {
  if (OPENAI_KEY) return OPENAI_KEY;
  const secretName = process.env.OPENAI_SECRET_NAME; // ex: "openai/api-key"
  if (!secretName) throw new Error("OPENAI_SECRET_NAME is missing");
  const sm = new SecretsManagerClient({});
  const out = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
  // supporte soit secretString brut, soit JSON { api_key: "..." }
  const raw = out.SecretString || "";
  try {
    const parsed = JSON.parse(raw);
    OPENAI_KEY = parsed.api_key || parsed.key || parsed.OPENAI_API_KEY || raw;
  } catch {
    OPENAI_KEY = raw;
  }
  if (!OPENAI_KEY) throw new Error("OpenAI key not found in secret");
  process.env.OPENAI_API_KEY = OPENAI_KEY; // utile pour les autres modules
  return OPENAI_KEY;
}

// --- Utils ---
const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : (s || ""));
const toNum = (x) => (Number.isFinite(+x) ? +x : null);

function stripDiacritics(s) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function toAxisId(label) {
  return stripDiacritics(String(label || "").toLowerCase())
    .replace(/[^a-z0-9/_\s-]/g, "")
    .replace(/\s+/g, "_");
}

function dedupeExamples(arr) {
  const seen = new Set();
  const out = [];
  for (const ex of (arr || [])) {
    const key = `${ex?.date || ""}|${ex?.rating ?? ""}|${ex?.text || ""}`;
    if (!seen.has(key) && ex?.text) {
      seen.add(key);
      out.push({
        date: (ex.date || "").slice(0, 10),
        rating: toNum(ex.rating),
        text: truncate(String(ex.text).replace(/\s+/g, " ").trim(), 240),
      });
    }
    if (out.length >= 3) break; // max 3 exemples par axe
  }
  return out;
}

// --- Prompt builder ---
function buildPrompt({ appPks, from, to, lang, posCutoff, negCutoff, topN }, rows) {
  const lines = rows.map(r => {
    const txt = truncate((r.text || "").replace(/\s+/g, " ").trim(), 600);
    const d = (r.date || "").slice(0, 10);
    const rating = r.rating != null ? r.rating : "";
    return `${d} | ${rating}★ | ${txt}`;
  }).join("\n");

  return [
    {
      role: "system",
      content: [
        "Tu es un analyste VOC multilingue.",
        "Objectif: extraire des AXES (thèmes) clairs et actionnables + top 3 NEG & top 3 POS.",
        `Polarité: note <= ${negCutoff} = négatif, note >= ${posCutoff} = positif; sinon infère le ton du texte.`,
        "Labels: courts et concrets (ex: “Affichage tardif des transactions”, “Problèmes de connexion et authentification”, “Notifications intempestives”).",
        "Disjonction stricte: un axe ne doit JAMAIS être à la fois en négatif et en positif.",
        "Exemples: max 3 par axe, distincts, concis.",
        "Réponds STRICTEMENT en JSON conforme au schéma fourni."
      ].join(" ")
    },
    {
      role: "user",
      content: [
        `Langue: ${lang || "fr"}`,
        `Fenêtre: ${from || "?"} → ${to || "?"}`,
        `Apps: ${(appPks || []).join(", ") || "n/a"}`,
        "",
        "Reviews (une par ligne: date | note★ | texte) :",
        lines,
        "",
        "JSON attendu:",
        JSON.stringify({
          top_negative_axes: [
            { axis_label: "string", count: 0, avg_rating: 0, examples: [{ date: "YYYY-MM-DD", rating: 1, text: "..." }] }
          ],
          top_positive_axes: [
            { axis_label: "string", count: 0, avg_rating: 0, examples: [{ date: "YYYY-MM-DD", rating: 5, text: "..." }] }
          ],
          axes: [
            {
              axis_label: "string",
              total_reviews: 0,
              positive: { count: 0, avg_rating: 0, examples: [] },
              negative: { count: 0, avg_rating: 0, examples: [] }
            }
          ]
        }, null, 2),
        "",
        `Contraintes: top_negative_axes=${topN}, top_positive_axes=${topN}, axes=breakdown complet.`,
        "Fusionne les synonymes sous UN même axe; aucun doublon d’exemples."
      ].join("\n")
    }
  ];
}

// --- Disjonction POS/NEG (par id) ---
function enforceDisjoint(out) {
  const toId = (x) => toAxisId(x?.axis_label || "");
  const negIds = new Set((out.top_negative_axes || []).map(x => toId(x)));
  const filteredPos = (out.top_positive_axes || []).filter(x => !negIds.has(toId(x)));
  return { ...out, top_positive_axes: filteredPos };
}

// --- Post-traitement ---
function postProcess(raw) {
  const safe = {
    top_negative_axes: Array.isArray(raw?.top_negative_axes) ? raw.top_negative_axes : [],
    top_positive_axes: Array.isArray(raw?.top_positive_axes) ? raw.top_positive_axes : [],
    axes: Array.isArray(raw?.axes) ? raw.axes : [],
  };

  const fixTopList = (list) =>
    (list || []).map(item => {
      const label = String(item?.axis_label || "").trim();
      return {
        ...item,
        axis_label: label,
        axis_id: toAxisId(label),
        count: toNum(item?.count) ?? 0,
        avg_rating: toNum(item?.avg_rating),
        examples: dedupeExamples(item?.examples || []),
      };
    });

  const fixedAxes = (safe.axes || []).map(a => {
    const label = String(a?.axis_label || "").trim();
    return {
      axis_label: label,
      axis_id: toAxisId(label),
      total_reviews: toNum(a?.total_reviews) ?? 0,
      positive: {
        count: toNum(a?.positive?.count) ?? 0,
        avg_rating: toNum(a?.positive?.avg_rating),
        examples: dedupeExamples(a?.positive?.examples || []),
      },
      negative: {
        count: toNum(a?.negative?.count) ?? 0,
        avg_rating: toNum(a?.negative?.avg_rating),
        examples: dedupeExamples(a?.negative?.examples || []),
      },
    };
  });

  return {
    top_negative_axes: fixTopList(safe.top_negative_axes),
    top_positive_axes: fixTopList(safe.top_positive_axes),
    axes: fixedAxes,
  };
}

// --- Fonction principale ---
export async function analyzeThemesWithOpenAI(
  { appPks, from, to, lang = "fr", posCutoff = 4, negCutoff = 3, topN = 3 },
  reviews
) {
  await ensureOpenAIKey();
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY is missing");
  if (!reviews?.length) return { top_negative_axes: [], top_positive_axes: [], axes: [] };

  // Ici on passe TOUS les reviews (plus d’échantillonnage ni MAX_REVIEWS)
  const messages = buildPrompt({ appPks, from, to, lang, posCutoff, negCutoff, topN }, reviews);

  const body = {
    model: OPENAI_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages
  };

  const resp = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`OpenAI API error ${resp.status}: ${txt}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "{}";

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Réponse OpenAI non-JSON (response_format) — vérifier le prompt.");
  }

  const cleaned = postProcess(parsed);
  return enforceDisjoint(cleaned);
}