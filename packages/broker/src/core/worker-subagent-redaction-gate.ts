import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import { numberValue, optionalString } from "./value-text.js";
import { canonicalizeJson } from "../a2a/agent-card-signing.js";
import { redactAndBoundReport } from "./worker-subagent-redaction.js";

// Source-only REDACTION GATE for sub-agent output.
//
// Every sub-agent output is passed through programmatic redaction + a byte bound
// BEFORE the finalizer assembles evidence — not merely requested in a prompt. In
// "redact" mode (default) findings are masked and the cleaned entry is passed
// through; in "reject" mode an entry with a secret finding is excluded from the
// assembled set. Over-budget output is truncated. The cleaned entries feed the
// evidence-assembly packet. Source-only: it cleans/decides, no spawn or mutation.

const DEFAULT_MAX_OUTPUT_CHARS = 4000;

export type A2AWorkerSubagentRedactionMode = "redact" | "reject";
export type A2AWorkerSubagentRedactionVerdict =
  | "clean"
  | "redacted"
  | "truncated"
  | "redacted+truncated"
  | "rejected";

export interface A2AWorkerSubagentRedactionEntryInput {
  role?: string;
  id?: string;
  output: string;
}

export interface A2AWorkerSubagentRedactionGateInput {
  now?: string;
  workerId: string;
  taskId?: string;
  mode?: A2AWorkerSubagentRedactionMode;
  maxOutputChars?: number;
  entries: A2AWorkerSubagentRedactionEntryInput[];
}

export interface A2AWorkerSubagentRedactionResultEntry {
  role?: string;
  id?: string;
  verdict: A2AWorkerSubagentRedactionVerdict;
  redacted: boolean;
  truncated: boolean;
  included: boolean;
  cleaned?: string;
}

export interface A2AWorkerSubagentCleanedEntry {
  role?: string;
  id?: string;
  output: string;
}

export interface A2AWorkerSubagentRedactionGatePacket {
  kind: "a2a-broker.worker-subagent-redaction-gate.packet";
  version: 1;
  generatedAt: string;
  sourceOnly: true;
  idempotencyKey: string;
  workerId: string;
  taskId?: string;
  mode: A2AWorkerSubagentRedactionMode;
  maxOutputChars: number;
  state: "all-clean" | "modified" | "has-rejections";
  summary: {
    total: number;
    clean: number;
    redacted: number;
    truncated: number;
    rejected: number;
    included: number;
  };
  results: A2AWorkerSubagentRedactionResultEntry[];
  cleanedEntries: A2AWorkerSubagentCleanedEntry[];
  determinism: {
    canonicalization: "rfc8785-jcs-v1";
    contentDigest: string;
  };
  semantics: {
    redactionEnforcedProgrammatically: true;
    appliedToEveryOutput: true;
    promptOnly: false;
  };
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
}

function verdictFor(redacted: boolean, truncated: boolean, rejected: boolean): A2AWorkerSubagentRedactionVerdict {
  if (rejected) return "rejected";
  if (redacted && truncated) return "redacted+truncated";
  if (redacted) return "redacted";
  if (truncated) return "truncated";
  return "clean";
}

export function buildA2AWorkerSubagentRedactionGate(
  input: A2AWorkerSubagentRedactionGateInput,
): A2AWorkerSubagentRedactionGatePacket {
  const generatedAt = input.now ?? new Date().toISOString();
  const mode: A2AWorkerSubagentRedactionMode = input.mode === "reject" ? "reject" : "redact";
  const maxOutputChars = input.maxOutputChars && input.maxOutputChars > 0 ? input.maxOutputChars : DEFAULT_MAX_OUTPUT_CHARS;

  const results: A2AWorkerSubagentRedactionResultEntry[] = [];
  const cleanedEntries: A2AWorkerSubagentCleanedEntry[] = [];
  let clean = 0;
  let redactedCount = 0;
  let truncatedCount = 0;
  let rejectedCount = 0;

  for (const entry of input.entries ?? []) {
    const report = redactAndBoundReport(entry.output ?? "", maxOutputChars);
    const rejected = mode === "reject" && report.redacted;
    const included = !rejected;
    const verdict = verdictFor(report.redacted, report.truncated, rejected);

    if (report.redacted) redactedCount += 1;
    if (report.truncated) truncatedCount += 1;
    if (rejected) rejectedCount += 1;
    if (verdict === "clean") clean += 1;

    results.push({
      role: entry.role,
      id: entry.id,
      verdict,
      redacted: report.redacted,
      truncated: report.truncated,
      included,
      cleaned: included ? report.cleaned : undefined,
    });
    if (included) {
      cleanedEntries.push({ role: entry.role, id: entry.id, output: report.cleaned });
    }
  }

  const total = results.length;
  const state: A2AWorkerSubagentRedactionGatePacket["state"] =
    rejectedCount > 0 ? "has-rejections" : redactedCount + truncatedCount > 0 ? "modified" : "all-clean";

  const canonicalBody = { workerId: input.workerId, taskId: input.taskId, mode, maxOutputChars, results, cleanedEntries };
  const contentDigest = "sha256:" + createHash("sha256").update(canonicalizeJson(canonicalBody), "utf8").digest("hex");
  const idempotencyKey = "a2a-worker-subagent-redaction-gate:" + contentDigest.slice("sha256:".length, "sha256:".length + 24);

  return {
    kind: "a2a-broker.worker-subagent-redaction-gate.packet",
    version: 1,
    generatedAt,
    sourceOnly: true,
    idempotencyKey,
    workerId: input.workerId,
    taskId: input.taskId,
    mode,
    maxOutputChars,
    state,
    summary: { total, clean, redacted: redactedCount, truncated: truncatedCount, rejected: rejectedCount, included: cleanedEntries.length },
    results,
    cleanedEntries,
    determinism: {
      canonicalization: "rfc8785-jcs-v1",
      contentDigest,
    },
    semantics: {
      redactionEnforcedProgrammatically: true,
      appliedToEveryOutput: true,
      promptOnly: false,
    },
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
  };
}

export function extractA2AWorkerSubagentRedactionGateInput(input: unknown): A2AWorkerSubagentRedactionGateInput {
  const envelope = isRecord(input) ? input : {};
  const candidate = isRecord(envelope.workerSubagentRedactionGate)
    ? envelope.workerSubagentRedactionGate
    : isRecord(envelope.redactionGate)
      ? envelope.redactionGate
      : envelope;
  if (!isRecord(candidate)) {
    throw new Error("worker subagent redaction gate input must be an object");
  }
  const workerId = optionalString(candidate.workerId ?? candidate.worker_id);
  if (!workerId) throw new Error("worker subagent redaction gate requires workerId");

  const modeRaw = optionalString(candidate.mode);
  const entriesRaw = Array.isArray(candidate.entries) ? candidate.entries : [];
  const entries: A2AWorkerSubagentRedactionEntryInput[] = entriesRaw
    .filter((e): e is Record<string, unknown> => isRecord(e))
    .map((e) => ({
      role: optionalString(e.role),
      id: optionalString(e.id ?? e.idempotencyKey),
      output: optionalString(e.output ?? e.text) ?? "",
    }));

  return {
    now: optionalString(candidate.now),
    workerId,
    taskId: optionalString(candidate.taskId ?? candidate.task_id),
    mode: modeRaw === "reject" ? "reject" : modeRaw === "redact" ? "redact" : undefined,
    maxOutputChars: numberValue(candidate.maxOutputChars ?? candidate.max_output_chars),
    entries,
  };
}

export function renderA2AWorkerSubagentRedactionGateMarkdown(packet: A2AWorkerSubagentRedactionGatePacket): string {
  return [
    "A2A worker sub-agent redaction gate",
    "Worker: " + packet.workerId,
    "Generated: " + packet.generatedAt,
    "Mode: " + packet.mode + " | max output chars: " + packet.maxOutputChars,
    "State: " + packet.state,
    "Summary: total=" + packet.summary.total
      + " clean=" + packet.summary.clean
      + " redacted=" + packet.summary.redacted
      + " truncated=" + packet.summary.truncated
      + " rejected=" + packet.summary.rejected
      + " included=" + packet.summary.included,
    "Results:",
    ...(packet.results.length
      ? packet.results.map((r) => "- " + (r.role ?? "?") + (r.id ? " (" + r.id + ")" : "") + ": " + r.verdict + (r.included ? "" : " [excluded]"))
      : ["- none"]),
    "Digest: " + packet.determinism.contentDigest,
    "Safety: source-only redaction gate; masks/bounds every sub-agent output programmatically before evidence assembly, but does not spawn sub-agents, dispatch, claim, invoke executors, mutate DB/TaskFlow, deploy/restart, send providers, ACK/replay terminal rows, publish releases, or move secrets.",
  ].join("\n");
}
