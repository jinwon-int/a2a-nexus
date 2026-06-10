/**
 * Mobile / Termux team-mode safety lane.
 *
 * Defines capability profiles for mobile-constrained nodes participating in
 * team aggregate assignments. Heavy gates (full E2E proof, broad regression)
 * are replaced with lightweight observation + status-only proofs. A NO-GO
 * signal is emitted when resources are insufficient, and GitHub write
 * operations are routed through a handoff target (e.g. node-hub/CI).
 *
 * Closes jinwon-int/plugin-a2a#85.
 */

// ── Types ─────────────────────────────────────────────────────

export type TeamMode =
  | "fanout"
  | "split"
  | "review"
  | "swarm";

export type NodeCapabilityProfile = {
  /** True when running on Android/Termux or another mobile-constrained host. */
  isMobile: boolean;
  /** True when the node has limited memory or CPU. */
  isLowResource: boolean;
  /** Maximum concurrent team tasks this node can handle. */
  maxConcurrentTasks: number;
  /** Whether the node can run heavy proof loops (E2E regression, broad gates). */
  canRunHeavyProof: boolean;
  /** Whether the node can push directly to GitHub. */
  canPushToGitHub: boolean;
  /** Preferred handoff target for GitHub write operations. */
  githubWriteHandoff?: string;
};

export type MobileLaneConfig = {
  /** Which team modes this node can participate in. */
  allowedModes: TeamMode[];
  /** Which team modes this node should observe-only (no proof submission). */
  observeOnlyModes: TeamMode[];
  /** Whether to emit a NO-GO when low-resource. */
  emitNoGoOnLowResource: boolean;
};

export type NoGoSignal = {
  type: "team_assignment_no_go";
  nodeId: string;
  reason: string;
  timestampMs: number;
  /** Whether the node can still participate in observe-only mode. */
  observeOnly: boolean;
  /** Suggested handoff targets (node ids). */
  handoffTargets: string[];
};

export type TeamAssignmentLaneResult =
  | { ok: true; lane: "full"; proofLevel: "full" | "lightweight" }
  | { ok: true; lane: "observe"; proofLevel: "none" }
  | { ok: false; signal: NoGoSignal };

// ── Defaults ──────────────────────────────────────────────────

const MOBILE_PROFILE: NodeCapabilityProfile = {
  isMobile: true,
  isLowResource: true,
  maxConcurrentTasks: 1,
  canRunHeavyProof: false,
  canPushToGitHub: false,
};

const DEFAULT_PROFILE: NodeCapabilityProfile = {
  isMobile: false,
  isLowResource: false,
  maxConcurrentTasks: 4,
  canRunHeavyProof: true,
  canPushToGitHub: true,
};

const MOBILE_LANE_CONFIG: MobileLaneConfig = {
  allowedModes: ["fanout", "review"],
  observeOnlyModes: ["swarm"],
  emitNoGoOnLowResource: true,
};

// ── Detection ─────────────────────────────────────────────────

function detectMobile(): boolean {
  const platform = typeof process !== "undefined" ? process.platform : "";
  const arch = typeof process !== "undefined" ? process.arch : "";
  return platform === "android" || arch === "arm64";
}

function detectLowResource(): boolean {
  if (detectMobile()) return true;
  try {
    const memInfo = require("os").totalmem?.();
    if (memInfo && memInfo < 2 * 1024 * 1024 * 1024) return true;
  } catch {}
  return false;
}

// ── Lane evaluation ───────────────────────────────────────────

export type MobileSafetyLaneOptions = {
  nodeId?: string;
  profile?: Partial<NodeCapabilityProfile>;
  laneConfig?: Partial<MobileLaneConfig>;
  handoffTargets?: string[];
  nowMs?: () => number;
};

export type MobileSafetyLane = {
  /** Evaluate whether this node can participate in a given team mode. */
  evaluate: (mode: TeamMode) => TeamAssignmentLaneResult;
  /** Get the current capability profile. */
  profile: () => NodeCapabilityProfile;
  /** Get the current lane config. */
  config: () => MobileLaneConfig;
  /** Generate a NO-GO signal for the given reason. */
  noGoSignal: (reason: string) => NoGoSignal;
  /** Check if a GitHub write should be handed off. */
  shouldHandoffGitHubWrite: () => boolean;
  /** Get the GitHub write handoff target, if configured. */
  githubWriteTarget: () => string | undefined;
};

export function createMobileSafetyLane(options: MobileSafetyLaneOptions = {}): MobileSafetyLane {
  const nowMs = options.nowMs ?? Date.now;
  const nodeId = options.nodeId ?? "unknown";
  const handoffTargets = options.handoffTargets ?? ["seoseo"];

  const isMobile = options.profile?.isMobile ?? detectMobile();
  const isLowResource = options.profile?.isLowResource ?? (options.profile?.isLowResource ?? detectLowResource());

  const profile: NodeCapabilityProfile = {
    ...(isMobile || isLowResource ? MOBILE_PROFILE : DEFAULT_PROFILE),
    ...options.profile,
    isMobile,
    isLowResource,
  };

  const laneConfig: MobileLaneConfig = {
    ...MOBILE_LANE_CONFIG,
    ...options.laneConfig,
  };

  function noGoSignal(reason: string): NoGoSignal {
    return {
      type: "team_assignment_no_go",
      nodeId,
      reason,
      timestampMs: nowMs(),
      observeOnly: laneConfig.observeOnlyModes.length > 0,
      handoffTargets,
    };
  }

  return {
    evaluate(mode: TeamMode): TeamAssignmentLaneResult {
      // Low-resource NO-GO check
      if (profile.isLowResource && laneConfig.emitNoGoOnLowResource) {
        // Allow lightweight participation in allowed modes even when low-resource
        if (laneConfig.allowedModes.includes(mode)) {
          return {
            ok: true,
            lane: "full",
            proofLevel: "lightweight",
          };
        }
        // Observe-only for observe modes
        if (laneConfig.observeOnlyModes.includes(mode)) {
          return {
            ok: true,
            lane: "observe",
            proofLevel: "none",
          };
        }
        // NO-GO for modes not listed in either
        return {
          ok: false,
          signal: noGoSignal(
            `Mode "${mode}" not available for mobile/low-resource node. ` +
            `Allowed: [${laneConfig.allowedModes.join(", ")}]. ` +
            `Observe-only: [${laneConfig.observeOnlyModes.join(", ")}].`
          ),
        };
      }

      // Non-mobile nodes: full participation
      if (laneConfig.allowedModes.includes(mode)) {
        return { ok: true, lane: "full", proofLevel: profile.canRunHeavyProof ? "full" : "lightweight" };
      }

      // Mode not in allowed list — NO-GO
      return {
        ok: false,
        signal: noGoSignal(`Mode "${mode}" not in allowed modes: [${laneConfig.allowedModes.join(", ")}]`),
      };
    },

    profile: () => ({ ...profile }),
    config: () => ({ ...laneConfig }),
    noGoSignal,
    shouldHandoffGitHubWrite: () => !profile.canPushToGitHub,
    githubWriteTarget: () => profile.githubWriteHandoff ?? handoffTargets[0],
  };
}
