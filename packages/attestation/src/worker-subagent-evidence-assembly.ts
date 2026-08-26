import { isRecord } from "./value-guards.js";
import { createHash } from "node:crypto";

import { numberValue, optionalString } from "./value-text.js";
import { canonicalizeJson } from "./agent-card-signing.js";

// Source-only DETERMINISTIC evidence assembly for sub-agent fanout.
//
// Fanout assembles a terminal evidence bundle from N sub-agent outputs that
// complete in a non-deterministic order. For the bundle to be byte-reproducible
// (so a downstream JCS/JWS signer produces a stable anchor) and replayable, this
// packet:
//   1. STABLE-ORDERS entries by a content-derived total order (independent of
//      input/completion order);
//   2. records the EXECUTION GRAPH (finalizer + each sub-agent node, spawn and
//      evidence-return edges) for replay/audit;
//   3. emits an RFC 8785 (JCS) contentDigest over the ordered bundle, excluding
//      the wall-clock generatedAt, so the same evidence always hashes the same.
// It assembles/canonicalizes only; it does NOT sign, spawn, or mutate anything.

const CANONICALIZATION = "rfc8785-jcs-v1" as const;
const FINALIZER_NODE = "finalizer" as const;

export interface A2AWorkerSubagentEvidenceEntryInput {
  role: string;
  id?: string;
  writeSet?: string[];
  status?: string;
  summary?: string;
}

export interface A2AWorkerSubagentExecutionContext {
  gateDecisionIdempotencyKey?: string;
  budgetCounterIdempotencyKey?: string;
  authorizedSubagentCount?: number;
  parallelismUsed?: number;
  hostSnapshot?: Record<string, unknown>;
}

export interface A2AWorkerSubagentEvidenceAssemblyInput {
  now?: string;
  workerId: string;
  taskId?: string;
  finalizer?: string;
  entries: A2AWorkerSubagentEvidenceEntryInput[];
  execution?: A2AWorkerSubagentExecutionContext;
}

export interface A2AWorkerSubagentAssembledEntry {
  order: number;
  role: string;
  id?: string;
  writeSet?: string[];
  status?: string;
  summary?: string;
}

export interface A2AWorkerSubagentExecutionGraphNode {
  id: string;
  role: string;
  writeSet?: string[];
  status?: string;
}

export interface A2AWorkerSubagentExecutionGraphEdge {
  from: string;
  to: string;
  kind: "spawn" | "evidence";
}

export interface A2AWorkerSubagentEvidenceAssemblyPacket {
  kind: "a2a-broker.worker-subagent-evidence-assembly.packet";
  version: 1;
  generatedAt: string;
  sourceOnly: true;
  idempotencyKey: string;
  workerId: string;
  taskId?: string;
  finalizer: string;
  assembledEvidence: A2AWorkerSubagentAssembledEntry[];
  executionGraph: {
    nodes: A2AWorkerSubagentExecutionGraphNode[];
    edges: A2AWorkerSubagentExecutionGraphEdge[];
  };
  execution: A2AWorkerSubagentExecutionContext;
  determinism: {
    stableOrdering: true;
    canonicalization: typeof CANONICALIZATION;
    contentDigest: string;
    reproducible: true;
    signsEvidence: false;
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

function normalizeEntry(entry: A2AWorkerSubagentEvidenceEntryInput): A2AWorkerSubagentEvidenceEntryInput {
  const writeSet = Array.isArray(entry.writeSet)
    ? [...entry.writeSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    : undefined;
  return {
    role: entry.role,
    id: entry.id,
    writeSet,
    status: entry.status,
    summary: entry.summary,
  };
}

// Total order derived from content only — independent of input/completion order.
function sortKey(entry: A2AWorkerSubagentEvidenceEntryInput): string {
  return [entry.role ?? "", entry.id ?? "", canonicalizeJson(entry)].join("\u0000");
}

function sha256Prefix(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

export function buildA2AWorkerSubagentEvidenceAssembly(
  input: A2AWorkerSubagentEvidenceAssemblyInput,
): A2AWorkerSubagentEvidenceAssemblyPacket {
  const generatedAt = input.now ?? new Date().toISOString();
  const finalizer = input.finalizer ?? "worker-or-broker-finalizer";
  const execution = input.execution ?? {};

  const normalized = (input.entries ?? []).map(normalizeEntry);
  // Decorate-sort-undecorate: sortKey canonicalizes, so compute it once per
  // entry instead of on every comparison. Same code-unit compare, same order.
  const ordered = normalized
    .map((entry) => ({ key: sortKey(entry), entry }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((decorated) => decorated.entry);

  const assembledEvidence: A2AWorkerSubagentAssembledEntry[] = ordered.map((entry, index) => ({
    order: index,
    role: entry.role,
    id: entry.id,
    writeSet: entry.writeSet,
    status: entry.status,
    summary: entry.summary,
  }));

  const nodes: A2AWorkerSubagentExecutionGraphNode[] = [
    { id: FINALIZER_NODE, role: FINALIZER_NODE },
    ...ordered.map((entry, index) => ({
      id: entry.id ?? `${entry.role}#${index}`,
      role: entry.role,
      writeSet: entry.writeSet,
      status: entry.status,
    })),
  ];
  const edges: A2AWorkerSubagentExecutionGraphEdge[] = [];
  for (const node of nodes.slice(1)) {
    edges.push({ from: FINALIZER_NODE, to: node.id, kind: "spawn" });
    edges.push({ from: node.id, to: FINALIZER_NODE, kind: "evidence" });
  }

  // Digest over the ordered content only (NOT generatedAt/idempotencyKey), so
  // the same evidence in any input order yields the same anchor.
  const canonicalBundle = {
    workerId: input.workerId,
    taskId: input.taskId,
    finalizer,
    assembledEvidence,
    executionGraph: { nodes, edges },
    execution,
  };
  const contentDigest = sha256Prefix(canonicalizeJson(canonicalBundle));
  const idempotencyKey = "a2a-worker-subagent-evidence-assembly:" + contentDigest.slice("sha256:".length, "sha256:".length + 24);

  return {
    kind: "a2a-broker.worker-subagent-evidence-assembly.packet",
    version: 1,
    generatedAt,
    sourceOnly: true,
    idempotencyKey,
    workerId: input.workerId,
    taskId: input.taskId,
    finalizer,
    assembledEvidence,
    executionGraph: { nodes, edges },
    execution,
    determinism: {
      stableOrdering: true,
      canonicalization: CANONICALIZATION,
      contentDigest,
      reproducible: true,
      signsEvidence: false,
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

export function extractA2AWorkerSubagentEvidenceAssemblyInput(input: unknown): A2AWorkerSubagentEvidenceAssemblyInput {
  const envelope = isRecord(input) ? input : {};
  const candidate = isRecord(envelope.workerSubagentEvidenceAssembly)
    ? envelope.workerSubagentEvidenceAssembly
    : isRecord(envelope.evidenceAssembly)
      ? envelope.evidenceAssembly
      : envelope;
  if (!isRecord(candidate)) {
    throw new Error("worker subagent evidence assembly input must be an object");
  }
  const workerId = optionalString(candidate.workerId ?? candidate.worker_id);
  if (!workerId) throw new Error("worker subagent evidence assembly requires workerId");

  const entriesRaw = Array.isArray(candidate.entries) ? candidate.entries : [];
  const entries: A2AWorkerSubagentEvidenceEntryInput[] = entriesRaw
    .filter((e): e is Record<string, unknown> => isRecord(e))
    .map((e) => ({
      role: optionalString(e.role) ?? "",
      id: optionalString(e.id ?? e.idempotencyKey),
      writeSet: stringList(e.writeSet ?? e.write_set),
      status: optionalString(e.status),
      summary: optionalString(e.summary),
    }));

  const exec = isRecord(candidate.execution) ? candidate.execution : {};
  const execution: A2AWorkerSubagentExecutionContext = {
    gateDecisionIdempotencyKey: optionalString(exec.gateDecisionIdempotencyKey),
    budgetCounterIdempotencyKey: optionalString(exec.budgetCounterIdempotencyKey),
    authorizedSubagentCount: numberValue(exec.authorizedSubagentCount),
    parallelismUsed: numberValue(exec.parallelismUsed),
    hostSnapshot: isRecord(exec.hostSnapshot) ? exec.hostSnapshot : undefined,
  };

  return {
    now: optionalString(candidate.now),
    workerId,
    taskId: optionalString(candidate.taskId ?? candidate.task_id),
    finalizer: optionalString(candidate.finalizer),
    entries,
    execution,
  };
}

export function renderA2AWorkerSubagentEvidenceAssemblyMarkdown(packet: A2AWorkerSubagentEvidenceAssemblyPacket): string {
  return [
    "A2A worker sub-agent deterministic evidence assembly",
    "Worker: " + packet.workerId,
    "Finalizer: " + packet.finalizer,
    "Generated: " + packet.generatedAt,
    "Canonicalization: " + packet.determinism.canonicalization,
    "Content digest: " + packet.determinism.contentDigest,
    "Assembled evidence (stable order):",
    ...(packet.assembledEvidence.length
      ? packet.assembledEvidence.map((e) => "- [" + e.order + "] " + e.role + (e.id ? " (" + e.id + ")" : "") + (e.status ? " - " + e.status : ""))
      : ["- none"]),
    "Execution graph: " + packet.executionGraph.nodes.length + " nodes, " + packet.executionGraph.edges.length + " edges",
    "Safety: source-only deterministic assembly; stable-orders and JCS-canonicalizes evidence for a reproducible digest, but does not sign, spawn sub-agents, dispatch, claim, invoke executors, mutate DB/TaskFlow, deploy/restart, send providers, ACK/replay terminal rows, publish releases, or move secrets.",
  ].join("\n");
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}
