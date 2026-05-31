// backend/frequentMentions.js

const GENERIC_STOP_WORDS = new Set([
  "app", "apps", "application", "applications", "appli",
  "review", "reviews", "avis",
  "version", "phone", "mobile",

  "the", "and", "for", "you", "your", "with", "this", "that", "from",
  "are", "was", "were", "have", "has", "had", "not", "but", "all",

  "les", "des", "une", "pour", "avec", "dans", "sur", "pas", "plus",
  "est", "sont", "mon", "mes", "que", "qui", "mais", "tout", "tres",
  "bien", "depuis", "vous", "suis", "cette", "fois", "jours", "sans",
  "fait", "faire", "plusieurs", "toujours", "meme", "merci",

  "los", "las", "una", "para", "con", "por", "del", "esta", "este",
  "pero",

  "der", "die", "das", "und", "mit", "ist", "nicht", "ein", "eine",

  "per", "non", "che", "uno", "gli", "della"
]);

function normalizeForKey(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForDisplay(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsefulToken(tokenKey) {
  return (
    tokenKey &&
    tokenKey.length >= 3 &&
    !GENERIC_STOP_WORDS.has(tokenKey) &&
    !/^\d+$/.test(tokenKey)
  );
}

function tokenize(text) {
  const displayText = normalizeForDisplay(text);
  const keyText = normalizeForKey(text);

  const displayTokens = displayText.split(" ").filter(Boolean);
  const keyTokens = keyText.split(" ").filter(Boolean);

  const maxLength = Math.min(displayTokens.length, keyTokens.length);

  const tokens = [];

  for (let i = 0; i < maxLength; i++) {
    tokens.push({
      index: i,
      display: displayTokens[i],
      key: keyTokens[i],
      useful: isUsefulToken(keyTokens[i])
    });
  }

  return tokens;
}

function getPhraseCandidates(tokens, size) {
  const usefulTokens = tokens.filter((token) => token.useful);
  const candidates = [];

  for (let i = 0; i <= usefulTokens.length - size; i++) {
    const group = usefulTokens.slice(i, i + size);

    const key = group.map((token) => token.key).join(" ");

    const startIndex = group[0].index;
    const endIndex = group[group.length - 1].index;

    const label = tokens
      .slice(startIndex, endIndex + 1)
      .map((token) => token.display)
      .join(" ");

    candidates.push({ key, label });
  }

  return candidates;
}

function addMention(map, key, label, review) {
  if (!map.has(key)) {
    map.set(key, {
      key,
      label,
      type: "phrase",
      count: 0,
      ratingsSum: 0,
      ratingsCount: 0,
      labelCounts: new Map()
    });
  }

  const item = map.get(key);
  item.count += 1;

  item.labelCounts.set(label, (item.labelCounts.get(label) || 0) + 1);

  const rating = Number(review.rating);
  if (Number.isFinite(rating)) {
    item.ratingsSum += rating;
    item.ratingsCount += 1;
  }
}

function getBestLabel(item) {
  return Array.from(item.labelCounts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].length - b[0].length;
    })[0]?.[0] || item.label;
}

export function extractFrequentMentions(reviews, options = {}) {
  const {
    minCount = 5,
    maxResults = 40
  } = options;

  const mentionsMap = new Map();

  for (const review of reviews || []) {
    const tokens = tokenize(review.text);
    if (!tokens.length) continue;

    const candidates = [
      ...getPhraseCandidates(tokens, 2),
      ...getPhraseCandidates(tokens, 3)
    ];

    const uniquePhrasesForReview = new Map();

    for (const candidate of candidates) {
      if (!uniquePhrasesForReview.has(candidate.key)) {
        uniquePhrasesForReview.set(candidate.key, candidate.label);
      }
    }

    for (const [key, label] of uniquePhrasesForReview.entries()) {
      addMention(mentionsMap, key, label, review);
    }
  }

  return Array.from(mentionsMap.values())
    .map((item) => ({
      label: getBestLabel(item),
      type: item.type,
      count: item.count,
      avgRating:
        item.ratingsCount > 0
          ? Number((item.ratingsSum / item.ratingsCount).toFixed(2))
          : null
    }))
    .filter((item) => item.count >= minCount)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.label.localeCompare(b.label);
    })
    .slice(0, maxResults);
}