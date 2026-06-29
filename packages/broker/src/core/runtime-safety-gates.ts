export type TerminalAction =
  | "pr_open"
  | "pr_merge"
  | "git_push"
  | "deploy_restart"
  | "release_tag"
  | "terminal_ack_replay"
  | "db_migration_prune"
  | "secret_handling";

export type TerminalActorRole = "explorer" | "researcher" | "implementer" | "verifier" | "finalizer" | "operator";

export interface TerminalActionRequest {
  action: TerminalAction;
  actorRole: TerminalActorRole;
  actorId: string;
  finalizerOnly?: boolean;
  freshApprovalToken?: string | null;
  approvalTokenIssuedAt?: string | null;
  approvalTokenMaxAgeMs?: number;
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

const DEFAULT_APPROVAL_TOKEN_MAX_AGE_MS = 5 * 60 * 1000;

export function evaluateTerminalActionGate(request: TerminalActionRequest): TerminalActionDecision {
  const blockers: string[] = [];
  const requiresFinalizer = request.finalizerOnly !== false;
  const actorIsFinalizer = request.actorRole === "finalizer";
  const approval = evaluateApprovalFreshness(request);

  if (requiresFinalizer && !actorIsFinalizer) {
    blockers.push(`terminal action ${request.action} requires finalizer actor`);
  }
  if (!approval.fresh) {
    blockers.push(`terminal action ${request.action} requires a fresh approval token`);
  }

  if (blockers.length === 0) {
    return { allowed: true, reason: "allowed_finalizer_fresh_approval", blockers: [] };
  }

  return {
    allowed: false,
    reason: !actorIsFinalizer && requiresFinalizer ? "non_finalizer_actor" : approval.reason,
    blockers,
  };
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
