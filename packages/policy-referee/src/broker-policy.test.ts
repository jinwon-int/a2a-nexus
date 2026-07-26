import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BROKER_POLICY_SCHEMA,
  deriveTaskWorkerClass,
  evaluateTaskPolicy,
  validateBrokerPolicyDocument,
  type BrokerPolicyDocument,
} from "./broker-policy.js";

function doc(overrides: Partial<BrokerPolicyDocument> = {}): BrokerPolicyDocument {
  return validateBrokerPolicyDocument({
    schemaVersion: BROKER_POLICY_SCHEMA,
    mode: "warn",
    defaultAction: "allow",
    rules: [],
    ...overrides,
  });
}

function operatorPolicyDoc(): BrokerPolicyDocument {
  const path = new URL("../../../docs/ops/broker-policy.json", import.meta.url);
  return validateBrokerPolicyDocument(JSON.parse(readFileSync(path, "utf8")), path.pathname);
}

// --- validation gate (G1-a): fail-closed ---

test("a valid document with a full rule validates", () => {
  const d = doc({
    rules: [{
      id: "mobile-analyze-only",
      workerClass: "mobile",
      allowIntents: ["analyze"],
      denyModes: ["apply"],
      requireApproval: false,
      maxTasksPerDay: 10,
    }],
  });
  assert.equal(d.rules.length, 1);
});

test("unknown top-level and rule fields fail closed", () => {
  assert.throws(() => doc({ extra: true } as never), /unknown field 'extra'/);
  assert.throws(
    () => doc({ rules: [{ id: "r-1", workerClass: "*", denyIntents: ["x"] }] } as never),
    /unknown field 'denyIntents'/,
  );
});

test("duplicate rule ids are rejected", () => {
  assert.throws(
    () => doc({ rules: [{ id: "dup", workerClass: "vps" }, { id: "dup", workerClass: "mobile" }] }),
    /duplicate rule id 'dup'/,
  );
});

test("a worker-name-shaped workerClass is rejected (anonymous class axis only)", () => {
  assert.throws(
    () => doc({ rules: [{ id: "r-1", workerClass: "some-worker-name" }] }),
    /worker names are rejected/,
  );
});

test("bad mode, defaultAction, schema, and budget values are rejected", () => {
  assert.throws(() => doc({ mode: "sometimes" } as never), /mode must be one of/);
  assert.throws(() => doc({ defaultAction: "maybe" } as never), /defaultAction must be one of/);
  assert.throws(() => doc({ schemaVersion: "v0" } as never), /schemaVersion/);
  assert.throws(
    () => doc({ rules: [{ id: "r-1", workerClass: "*", maxTasksPerDay: 0 }] }),
    /positive integer/,
  );
});

// --- worker class derivation ---

test("deriveTaskWorkerClass mirrors the stats classes", () => {
  assert.equal(deriveTaskWorkerClass({ sourceOnly: true, workerFound: true, workerMode: "mobile" }), "source-only");
  assert.equal(deriveTaskWorkerClass({ payloadMode: "source-only", workerFound: false }), "source-only");
  assert.equal(deriveTaskWorkerClass({ workerFound: false }), "unclassified");
  assert.equal(deriveTaskWorkerClass({ workerFound: true, workerMode: "mobile" }), "mobile");
  assert.equal(deriveTaskWorkerClass({ workerFound: true, workerMode: "persistent" }), "vps");
});

// --- evaluation engine (G1-b): the six G1-c paths ---

test("path 1 — allow: intent inside allowIntents", () => {
  const d = doc({ rules: [{ id: "r-1", workerClass: "mobile", allowIntents: ["analyze"] }] });
  const r = evaluateTaskPolicy({ intent: "analyze", workerClass: "mobile" }, d);
  assert.deepEqual(r, { action: "allow", ruleId: "r-1" });
});

test("path 2 — deny: intent outside allowIntents, and denyModes match", () => {
  const d = doc({ rules: [{ id: "r-1", workerClass: "mobile", allowIntents: ["analyze"], denyModes: ["apply"] }] });
  const denyIntent = evaluateTaskPolicy({ intent: "apply_local_change", workerClass: "mobile" }, d);
  assert.equal(denyIntent.action, "deny");
  assert.equal(denyIntent.ruleId, "r-1");
  const denyMode = evaluateTaskPolicy({ intent: "analyze", mode: "apply", workerClass: "mobile" }, d);
  assert.equal(denyMode.action, "deny");
  assert.match((denyMode as { reason: string }).reason, /mode 'apply' is denied/);
});

test("path 3 — requireApproval routes to the approval state", () => {
  const d = doc({ rules: [{ id: "r-1", workerClass: "vps", requireApproval: true }] });
  const r = evaluateTaskPolicy({ intent: "analyze", workerClass: "vps" }, d);
  assert.equal(r.action, "require_approval");
  assert.equal(r.ruleId, "r-1");
});

test("path 4 — budget exhaustion denies at the cap and allows under it", () => {
  const d = doc({ rules: [{ id: "r-1", workerClass: "mobile", maxTasksPerDay: 2 }] });
  const under = evaluateTaskPolicy({ intent: "analyze", workerClass: "mobile", countTasksToday: () => 1 }, d);
  assert.equal(under.action, "allow");
  const at = evaluateTaskPolicy({ intent: "analyze", workerClass: "mobile", countTasksToday: () => 2 }, d);
  assert.equal(at.action, "deny");
  assert.match((at as { reason: string }).reason, /budget exhausted .*\(2\/2\)/);
});

test("path 5 — unclassified worker matches its own class and the wildcard", () => {
  const wildcardDeny = doc({ rules: [{ id: "r-1", workerClass: "*", allowIntents: ["analyze"] }] });
  const denied = evaluateTaskPolicy({ intent: "deploy", workerClass: "unclassified" }, wildcardDeny);
  assert.equal(denied.action, "deny");
  const exact = doc({ rules: [{ id: "r-1", workerClass: "unclassified", requireApproval: true }] });
  const gated = evaluateTaskPolicy({ intent: "analyze", workerClass: "unclassified" }, exact);
  assert.equal(gated.action, "require_approval");
});

test("path 6 — no matching rule falls through to defaultAction", () => {
  const allowDefault = doc({ rules: [{ id: "r-1", workerClass: "mobile", allowIntents: [] }] });
  assert.deepEqual(evaluateTaskPolicy({ intent: "x", workerClass: "vps" }, allowDefault), { action: "allow" });
  const denyDefault = doc({ defaultAction: "deny", rules: [] });
  const r = evaluateTaskPolicy({ intent: "x", workerClass: "vps" }, denyDefault);
  assert.equal(r.action, "deny");
  assert.equal(r.ruleId, "default");
});

test("first matching rule wins in document order", () => {
  const d = doc({
    rules: [
      { id: "wild", workerClass: "*", requireApproval: true },
      { id: "mobile", workerClass: "mobile", allowIntents: ["analyze"] },
    ],
  });
  // wildcard listed first shadows the class-specific rule
  const r = evaluateTaskPolicy({ intent: "analyze", workerClass: "mobile" }, d);
  assert.equal(r.ruleId, "wild");
});

test("budget counter is only consulted when the rule declares a budget", () => {
  const d = doc({ rules: [{ id: "r-1", workerClass: "mobile" }] });
  let called = 0;
  evaluateTaskPolicy({ intent: "analyze", workerClass: "mobile", countTasksToday: () => { called += 1; return 0; } }, d);
  assert.equal(called, 0, "no maxTasksPerDay -> counter thunk must not run");
});

test("operator source-only rule allows observed read-only and local proposal workflows (#1355)", () => {
  const policy = operatorPolicyDoc();

  assert.deepEqual(
    evaluateTaskPolicy({ intent: "verify", mode: "github-read-only-validation", workerClass: "source-only" }, policy),
    { action: "allow", ruleId: "source-only-safe-intents" },
  );
  assert.deepEqual(
    evaluateTaskPolicy({ intent: "propose_patch", mode: "propose-patch", workerClass: "source-only" }, policy),
    { action: "allow", ruleId: "source-only-safe-intents" },
  );
  assert.deepEqual(
    evaluateTaskPolicy({ intent: "analyze", mode: "analysis-only", workerClass: "source-only" }, policy),
    { action: "allow", ruleId: "source-only-safe-intents" },
  );
});

test("operator source-only rule still denies GitHub-write and generic patch modes (#1355)", () => {
  const policy = operatorPolicyDoc();

  for (const mode of ["github-propose-patch", "patch"]) {
    const decision = evaluateTaskPolicy({ intent: "propose_patch", mode, workerClass: "source-only" }, policy);
    assert.equal(decision.action, "deny", mode);
    assert.equal(decision.ruleId, "source-only-safe-intents", mode);
  }
});

test("requireImplementationCapability must be a boolean (#1597)", () => {
  assert.throws(
    () => doc({ rules: [{ id: "r-1", workerClass: "*", requireImplementationCapability: "yes" as never }] }),
    /requireImplementationCapability must be a boolean/,
  );
});

test("requireImplementationCapability is an accepted rule field (#1597)", () => {
  const policy = doc({ rules: [{ id: "impl-gate", workerClass: "*", requireImplementationCapability: true }] });
  assert.equal(policy.rules[0]?.requireImplementationCapability, true);
});

test("implementation intent is denied when the worker is not implementation-ready (#1597)", () => {
  const policy = doc({ rules: [{ id: "impl-gate", workerClass: "*", requireImplementationCapability: true }] });

  const decision = evaluateTaskPolicy({
    intent: "propose_patch",
    workerClass: "mobile",
    evaluationPoint: "claim",
    implementation: {
      isImplementationIntent: true,
      ready: false,
      blockers: "implementation availability is \'configured\', not \'canary_passed\'",
    },
  }, policy);

  assert.equal(decision.action, "deny");
  assert.equal(decision.ruleId, "impl-gate");
  assert.match(decision.reason ?? "", /requires a verified implementation capability/);
  assert.match(decision.reason ?? "", /not \'canary_passed\'/);
});

test("omitting the readiness input at claim time fails closed (#1597)", () => {
  const policy = doc({ rules: [{ id: "impl-gate", workerClass: "*", requireImplementationCapability: true }] });

  const decision = evaluateTaskPolicy({
    intent: "apply_local_change",
    workerClass: "vps",
    evaluationPoint: "claim",
  }, policy);

  assert.equal(decision.action, "deny");
  assert.match(decision.reason ?? "", /readiness was not evaluated/);
});

test("omitting evaluationPoint entirely still fails closed (#1597)", () => {
  // A refactor that drops the readiness plumbing must deny, never silently
  // disable the gate. Only an explicit evaluationPoint "create" opts out.
  const policy = doc({ rules: [{ id: "impl-gate", workerClass: "*", requireImplementationCapability: true }] });

  const decision = evaluateTaskPolicy({ intent: "propose_patch", workerClass: "vps" }, policy);

  assert.equal(decision.action, "deny");
  assert.match(decision.reason ?? "", /readiness was not evaluated/);
});

test("create-time evaluation opts out of the claim-time gate (#1597)", () => {
  const policy = doc({ rules: [{ id: "impl-gate", workerClass: "*", requireImplementationCapability: true }] });

  assert.deepEqual(
    evaluateTaskPolicy({ intent: "propose_patch", workerClass: "vps", evaluationPoint: "create" }, policy),
    { action: "allow", ruleId: "impl-gate" },
  );
});

test("implementation gate allows a ready worker and ignores other intents (#1597)", () => {
  const policy = doc({ rules: [{ id: "impl-gate", workerClass: "*", requireImplementationCapability: true }] });

  assert.deepEqual(
    evaluateTaskPolicy({
      intent: "propose_patch",
      workerClass: "vps",
      evaluationPoint: "claim",
      implementation: { isImplementationIntent: true, ready: true },
    }, policy),
    { action: "allow", ruleId: "impl-gate" },
  );

  assert.deepEqual(
    evaluateTaskPolicy({
      intent: "analyze",
      workerClass: "mobile",
      evaluationPoint: "claim",
      implementation: { isImplementationIntent: false, ready: false },
    }, policy),
    { action: "allow", ruleId: "impl-gate" },
  );
});

test("implementation gate is opt-in: rules without it are unchanged (#1597)", () => {
  const policy = doc({ rules: [{ id: "legacy", workerClass: "*" }] });

  assert.deepEqual(
    evaluateTaskPolicy({
      intent: "propose_patch",
      workerClass: "mobile",
      evaluationPoint: "claim",
      implementation: { isImplementationIntent: true, ready: false, blockers: "not declared" },
    }, policy),
    { action: "allow", ruleId: "legacy" },
  );

  assert.deepEqual(
    evaluateTaskPolicy({
      intent: "propose_patch",
      workerClass: "mobile",
      evaluationPoint: "claim",
      implementation: { isImplementationIntent: true, ready: false },
    }, doc({ rules: [{ id: "explicit-false", workerClass: "*", requireImplementationCapability: false }] })),
    { action: "allow", ruleId: "explicit-false" },
  );
});

test("denyModes and allowIntents still win over the implementation gate (#1597)", () => {
  const policy = doc({
    rules: [{
      id: "impl-gate",
      workerClass: "*",
      denyModes: ["apply"],
      allowIntents: ["propose_patch"],
      requireImplementationCapability: true,
    }],
  });

  const byMode = evaluateTaskPolicy({
    intent: "propose_patch",
    mode: "apply",
    workerClass: "vps",
    evaluationPoint: "claim",
    implementation: { isImplementationIntent: true, ready: true },
  }, policy);
  assert.equal(byMode.action, "deny");
  assert.match(byMode.reason ?? "", /mode \'apply\' is denied/);

  const byIntent = evaluateTaskPolicy({
    intent: "analyze",
    workerClass: "vps",
    evaluationPoint: "claim",
    implementation: { isImplementationIntent: false, ready: false },
  }, policy);
  assert.equal(byIntent.action, "deny");
  assert.match(byIntent.reason ?? "", /is not allowed/);
});

test("a class-specific rule listed first shadows a later wildcard gate (#1597)", () => {
  const policy = doc({
    rules: [
      { id: "mobile-open", workerClass: "mobile" },
      { id: "impl-gate", workerClass: "*", requireImplementationCapability: true },
    ],
  });

  assert.deepEqual(
    evaluateTaskPolicy({
      intent: "propose_patch",
      workerClass: "mobile",
      evaluationPoint: "claim",
      implementation: { isImplementationIntent: true, ready: false },
    }, policy),
    { action: "allow", ruleId: "mobile-open" },
  );
});
