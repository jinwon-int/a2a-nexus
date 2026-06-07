// ── Task-complexity classifier (source-only, deterministic) ──────────────────
//
// Classifies an A2A task's complexity level from source-visible signals:
// intent, target environment, approval gates, reference structure, and
// artifact count.  The classifier is pure (no IO, no broker state), fail-closed
// (unknown inputs yield "unclassifiable"), and bounded (output clamped to a
// four-level ordinal scale).
//
// Safety boundaries (all statically enforced):
//   - No broker/Gateway/worker service access
//   - No DB mutation or live provider send
//   - No subagent spawn or executor invocation
//   - No terminal ACK/replay or release operation
//   - No secret or credential exposure
//
// Reference: #970 Team2 (gwakga/soonwook) — task-complexity classifier lane.
// Parent:    #969  Team2 A2A next implementation lane.
// ─────────────────────────────────────────────────────────────────────────────

import type { A2AExchangeIntent, A2AWorkerEnvironment } from "./types.js";

// ---------------------------------------------------------------------------
// Complexity ordinal
// ---------------------------------------------------------------------------

/** Four-level ordinal complexity scale, strictly ordered. */
export type ComplexityLevel = "simple" | "moderate" | "complex" | "critical";

/** All complexity levels in ascending order. */
export const COMPLEXITY_LEVELS: readonly ComplexityLevel[] = [
  "simple",
  "moderate",
  "complex",
  "critical",
] as const;

/** Ordinal index lookup for comparison. */
export const COMPLEXITY_ORDINAL: ReadonlyMap<ComplexityLevel, number> = new Map(
  COMPLEXITY_LEVELS.map((level, idx) => [level, idx]),
);

/**
 * Compare two complexity levels. Returns -1 when a < b, 0 when equal, 1 when a > b.
 * Returns null when either level is unknown.
 */
export function compareComplexity(
  a: ComplexityLevel,
  b: ComplexityLevel,
): -1 | 0 | 1 | null {
  const ai = COMPLEXITY_ORDINAL.get(a);
  const bi = COMPLEXITY_ORDINAL.get(b);
  if (ai === undefined || bi === undefined) return null;
  if (ai < bi) return -1;
  if (ai > bi) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Base-complexity map: each intent maps to a base level
// ---------------------------------------------------------------------------

const INTENT_BASE_COMPLEXITY: ReadonlyMap<A2AExchangeIntent, ComplexityLevel> = new Map([
  // Read-only / low-risk intents
  ["chat", "simple"],
  ["analyze", "simple"],
  ["verify", "simple"],

  // Moderate-complexity intents
  ["backfill", "moderate"],
  ["propose_params", "moderate"],

  // Complex intents (may mutate workspace or validate changes)
  ["propose_patch", "complex"],
  ["validate_change", "complex"],
  ["apply_local_change", "complex"],

  // Critical intents (live impact / rollback)
  ["promote_to_live", "critical"],
  ["rollback_live", "critical"],
]);

// ── Environment complexity offset ──────────────────────────────────────────

/**
 * Environment complexity offset. Live environments shift the base complexity
 * up by one ordinal level; staging environments keep the base level; research
 * keeps the base level as well.
 */
export type ComplexityEnvironment = A2AWorkerEnvironment | "unknown";

export const ENVIRONMENT_COMPLEXITY_OFFSET: ReadonlyMap<
  ComplexityEnvironment,
  number
> = new Map([
  ["live", 1],
  ["staging", 0],
  ["research", 0],
  ["unknown", 0],
]);

// ── Policy-context signals ─────────────────────────────────────────────────

export interface TaskComplexityPolicyContext {
  /** When true, shift complexity up by one. */
  requiresApproval?: boolean;
  /** When true, shift complexity up by one (cumulative with requiresApproval). */
  liveImpact?: boolean;
}

// ── Classifier input ───────────────────────────────────────────────────────

export interface TaskComplexityInput {
  /** Task intent (required). */
  intent: A2AExchangeIntent;
  /** Target worker runtime environment. Defaults to "unknown". */
  targetEnvironment?: ComplexityEnvironment;
  /** Policy gates data. */
  policyContext?: TaskComplexityPolicyContext;
  /** Number of cross-task reference task IDs. Defaults to 0. */
  referenceCount?: number;
  /** Number of attached artifact IDs. Defaults to 0. */
  artifactCount?: number;
  /** Number of intended message turns / sub-steps. Defaults to 1. */
  turnCount?: number;
}

// ---------------------------------------------------------------------------
// Signal extraction
// ---------------------------------------------------------------------------

export interface TaskComplexitySignals {
  /** Base level derived from intent alone. */
  baseLevel: ComplexityLevel | null;
  /** Whether the base lookup succeeded. */
  intentRecognized: boolean;
  /** Environment offset (0, 1). */
  environmentOffset: number;
  /** Whether approval is required. */
  requiresApproval: boolean;
  /** Whether the task has live impact. */
  liveImpact: boolean;
  /** Effective reference count. */
  effectiveReferenceCount: number;
  /** Effective artifact count. */
  effectiveArtifactCount: number;
  /** Effective turn count. */
  effectiveTurnCount: number;
  /** Total modifier steps (sum of all offsets). */
  totalOffset: number;
}

/**
 * Extract deterministic signals from a task complexity input.
 * Pure function — no side effects, no IO.
 */
export function extractTaskComplexitySignals(
  input: TaskComplexityInput,
): TaskComplexitySignals {
  const baseLevel = INTENT_BASE_COMPLEXITY.get(input.intent) ?? null;

  const environmentOffset =
    ENVIRONMENT_COMPLEXITY_OFFSET.get(input.targetEnvironment ?? "unknown") ?? 0;

  const requiresApproval = input.policyContext?.requiresApproval === true;
  const liveImpact = input.policyContext?.liveImpact === true;

  const effectiveReferenceCount =
    typeof input.referenceCount === "number" && input.referenceCount >= 0
      ? input.referenceCount
      : 0;

  const effectiveArtifactCount =
    typeof input.artifactCount === "number" && input.artifactCount >= 0
      ? input.artifactCount
      : 0;

  const effectiveTurnCount =
    typeof input.turnCount === "number" && input.turnCount >= 1
      ? input.turnCount
      : 1;

  // Offset contributions:
  //   +1 for live environment
  //   +1 for requiresApproval
  //   +1 for liveImpact
  //   +1 for referenceCount >= 3
  //   +1 for artifactCount >= 3
  //   +1 for turnCount >= 5
  let totalOffset = environmentOffset;
  if (requiresApproval) totalOffset += 1;
  if (liveImpact) totalOffset += 1;
  if (effectiveReferenceCount >= 3) totalOffset += 1;
  if (effectiveArtifactCount >= 3) totalOffset += 1;
  if (effectiveTurnCount >= 5) totalOffset += 1;

  return {
    baseLevel,
    intentRecognized: baseLevel !== null,
    environmentOffset,
    requiresApproval,
    liveImpact,
    effectiveReferenceCount,
    effectiveArtifactCount,
    effectiveTurnCount,
    totalOffset,
  };
}

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

export type TaskComplexityOrigin =
  | "intent-derived"
  | "offset-adjusted"
  | "unclassifiable"
  | "clamped-to-boundary";

export interface TaskComplexityClassification {
  /** The stable complexity level. */
  level: ComplexityLevel;
  /** Human-readable rationale. */
  reason: string;
  /** How the level was determined. */
  origin: TaskComplexityOrigin;
  /** Extracted signals for transparency. */
  signals: TaskComplexitySignals;
}

// ---------------------------------------------------------------------------
// Clamp bounds
// ---------------------------------------------------------------------------

/**
 * Bounds for complexity classification. When the computed ordinal is outside
 * these bounds, it is clamped to the nearest bound.
 */
export interface ComplexityBounds {
  min: ComplexityLevel;
  max: ComplexityLevel;
}

/** Default safety bounds: allow the full range. */
export const DEFAULT_COMPLEXITY_BOUNDS: ComplexityBounds = {
  min: "simple",
  max: "critical",
};

/** Hermes/mobile bounds: never permit "critical" classification. */
export const HERMES_MOBILE_BOUNDS: ComplexityBounds = {
  min: "simple",
  max: "complex",
};

/** Read-only bounds: never exceed "moderate". */
export const READONLY_BOUNDS: ComplexityBounds = {
  min: "simple",
  max: "moderate",
};

// ---------------------------------------------------------------------------
// Core classifier
// ---------------------------------------------------------------------------

/**
 * Deterministically classify task complexity from source-only inputs.
 *
 * 1. Derive base level from task intent.
 * 2. Apply environment/policy/reference/artifact/turn offsets.
 * 3. Clamp result to the configured safety bounds.
 *
 * Returns a rationaled {@link TaskComplexityClassification} that downstream
 * orchestrators can use for routing, staleness, or budget decisions.
 *
 * @param input  Source-visible task features (pure data, no IO).
 * @param bounds Safety bounds for clamping. Defaults to full range.
 */
export function classifyTaskComplexity(
  input: TaskComplexityInput,
  bounds: ComplexityBounds = DEFAULT_COMPLEXITY_BOUNDS,
): TaskComplexityClassification {
  const signals = extractTaskComplexitySignals(input);

  // Unclassifiable when intent is not recognized
  if (!signals.intentRecognized) {
    return {
      level: bounds.min,
      reason: `Unknown intent "${input.intent}"; defaulting to minimum safety bound ${bounds.min}`,
      origin: "unclassifiable",
      signals,
    };
  }

  // Compute raw ordinal
  const baseOrdinal = COMPLEXITY_ORDINAL.get(signals.baseLevel!)!;
  const rawOrdinal = baseOrdinal + signals.totalOffset;

  // Clamp to safety bounds
  const minOrdinal = COMPLEXITY_ORDINAL.get(bounds.min)!;
  const maxOrdinal = COMPLEXITY_ORDINAL.get(bounds.max)!;
  const clampedOrdinal = Math.max(minOrdinal, Math.min(maxOrdinal, rawOrdinal));
  const level = COMPLEXITY_LEVELS[clampedOrdinal]!;

  // Build reason
  let origin: TaskComplexityOrigin;
  const parts: string[] = [`base="${signals.baseLevel}"`];

  if (rawOrdinal !== baseOrdinal) {
    if (signals.environmentOffset > 0) parts.push(`env=+${signals.environmentOffset}`);
    if (signals.requiresApproval) parts.push("approval=+1");
    if (signals.liveImpact) parts.push("liveImpact=+1");
    if (signals.effectiveReferenceCount >= 3) parts.push(`refs>=3`);
    if (signals.effectiveArtifactCount >= 3) parts.push(`artifacts>=3`);
    if (signals.effectiveTurnCount >= 5) parts.push(`turns>=5`);
  }

  if (clampedOrdinal !== rawOrdinal) {
    origin = "clamped-to-boundary";
    parts.push(`clamped from ordinal ${rawOrdinal} to bound [${bounds.min}..${bounds.max}]`);
  } else if (rawOrdinal !== baseOrdinal) {
    origin = "offset-adjusted";
  } else {
    origin = "intent-derived";
  }

  const reasons = parts.join("; ");

  return {
    level,
    reason: `complexity=${level}: ${reasons}`,
    origin,
    signals,
  };
}

/**
 * Produce a compact complexity report for an array of task inputs.
 * Pure function — no IO, no broker state.
 */
export function classifyTaskComplexities(
  inputs: TaskComplexityInput[],
  bounds?: ComplexityBounds,
): TaskComplexityClassification[] {
  return inputs.map((input) => classifyTaskComplexity(input, bounds));
}

// ---------------------------------------------------------------------------
// Aggregated report
// ---------------------------------------------------------------------------

export interface TaskComplexityAggregateReport {
  total: number;
  byLevel: Record<ComplexityLevel, number>;
  unclassifiable: number;
  clamped: number;
  classifications: TaskComplexityClassification[];
}

/**
 * Aggregate a set of complexity classifications into a summary report.
 */
export function aggregateTaskComplexity(
  classifications: TaskComplexityClassification[],
): TaskComplexityAggregateReport {
  const byLevel: Record<ComplexityLevel, number> = {
    simple: 0,
    moderate: 0,
    complex: 0,
    critical: 0,
  };

  let unclassifiable = 0;
  let clamped = 0;

  for (const c of classifications) {
    byLevel[c.level] = (byLevel[c.level] ?? 0) + 1;
    if (c.origin === "unclassifiable") unclassifiable += 1;
    if (c.origin === "clamped-to-boundary") clamped += 1;
  }

  return {
    total: classifications.length,
    byLevel,
    unclassifiable,
    clamped,
    classifications,
  };
}

// ---------------------------------------------------------------------------
// Preset input profiles (for testing and documentation)
// ---------------------------------------------------------------------------

export const SIMPLE_ANALYSIS_INPUT: TaskComplexityInput = {
  intent: "analyze",
  targetEnvironment: "research",
};

export const MODERATE_BACKFILL_INPUT: TaskComplexityInput = {
  intent: "backfill",
  targetEnvironment: "staging",
  policyContext: { requiresApproval: false },
};

export const COMPLEX_PATCH_INPUT: TaskComplexityInput = {
  intent: "propose_patch",
  targetEnvironment: "research",
  policyContext: { requiresApproval: true },
  artifactCount: 2,
};

export const COMPLEX_APPLY_INPUT: TaskComplexityInput = {
  intent: "apply_local_change",
  targetEnvironment: "staging",
  policyContext: { requiresApproval: true, liveImpact: false },
  referenceCount: 4,
  artifactCount: 3,
};

export const CRITICAL_PROMOTE_INPUT: TaskComplexityInput = {
  intent: "promote_to_live",
  targetEnvironment: "live",
  policyContext: { requiresApproval: true, liveImpact: true },
  referenceCount: 2,
  artifactCount: 1,
};

export const CRITICAL_ROLLBACK_INPUT: TaskComplexityInput = {
  intent: "rollback_live",
  targetEnvironment: "live",
  policyContext: { requiresApproval: true, liveImpact: true },
  turnCount: 5,
};

export const UNKNOWN_INTENT_INPUT: TaskComplexityInput = {
  intent: "chat" as A2AExchangeIntent, // will be overridden in tests
};
