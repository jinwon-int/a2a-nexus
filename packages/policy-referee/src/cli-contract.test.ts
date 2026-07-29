import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  POLICY_REFEREE_ERROR_SCHEMA,
  POLICY_REFEREE_EXIT,
  PolicyRefereeInputError,
  evaluatePolicyRefereeCli,
  parsePolicyRefereePolicyDocument,
  parsePolicyRefereeTaskEnvelope,
  parsePolicyRefereeWorkerEnvelope,
  projectPolicyRefereeDecision,
  type PolicyRefereeDecisionEnvelope,
  type PolicyRefereeErrorCode,
  type PolicyRefereeInputKind,
} from "./cli-contract.js";

interface GoldenFixture {
  id: string;
  policy: unknown;
  task: unknown;
  worker: unknown;
  expected: {
    decision: PolicyRefereeDecisionEnvelope;
    exitCode: number;
  };
}

interface GoldenManifest {
  schemaVersion: string;
  cases: GoldenFixture[];
}

interface NegativeFixture {
  id: string;
  input: "policy" | "task" | "worker";
  value?: unknown;
  raw?: string;
  expected: {
    code: PolicyRefereeErrorCode;
    input: PolicyRefereeInputKind;
    path: string;
  };
}

interface NegativeManifest {
  schemaVersion: string;
  cases: NegativeFixture[];
}

const goldenManifest = JSON.parse(
  readFileSync(new URL("../fixtures/golden/manifest.json", import.meta.url), "utf8"),
) as GoldenManifest;
const negativeManifest = JSON.parse(
  readFileSync(new URL("../fixtures/negative/manifest.json", import.meta.url), "utf8"),
) as NegativeManifest;
const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));

function assertInputError(
  operation: () => unknown,
  expected: NegativeFixture["expected"],
): void {
  assert.throws(operation, (error: unknown) => {
    assert.equal(error instanceof PolicyRefereeInputError, true);
    const inputError = error as PolicyRefereeInputError;
    assert.deepEqual(
      { code: inputError.code, input: inputError.input, path: inputError.path },
      expected,
    );
    return true;
  });
}

function parseNegativeFixture(fixture: NegativeFixture): unknown {
  if (fixture.input === "policy") return parsePolicyRefereePolicyDocument(fixture.value);
  if (fixture.input === "task") return parsePolicyRefereeTaskEnvelope(fixture.value);
  return parsePolicyRefereeWorkerEnvelope(fixture.value);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

test("golden fixture manifest covers the bounded public decision surface", () => {
  assert.equal(goldenManifest.schemaVersion, "a2a.policy-referee.golden-fixtures.v1");
  assert.equal(goldenManifest.cases.length, 9);
  assert.deepEqual(
    goldenManifest.cases.map((fixture) => fixture.id),
    [
      "matched-allow",
      "allow-intent-deny",
      "deny-mode-precedence",
      "require-approval",
      "daily-budget-boundary",
      "claim-readiness-missing",
      "claim-capability-unready",
      "create-time-capability-opt-out",
      "default-deny",
    ],
  );
});

test("pure parsers and evaluator reproduce every golden decision and exit", () => {
  for (const fixture of goldenManifest.cases) {
    const result = evaluatePolicyRefereeCli(
      parsePolicyRefereePolicyDocument(fixture.policy),
      parsePolicyRefereeTaskEnvelope(fixture.task),
      parsePolicyRefereeWorkerEnvelope(fixture.worker),
    );
    assert.deepEqual(result, {
      decision: fixture.expected.decision,
      exitCode: fixture.expected.exitCode,
    }, fixture.id);
  }
});

test("negative fixture manifest rejects closed-envelope and public-safety violations", () => {
  assert.equal(negativeManifest.schemaVersion, "a2a.policy-referee.negative-fixtures.v1");
  for (const fixture of negativeManifest.cases) {
    if (fixture.raw !== undefined) continue;
    assertInputError(() => parseNegativeFixture(fixture), fixture.expected);
  }
});

test("pure parsers reject non-plain, accessor, sparse, and inherited objects", () => {
  const inherited = Object.assign(Object.create({ workerClass: "vps" }) as object, {
    schemaVersion: "a2a.policy-referee.worker.v1",
  });
  assertInputError(
    () => parsePolicyRefereeWorkerEnvelope(inherited),
    { code: "non_plain_object", input: "worker", path: "$" },
  );

  const accessor = {
    schemaVersion: "a2a.policy-referee.task.v1",
    get intent(): string {
      return "analyze";
    },
    evaluationPoint: "create",
  };
  assertInputError(
    () => parsePolicyRefereeTaskEnvelope(accessor),
    { code: "non_plain_object", input: "task", path: "$" },
  );

  const sparse = new Array(2);
  assertInputError(
    () => parsePolicyRefereePolicyDocument(sparse),
    { code: "invalid_structure", input: "policy", path: "$" },
  );

  assertInputError(
    () => parsePolicyRefereeTaskEnvelope(new Date()),
    { code: "non_plain_object", input: "task", path: "$" },
  );
});

test("tasksToday is required exactly when the evaluator invokes its lazy counter", () => {
  const worker = parsePolicyRefereeWorkerEnvelope({
    schemaVersion: "a2a.policy-referee.worker.v1",
    workerClass: "mobile",
  });
  const budgetPolicy = parsePolicyRefereePolicyDocument({
    schemaVersion: "a2a.broker.policy.v1",
    mode: "warn",
    defaultAction: "allow",
    rules: [{ id: "budget", workerClass: "mobile", maxTasksPerDay: 2 }],
  });
  const noBudgetPolicy = parsePolicyRefereePolicyDocument({
    schemaVersion: "a2a.broker.policy.v1",
    mode: "warn",
    defaultAction: "allow",
    rules: [{ id: "open", workerClass: "mobile" }],
  });

  assertInputError(
    () => evaluatePolicyRefereeCli(
      budgetPolicy,
      parsePolicyRefereeTaskEnvelope({
        schemaVersion: "a2a.policy-referee.task.v1",
        intent: "analyze",
        evaluationPoint: "create",
      }),
      worker,
    ),
    { code: "required_field", input: "task", path: "$.tasksToday" },
  );
  assertInputError(
    () => evaluatePolicyRefereeCli(
      noBudgetPolicy,
      parsePolicyRefereeTaskEnvelope({
        schemaVersion: "a2a.policy-referee.task.v1",
        intent: "analyze",
        evaluationPoint: "create",
        tasksToday: 0,
      }),
      worker,
    ),
    { code: "unexpected_field", input: "task", path: "$.tasksToday" },
  );
});

test("task parser rejects negative, fractional, over-bound, and unsafe counts", () => {
  for (const tasksToday of [-1, 0.5, 1_000_001, Number.MAX_SAFE_INTEGER + 1]) {
    assertInputError(
      () => parsePolicyRefereeTaskEnvelope({
        schemaVersion: "a2a.policy-referee.task.v1",
        intent: "analyze",
        evaluationPoint: "create",
        tasksToday,
      }),
      { code: "invalid_integer", input: "task", path: "$.tasksToday" },
    );
  }
});

test("decision projection classifies evaluator precedence without reflecting reasons", () => {
  const marker = "do-not-reflect-marker";
  const projected = projectPolicyRefereeDecision("warn", {
    action: "deny",
    ruleId: "safe-rule",
    reason: `mode '${marker}' is denied for worker class 'mobile'`,
  });
  assert.deepEqual(projected, {
    schemaVersion: "a2a.policy-referee.decision.v1",
    policyMode: "warn",
    action: "deny",
    ruleId: "safe-rule",
    reasonCode: "mode_denied",
    enforceMode: { deny: true, requireApproval: false },
  });
  assert.equal(JSON.stringify(projected).includes(marker), false);

  const precedence = goldenManifest.cases.find((fixture) => fixture.id === "deny-mode-precedence");
  assert.ok(precedence);
  const result = evaluatePolicyRefereeCli(
    parsePolicyRefereePolicyDocument(precedence.policy),
    parsePolicyRefereeTaskEnvelope(precedence.task),
    parsePolicyRefereeWorkerEnvelope(precedence.worker),
  );
  assert.equal(result.decision.reasonCode, "mode_denied");
});

test("built bin emits byte-stable stdout for every golden fixture", () => {
  const work = mkdtempSync(join(tmpdir(), "policy-referee-golden-"));
  try {
    for (const fixture of goldenManifest.cases) {
      const policyPath = join(work, `${fixture.id}.policy.json`);
      const taskPath = join(work, `${fixture.id}.task.json`);
      const workerPath = join(work, `${fixture.id}.worker.json`);
      writeJson(policyPath, fixture.policy);
      writeJson(taskPath, fixture.task);
      writeJson(workerPath, fixture.worker);
      const result = spawnSync(
        process.execPath,
        [cliPath, "check", policyPath, taskPath, workerPath],
        { encoding: "utf8" },
      );
      assert.equal(result.status, fixture.expected.exitCode, fixture.id);
      assert.equal(result.stdout, `${JSON.stringify(fixture.expected.decision)}\n`, fixture.id);
      assert.equal(result.stderr, "", fixture.id);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("built bin returns stable invalid exits for malformed JSON, missing files, and arguments", () => {
  const work = mkdtempSync(join(tmpdir(), "policy-referee-invalid-"));
  try {
    const policyPath = join(work, "policy.json");
    const malformedTaskPath = join(work, "task.json");
    const workerPath = join(work, "worker.json");
    writeJson(policyPath, {
      schemaVersion: "a2a.broker.policy.v1",
      mode: "warn",
      defaultAction: "allow",
      rules: [],
    });
    writeFileSync(malformedTaskPath, "{\"schemaVersion\":");
    writeJson(workerPath, {
      schemaVersion: "a2a.policy-referee.worker.v1",
      workerClass: "mobile",
    });

    const malformed = spawnSync(
      process.execPath,
      [cliPath, "check", policyPath, malformedTaskPath, workerPath],
      { encoding: "utf8" },
    );
    assert.equal(malformed.status, POLICY_REFEREE_EXIT.invalidInput);
    assert.equal(malformed.stdout, "");
    assert.equal(malformed.stderr, `${JSON.stringify({
      schemaVersion: POLICY_REFEREE_ERROR_SCHEMA,
      code: "invalid_json",
      input: "task",
      path: "$",
    })}\n`);

    const missingFile = spawnSync(
      process.execPath,
      [cliPath, "check", join(work, "absent-policy.json"), malformedTaskPath, workerPath],
      { encoding: "utf8" },
    );
    assert.equal(missingFile.status, POLICY_REFEREE_EXIT.invalidInput);
    assert.equal(missingFile.stdout, "");
    assert.equal(missingFile.stderr, `${JSON.stringify({
      schemaVersion: POLICY_REFEREE_ERROR_SCHEMA,
      code: "file_unreadable",
      input: "policy",
      path: "$",
    })}\n`);

    const missingArguments = spawnSync(process.execPath, [cliPath, "check"], { encoding: "utf8" });
    assert.equal(missingArguments.status, POLICY_REFEREE_EXIT.invalidInput);
    assert.equal(missingArguments.stdout, "");
    assert.equal(missingArguments.stderr, `${JSON.stringify({
      schemaVersion: POLICY_REFEREE_ERROR_SCHEMA,
      code: "invalid_usage",
      input: "arguments",
      path: "$",
    })}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("built bin never reflects source paths, rejected fields, or marker values", () => {
  const sourceMarker = "private-source-path-marker";
  const secretMarker = "secret-sentinel";
  const work = mkdtempSync(join(tmpdir(), `${sourceMarker}-`));
  try {
    const policyPath = join(work, `${sourceMarker}.policy.json`);
    const taskPath = join(work, `${sourceMarker}.task.json`);
    const workerPath = join(work, `${sourceMarker}.worker.json`);
    writeJson(policyPath, {
      schemaVersion: "a2a.broker.policy.v1",
      mode: "enforce",
      defaultAction: "deny",
      rules: [],
    });
    writeJson(taskPath, {
      schemaVersion: "a2a.policy-referee.task.v1",
      intent: "analyze",
      evaluationPoint: "create",
      credential: secretMarker,
    });
    writeJson(workerPath, {
      schemaVersion: "a2a.policy-referee.worker.v1",
      workerClass: "mobile",
    });

    const result = spawnSync(
      process.execPath,
      [cliPath, "check", policyPath, taskPath, workerPath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, POLICY_REFEREE_EXIT.invalidInput);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.includes(sourceMarker), false);
    assert.equal(result.stderr.includes(secretMarker), false);
    assert.equal(result.stderr.includes("credential"), false);
    assert.equal(result.stderr, `${JSON.stringify({
      schemaVersion: POLICY_REFEREE_ERROR_SCHEMA,
      code: "unknown_field",
      input: "task",
      path: "$",
    })}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("package manifest exposes the shebang-backed built bin", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { bin?: Record<string, string> };
  assert.equal(packageJson.bin?.["a2a-policy-referee"], "./dist/cli.js");
  assert.equal(readFileSync(new URL("./cli.js", import.meta.url), "utf8").startsWith("#!/usr/bin/env node"), true);
});

test("decision and failure exits are pinned and pairwise distinct", () => {
  assert.deepEqual(POLICY_REFEREE_EXIT, {
    allow: 0,
    requireApproval: 10,
    deny: 20,
    invalidInput: 64,
    internalFailure: 70,
  });
  assert.equal(new Set(Object.values(POLICY_REFEREE_EXIT)).size, 5);
});
