#!/usr/bin/env node
/**
 * release-candidate-parity-audit – deterministic, CI-safe release parity checks.
 *
 * This audit is intentionally read-only. It verifies that final release-candidate
 * evidence still covers the runner gates operators rely on before rollout:
 * type/build/test/lint gates, the pre-PR OpenClaw bootstrap guard, chaos E2E
 * evidence, and active/excluded worker rollout parity.
 *
 * Schema: a2a.runner.release-candidate-parity-audit.v1
 */

import { readFileSync } from "node:fs";

const REQUIRED_PACKAGE_SCRIPTS = ["check", "build", "lint", "test", "chaos:e2e"];
// In the monorepo, GitHub Actions never runs this package's nested
// .github/workflows/ci.yml — the docker-runner gates are executed by the root
// CI via scripts/run-monorepo-package-ci-parity.mjs. Validate that live runner
// (relative to this package dir) instead of the dead nested workflow.
const MONOREPO_PARITY_RUNNER = "../../scripts/run-monorepo-package-ci-parity.mjs";
const REQUIRED_PARITY_GATES = [
  "'check', '-w', 'packages/docker-runner'",
  "'build', '-w', 'packages/docker-runner'",
  "'lint', '-w', 'packages/docker-runner'",
  // The compiled dist test suite is executed by coverage:baseline, which runs
  // `node --test --experimental-test-coverage` over every dist/**/*.test.js and
  // fails closed on a non-zero test exit. The parity runner no longer also
  // invokes the bare `test` script, which ran the identical suite a second time.
  "'coverage:baseline', '-w', 'packages/docker-runner'",
  "pre-pr-bootstrap-guard.mjs",
  "chaos:e2e",
];
const REQUIRED_BOOTSTRAP_PATHS = [
  "AGENTS.md",
  "BOOTSTRAP.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
  "MEMORY.md",
  "SOUL.md",
  "TOOLS.md",
  "USER.md",
  ".openclaw",
  "memory",
];
const ACTIVE_WORKERS = ["workerGamma", "workerEpsilon", "workerBeta", "workerAlpha"];
const EXCLUDED_WORKERS = ["workerDelta"];

function readText(path) {
  return readFileSync(path, "utf8");
}

function packageScriptChecks(pkg) {
  return REQUIRED_PACKAGE_SCRIPTS.map((script) => ({
    id: `package-script:${script}`,
    passed: typeof pkg.scripts?.[script] === "string" && pkg.scripts[script].length > 0,
    evidence: `package.json scripts.${script}`,
  }));
}

function containsChecks(text, required, prefix, evidencePath) {
  return required.map((needle) => ({
    id: `${prefix}:${needle}`,
    passed: text.includes(needle),
    evidence: evidencePath,
  }));
}

function workerChecks(text, workers, expectation, evidencePath) {
  return workers.map((worker) => ({
    id: `${expectation}-worker:${worker}`,
    passed: text.includes(worker),
    evidence: evidencePath,
  }));
}

function main() {
  const pkg = JSON.parse(readText("package.json"));
  const parityRunner = readText(MONOREPO_PARITY_RUNNER);
  const guard = readText("scripts/pre-pr-bootstrap-guard.mjs");
  const rollout = readText("docs/release-rollout-checklist.md");

  const checks = [
    ...packageScriptChecks(pkg),
    ...containsChecks(parityRunner, REQUIRED_PARITY_GATES, "parity-gate", MONOREPO_PARITY_RUNNER),
    ...containsChecks(guard, REQUIRED_BOOTSTRAP_PATHS, "bootstrap-guard-path", "scripts/pre-pr-bootstrap-guard.mjs"),
    ...containsChecks(rollout, ["npm run chaos:e2e", "node --test dist/canary.test.js", "npm run rollout:receipt-evidence"], "rollout-gate", "docs/release-rollout-checklist.md"),
    ...workerChecks(rollout, ACTIVE_WORKERS, "active", "docs/release-rollout-checklist.md"),
    ...workerChecks(rollout, EXCLUDED_WORKERS, "excluded", "docs/release-rollout-checklist.md"),
  ];

  const failed = checks.filter((check) => !check.passed);
  const output = {
    schemaVersion: "a2a.runner.release-candidate-parity-audit.v1",
    ok: failed.length === 0,
    sourcePublicExecution: "not_performed",
    liveProviderSendPerformed: false,
    terminalAckSent: false,
    dbMutationPerformed: false,
    deployOrRestartPerformed: false,
    activeWorkers: ACTIVE_WORKERS,
    excludedWorkers: EXCLUDED_WORKERS,
    bootstrapGuardBannedPaths: REQUIRED_BOOTSTRAP_PATHS,
    checkedFiles: [
      "package.json",
      MONOREPO_PARITY_RUNNER,
      "scripts/pre-pr-bootstrap-guard.mjs",
      "docs/release-rollout-checklist.md",
    ],
    checks,
    failures: failed.map(({ id, evidence }) => ({ id, evidence })),
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(output.ok ? 0 : 1);
}

try {
  main();
} catch (error) {
  const output = {
    schemaVersion: "a2a.runner.release-candidate-parity-audit.v1",
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exit(2);
}
