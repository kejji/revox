// ratings.js — Définition partagée de ce qui compte comme review "négative".
// -------------------------------------------------------------------------
// Cette définition DOIT rester identique entre l'ingestion (worker.js) et le
// backfill (scripts/backfillNegativeReviews.js), sinon le compteur
// negative_reviews diverge du stock réel des reviews.

export const NEGATIVE_RATING_MAX = 3;

export function isNegativeRating(rating) {
  const r = Number(rating);
  return Number.isFinite(r) && r <= NEGATIVE_RATING_MAX;
}
