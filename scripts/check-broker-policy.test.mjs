import test from "node:test";
import assert from "node:assert/strict";

import { BROKER_POLICY_SCHEMA, validatePolicyDocument } from "./check-broker-policy.mjs";

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
