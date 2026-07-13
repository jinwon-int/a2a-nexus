import { createHmac } from "node:crypto";

export type TerminalAction =
  | "pr_open"
  | "pr_merge"
  | "git_push"
  | "deploy_restart"
  | "promote_to_live_apply"
  | "promote_to_live_rollback"
  | "release_tag"
  | "terminal_ack_replay"
  | "db_migration_prune"
  | "secret_handling";

export type TerminalActorRole = "explorer" | "researcher" | "implementer" | "verifier" | "finalizer" | "operator";

export interface LiveApprovalScope {
  taskId: string;
  runId: string;
  action: "promote_to_live_apply" | "promote_to_live_rollback";
  target: string;
}

export interface TerminalActionRequest {
  action: TerminalAction;
  actorRole: TerminalActorRole;
  actorId: string;
  finalizerOnly?: boolean;
  freshApprovalToken?: string | null;
  approvalTokenIssuedAt?: string | null;
  approvalTokenMaxAgeMs?: number;
  approvalScope?: LiveApprovalScope;
  approvalTokenSigningKey?: string;
  consumedApprovalKeys?: string[];
  now?: string;
}

export interface TerminalActionDecision {
  allowed: boolean;
  reason: string;
  blockers: string[];
}

export interface DeclaredWriteSetGateInput {
  declaredWriteSet: string[];
  touchedFiles: string[];
}

export interface DeclaredWriteSetGateDecision {
  allowed: boolean;
  reason: string;
  outOfScopeFiles: string[];
  quarantineRequired: boolean;
}

export type RuntimeLifecyclePhase = "claim" | "process" | "finalize";

export interface RuntimeIdempotencyInput {
  taskId: string;
  runId: string;
  phase: RuntimeLifecyclePhase;
  action: string;
  target: string;
  updatedAt?: string;
}

export interface RuntimeReplayGateInput {
  idempotencyKey: string;
  appliedKeys: string[];
}

export interface RuntimeReplayGateDecision {
  allowed: boolean;
  reason: string;
}

export interface WorkerRuntimeBoundaryInput {
  tunnelOnly: boolean;
  brokerUrl: string;
  taskWorkspaceId?: string;
  registeredWorkspaceIds: string[];
  bridgeBin: string;
  reportedMetadata?: Record<string, unknown>;
}

export interface WorkerRuntimeMetadata {
  runtime: string;
  harness: string;
  adapter: string;
}

export interface WorkerRuntimeBoundaryDecision {
  allowed: boolean;
  blockers: string[];
  derivedMetadata: WorkerRuntimeMetadata;
}

export interface RuntimeAuditEventInput {
  id: string;
  taskId: string;
  actorId: string;
  action: string;
  message: string;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  costUsd?: number;
  maxMessageChars?: number;
}

export interface RuntimeAuditEvent {
  id: string;
  taskId: string;
  actorId: string;
  action: string;
  message: string;
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  costUsd: number;
}

const DEFAULT_APPROVAL_TOKEN_MAX_AGE_MS = 5 * 60 * 1000;

export function evaluateTerminalActionGate(request: TerminalActionRequest): TerminalActionDecision {
  const blockers: string[] = [];
  const requiresFinalizer = request.finalizerOnly !== false;
  const actorIsFinalizer = request.actorRole === "finalizer";
  const approval = evaluateApprovalFreshness(request);
  const liveApproval = evaluateLiveApprovalBinding(request);

  if (requiresFinalizer && !actorIsFinalizer) {
    blockers.push(`terminal action ${request.action} requires finalizer actor`);
  }
  if (!approval.fresh) {
    blockers.push(`terminal action ${request.action} requires a fresh approval token`);
  }
  if (!liveApproval.allowed) {
    blockers.push(liveApproval.blocker);
  }

  if (blockers.length === 0) {
    return { allowed: true, reason: "allowed_finalizer_fresh_approval", blockers: [] };
  }

  return {
    allowed: false,
    reason: !actorIsFinalizer && requiresFinalizer
      ? "non_finalizer_actor"
      : !approval.fresh
        ? approval.reason
        : liveApproval.reason,
    blockers,
  };
}

function isLiveMutationAction(action: TerminalAction): action is LiveApprovalScope["action"] {
  return action === "promote_to_live_apply" || action === "promote_to_live_rollback";
}

export function buildLiveApprovalConsumptionKey(scope: LiveApprovalScope): string {
  return buildStableRuntimeIdempotencyKey({ ...scope, phase: "process" });
}

export function buildLiveApprovalToken(scope: LiveApprovalScope, nonce: string, signingKey: string): string {
  const normalizedKey = String(signingKey ?? "").trim();
  if (!normalizedKey) {
    throw new Error("live approval signing key is required");
  }
  const digest = createHmac("sha256", normalizedKey).update(buildLiveApprovalConsumptionKey(scope)).digest("hex");
  const normalizedNonce = String(nonce ?? "").trim();
  if (!normalizedNonce || /[^A-Za-z0-9_-]/.test(normalizedNonce)) {
    throw new Error("live approval nonce must be a non-empty URL-safe token");
  }
  return `approval-live:${digest}:${normalizedNonce}`;
}

function liveApprovalTokenDigest(token: string): string | null {
  const match = /^approval-live:([a-f0-9]{64}):[A-Za-z0-9_-]+$/.exec(String(token ?? "").trim());
  return match?.[1] ?? null;
}

function evaluateLiveApprovalBinding(request: TerminalActionRequest): {
  allowed: boolean;
  reason: string;
  blocker: string;
} {
  if (!isLiveMutationAction(request.action)) {
    return { allowed: true, reason: "live_approval_not_required", blocker: "" };
  }
  const requested = request.approvalScope;
  if (!requested) {
    return {
      allowed: false,
      reason: "missing_approval_scope",
      blocker: `terminal action ${request.action} requires an approval bound to the exact live operation scope`,
    };
  }
  const signingKey = String(request.approvalTokenSigningKey ?? "").trim();
  if (!signingKey) {
    return {
      allowed: false,
      reason: "missing_approval_authority",
      blocker: `terminal action ${request.action} requires a trusted live approval authority`,
    };
  }
  const requestedKey = buildLiveApprovalConsumptionKey(requested);
  const expectedDigest = createHmac("sha256", signingKey).update(requestedKey).digest("hex");
  const grantedDigest = liveApprovalTokenDigest(String(request.freshApprovalToken ?? ""));
  if (requested.action !== request.action || grantedDigest !== expectedDigest) {
    return {
      allowed: false,
      reason: "approval_scope_mismatch",
      blocker: `terminal action ${request.action} requires an approval bound to the exact live operation scope`,
    };
  }
  if (normalizeStringList(request.consumedApprovalKeys ?? []).includes(requestedKey)) {
    return {
      allowed: false,
      reason: "approval_scope_already_consumed",
      blocker: `terminal action ${request.action} approval scope was already consumed`,
    };
  }
  return { allowed: true, reason: "approval_scope_bound", blocker: "" };
}

function evaluateApprovalFreshness(request: TerminalActionRequest): { fresh: boolean; reason: string } {
  const token = String(request.freshApprovalToken ?? "").trim();
  if (!token) return { fresh: false, reason: "missing_approval_token" };
  const issuedAtMs = Date.parse(String(request.approvalTokenIssuedAt ?? ""));
  const nowMs = Date.parse(String(request.now ?? new Date().toISOString()));
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(nowMs)) {
    return { fresh: false, reason: "invalid_approval_token_time" };
  }
  const maxAgeMs = request.approvalTokenMaxAgeMs ?? DEFAULT_APPROVAL_TOKEN_MAX_AGE_MS;
  if (nowMs - issuedAtMs > maxAgeMs) return { fresh: false, reason: "stale_approval_token" };
  if (issuedAtMs - nowMs > 30_000) return { fresh: false, reason: "future_approval_token" };
  return { fresh: true, reason: "fresh_approval_token" };
}

export function evaluateDeclaredWriteSetGate(input: DeclaredWriteSetGateInput): DeclaredWriteSetGateDecision {
  const touched = normalizeStringList(input.touchedFiles).map(normalizeRepoPath);
  const declared = normalizeStringList(input.declaredWriteSet);
  if (declared.length === 0) {
    return {
      allowed: touched.length === 0,
      reason: touched.length === 0 ? "no_touched_files" : "declared write-set is required before finalize",
      outOfScopeFiles: touched,
      quarantineRequired: touched.length > 0,
    };
  }
  const matchers = declared.map(writeSetPatternToRegExp);
  const outOfScopeFiles = touched.filter((file) => !matchers.some((matcher) => matcher.test(file)));
  return {
    allowed: outOfScopeFiles.length === 0,
    reason: outOfScopeFiles.length === 0
      ? "all touched files are inside declared write-set"
      : `files outside declared write-set: ${outOfScopeFiles.join(", ")}`,
    outOfScopeFiles,
    quarantineRequired: outOfScopeFiles.length > 0,
  };
}

export function buildStableRuntimeIdempotencyKey(input: RuntimeIdempotencyInput): string {
  return [input.taskId, input.runId, input.phase, input.action, input.target]
    .map((part) => encodeURIComponent(String(part ?? "").trim()))
    .join(":");
}

export function evaluateRuntimeReplayGate(input: RuntimeReplayGateInput): RuntimeReplayGateDecision {
  const key = String(input.idempotencyKey ?? "").trim();
  if (!key) return { allowed: false, reason: "missing_idempotency_key" };
  const applied = new Set(normalizeStringList(input.appliedKeys));
  if (applied.has(key)) return { allowed: false, reason: "duplicate_idempotency_key" };
  return { allowed: true, reason: "new_idempotency_key" };
}

export function evaluateWorkerRuntimeBoundary(input: WorkerRuntimeBoundaryInput): WorkerRuntimeBoundaryDecision {
  const blockers: string[] = [];
  const derivedMetadata = deriveWorkerRuntimeMetadata(input.bridgeBin);
  if (input.tunnelOnly && !isLoopbackUrl(input.brokerUrl)) {
    blockers.push("tunnel-only worker must use a loopback broker URL");
  }
  const workspaceId = String(input.taskWorkspaceId ?? "").trim();
  if (workspaceId && !normalizeStringList(input.registeredWorkspaceIds).includes(workspaceId)) {
    blockers.push(`task workspace ${workspaceId} is not registered for this worker`);
  }
  if (!metadataMatchesDerived(input.reportedMetadata, derivedMetadata)) {
    blockers.push("runtime metadata must be derived from bridge wiring");
  }
  return { allowed: blockers.length === 0, blockers, derivedMetadata };
}

export function buildRuntimeAuditEvent(input: RuntimeAuditEventInput): RuntimeAuditEvent {
  const tokenUsage = {
    inputTokens: finiteNumber(input.tokenUsage?.inputTokens),
    outputTokens: finiteNumber(input.tokenUsage?.outputTokens),
    totalTokens: finiteNumber(input.tokenUsage?.totalTokens),
  };
  const max = Math.max(1, Math.floor(input.maxMessageChars ?? 500));
  return {
    id: String(input.id),
    taskId: String(input.taskId),
    actorId: String(input.actorId),
    action: String(input.action),
    message: redactRuntimeAuditMessage(input.message).slice(0, max),
    tokenUsage,
    costUsd: finiteNumber(input.costUsd),
  };
}

function deriveWorkerRuntimeMetadata(bridgeBin: string): WorkerRuntimeMetadata {
  const bin = String(bridgeBin ?? "");
  if (/claude-a2a-patch-bridge\.mjs$/.test(bin)) {
    return { runtime: "claude-code", harness: "patch-bridge", adapter: "claude-a2a-patch-bridge" };
  }
  if (/claude-a2a-analysis-bridge\.mjs$/.test(bin)) {
    return { runtime: "claude-code", harness: "analysis-bridge", adapter: "claude-a2a-analysis-bridge" };
  }
  if (/hermes-a2a-analysis-bridge\.mjs$/.test(bin)) {
    return { runtime: "hermes", harness: "analysis-bridge", adapter: "hermes-a2a-analysis-bridge" };
  }
  if (/codex-a2a-analysis-bridge\.mjs$/.test(bin)) {
    return { runtime: "codex", harness: "analysis-bridge", adapter: "codex-a2a-analysis-bridge" };
  }
  return { runtime: "unknown", harness: "unknown", adapter: "unknown" };
}

function metadataMatchesDerived(metadata: Record<string, unknown> | undefined, derived: WorkerRuntimeMetadata): boolean {
  if (!metadata) return false;
  return metadata.runtime === derived.runtime && metadata.harness === derived.harness && metadata.adapter === derived.adapter;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function finiteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function redactRuntimeAuditMessage(value: string): string {
  return String(value ?? "")
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted-token]")
    .replace(/\b(Authorization\s*[:=]\s*Bearer\s+)[^\s"']+/gi, "$1[redacted]")
    .replace(/\b(BROKER_EDGE_SECRET|A2A_EDGE_SECRET|EDGE_SECRET|TOKEN|SECRET|API[_-]?KEY|PASSWORD)=\S+/gi, "$1[redacted-secret]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted-secret-like]");
}

function normalizeStringList(value: string[]): string[] {
  return Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
}

function normalizeRepoPath(path: string): string {
  return String(path ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^a\//, "").replace(/^b\//, "");
}

function writeSetPatternToRegExp(pattern: string): RegExp {
  const normalized = normalizeRepoPath(pattern);
  let source = "^";
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    const next = normalized[i + 1];
    if (ch === "*" && next === "*") {
      source += ".*";
      i += 1;
      continue;
    }
    if (ch === "*") {
      source += "[^/]*";
      continue;
    }
    source += escapeRegExp(ch);
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
