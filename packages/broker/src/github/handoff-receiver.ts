import { createHash } from "node:crypto";

import type { InMemoryA2ABroker } from "../core/broker.js";
import {
  peerHasHandoffScope,
  type PeerCredentialRegistry,
  type PeerHandoffScopeMode,
} from "../core/request-security.js";
import type {
  A2AExchangeIntent,
  CreateTaskRequest,
  TaskRecord,
  TaskStatus,
} from "../core/types.js";
import { parseAssignmentIntents, type AssignmentIntent } from "./ingestion.js";
import type { GitHubDeliveryContext, GitHubIssueCommentEvent } from "./types.js";

export type HandoffEvidenceStatus = "accepted" | "running" | "pr-open" | "done" | "blocked";

export type HandoffReceiverSkippedReason =
  | "no_handoff_manifest"
  | "no_assignment_command"
  | "unknown_worker"
  | "wrong_broker_of_record"
  | "wrong_target_team"
  | "missing_idempotency_key"
  | "peer_scope_denied"
  | "idempotency_conflict";

export interface brokerbetabrokeralphaHandoffManifest {
  brokerOfRecord?: string;
  requestedByBroker?: string;
  requestingAgent?: string;
  sourceTaskId?: string;
  targetTaskId?: string;
  targetTeam?: string;
  handoffReason?: string;
  status?: string;
  idempotencyKey?: string;
  evidence: string[];
  /** Optional structured-manifest-only target. `/a2a assign <worker>` remains preferred. */
  targetWorker?: string;
  /** Parent round identifier for Terminal Brief aggregation. */
  parentRoundId?: string;
  /** Total worker/task count expected for the parent round (denominator). */
  parentRoundTotal?: number | string;
  /**
   * Global order of this handoff within the parent round (1-based). Optional;
   * defaults to the assignment index + 1 when the manifest carries
   * parentRoundId + parentRoundTotal.
   */
  parentRoundOrder?: number | string;
}

export interface HandoffReceiverOptions {
  broker: InMemoryA2ABroker;
  /** Local broker expected to own created tasks. Defaults to `brokeralpha`. */
  brokerOfRecord?: string;
  /** Local team/tenant expected to own created tasks. Defaults to `team1`. */
  targetTeam?: string;
  /** Remote broker allowed to request this handoff. Defaults to `brokerbeta`. */
  requestedByBroker?: string;
  /** Intent used when a `/a2a assign` command omits `--intent`. */
  defaultIntent?: A2AExchangeIntent;
  /** Service requester id used when the manifest omits `requestingAgent`. */
  requesterId?: string;
  /**
   * Minimum-scope peer credential registry
   * (contracts/a2a/broker-handoff-protocol.md peer scopes). When configured,
   * the requesting peer broker must hold the `handoff:create` scope or the
   * manifest fails closed before any task is created. Transport
   * authentication for this lane is the GitHub webhook signature; the
   * registry supplies the per-peer authorization grant.
   */
  peerCredentialRegistry?: PeerCredentialRegistry | null;
  /** Peer scope gate mode; defaults to `auto` (assert when a registry is configured). */
  peerHandoffScopeMode?: PeerHandoffScopeMode;
}

export interface HandoffReceiveInput {
  body: string;
  repoFullName: string;
  issueNumber: number;
  issueUrl: string;
  commentId?: number;
  commentUrl?: string;
  ctx: GitHubDeliveryContext;
}

export interface HandoffEvidenceEntry {
  workerId: string;
  targetTaskId: string;
  status: HandoffEvidenceStatus;
  evidenceUrl?: string;
}

export interface HandoffReceiveResult {
  accepted: boolean;
  replayed: boolean;
  skippedReason?: HandoffReceiverSkippedReason;
  manifest?: brokerbetabrokeralphaHandoffManifest;
  targetTaskIds: string[];
  evidence: HandoffEvidenceEntry[];
  evidenceCommentBody?: string;
}

const MANIFEST_KEYS = new Set([
  "brokerOfRecord",
  "requestedByBroker",
  "requestingAgent",
  "sourceTaskId",
  "targetTaskId",
  "targetTeam",
  "handoffReason",
  "status",
  "idempotencyKey",
  "targetWorker",
  "targetWorkerId",
  "targetNodeId",
  "worker",
  "parentRoundId",
  "parentRoundTotal",
  "parentRoundOrder",
]);

export class brokerbetabrokeralphaHandoffReceiver {
  private readonly broker: InMemoryA2ABroker;
  private readonly brokerOfRecord: string;
  private readonly targetTeam: string;
  private readonly requestedByBroker: string;
  private readonly defaultIntent: A2AExchangeIntent;
  private readonly requesterId: string;
  private readonly peerCredentialRegistry: PeerCredentialRegistry | null;
  private readonly peerHandoffScopeMode: PeerHandoffScopeMode;

  constructor(options: HandoffReceiverOptions) {
    this.broker = options.broker;
    this.brokerOfRecord = options.brokerOfRecord ?? "brokeralpha";
    this.targetTeam = options.targetTeam ?? "team1";
    this.requestedByBroker = options.requestedByBroker ?? "brokerbeta";
    this.defaultIntent = options.defaultIntent ?? "propose_patch";
    this.requesterId = options.requesterId ?? `${this.requestedByBroker}-${this.brokerOfRecord}-handoff-receiver`;
    this.peerCredentialRegistry = options.peerCredentialRegistry ?? null;
    this.peerHandoffScopeMode = options.peerHandoffScopeMode ?? "auto";
  }

  receiveIssueComment(event: GitHubIssueCommentEvent, ctx: GitHubDeliveryContext): HandoffReceiveResult {
    return this.receive({
      body: event.comment.body,
      repoFullName: event.repo.fullName,
      issueNumber: event.issue.number,
      issueUrl: event.issue.htmlUrl,
      commentId: event.comment.id,
      commentUrl: event.comment.htmlUrl,
      ctx,
    });
  }

  receive(input: HandoffReceiveInput): HandoffReceiveResult {
    const manifest = parsebrokerbetabrokeralphaHandoffManifest(input.body);
    if (!manifest) {
      return emptyResult("no_handoff_manifest");
    }

    const brokerOfRecord = normalizeString(manifest.brokerOfRecord);
    if (brokerOfRecord !== this.brokerOfRecord) {
      return emptyResult("wrong_broker_of_record", manifest);
    }
    const requestedByBroker = normalizeString(manifest.requestedByBroker);
    if (requestedByBroker && requestedByBroker !== this.requestedByBroker) {
      return emptyResult("wrong_broker_of_record", manifest);
    }
    const targetTeam = normalizeString(manifest.targetTeam);
    if (targetTeam !== this.targetTeam) {
      return emptyResult("wrong_target_team", manifest);
    }
    const idempotencyKey = normalizeString(manifest.idempotencyKey);
    if (!idempotencyKey) {
      return emptyResult("missing_idempotency_key", manifest);
    }

    // Peer scope gate (contracts/a2a/broker-handoff-protocol.md): a peer
    // missing the handoff:create scope fails closed before task creation.
    // Mode `auto` asserts whenever a registry is provisioned; `enforce`
    // asserts even without one (denying everything until provisioned).
    if (this.peerHandoffScopeMode !== "off" &&
        (this.peerHandoffScopeMode === "enforce" || this.peerCredentialRegistry)) {
      const requestingPeer = requestedByBroker ?? this.requestedByBroker;
      if (!peerHasHandoffScope(this.peerCredentialRegistry, requestingPeer, "handoff:create")) {
        return emptyResult("peer_scope_denied", manifest);
      }
    }

    const intents = parseAssignmentIntents(input.body);
    const assignmentIntents = intents.length > 0 ? intents : manifest.targetWorker ? [intentFromManifest(manifest)] : [];
    if (assignmentIntents.length === 0) {
      return emptyResult("no_assignment_command", manifest);
    }

    const targetTaskIds: string[] = [];
    const evidence: HandoffEvidenceEntry[] = [];
    const envelopeDigest = handoffEnvelopeDigest(manifest, assignmentIntents.map((entry) => entry.target));
    let replayed = false;

    for (let index = 0; index < assignmentIntents.length; index++) {
      const intent = assignmentIntents[index]!;
      const worker = this.broker.getWorker(intent.target);
      if (!worker) {
        return emptyResult("unknown_worker", manifest);
      }
      const workerTeam = normalizeString(worker.metadata?.teamId);
      if (workerTeam && workerTeam !== this.targetTeam) {
        return emptyResult("wrong_target_team", manifest);
      }
      const workerBroker = normalizeString(worker.metadata?.brokerOfRecord ?? worker.metadata?.brokerId ?? worker.metadata?.homeBrokerId);
      if (workerBroker && workerBroker !== this.brokerOfRecord) {
        return emptyResult("wrong_broker_of_record", manifest);
      }

      const taskId = taskIdForHandoff(manifest, intent.target, index, assignmentIntents.length);
      const existing = this.broker.getTask(taskId);
      if (existing) {
        // One idempotency key = one logical handoff: a replay of the same
        // envelope returns the existing task, but the same key with a
        // different envelope is a conflict, not a second dispatch
        // (contracts/a2a/broker-handoff-protocol.md idempotency rules).
        const existingDigest = existing.payload["handoffEnvelopeDigest"];
        if (typeof existingDigest === "string" && existingDigest !== envelopeDigest) {
          return emptyResult("idempotency_conflict", manifest);
        }
      }
      const task = existing ?? this.createTask({ input, manifest, intent, taskId, index, envelopeDigest });
      if (existing) replayed = true;
      targetTaskIds.push(task.id);
      evidence.push({
        workerId: task.assignedWorkerId ?? task.targetNodeId,
        targetTaskId: task.id,
        status: toEvidenceStatus(task),
        ...(extractEvidenceUrl(task) ? { evidenceUrl: extractEvidenceUrl(task)! } : {}),
      });
    }

    const result: HandoffReceiveResult = {
      accepted: true,
      replayed,
      manifest,
      targetTaskIds,
      evidence,
    };
    return {
      ...result,
      evidenceCommentBody: renderHandoffEvidenceComment(result),
    };
  }

  private createTask(args: {
    input: HandoffReceiveInput;
    manifest: brokerbetabrokeralphaHandoffManifest;
    intent: AssignmentIntent;
    taskId: string;
    index: number;
    envelopeDigest: string;
  }): TaskRecord {
    const { input, manifest, intent, taskId, index, envelopeDigest } = args;
    const message = redactHandoffText(intent.message ?? intent.raw);
    const requesterId = normalizeString(manifest.requestingAgent) ?? this.requesterId;
    const parentRoundId = normalizeString(manifest.parentRoundId);
    const parentBrokerId = normalizeString(manifest.requestedByBroker) ?? this.requestedByBroker;
    const request: CreateTaskRequest = {
      id: taskId,
      intent: intent.intent ?? this.defaultIntent,
      requester: { id: requesterId, kind: "service", role: "operator" },
      target: { id: intent.target, kind: "node" },
      assignedWorkerId: intent.target,
      message,
      taskOrigin: "github",
      brokerOfRecord: this.brokerOfRecord,
      teamId: this.targetTeam,
      payload: {
        handoffKind: `${this.requestedByBroker}-${this.brokerOfRecord}`,
        brokerOfRecord: this.brokerOfRecord,
        requestedByBroker: normalizeString(manifest.requestedByBroker),
        requestingAgent: requesterId,
        sourceTaskId: redactHandoffText(normalizeString(manifest.sourceTaskId) ?? input.issueUrl),
        requestedTargetTaskId: redactHandoffText(normalizeString(manifest.targetTaskId) ?? ""),
        targetTeam: this.targetTeam,
        handoffReason: redactHandoffText(normalizeString(manifest.handoffReason) ?? ""),
        handoffStatus: normalizeString(manifest.status) ?? "requested",
        idempotencyKey: normalizeString(manifest.idempotencyKey),
        handoffEnvelopeDigest: envelopeDigest,
        evidenceUrls: manifest.evidence.map(redactHandoffText),
        ...(intent.intent === "propose_patch" || (!intent.intent && this.defaultIntent === "propose_patch")
          ? { mode: "github-propose-patch", repo: input.repoFullName, issue: `#${input.issueNumber}`, issueNumber: input.issueNumber, issueUrl: input.issueUrl }
          : {}),
        githubDeliveryId: input.ctx.deliveryId,
        githubReceivedAt: input.ctx.receivedAt,
        githubRepo: input.repoFullName,
        githubIssueNumber: input.issueNumber,
        githubIssueUrl: input.issueUrl,
        workMode: this.targetTeam,
        // A2AWorkMode has no team2 token; emit the packaged decision only for
        // the team1 lane and let other lanes supply their own policy packet.
        ...(this.targetTeam === "team1"
          ? {
              workModeDecision: {
                mode: "team1",
                idempotencyKey: `${this.requestedByBroker}-${this.brokerOfRecord}-handoff:${normalizeString(manifest.idempotencyKey) ?? taskId}`,
                finalizerOwner: this.brokerOfRecord,
                generatedAt: input.ctx.receivedAt,
                capacityState: "unknown",
                capacitySnapshotSource: `${this.requestedByBroker}-${this.brokerOfRecord}-handoff-manifest`,
                capacitySnapshotAt: input.ctx.receivedAt,
                sourceOnlyDecision: true,
                workerDispatchAllowedByThisPacket: false,
              },
            }
          : {}),
        githubWorkMode: intent.workMode,
        githubKind: "handoff",
        ...(input.commentId !== undefined ? { githubCommentId: input.commentId } : {}),
        ...(input.commentUrl ? { githubCommentUrl: input.commentUrl } : {}),
        githubCommandIndex: index,
        ...(parentRoundId ? { parentRoundId } : {}),
        ...(manifest.parentRoundTotal ? { parentRoundTotal: manifest.parentRoundTotal } : {}),
        ...(parentRoundId && manifest.parentRoundTotal
          ? { parentRoundOrder: positiveIntFrom(manifest.parentRoundOrder) ?? index + 1 }
          : {}),
        // Parent Terminal Brief metadata (broker-handoff-protocol.md,
        // "Parent Terminal Brief metadata"): when the envelope carries a
        // parent round, mark the terminal brief parent-owned so the child
        // terminal-outbox event emits notificationOwnership
        // scope=parent-broker-only with the parent broker as owner, plus the
        // crossBrokerHandoff attribution the parent-side receiver requires.
        // Without these fields the child event is silently ignored by
        // cross-broker receivers (aggregation gap G2/G3).
        ...(parentRoundId
          ? {
              originBrokerId: parentBrokerId,
              brokerOfRecordId: parentBrokerId,
              operatorFacingOwner: "parent",
              crossBrokerHandoff: {
                parentRoundId,
                originBrokerId: parentBrokerId,
                handoffBrokerId: this.brokerOfRecord,
                childWorkerId: intent.target,
                ...(normalizeString(manifest.sourceTaskId)
                  ? { originTaskId: redactHandoffText(normalizeString(manifest.sourceTaskId)!) }
                  : {}),
              },
            }
          : {}),
      },
    };
    return this.broker.createTask(request);
  }
}

export function parsebrokerbetabrokeralphaHandoffManifest(text: string | null | undefined): brokerbetabrokeralphaHandoffManifest | null {
  if (!text) return null;
  for (const block of manifestCandidateBlocks(text)) {
    const parsed = parseManifestBlock(block);
    if (parsed) return parsed;
  }
  return null;
}

export function renderHandoffEvidenceComment(result: Pick<HandoffReceiveResult, "manifest" | "evidence">): string {
  const manifest = result.manifest;
  const requestedByBroker = manifest?.requestedByBroker?.trim();
  const brokerOfRecord = manifest?.brokerOfRecord?.trim();
  const header = requestedByBroker && brokerOfRecord
    ? `[a2a:${redactHandoffText(requestedByBroker)}→${redactHandoffText(brokerOfRecord)} handoff]`
    : "[a2a:brokerbeta→brokeralpha handoff]";
  const lines = [header];
  if (manifest) {
    lines.push(`brokerOfRecord: ${redactHandoffText(manifest.brokerOfRecord ?? "")}`);
    lines.push(`requestedByBroker: ${redactHandoffText(manifest.requestedByBroker ?? "")}`);
    lines.push(`targetTeam: ${redactHandoffText(manifest.targetTeam ?? "")}`);
    lines.push(`idempotencyKey: ${redactHandoffText(manifest.idempotencyKey ?? "")}`);
    if (manifest.sourceTaskId) lines.push(`sourceTaskId: ${redactHandoffText(manifest.sourceTaskId)}`);
    if (manifest.parentRoundId) lines.push(`parentRoundId: ${redactHandoffText(manifest.parentRoundId)}`);
    if (manifest.parentRoundTotal !== undefined && manifest.parentRoundTotal !== null) lines.push(`parentRoundTotal: ${String(manifest.parentRoundTotal)}`);
  }
  lines.push("targetTasks:");
  for (const entry of result.evidence) {
    const suffix = entry.evidenceUrl ? ` evidence=${redactHandoffText(entry.evidenceUrl)}` : "";
    lines.push(`- worker=${redactHandoffText(entry.workerId)} targetTaskId=${redactHandoffText(entry.targetTaskId)} status=${entry.status}${suffix}`);
  }
  return lines.join("\n");
}

export function redactHandoffText(value: string): string {
  return value
    .replace(/\b((?:edge[_-]?secret|secret|token|api[_-]?key|password|authorization))\s*[:=]\s*("[^"]*"|'[^']*'|`[^`]*`|[^\s,;]+)/gi, "$1=[REDACTED]")
    .replace(/\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]+/g, "[REDACTED]");
}

function manifestCandidateBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fence = /```(?:yaml|yml|json)?\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) {
    blocks.push(match[1]!);
  }
  blocks.push(text);
  return blocks;
}

function parseManifestBlock(block: string): brokerbetabrokeralphaHandoffManifest | null {
  const fields: Record<string, string> = {};
  const evidence: string[] = [];
  let inEvidence = false;

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (kv) {
      inEvidence = kv[1] === "evidence";
      if (inEvidence) {
        const inline = stripValue(kv[2] ?? "");
        if (inline && inline !== "[]") evidence.push(inline);
      } else if (MANIFEST_KEYS.has(kv[1]!)) {
        fields[canonicalKey(kv[1]!)] = stripValue(kv[2] ?? "");
      }
      continue;
    }
    if (inEvidence) {
      const item = line.match(/^-\s*(.+)$/);
      if (item) evidence.push(stripValue(item[1]!));
    }
  }

  if (!fields.brokerOfRecord && !fields.requestedByBroker && !fields.targetTeam && !fields.idempotencyKey) {
    return null;
  }

  return {
    ...(fields.brokerOfRecord ? { brokerOfRecord: fields.brokerOfRecord } : {}),
    ...(fields.requestedByBroker ? { requestedByBroker: fields.requestedByBroker } : {}),
    ...(fields.requestingAgent ? { requestingAgent: fields.requestingAgent } : {}),
    ...(fields.sourceTaskId ? { sourceTaskId: fields.sourceTaskId } : {}),
    ...(fields.targetTaskId ? { targetTaskId: fields.targetTaskId } : {}),
    ...(fields.targetTeam ? { targetTeam: fields.targetTeam } : {}),
    ...(fields.handoffReason ? { handoffReason: fields.handoffReason } : {}),
    ...(fields.status ? { status: fields.status } : {}),
    ...(fields.idempotencyKey ? { idempotencyKey: fields.idempotencyKey } : {}),
    ...(fields.targetWorker ? { targetWorker: fields.targetWorker } : {}),
    ...(fields.parentRoundId ? { parentRoundId: fields.parentRoundId } : {}),
    ...(fields.parentRoundTotal ? { parentRoundTotal: fields.parentRoundTotal } : {}),
    ...(fields.parentRoundOrder ? { parentRoundOrder: fields.parentRoundOrder } : {}),
    evidence,
  };
}

function canonicalKey(key: string): string {
  if (key === "targetWorkerId" || key === "targetNodeId" || key === "worker") return "targetWorker";
  return key;
}

function stripValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith("`") && trimmed.endsWith("`"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function intentFromManifest(manifest: brokerbetabrokeralphaHandoffManifest): AssignmentIntent {
  return {
    raw: `structured handoff for ${manifest.targetWorker}`,
    target: manifest.targetWorker!,
    workMode: "github",
    args: {},
    ...(manifest.handoffReason ? { message: manifest.handoffReason } : {}),
  };
}

function taskIdForHandoff(
  manifest: brokerbetabrokeralphaHandoffManifest,
  workerId: string,
  index: number,
  count: number,
): string {
  const explicit = normalizeString(manifest.targetTaskId);
  if (explicit && count === 1) return explicit;
  const key = slugForId(normalizeString(manifest.idempotencyKey) ?? "handoff");
  return `handoff-${key}-${slugForId(workerId)}-${index}`;
}

function toEvidenceStatus(task: TaskRecord): HandoffEvidenceStatus {
  switch (task.status as TaskStatus) {
    case "claimed":
    case "running":
      return "running";
    case "succeeded":
      return extractPullRequestUrl(task) ? "pr-open" : "done";
    case "failed":
    case "canceled":
    case "blocked":
      return "blocked";
    case "queued":
    default:
      return "accepted";
  }
}

function extractEvidenceUrl(task: TaskRecord): string | undefined {
  return extractPullRequestUrl(task) ?? firstString(task.result?.output, ["doneCommentUrl", "blockCommentUrl", "doneUrl", "blockUrl"]);
}

function extractPullRequestUrl(task: TaskRecord): string | undefined {
  const fromOutput = firstString(task.result?.output, ["pullRequestUrl", "prUrl", "pull_request_url"]);
  if (fromOutput && /\/pull\/\d+/.test(fromOutput)) return fromOutput;
  const summary = task.result?.summary;
  if (typeof summary === "string") {
    const match = summary.match(/https?:\/\/\S*\/pull\/\d+/);
    if (match) return match[0];
  }
  return undefined;
}

function firstString(source: unknown, keys: string[]): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const record = source as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function normalizeString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveIntFrom(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

/**
 * Stable digest over the identity-bearing envelope fields. Two manifests that
 * reuse one idempotency key with a different source/destination/team/link or
 * worker set must be treated as a conflict, not a replay.
 */
export function handoffEnvelopeDigest(
  manifest: brokerbetabrokeralphaHandoffManifest,
  targetWorkers: readonly string[],
): string {
  const canonical = JSON.stringify({
    brokerOfRecord: manifest.brokerOfRecord?.trim() ?? null,
    requestedByBroker: manifest.requestedByBroker?.trim() ?? null,
    targetTeam: manifest.targetTeam?.trim() ?? null,
    sourceTaskId: manifest.sourceTaskId?.trim() ?? null,
    targetTaskId: manifest.targetTaskId?.trim() ?? null,
    parentRoundId: manifest.parentRoundId?.trim() ?? null,
    parentRoundTotal: manifest.parentRoundTotal !== undefined ? String(manifest.parentRoundTotal).trim() : null,
    parentRoundOrder: manifest.parentRoundOrder !== undefined ? String(manifest.parentRoundOrder).trim() : null,
    targetWorkers: [...targetWorkers],
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function slugForId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "handoff";
}

function emptyResult(reason: HandoffReceiverSkippedReason, manifest?: brokerbetabrokeralphaHandoffManifest): HandoffReceiveResult {
  return {
    accepted: false,
    replayed: false,
    skippedReason: reason,
    ...(manifest ? { manifest } : {}),
    targetTaskIds: [],
    evidence: [],
  };
}
