import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveNodeRouting,
  validateRegistry,
  validateFleetRouting,
  TEAM_BROKER_INVARIANT,
} from "./a2a-broker-id-routing.mjs";

const registry = {
  brokers: {
    seoseo: { teamId: "team1", url: "https://seoseo.invalid" },
    gwakga: { teamId: "team2", url: "https://gwakga.invalid" },
  },
};

test("canonical invariant maps team1→seoseo and team2→gwakga", () => {
  assert.deepEqual(TEAM_BROKER_INVARIANT, { team1: "seoseo", team2: "gwakga" });
});

test("derives BROKER_URL from home broker id when none is declared", () => {
  const r = resolveNodeRouting({ node: "dungae", teamId: "team2", homeBrokerId: "gwakga" }, registry);
  assert.equal(r.ok, true);
  assert.equal(r.resolvedUrl, "https://gwakga.invalid");
  assert.equal(r.source, "derived");
});

test("accepts a declared URL that agrees with the id-derived URL", () => {
  const r = resolveNodeRouting(
    { node: "sogyo", teamId: "team1", homeBrokerId: "seoseo", brokerUrl: "https://seoseo.invalid/" },
    registry,
  );
  assert.equal(r.ok, true);
  assert.equal(r.source, "declared");
  assert.equal(r.resolvedUrl, "https://seoseo.invalid");
});

test("flags a declared URL that disagrees with the home broker id (the #633 incident)", () => {
  // team2 node still names gwakga as home, but its BROKER_URL was overwritten to seoseo's.
  const r = resolveNodeRouting(
    { node: "soonwook", teamId: "team2", homeBrokerId: "gwakga", brokerUrl: "https://seoseo.invalid" },
    registry,
  );
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.code === "url_id_disagreement"));
});

test("flags a team↔broker-id mismatch", () => {
  const r = resolveNodeRouting({ node: "jingun", teamId: "team2", homeBrokerId: "seoseo" }, registry);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.code === "team_broker_mismatch"));
});

test("flags an unknown broker id and missing primary key (fail-closed)", () => {
  const unknown = resolveNodeRouting({ node: "x", teamId: "team1", homeBrokerId: "nope" }, registry);
  assert.ok(unknown.violations.some((v) => v.code === "broker_id_unknown"));

  const missing = resolveNodeRouting({ node: "y", teamId: "team1", brokerUrl: "https://seoseo.invalid" }, registry);
  assert.ok(missing.violations.some((v) => v.code === "missing_routing_keys"));
});

test("validateRegistry rejects a broker mapped to the wrong team", () => {
  const bad = { brokers: { seoseo: { teamId: "team2", url: "https://x" } } };
  const errors = validateRegistry(bad);
  assert.ok(errors.some((e) => /must route to 'gwakga'/.test(e)));
  assert.deepEqual(validateRegistry(registry), []);
});

test("validateFleetRouting aggregates a clean fleet and a violating fleet", () => {
  const clean = validateFleetRouting(
    [
      { node: "sogyo", teamId: "team1", homeBrokerId: "seoseo" },
      { node: "dungae", teamId: "team2", homeBrokerId: "gwakga" },
    ],
    registry,
  );
  assert.equal(clean.ok, true);
  assert.equal(clean.violations.length, 0);

  const dirty = validateFleetRouting(
    [{ node: "soonwook", teamId: "team2", homeBrokerId: "gwakga", brokerUrl: "https://seoseo.invalid" }],
    registry,
  );
  assert.equal(dirty.ok, false);
  assert.equal(dirty.violations.length, 1);
});
