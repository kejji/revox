// backend/openaiClient.js
// Petit client OpenAI partagé (clé via Secrets Manager, appel JSON strict).
// Même câblage que openaiThemes.js, factorisé pour être réutilisable.
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const OPENAI_URL = process.env.OPENAI_URL;
const OPENAI_MODEL = process.env.OPENAI_MODEL;
let OPENAI_KEY = process.env.OPENAI_API_KEY;
const DEFAULT_TIMEOUT = 150000; // 150s

function fetchWithTimeout(url, options = {}, ms = DEFAULT_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

export async function ensureOpenAIKey() {
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

// Appelle OpenAI en mode JSON strict (response_format json_object) et renvoie
// l'objet JSON déjà parsé.
export async function callOpenAIJson(messages, { temperature = 0.2, timeout = DEFAULT_TIMEOUT } = {}) {
  const key = await ensureOpenAIKey();

  const body = {
    model: OPENAI_MODEL,
    temperature,
    response_format: { type: "json_object" },
    messages,
  };

  const resp = await fetchWithTimeout(
    OPENAI_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    timeout
  );

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`OpenAI API error ${resp.status}: ${txt}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "{}";

  try {
    return JSON.parse(content);
  } catch {
    throw new Error("Réponse OpenAI non-JSON (response_format) — vérifier le prompt.");
  }
}
