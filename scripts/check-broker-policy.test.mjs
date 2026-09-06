import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { BROKER_POLICY_SCHEMA, RULE_FIELDS, validatePolicyDocument } from "./check-broker-policy.mjs";
import {
  applyPolicySync,
  formatDeploymentReport,
  formatSyncReport,
  inspectPolicyDeployment,
} from "./lib/broker-policy-deployment.mjs";

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

// ---------------------------------------------------------------------------
// #2064: repo document <-> live broker document drift + deployment path.
//
// The drift these tests encode really happened: for two months the committed
// document said mode "warn" while one live broker ran mode "enforce", with
// byte-identical rules. Every repo-side check was green throughout, because
// nothing compared the two files. The mode-only case is therefore the headline
// regression test, not an edge case.
// ---------------------------------------------------------------------------

function fakeFs(files) {
  const store = new Map(Object.entries(files));
  return {
    store,
    readFileSync(target) {
      if (!store.has(target)) {
        const err = new Error(`ENOENT: no such file or directory, open '${target}'`);
        err.code = "ENOENT";
        throw err;
      }
      return store.get(target);
    },
    writeFileSync(target, text) {
      store.set(target, text);
    },
    copyFileSync(from, to) {
      store.set(to, store.get(from));
    },
  };
}

const CANON = "docs/ops/broker-policy.json";
const LIVE = "/var/lib/a2a-broker/broker-policy.json";

function policyText(overrides = {}, space = 2) {
  return JSON.stringify(
    {
      schemaVersion: BROKER_POLICY_SCHEMA,
      mode: "warn",
      defaultAction: "allow",
      rules: [{ id: "mobile-analyze-only", workerClass: "mobile", denyModes: ["patch"] }],
      ...overrides,
    },
    null,
    space,
  );
}

function inspect(files) {
  const impl = fakeFs(files);
  return inspectPolicyDeployment({
    canonicalPath: CANON,
    livePath: LIVE,
    readFile: (target) => impl.readFileSync(target),
    validate: validatePolicyDocument,
  });
}

test("#2064 mode-only drift fails and names the live mode", () => {
  const result = inspect({ [CANON]: policyText(), [LIVE]: policyText({ mode: "enforce" }) });
  assert.equal(result.status, "drift");
  assert.deepEqual(result.differences, [{ path: "mode", canonical: "warn", live: "enforce" }]);
  const report = formatDeploymentReport(result).join("\n");
  assert.match(report, /mode: canonical="warn" live="enforce"/);
  assert.match(report, /the live broker is running in 'enforce'/);
});

test("#2064 rule-body drift is reported per field path", () => {
  const drifted = policyText({
    rules: [{ id: "mobile-analyze-only", workerClass: "mobile", denyModes: ["patch", "github-propose-patch"] }],
  });
  const result = inspect({ [CANON]: policyText(), [LIVE]: drifted });
  assert.equal(result.status, "drift");
  assert.deepEqual(result.differences, [
    { path: "rules[0].denyModes[1]", canonical: undefined, live: "github-propose-patch" },
  ]);
});

test("#2064 rule ORDER is drift — matching is first-match-wins", () => {
  const rules = [
    { id: "a-rule", workerClass: "mobile" },
    { id: "b-rule", workerClass: "vps" },
  ];
  const result = inspect({
    [CANON]: policyText({ rules }),
    [LIVE]: policyText({ rules: [rules[1], rules[0]] }),
  });
  assert.equal(result.status, "drift");
});

test("#2064 formatting-only differences pass with a note, key order included", () => {
  const reordered = JSON.stringify(
    {
      rules: [{ workerClass: "mobile", denyModes: ["patch"], id: "mobile-analyze-only" }],
      defaultAction: "allow",
      mode: "warn",
      schemaVersion: BROKER_POLICY_SCHEMA,
    },
    null,
    4,
  );
  const result = inspect({ [CANON]: policyText(), [LIVE]: reordered });
  assert.equal(result.status, "ok");
  assert.equal(result.formattingOnly, true);
  assert.match(formatDeploymentReport(result).join("\n"), /semantically identical but not byte-identical/);
});

test("#2064 an identical live document passes with no note", () => {
  const result = inspect({ [CANON]: policyText(), [LIVE]: policyText() });
  assert.equal(result.status, "ok");
  assert.equal(result.byteEqual, true);
  assert.equal(result.formattingOnly, false);
});

test("#2064 a missing or unparseable live document fails closed, never 'assumed equal'", () => {
  assert.equal(inspect({ [CANON]: policyText() }).status, "unreadable");
  assert.equal(inspect({ [CANON]: policyText(), [LIVE]: "{ not json" }).status, "unreadable");
});

test("#2064 an invalid canonical document is reported before any comparison", () => {
  const result = inspect({ [CANON]: policyText({ mode: "sometimes" }), [LIVE]: policyText() });
  assert.equal(result.status, "invalid");
  assert.match(result.violations.join(";"), /mode must be one of/);
});

test("#2064 sync is dry-run by default and writes nothing", () => {
  const impl = fakeFs({ [CANON]: policyText(), [LIVE]: policyText({ mode: "enforce" }) });
  const result = applyPolicySync({
    canonicalPath: CANON,
    livePath: LIVE,
    fsImpl: impl,
    validate: validatePolicyDocument,
  });
  assert.equal(result.status, "dry-run");
  assert.equal(result.applied, false);
  assert.equal(JSON.parse(impl.store.get(LIVE)).mode, "enforce", "dry-run must not touch the live file");
  assert.equal(impl.store.size, 2, "dry-run must not create a backup either");
  assert.match(formatSyncReport(result).join("\n"), /Re-run with --apply/);
});

test("#2064 sync --apply backs up, writes, and verifies without restarting", () => {
  const impl = fakeFs({ [CANON]: policyText(), [LIVE]: policyText({ mode: "enforce" }) });
  const result = applyPolicySync({
    canonicalPath: CANON,
    livePath: LIVE,
    apply: true,
    now: new Date("2026-09-06T12:00:00.000Z"),
    fsImpl: impl,
    validate: validatePolicyDocument,
  });
  assert.equal(result.status, "applied");
  assert.equal(result.verified, true);
  assert.equal(result.restartRequired, true);
  assert.equal(impl.store.get(LIVE), policyText());
  assert.equal(JSON.parse(impl.store.get(`${LIVE}.bak-20260906T120000Z`)).mode, "enforce");
  const report = formatSyncReport(result).join("\n");
  assert.match(report, /RESTART REQUIRED — not performed by this command/);
});

test("#2064 sync refuses to deploy an invalid canonical document", () => {
  const impl = fakeFs({ [CANON]: policyText({ mode: "sometimes" }), [LIVE]: policyText() });
  const result = applyPolicySync({
    canonicalPath: CANON,
    livePath: LIVE,
    apply: true,
    fsImpl: impl,
    validate: validatePolicyDocument,
  });
  assert.equal(result.refused, true);
  assert.equal(result.applied, false);
  assert.equal(impl.store.get(LIVE), policyText(), "an invalid document must never reach a broker");
});

test("#2064 sync --apply on an already-matching live document writes nothing", () => {
  const impl = fakeFs({ [CANON]: policyText(), [LIVE]: policyText() });
  const result = applyPolicySync({
    canonicalPath: CANON,
    livePath: LIVE,
    apply: true,
    fsImpl: impl,
    validate: validatePolicyDocument,
  });
  assert.equal(result.status, "unchanged");
  assert.equal(result.restartRequired, false);
  assert.equal(impl.store.size, 2);
});

test("#2064 sync creates an absent live document without a backup", () => {
  const impl = fakeFs({ [CANON]: policyText() });
  const result = applyPolicySync({
    canonicalPath: CANON,
    livePath: LIVE,
    apply: true,
    fsImpl: impl,
    validate: validatePolicyDocument,
  });
  assert.equal(result.status, "applied");
  assert.equal(result.backupPath, null);
  assert.equal(impl.store.get(LIVE), policyText());
});

// The contract must keep documenting the deployment path; the absence of that
// documentation is the stated root cause of #2064.
test("#2064 the contract documents how the committed document reaches a broker", () => {
  const contract = readFileSync(new URL("../contracts/a2a/broker-policy.md", import.meta.url), "utf8");
  assert.match(contract, /check-broker-policy\.mjs drift/);
  assert.match(contract, /check-broker-policy\.mjs sync/);
  assert.match(contract, /--apply/);
});
