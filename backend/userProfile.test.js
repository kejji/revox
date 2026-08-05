// userProfile.test.js — helpers de préférences utilisateur
// Lancer avec : npm test  (node --test)

import { test } from "node:test";
import assert from "node:assert/strict";

import { cleanHomeOrder, buildOrderedCards } from "./userProfile.js";

const f = (app_pk, followed_at) => ({ app_pk, followed_at });

test("cleanHomeOrder: trim, dédup, filtre vides", () => {
  assert.deepEqual(
    cleanHomeOrder([" android#a ", "ios#b", "android#a", ""]),
    ["android#a", "ios#b"]
  );
});

test("cleanHomeOrder: non-tableau -> null", () => {
  assert.equal(cleanHomeOrder("android#a"), null);
  assert.equal(cleanHomeOrder(undefined), null);
});

test("cards: sans liens -> une card par app, ordre stocké respecté", () => {
  const stored = ["android#a", "ios#b", "android#c"];
  const follows = [f("android#a", "1"), f("ios#b", "2"), f("android#c", "3")];
  assert.deepEqual(buildOrderedCards(stored, follows, {}), [
    ["android#a"], ["ios#b"], ["android#c"],
  ]);
});

test("cards: apps mergées regroupées dans une seule card", () => {
  const stored = ["android#a", "ios#c"];
  const follows = [f("android#a", "1"), f("ios#b", "2"), f("ios#c", "3")];
  const links = { "android#a": ["ios#b"], "ios#b": ["android#a"] };
  // card {a,b} position = index de a (0) ; card {c} = index 1
  assert.deepEqual(buildOrderedCards(stored, follows, links), [
    ["android#a", "ios#b"], ["ios#c"],
  ]);
});

test("cards: position d'une card = membre le plus précoce (même non adjacent)", () => {
  const stored = ["ios#c", "ios#b", "android#a"]; // b avant a
  const follows = [f("android#a", "1"), f("ios#b", "2"), f("ios#c", "3")];
  const links = { "android#a": ["ios#b"], "ios#b": ["android#a"] };
  // card {a,b} minPos = index de b (1) ; card {c} minPos 0
  // membres triés par position stockée : b(1) puis a(2)
  assert.deepEqual(buildOrderedCards(stored, follows, links), [
    ["ios#c"], ["ios#b", "android#a"],
  ]);
});

test("cards: app obsolète (plus suivie) retirée; lien vers app non suivie ignoré", () => {
  const stored = ["android#a", "ios#gone"];
  const follows = [f("android#a", "1"), f("android#c", "3")];
  const links = { "android#a": ["ios#gone"], "ios#gone": ["android#a"] };
  assert.deepEqual(buildOrderedCards(stored, follows, links), [
    ["android#a"], ["android#c"],
  ]);
});

test("cards: nouvelles apps ajoutées en fin, plus récentes d'abord", () => {
  const stored = ["android#a"];
  const follows = [f("android#a", "2026-01-01"), f("ios#n1", "2026-02-01"), f("ios#n2", "2026-03-01")];
  assert.deepEqual(buildOrderedCards(stored, follows, {}), [
    ["android#a"], ["ios#n2"], ["ios#n1"],
  ]);
});
