/**
 * Residue Cleanup Dry-Run Fixture Harness (Team1/bangtong).
 *
 * Validates that `buildCleanupDryRunPlan` produces correct deterministic
 * dry-run plans from a structured fixture of readiness-report scenarios.
 *
 * Parent: https://github.com/jinwon-int/a2a-broker/issues/835
 * Run: a2a-team1-bangtong-residue-cleanup-dry-run-20260520T125200Z
 *
 * Safety gates enforced for every case:
 * - No DB mutation / prune / migration
 * - No deploy / restart
 * - No live provider send
 * - No terminal ACK
 * - Operator approval required before any mutation
 * - Backup required before any execution
 * - Dry-run only (mutationPerformed: false)
 * - Fail closed for stale entries that may still be valid
 * - No OpenClaw runtime/bootstrap context files leak into fixture
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCleanupDryRunPlan,
  type ReadinessReport,
  type CleanupDryRunPlan,
  type CleanupDryRunEntry,
} from "./scanner.js";
import type { CleanupRiskClass, ReadinessRunStatus } from "./scanner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE_PATH = resolve(__dirname, "..", "examples", "runner-residue-cleanup-dry-run-fixtures.json");

// ─── Fixture types ──────────────────────────────────────────────────────

interface ResidueCleanupDryRunFixtures {
  schemaVersion: "a2a.runner.residue-cleanup-dry-run-fixtures.v1";
  run: string;
  issueUrl: string;
  parentUrl: string;
  targetWorker: string;
  safetyState: {
    noLiveProviderSend: true;
    noDbMutationOrPrune: true;
    noDeployOrRestart: true;
    noTerminalAck: true;
    dryRunOnly: true;
    operatorApprovalRequired: true;
    backupRequired: true;
  };
  cases: ResidueCleanupDryRunCase[];
}

interface ResidueCleanupDryRunCase {
  name: string;
  readinessReport: ReadinessReport;
  options?: {
    limit?: number;
    candidateIdPrefix?: string;
  };
  expected: {
    schemaVersion: "a2a.runner.cleanup-dry-run-plan.v1";
    totalCandidates: number;
    entriesLen: number;
    byRiskClass: Record<CleanupRiskClass, number>;
    byTrigger: Record<ReadinessRunStatus, number>;
    entries?: Array<{
      riskClass?: CleanupRiskClass;
      trigger?: ReadinessRunStatus;
      terminal?: boolean;
    }>;
    safeTaskIds?: string[];
    excludedSafeTaskIds?: string[];
    candidateIdStartsWith?: string;
    planIdStartsWith?: string;
    sortedByCandidateId?: boolean;
    firstCandidateSafeTaskId?: string;
    lastCandidateSafeTaskId?: string;
    deterministic?: boolean;
    hasPreExecutionChecklist?: boolean;
    hasRollbackNotes?: boolean;
    safety: {
      mutationPerformed: false;
      operatorApprovalRequired: true;
      backupRequired: true;
      staleWorkerRowsMayBeValid: true;
      liveProviderSendPerformed: false;
      terminalAckSent: false;
      dbMutationPerformed: false;
    };
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function loadFixture(): { raw: string; fixture: ResidueCleanupDryRunFixtures } {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  return { raw, fixture: JSON.parse(raw) as ResidueCleanupDryRunFixtures };
}

function assertCommonSafety(
  name: string,
  plan: CleanupDryRunPlan,
  expected: ResidueCleanupDryRunCase["expected"],
): void {
  const s = plan.safety;
  assert.strictEqual(s.mutationPerformed, false, `${name}: safety.mutationPerformed`);
  assert.strictEqual(s.operatorApprovalRequired, true, `${name}: safety.operatorApprovalRequired`);
  assert.strictEqual(s.backupRequired, true, `${name}: safety.backupRequired`);
  assert.strictEqual(s.staleWorkerRowsMayBeValid, true, `${name}: safety.staleWorkerRowsMayBeValid`);
  assert.strictEqual(s.liveProviderSendPerformed, false, `${name}: safety.liveProviderSendPerformed`);
  assert.strictEqual(s.terminalAckSent, false, `${name}: safety.terminalAckSent`);
  assert.strictEqual(s.dbMutationPerformed, false, `${name}: safety.dbMutationPerformed`);

  // Also verify against expected safety markers
  assert.strictEqual(s.mutationPerformed, expected.safety.mutationPerformed, `${name}: expected safety.mutationPerformed`);
  assert.strictEqual(s.operatorApprovalRequired, expected.safety.operatorApprovalRequired, `${name}: expected safety.operatorApprovalRequired`);
  assert.strictEqual(s.backupRequired, expected.safety.backupRequired, `${name}: expected safety.backupRequired`);
  assert.strictEqual(s.staleWorkerRowsMayBeValid, expected.safety.staleWorkerRowsMayBeValid, `${name}: expected safety.staleWorkerRowsMayBeValid`);
  assert.strictEqual(s.liveProviderSendPerformed, expected.safety.liveProviderSendPerformed, `${name}: expected safety.liveProviderSendPerformed`);
  assert.strictEqual(s.terminalAckSent, expected.safety.terminalAckSent, `${name}: expected safety.terminalAckSent`);
  assert.strictEqual(s.dbMutationPerformed, expected.safety.dbMutationPerformed, `${name}: expected safety.dbMutationPerformed`);
}

function assertByRiskClass(
  name: string,
  actual: Record<CleanupRiskClass, number>,
  expected: Record<CleanupRiskClass, number>,
): void {
  for (const cls of ["low", "medium", "high", "blocked"] as CleanupRiskClass[]) {
    assert.strictEqual(actual[cls], expected[cls], `${name}: byRiskClass.${cls}`);
  }
}

function assertByTrigger(
  name: string,
  actual: Record<ReadinessRunStatus, number>,
  expected: Record<ReadinessRunStatus, number>,
): void {
  for (const trigger of ["ok", "stale", "malformed", "orphan"] as ReadinessRunStatus[]) {
    assert.strictEqual(actual[trigger], expected[trigger], `${name}: byTrigger.${trigger}`);
  }
}

function assertBoundReport(
  name: string,
  plan: CleanupDryRunPlan,
  report: ReadinessReport,
): void {
  const bound = plan.boundReadinessReport;
  assert.strictEqual(bound.rootLabel, report.rootLabel, `${name}: bound rootLabel`);
  assert.strictEqual(bound.totalTaskRoots, report.totalTaskRoots, `${name}: bound totalTaskRoots`);
  assert.strictEqual(bound.totalRunDirs, report.totalRunDirs, `${name}: bound totalRunDirs`);
  assert.strictEqual(bound.staleRuns, report.staleRuns, `${name}: bound staleRuns`);
  assert.strictEqual(bound.malformedRuns, report.malformedRuns, `${name}: bound malformedRuns`);
  assert.strictEqual(bound.orphanTaskRoots, report.orphanTaskRoots, `${name}: bound orphanTaskRoots`);
}

// ─── Tests ──────────────────────────────────────────────────────────────

// ── Fixture integrity ───────────────────────────────────────────────────

test("residue cleanup dry-run fixture has valid schema and safety state", () => {
  const { raw, fixture } = loadFixture();

  assert.equal(
    fixture.schemaVersion,
    "a2a.runner.residue-cleanup-dry-run-fixtures.v1",
  );
  assert.equal(fixture.targetWorker, "bangtong");
  assert.equal(
    fixture.issueUrl,
    "https://github.com/jinwon-int/a2a-broker/issues/835",
  );
  assert.ok(fixture.cases.length >= 3, "fixture should cover at least 3 residue scenarios");

  // All safety gates must be explicitly false for live/mutation paths
  assert.deepStrictEqual(fixture.safetyState, {
    noLiveProviderSend: true,
    noDbMutationOrPrune: true,
    noDeployOrRestart: true,
    noTerminalAck: true,
    dryRunOnly: true,
    operatorApprovalRequired: true,
    backupRequired: true,
  });

  // No OpenClaw bootstrap context file leaks
  assert.doesNotMatch(
    raw,
    /(?:^|["/\\])(?:AGENTS|SOUL|USER|TOOLS|HEARTBEAT|IDENTITY)\.md(?:["\s,}]|$)|(?:^|["/\\])\.openclaw(?:["/\\]|$)/m,
    "fixture must not include OpenClaw runtime/bootstrap context paths",
  );
});

test("every fixture case has required fields", () => {
  const { fixture } = loadFixture();

  for (const entry of fixture.cases) {
    assert.ok(entry.name, "each case must have a name");
    assert.ok(entry.readinessReport, `${entry.name}: must have readinessReport`);
    assert.ok(entry.expected, `${entry.name}: must have expected block`);
    assert.equal(
      entry.expected.schemaVersion,
      "a2a.runner.cleanup-dry-run-plan.v1",
      `${entry.name}: expected schema must be cleanup-dry-run-plan.v1`,
    );
    assert.ok(typeof entry.expected.totalCandidates === "number", `${entry.name}: expected.totalCandidates`);
    assert.ok(typeof entry.expected.entriesLen === "number", `${entry.name}: expected.entriesLen`);
    assert.ok(entry.expected.byRiskClass, `${entry.name}: expected.byRiskClass`);
    assert.ok(entry.expected.byTrigger, `${entry.name}: expected.byTrigger`);
    assert.ok(entry.expected.safety, `${entry.name}: expected.safety`);
  }
});

// ── Empty report ────────────────────────────────────────────────────────

test("residue dry-run: empty readiness report produces zero-candidate plan", () => {
  const { fixture } = loadFixture();
  const entry = fixture.cases.find((c) => c.name === "empty readiness report produces zero-candidate plan");
  assert.ok(entry, "missing empty report case");

  const plan = buildCleanupDryRunPlan(entry.readinessReport);

  assert.equal(plan.schemaVersion, "a2a.runner.cleanup-dry-run-plan.v1");
  assert.equal(plan.summary.totalCandidates, 0);
  assert.equal(plan.entries.length, 0);
  assertBoundReport(entry.name, plan, entry.readinessReport);
  assertByRiskClass(entry.name, plan.summary.byRiskClass, entry.expected.byRiskClass);
  assertByTrigger(entry.name, plan.summary.byTrigger, entry.expected.byTrigger);
  assertCommonSafety(entry.name, plan, entry.expected);
});

// ── Stale old (high risk) ───────────────────────────────────────────────

test("residue dry-run: stale runs older than 7 days are high risk", () => {
  const { fixture } = loadFixture();
  const entry = fixture.cases.find((c) => c.name === "stale runs older than 7 days are high risk");
  assert.ok(entry, "missing stale old case");

  const plan = buildCleanupDryRunPlan(entry.readinessReport);

  assert.equal(plan.summary.totalCandidates, 1);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0]!.riskClass, "high");
  assert.equal(plan.entries[0]!.trigger, "stale");
  assertBoundReport(entry.name, plan, entry.readinessReport);
  assertByRiskClass(entry.name, plan.summary.byRiskClass, entry.expected.byRiskClass);
  assertByTrigger(entry.name, plan.summary.byTrigger, entry.expected.byTrigger);
  assertCommonSafety(entry.name, plan, entry.expected);
});

// ── Stale fresh (medium risk) ───────────────────────────────────────────

test("residue dry-run: stale runs younger than 7 days are medium risk", () => {
  const { fixture } = loadFixture();
  const entry = fixture.cases.find((c) => c.name === "stale runs younger than 7 days are medium risk");
  assert.ok(entry, "missing stale fresh case");

  const plan = buildCleanupDryRunPlan(entry.readinessReport);

  assert.equal(plan.summary.totalCandidates, 1);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0]!.riskClass, "medium");
  assert.equal(plan.entries[0]!.trigger, "stale");
  assertBoundReport(entry.name, plan, entry.readinessReport);
  assertByRiskClass(entry.name, plan.summary.byRiskClass, entry.expected.byRiskClass);
  assertByTrigger(entry.name, plan.summary.byTrigger, entry.expected.byTrigger);
  assertCommonSafety(entry.name, plan, entry.expected);
});

// ── Orphan (low risk) ───────────────────────────────────────────────────

test("residue dry-run: orphan task roots are low risk", () => {
  const { fixture } = loadFixture();
  const entry = fixture.cases.find((c) => c.name === "orphan task roots classified as low risk");
  assert.ok(entry, "missing orphan case");

  const plan = buildCleanupDryRunPlan(entry.readinessReport);

  assert.equal(plan.summary.totalCandidates, 1);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0]!.riskClass, "low");
  assert.equal(plan.entries[0]!.trigger, "orphan");
  assertBoundReport(entry.name, plan, entry.readinessReport);
  assertByRiskClass(entry.name, plan.summary.byRiskClass, entry.expected.byRiskClass);
  assertByTrigger(entry.name, plan.summary.byTrigger, entry.expected.byTrigger);
  assertCommonSafety(entry.name, plan, entry.expected);
});

// ── Terminal malformed (low risk) ───────────────────────────────────────

test("residue dry-run: terminal malformed runs are low risk", () => {
  const { fixture } = loadFixture();
  const entry = fixture.cases.find((c) => c.name === "terminal malformed runs are low risk");
  assert.ok(entry, "missing terminal malformed case");

  const plan = buildCleanupDryRunPlan(entry.readinessReport);

  assert.equal(plan.summary.totalCandidates, 1);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0]!.riskClass, "low");
  assert.equal(plan.entries[0]!.trigger, "malformed");
  assert.equal(plan.entries[0]!.terminal, true);
  assertBoundReport(entry.name, plan, entry.readinessReport);
  assertByRiskClass(entry.name, plan.summary.byRiskClass, entry.expected.byRiskClass);
  assertByTrigger(entry.name, plan.summary.byTrigger, entry.expected.byTrigger);
  assertCommonSafety(entry.name, plan, entry.expected);
});

// ── Non-terminal malformed (medium risk) ────────────────────────────────

test("residue dry-run: non-terminal malformed runs are medium risk", () => {
  const { fixture } = loadFixture();
  const entry = fixture.cases.find((c) => c.name === "non-terminal malformed runs are medium risk");
  assert.ok(entry, "missing non-terminal malformed case");

  const plan = buildCleanupDryRunPlan(entry.readinessReport);

  assert.equal(plan.summary.totalCandidates, 1);
  assert.equal(plan.entries.length, 1);
  assert.equal(plan.entries[0]!.riskClass, "medium");
  assert.equal(plan.entries[0]!.trigger, "malformed");
  assert.equal(plan.entries[0]!.terminal, false);
  assertBoundReport(entry.name, plan, entry.readinessReport);
  assertByRiskClass(entry.name, plan.summary.byRiskClass, entry.expected.byRiskClass);
  assertByTrigger(entry.name, plan.summary.byTrigger, entry.expected.byTrigger);
  assertCommonSafety(entry.name, plan, entry.expected);
});

// ── OK runs excluded ────────────────────────────────────────────────────

test("residue dry-run: ok runs are excluded from cleanup candidates", () => {
  const { fixture } = loadFixture();
  const entry = fixture.cases.find((c) => c.name === "ok runs are excluded from cleanup candidates");
  assert.ok(entry, "missing ok excluded case");

  const plan = buildCleanupDryRunPlan(entry.readinessReport);

  assert.equal(plan.summary.totalCandidates, 1);
  assert.equal(plan.entries.length, 1);

  // Verify excluded safe task ids are absent
  for (const excluded of entry.expected.excludedSafeTaskIds ?? []) {
    assert.ok(
      !plan.entries.some((e) => e.safeTaskId === excluded),
      `${entry.name}: should exclude ${excluded}`,
    );
  }
  // Verify included safe task ids
  for (const included of entry.expected.safeTaskIds ?? []) {
    assert.ok(
      plan.entries.some((e) => e.safeTaskId === included),
      `${entry.name}: should include ${included}`,
    );
  }

  assertBoundReport(entry.name, plan, entry.readinessReport);
  assertByRiskClass(entry.name, plan.summary.byRiskClass, entry.expected.byRiskClass);
  assertByTrigger(entry.name, plan.summary.byTrigger, entry.expected.byTrigger);
  assertCommonSafety(entry.name, plan, entry.expected);
});

// ── Limit ───────────────────────────────────────────────────────────────

test("residue dry-run: limit option caps total entries", () => {
  const { fixture } = loadFixture();
  const entry = fixture.cases.find((c) => c.name === "limit option caps total entries");
  assert.ok(entry, "missing limit case");

  const plan = buildCleanupDryRunPlan(entry.readinessReport, entry.options);

  assert.equal(plan.entries.length, 2);
  assert.equal(plan.summary.totalCandidates, 2);
  assertBoundReport(entry.name, plan, entry.readinessReport);
  assertByRiskClass(entry.name, plan.summary.byRiskClass, entry.expected.byRiskClass);
  assertByTrigger(entry.name, plan.summary.byTrigger, entry.expected.byTrigger);
  assertCommonSafety(entry.name, plan, entry.expected);
});

// ── Candidate prefix ────────────────────────────────────────────────────

test("residue dry-run: candidateIdPrefix overrides default prefix", () => {
  const { fixture } = loadFixture();
  const entry = fixture.cases.find((c) => c.name === "candidateIdPrefix overrides default prefix");
  assert.ok(entry, "missing prefix case");

  const plan = buildCleanupDryRunPlan(entry.readinessReport, entry.options);

  assert.equal(plan.entries.length, 1);
  assert.ok(
    plan.entries[0]!.candidateId.startsWith(entry.expected.candidateIdStartsWith!),
    `${entry.name}: candidateId should start with "${entry.expected.candidateIdStartsWith}"`,
  );
  assert.ok(
    plan.planId.startsWith(entry.expected.planIdStartsWith!),
    `${entry.name}: planId should start with "${entry.expected.planIdStartsWith}"`,
  );
  assertByRiskClass(entry.name, plan.summary.byRiskClass, entry.expected.byRiskClass);
  assertByTrigger(entry.name, plan.summary.byTrigger, entry.expected.byTrigger);
  assertCommonSafety(entry.name, plan, entry.expected);
});

// ── Mixed risk classes ──────────────────────────────────────────────────

test("residue dry-run: mixed residue with all risk classes present", () => {
  const { fixture } = loadFixture();
  const entry = fixture.cases.find((c) => c.name === "mixed residue with all risk classes present");
  assert.ok(entry, "missing mixed case");

  const plan = buildCleanupDryRunPlan(entry.readinessReport);

  assert.equal(plan.entries.length, 4);
  assert.equal(plan.summary.totalCandidates, 4);

  // Verify each risk class is represented
  const foundLow = plan.entries.some((e) => e.riskClass === "low");
  const foundMedium = plan.entries.some((e) => e.riskClass === "medium");
  const foundHigh = plan.entries.some((e) => e.riskClass === "high");
  assert.ok(foundLow, `${entry.name}: should have low risk entry`);
  assert.ok(foundMedium, `${entry.name}: should have medium risk entry`);
  assert.ok(foundHigh, `${entry.name}: should have high risk entry`);

  assertBoundReport(entry.name, plan, entry.readinessReport);
  assertByRiskClass(entry.name, plan.summary.byRiskClass, entry.expected.byRiskClass);
  assertByTrigger(entry.name, plan.summary.byTrigger, entry.expected.byTrigger);
  assertCommonSafety(entry.name, plan, entry.expected);
});

// ── Deterministic sort ──────────────────────────────────────────────────

test("residue dry-run: entries sorted deterministically by candidateId", () => {
  const { fixture } = loadFixture();
  const entry = fixture.cases.find((c) => c.name === "entries sorted deterministically by candidateId");
  assert.ok(entry, "missing sort case");

  const plan = buildCleanupDryRunPlan(entry.readinessReport);

  assert.equal(plan.entries.length, 3);

  // Verify sort order
  const ids = plan.entries.map((e) => e.candidateId);
  for (let i = 1; i < ids.length; i++) {
    assert.ok(
      ids[i - 1]! < ids[i]!,
      `${entry.name}: entries must be sorted by candidateId: ${ids[i - 1]} >= ${ids[i]}`,
    );
  }

  // First and last by safeTaskId
  assert.ok(
    plan.entries[0]!.candidateId.includes("aaa-task"),
    `${entry.name}: first entry should be aaa-task`,
  );
  assert.ok(
    plan.entries[2]!.candidateId.includes("zzz-task"),
    `${entry.name}: last entry should be zzz-task`,
  );

  assertBoundReport(entry.name, plan, entry.readinessReport);
  assertByRiskClass(entry.name, plan.summary.byRiskClass, entry.expected.byRiskClass);
  assertByTrigger(entry.name, plan.summary.byTrigger, entry.expected.byTrigger);
  assertCommonSafety(entry.name, plan, entry.expected);
});

// ── Deterministic output across invocations ─────────────────────────────

test("residue dry-run: deterministic output for identical input", () => {
  const { fixture } = loadFixture();
  const entry = fixture.cases.find((c) => c.name === "deterministic output for identical input across two invocations");
  assert.ok(entry, "missing deterministic case");

  const plan1 = buildCleanupDryRunPlan(entry.readinessReport);
  const plan2 = buildCleanupDryRunPlan(entry.readinessReport);

  // planId, candidateIds, summary, and safety must be identical
  assert.strictEqual(plan1.planId, plan2.planId, `${entry.name}: planId must be deterministic`);
  assert.deepStrictEqual(
    plan1.entries.map((e) => e.candidateId),
    plan2.entries.map((e) => e.candidateId),
    `${entry.name}: candidateIds must be deterministic`,
  );
  assert.deepStrictEqual(plan1.summary, plan2.summary, `${entry.name}: summary must be deterministic`);
  assert.deepStrictEqual(plan1.safety, plan2.safety, `${entry.name}: safety must be deterministic`);
  assert.deepStrictEqual(plan1.entries, plan2.entries, `${entry.name}: entries must be deterministic`);

  assertCommonSafety(entry.name, plan1, entry.expected);
  assertCommonSafety(entry.name, plan2, entry.expected);
});

// ── Pre-execution checklist and rollback notes ──────────────────────────

test("residue dry-run: pre-execution checklist and rollback notes present", () => {
  const { fixture } = loadFixture();
  const entry = fixture.cases.find(
    (c) => c.name === "pre-execution checklist and rollback notes are present",
  );
  assert.ok(entry, "missing checklist case");

  const plan = buildCleanupDryRunPlan(entry.readinessReport);

  assert.ok(
    Array.isArray(plan.preExecutionChecklist),
    `${entry.name}: preExecutionChecklist must be an array`,
  );
  assert.ok(
    plan.preExecutionChecklist.length >= 3,
    `${entry.name}: preExecutionChecklist should have at least 3 items`,
  );
  assert.ok(
    typeof plan.rollbackNotes === "string" && plan.rollbackNotes.length > 0,
    `${entry.name}: rollbackNotes must be a non-empty string`,
  );
  assert.ok(
    plan.rollbackNotes.includes("backup"),
    `${entry.name}: rollbackNotes should reference backup`,
  );
  assert.ok(
    plan.rollbackNotes.includes("rollback"),
    `${entry.name}: rollbackNotes should reference rollback`,
  );

  assertCommonSafety(entry.name, plan, entry.expected);
});

// ── Cross-cutting ───────────────────────────────────────────────────────

test("residue dry-run: all cases share consistent issue metadata", () => {
  const { fixture } = loadFixture();

  for (const entry of fixture.cases) {
    assert.equal(
      fixture.run,
      "a2a-team1-bangtong-residue-cleanup-dry-run-20260520T125200Z",
      `${entry.name}: run metadata mismatch`,
    );
    assert.strictEqual(fixture.targetWorker, "bangtong", `${entry.name}: targetWorker mismatch`);
  }
});

test("residue dry-run: no case contains raw stdout, stderr, or session dumps", () => {
  const { raw } = loadFixture();

  // The fixture must not contain raw log bodies (structured metadata only)
  assert.doesNotMatch(
    raw,
    /(?:^|["\s])(?:stdout|stderr)(?:["\s:,]|$)/im,
    "fixture must not reference raw stdout or stderr in evidence body",
  );

  // No raw session dump payload
  assert.doesNotMatch(
    raw,
    /"sessions\.json"|"session\.json"|sessions\.dump|\.session-store/,
    "fixture must not contain raw session dump references",
  );
});

test("residue dry-run: all cases use synthetic/fixture data only (no live URLs beyond issue)", () => {
  const { raw, fixture } = loadFixture();

  // Fixture references known issue and parent URLs — not production issue URLs
  assert.ok(
    raw.includes("jinwon-int/a2a-broker/issues/835"),
    "fixture should reference the parent broker issue",
  );
  assert.ok(
    raw.includes("jinwon-int/a2a-docker-runner"),
    "fixture should reference the runner repo",
  );

  // Verify all readiness reports use deterministic timestamps
  for (const entry of fixture.cases) {
    assert.equal(
      entry.readinessReport.generatedAt,
      "1970-01-01T00:00:00.000Z",
      `${entry.name}: report must use deterministic timestamp`,
    );
  }
});

// ── Scanner import boundary ─────────────────────────────────────────────

test("residue dry-run: builtCleanupDryRunPlan does not mutate input report", () => {
  const { fixture } = loadFixture();
  const entry = fixture.cases.find((c) => c.name === "empty readiness report produces zero-candidate plan");
  assert.ok(entry, "missing empty report case for immutability check");

  const frozen = JSON.parse(JSON.stringify(entry.readinessReport)) as ReadinessReport;
  buildCleanupDryRunPlan(entry.readinessReport);
  assert.deepStrictEqual(
    entry.readinessReport,
    frozen,
    "buildCleanupDryRunPlan must not mutate its input report",
  );
});

test("residue dry-run: all fixture cases pass full safety gate assert set", () => {
  const { fixture } = loadFixture();

  for (const entry of fixture.cases) {
    const plan = buildCleanupDryRunPlan(entry.readinessReport, entry.options);
    const s = plan.safety;

    // Every safety marker must be set
    assert.strictEqual(s.mutationPerformed, false, `${entry.name}: mutationPerformed`);
    assert.strictEqual(s.operatorApprovalRequired, true, `${entry.name}: operatorApprovalRequired`);
    assert.strictEqual(s.backupRequired, true, `${entry.name}: backupRequired`);
    assert.strictEqual(s.staleWorkerRowsMayBeValid, true, `${entry.name}: staleWorkerRowsMayBeValid`);
    assert.strictEqual(s.liveProviderSendPerformed, false, `${entry.name}: liveProviderSendPerformed`);
    assert.strictEqual(s.terminalAckSent, false, `${entry.name}: terminalAckSent`);
    assert.strictEqual(s.dbMutationPerformed, false, `${entry.name}: dbMutationPerformed`);
  }
});
