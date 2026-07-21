// reviews.test.js — tests des helpers de filtrage de GET /reviews
// Lancer avec : npm test  (node --test)

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeText,
  parseReviewFilters,
  reviewMatches,
} from "./reviews.js";

const APP = "android#com.revolut.revolut";

function review(overrides = {}) {
  return {
    app_pk: APP,
    ts_review: "2026-07-10T08:00:00.000Z#sig",
    date: "2026-07-10T08:00:00.000Z",
    rating: 5,
    platform: "android",
    app_version: "v8.20.1",
    text: "Application géniale",
    user_name: "Alice",
    bundle_id: "com.revolut.revolut",
    ...overrides,
  };
}

// Applique les filtres à une liste, comme le fait le calcul de `total`.
function countMatches(items, filters) {
  return items.filter((it) => reviewMatches(it, filters)).length;
}
function parse(qs) {
  const p = parseReviewFilters({ app_pk: APP, ...qs });
  assert.ok(!p.error, `parse inattendu en erreur: ${p.error}`);
  return p;
}

/* --------------------------- normalizeText --------------------------- */

test("normalizeText: minuscules + suppression des accents", () => {
  assert.equal(normalizeText("Carté FRAUDE éàçüî"), "carte fraude eacui");
  assert.equal(normalizeText(undefined), "");
  assert.equal(normalizeText(null), "");
});

/* ------------------------- parseReviewFilters ------------------------ */

test("parse: app_pk requis", () => {
  const p = parseReviewFilters({});
  assert.match(p.error || "", /app_pk/);
});

test("parse: defaults (limit 50, aucun filtre)", () => {
  const { limit, filters } = parse({});
  assert.equal(limit, 50);
  assert.equal(filters.hasAny, false);
});

test("parse: limit borné à 200 et plancher 1", () => {
  assert.equal(parse({ limit: "9999" }).limit, 200);
  assert.equal(parse({ limit: "0" }).limit, 1);
  assert.equal(parse({ limit: "20" }).limit, 20);
});

test("parse: q normalisé et découpé (OU)", () => {
  const { filters } = parse({ q: "Carté, Fraude" });
  assert.deepEqual(filters.q, ["carte", "fraude"]);
  assert.equal(filters.hasAny, true);
});

test("parse: rating valide -> Set, invalides -> 400", () => {
  const { filters } = parse({ rating: "1,2" });
  assert.deepEqual([...filters.ratings].sort(), [1, 2]);
  assert.ok(parseReviewFilters({ app_pk: APP, rating: "6" }).error);
  assert.ok(parseReviewFilters({ app_pk: APP, rating: "0" }).error);
  assert.ok(parseReviewFilters({ app_pk: APP, rating: "x" }).error);
});

test("parse: platform validé", () => {
  assert.equal(parse({ platform: "iOS" }).filters.platform, "ios");
  assert.ok(parseReviewFilters({ app_pk: APP, platform: "windows" }).error);
});

test("parse: bornes de dates (to en date seule -> fin de journée)", () => {
  const { filters } = parse({ from: "2026-07-01", to: "2026-07-19" });
  assert.equal(filters.fromBound, "2026-07-01T00:00:00.000Z");
  assert.equal(filters.toBound, "2026-07-19T23:59:59.999Z");
  assert.ok(parseReviewFilters({ app_pk: APP, from: "pas-une-date" }).error);
});

/* ---------------------------- reviewMatches -------------------------- */

test("match: sans filtre -> tout passe", () => {
  assert.equal(reviewMatches(review(), parse({}).filters), true);
});

test("match: q est un OU, insensible casse/accents", () => {
  const { filters } = parse({ q: "carte,fraude" });
  assert.equal(reviewMatches(review({ text: "Ma CARTE bloquée" }), filters), true); // casse
  assert.equal(reviewMatches(review({ text: "tentative de fraudé" }), filters), true); // accent
  assert.equal(reviewMatches(review({ text: "super appli" }), filters), false);
});

test("match: q=zzzznomatch -> aucun", () => {
  const { filters } = parse({ q: "zzzznomatch" });
  const items = [review({ text: "génial" }), review({ text: "nul" })];
  assert.equal(countMatches(items, filters), 0);
});

test("match: rating est un OU", () => {
  const { filters } = parse({ rating: "1,2" });
  assert.equal(reviewMatches(review({ rating: 1 }), filters), true);
  assert.equal(reviewMatches(review({ rating: 2 }), filters), true);
  assert.equal(reviewMatches(review({ rating: 3 }), filters), false);
});

test("match: version et platform en ET (égalité stricte)", () => {
  assert.equal(reviewMatches(review({ app_version: "v8.20.1" }), parse({ version: "v8.20.1" }).filters), true);
  assert.equal(reviewMatches(review({ app_version: "v8.20.0" }), parse({ version: "v8.20.1" }).filters), false);
  assert.equal(reviewMatches(review({ platform: "android" }), parse({ platform: "ios" }).filters), false);
});

test("match: plage de dates inclusive aux deux bornes", () => {
  const { filters } = parse({ from: "2026-07-01", to: "2026-07-19" });
  assert.equal(reviewMatches(review({ date: "2026-07-01T00:00:00.000Z" }), filters), true); // borne basse incluse
  assert.equal(reviewMatches(review({ date: "2026-07-19T23:59:59.999Z" }), filters), true); // borne haute incluse
  assert.equal(reviewMatches(review({ date: "2026-06-30T23:59:59.999Z" }), filters), false);
  assert.equal(reviewMatches(review({ date: "2026-07-20T00:00:00.000Z" }), filters), false);
});

test("match: combinaison ET de tous les filtres", () => {
  const { filters } = parse({
    q: "carte,fraude", rating: "1,2", version: "v8.20.1",
    platform: "ios", from: "2026-07-01", to: "2026-07-19",
  });
  const ok = review({
    text: "fraude sur ma carte", rating: 1, app_version: "v8.20.1",
    platform: "ios", date: "2026-07-10T12:00:00.000Z",
  });
  assert.equal(reviewMatches(ok, filters), true);
  // un seul critère qui casse -> rejet
  assert.equal(reviewMatches({ ...ok, platform: "android" }, filters), false);
  assert.equal(reviewMatches({ ...ok, rating: 5 }, filters), false);
  assert.equal(reviewMatches({ ...ok, date: "2026-08-01T00:00:00.000Z" }, filters), false);
});

test("total: reflète l'ensemble filtré complet", () => {
  const items = [
    review({ text: "carte perdue", rating: 1 }),
    review({ text: "fraude détectée", rating: 2 }),
    review({ text: "super appli", rating: 5 }),
    review({ text: "rien à voir", rating: 1 }),
  ];
  assert.equal(countMatches(items, parse({ q: "carte,fraude" }).filters), 2);
  assert.equal(countMatches(items, parse({ rating: "1" }).filters), 2);
  assert.equal(countMatches(items, parse({ q: "carte,fraude", rating: "1" }).filters), 1);
});
