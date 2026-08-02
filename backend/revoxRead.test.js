// revoxRead.test.js — normalisation de la sortie OpenAI
// Lancer avec : npm test  (node --test)

import { test } from "node:test";
import assert from "node:assert/strict";

import { sanitizeRevoxRead } from "./revoxRead.js";

test("comment trim, rating arrondi et borné 1..5", () => {
  const r = sanitizeRevoxRead({ comment: "  Super appli  ", rating: 4.6 }, 500, "gpt-4o-mini");
  assert.equal(r.comment, "Super appli");
  assert.equal(r.rating, 5);
  assert.equal(r.reviews_count, 500);
  assert.equal(r.model, "gpt-4o-mini");
});

test("rating hors bornes -> clamp", () => {
  assert.equal(sanitizeRevoxRead({ comment: "x", rating: 9 }, 1).rating, 5);
  assert.equal(sanitizeRevoxRead({ comment: "x", rating: 0 }, 1).rating, 1);
});

test("rating non numérique -> null", () => {
  assert.equal(sanitizeRevoxRead({ comment: "x", rating: "abc" }, 1).rating, null);
  assert.equal(sanitizeRevoxRead({ comment: "x" }, 1).rating, null);
});

test("comment manquant -> chaîne vide", () => {
  assert.equal(sanitizeRevoxRead({ rating: 3 }, 1).comment, "");
});
