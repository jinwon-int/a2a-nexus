import test from "node:test";
import assert from "node:assert/strict";

import { TEAM_BROKER_INVARIANT, hasText, normalizeUrl } from "./a2a-routing-shared.mjs";

test("TEAM_BROKER_INVARIANT maps team1→seoseo and team2→gwakga", () => {
  assert.deepEqual(TEAM_BROKER_INVARIANT, { team1: "seoseo", team2: "gwakga" });
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
  assert.equal(normalizeUrl(" https://seoseo.invalid/// "), "https://seoseo.invalid");
  assert.equal(normalizeUrl("https://gwakga.invalid"), "https://gwakga.invalid");
  assert.equal(normalizeUrl(""), "");
  assert.equal(normalizeUrl(undefined), undefined);
});
