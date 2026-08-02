// mentions.test.js — helpers multi-app de /mentions
// Lancer avec : npm test  (node --test)

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAppPks, canonicalAppKey } from "./mentions.js";

test("parseAppPks: unique, liste, trim, dédup", () => {
  assert.deepEqual(parseAppPks("ios#a"), ["ios#a"]);
  assert.deepEqual(parseAppPks(" ios#a , android#b "), ["ios#a", "android#b"]);
  assert.deepEqual(parseAppPks("ios#a,ios#a"), ["ios#a"]);
  assert.deepEqual(parseAppPks(""), []);
  assert.deepEqual(parseAppPks(undefined), []);
});

test("canonicalAppKey: une app = l'app_pk (rétro-compatible)", () => {
  assert.equal(canonicalAppKey(["ios#a"]), "ios#a");
});

test("canonicalAppKey: indépendant de l'ordre (trié)", () => {
  const a = canonicalAppKey(["ios#a", "android#b"]);
  const b = canonicalAppKey(["android#b", "ios#a"]);
  assert.equal(a, b);
  assert.equal(a, "android#b,ios#a");
});

test("parse + canonical: même clé quel que soit l'ordre saisi", () => {
  assert.equal(
    canonicalAppKey(parseAppPks("ios#a,android#b")),
    canonicalAppKey(parseAppPks("android#b,ios#a"))
  );
});
