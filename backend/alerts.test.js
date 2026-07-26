// alerts.test.js — validation des 3 types d'alertes
// Lancer avec : npm test  (node --test)

import { test } from "node:test";
import assert from "node:assert/strict";

import { validateAlertBody } from "./alerts.js";

const base = { platform: "ios", bundleId: "com.revolut.revolut", email: "a@b.co" };

test("champs requis: platform, bundleId, email", () => {
  assert.match(validateAlertBody({}).error, /platform et bundleId/);
  assert.match(validateAlertBody({ platform: "ios", bundleId: "x" }).error, /email/);
});

test("alertType inconnu -> erreur", () => {
  const r = validateAlertBody({ ...base, alertType: "review_anomaly" });
  assert.match(r.error, /alertType doit être/);
});

test("review_match: au moins un critère requis", () => {
  const r = validateAlertBody({ ...base, alertType: "review_match" });
  assert.match(r.error, /Au moins un critère/);
});

test("review_match: keywords nettoyés + minuscules", () => {
  const { value } = validateAlertBody({
    ...base, alertType: "review_match", keywords: [" Fraude ", "BUG", ""],
  });
  assert.deepEqual(value.keywords, ["fraude", "bug"]);
  assert.equal(value.alertType, "review_match");
});

test("review_match: maxRating hors 1..5 -> erreur", () => {
  assert.match(validateAlertBody({ ...base, alertType: "review_match", maxRating: 6 }).error, /maxRating/);
  assert.match(validateAlertBody({ ...base, alertType: "review_match", maxRating: 0 }).error, /maxRating/);
  assert.ok(validateAlertBody({ ...base, alertType: "review_match", maxRating: 3 }).value);
});

test("volume_spike: aucun critère requis, champs review_match neutralisés", () => {
  const { value, error } = validateAlertBody({
    ...base, alertType: "volume_spike",
    keywords: ["fraude"], maxRating: 2, triggerOnNewReview: true,
  });
  assert.equal(error, undefined);
  assert.equal(value.alertType, "volume_spike");
  assert.deepEqual(value.keywords, []);
  assert.equal(value.maxRating, null);
  assert.equal(value.triggerOnNewReview, false);
});

test("negative_spike: valide sans critère", () => {
  const { value, error } = validateAlertBody({ ...base, alertType: "negative_spike" });
  assert.equal(error, undefined);
  assert.equal(value.alertType, "negative_spike");
  assert.equal(value.maxRating, null);
});

test("enabled par défaut à true, respecté si fourni", () => {
  assert.equal(validateAlertBody({ ...base, alertType: "negative_spike" }).value.enabled, true);
  assert.equal(validateAlertBody({ ...base, alertType: "negative_spike", enabled: false }).value.enabled, false);
});
