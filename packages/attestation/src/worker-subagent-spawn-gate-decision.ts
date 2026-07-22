import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import { numberValue, optionalBoolean, optionalString } from "./value-text.js";
import { clampParallelism, hasOverlappingWriteSets } from "./worker-subagent-orchestration-policy.js";

// Source-only sub-agent SPAWN GATE decision.
//
// The spawn-authorization-request packet is an evidence DRAFT that is explicitly
// "not an authorization grant and is not a runtime spawn gate", and the
// budget-counter is a non-enforcing counter source. This packet is the missing
// deterministic GATE that consumes both and emits a BINDING authorized/refused
// verdict for a concrete requested spawn — respecting the count budget
// (clampParallelism / hard cap 4), the budget ceiling (shrink-only), the
// Write-Set Rule (disjoint implementer write sets), and the Single-Finalizer
// Rule. It DECIDES only; it does not itself spawn or intercept — a Phase-2
// runtime consults this verdict before an actual spawn (boundaries all false).

const HARD_CAP = 4;

export interface SpawnGateAuthorizationView {
  state?: string;
  workerId?: string;
  taskId?: string;
  idempotencyKey?: string;
  plannerParallelismHint?: number;
  oneFinalizerRequired?: boolean;
  writeSetIsolationRequired?: boolean;
}

export interface SpawnGateBudgetView {
  state?: string;
  spawnBudgetCeiling?: number | null;
  budgetExhausted?: boolean;
  idempotencyKey?: string;
}

export interface SpawnGateRequestedSubagent {
  role: string;
  writeSet?: string[];
}

export interface A2AWorkerSubagentSpawnGateDecisionInput {
  now?: string;
  authorization: SpawnGateAuthorizationView;
  budget?: SpawnGateBudgetView;
  requestedSpawn: {
    subagents: SpawnGateRequestedSubagent[];
  };
}

export interface A2AWorkerSubagentSpawnGateDecisionCheck {
  id:
    | "authorization_ready"
    | "single_finalizer_required"
    | "budget_within_ceiling"
    | "count_within_ceiling"
    | "write_set_isolation";
  status: "pass" | "fail" | "review";
  summary: string;
}

export interface A2AWorkerSubagentSpawnGateDecisionPacket {
  kind: "a2a-broker.worker-subagent-spawn-gate-decision.packet";
  version: 1;
  generatedAt: string;
  sourceOnly: true;
  idempotencyKey: string;
  workerId?: string;
  taskId?: string;
  authorizationIdempotencyKey?: string;
  budgetIdempotencyKey?: string;
  state: "authorized" | "refused";
  disposition: "spawn_authorized" | "spawn_refused";
  requestedSubagentCount: number;
  effectiveCeiling: number;
  authorizedSubagentCount: number;
  checks: A2AWorkerSubagentSpawnGateDecisionCheck[];
  blockers: string[];
  reviews: string[];
  nextActions: string[];
  boundaries: {
    sourceOnly: true;
    liveHostProbe: false;
    plannerRouteCall: false;
    runtimeBehaviorChanged: false;
    mandatoryProductionSpawn: false;
    actualSubagentSpawn: false;
    brokerDispatch: false;
    workerClaim: false;
    executorInvocation: false;
    processSpawn: false;
    taskFlowMutation: false;
    dbMutation: false;
    deployOrRestart: false;
    providerSend: false;
    terminalAckOrReplay: false;
    releaseOrPublish: false;
    secretMovement: false;
  };
  semantics: {
    spawnGateDecisionOnly: true;
    producesBindingVerdict: true;
    enforcesSpawn: false;
    consultedByRuntimeBeforeSpawn: true;
  };
}

export function buildA2AWorkerSubagentSpawnGateDecision(
  input: A2AWorkerSubagentSpawnGateDecisionInput,
): A2AWorkerSubagentSpawnGateDecisionPacket {
  const generatedAt = input.now ?? new Date().toISOString();
  const auth = input.authorization ?? {};
  const budget = input.budget;
  const subagents = input.requestedSpawn?.subagents ?? [];
  const requestedCount = subagents.length;

  const policyCeiling = clampParallelism(auth.plannerParallelismHint ?? 0);
  const budgetBlocks = budget?.budgetExhausted === true || budget?.spawnBudgetCeiling === 0;
  const effectiveCeiling = budgetBlocks ? 0 : policyCeiling;

  const implementerWriteSets = subagents
    .filter((s) => /implementer/i.test(s.role))
    .flatMap((s) => (Array.isArray(s.writeSet) ? s.writeSet : []));
  const writeSetOverlap = hasOverlappingWriteSets(implementerWriteSets);

  const checks = buildChecks({ auth, budget, requestedCount, effectiveCeiling, writeSetOverlap });
  const blockers = checks.filter((c) => c.status === "fail").map((c) => `${c.id}: ${c.summary}`);
  const reviews = checks.filter((c) => c.status === "review").map((c) => `${c.id}: ${c.summary}`);
  const state: A2AWorkerSubagentSpawnGateDecisionPacket["state"] = blockers.length === 0 ? "authorized" : "refused";
  const authorizedSubagentCount = state === "authorized" ? Math.min(requestedCount, effectiveCeiling) : 0;

  return {
    kind: "a2a-broker.worker-subagent-spawn-gate-decision.packet",
    version: 1,
    generatedAt,
    sourceOnly: true,
    idempotencyKey: buildGateDecisionId(input, generatedAt),
    workerId: auth.workerId,
    taskId: auth.taskId,
    authorizationIdempotencyKey: auth.idempotencyKey,
    budgetIdempotencyKey: budget?.idempotencyKey,
    state,
    disposition: state === "authorized" ? "spawn_authorized" : "spawn_refused",
    requestedSubagentCount: requestedCount,
    effectiveCeiling,
    authorizedSubagentCount,
    checks,
    blockers,
    reviews,
    nextActions: nextActionsFor(state, reviews.length > 0),
    boundaries: {
      sourceOnly: true,
      liveHostProbe: false,
      plannerRouteCall: false,
      runtimeBehaviorChanged: false,
      mandatoryProductionSpawn: false,
      actualSubagentSpawn: false,
      brokerDispatch: false,
      workerClaim: false,
      executorInvocation: false,
      processSpawn: false,
      taskFlowMutation: false,
      dbMutation: false,
      deployOrRestart: false,
      providerSend: false,
      terminalAckOrReplay: false,
      releaseOrPublish: false,
      secretMovement: false,
    },
    semantics: {
      spawnGateDecisionOnly: true,
      producesBindingVerdict: true,
      enforcesSpawn: false,
      consultedByRuntimeBeforeSpawn: true,
    },
  };
}

function buildChecks(args: {
  auth: SpawnGateAuthorizationView;
  budget?: SpawnGateBudgetView;
  requestedCount: number;
  effectiveCeiling: number;
  writeSetOverlap: boolean;
}): A2AWorkerSubagentSpawnGateDecisionCheck[] {
  const { auth, budget, requestedCount, effectiveCeiling, writeSetOverlap } = args;
  const checks: A2AWorkerSubagentSpawnGateDecisionCheck[] = [];

  const authReady = auth.state === "authorization_request_draft_ready";
  checks.push({
    id: "authorization_ready",
    status: authReady ? "pass" : "fail",
    summary: authReady
      ? "spawn-authorization-request draft is ready for a gate decision"
      : `spawn-authorization-request state is ${auth.state ?? "missing"} (not draft-ready)`,
  });

  const finalizerOk = auth.oneFinalizerRequired === true;
  checks.push({
    id: "single_finalizer_required",
    status: finalizerOk ? "pass" : "fail",
    summary: finalizerOk
      ? "single-finalizer rule asserted (sub-agents evidence-only)"
      : "single-finalizer rule not asserted by the authorization packet",
  });

  if (!budget) {
    checks.push({
      id: "budget_within_ceiling",
      status: "review",
      summary: "no budget counter supplied; the count budget governs, but token/cost budget is unconfirmed",
    });
  } else if (budget.budgetExhausted === true || budget.spawnBudgetCeiling === 0) {
    checks.push({
      id: "budget_within_ceiling",
      status: "fail",
      summary: "budget exhausted: spawnBudgetCeiling is 0",
    });
  } else if (budget.state === "insufficient-input") {
    checks.push({
      id: "budget_within_ceiling",
      status: "review",
      summary: "budget counter has insufficient input; token/cost budget is unconfirmed",
    });
  } else {
    checks.push({
      id: "budget_within_ceiling",
      status: "pass",
      summary: "within token/cost budget",
    });
  }

  const countOk = requestedCount <= effectiveCeiling && requestedCount <= HARD_CAP;
  checks.push({
    id: "count_within_ceiling",
    status: countOk ? "pass" : "fail",
    summary: countOk
      ? `requested ${requestedCount} <= effective ceiling ${effectiveCeiling} (hard cap ${HARD_CAP})`
      : `requested ${requestedCount} exceeds effective ceiling ${effectiveCeiling} (hard cap ${HARD_CAP})`,
  });

  checks.push({
    id: "write_set_isolation",
    status: writeSetOverlap ? "fail" : "pass",
    summary: writeSetOverlap
      ? "implementer write sets overlap; use one implementer plus a verifier"
      : "implementer write sets are disjoint (or a single implementer)",
  });

  return checks;
}

function nextActionsFor(state: A2AWorkerSubagentSpawnGateDecisionPacket["state"], hasReviews: boolean): string[] {
  if (state === "authorized") {
    const actions = ["a Phase-2 runtime may consult this verdict and spawn up to authorizedSubagentCount, keeping one finalizer"];
    if (hasReviews) actions.push("resolve the review items (e.g. supply a budget counter) to remove unconfirmed constraints");
    return actions;
  }
  return ["do not spawn sub-agents", "resolve the blockers and re-run the gate; zero-subagent direct execution is always allowed"];
}

export function extractA2AWorkerSubagentSpawnGateDecisionInput(input: unknown): A2AWorkerSubagentSpawnGateDecisionInput {
  const envelope = isRecord(input) ? input : {};
  const authRaw = isRecord(envelope.spawnAuthorization)
    ? envelope.spawnAuthorization
    : isRecord(envelope.authorization)
      ? envelope.authorization
      : {};
  const budgetRaw = isRecord(envelope.budgetCounter)
    ? envelope.budgetCounter
    : isRecord(envelope.budget)
      ? envelope.budget
      : undefined;
  const requestedRaw = isRecord(envelope.requestedSpawn) ? envelope.requestedSpawn : {};

  const authSource = isRecord(authRaw.source) ? authRaw.source : {};
  const authFinalizer = isRecord(authRaw.finalizerReview) ? authRaw.finalizerReview : {};
  const authCapacity = isRecord(authFinalizer.capacityConstraints) ? authFinalizer.capacityConstraints : {};

  const authorization: SpawnGateAuthorizationView = {
    state: optionalString(authRaw.state),
    workerId: optionalString(authRaw.workerId ?? authRaw.worker_id),
    taskId: optionalString(authRaw.taskId ?? authRaw.task_id),
    idempotencyKey: optionalString(authRaw.idempotencyKey),
    plannerParallelismHint: numberValue(
      authSource.plannerParallelismHint ?? authCapacity.plannerParallelismHint ?? authRaw.plannerParallelismHint,
    ),
    oneFinalizerRequired: optionalBoolean(authFinalizer.oneFinalizerRequired ?? authRaw.oneFinalizerRequired),
    writeSetIsolationRequired: optionalBoolean(authFinalizer.writeSetIsolationRequired ?? authRaw.writeSetIsolationRequired),
  };

  let budget: SpawnGateBudgetView | undefined;
  if (budgetRaw) {
    const counter = isRecord(budgetRaw.counter) ? budgetRaw.counter : budgetRaw;
    budget = {
      state: optionalString(budgetRaw.state),
      spawnBudgetCeiling: numberOrNull(counter.spawnBudgetCeiling ?? budgetRaw.spawnBudgetCeiling),
      budgetExhausted: optionalBoolean(counter.budgetExhausted ?? budgetRaw.budgetExhausted),
      idempotencyKey: optionalString(budgetRaw.idempotencyKey),
    };
  }

  const subagentsRaw = Array.isArray(requestedRaw.subagents) ? requestedRaw.subagents : [];
  const subagents: SpawnGateRequestedSubagent[] = subagentsRaw
    .filter((s): s is Record<string, unknown> => isRecord(s))
    .map((s) => ({
      role: optionalString(s.role) ?? "",
      writeSet: stringList(s.writeSet ?? s.write_set),
    }));

  return { now: optionalString(envelope.now), authorization, budget, requestedSpawn: { subagents } };
}

export function renderA2AWorkerSubagentSpawnGateDecisionMarkdown(packet: A2AWorkerSubagentSpawnGateDecisionPacket): string {
  return [
    "A2A worker sub-agent spawn gate decision",
    "Worker: " + (packet.workerId ?? "unknown"),
    "Generated: " + packet.generatedAt,
    "State: " + packet.state,
    "Disposition: " + packet.disposition,
    "Requested: " + packet.requestedSubagentCount
      + " | effective ceiling: " + packet.effectiveCeiling
      + " | authorized: " + packet.authorizedSubagentCount,
    "Checks:",
    ...packet.checks.map((c) => "- " + c.id + ": " + c.status + " - " + c.summary),
    "Blockers:",
    ...(packet.blockers.length ? packet.blockers.map((b) => "- " + b) : ["- none"]),
    "Next actions:",
    ...packet.nextActions.map((a) => "- " + a),
    "Safety: source-only spawn gate decision; produces a binding verdict but does not itself spawn sub-agents, dispatch, claim, invoke executors, mutate DB/TaskFlow, deploy/restart, send providers, ACK/replay terminal rows, publish releases, or move secrets.",
  ].join("\n");
}

function buildGateDecisionId(input: A2AWorkerSubagentSpawnGateDecisionInput, generatedAt: string): string {
  const base = JSON.stringify({ input, generatedAt });
  return "a2a-worker-subagent-spawn-gate-decision:" + createHash("sha256").update(base).digest("hex").slice(0, 24);
}

function numberOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  return numberValue(value);
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}
