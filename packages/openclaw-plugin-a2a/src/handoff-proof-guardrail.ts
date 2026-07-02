/**
 * Mobile / low-resource handoff proof guardrails (Round 15).
 *
 * Ensures handoff proof observation on mobile/low-resource nodes stays
 * lightweight. Heavy verification (full gate runs, deep proof loops) is
 * delegated to a hub/CI/dedicated environment.
 *
 * Mobile nodes submit observation payloads; they never run heavy gates.
 *
 * Closes jinwon-int/plugin-a2a#81.
 */

// ── Types ─────────────────────────────────────────────────────

export type NodeResourceProfile = {
  isMobile: boolean;
  isLowResource: boolean;
  /** Approximate free memory in MB (0 = unknown). */
  freeMemoryMb: number;
  /** Approximate CPU load 0-1 (0 = unknown). */
  cpuLoad: number;
  nodeId?: string;
};

export type ProofCommandKind =
  | "observe_ping"
  | "observe_dispatch"
  | "observe_ack"
  | "observe_health"
  | "full_gate"
  | "full_proof_loop"
  | "full_regression";

/** Commands safe to run on mobile/low-resource nodes. */
export const MOBILE_SAFE_COMMANDS: readonly ProofCommandKind[] = [
  "observe_ping",
  "observe_dispatch",
  "observe_ack",
  "observe_health",
] as const;

/** Commands that MUST NOT run on mobile/low-resource nodes. */
export const HEAVY_COMMANDS: readonly ProofCommandKind[] = [
  "full_gate",
  "full_proof_loop",
  "full_regression",
] as const;

export type NoGoReason =
  | "memory_pressure"
  | "cpu_pressure"
  | "mobile_no_heavy"
  | "network_degraded"
  | "service_unstable"
  | "timeout_risk";

export type HandoffProofObservation = {
  nodeId: string;
  timestamp: string;
  command: ProofCommandKind;
  status: "ok" | "nogo" | "delegated";
  /** Duration in ms. */
  durationMs: number;
  /** If status is "nogo", the reason(s). */
  noGoReasons?: NoGoReason[];
  /** Observation payload — lightweight key-value pairs only. */
  observations: Record<string, string | number | boolean>;
  /** If delegated, the target environment. */
  delegatedTo?: string;
};

export type HandoffProofResult = {
  allowed: boolean;
  reason?: string;
  noGoReasons: NoGoReason[];
  delegateTo?: string;
  observation?: HandoffProofObservation;
};

export type HandoffGuardOptions = {
  nodeProfile?: Partial<NodeResourceProfile>;
  /** Memory threshold in MB below which NO-GO triggers. Default: 200. */
  memoryThresholdMb?: number;
  /** CPU load threshold above which NO-GO triggers (0-1). Default: 0.9. */
  cpuLoadThreshold?: number;
  /** Max allowed duration for any proof command in ms. Default: 30000. */
  maxCommandDurationMs?: number;
  /** Target for heavy command delegation. Defaults to the configured hub delegate. */
  delegateTarget?: string;
  /** Clock override for tests. */
  nowMs?: () => number;
};

// ── Defaults ──────────────────────────────────────────────────

const DEFAULTS: Required<
  Omit<HandoffGuardOptions, "nodeProfile" | "nowMs">
> = {
  memoryThresholdMb: 200,
  cpuLoadThreshold: 0.9,
  maxCommandDurationMs: 30000,
  delegateTarget: "brokerAlpha",
};

// ── Guardrail ─────────────────────────────────────────────────

export function createHandoffProofGuard(opts: HandoffGuardOptions = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const clock = opts.nowMs ?? (() => Date.now());

  function resolveProfile(): NodeResourceProfile {
    if (opts.nodeProfile) {
      return {
        isMobile: false,
        isLowResource: false,
        freeMemoryMb: 0,
        cpuLoad: 0,
        ...opts.nodeProfile,
      };
    }
    return detectResourceProfile();
  }

  function assessNoGo(profile: NodeResourceProfile): NoGoReason[] {
    const reasons: NoGoReason[] = [];

    if (profile.isMobile || profile.isLowResource) {
      // Mobile/low-resource nodes get stricter thresholds
      if (profile.freeMemoryMb > 0 && profile.freeMemoryMb < 400) {
        reasons.push("memory_pressure");
      }
      if (profile.cpuLoad > 0 && profile.cpuLoad > 0.8) {
        reasons.push("cpu_pressure");
      }
    } else {
      if (profile.freeMemoryMb > 0 && profile.freeMemoryMb < cfg.memoryThresholdMb) {
        reasons.push("memory_pressure");
      }
      if (profile.cpuLoad > 0 && profile.cpuLoad > cfg.cpuLoadThreshold) {
        reasons.push("cpu_pressure");
      }
    }

    return reasons;
  }

  function checkCommand(
    command: ProofCommandKind,
    profile?: NodeResourceProfile,
  ): HandoffProofResult {
    const resolved = profile ?? resolveProfile();
    const noGoReasons = assessNoGo(resolved);
    const isHeavy = HEAVY_COMMANDS.includes(command);
    const isMobileOrLow = resolved.isMobile || resolved.isLowResource;

    // Mobile/low-resource nodes cannot run heavy commands
    if (isMobileOrLow && isHeavy) {
      return {
        allowed: false,
        reason: `Mobile/low-resource node cannot run ${command}. Delegate to ${cfg.delegateTarget}.`,
        noGoReasons: [...noGoReasons, "mobile_no_heavy"],
        delegateTo: cfg.delegateTarget,
      };
    }

    // NO-GO conditions block even lightweight commands
    if (noGoReasons.length > 0) {
      return {
        allowed: false,
        reason: `Resource pressure detected: ${noGoReasons.join(", ")}`,
        noGoReasons,
        delegateTo: cfg.delegateTarget,
      };
    }

    return {
      allowed: true,
      noGoReasons: [],
    };
  }

  function submitObservation(
    command: ProofCommandKind,
    observations: Record<string, string | number | boolean>,
    durationMs: number,
    profile?: NodeResourceProfile,
  ): HandoffProofObservation {
    const resolved = profile ?? resolveProfile();
    const check = checkCommand(command, resolved);
    const now = new Date(clock()).toISOString();

    if (!check.allowed) {
      return {
        nodeId: resolved.nodeId ?? "unknown",
        timestamp: now,
        command,
        status: "delegated",
        durationMs,
        noGoReasons: check.noGoReasons,
        observations,
        delegatedTo: check.delegateTo ?? cfg.delegateTarget,
      };
    }

    return {
      nodeId: resolved.nodeId ?? "unknown",
      timestamp: now,
      command,
      status: "ok",
      durationMs,
      observations,
    };
  }

  function createMobileSafeScenarioMatrix(): MobileScenarioMatrix {
    return {
      S1: { command: "observe_ping", mobileSafe: true, description: "Broker ping observation" },
      S2: { command: "observe_dispatch", mobileSafe: true, description: "Dispatch event observation" },
      S3: { command: "observe_ack", mobileSafe: true, description: "ACK receipt observation" },
      S4: { command: "observe_health", mobileSafe: true, description: "Health check observation" },
      S5: { command: "full_gate", mobileSafe: false, description: "Full gate verification", delegateTo: cfg.delegateTarget },
    };
  }

  return {
    checkCommand,
    submitObservation,
    resolveProfile,
    assessNoGo,
    createMobileSafeScenarioMatrix,
    config: cfg,
  };
}

// ── Scenario Matrix Type ──────────────────────────────────────

export type MobileScenarioLane = {
  command: ProofCommandKind;
  mobileSafe: boolean;
  description: string;
  delegateTo?: string;
};

export type MobileScenarioMatrix = {
  [scenarioId: string]: MobileScenarioLane;
};

// ── Resource Detection ────────────────────────────────────────

function detectResourceProfile(): NodeResourceProfile {
  let freeMemoryMb = 0;
  let cpuLoad = 0;

  try {
    // Try /proc/meminfo (Linux/Android)
    const meminfo = fs.readFileSync("/proc/meminfo", "utf-8");
    const memFreeMatch = meminfo.match(/MemAvailable:\s*(\d+)\s*kB/);
    if (memFreeMatch) {
      freeMemoryMb = Math.round(Number(memFreeMatch[1]) / 1024);
    }
  } catch {
    // Not Linux — leave as 0 (unknown)
  }

  try {
    // Try /proc/loadavg (Linux/Android)
    const loadavg = fs.readFileSync("/proc/loadavg", "utf-8");
    const loadMatch = loadavg.match(/^([\d.]+)/);
    if (loadMatch) {
      // Normalize: assume 4 cores for mobile, load > cores = saturated
      cpuLoad = Math.min(Number(loadMatch[1]) / 4, 1);
    }
  } catch {
    // Not Linux — leave as 0
  }

  const isMobile = process.platform === "android" || !!process.env.TERMUX_VERSION;
  const isLowResource = freeMemoryMb > 0 && freeMemoryMb < 500;

  return { isMobile, isLowResource, freeMemoryMb, cpuLoad };
}

import fs from "node:fs";

// ── Export helpers for testing ────────────────────────────────

export { MOBILE_SAFE_COMMANDS as MOBILE_SAFE, HEAVY_COMMANDS as HEAVY };
