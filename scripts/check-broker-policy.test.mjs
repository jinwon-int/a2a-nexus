import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BROKER_POLICY_SCHEMA, RULE_FIELDS, validatePolicyDocument } from "./check-broker-policy.mjs";

function doc(overrides = {}) {
  return {
    schemaVersion: BROKER_POLICY_SCHEMA,
    mode: "warn",
    defaultAction: "allow",
    rules: [],
    ...overrides,
  };
}

test("the committed v1 shape validates", () => {
  assert.deepEqual(validatePolicyDocument(doc()), []);
  assert.deepEqual(
    validatePolicyDocument(doc({
      mode: "enforce",
      rules: [{ id: "mobile-analyze-only", workerClass: "mobile", allowIntents: ["analyze"], maxTasksPerDay: 10 }],
    })),
    [],
  );
});

test("unknown fields fail closed at both levels", () => {
  assert.match(validatePolicyDocument(doc({ extra: 1 })).join(";"), /unknown field 'extra'/);
  assert.match(
    validatePolicyDocument(doc({ rules: [{ id: "r-1", workerClass: "*", denyIntents: ["x"] }] })).join(";"),
    /unknown field 'denyIntents'/,
  );
});

test("duplicate rule ids and worker-name-shaped classes are rejected", () => {
  assert.match(
    validatePolicyDocument(doc({ rules: [{ id: "dup", workerClass: "vps" }, { id: "dup", workerClass: "mobile" }] })).join(";"),
    /duplicate rule id 'dup'/,
  );
  assert.match(
    validatePolicyDocument(doc({ rules: [{ id: "r-1", workerClass: "some-worker-name" }] })).join(";"),
    /worker names are rejected/,
  );
});

test("mode, defaultAction, and budget bounds are validated", () => {
  assert.match(validatePolicyDocument(doc({ mode: "sometimes" })).join(";"), /mode must be one of/);
  assert.match(validatePolicyDocument(doc({ defaultAction: "maybe" })).join(";"), /defaultAction must be one of/);
  assert.match(
    validatePolicyDocument(doc({ rules: [{ id: "r-1", workerClass: "*", maxTasksPerDay: 0 }] })).join(";"),
    /positive integer/,
  );
});

// #1597: this standalone gate and the TS validator each keep their own
// fail-closed RULE_FIELDS set. A field added to only one of them makes the
// other reject every document that uses it — which is exactly how
// requireImplementationCapability first shipped: the TS validator accepted it
// while this gate failed the release with "unknown field (fail-closed)".
// Parse the TS source textually so the check needs no build step, matching this
// gate's "no broker build needed" contract.
test("RULE_FIELDS stays in lockstep with the TS validator (#1597)", () => {
  const tsPath = new URL("../packages/policy-referee/src/broker-policy.ts", import.meta.url);
  const source = readFileSync(tsPath, "utf8");

  const match = source.match(/const RULE_FIELDS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(match, "could not locate RULE_FIELDS in broker-policy.ts");

  const tsFields = new Set(
    [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]),
  );

  assert.ok(tsFields.size > 0, "parsed an empty TS RULE_FIELDS set");
  assert.deepEqual(
    [...tsFields].sort(),
    [...RULE_FIELDS].sort(),
    "check-broker-policy.mjs RULE_FIELDS and broker-policy.ts RULE_FIELDS diverged",
  );
});

test("requireImplementationCapability is accepted and type-checked (#1597)", () => {
  assert.deepEqual(
    validatePolicyDocument(doc({
      rules: [{ id: "impl-gate", workerClass: "*", requireImplementationCapability: true }],
    })),
    [],
  );

  assert.deepEqual(
    validatePolicyDocument(doc({
      rules: [{ id: "impl-gate", workerClass: "*", requireImplementationCapability: "yes" }],
    })),
    ["rules[0].requireImplementationCapability must be a boolean"],
  );
});
