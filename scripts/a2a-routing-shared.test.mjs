import test from "node:test";
import assert from "node:assert/strict";

import { TEAM_BROKER_INVARIANT, hasText, normalizeUrl } from "./a2a-routing-shared.mjs";

test("TEAM_BROKER_INVARIANT maps team1→brokerAlpha and team2→brokerBeta", () => {
  assert.deepEqual(TEAM_BROKER_INVARIANT, { team1: "brokerAlpha", team2: "brokerBeta" });
});

test("hasText is true only for non-blank strings", () => {
  assert.equal(hasText("x"), true);
  assert.equal(hasText("  x "), true);
  assert.equal(hasText(""), false);
  assert.equal(hasText("   "), false);
  assert.equal(hasText(undefined), false);
  assert.equal(hasText(123), false);
});

test("normalizeUrl trims and strips trailing slashes, passing through non-strings", () => {
  assert.equal(normalizeUrl(" https://brokerAlpha.invalid/// "), "https://brokerAlpha.invalid");
  assert.equal(normalizeUrl("https://brokerBeta.invalid"), "https://brokerBeta.invalid");
  assert.equal(normalizeUrl(""), "");
  assert.equal(normalizeUrl(undefined), undefined);
});
