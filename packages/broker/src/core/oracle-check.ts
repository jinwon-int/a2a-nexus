/**
 * oracle-check.ts — read-only ground-truth oracle core (#971).
 *
 * The core is deliberately dependency-injected: it never performs network,
 * filesystem, GitHub, CI, posting, merge, ACK, or DB mutation by itself.
 */

export type OracleSourceKind = "github" | "file" | "ci";
export type OracleMatch = boolean | "unresolved";

export interface OracleClaim {
  taskId: string;
  field: string;
  claimedValue: unknown;
  evidenceRef?: string;
  sourceKind: OracleSourceKind;
}

export interface GitHubOracleReality {
  kind: "github";
  exists?: boolean;
  merged?: boolean;
  state?: string;
  conclusion?: string;
}

export interface FileOracleReality {
  kind: "file";
  exists?: boolean;
  content?: string;
}

export interface CiOracleReality {
  kind: "ci";
  conclusion?: string;
  passed?: boolean;
}

export type OracleReality = GitHubOracleReality | FileOracleReality | CiOracleReality;

export interface OracleVerdict {
  match: OracleMatch;
  actualValue?: unknown;
  detail: string;
  checkedAt: string;
  sourceKind: OracleSourceKind;
  evidenceRef?: string;
}

export interface OracleCheckDeps {
  now?: () => string;
  github?: (claim: OracleClaim) => OracleReality | null | undefined | Promise<OracleReality | null | undefined>;
  file?: (claim: OracleClaim) => OracleReality | null | undefined | Promise<OracleReality | null | undefined>;
  ci?: (claim: OracleClaim) => OracleReality | null | undefined | Promise<OracleReality | null | undefined>;
}

export async function checkOracle(claim: OracleClaim, deps: OracleCheckDeps = {}): Promise<OracleVerdict> {
  const checkedAt = deps.now?.() ?? new Date().toISOString();
  try {
    const reality = await resolveReality(claim, deps);
    if (!reality) {
      return unresolved(claim, checkedAt, "unresolved: trusted source did not resolve evidence");
    }

    const actualValue = actualValueForClaim(claim, reality);
    if (actualValue === undefined) {
      return unresolved(claim, checkedAt, `unresolved: trusted source did not expose field ${claim.field}`);
    }

    const claimed = normalizeComparable(claim.claimedValue);
    const actual = normalizeComparable(actualValue);
    const ok = claimed === actual;
    return {
      match: ok,
      actualValue,
      detail: ok
        ? `${claim.sourceKind}.${claim.field} matched claimed value`
        : `${claim.sourceKind}.${claim.field} mismatch: claimed=${String(claimed)} actual=${String(actual)}`,
      checkedAt,
      sourceKind: claim.sourceKind,
      evidenceRef: claim.evidenceRef,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unresolved(claim, checkedAt, `unresolved: trusted source check threw: ${message}`);
  }
}

async function resolveReality(claim: OracleClaim, deps: OracleCheckDeps): Promise<OracleReality | null | undefined> {
  switch (claim.sourceKind) {
    case "github":
      return deps.github?.(claim);
    case "file":
      return deps.file?.(claim);
    case "ci":
      return deps.ci?.(claim);
  }
}

function actualValueForClaim(claim: OracleClaim, reality: OracleReality): unknown {
  const field = normalizeFieldName(claim.field);
  switch (reality.kind) {
    case "github":
      if (field === "merged" || field === "pr.merged") return reality.merged;
      if (field === "exists") return reality.exists;
      if (field === "state") return reality.state;
      if (field === "conclusion") return reality.conclusion;
      return undefined;
    case "file":
      if (field === "exists") return reality.exists;
      if (field === "content") return reality.content;
      return undefined;
    case "ci":
      if (field === "conclusion") return reality.conclusion;
      if (field === "passed" || field === "success") return reality.passed ?? reality.conclusion === "success";
      return undefined;
  }
}

function normalizeFieldName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeComparable(value: unknown): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^(true|yes|merged|success|passed)$/i.test(trimmed)) return true;
    if (/^(false|no|open|failure|failed)$/i.test(trimmed)) return false;
    return trimmed.toLowerCase();
  }
  return value;
}

function unresolved(claim: OracleClaim, checkedAt: string, detail: string): OracleVerdict {
  return {
    match: "unresolved",
    detail,
    checkedAt,
    sourceKind: claim.sourceKind,
    evidenceRef: claim.evidenceRef,
  };
}
