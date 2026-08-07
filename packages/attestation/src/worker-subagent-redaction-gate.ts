import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import { numberValue, optionalString } from "./value-text.js";
import { canonicalizeJson } from "./agent-card-signing.js";
import { redactAndBoundReport } from "./worker-subagent-redaction.js";

// Source-only REDACTION GATE for sub-agent output.
//
// Every sub-agent output is passed through programmatic redaction + a byte bound
// BEFORE the finalizer assembles evidence — not merely requested in a prompt. In
// "redact" mode (default) findings are masked and the cleaned entry is passed
// through; in "reject" mode an entry with a secret finding is excluded from the
// assembled set. Over-budget output is truncated. The cleaned entries feed the
// evidence-assembly packet. Source-only: it cleans/decides, no spawn or mutation.

const DEFAULT_MAX_OUTPUT_BYTES = 4000;

/**
 * Longest marker suffix this gate will recognise inside `<redacted-...>`.
 *
 * The unbounded form `<redacted(?:-[^>]+)?>` is a polynomial ReDoS
 * (CodeQL js/polynomial-redos, alert #26) because the test below is unanchored
 * and runs against untrusted subagent output: for input like `"<redacted-"`
 * repeated with no closing `>`, every start position rescans to end of string.
 * Measured on the pre-fix expression — 2x input, 4x time, deterministically:
 *
 *   20,000 chars ->    46ms      160,000 chars ->  3,096ms
 *   40,000 chars ->   193ms      320,000 chars -> 12,420ms
 *   80,000 chars ->   773ms      640,000 chars -> 49,960ms
 *
 * That is an event-loop stall, not just a slow task: the gate is called
 * synchronously from the broker worker (packages/broker/src/worker.ts), and
 * `maxOutputBytes` does not protect this line — it bounds redactAndBoundReport,
 * while this test reads the raw `entry.output`.
 *
 * The bound is deliberately generous rather than tight. Every marker this repo
 * emits is a fixed string literal in a `.replace()` call; the longest suffix in
 * the whole tree is `non-http-evidence` (17 chars). 64 leaves >3.7x headroom, so
 * narrowing the quantifier cannot make the gate miss a marker it used to catch —
 * which matters, because a missed marker would let already-redacted output be
 * scored `clean` instead of `redacted`.
 */
const MAX_REDACTION_MARKER_SUFFIX = 64;

const REDACTION_MARKER_PATTERN = new RegExp(
  "(?:\\[redacted\\]|<redacted(?:-[^>]{1," + MAX_REDACTION_MARKER_SUFFIX + "})?>|<private-dir>|<openclaw-dir>|<openclaw-workspace>)",
  "i",
);

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
  /** True when an upstream trusted transport already masked a finding. */
  preRedacted?: boolean;
  /** True when an upstream trusted transport already byte-truncated output. */
  preTruncated?: boolean;
}

export interface A2AWorkerSubagentRedactionGateInput {
  now?: string;
  workerId: string;
  taskId?: string;
  mode?: A2AWorkerSubagentRedactionMode;
  maxOutputBytes?: number;
  /** @deprecated Use maxOutputBytes. Kept as an input compatibility alias. */
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
  maxOutputBytes: number;
  /** @deprecated Equal to maxOutputBytes for packet compatibility. */
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
  const requestedLimit = input.maxOutputBytes ?? input.maxOutputChars;
  const maxOutputBytes = Number.isFinite(requestedLimit) && Number(requestedLimit) > 0
    ? Math.min(64 * 1024, Math.floor(Number(requestedLimit)))
    : DEFAULT_MAX_OUTPUT_BYTES;

  const results: A2AWorkerSubagentRedactionResultEntry[] = [];
  const cleanedEntries: A2AWorkerSubagentCleanedEntry[] = [];
  let clean = 0;
  let redactedCount = 0;
  let truncatedCount = 0;
  let rejectedCount = 0;

  for (const entry of input.entries ?? []) {
    const report = redactAndBoundReport(entry.output ?? "", maxOutputBytes);
    const markerDetected = REDACTION_MARKER_PATTERN.test(entry.output ?? "");
    const redacted = report.redacted || entry.preRedacted === true || markerDetected;
    const truncated = report.truncated || entry.preTruncated === true;
    const rejected = mode === "reject" && redacted;
    const included = !rejected;
    const verdict = verdictFor(redacted, truncated, rejected);

    if (redacted) redactedCount += 1;
    if (truncated) truncatedCount += 1;
    if (rejected) rejectedCount += 1;
    if (verdict === "clean") clean += 1;

    results.push({
      role: entry.role,
      id: entry.id,
      verdict,
      redacted,
      truncated,
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

  const canonicalBody = { workerId: input.workerId, taskId: input.taskId, mode, maxOutputBytes, results, cleanedEntries };
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
    maxOutputBytes,
    maxOutputChars: maxOutputBytes,
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
      preRedacted: e.preRedacted === true || e.pre_redacted === true,
      preTruncated: e.preTruncated === true || e.pre_truncated === true,
    }));

  return {
    now: optionalString(candidate.now),
    workerId,
    taskId: optionalString(candidate.taskId ?? candidate.task_id),
    mode: modeRaw === "reject" ? "reject" : modeRaw === "redact" ? "redact" : undefined,
    maxOutputBytes: numberValue(candidate.maxOutputBytes ?? candidate.max_output_bytes),
    maxOutputChars: numberValue(candidate.maxOutputChars ?? candidate.max_output_chars),
    entries,
  };
}

export function renderA2AWorkerSubagentRedactionGateMarkdown(packet: A2AWorkerSubagentRedactionGatePacket): string {
  return [
    "A2A worker sub-agent redaction gate",
    "Worker: " + packet.workerId,
    "Generated: " + packet.generatedAt,
    "Mode: " + packet.mode + " | max output bytes: " + packet.maxOutputBytes,
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
