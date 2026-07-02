// ── Resource-aware worker policy ─────────────────────────────────────────
//
// Validation fixtures, types, and GO/NO-GO evaluation for resource-aware
// worker onboarding flags: maxConcurrent, allowedTaskTypes, noLiveSend,
// noMutation, gatewayRequired, mobileLowPower, standby/read-only, and
// GO/NO-GO examples for mobilealpha/Hermes and mobilebeta-style worker onboarding.
//
// This is source-only and fail-closed.  It does not inspect live host or
// gateway state, spawn subagents, dispatch broker work, claim tasks, invoke
// executors, create TaskFlow records, mutate DB state, deploy/restart
// services, send providers, ACK/replay terminal rows, publish releases, or
// move secrets.
// ─────────────────────────────────────────────────────────────────────────────

import type { A2AExchangeIntent, A2AWorkerEnvironment } from "./types.js";

// ── Resource-aware policy flags ────────────────────────────────────────────

/**
 * Resource-aware worker policy flags.
 *
 * Every flag defaults to `false` when absent, so adding a new flag cannot
 * accidentally grant a permission — the worker must explicitly opt in.
 */
export interface ResourceAwareWorkerPolicy {
  /** Maximum number of concurrent tasks this worker should handle. */
  maxConcurrent?: number;

  /** Task types this worker is allowed to accept. Empty means deny-all. */
  allowedTaskTypes: A2AExchangeIntent[];

  /** Forbid sending live/visible provider messages (Telegram, Hermes, etc.). */
  noLiveSend: boolean;

  /** Forbid mutating broker or worker state. */
  noMutation: boolean;

  /** Worker requires a full OpenClaw Gateway on-device. */
  gatewayRequired: boolean;

  /** Worker is running on a battery/mobile device with power constraints. */
  mobileLowPower: boolean;

  /** Accept no new tasks; drain existing ones. */
  standby: boolean;

  /** Reject all mutations; only allow reads and evidence submission. */
  readOnly: boolean;
}

// ── Predefined policy templates ────────────────────────────────────────────

export const mobilealpha_HERMES_POLICY: ResourceAwareWorkerPolicy = {
  allowedTaskTypes: ["analyze", "validate_change"],
  noLiveSend: true,
  noMutation: true,
  gatewayRequired: false,
  mobileLowPower: true,
  standby: false,
  readOnly: true,
};

export const mobilebeta_STYLE_POLICY: ResourceAwareWorkerPolicy = {
  allowedTaskTypes: ["propose_patch", "apply_local_change", "analyze"],
  noLiveSend: false,
  noMutation: false,
  gatewayRequired: true,
  mobileLowPower: false,
  standby: false,
  readOnly: false,
  maxConcurrent: 3,
};

// ── Policy validation ──────────────────────────────────────────────────────

export interface ResourcePolicyValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a resource-aware worker policy.
 *
 * Fails closed on contradictions, missing required fields, or unsafe
 * combinations.
 */
export function validateResourceAwareWorkerPolicy(
  policy: ResourceAwareWorkerPolicy,
): ResourcePolicyValidationResult {
  const errors: string[] = [];

  // allowedTaskTypes is required and must be a non-empty array
  const taskTypesOk = Array.isArray(policy.allowedTaskTypes) && policy.allowedTaskTypes.length > 0;
  if (!taskTypesOk) {
    errors.push("allowedTaskTypes must be a non-empty array");
  }

  // maxConcurrent must be a positive integer when set
  if (policy.maxConcurrent !== undefined) {
    if (!Number.isInteger(policy.maxConcurrent) || policy.maxConcurrent < 1) {
      errors.push("maxConcurrent must be a positive integer when set");
    }
  }

  // noLiveSend must be boolean
  if (typeof policy.noLiveSend !== "boolean") {
    errors.push("noLiveSend must be a boolean");
  }

  // noMutation must be boolean
  if (typeof policy.noMutation !== "boolean") {
    errors.push("noMutation must be a boolean");
  }

  // gatewayRequired must be boolean
  if (typeof policy.gatewayRequired !== "boolean") {
    errors.push("gatewayRequired must be a boolean");
  }

  // mobileLowPower must be boolean
  if (typeof policy.mobileLowPower !== "boolean") {
    errors.push("mobileLowPower must be a boolean");
  }

  // standby must be boolean
  if (typeof policy.standby !== "boolean") {
    errors.push("standby must be a boolean");
  }

  // readOnly must be boolean
  if (typeof policy.readOnly !== "boolean") {
    errors.push("readOnly must be a boolean");
  }

  // Contradictions: standby + maxConcurrent > 0 is suspicious
  if (policy.standby && (policy.maxConcurrent ?? 1) > 0) {
    errors.push("standby is true but maxConcurrent > 0; standby should accept no new tasks");
  }

  // Contradictions: noLiveSend + noMutation → implicitly readOnly
  if (policy.noLiveSend && policy.noMutation && !policy.readOnly) {
    errors.push(
      "noLiveSend and noMutation both true implies readOnly should also be true",
    );
  }

  // Contradictions: readOnly + noMutation=false or noLiveSend=false
  if (policy.readOnly) {
    if (!policy.noMutation) {
      errors.push("readOnly=true requires noMutation=true");
    }
    if (!policy.noLiveSend) {
      errors.push("readOnly=true requires noLiveSend=true");
    }
  }

  // Contradictions: noMutation but allowedTaskTypes includes apply_local_change
  if (taskTypesOk && policy.noMutation && policy.allowedTaskTypes!.includes("apply_local_change")) {
    errors.push(
      "noMutation=true but allowedTaskTypes includes apply_local_change which requires mutation",
    );
  }

  // Contradictions: noLiveSend but allowedTaskTypes includes promote_to_live
  if (taskTypesOk && policy.noLiveSend && policy.allowedTaskTypes!.includes("promote_to_live")) {
    errors.push(
      "noLiveSend=true but allowedTaskTypes includes promote_to_live which requires live send",
    );
  }

  // mobileLowPower workers should not have high maxConcurrent
  if (policy.mobileLowPower && (policy.maxConcurrent ?? 1) > 2) {
    errors.push("mobileLowPower workers should limit maxConcurrent to 2 or less");
  }

  // gatewayRequired=true workers on mobileLowPower is contradictory
  if (policy.gatewayRequired && policy.mobileLowPower) {
    errors.push(
      "gatewayRequired=true and mobileLowPower=true is contradictory: Gateway is not a low-power runtime",
    );
  }

  return { ok: errors.length === 0, errors };
}

// ── GO/NO-GO evaluation ────────────────────────────────────────────────────

export type WorkerOnboardingKind =
  | "mobilealpha-hermes"
  | "mobilebeta-style"
  | "standard-gateway"
  | "team1-scheduling-attribution"
  | "generic-terms";

export interface WorkerOnboardingEvaluation {
  kind: WorkerOnboardingKind;
  policy: ResourceAwareWorkerPolicy;
  validation: ResourcePolicyValidationResult;
  decision: "go" | "no-go";
  reasons: string[];
}

/**
 * Evaluate whether a worker onboarding profile passes GO/NO-GO gates.
 */
export function evaluateWorkerOnboarding(
  kind: WorkerOnboardingKind,
  policy: ResourceAwareWorkerPolicy,
): WorkerOnboardingEvaluation {
  const validation = validateResourceAwareWorkerPolicy(policy);
  const reasons: string[] = [];

  if (!validation.ok) {
    reasons.push("Policy validation failed: " + validation.errors.join("; "));
    return { kind, policy, validation, decision: "no-go", reasons };
  }

  switch (kind) {
    case "mobilealpha-hermes": {
      // mobilealpha/Hermes workers must be readOnly, noLiveSend, noMutation,
      // mobileLowPower, and NOT gatewayRequired
      if (!policy.readOnly) {
        reasons.push("mobilealpha/Hermes workers must be readOnly");
      }
      if (!policy.noLiveSend) {
        reasons.push("mobilealpha/Hermes workers must set noLiveSend=true");
      }
      if (!policy.noMutation) {
        reasons.push("mobilealpha/Hermes workers must set noMutation=true");
      }
      if (!policy.mobileLowPower) {
        reasons.push("mobilealpha/Hermes workers must set mobileLowPower=true");
      }
      if (policy.gatewayRequired) {
        reasons.push("mobilealpha/Hermes workers must NOT set gatewayRequired=true");
      }
      // Hermes workers should not have promote_to_live in allowedTaskTypes
      if (policy.allowedTaskTypes.includes("promote_to_live")) {
        reasons.push("mobilealpha/Hermes workers must not include promote_to_live in allowedTaskTypes");
      }
      break;
    }

    case "mobilebeta-style": {
      // mobilebeta-style workers require gateway, support mutation-capable task types,
      // no mobileLowPower, and must NOT be readOnly
      if (!policy.gatewayRequired) {
        reasons.push("mobilebeta-style workers must have gatewayRequired=true");
      }
      if (policy.mobileLowPower) {
        reasons.push("mobilebeta-style workers must not set mobileLowPower=true");
      }
      if (policy.readOnly) {
        reasons.push("mobilebeta-style workers must not be readOnly");
      }
      if (!policy.allowedTaskTypes.includes("propose_patch") &&
          !policy.allowedTaskTypes.includes("apply_local_change")) {
        reasons.push(
          "mobilebeta-style workers should include propose_patch or apply_local_change in allowedTaskTypes",
        );
      }
      break;
    }

    case "standard-gateway": {
      // Standard gateway: requires gateway, not mobile, not readOnly, has maxConcurrent
      if (!policy.gatewayRequired) {
        reasons.push("Standard gateway workers must have gatewayRequired=true");
      }
      if (policy.mobileLowPower) {
        reasons.push("Standard gateway workers must not set mobileLowPower=true");
      }
      if (policy.readOnly) {
        reasons.push("Standard gateway workers must not be readOnly");
      }
      if (!policy.maxConcurrent || policy.maxConcurrent < 1) {
        reasons.push("Standard gateway workers should set maxConcurrent to a positive integer");
      }
      break;
    }

    case "team1-scheduling-attribution": {
      // Team1 scheduling-attribution workers (workergamma lane / #1051):
      // Source-only scheduling attribute analysis; no live send, no mutation.
      // Does not require a full Gateway; runs on broker context.
      // Must be readOnly, noLiveSend, noMutation.
      // Must NOT have promote_to_live in allowedTaskTypes.
      // Should not be mobileLowPower (runs on broker/test host, not battery).
      if (!policy.readOnly) {
        reasons.push("Team1 scheduling-attribution workers must be readOnly");
      }
      if (!policy.noLiveSend) {
        reasons.push("Team1 scheduling-attribution workers must set noLiveSend=true");
      }
      if (!policy.noMutation) {
        reasons.push("Team1 scheduling-attribution workers must set noMutation=true");
      }
      if (policy.allowedTaskTypes.includes("promote_to_live")) {
        reasons.push("Team1 scheduling-attribution workers must not include promote_to_live");
      }
      if (policy.mobileLowPower) {
        reasons.push("Team1 scheduling-attribution workers should not set mobileLowPower=true (runs on broker context)");
      }
      // Recommended: include "analyze" and/or "validate_change" task types
      if (!policy.allowedTaskTypes.includes("analyze") &&
          !policy.allowedTaskTypes.includes("validate_change")) {
        reasons.push(
          "Team1 scheduling-attribution workers should include analyze or validate_change in allowedTaskTypes",
        );
      }
      break;
    }

    case "generic-terms": {
      // Generic: only basic validation applies; any valid policy passes
      break;
    }

    default: {
      reasons.push("Unknown worker onboarding kind: " + kind);
    }
  }

  const decision = reasons.length === 0 ? "go" : "no-go";

  if (decision === "go") {
    reasons.push("All GO/NO-GO gates passed for " + kind);
  }

  return { kind, policy, validation, decision, reasons };
}

// ── Policy diff helper ─────────────────────────────────────────────────────

export interface PolicyDiffEntry {
  field: keyof ResourceAwareWorkerPolicy;
  expected: unknown;
  actual: unknown;
  match: boolean;
}

/**
 * Compare a worker's declared policy against an expected policy template.
 * Returns a list of field-level diffs.
 */
export function diffResourceAwareWorkerPolicy(
  declared: ResourceAwareWorkerPolicy,
  expected: ResourceAwareWorkerPolicy,
): PolicyDiffEntry[] {
  const fields: (keyof ResourceAwareWorkerPolicy)[] = [
    "maxConcurrent",
    "allowedTaskTypes",
    "noLiveSend",
    "noMutation",
    "gatewayRequired",
    "mobileLowPower",
    "standby",
    "readOnly",
  ];

  return fields.map((field) => {
    const declaredVal = declared[field];
    const expectedVal = expected[field];
    let match: boolean;
    if (field === "allowedTaskTypes") {
      // Order-independent comparison
      const dv = (declaredVal as string[])?.slice().sort() ?? [];
      const ev = (expectedVal as string[])?.slice().sort() ?? [];
      match = dv.length === ev.length && dv.every((v, i) => v === ev[i]);
    } else {
      match = declaredVal === expectedVal;
    }
    return { field, expected: expectedVal, actual: declaredVal, match };
  });
}

// ── Preset policies for common onboarding scenarios ────────────────────────

export const workergamma_SCHEDULING_POLICY: ResourceAwareWorkerPolicy = {
  allowedTaskTypes: ["analyze", "validate_change"],
  noLiveSend: true,
  noMutation: true,
  gatewayRequired: false,
  mobileLowPower: false,
  standby: false,
  readOnly: true,
};

/**
 * workergamma lane scheduling-attribution policy (Team1).
 *
 * This preset covers the workergamma lane (#1051) for host scheduling attribution
 * evidence — source-only analysis of scheduling timing windows, accept-queue
 * delay, and host scheduler attribution. Workers following this policy:
 * - are readOnly (source-only evidence submission)
 * - forbid live sends and mutations
 * - do NOT require a Gateway (run on broker/test context)
 * - are NOT mobileLowPower (run on broker host, not battery)
 */
export const PRESET_POLICIES: Record<string, ResourceAwareWorkerPolicy> = {
  "mobilealpha-hermes": mobilealpha_HERMES_POLICY,
  "mobilebeta-style": mobilebeta_STYLE_POLICY,
  "team1-scheduling-attribution": workergamma_SCHEDULING_POLICY,
};

/**
 * Return the canonical preset policy for a given onboarding kind, or null.
 */
export function getPresetPolicy(kind: WorkerOnboardingKind): ResourceAwareWorkerPolicy | null {
  return PRESET_POLICIES[kind] ?? null;
}
