import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildA2AWorkModeDecisionEvidence,
  buildA2AWorkModePreDispatchDecision,
  type A2AWorkModeDecisionEvidence,
} from "./work-mode-pre-dispatch-decision.js";

import {
  buildTeam1DispatchPlan,
  buildDeterministicTaskId,
  buildTeam1RoundManifest,
  resolveTeam1ParentRoundMetadata,
  runTeam1PreflightChecks,
  evaluateDispatchDecision,
  renderTeam1DispatchPlanMarkdown,
  resolveTeam1WorkerModelPolicy,
  TEAM1_ALLOWED_WORKER_MODELS,
  TEAM1_ALLOWED_WORKER_THINKING_LEVELS,
  TEAM1_DEFAULT_WORKER_MODEL,
  TEAM1_PRO_ESCALATION_MODEL,
} from "./team1-dispatch-wrapper.js";

const BASE_ROUND_SPEC = {
  teamId: "team1" as const,
  lane: 2 as const,
  worker: "workerdelta",
  runId: "a2a-team1-dispatch-wrapper-20260520T233413Z",
  parentIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/847",
  childIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/848",
  childIssue: "#848",
};

function validTeam1DecisionEvidence(): A2AWorkModeDecisionEvidence {
  return buildA2AWorkModeDecisionEvidence(
    buildA2AWorkModePreDispatchDecision({
      now: "2026-06-07T06:00:00.000Z",
      finalizerOwner: "brokeralpha",
      task: {
        taskId: "team1-dispatch-wrapper-test",
        workProfile: "candidate_review",
        ambiguity: "high",
        hasIndependentEvidenceLanes: true,
        hasMultipleCandidates: true,
      },
      workers: {
        capacityState: "healthy",
        staleTasks: 0,
        snapshotSource: "/workers/capacity",
        snapshotAt: "2026-06-07T05:59:00.000Z",
      },
    }),
  );
}

// ── Deterministic task ID ───────────────────────────────────────────────────

test("buildDeterministicTaskId produces deterministic ids from same inputs", () => {
  const first = buildDeterministicTaskId(BASE_ROUND_SPEC, { dryRun: true, execute: false, preflightEnabled: true });
  const second = buildDeterministicTaskId(BASE_ROUND_SPEC, { dryRun: true, execute: false, preflightEnabled: true });

  assert.equal(first.taskId, second.taskId);
  assert.equal(first.shortId, second.shortId);
  assert.equal(first.idempotent, true);
  assert.match(first.taskId, /^team1-/);
});

test("buildDeterministicTaskId changes when inputs change", () => {
  const base = buildDeterministicTaskId(BASE_ROUND_SPEC, { dryRun: true, execute: false, preflightEnabled: true });
  const differentWorker = buildDeterministicTaskId(
    { ...BASE_ROUND_SPEC, worker: "other-worker" },
    { dryRun: true, execute: false, preflightEnabled: true },
  );
  const differentLane = buildDeterministicTaskId(
    { ...BASE_ROUND_SPEC, lane: 3 },
    { dryRun: true, execute: false, preflightEnabled: true },
  );

  assert.notEqual(base.taskId, differentWorker.taskId);
  assert.notEqual(base.taskId, differentLane.taskId);
});

test("buildDeterministicTaskId idempotent across calls", () => {
  const ids = Array.from({ length: 5 }, () =>
    buildDeterministicTaskId(BASE_ROUND_SPEC, { dryRun: true, execute: false, preflightEnabled: true }),
  );
  for (const id of ids) {
    assert.equal(id.taskId, ids[0].taskId);
  }
});

// ── Preflight checks ────────────────────────────────────────────────────────

test("runTeam1PreflightChecks passes with valid spec and known worker", () => {
  const results = runTeam1PreflightChecks(BASE_ROUND_SPEC, { dryRun: true, execute: false, preflightEnabled: true }, true);
  const fails = results.filter((r) => r.status === "fail");
  assert.equal(fails.length, 0);
  assert.ok(results.some((r) => r.checkId === "worker_online" && r.status === "pass"));
  assert.ok(results.some((r) => r.checkId === "approval_boundary_respected" && r.status === "pass"));
});

test("runTeam1PreflightChecks fails when worker capability is absent", () => {
  const results = runTeam1PreflightChecks(BASE_ROUND_SPEC, { dryRun: true, execute: false, preflightEnabled: true }, false);
  const fails = results.filter((r) => r.status === "fail");
  assert.ok(fails.length > 0);
  assert.ok(results.some((r) => r.checkId === "worker_online" && r.status === "fail"));
});

test("runTeam1PreflightChecks fails when github patch runtime is not ready", () => {
  const results = runTeam1PreflightChecks(
    BASE_ROUND_SPEC,
    { dryRun: true, execute: false, preflightEnabled: true },
    true,
    false,
  );

  const runtimeCheck = results.find((r) => r.checkId === "worker_github_patch_runtime_ready");
  assert.ok(runtimeCheck);
  assert.equal(runtimeCheck.status, "fail");
  assert.match(runtimeCheck.detail ?? "", /githubPatch\.status=ok/);
});

test("runTeam1PreflightChecks passes github patch runtime when doctor is ready", () => {
  const results = runTeam1PreflightChecks(
    BASE_ROUND_SPEC,
    { dryRun: true, execute: false, preflightEnabled: true },
    true,
    true,
  );

  assert.ok(results.some((r) => r.checkId === "worker_github_patch_runtime_ready" && r.status === "pass"));
});

test("runTeam1PreflightChecks warns on execute mode", () => {
  const results = runTeam1PreflightChecks(BASE_ROUND_SPEC, { dryRun: false, execute: true, preflightEnabled: true }, true);
  const approvalCheck = results.find((r) => r.checkId === "approval_boundary_respected");
  assert.ok(approvalCheck);
  assert.equal(approvalCheck.status, "warn");
});

test("runTeam1PreflightChecks skips when preflight disabled", () => {
  const results = runTeam1PreflightChecks(BASE_ROUND_SPEC, { dryRun: true, execute: false, preflightEnabled: false });
  const skipped = results.filter((r) => r.status === "skipped");
  assert.ok(skipped.length > 0);
});

test("runTeam1PreflightChecks fails before dispatch when parent round order exceeds total", () => {
  const results = runTeam1PreflightChecks(
    { ...BASE_ROUND_SPEC, parentRoundTotal: 2, parentRoundOrder: 3 },
    { dryRun: false, execute: true, preflightEnabled: true },
    true,
  );

  const metadataCheck = results.find((r) => r.checkId === "parent_round_metadata_populated");
  assert.ok(metadataCheck);
  assert.equal(metadataCheck.status, "fail");
  assert.match(metadataCheck.detail ?? "", /parentRoundOrder must be <= parentRoundTotal/);
});

test("resolveTeam1ParentRoundMetadata derives order from lane and total from Team1 default", () => {
  const result = resolveTeam1ParentRoundMetadata(BASE_ROUND_SPEC);

  assert.equal(result.issues.length, 0);
  assert.equal(result.metadata?.parentRoundId, BASE_ROUND_SPEC.runId);
  assert.equal(result.metadata?.parentRoundTotal, 4);
  assert.equal(result.metadata?.parentRoundOrder, BASE_ROUND_SPEC.lane);
  assert.equal(result.metadata?.parentRoundTotalSource, "team1-default");
  assert.equal(result.metadata?.parentRoundOrderSource, "lane");
});

// ── Fail-closed decision ────────────────────────────────────────────────────

test("evaluateDispatchDecision returns go when all pass", () => {
  const results = runTeam1PreflightChecks(BASE_ROUND_SPEC, { dryRun: true, execute: false, preflightEnabled: true }, true);
  const decision = evaluateDispatchDecision(results);
  assert.equal(decision.decision, "go");
  assert.equal(decision.blockers.length, 0);
});

test("evaluateDispatchDecision returns blocked on failures", () => {
  const results = runTeam1PreflightChecks(BASE_ROUND_SPEC, { dryRun: true, execute: false, preflightEnabled: true }, false);
  const decision = evaluateDispatchDecision(results);
  assert.equal(decision.decision, "blocked");
  assert.ok(decision.blockers.length > 0);
});

test("evaluateDispatchDecision returns blocked on execute without work-mode evidence", () => {
  const results = runTeam1PreflightChecks(BASE_ROUND_SPEC, { dryRun: false, execute: true, preflightEnabled: true }, true);
  const decision = evaluateDispatchDecision(results);
  assert.equal(decision.decision, "blocked");
  assert.ok(decision.blockers.some((blocker) => blocker.includes("work_mode_decision_evidence")));
});

test("evaluateDispatchDecision returns warn_go on execute with work-mode evidence", () => {
  const results = runTeam1PreflightChecks(
    { ...BASE_ROUND_SPEC, workModeDecision: validTeam1DecisionEvidence() },
    { dryRun: false, execute: true, preflightEnabled: true },
    true,
  );
  const decision = evaluateDispatchDecision(results);
  assert.equal(decision.decision, "warn_go");
  assert.ok(decision.warnings.length > 0);
  assert.equal(decision.blockers.length, 0);
});

// ── Dispatch plan ───────────────────────────────────────────────────────────

test("buildTeam1DispatchPlan produces deterministic plans for same inputs", () => {
  const fixedNow = "2026-05-20T23:34:13.000Z";
  const config = { dryRun: true, execute: false, preflightEnabled: true, now: fixedNow };
  const first = buildTeam1DispatchPlan(BASE_ROUND_SPEC, config, true);
  const second = buildTeam1DispatchPlan(BASE_ROUND_SPEC, config, true);

  assert.equal(first.deterministicTaskId.taskId, second.deterministicTaskId.taskId);
  assert.equal(first.runRecord.recordChecksum, second.runRecord.recordChecksum);
  assert.equal(first.runRecord.taskId, second.runRecord.taskId);
  assert.deepEqual(first, second);
});

test("buildTeam1DispatchPlan defaults to dry-run", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);

  assert.equal(plan.config.dryRun, true);
  assert.equal(plan.config.execute, false);
  assert.equal(plan.metadata.dryRunDefault, true);
  assert.equal(plan.metadata.executeExplicit, false);
  assert.ok(plan.dispatchActions.some((a) => a.includes("dry-run")));
});

test("buildTeam1DispatchPlan blocks --execute without work-mode decision evidence", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, { dryRun: false, execute: true, preflightEnabled: true }, true);

  assert.equal(plan.config.dryRun, false);
  assert.equal(plan.config.execute, true);
  assert.equal(plan.metadata.executeExplicit, true);
  assert.equal(plan.decision.value, "blocked");
  assert.ok(plan.decision.blockers.some((blocker) => blocker.includes("work_mode_decision_evidence")));
  assert.ok(plan.dispatchActions.some((a) => a.includes("createTask: blocked")));
});

test("buildTeam1DispatchPlan with --execute persists work-mode decision evidence", () => {
  const workModeDecision = validTeam1DecisionEvidence();
  const plan = buildTeam1DispatchPlan(
    { ...BASE_ROUND_SPEC, workModeDecision },
    { dryRun: false, execute: true, preflightEnabled: true },
    true,
  );

  assert.equal(plan.decision.value, "warn_go");
  assert.equal(plan.taskPayload?.workModeDecision?.idempotencyKey, workModeDecision.idempotencyKey);
  assert.equal(plan.metadata.workModeDecision?.finalizerOwner, "brokeralpha");
  assert.equal(plan.runRecord.metadata.workModeDecisionMode, "team1");
  assert.equal(plan.roundManifest?.metadata?.workModeDecisionIdempotencyKey, workModeDecision.idempotencyKey);
  assert.ok(plan.dispatchActions.some((a) => a.includes("[work-mode] decision")));
  assert.ok(plan.dispatchActions.some((a) => a.includes("createTask(")));
});

test("buildTeam1DispatchPlan blocks with missing worker capability", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, { dryRun: true, execute: false, preflightEnabled: true }, false);

  assert.equal(plan.decision.value, "blocked");
  assert.ok(plan.decision.blockers.length > 0);
  // Dispatch actions do not contain writes in dry-run mode
  assert.ok(plan.dispatchActions.some((a) => a.includes("dry-run")));
});

test("buildTeam1DispatchPlan blocks fan-out when github patch runtime is not ready", () => {
  const plan = buildTeam1DispatchPlan(
    BASE_ROUND_SPEC,
    { dryRun: false, execute: true, preflightEnabled: true },
    true,
    false,
  );

  assert.equal(plan.decision.value, "blocked");
  assert.ok(plan.decision.blockers.some((blocker) => blocker.includes("worker_github_patch_runtime_ready")));
  assert.ok(plan.dispatchActions.some((a) => a.includes("createTask: blocked")));
  assert.equal(plan.runRecord.metadata.githubPatchRuntimeReady, "false");
});

test("buildTeam1DispatchPlan includes parent/child metadata", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);

  assert.equal(plan.metadata.parentIssueUrl, BASE_ROUND_SPEC.parentIssueUrl);
  assert.equal(plan.metadata.childIssueUrl, BASE_ROUND_SPEC.childIssueUrl);
  assert.match(plan.metadata.parentChildChain, /847 → .*848/);
});

test("buildTeam1DispatchPlan populates Terminal Brief parent round metadata by default", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);

  assert.equal(plan.metadata.parentRoundId, BASE_ROUND_SPEC.runId);
  assert.equal(plan.metadata.parentRoundTotal, 4);
  assert.equal(plan.metadata.parentRoundOrder, 2);
  assert.equal(plan.runRecord.metadata.parentRoundId, BASE_ROUND_SPEC.runId);
  assert.equal(plan.runRecord.metadata.parentRoundTotal, "4");
  assert.equal(plan.runRecord.metadata.parentRoundOrder, "2");
  assert.equal(plan.taskPayload?.parentRoundId, BASE_ROUND_SPEC.runId);
  assert.equal(plan.taskPayload?.parentRoundTotal, 4);
  assert.equal(plan.taskPayload?.parentRoundOrder, 2);
  assert.ok(plan.dispatchActions.some((a) => a.includes("parent round")));
  assert.doesNotMatch(JSON.stringify(plan), /parentRoundTotal, parentRoundOrder 누락/);
});

test("buildTeam1DispatchPlan accepts explicit multi-lane parent round total and order", () => {
  const plan = buildTeam1DispatchPlan(
    {
      ...BASE_ROUND_SPEC,
      parentRoundId: "a2a-1032-cross-broker-round",
      parentRoundTotal: 8,
      parentRoundOrder: 6,
    },
    undefined,
    true,
  );

  assert.equal(plan.metadata.parentRoundId, "a2a-1032-cross-broker-round");
  assert.equal(plan.metadata.parentRoundTotal, 8);
  assert.equal(plan.metadata.parentRoundOrder, 6);
  assert.equal(plan.runRecord.metadata.parentRoundTotalSource, "explicit");
  assert.equal(plan.runRecord.metadata.parentRoundOrderSource, "explicit");
  assert.equal(plan.taskPayload?.parentRoundTotal, 8);
  assert.equal(plan.taskPayload?.parentRoundOrder, 6);
  assert.equal(plan.roundManifest?.metadata?.parentRoundTotal, "8");
  assert.equal(plan.roundManifest?.expectedWorkers[0].metadata?.parentRoundOrder, "6");
});

test("buildTeam1DispatchPlan uses actual dispatch workers before manual totals", () => {
  const plan = buildTeam1DispatchPlan(
    {
      ...BASE_ROUND_SPEC,
      worker: "workerdelta",
      lane: 4,
      parentRoundTotal: 5,
      parentRoundOrder: 5,
      dispatchWorkers: ["workerbeta", "workeralpha", "workergamma", "workerdelta"],
    },
    undefined,
    true,
  );

  assert.equal(plan.metadata.parentRoundTotal, 4);
  assert.equal(plan.metadata.parentRoundOrder, 4);
  assert.equal(plan.runRecord.metadata.parentRoundTotalSource, "dispatch-workers");
  assert.equal(plan.runRecord.metadata.parentRoundOrderSource, "dispatch-workers");
  assert.deepEqual(plan.taskPayload?.dispatchedWorkers, ["workerbeta", "workeralpha", "workergamma", "workerdelta"]);
  assert.equal(plan.taskPayload?.parentRoundTotal, 4);
  assert.equal(plan.taskPayload?.parentRoundOrder, 4);
});

test("buildTeam1DispatchPlan blocks invalid parent round metadata before createTask", () => {
  const plan = buildTeam1DispatchPlan(
    { ...BASE_ROUND_SPEC, parentRoundTotal: 2, parentRoundOrder: 3 },
    { dryRun: false, execute: true, preflightEnabled: true },
    true,
  );

  assert.equal(plan.decision.value, "blocked");
  assert.ok(plan.decision.blockers.some((b) => b.includes("parent_round_metadata_populated")));
  assert.ok(plan.dispatchActions.some((a) => a.includes("createTask: blocked")));
});

test("buildTeam1DispatchPlan produces sanitized run record", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);

  assert.equal(plan.runRecord.teamId, "team1");
  assert.equal(plan.runRecord.lane, 2);
  assert.equal(plan.runRecord.worker, "workerdelta");
  assert.equal(plan.runRecord.dryRun, true);
  assert.ok(plan.runRecord.recordChecksum.length > 0);
  // Verify no secret patterns leak
  const recordJson = JSON.stringify(plan.runRecord);
  assert.doesNotMatch(recordJson, /ghp_|ghs_|gho_|ghu_|ghr_/);
  assert.doesNotMatch(recordJson, /openclaw-path|root.*\.openclaw/);
});

test("buildTeam1DispatchPlan is deterministic: same inputs same run record", () => {
  const first = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);
  const second = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);

  assert.deepEqual(first.runRecord, second.runRecord);
});

// ── Worker model policy ────────────────────────────────────────────────────

test("resolveTeam1WorkerModelPolicy keeps the current fleet baseline as the default (#766)", () => {
  const policy = resolveTeam1WorkerModelPolicy(BASE_ROUND_SPEC);

  assert.equal(policy.selectedModel, "openai-codex/gpt-5.5");
  assert.equal(policy.escalatedToPro, false);
  assert.equal(policy.env.A2A_OPENCLAW_MODEL, "openai-codex/gpt-5.5");
});

test("resolveTeam1WorkerModelPolicy escalates broad inspection to Pro", () => {
  const policy = resolveTeam1WorkerModelPolicy({
    ...BASE_ROUND_SPEC,
    modelEscalation: { reasons: ["broad_source_inspection", "no_change_evidence_salvage"] },
  });

  assert.equal(policy.selectedModel, "deepseek/deepseek-v4-pro");
  assert.equal(policy.escalatedToPro, true);
  assert.deepEqual(policy.reasons, ["broad_source_inspection", "no_change_evidence_salvage"]);
  assert.equal(policy.boundary, "per-task model override only; no default change, restart, deploy, or credential change");
});

test("buildTeam1DispatchPlan records per-task Pro model env", () => {
  const plan = buildTeam1DispatchPlan({
    ...BASE_ROUND_SPEC,
    tags: { contextHeavy: "true" },
  }, undefined, true);

  assert.equal(plan.modelPolicy.selectedModel, "deepseek/deepseek-v4-pro");
  assert.equal(plan.metadata.workerModel, "deepseek/deepseek-v4-pro");
  assert.equal(plan.metadata.workerModelEscalatedToPro, true);
  assert.equal(plan.runRecord.metadata.workerModelEscalationReasons, "context_heavy");
  assert.deepEqual(plan.modelPolicy.env, { A2A_OPENCLAW_MODEL: "deepseek/deepseek-v4-pro" });
  assert.ok(plan.dispatchActions.some((a) => a.includes("A2A_OPENCLAW_MODEL=deepseek/deepseek-v4-pro")));
});

// ── Markdown rendering ──────────────────────────────────────────────────────

test("renderTeam1DispatchPlanMarkdown produces readable output", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);
  const markdown = renderTeam1DispatchPlanMarkdown(plan);

  assert.match(markdown, /Team1 Dispatch Plan/);
  assert.match(markdown, /Deterministic task ID/);
  assert.match(markdown, /Preflight results/);
  assert.match(markdown, /Worker model policy/);
  assert.match(markdown, /Decision/);
  assert.match(markdown, /Parent\/child metadata/);
  assert.match(markdown, /Safety boundaries/);
  assert.doesNotMatch(markdown, /secret value|private path|ghp_|ghs_|openclaw-path/i);
});

test("renderTeam1DispatchPlanMarkdown shows blocked state correctly", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, { dryRun: true, execute: false, preflightEnabled: true }, false);
  const markdown = renderTeam1DispatchPlanMarkdown(plan);

  assert.match(markdown, /blocked/);
  assert.match(markdown, /Blockers/);
});

// ── Safety: fail-closed approval boundary ────────────────────────────────────

test("fail-closed: dry-run blocks all write dispatch actions", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, { dryRun: true, execute: false, preflightEnabled: true }, true);

  assert.equal(plan.config.dryRun, true);
  // Dry-run mode should have a dry-run action (not a createTask action)
  assert.ok(plan.dispatchActions.some((a) => a.includes("dry-run")));
  assert.ok(plan.dispatchActions.some((a) => a.includes("dry-run")));
  // No write actions in dry-run
  assert.equal(plan.dispatchActions.filter((a) => a.includes("createTask")).length, 0);
});

test("fail-closed: worker capability failure blocks dispatch", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, { dryRun: false, execute: true, preflightEnabled: true }, false);

  // Even with execute=true, preflight failures should block
  assert.equal(plan.decision.value, "blocked");
  assert.ok(plan.dispatchActions.some((a) => a.includes("blocked")));
});

test("fail-closed: approval boundary warn with execute mode and work-mode evidence", () => {
  const plan = buildTeam1DispatchPlan(
    { ...BASE_ROUND_SPEC, workModeDecision: validTeam1DecisionEvidence() },
    { dryRun: false, execute: true, preflightEnabled: true },
    true,
  );

  assert.equal(plan.decision.value, "warn_go");
  assert.ok(plan.decision.warnings.some((w) => w.includes("approval_boundary_respected")));
});

// ── Safety: no-live / source-only ───────────────────────────────────────────

test("safety: plan claims no-live and source-only", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);

  assert.equal(plan.metadata.noLiveImpact, true);
  assert.equal(plan.metadata.sourceOnly, true);
});

// ── Idempotency guard ───────────────────────────────────────────────────────

test("idempotency: same run spec produces identical taskId", () => {
  const spec = { ...BASE_ROUND_SPEC };
  const planA = buildTeam1DispatchPlan(spec, undefined, true);
  const planB = buildTeam1DispatchPlan(spec, undefined, true);

  assert.equal(planA.deterministicTaskId.taskId, planB.deterministicTaskId.taskId);
  assert.equal(planA.runRecord.taskId, planB.runRecord.taskId);
});

test("idempotency: different run specs produce different taskIds", () => {
  const planA = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);
  const planB = buildTeam1DispatchPlan({ ...BASE_ROUND_SPEC, worker: "workerepsilon" }, undefined, true);

  assert.notEqual(planA.deterministicTaskId.taskId, planB.deterministicTaskId.taskId);
});

// ── Edge cases ──────────────────────────────────────────────────────────────

test("edge case: empty runId fails preflight", () => {
  const results = runTeam1PreflightChecks(
    { ...BASE_ROUND_SPEC, runId: "" },
    { dryRun: true, execute: false, preflightEnabled: true },
    true,
  );
  const idCheck = results.find((r) => r.checkId === "run_id_deterministic");
  assert.ok(idCheck);
  assert.equal(idCheck.status, "fail");
});

test("edge case: non-GitHub parent URL fails preflight", () => {
  const results = runTeam1PreflightChecks(
    { ...BASE_ROUND_SPEC, parentIssueUrl: "https://example.com/issues/1" },
    { dryRun: true, execute: false, preflightEnabled: true },
    true,
  );
  const parentCheck = results.find((r) => r.checkId === "parent_issue_reachable");
  assert.ok(parentCheck);
  assert.equal(parentCheck.status, "fail");
});

// ── Worker model/thinking overrides ─────────────────────────────────────────

test("resolveTeam1WorkerModelPolicy includes selectedThinking default low", () => {
  const policy = resolveTeam1WorkerModelPolicy(BASE_ROUND_SPEC);
  assert.equal(policy.selectedThinking, "low");
  assert.equal(policy.selectedModel, "openai-codex/gpt-5.5");
});

test("resolveTeam1WorkerModelPolicy respects explicit workerModel override", () => {
  const policy = resolveTeam1WorkerModelPolicy({
    ...BASE_ROUND_SPEC,
    workerModel: "deepseek/deepseek-v4-pro",
  });
  assert.equal(policy.selectedModel, "deepseek/deepseek-v4-pro");
  assert.equal(policy.escalatedToPro, true);
  assert.equal(policy.payloadOverrides.workerModel, "deepseek/deepseek-v4-pro");
});

test("resolveTeam1WorkerModelPolicy respects explicit workerThinking override", () => {
  const policy = resolveTeam1WorkerModelPolicy({
    ...BASE_ROUND_SPEC,
    workerThinking: "high",
  });
  assert.equal(policy.selectedThinking, "high");
  assert.equal(policy.payloadOverrides.workerThinking, "high");
  assert.equal(policy.selectedModel, "openai-codex/gpt-5.5");
});

test("resolveTeam1WorkerModelPolicy combines explicit model and thinking overrides", () => {
  const policy = resolveTeam1WorkerModelPolicy({
    ...BASE_ROUND_SPEC,
    workerModel: "deepseek/deepseek-v4-pro",
    workerThinking: "max",
  });
  assert.equal(policy.selectedModel, "deepseek/deepseek-v4-pro");
  assert.equal(policy.selectedThinking, "max");
  assert.equal(policy.payloadOverrides.workerModel, "deepseek/deepseek-v4-pro");
  assert.equal(policy.payloadOverrides.workerThinking, "max");
});

test("buildTeam1DispatchPlan includes workerThinking in metadata", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);
  assert.equal(plan.metadata.workerThinking, "low");
  assert.ok(plan.dispatchActions.some((a) => a.includes("thinking=low")));
});

test("buildTeam1DispatchPlan records explicit workerModel in dispatch actions", () => {
  const plan = buildTeam1DispatchPlan({
    ...BASE_ROUND_SPEC,
    workerModel: "deepseek/deepseek-v4-pro",
    workerThinking: "high",
  }, undefined, true);
  assert.equal(plan.metadata.workerModel, "deepseek/deepseek-v4-pro");
  assert.equal(plan.metadata.workerThinking, "high");
  assert.equal(plan.runRecord.metadata.workerModelExplicitOverride, "deepseek/deepseek-v4-pro");
  assert.equal(plan.runRecord.metadata.workerThinkingExplicitOverride, "high");
  assert.ok(plan.dispatchActions.some((a) => a.includes("explicit override: workerModel=deepseek/deepseek-v4-pro")));
  assert.ok(plan.dispatchActions.some((a) => a.includes("explicit override: workerThinking=high")));
});

test("buildTeam1DispatchPlan includes payload override fields in run record metadata", () => {
  const plan = buildTeam1DispatchPlan({
    ...BASE_ROUND_SPEC,
    workerModel: "deepseek/deepseek-v4-pro",
    modelEscalation: { reasons: ["context_heavy"] },
  }, undefined, true);
  assert.equal(plan.runRecord.metadata.payloadWorkerModel, "deepseek/deepseek-v4-pro");
  assert.equal(plan.runRecord.metadata.payloadWorkerModelEscalationReasons, "context_heavy");
  assert.equal(plan.modelPolicy.payloadOverrides.workerModel, "deepseek/deepseek-v4-pro");
});

test("markdown renderer includes worker model and thinking", () => {
  const plan = buildTeam1DispatchPlan({
    ...BASE_ROUND_SPEC,
    workerModel: "deepseek/deepseek-v4-pro",
    workerThinking: "medium",
  }, undefined, true);
  const markdown = renderTeam1DispatchPlanMarkdown(plan);
  assert.match(markdown, /Worker thinking/);
  assert.match(markdown, /deepseek\/deepseek-v4-pro/);
  assert.match(markdown, /medium/);
});

test("ALLOWED_WORKER_MODELS accepts known models", () => {
  assert.ok(TEAM1_ALLOWED_WORKER_MODELS.has(TEAM1_DEFAULT_WORKER_MODEL));
  assert.ok(TEAM1_ALLOWED_WORKER_MODELS.has(TEAM1_PRO_ESCALATION_MODEL));
  assert.ok(TEAM1_ALLOWED_WORKER_MODELS.has("openai-codex/gpt-5.5"));
  assert.ok(TEAM1_ALLOWED_WORKER_MODELS.has("gpt-5.5"));
  assert.ok(TEAM1_ALLOWED_WORKER_MODELS.has("grok-4.20"));
  assert.ok(TEAM1_ALLOWED_WORKER_MODELS.has("deepseek-v4-pro"));
  assert.ok(TEAM1_ALLOWED_WORKER_MODELS.has("minimax-m3"));
});

test("resolveTeam1WorkerModelPolicy accepts fleet baseline explicit overrides (#766)", () => {
  for (const workerModel of ["openai-codex/gpt-5.5", "gpt-5.5", "grok-4.20", "deepseek-v4-pro", "minimax-m3"]) {
    const policy = resolveTeam1WorkerModelPolicy({ ...BASE_ROUND_SPEC, workerModel });

    assert.equal(policy.selectedModel, workerModel);
    assert.equal(policy.payloadOverrides.workerModel, workerModel);
    assert.equal(policy.env.A2A_OPENCLAW_MODEL, workerModel);
  }
});

test("ALLOWED_WORKER_THINKING_LEVELS includes known levels", () => {
  assert.ok(TEAM1_ALLOWED_WORKER_THINKING_LEVELS.has("low"));
  assert.ok(TEAM1_ALLOWED_WORKER_THINKING_LEVELS.has("high"));
  assert.ok(TEAM1_ALLOWED_WORKER_THINKING_LEVELS.has("off"));
  assert.ok(TEAM1_ALLOWED_WORKER_THINKING_LEVELS.has("max"));
  assert.ok(TEAM1_ALLOWED_WORKER_THINKING_LEVELS.has("medium"));
});

// ── Round manifest wiring (issue #935) ─────────────────────────────────────

test("buildTeam1RoundManifest produces a valid manifest with deterministic id", () => {
  const result = buildTeam1RoundManifest(
    BASE_ROUND_SPEC,
    { dryRun: true, execute: false, preflightEnabled: true },
  );
  assert.ok(result !== null, "manifest should be non-null for valid URL");
  assert.equal(result.manifest.kind, "a2a-broker.round-manifest");
  assert.equal(result.manifest.version, 1);
  assert.match(result.manifest.manifestId, /^[0-9a-f]{32}$/);
  assert.match(result.manifest.manifestChecksum, /^[0-9a-f]{32}$/);
  assert.notEqual(result.manifest.manifestId, result.manifest.manifestChecksum);
  assert.equal(result.manifest.parentIssue.issueNumber, 847);
  assert.equal(result.manifest.parentIssue.repo, "jinwon-int/a2a-broker");
  assert.equal(result.manifest.teamId, "team1");
  assert.equal(result.manifest.runId, BASE_ROUND_SPEC.runId);
});

test("buildTeam1RoundManifest returns null for non-parseable URLs", () => {
  const result = buildTeam1RoundManifest(
    { ...BASE_ROUND_SPEC, parentIssueUrl: "https://example.com/issues/1" },
    { dryRun: true, execute: false, preflightEnabled: true },
  );
  assert.equal(result, null);
});

test("buildTeam1RoundManifest returns null for non-issue URLs", () => {
  const result = buildTeam1RoundManifest(
    { ...BASE_ROUND_SPEC, parentIssueUrl: "https://github.com/owner/repo/pull/1" },
    { dryRun: true, execute: false, preflightEnabled: true },
  );
  assert.equal(result, null);
});

test("buildTeam1RoundManifest includes expected worker with deterministic taskId", () => {
  const result = buildTeam1RoundManifest(
    BASE_ROUND_SPEC,
    { dryRun: true, execute: false, preflightEnabled: true },
  );
  assert.ok(result !== null);
  assert.equal(result.manifest.expectedWorkers.length, 1);
  const worker = result.manifest.expectedWorkers[0];
  assert.equal(worker.workerId, "workerdelta");
  assert.equal(worker.lane, 2);
  assert.match(worker.taskId ?? "", /^team1-/);
  // Verify taskId matches deterministic ID
  const detTaskId = buildDeterministicTaskId(
    BASE_ROUND_SPEC,
    { dryRun: true, execute: false, preflightEnabled: true },
  );
  assert.equal(worker.taskId, detTaskId.taskId);
});

test("buildTeam1RoundManifest uses fail-closed closeout policy by default", () => {
  const result = buildTeam1RoundManifest(
    BASE_ROUND_SPEC,
    { dryRun: true, execute: false, preflightEnabled: true },
  );
  assert.ok(result !== null);
  assert.equal(result.manifest.closeoutPolicy.automaticCloseout, false);
  assert.equal(result.manifest.closeoutPolicy.automaticFinalizer, false);
  assert.equal(result.manifest.closeoutPolicy.requireAllWorkersComplete, true);
  assert.equal(result.manifest.closeoutPolicy.timeoutOnDeadlineExceeded, false);
  assert.equal(result.manifest.closeoutPolicy.approvalRef, undefined);
});

test("buildTeam1RoundManifest accepts custom closeout policy override", () => {
  const result = buildTeam1RoundManifest(
    BASE_ROUND_SPEC,
    { dryRun: true, execute: false, preflightEnabled: true },
    { automaticCloseout: true, automaticFinalizer: true, approvalRef: "#935-approval" },
  );
  assert.ok(result !== null);
  assert.equal(result.manifest.closeoutPolicy.automaticCloseout, true);
  assert.equal(result.manifest.closeoutPolicy.automaticFinalizer, true);
  assert.equal(result.manifest.closeoutPolicy.approvalRef, "#935-approval");
});

test("buildTeam1RoundManifest includes default evidence policy (pr, done, block)", () => {
  const result = buildTeam1RoundManifest(
    BASE_ROUND_SPEC,
    { dryRun: true, execute: false, preflightEnabled: true },
  );
  assert.ok(result !== null);
  const ep = result.manifest.defaultEvidencePolicy;
  assert.ok(ep !== undefined);
  assert.deepEqual(ep.requiredTypes.sort(), ["block", "done", "pr"]);
  assert.equal(ep.minimumRequired, 1);
});

test("buildTeam1RoundManifest builds deterministic projection", () => {
  const first = buildTeam1RoundManifest(
    BASE_ROUND_SPEC,
    { dryRun: true, execute: false, preflightEnabled: true },
  );
  const second = buildTeam1RoundManifest(
    BASE_ROUND_SPEC,
    { dryRun: true, execute: false, preflightEnabled: true },
  );
  assert.ok(first !== null && second !== null);
  assert.equal(first.manifest.manifestId, second.manifest.manifestId);
  assert.equal(first.manifest.manifestChecksum, second.manifest.manifestChecksum);
  assert.equal(first.projection.manifestId, second.projection.manifestId);
  assert.equal(first.projection.expectedWorkerIds[0], second.projection.expectedWorkerIds[0]);
});

test("buildTeam1RoundManifest changes manifestId for different worker", () => {
  const specA = BASE_ROUND_SPEC;
  const specB = { ...BASE_ROUND_SPEC, worker: "workergamma" };
  const resultA = buildTeam1RoundManifest(specA, { dryRun: true, execute: false, preflightEnabled: true });
  const resultB = buildTeam1RoundManifest(specB, { dryRun: true, execute: false, preflightEnabled: true });
  assert.ok(resultA !== null && resultB !== null);
  assert.notEqual(resultA.manifest.manifestId, resultB.manifest.manifestId);
});

test("buildTeam1RoundManifest changes manifestId for different runId", () => {
  const resultA = buildTeam1RoundManifest(
    BASE_ROUND_SPEC,
    { dryRun: true, execute: false, preflightEnabled: true },
  );
  const resultB = buildTeam1RoundManifest(
    { ...BASE_ROUND_SPEC, runId: "a2a-team1-round-20260527T000000Z" },
    { dryRun: true, execute: false, preflightEnabled: true },
  );
  assert.ok(resultA !== null && resultB !== null);
  assert.notEqual(resultA.manifest.manifestId, resultB.manifest.manifestId);
});

test("buildTeam1RoundManifest respects modelEscalationHints", () => {
  const result = buildTeam1RoundManifest(
    {
      ...BASE_ROUND_SPEC,
      modelEscalation: { reasons: ["broad_source_inspection"], forcePro: true },
    },
    { dryRun: true, execute: false, preflightEnabled: true },
  );
  assert.ok(result !== null);
  const worker = result.manifest.expectedWorkers[0];
  assert.equal(worker.modelEscalationHints?.forcePro, true);
  assert.deepEqual(worker.modelEscalationHints?.reasons, ["broad_source_inspection"]);
});

test("buildTeam1RoundManifest accepts deadlineConfig", () => {
  const result = buildTeam1RoundManifest(
    BASE_ROUND_SPEC,
    { dryRun: true, execute: false, preflightEnabled: true },
    undefined,
    { roundDeadlineAt: "2026-05-30T00:00:00.000Z" },
  );
  assert.ok(result !== null);
  assert.equal(result.manifest.deadlineConfig?.roundDeadlineAt, "2026-05-30T00:00:00.000Z");
  assert.equal(result.projection.deadlineConfig?.roundDeadlineAt, "2026-05-30T00:00:00.000Z");
});

// ── Dispatch plan includes round manifest ───────────────────────────────────

test("buildTeam1DispatchPlan includes roundManifest for valid parent URL", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);
  assert.ok(plan.roundManifest !== null, "roundManifest should be present");
  assert.ok(plan.roundManifestProjection !== null, "roundManifestProjection should be present");
  assert.equal(plan.roundManifest.teamId, "team1");
  assert.equal(plan.roundManifest.parentIssue.issueNumber, 847);
  assert.equal(plan.roundManifest.expectedWorkers[0].workerId, "workerdelta");
  assert.match(plan.roundManifest.manifestId, /^[0-9a-f]{32}$/);
});

test("buildTeam1DispatchPlan roundManifest is deterministic for same inputs", () => {
  const planA = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);
  const planB = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);
  assert.ok(planA.roundManifest !== null && planB.roundManifest !== null);
  assert.equal(planA.roundManifest.manifestId, planB.roundManifest.manifestId);
  assert.equal(planA.roundManifest.manifestChecksum, planB.roundManifest.manifestChecksum);
  assert.equal(planA.roundManifestProjection?.manifestChecksum, planB.roundManifestProjection?.manifestChecksum);
});

test("buildTeam1DispatchPlan roundManifest is null for non-parseable URL", () => {
  const plan = buildTeam1DispatchPlan(
    { ...BASE_ROUND_SPEC, parentIssueUrl: "https://example.com/issues/1" },
    undefined,
    true,
  );
  assert.equal(plan.roundManifest, null);
  assert.equal(plan.roundManifestProjection, null);
});

test("buildTeam1DispatchPlan includes manifest actions in dispatchActions", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);
  assert.ok(plan.dispatchActions.some((a) => a.includes("[manifest]")));
  assert.ok(plan.dispatchActions.some((a) => a.includes("round-manifest")));
  assert.ok(plan.dispatchActions.some((a) => a.includes("workers:")));
  assert.ok(plan.dispatchActions.some((a) => a.includes("closeout:")));
});

test("buildTeam1DispatchPlan manifest links to consistent projection", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);
  assert.ok(plan.roundManifest !== null && plan.roundManifestProjection !== null);
  assert.equal(plan.roundManifestProjection.manifestId, plan.roundManifest.manifestId);
  assert.equal(plan.roundManifestProjection.manifestChecksum, plan.roundManifest.manifestChecksum);
  assert.equal(plan.roundManifestProjection.expectedWorkerIds.length, plan.roundManifest.expectedWorkers.length);
  assert.equal(plan.roundManifestProjection.expectedWorkerIds[0], plan.roundManifest.expectedWorkers[0].workerId);
});

test("markdown renderer includes round manifest section", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);
  const md = renderTeam1DispatchPlanMarkdown(plan);
  assert.match(md, /Round manifest/);
  assert.match(md, /Manifest ID/);
  assert.match(md, /Checksum/);
  assert.match(md, /Parent issue/);
  assert.match(md, /Expected workers/);
  assert.match(md, /Closeout policy/);
  assert.match(md, /workerdelta/);
  assert.match(md, /team1-/);
  assert.doesNotMatch(md, /secret value|private path|ghp_|ghs_|openclaw-path/i);
});

test("markdown renderer handles null roundManifest gracefully", () => {
  const plan = buildTeam1DispatchPlan(
    { ...BASE_ROUND_SPEC, parentIssueUrl: "https://example.com/issues/1" },
    undefined,
    true,
  );
  assert.equal(plan.roundManifest, null);
  const md = renderTeam1DispatchPlanMarkdown(plan);
  assert.doesNotMatch(md, /Round manifest/);
  // Should still include other sections
  assert.match(md, /Safety boundaries/);
});

test("roundManifest projection is JSON-serialisable", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);
  assert.ok(plan.roundManifestProjection !== null);
  const json = JSON.stringify(plan.roundManifestProjection);
  const parsed = JSON.parse(json);
  assert.equal(parsed.manifestId, plan.roundManifestProjection.manifestId);
  assert.equal(parsed.expectedWorkerIds[0], "workerdelta");
  assert.equal(parsed.runId, BASE_ROUND_SPEC.runId);
});

test("roundManifest contains lane metadata in projection workerAssignments", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);
  assert.ok(plan.roundManifestProjection !== null);
  const wa = plan.roundManifestProjection.workerAssignments[0];
  assert.equal(wa.workerId, "workerdelta");
  assert.equal(wa.lane, 2);
  assert.ok(wa.taskId !== undefined);
  assert.match(wa.taskId!, /^team1-/);
  assert.ok(wa.requiredEvidenceTypes.includes("pr"));
  assert.ok(wa.requiredEvidenceTypes.includes("done"));
  assert.ok(wa.requiredEvidenceTypes.includes("block"));
});

// ── Read-only audit lane (a2a-broker#953) ──────────────────────────────────

test("read-only audit lane uses evidence-only policy (done, block — no pr)", () => {
  const plan = buildTeam1DispatchPlan(
    { ...BASE_ROUND_SPEC, readOnlyAudit: true },
    undefined,
    true,
  );
  assert.ok(plan.roundManifest !== null);
  const ep = plan.roundManifest.defaultEvidencePolicy;
  assert.ok(ep !== undefined);
  assert.deepEqual(ep.requiredTypes.sort(), ["block", "done"]);
  assert.equal(ep.minimumRequired, 1);
  assert.ok(!ep.requiredTypes.includes("pr"), "read-only audit must not require pr evidence");

  // Verify projection also excludes PR evidence
  assert.ok(plan.roundManifestProjection !== null);
  const wa = plan.roundManifestProjection.workerAssignments[0];
  assert.ok(!wa.requiredEvidenceTypes.includes("pr"), "projection must not require pr evidence");
  assert.ok(wa.requiredEvidenceTypes.includes("done"));
  assert.ok(wa.requiredEvidenceTypes.includes("block"));
});

test("read-only audit lane carries allowNoChanges and readOnlyValidation flags", () => {
  const plan = buildTeam1DispatchPlan(
    { ...BASE_ROUND_SPEC, readOnlyAudit: true },
    undefined,
    true,
  );
  assert.equal(plan.metadata.readOnlyAudit, true);
  assert.equal(plan.metadata.allowNoChanges, true);
  assert.equal(plan.metadata.readOnlyValidation, true);
  assert.equal(plan.taskPayload?.parentRoundTotal, 4);
  assert.equal(plan.taskPayload?.parentRoundOrder, 2);
  assert.equal(plan.taskPayload?.allowNoChanges, true);
  assert.equal(plan.taskPayload?.readOnlyValidation, true);
});

test("read-only audit lane dispatch actions include evidence policy indicators", () => {
  const plan = buildTeam1DispatchPlan(
    { ...BASE_ROUND_SPEC, readOnlyAudit: true },
    undefined,
    true,
  );
  assert.ok(plan.dispatchActions.some((a) => a.includes("read-only audit lane")));
  assert.ok(plan.dispatchActions.some((a) => a.includes("allowNoChanges=true")));
  assert.ok(plan.dispatchActions.some((a) => a.includes("done, block only")));
  assert.ok(plan.dispatchActions.some((a) => a.includes("no PR/diff required")));
});

test("read-only audit lane markdown includes safety boundary flags", () => {
  const plan = buildTeam1DispatchPlan(
    { ...BASE_ROUND_SPEC, readOnlyAudit: true },
    undefined,
    true,
  );
  const md = renderTeam1DispatchPlanMarkdown(plan);
  assert.match(md, /Read-only audit.*Yes/);
  assert.match(md, /Allow no changes.*Yes/);
  assert.match(md, /Read-only validation.*Yes/);
});

test("read-only audit lane runRecord metadata includes read-only flags", () => {
  const plan = buildTeam1DispatchPlan(
    { ...BASE_ROUND_SPEC, readOnlyAudit: true },
    undefined,
    true,
  );
  const mdForDispatch = plan.runRecord.metadata;
  assert.equal(mdForDispatch.readOnlyAudit, "true");
  assert.equal(mdForDispatch.allowNoChanges, "true");
  assert.equal(mdForDispatch.readOnlyValidation, "true");
});

test("normal patch lane (non-readOnlyAudit) preserves fail-closed evidence policy", () => {
  const plan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);
  assert.equal(plan.metadata.readOnlyAudit, false);
  assert.equal(plan.metadata.allowNoChanges, false);
  assert.equal(plan.metadata.readOnlyValidation, false);

  assert.ok(plan.roundManifest !== null);
  const ep = plan.roundManifest.defaultEvidencePolicy;
  assert.ok(ep?.requiredTypes.includes("pr"), "normal patch lane must require pr evidence");
  assert.ok(ep?.requiredTypes.includes("done"));
  assert.ok(ep?.requiredTypes.includes("block"));

  const md = renderTeam1DispatchPlanMarkdown(plan);
  assert.match(md, /Read-only audit.*No/);
});

test("readOnlyAudit=false explicitly produces same evidence policy as default", () => {
  const defaultPlan = buildTeam1DispatchPlan(BASE_ROUND_SPEC, undefined, true);
  const explicitPlan = buildTeam1DispatchPlan(
    { ...BASE_ROUND_SPEC, readOnlyAudit: false },
    undefined,
    true,
  );
  assert.deepEqual(
    defaultPlan.roundManifest?.defaultEvidencePolicy?.requiredTypes.sort(),
    explicitPlan.roundManifest?.defaultEvidencePolicy?.requiredTypes.sort(),
  );
});
