import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import { numberValue, optionalString } from "./value-text.js";
import { canonicalizeJson } from "../a2a/agent-card-signing.js";

// Source-only shared CONTEXT BRIEF for sub-agent fanout.
//
// The dominant fanout cost is token-volume amplification: N sub-agents each
// re-read the repo/issue context. The finalizer explores ONCE and produces this
// curated, redacted brief; each sub-agent READS it instead of re-exploring —
// turning N explorations into 1 exploration + N cheap brief-reads.
//
// Correctness discipline baked in:
//   - the brief is NOT a write-time source of truth: implementers must read the
//     live file immediately before editing (default invariant below);
//   - carries precise file:line POINTERS so a sub-agent fetches the exact thing
//     it needs (with source fallback), not a re-exploration;
//   - REDACTION-mandatory + byte-bounded on every free-text field (composes with
//     the redaction gate);
//   - content-addressed JCS digest (determinism synergy).
// It builds a brief only — no spawn, dispatch, or mutation (boundaries false).

const DEFAULT_MAX_FIELD_CHARS = 2000;
const REDACTED = "[redacted]";

const DEFAULT_INVARIANTS = [
  "Single-finalizer: exactly one finalizer owns the terminal result; sub-agents are evidence-only.",
  "Write-Set Rule: implementer write sets must be disjoint; overlap => one implementer plus a verifier.",
  "This brief is shared understanding + pointers, NOT a write-time source of truth: read the live file immediately before editing it.",
  "Redaction-mandatory: never emit secrets, tokens, credentials, provider/host identifiers, or raw session dumps.",
];

export interface A2AWorkerSubagentContextPointer {
  path: string;
  lines?: string;
  note?: string;
}

export interface A2AWorkerSubagentRoleAssignment {
  role: string;
  objective?: string;
  writeSet?: string[];
  pointers?: A2AWorkerSubagentContextPointer[];
}

export interface A2AWorkerSubagentContextBriefInput {
  now?: string;
  workerId: string;
  taskId?: string;
  finalizer?: string;
  summary?: string;
  assignments?: A2AWorkerSubagentRoleAssignment[];
  pointers?: A2AWorkerSubagentContextPointer[];
  acceptanceCriteria?: string[];
  invariants?: string[];
  maxFieldChars?: number;
}

export interface A2AWorkerSubagentContextBriefPacket {
  kind: "a2a-broker.worker-subagent-context-brief.packet";
  version: 1;
  generatedAt: string;
  sourceOnly: true;
  idempotencyKey: string;
  workerId: string;
  taskId?: string;
  finalizer: string;
  summary?: string;
  assignments: A2AWorkerSubagentRoleAssignment[];
  pointers: A2AWorkerSubagentContextPointer[];
  acceptanceCriteria: string[];
  invariants: string[];
  redaction: {
    redactionApplied: true;
    byteBounded: true;
    maxFieldChars: number;
  };
  determinism: {
    canonicalization: "rfc8785-jcs-v1";
    contentDigest: string;
  };
  usage: {
    readInsteadOfReExploring: true;
    pointersEnableCheapFetch: true;
    readLiveFileBeforeEditing: true;
    notAWriteTimeSourceOfTruth: true;
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

// Programmatic secret redaction + byte bound, consistent with the repo's
// established redactors (round-status redactSensitiveText, patch-bridge
// redactSecrets): masks bearer/auth, KEY=VALUE secrets, URL and JSON secret
// values, token-shaped and gh-token strings, then bounds the length.
export function redactAndBound(value: string, maxChars: number): string {
  const redacted = value
    .replace(/(Authorization:\s*Bearer\s+)[^\s,;]+/gi, "$1" + REDACTED)
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+/g, REDACTED)
    .replace(/\b(TOKEN|SECRET|KEY|PASSWORD|API[_-]?KEY|APIKEY|ACCESS_TOKEN|EDGE_SECRET)=([^\s,;&]+)/gi, "$1=" + REDACTED)
    .replace(/([?&](?:token|access_token|api_key|apikey|secret|key|password)=)[^&\s,;]+/gi, "$1" + REDACTED)
    .replace(/((?:"|')?(?:token|access_token|api_key|apikey|secret|key|password)(?:"|')?\s*:\s*(?:"|')?)[^"'\s,;}]+/gi, "$1" + REDACTED)
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, REDACTED);
  return redacted.length > maxChars ? redacted.slice(0, maxChars) : redacted;
}

function redactOptional(value: string | undefined, maxChars: number): string | undefined {
  return value === undefined ? undefined : redactAndBound(value, maxChars);
}

function redactPointer(p: A2AWorkerSubagentContextPointer, maxChars: number): A2AWorkerSubagentContextPointer {
  return {
    path: redactAndBound(p.path, maxChars),
    lines: p.lines,
    note: redactOptional(p.note, maxChars),
  };
}

export function buildA2AWorkerSubagentContextBrief(
  input: A2AWorkerSubagentContextBriefInput,
): A2AWorkerSubagentContextBriefPacket {
  const generatedAt = input.now ?? new Date().toISOString();
  const finalizer = input.finalizer ?? "worker-or-broker-finalizer";
  const maxFieldChars = input.maxFieldChars && input.maxFieldChars > 0 ? input.maxFieldChars : DEFAULT_MAX_FIELD_CHARS;

  const summary = redactOptional(input.summary, maxFieldChars);
  const assignments: A2AWorkerSubagentRoleAssignment[] = (input.assignments ?? []).map((a) => ({
    role: a.role,
    objective: redactOptional(a.objective, maxFieldChars),
    writeSet: Array.isArray(a.writeSet) ? a.writeSet : undefined,
    pointers: Array.isArray(a.pointers) ? a.pointers.map((p) => redactPointer(p, maxFieldChars)) : undefined,
  }));
  const pointers = (input.pointers ?? []).map((p) => redactPointer(p, maxFieldChars));
  const acceptanceCriteria = (input.acceptanceCriteria ?? []).map((c) => redactAndBound(c, maxFieldChars));
  const invariants = (input.invariants && input.invariants.length > 0 ? input.invariants : DEFAULT_INVARIANTS).map((i) =>
    redactAndBound(i, maxFieldChars),
  );

  const canonicalBody = {
    workerId: input.workerId,
    taskId: input.taskId,
    finalizer,
    summary,
    assignments,
    pointers,
    acceptanceCriteria,
    invariants,
    maxFieldChars,
  };
  const contentDigest = "sha256:" + createHash("sha256").update(canonicalizeJson(canonicalBody), "utf8").digest("hex");
  const idempotencyKey = "a2a-worker-subagent-context-brief:" + contentDigest.slice("sha256:".length, "sha256:".length + 24);

  return {
    kind: "a2a-broker.worker-subagent-context-brief.packet",
    version: 1,
    generatedAt,
    sourceOnly: true,
    idempotencyKey,
    workerId: input.workerId,
    taskId: input.taskId,
    finalizer,
    summary,
    assignments,
    pointers,
    acceptanceCriteria,
    invariants,
    redaction: {
      redactionApplied: true,
      byteBounded: true,
      maxFieldChars,
    },
    determinism: {
      canonicalization: "rfc8785-jcs-v1",
      contentDigest,
    },
    usage: {
      readInsteadOfReExploring: true,
      pointersEnableCheapFetch: true,
      readLiveFileBeforeEditing: true,
      notAWriteTimeSourceOfTruth: true,
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

export function extractA2AWorkerSubagentContextBriefInput(input: unknown): A2AWorkerSubagentContextBriefInput {
  const envelope = isRecord(input) ? input : {};
  const candidate = isRecord(envelope.workerSubagentContextBrief)
    ? envelope.workerSubagentContextBrief
    : isRecord(envelope.contextBrief)
      ? envelope.contextBrief
      : envelope;
  if (!isRecord(candidate)) {
    throw new Error("worker subagent context brief input must be an object");
  }
  const workerId = optionalString(candidate.workerId ?? candidate.worker_id);
  if (!workerId) throw new Error("worker subagent context brief requires workerId");

  return {
    now: optionalString(candidate.now),
    workerId,
    taskId: optionalString(candidate.taskId ?? candidate.task_id),
    finalizer: optionalString(candidate.finalizer),
    summary: optionalString(candidate.summary),
    assignments: Array.isArray(candidate.assignments)
      ? candidate.assignments.filter(isRecord).map(extractAssignment)
      : undefined,
    pointers: Array.isArray(candidate.pointers)
      ? candidate.pointers.filter(isRecord).map(extractPointer)
      : undefined,
    acceptanceCriteria: stringList(candidate.acceptanceCriteria ?? candidate.acceptance_criteria),
    invariants: stringList(candidate.invariants),
    maxFieldChars: numberValue(candidate.maxFieldChars ?? candidate.max_field_chars),
  };
}

function extractAssignment(value: Record<string, unknown>): A2AWorkerSubagentRoleAssignment {
  return {
    role: optionalString(value.role) ?? "",
    objective: optionalString(value.objective),
    writeSet: stringList(value.writeSet ?? value.write_set),
    pointers: Array.isArray(value.pointers) ? value.pointers.filter(isRecord).map(extractPointer) : undefined,
  };
}

function extractPointer(value: Record<string, unknown>): A2AWorkerSubagentContextPointer {
  return {
    path: optionalString(value.path) ?? "",
    lines: optionalString(value.lines),
    note: optionalString(value.note),
  };
}

export function renderA2AWorkerSubagentContextBriefMarkdown(packet: A2AWorkerSubagentContextBriefPacket): string {
  const lines: string[] = [
    "# A2A sub-agent context brief",
    "Worker: " + packet.workerId + (packet.taskId ? " | Task: " + packet.taskId : ""),
    "Finalizer: " + packet.finalizer,
    "Digest: " + packet.determinism.contentDigest,
    "",
    "## Summary",
    packet.summary ?? "(none)",
    "",
    "## Role assignments",
  ];
  if (packet.assignments.length === 0) lines.push("(none)");
  for (const a of packet.assignments) {
    lines.push("### " + a.role);
    if (a.objective) lines.push(a.objective);
    if (a.writeSet && a.writeSet.length) lines.push("Write set: " + a.writeSet.join(", "));
    for (const p of a.pointers ?? []) lines.push("- " + p.path + (p.lines ? ":" + p.lines : "") + (p.note ? " — " + p.note : ""));
  }
  lines.push("", "## Shared pointers");
  if (packet.pointers.length === 0) lines.push("(none)");
  for (const p of packet.pointers) lines.push("- " + p.path + (p.lines ? ":" + p.lines : "") + (p.note ? " — " + p.note : ""));
  lines.push("", "## Acceptance criteria");
  lines.push(...(packet.acceptanceCriteria.length ? packet.acceptanceCriteria.map((c) => "- " + c) : ["(none)"]));
  lines.push("", "## Invariants");
  lines.push(...packet.invariants.map((i) => "- " + i));
  lines.push(
    "",
    "Safety: source-only shared context brief; redacted and byte-bounded. Read pointers instead of re-exploring, but read the live file before editing. Does not spawn sub-agents, dispatch, claim, invoke executors, mutate state, deploy/restart, send providers, ACK/replay, publish, or move secrets.",
  );
  return lines.join("\n");
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}
