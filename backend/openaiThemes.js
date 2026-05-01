// backend/openaiThemes.js
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// --- Config OpenAI ---
const OPENAI_URL = process.env.OPENAI_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL;
let OPENAI_KEY = process.env.OPENAI_API_KEY;
const OPENAI_TIMEOUT = 150000; // 150s

function fetchWithTimeout(url, options = {}, ms = OPENAI_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal })
    .finally(() => clearTimeout(t));
}

async function ensureOpenAIKey() {
  if (OPENAI_KEY) return OPENAI_KEY;

  const secretName = process.env.OPENAI_SECRET_NAME;
  if (!secretName) throw new Error("OPENAI_SECRET_NAME is missing");

  const sm = new SecretsManagerClient({});
  const out = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
  const raw = out.SecretString || "";

  try {
    const parsed = JSON.parse(raw);
    OPENAI_KEY = parsed.api_key || parsed.key || parsed.OPENAI_API_KEY || raw;
  } catch {
    OPENAI_KEY = raw;
  }

  if (!OPENAI_KEY) throw new Error("OpenAI key not found in secret");

  process.env.OPENAI_API_KEY = OPENAI_KEY;
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

function toIsoDate(value) {
  if (!value) return null;

  const raw = String(value).trim();

  // Si déjà ISO valide
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString();
  }

  // Fallback si format "YYYY-MM-DD HH:mm:ss"
  const normalized = raw.replace(" ", "T");
  const d2 = new Date(normalized);
  if (!Number.isNaN(d2.getTime())) {
    return d2.toISOString();
  }

  return raw;
}

function normalizeExample(ex = {}) {
  const rawDate =
    ex.date ||
    ex.datetime ||
    ex.created_at ||
    ex.createdAt ||
    ex.review_date ||
    ex.reviewDate ||
    ex.updated ||
    "";

  return {
    date: toIsoDate(rawDate),
    platform:
      ex.platform ||
      ex.store ||
      ex.source ||
      ex.os ||
      null,
    rating: toNum(ex.rating),
    text: truncate(String(ex.text || "").replace(/\s+/g, " ").trim(), 240),
    user_name:
      ex.user_name ||
      ex.username ||
      ex.userName ||
      ex.author ||
      ex.authorName ||
      ex.user ||
      ex.name ||
      null,
  };
}

function dedupeExamples(arr) {
  const seen = new Set();
  const out = [];

  for (const ex of (arr || [])) {
    const normalized = normalizeExample(ex);

    const key = [
      normalized.date || "",
      normalized.platform || "",
      normalized.rating ?? "",
      normalized.user_name || "",
      normalized.text || ""
    ].join("|");

    if (!seen.has(key) && normalized.text) {
      seen.add(key);
      out.push(normalized);
    }
  }

  return out;
}

// --- Prompt builder ---
function buildPrompt({ appPks, from, to, lang, posCutoff, negCutoff, topN }, rows) {
  const lines = rows.map(r => {
    const ex = normalizeExample({
      ...r,
      text: truncate((r.text || "").replace(/\s+/g, " ").trim(), 600),
    });

    return JSON.stringify({
      date: ex.date,
      platform: ex.platform,
      rating: ex.rating,
      user_name: ex.user_name,
      text: ex.text,
    });
  }).join("\n");

  return [
    {
      role: "system",
      content: [
        "Tu es un analyste VOC multilingue.",
        "Objectif: extraire des AXES (thèmes) clairs et actionnables + top 3 NEG & top 3 POS.",
        `Polarité: note <= ${negCutoff} = négatif, note >= ${posCutoff} = positif; sinon infère le ton du texte.`,
        "Labels: courts et concrets.",
        "Disjonction stricte: un axe ne doit JAMAIS être à la fois en négatif et en positif.",
        "Retourne TOUS les exemples pertinents pour chaque axe, sans limite à 3.",
        "Chaque exemple doit conserver exactement ces champs si disponibles: date, platform, rating, text, user_name.",
        "Le champ date doit rester au format ISO complet avec fuseau horaire, exemple: 2026-04-29T20:55:56.000Z.",
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
        "Reviews JSONL, une review par ligne :",
        lines,
        "",
        "JSON attendu:",
        JSON.stringify({
          top_negative_axes: [
            {
              axis_label: "string",
              count: 0,
              avg_rating: 0,
              examples: [
                {
                  date: "2026-04-29T20:55:56.000Z",
                  platform: "ios|android",
                  rating: 1,
                  text: "...",
                  user_name: "string"
                }
              ]
            }
          ],
          top_positive_axes: [
            {
              axis_label: "string",
              count: 0,
              avg_rating: 0,
              examples: [
                {
                  date: "2026-04-29T20:55:56.000Z",
                  platform: "ios|android",
                  rating: 5,
                  text: "...",
                  user_name: "string"
                }
              ]
            }
          ],
          axes: [
            {
              axis_label: "string",
              total_reviews: 0,
              positive: {
                count: 0,
                avg_rating: 0,
                examples: [
                  {
                    date: "2026-04-29T20:55:56.000Z",
                    platform: "ios|android",
                    rating: 5,
                    text: "...",
                    user_name: "string"
                  }
                ]
              },
              negative: {
                count: 0,
                avg_rating: 0,
                examples: [
                  {
                    date: "2026-04-29T20:55:56.000Z",
                    platform: "ios|android",
                    rating: 1,
                    text: "...",
                    user_name: "string"
                  }
                ]
              }
            }
          ]
        }, null, 2),
        "",
        `Contraintes: top_negative_axes=${topN}, top_positive_axes=${topN}, axes=breakdown complet.`,
        "Fusionne les synonymes sous UN même axe; aucun doublon d’exemples; retourne tous les exemples disponibles."
      ].join("\n")
    }
  ];
}

// --- Disjonction POS/NEG ---
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

  console.log("[Themes] sample review", JSON.stringify(reviews[0], null, 2));

  const messages = buildPrompt({ appPks, from, to, lang, posCutoff, negCutoff, topN }, reviews);

  const body = {
    model: OPENAI_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages
  };

  console.log("[OpenAI] call", { url: OPENAI_URL, model: OPENAI_MODEL, msgs: messages.length });
  console.log("key prefix", OPENAI_KEY.slice(0, 7));

  const resp = await fetchWithTimeout(OPENAI_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  }, OPENAI_TIMEOUT);

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