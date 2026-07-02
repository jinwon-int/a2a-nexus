// ── Complexity orchestration recommendation packet (source-only, no-live) ──
//
// Consumes a TaskComplexityClassification (produced by the task-complexity
// classifier, #970) and produces a deterministic, no-live orchestration
// recommendation packet.
//
// The packet maps each complexity level to an orchestration action:
//
//   simple   → direct execution (no subagent overhead)
//   moderate → sequential subagent with verification
//   complex  → parallel subagents (explore, implement, verify)
//   critical → operator review required (no autonomous orchestration)
//
// Safety boundaries (all statically enforced):
//   - No broker/Gateway/worker service access
//   - No DB mutation or live provider send
//   - No subagent spawn or executor invocation
//   - No terminal ACK/replay or release operation
//   - No secret or credential exposure
//
// Reference: #971 Team2 (brokerbeta/workereta) — no-live orchestration
//            recommendation packet after classifier.
// Parent:    #969  Team2 A2A next implementation lane.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import type {
  TaskComplexityClassification,
  ComplexityLevel,
} from "./task-complexity-classifier.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Deterministic orchestration action derived from complexity. */
export type OrchestrationAction =
  | "direct_execution"
  | "sequential_subagent"
  | "parallel_subagents"
  | "operator_review";

/** Confidence level based on classification origin stability. */
export type RecommendationConfidence = "high" | "medium" | "low";

/** A single role recommendation for the orchestration plan. */
export interface RecommendedRole {
  role: string;
  purpose: string;
}

/** Per-complexity-level orchestration recommendation. */
export interface ComplexityOrchestrationRecommendation {
  /** The stable complexity level this recommendation is derived from. */
  complexity: ComplexityLevel;
  /** High-level orchestration action. */
  action: OrchestrationAction;
  /** Suggested subagent parallelism (0 = direct/blocked, 1–3 = subagents). */
  parallelismHint: 0 | 1 | 2 | 3 | 4;
  /** Confidence in the recommendation based on classification stability. */
  confidence: RecommendationConfidence;
  /** Human-readable rationale anchored to the classification signals. */
  rationale: string;
  /** Roles recommended for subagent orchestration. */
  recommendedRoles: RecommendedRole[];
  /** Safety gate description — what must hold before acting on this. */
  safetyGate: string;
}

/** No-live orchestration recommendation packet. */
export interface ComplexityOrchestrationRecommendationPacket {
  kind: "a2a-broker.complexity-orchestration-recommendation-packet";
  version: 1;
  generatedAt: string;
  /**
   * Idempotency key derived from the classification and recommendation —
   * deterministic across identical inputs.
   */
  idempotencyKey: string;
  /** The classification that drove this recommendation. */
  classification: TaskComplexityClassification;
  /** The derived recommendation. */
  recommendation: ComplexityOrchestrationRecommendation;
  /** Static no-live boundary enforcement (always safe). */
  boundaries: {
    runtimeBehaviorChanged: false;
    mandatoryProductionSpawn: false;
    brokerDispatchSemanticsChanged: false;
    taskFlowMutation: false;
    dbMutation: false;
    deployOrRestart: false;
    secretMovement: false;
  };
}

// ---------------------------------------------------------------------------
// Static mapping tables
// ---------------------------------------------------------------------------

const COMPLEXITY_ACTION: Record<ComplexityLevel, OrchestrationAction> = {
  simple: "direct_execution",
  moderate: "sequential_subagent",
  complex: "parallel_subagents",
  critical: "operator_review",
};

const COMPLEXITY_PARALLELISM: Record<ComplexityLevel, 0 | 1 | 2 | 3> = {
  simple: 0,
  moderate: 1,
  complex: 2,
  critical: 0,
};

const COMPLEXITY_ROLES: Record<ComplexityLevel, RecommendedRole[]> = {
  simple: [],
  moderate: [
    { role: "verifier", purpose: "review output for correctness within bounded scope" },
  ],
  complex: [
    { role: "explorer", purpose: "bounded code and issue investigation across affected modules" },
    { role: "implementer", purpose: "scoped implementation of the validated change" },
    { role: "verifier", purpose: "test and risk review of the implemented change" },
  ],
  critical: [],
};

// ---------------------------------------------------------------------------
// Recommendation builder
// ---------------------------------------------------------------------------

/**
 * Build a human-readable rationale string for a recommendation based on the
 * classification's origin, signals, and derived action.
 */
function buildRationale(
  classification: TaskComplexityClassification,
  action: OrchestrationAction,
): string {
  const { origin, level, signals } = classification;
  const parts: string[] = [`complexity=${level}`];

  if (signals.intentRecognized) {
    parts.push(`intent-derived from "${signals.baseLevel}"`);
  }

  if (signals.totalOffset > 0) {
    parts.push(`offset=+${signals.totalOffset}`);
  }

  if (signals.requiresApproval) {
    parts.push("requires approval");
  }

  if (signals.liveImpact) {
    parts.push("live impact detected");
  }

  if (origin === "clamped-to-boundary") {
    parts.push("clamped to safety bounds");
  } else if (origin === "unclassifiable") {
    parts.push("defaulted to minimum bound");
  }

  switch (action) {
    case "direct_execution":
      parts.push("recommend direct execution without subagent overhead");
      break;
    case "sequential_subagent":
      parts.push("recommend single verifier subagent for bounded scope");
      break;
    case "parallel_subagents":
      parts.push("recommend parallel explorer+implementer+verifier subagents");
      break;
    case "operator_review":
      parts.push("recommend operator review — no autonomous orchestration");
      break;
  }

  return parts.join("; ");
}

/**
 * Build the safety gate description based on complexity level and action.
 */
function buildSafetyGate(
  level: ComplexityLevel,
  action: OrchestrationAction,
): string {
  switch (action) {
    case "direct_execution":
      return "Direct execution gate: trivial complexity — no subagent required. " +
        "Operator may proceed without orchestration.";
    case "sequential_subagent":
      return `Sequential subagent gate: ${level} complexity. ` +
        "Spawn exactly one verifier subagent. Wait for completion before " +
        "any subsequent action. No parallel dispatch.";
    case "parallel_subagents":
      return `Parallel subagent gate: ${level} complexity. ` +
        "Spawn explorer, implementer, and verifier subagents with disjoint " +
        "write sets. One finalizer required. No live execution until all " +
        "subagents complete and operator reviews.";
    case "operator_review":
      return `Operator review gate: ${level} complexity. ` +
        "No autonomous orchestration permitted. Route to operator for " +
        "manual review and explicit approval before any subagent spawn " +
        "or execution.";
  }
}

/**
 * Compute confidence based on classification origin stability.
 *
 * - "intent-derived" and "offset-adjusted" → high
 * - "clamped-to-boundary" → medium (boundary may shift)
 * - "unclassifiable" → low (uncertain input)
 */
function computeConfidence(
  origin: TaskComplexityClassification["origin"],
): RecommendationConfidence {
  switch (origin) {
    case "intent-derived":
    case "offset-adjusted":
      return "high";
    case "clamped-to-boundary":
      return "medium";
    case "unclassifiable":
      return "low";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Produce a no-live orchestration recommendation packet from a task-complexity
 * classification.
 *
 * The packet maps complexity levels to orchestration actions, parallelism
 * hints, recommended subagent roles, safety gates, and confidence. All logic
 * is pure and source-only — no IO, no broker state, no mutation.
 *
 * @param classification  A stable TaskComplexityClassification from the
 *                        task-complexity classifier (#970).
 * @param options         Optional overrides (generatedAt timestamp).
 */
export function buildComplexityOrchestrationRecommendation(
  classification: TaskComplexityClassification,
  options: { now?: string } = {},
): ComplexityOrchestrationRecommendationPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const { level, origin, signals } = classification;

  const action = COMPLEXITY_ACTION[level];
  const parallelismHint = COMPLEXITY_PARALLELISM[level];
  const confidence = computeConfidence(origin);
  const recommendedRoles = COMPLEXITY_ROLES[level];
  const rationale = buildRationale(classification, action);
  const safetyGate = buildSafetyGate(level, action);

  // Deterministic idempotency key
  const idempotencyKey = buildRecommendationIdempotencyKey(
    classification,
    action,
    parallelismHint,
  );

  return {
    kind: "a2a-broker.complexity-orchestration-recommendation-packet",
    version: 1,
    generatedAt,
    idempotencyKey,
    classification: { ...classification, signals: { ...signals } },
    recommendation: {
      complexity: level,
      action,
      parallelismHint,
      confidence,
      rationale,
      recommendedRoles: recommendedRoles.map((r) => ({ ...r })),
      safetyGate,
    },
    boundaries: {
      runtimeBehaviorChanged: false,
      mandatoryProductionSpawn: false,
      brokerDispatchSemanticsChanged: false,
      taskFlowMutation: false,
      dbMutation: false,
      deployOrRestart: false,
      secretMovement: false,
    },
  };
}

/**
 * Build a deterministic idempotency key from the classification and derived
 * recommendation. Same inputs always produce the same key.
 */
function buildRecommendationIdempotencyKey(
  classification: TaskComplexityClassification,
  action: OrchestrationAction,
  parallelismHint: number,
): string {
  const seed = stableStringify({
    level: classification.level,
    origin: classification.origin,
    action,
    parallelismHint,
    signalOffsets: classification.signals.totalOffset,
    environmentOffset: classification.signals.environmentOffset,
    requiresApproval: classification.signals.requiresApproval,
    liveImpact: classification.signals.liveImpact,
  });
  return "complexity-orch-recommendation:" +
    createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

/**
 * Render a recommendation packet to a human-readable markdown summary.
 * Pure function — no IO, no side effects.
 */
export function renderComplexityOrchestrationRecommendationMarkdown(
  packet: ComplexityOrchestrationRecommendationPacket,
): string {
  const r = packet.recommendation;
  const c = packet.classification;

  return [
    `# Complexity orchestration recommendation: ${r.action}`,
    "",
    `- **generatedAt**: ${packet.generatedAt}`,
    `- **idempotencyKey**: ${packet.idempotencyKey}`,
    `- **complexity**: ${r.complexity}`,
    `- **action**: ${r.action}`,
    `- **parallelismHint**: ${r.parallelismHint}`,
    `- **confidence**: ${r.confidence}`,
    "",
    "## Classification signals",
    "",
    `- **origin**: ${c.origin}`,
    `- **intentRecognized**: ${c.signals.intentRecognized}`,
    `- **environmentOffset**: ${c.signals.environmentOffset}`,
    `- **requiresApproval**: ${c.signals.requiresApproval}`,
    `- **liveImpact**: ${c.signals.liveImpact}`,
    `- **totalOffset**: ${c.signals.totalOffset}`,
    `- **effectiveReferenceCount**: ${c.signals.effectiveReferenceCount}`,
    `- **effectiveArtifactCount**: ${c.signals.effectiveArtifactCount}`,
    `- **effectiveTurnCount**: ${c.signals.effectiveTurnCount}`,
    "",
    "## Recommendation",
    "",
    `- **rationale**: ${r.rationale}`,
    `- **safetyGate**: ${r.safetyGate}`,
    "",
    "## Recommended roles",
    "",
    ...(r.recommendedRoles.length === 0
      ? ["*(none — direct execution or operator review)*"]
      : r.recommendedRoles.map(
          (role) => `- **${role.role}**: ${role.purpose}`,
        )),
    "",
    "## Boundaries (no-live enforcement)",
    "",
    ...Object.entries(packet.boundaries).map(
      ([key, val]) => `- **${key}**: ${val}`,
    ),
    "",
    "No orchestration action in this packet spawns subagents, mutates DB, " +
    "dispatches broker work, deploys/restarts services, moves secrets, " +
    "sends provider messages, or performs ACK/replay.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Stable JSON stringify for deterministic keying
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`)
    .join(",")}}`;
}
