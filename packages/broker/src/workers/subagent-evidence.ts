/**
 * Sub-agent runtime evidence finalization (#1601 churn-relief slice 3).
 *
 * Extracted verbatim from worker.ts: the finalizeSubagentEvidence block —
 * RuntimeSubagentEvidenceContext, RuntimeSubagentReportEntry, the
 * runtimeRecord/runtimeStringList guards, subagentEvidenceError, and
 * finalizeSubagentEvidence itself. worker.ts keeps calling it unchanged;
 * the compiler guards the moved dependencies.
 */
import {
  buildA2AWorkerSubagentRedactionGate,
  buildA2AWorkerSubagentEvidenceAssembly,
  type A2AWorkerSubagentRedactionMode,
} from "a2a-attestation";
import type { TaskResult } from "../core/types.js";
import type { WorkerHandlerOutcome } from "../worker.js";

/**
 * Close the conductor evidence loop. Legacy count-only reports keep their
 * additive budget annotation. An authorized fanout report must carry bounded
 * helper entries; those entries are bound to the broker-owned plan, redacted,
 * and deterministically assembled before the TaskResult can be completed or
 * signed. Raw helper entries never survive in the returned TaskResult.
 */
export interface RuntimeSubagentEvidenceContext {
  fanoutEnabled: boolean;
  workerId: string;
  taskId: string;
  planJson?: string;
  maxOutputBytes: number;
  redactionMode: A2AWorkerSubagentRedactionMode;
}

interface RuntimeSubagentReportEntry {
  role: string;
  id: string;
  writeSet: string[];
  status: string;
  output: string;
  preRedacted: boolean;
  preTruncated: boolean;
}

function runtimeRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function runtimeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return items.length === value.length ? items : undefined;
}

function subagentEvidenceError(code: string, message: string, details: Record<string, unknown>): WorkerHandlerOutcome {
  return { error: { code, message, details } };
}

export function finalizeSubagentEvidence(
  result: TaskResult,
  directiveBudget: number | null,
  command: string,
  runtimeContext?: RuntimeSubagentEvidenceContext,
): WorkerHandlerOutcome {
  const output = result.output;
  const report = runtimeRecord(output) ? output.subagentReport : undefined;
  const fanoutEnabled = runtimeContext?.fanoutEnabled === true;

  if (report === undefined) {
    if (fanoutEnabled) {
      return subagentEvidenceError(
        "subagent_report_missing",
        "authorized fanout handler result must include subagentReport",
        { command, taskId: runtimeContext.taskId, workerId: runtimeContext.workerId },
      );
    }
    return { result };
  }
  if (!runtimeRecord(report)) {
    return subagentEvidenceError(
      "subagent_report_invalid",
      "subagentReport must be an object",
      { command, fanoutEnabled },
    );
  }

  const reported = Number(report.count);
  if (!Number.isInteger(reported) || reported < 0) {
    return subagentEvidenceError(
      "subagent_report_invalid",
      "subagentReport.count must be a non-negative integer",
      { command, fanoutEnabled },
    );
  }
  if (directiveBudget !== null && reported > directiveBudget) {
    return subagentEvidenceError(
      "subagent_budget_exceeded",
      `handler reported ${reported} subagents but the conductor budget for this task was ${directiveBudget}`,
      { command, budget: directiveBudget, reported },
    );
  }

  if (!fanoutEnabled) {
    if (report.entries !== undefined) {
      return subagentEvidenceError(
        "subagent_report_entries_without_authorized_fanout",
        "subagentReport.entries require broker-authorized fanout",
        { command, reported },
      );
    }
    return {
      result: {
        ...result,
        output: {
          ...(output as Record<string, unknown>),
          subagentReport: {
            count: reported,
            budget: directiveBudget,
            withinBudget: true,
          },
        },
      },
    };
  }

  if (!runtimeContext?.planJson || directiveBudget === null) {
    return subagentEvidenceError(
      "subagent_runtime_plan_missing",
      "authorized fanout result is missing its broker runtime plan",
      { command, reported },
    );
  }
  let plan: Record<string, unknown>;
  try {
    const parsed = JSON.parse(runtimeContext.planJson) as unknown;
    if (!runtimeRecord(parsed)) throw new Error("plan must be an object");
    plan = parsed;
  } catch {
    return subagentEvidenceError(
      "subagent_runtime_plan_invalid",
      "authorized fanout runtime plan is invalid",
      { command, reported },
    );
  }
  if (
    plan.state !== "authorized"
    || plan.workerId !== runtimeContext.workerId
    || plan.taskId !== runtimeContext.taskId
    || Number(plan.authorizedSubagentCount) !== directiveBudget
    || typeof plan.gateDecisionIdempotencyKey !== "string"
    || plan.gateDecisionIdempotencyKey.length === 0
    || typeof plan.budgetCounterIdempotencyKey !== "string"
    || plan.budgetCounterIdempotencyKey.length === 0
  ) {
    return subagentEvidenceError(
      "subagent_runtime_plan_binding_invalid",
      "fanout runtime plan is not bound to this worker/task/budget",
      { command, taskId: runtimeContext.taskId, workerId: runtimeContext.workerId, reported },
    );
  }

  const authorizedRoles = runtimeStringList(plan.authorizedRoles);
  const assignmentsRaw = Array.isArray(plan.authorizedAssignments) ? plan.authorizedAssignments : undefined;
  if (!authorizedRoles || !assignmentsRaw || authorizedRoles.length !== directiveBudget) {
    return subagentEvidenceError(
      "subagent_runtime_plan_invalid",
      "fanout runtime plan is missing its authorized roster",
      { command, reported, budget: directiveBudget },
    );
  }
  if (assignmentsRaw.length !== authorizedRoles.length) {
    return subagentEvidenceError(
      "subagent_runtime_plan_invalid",
      "fanout runtime plan assignments must cover the authorized roster",
      { command, reported },
    );
  }
  const assignments = new Map<string, string[]>();
  for (const candidate of assignmentsRaw) {
    if (!runtimeRecord(candidate) || typeof candidate.role !== "string" || !authorizedRoles.includes(candidate.role)) {
      return subagentEvidenceError(
        "subagent_runtime_plan_invalid",
        "fanout runtime plan contains an invalid assignment",
        { command, reported },
      );
    }
    const writeSet = candidate.writeSet === undefined ? [] : runtimeStringList(candidate.writeSet);
    if (!writeSet || assignments.has(candidate.role)) {
      return subagentEvidenceError(
        "subagent_runtime_plan_invalid",
        "fanout runtime plan assignments must have unique roles and valid write sets",
        { command, reported },
      );
    }
    assignments.set(candidate.role, writeSet);
  }
  if (assignments.size !== authorizedRoles.length) {
    return subagentEvidenceError(
      "subagent_runtime_plan_invalid",
      "fanout runtime plan assignments must cover the authorized roster",
      { command, reported },
    );
  }

  const entriesRaw = report.entries;
  if (!Array.isArray(entriesRaw) || entriesRaw.length !== reported) {
    return subagentEvidenceError(
      "subagent_report_entries_invalid",
      "subagentReport.entries length must equal count",
      { command, reported, entries: Array.isArray(entriesRaw) ? entriesRaw.length : null },
    );
  }
  const seenIds = new Set<string>();
  const seenRoles = new Set<string>();
  const entries: RuntimeSubagentReportEntry[] = [];
  for (const [index, candidate] of entriesRaw.entries()) {
    if (!runtimeRecord(candidate)) {
      return subagentEvidenceError(
        "subagent_report_entries_invalid",
        "each subagentReport entry must be an object",
        { command, reported, index },
      );
    }
    const role = typeof candidate.role === "string" ? candidate.role.trim() : "";
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const status = typeof candidate.status === "string" ? candidate.status.trim().toLowerCase() : "complete";
    const outputText = typeof candidate.output === "string" ? candidate.output : undefined;
    const preRedacted = candidate.redacted === true || candidate.redactionChanged === true;
    const preTruncated = candidate.truncated === true || candidate.outputTruncated === true;
    const writeSet = candidate.writeSet === undefined ? [] : runtimeStringList(candidate.writeSet);
    if (!authorizedRoles.includes(role) || !assignments.has(role)) {
      return subagentEvidenceError(
        "subagent_report_unauthorized_role",
        "subagentReport entry role was not authorized by the broker plan",
        { command, reported, index },
      );
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id) || seenIds.has(id)) {
      return subagentEvidenceError(
        "subagent_report_invalid_id",
        "subagentReport entry id must be unique and bounded",
        { command, reported, index },
      );
    }
    if (seenRoles.has(role)) {
      return subagentEvidenceError(
        "subagent_report_duplicate_role",
        "subagentReport may use each broker-authorized role at most once",
        { command, reported, index },
      );
    }
    if (!writeSet || writeSet.some((path) => !assignments.get(role)?.includes(path))) {
      return subagentEvidenceError(
        "subagent_report_write_set_exceeded",
        "subagentReport entry exceeded its broker-authorized write set",
        { command, reported, index },
      );
    }
    if (!new Set(["complete", "blocked", "failed", "skipped"]).has(status) || outputText === undefined) {
      return subagentEvidenceError(
        "subagent_report_entries_invalid",
        "subagentReport entries require a valid status and string output",
        { command, reported, index },
      );
    }
    seenIds.add(id);
    seenRoles.add(role);
    entries.push({ role, id, writeSet, status, output: outputText, preRedacted, preTruncated });
  }

  entries.sort((left, right) => left.role.localeCompare(right.role) || left.id.localeCompare(right.id));

  const redaction = buildA2AWorkerSubagentRedactionGate({
    workerId: runtimeContext.workerId,
    taskId: runtimeContext.taskId,
    mode: runtimeContext.redactionMode,
    maxOutputBytes: runtimeContext.maxOutputBytes,
    entries,
  });
  if (runtimeContext.redactionMode === "reject" && redaction.summary.rejected > 0) {
    return subagentEvidenceError(
      "subagent_evidence_rejected",
      "one or more helper outputs were rejected by the runtime redaction gate",
      {
        command,
        reported,
        rejected: redaction.summary.rejected,
        redactionDigest: redaction.determinism.contentDigest,
      },
    );
  }

  const assembledEntries = redaction.results.flatMap((redactionResult, index) => {
    if (!redactionResult.included || redactionResult.cleaned === undefined) return [];
    const source = entries[index];
    return [{
      role: source.role,
      id: source.id,
      writeSet: source.writeSet,
      status: source.status,
      summary: redactionResult.cleaned,
    }];
  });
  const assembly = buildA2AWorkerSubagentEvidenceAssembly({
    workerId: runtimeContext.workerId,
    taskId: runtimeContext.taskId,
    finalizer: "broker-worker-finalizer",
    entries: assembledEntries,
    execution: {
      gateDecisionIdempotencyKey: typeof plan.gateDecisionIdempotencyKey === "string" ? plan.gateDecisionIdempotencyKey : undefined,
      budgetCounterIdempotencyKey: typeof plan.budgetCounterIdempotencyKey === "string" ? plan.budgetCounterIdempotencyKey : undefined,
      authorizedSubagentCount: directiveBudget,
      parallelismUsed: reported,
    },
  });

  const safeReport = {
    count: reported,
    roles: entries.map((entry) => entry.role),
    writeSets: entries.map((entry) => entry.writeSet),
    budget: directiveBudget,
    withinBudget: true,
    runtimeEvidenceRef: assembly.idempotencyKey,
  };
  return {
    result: {
      ...result,
      output: {
        ...(output as Record<string, unknown>),
        subagentReport: safeReport,
        subagentEvidence: {
          kind: "a2a-broker.worker-subagent-runtime-evidence",
          version: 1,
          workerId: runtimeContext.workerId,
          taskId: runtimeContext.taskId,
          state: redaction.state === "has-rejections" ? "blocked" : "assembled",
          redaction,
          assembly,
          runtime: {
            enforced: true,
            fanoutEnabled: true,
            actualSubagentCount: reported,
            maxOutputBytes: runtimeContext.maxOutputBytes,
            redactionMode: runtimeContext.redactionMode,
          },
        },
      },
    },
  };
}
