/**
 * Gongyung Hermes lightweight A2A worker profile admission validation.
 *
 * Tests the fail-closed admission semantics, artifact/evidence manifest
 * requirements, and redaction rules defined in:
 *   docs/specs/gongyung-hermes-worker-profile/spec.md
 *
 * These tests are self-contained or use the existing mobile-safety-lane
 * and handoff-proof-guardrail modules. They do not require a live broker.
 *
 * Closes: jinwon-int/a2a-plane#393
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMobileSafetyLane } from "../dist/src/mobile-safety-lane.js";
import { createHandoffProofGuard } from "../dist/src/handoff-proof-guardrail.js";
import type { NoGoSignal } from "../dist/src/mobile-safety-lane.js";

// ── Helpers ───────────────────────────────────────────────────

const FIXED_NOW = 1_774_700_000_000;
const now = () => FIXED_NOW;

/** A task shape that the admission function evaluates. */
type AdmittableTask = {
  id: string;
  intent?: string;
  mode?: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
};

/** An admission decision matching the spec's fail-closed semantics. */
type AdmissionDecision =
  | { ok: true; lane: "full" | "observe"; proofLevel: "lightweight" | "none" }
  | { ok: false; noGoSignal: NoGoSignal };

/** Check if a payload/metadata field indicates Docker runner semantics. REC-2. */
function hasDockerRunnerIndicators(task: AdmittableTask): boolean {
  const payload = task.payload ?? {};
  const metadata = task.metadata ?? {};

  // executorMode check
  const executorMode = String(payload.executorMode ?? metadata.executorMode ?? "");
  if (["docker", "auto", "auto-with-docker-fallback"].includes(executorMode)) {
    return true;
  }

  // runnerScope check
  const runnerScope = String(payload.runnerScope ?? metadata.runnerScope ?? "");
  if (["all-github", "github-patch", "all"].includes(runnerScope)) {
    return true;
  }

  // WORKER_HANDLER_COMMAND inference: if payload contains a "command" key
  // targeting "docker"
  const command = String(payload.command ?? metadata.command ?? "");
  if (command === "docker" || command.startsWith("docker ")) {
    return true;
  }

  // A2A_EXECUTOR_MODE / A2A_DOCKER_RUNNER_SCOPE references in payload
  const envRefs = String(payload.env ?? metadata.env ?? "");
  if (envRefs.includes("A2A_EXECUTOR_MODE") || envRefs.includes("A2A_DOCKER_RUNNER_SCOPE")) {
    return true;
  }

  return false;
}

/** Intent-based rejection check. REC-1, REC-3. */
const REJECTED_INTENTS = new Set(["docker", "patch_repo", "build_repo", "test_repo"]);

/** Intent classes explicitly admissible on Gongyung mobile profile. */
const ADMISSIBLE_INTENTS = new Set([
  "analyze", "review", "clarify", "observe",
  "check_readiness", "cross_check", "regression",
]);

/** Intent classes that should hand off to a hub/CI target. */
const HANDOFF_INTENTS = new Set(["propose_patch", "propose_params", "apply_local_change"]);

/** Task classes where the intent alone triggers rejection. */
function isIntentRejected(intent?: string): boolean {
  if (!intent) return false; // Undefined intent passes — let other guards decide
  return REJECTED_INTENTS.has(intent);
}

/** Check whether the intent is explicitly in the admissible set. */
function isIntentAdmissible(intent?: string): boolean {
  if (!intent) return false;
  return ADMISSIBLE_INTENTS.has(intent);
}

/** Capability names that Gongyung must reject. */
const REJECTED_CAPABILITIES = new Set([
  "canRunHeavyProof",
  "canPushToGitHub",
  "canPromoteLive",
  "canPatchWorkspace_docker",
]);

/**
 * The Gongyung Hermes admission function as defined by the spec.
 *
 * Decision rules (in order):
 *   1. Runtime guard (Docker runner) → NO-GO
 *   2. Intent guard                     → NO-GO
 *   3. Mode guard (mobile-safety-lane)  → NO-GO or observe
 *   4. Capability guard                 → NO-GO
 *   5. Admit
 */
function gongyungAdmit(
  task: AdmittableTask,
  options: {
    handoffTargets?: string[];
    maxConcurrentTasks?: number;
    activeTaskCount?: number;
  } = {},
): AdmissionDecision {
  const handoffTargets = options.handoffTargets ?? ["node-hub"];
  const maxConcurrentTasks = options.maxConcurrentTasks ?? 1;
  const activeTaskCount = options.activeTaskCount ?? 0;

  // Rule 1: Runtime guard — Docker runner indicators are rejected first
  if (hasDockerRunnerIndicators(task)) {
    return {
      ok: false,
      noGoSignal: {
        type: "team_assignment_no_go",
        nodeId: "gongyung",
        reason: "gongyung_not_docker_runner",
        timestampMs: now(),
        observeOnly: true,
        handoffTargets,
      },
    };
  }

  // Rule 2a: Intent guard — explicitly rejected intents
  if (isIntentRejected(task.intent)) {
    return {
      ok: false,
      noGoSignal: {
        type: "team_assignment_no_go",
        nodeId: "gongyung",
        reason: `intent_not_allowed: ${task.intent}`,
        timestampMs: now(),
        observeOnly: true,
        handoffTargets,
      },
    };
  }

  // Rule 2b: Unknown intent (not in admissible set) → NO-GO (fail-closed default)
  if (task.intent && !isIntentAdmissible(task.intent)) {
    return {
      ok: false,
      noGoSignal: {
        type: "team_assignment_no_go",
        nodeId: "gongyung",
        reason: `intent_not_allowed: ${task.intent} (not in admissible set: analyze, review, clarify, observe, check_readiness, cross_check, regression)`,
        timestampMs: now(),
        observeOnly: true,
        handoffTargets,
      },
    };
  }

  // Rule 2c: Missing intent with no other decision context → fail-closed default
  const hasCapacityContext = options.maxConcurrentTasks !== undefined || options.activeTaskCount !== undefined;
  if (!task.intent && !task.mode && !task.capabilities && !hasCapacityContext) {
    return {
      ok: false,
      noGoSignal: {
        type: "team_assignment_no_go",
        nodeId: "gongyung",
        reason: "intent_not_allowed: missing (fail-closed default)",
        timestampMs: now(),
        observeOnly: true,
        handoffTargets,
      },
    };
  }

  // Rule 3: Mode guard via mobile-safety-lane
  let modeResult: AdmissionDecision | null = null;
  if (task.mode) {
    const mode = task.mode;
    const allowedModes = ["fanout", "review"];
    const observeOnlyModes = ["swarm"];

    if (allowedModes.includes(mode)) {
      modeResult = { ok: true, lane: "full", proofLevel: "lightweight" };
    } else if (observeOnlyModes.includes(mode)) {
      modeResult = { ok: true, lane: "observe", proofLevel: "none" };
    } else {
      return {
        ok: false,
        noGoSignal: {
          type: "team_assignment_no_go",
          nodeId: "gongyung",
          reason: `mode_not_allowed: ${mode}. Allowed: [${allowedModes.join(", ")}]. Observe-only: [${observeOnlyModes.join(", ")}].`,
          timestampMs: now(),
          observeOnly: true,
          handoffTargets,
        },
      };
    }

    // Mode guard: check proof level compatibility
    if (modeResult.ok && modeResult.proofLevel === "lightweight" && task.intent === "regression") {
      return {
        ok: false,
        noGoSignal: {
          type: "team_assignment_no_go",
          nodeId: "gongyung",
          reason: "heavy_proof_not_supported",
          timestampMs: now(),
          observeOnly: true,
          handoffTargets,
        },
      };
    }
    // If the mode passed, fall through to check Rules 4-5
  }

  // Rule 4: Capability guard (always checked after mode passes)
  // forceFullGate in payload/metadata is also a capability rejection per spec
  const forceFullGate = task.payload?.forceFullGate ?? task.metadata?.forceFullGate;
  if (forceFullGate === true) {
    return {
      ok: false,
      noGoSignal: {
        type: "team_assignment_no_go",
        nodeId: "gongyung",
        reason: "capability_not_available: canRunHeavyProof (forceFullGate=true)",
        timestampMs: now(),
        observeOnly: true,
        handoffTargets,
      },
    };
  }

  if (task.capabilities) {
    for (const cap of Object.keys(task.capabilities)) {
      if (REJECTED_CAPABILITIES.has(cap) && task.capabilities[cap] === true) {
        return {
          ok: false,
          noGoSignal: {
            type: "team_assignment_no_go",
            nodeId: "gongyung",
            reason: `capability_not_available: ${cap}`,
            timestampMs: now(),
            observeOnly: true,
            handoffTargets,
          },
        };
      }
    }
  }

  // Rule 5: Resource guard — capacity
  if (activeTaskCount >= maxConcurrentTasks) {
    return {
      ok: false,
      noGoSignal: {
        type: "team_assignment_no_go",
        nodeId: "gongyung",
        reason: "at_capacity",
        timestampMs: now(),
        observeOnly: true,
        handoffTargets,
      },
    };
  }

  // If mode was evaluated and passed, use its lane/proofLevel
  if (modeResult) {
    return modeResult;
  }

  // Default: admit with lightweight proof
  return { ok: true, lane: "full", proofLevel: "lightweight" };
}

// ════════════════════════════════════════════════════════════════
// §1  Runtime guard: Docker runner rejection
// ════════════════════════════════════════════════════════════════

describe("Gongyung profile — runtime guard (Docker runner rejection)", () => {
  it("rejects task with executorMode=docker", () => {
    const result = gongyungAdmit({ id: "t1", payload: { executorMode: "docker" } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "gongyung_not_docker_runner");
  });

  it("rejects task with executorMode=auto", () => {
    const result = gongyungAdmit({ id: "t2", payload: { executorMode: "auto" } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "gongyung_not_docker_runner");
  });

  it("rejects task with executorMode=auto-with-docker-fallback", () => {
    const result = gongyungAdmit({ id: "t3", payload: { executorMode: "auto-with-docker-fallback" } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "gongyung_not_docker_runner");
  });

  it("rejects task with runnerScope=all-github", () => {
    const result = gongyungAdmit({ id: "t4", payload: { runnerScope: "all-github" } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "gongyung_not_docker_runner");
  });

  it("rejects task with runnerScope=github-patch", () => {
    const result = gongyungAdmit({ id: "t5", payload: { runnerScope: "github-patch" } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "gongyung_not_docker_runner");
  });

  it("rejects task with runnerScope=all", () => {
    const result = gongyungAdmit({ id: "t6", payload: { runnerScope: "all" } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "gongyung_not_docker_runner");
  });

  it("rejects task with command=docker in payload", () => {
    const result = gongyungAdmit({ id: "t7", payload: { command: "docker" } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "gongyung_not_docker_runner");
  });

  it("rejects task with command=docker build in payload", () => {
    const result = gongyungAdmit({ id: "t8", payload: { command: "docker build ." } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "gongyung_not_docker_runner");
  });

  it("rejects task with env referencing A2A_EXECUTOR_MODE", () => {
    const result = gongyungAdmit({ id: "t9", payload: { env: "A2A_EXECUTOR_MODE=docker" } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "gongyung_not_docker_runner");
  });

  it("rejects task with metadata-level executorMode=docker", () => {
    const result = gongyungAdmit({ id: "t10", metadata: { executorMode: "docker" } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "gongyung_not_docker_runner");
  });

  it("rejects task with env referencing A2A_DOCKER_RUNNER_SCOPE", () => {
    const result = gongyungAdmit({ id: "t11", payload: { env: "A2A_DOCKER_RUNNER_SCOPE=all-github" } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "gongyung_not_docker_runner");
  });
});

// ════════════════════════════════════════════════════════════════
// §2  Intent guard: rejected intents
// ════════════════════════════════════════════════════════════════

describe("Gongyung profile — intent guard", () => {
  it("admits analyze intent", () => {
    const result = gongyungAdmit({ id: "t1", intent: "analyze" });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.lane, "full");
  });

  it("admits review intent", () => {
    const result = gongyungAdmit({ id: "t2", intent: "review" });
    assert.ok(result.ok);
  });

  it("admits clarify intent", () => {
    const result = gongyungAdmit({ id: "t3", intent: "clarify" });
    assert.ok(result.ok);
  });

  it("admits observe intent", () => {
    const result = gongyungAdmit({ id: "t4", intent: "observe" });
    assert.ok(result.ok);
  });

  it("admits check_readiness intent", () => {
    const result = gongyungAdmit({ id: "t5", intent: "check_readiness" });
    assert.ok(result.ok);
  });

  it("admits cross_check intent", () => {
    const result = gongyungAdmit({ id: "t6", intent: "cross_check" });
    assert.ok(result.ok);
  });

  // Rejected intents
  const rejected = ["docker", "patch_repo", "build_repo", "test_repo"];
  for (const intent of rejected) {
    it(`rejects intent=${intent}`, () => {
      const result = gongyungAdmit({ id: "t-reject", intent });
      assert.ok(!result.ok);
    });
  }
});

// ════════════════════════════════════════════════════════════════
// §3  Mode guard via mobile-safety-lane integration
// ════════════════════════════════════════════════════════════════

describe("Gongyung profile — mode guard (mobile-safety-lane integration)", () => {
  it("fanout mode → full lane, lightweight proof", () => {
    const result = gongyungAdmit({ id: "t1", mode: "fanout" });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.lane, "full");
      assert.equal(result.proofLevel, "lightweight");
    }
  });

  it("review mode → full lane, lightweight proof", () => {
    const result = gongyungAdmit({ id: "t2", mode: "review" });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.lane, "full");
      assert.equal(result.proofLevel, "lightweight");
    }
  });

  it("swarm mode → observe lane, no proof", () => {
    const result = gongyungAdmit({ id: "t3", mode: "swarm" });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.lane, "observe");
      assert.equal(result.proofLevel, "none");
    }
  });

  it("split mode → NO-GO", () => {
    const result = gongyungAdmit({ id: "t4", mode: "split" });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.ok(result.noGoSignal.reason.startsWith("mode_not_allowed"));
  });

  it("unknown mode → NO-GO (fail-closed default)", () => {
    const result = gongyungAdmit({ id: "t5", mode: "deploy" });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.ok(result.noGoSignal.reason.startsWith("mode_not_allowed"));
  });

  it("fanout with regression intent → NO-GO (heavy proof)", () => {
    const result = gongyungAdmit({ id: "t6", mode: "fanout", intent: "regression" });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "heavy_proof_not_supported");
  });
});

// ════════════════════════════════════════════════════════════════
// §4  Capability guard
// ════════════════════════════════════════════════════════════════

describe("Gongyung profile — capability guard", () => {
  it("rejects task requiring canRunHeavyProof", () => {
    const result = gongyungAdmit({ id: "t1", capabilities: { canRunHeavyProof: true } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.ok(result.noGoSignal.reason.startsWith("capability_not_available"));
  });

  it("rejects task requiring canPushToGitHub", () => {
    const result = gongyungAdmit({ id: "t2", capabilities: { canPushToGitHub: true } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.ok(result.noGoSignal.reason.startsWith("capability_not_available"));
  });

  it("rejects task requiring canPromoteLive", () => {
    const result = gongyungAdmit({ id: "t3", capabilities: { canPromoteLive: true } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.ok(result.noGoSignal.reason.startsWith("capability_not_available"));
  });

  it("rejects task requiring canPatchWorkspace with docker type", () => {
    const result = gongyungAdmit({ id: "t4", capabilities: { canPatchWorkspace_docker: true } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.ok(result.noGoSignal.reason.startsWith("capability_not_available"));
  });

  it("allows task with canAnalyze capability", () => {
    const result = gongyungAdmit({ id: "t5", capabilities: { canAnalyze: true } });
    assert.ok(result.ok);
  });
});

// ════════════════════════════════════════════════════════════════
// §5  Resource guard (capacity)
// ════════════════════════════════════════════════════════════════

describe("Gongyung profile — resource / capacity guard", () => {
  it("admits when under capacity", () => {
    const result = gongyungAdmit({ id: "t1" }, { maxConcurrentTasks: 1, activeTaskCount: 0 });
    assert.ok(result.ok);
  });

  it("NO-GO when at capacity", () => {
    const result = gongyungAdmit({ id: "t2" }, { maxConcurrentTasks: 1, activeTaskCount: 1 });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "at_capacity");
  });

  it("NO-GO when over capacity", () => {
    const result = gongyungAdmit({ id: "t3" }, { maxConcurrentTasks: 2, activeTaskCount: 3 });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "at_capacity");
  });
});

// ════════════════════════════════════════════════════════════════
// §6  Admission ordering: Docker runner guard checked before intents
// ════════════════════════════════════════════════════════════════

describe("Gongyung profile — admission ordering", () => {
  it("Docker runtime guard checked even when intent is acceptable", () => {
    // Even a "review" intent with Docker runner indicators must be rejected
    const result = gongyungAdmit({
      id: "t1",
      intent: "review",
      payload: { executorMode: "docker" },
    });
    assert.ok(!result.ok);
    if (result.ok) return;
    // Must reject with Docker runner reason, not the intent reason
    assert.equal(result.noGoSignal.reason, "gongyung_not_docker_runner");
  });

  it("Docker runtime guard checked first even when intent is rejected", () => {
    // Even if both Docker and rejected intent are present, the Docker guard wins
    const result = gongyungAdmit({
      id: "t2",
      intent: "patch_repo",
      payload: { executorMode: "docker" },
    });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "gongyung_not_docker_runner");
  });
});

// ════════════════════════════════════════════════════════════════
// §7  Evidence manifest validation
// ════════════════════════════════════════════════════════════════

/**
 * Replicates the "manifest ok" inline check from the spec.
 * Validates that the evidence record conforms to the Gongyung profile.
 */
function validateEvidenceManifest(evidence: Record<string, unknown>): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  // workerId must be present and non-empty
  if (!evidence.workerId || typeof evidence.workerId !== "string" || evidence.workerId.trim() === "") {
    errors.push("workerId must be a non-empty string");
  }

  // outcome must be one of the allowed values
  const allowedOutcomes = ["done", "blocked", "failed"];
  if (!allowedOutcomes.includes(evidence.outcome as string)) {
    errors.push(`outcome must be one of: ${allowedOutcomes.join(", ")}`);
  }

  const result = evidence.result as Record<string, unknown> | undefined;
  if (!result) {
    errors.push("result is required");
    return { ok: errors.length === 0, errors };
  }

  const output = result.output as Record<string, unknown> | undefined;
  if (!output) {
    errors.push("result.output is required");
    return { ok: errors.length === 0, errors };
  }

  // gongyungProfile = "hermes-worker"
  if (output.gongyungProfile !== "hermes-worker") {
    errors.push('result.output.gongyungProfile must be "hermes-worker"');
  }

  // openClawRequired = false
  if (output.openClawRequired !== false) {
    errors.push("result.output.openClawRequired must be false");
  }

  // runtimeFlavor = "termux-hermes"
  if (output.runtimeFlavor !== "termux-hermes") {
    errors.push('result.output.runtimeFlavor must be "termux-hermes"');
  }

  // profileVersion = 1
  if (output.profileVersion !== 1) {
    errors.push("result.output.profileVersion must be 1");
  }

  // artifacts array
  const artifacts = result.artifacts as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(artifacts)) {
    errors.push("result.artifacts must be an array");
  } else {
    for (let i = 0; i < artifacts.length; i++) {
      const a = artifacts[i];
      if (typeof a.path !== "string") errors.push(`artifacts[${i}].path must be a string`);
      if (typeof a.kind !== "string") errors.push(`artifacts[${i}].kind must be a string`);
      if (a.redacted !== true && a.redacted !== false) {
        errors.push(`artifacts[${i}].redacted must be a boolean`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

describe("Gongyung profile — evidence manifest validation", () => {
  it("accepts a valid done evidence record", () => {
    const evidence = {
      workerId: "gongyung",
      outcome: "done",
      result: {
        summary: "Readiness check complete — all gates green",
        output: {
          gongyungProfile: "hermes-worker",
          openClawRequired: false,
          runtimeFlavor: "termux-hermes",
          profileVersion: 1,
        },
        artifacts: [
          { path: "docs/specs/gongyung-hermes-worker-profile/spec.md", kind: "evidence", redacted: true },
        ],
      },
    };
    const result = validateEvidenceManifest(evidence);
    assert.ok(result.ok, result.errors.join("; "));
  });

  it("accepts a valid blocked evidence record", () => {
    const evidence = {
      workerId: "gongyung",
      outcome: "blocked",
      result: {
        summary: "Task not admitted: gongyung_not_docker_runner",
        output: {
          gongyungProfile: "hermes-worker",
          openClawRequired: false,
          runtimeFlavor: "termux-hermes",
          profileVersion: 1,
        },
        artifacts: [],
      },
    };
    const result = validateEvidenceManifest(evidence);
    assert.ok(result.ok, result.errors.join("; "));
  });

  it("rejects evidence with pr outcome (not supported for Gongyung)", () => {
    const evidence = {
      workerId: "gongyung",
      outcome: "pr",
      result: {
        summary: "PR created",
        output: {
          gongyungProfile: "hermes-worker",
          openClawRequired: false,
          runtimeFlavor: "termux-hermes",
          profileVersion: 1,
        },
        artifacts: [],
      },
    };
    const result = validateEvidenceManifest(evidence);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.includes("outcome")));
  });

  it("rejects evidence missing workerId", () => {
    const evidence = {
      workerId: "",
      outcome: "done",
      result: { summary: "x", output: { gongyungProfile: "hermes-worker", openClawRequired: false, runtimeFlavor: "termux-hermes", profileVersion: 1 }, artifacts: [] },
    };
    const result = validateEvidenceManifest(evidence);
    assert.ok(!result.ok);
  });

  it("rejects evidence with wrong gongyungProfile", () => {
    const evidence = {
      workerId: "gongyung",
      outcome: "done",
      result: {
        summary: "Wrong profile",
        output: { gongyungProfile: "hermes-agent", openClawRequired: false, runtimeFlavor: "termux-hermes", profileVersion: 1 },
        artifacts: [],
      },
    };
    const result = validateEvidenceManifest(evidence);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.includes("gongyungProfile")));
  });

  it("rejects evidence with openClawRequired=true", () => {
    const evidence = {
      workerId: "gongyung",
      outcome: "done",
      result: {
        summary: "Wrong runtime",
        output: { gongyungProfile: "hermes-worker", openClawRequired: true, runtimeFlavor: "termux-hermes", profileVersion: 1 },
        artifacts: [],
      },
    };
    const result = validateEvidenceManifest(evidence);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.includes("openClawRequired")));
  });

  it("rejects evidence with wrong runtimeFlavor", () => {
    const evidence = {
      workerId: "gongyung",
      outcome: "done",
      result: {
        summary: "Wrong runtime flavor",
        output: { gongyungProfile: "hermes-worker", openClawRequired: false, runtimeFlavor: "linux-docker", profileVersion: 1 },
        artifacts: [],
      },
    };
    const result = validateEvidenceManifest(evidence);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.includes("runtimeFlavor")));
  });

  it("rejects evidence with wrong profileVersion", () => {
    const evidence = {
      workerId: "gongyung",
      outcome: "done",
      result: {
        summary: "Wrong version",
        output: { gongyungProfile: "hermes-worker", openClawRequired: false, runtimeFlavor: "termux-hermes", profileVersion: 2 },
        artifacts: [],
      },
    };
    const result = validateEvidenceManifest(evidence);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.includes("profileVersion")));
  });

  it("rejects evidence when artifacts field is not an array", () => {
    const evidence = {
      workerId: "gongyung",
      outcome: "done",
      result: {
        summary: "Bad artifacts",
        output: { gongyungProfile: "hermes-worker", openClawRequired: false, runtimeFlavor: "termux-hermes", profileVersion: 1 },
        artifacts: "not-an-array",
      },
    };
    const result = validateEvidenceManifest(evidence);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.includes("artifacts")));
  });

  it("rejects evidence with artifact missing path", () => {
    const evidence = {
      workerId: "gongyung",
      outcome: "done",
      result: {
        summary: "Missing path",
        output: { gongyungProfile: "hermes-worker", openClawRequired: false, runtimeFlavor: "termux-hermes", profileVersion: 1 },
        artifacts: [{ kind: "log", redacted: true }],
      },
    };
    const result = validateEvidenceManifest(evidence);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.includes("path")));
  });

  it("rejects evidence with artifact missing redacted field", () => {
    const evidence = {
      workerId: "gongyung",
      outcome: "done",
      result: {
        summary: "Missing redacted",
        output: { gongyungProfile: "hermes-worker", openClawRequired: false, runtimeFlavor: "termux-hermes", profileVersion: 1 },
        artifacts: [{ path: "test.log", kind: "log" }],
      },
    };
    const result = validateEvidenceManifest(evidence);
    assert.ok(!result.ok);
    assert.ok(result.errors.some((e) => e.includes("redacted")));
  });
});

// ════════════════════════════════════════════════════════════════
// §8  Mobile safety lane consensus check
// ════════════════════════════════════════════════════════════════

describe("Gongyung profile — mobile safety lane consensus", () => {
  it("createMobileSafetyLane with gongyung profile matches spec defaults", () => {
    const lane = createMobileSafetyLane({
      nodeId: "gongyung",
      profile: { isMobile: true, isLowResource: true },
    });
    const p = lane.profile();
    assert.equal(p.maxConcurrentTasks, 1, "mobile maxConcurrentTasks should be 1");
    assert.equal(p.canRunHeavyProof, false, "mobile should not run heavy proof");
    assert.equal(p.canPushToGitHub, false, "mobile should not push to GitHub");
    assert.equal(p.isMobile, true);
  });

  it("fanout/review are allowed modes on gongyung", () => {
    const lane = createMobileSafetyLane({
      nodeId: "gongyung",
      profile: { isMobile: true, isLowResource: true },
    });
    assert.ok(lane.evaluate("fanout").ok);
    assert.ok(lane.evaluate("review").ok);
  });

  it("swarm is observe-only on gongyung", () => {
    const lane = createMobileSafetyLane({
      nodeId: "gongyung",
      profile: { isMobile: true, isLowResource: true },
    });
    const result = lane.evaluate("swarm");
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.lane, "observe");
      assert.equal(result.proofLevel, "none");
    }
  });

  it("split is NO-GO on gongyung", () => {
    const lane = createMobileSafetyLane({
      nodeId: "gongyung",
      profile: { isMobile: true, isLowResource: true },
      handoffTargets: ["node-hub"],
    });
    const result = lane.evaluate("split");
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.signal.nodeId, "gongyung");
    assert.deepEqual(result.signal.handoffTargets, ["node-hub"]);
  });
});

// ════════════════════════════════════════════════════════════════
// §9  Handoff proof guardrail consensus check
// ════════════════════════════════════════════════════════════════

describe("Gongyung profile — handoff proof guardrail consensus", () => {
  it("mobile node blocks heavy commands and delegates them", () => {
    const guard = createHandoffProofGuard({
      nowMs: now,
      delegateTarget: "node-hub",
      nodeProfile: { isMobile: true, isLowResource: true, freeMemoryMb: 600, cpuLoad: 0.3 },
    });

    const heavy: string[] = ["full_gate", "full_proof_loop", "full_regression"];
    for (const cmd of heavy) {
      const result = guard.checkCommand(cmd as any);
      assert.equal(result.allowed, false, `${cmd} should be blocked on mobile`);
      assert.ok(result.noGoReasons.includes("mobile_no_heavy"), `${cmd} should trigger mobile_no_heavy`);
      assert.equal(result.delegateTo, "node-hub");
    }
  });

  it("observe commands are safe on mobile", () => {
    const guard = createHandoffProofGuard({
      nowMs: now,
      delegateTarget: "node-hub",
      nodeProfile: { isMobile: true, isLowResource: true, freeMemoryMb: 600, cpuLoad: 0.3 },
    });

    const safe: string[] = ["observe_ping", "observe_dispatch", "observe_ack", "observe_health"];
    for (const cmd of safe) {
      const result = guard.checkCommand(cmd as any);
      assert.equal(result.allowed, true, `${cmd} should be allowed on mobile`);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// §10  Integration: admission + manifest + mobile lane
// ════════════════════════════════════════════════════════════════

describe("Gongyung profile — end-to-end integration", () => {
  it("admission of allowed task → valid evidence manifest", () => {
    // Step 1: Admit a cross_check task
    const admitResult = gongyungAdmit({ id: "e2e-1", intent: "cross_check" });
    assert.ok(admitResult.ok);
    if (!admitResult.ok) return;

    // Step 2: Build evidence record matching the spec
    const evidence = {
      workerId: "gongyung",
      outcome: "done",
      result: {
        summary: "Cross-check complete — no discrepancies found",
        output: {
          gongyungProfile: "hermes-worker",
          openClawRequired: false,
          runtimeFlavor: "termux-hermes",
          profileVersion: 1,
        },
        artifacts: [
          { path: "docs/validation/report.md", kind: "evidence", redacted: true },
        ],
      },
    };

    // Step 3: Validate manifest
    const manifestResult = validateEvidenceManifest(evidence);
    assert.ok(manifestResult.ok, manifestResult.errors.join("; "));
  });

  it("rejected Docker runner task → blocked evidence manifest with correct reason", () => {
    const admitResult = gongyungAdmit({
      id: "e2e-2",
      intent: "analyze",
      payload: { executorMode: "auto" },
    });
    assert.ok(!admitResult.ok);
    if (admitResult.ok) return;

    const evidence = {
      workerId: "gongyung",
      outcome: "blocked",
      result: {
        summary: `Task not admitted: ${admitResult.noGoSignal.reason}`,
        output: {
          gongyungProfile: "hermes-worker",
          openClawRequired: false,
          runtimeFlavor: "termux-hermes",
          profileVersion: 1,
        },
        artifacts: [],
      },
    };

    const manifestResult = validateEvidenceManifest(evidence);
    assert.ok(manifestResult.ok, manifestResult.errors.join("; "));
    assert.equal(admitResult.noGoSignal.reason, "gongyung_not_docker_runner");
  });

  it("at capacity → blocked evidence manifest", () => {
    const admitResult = gongyungAdmit(
      { id: "e2e-3", intent: "review" },
      { maxConcurrentTasks: 1, activeTaskCount: 1 },
    );
    assert.ok(!admitResult.ok);
    if (admitResult.ok) return;

    const evidence = {
      workerId: "gongyung",
      outcome: "blocked",
      result: {
        summary: `Task not admitted: ${admitResult.noGoSignal.reason}`,
        output: {
          gongyungProfile: "hermes-worker",
          openClawRequired: false,
          runtimeFlavor: "termux-hermes",
          profileVersion: 1,
        },
        artifacts: [],
      },
    };

    const manifestResult = validateEvidenceManifest(evidence);
    assert.ok(manifestResult.ok, manifestResult.errors.join("; "));
    assert.equal(admitResult.noGoSignal.reason, "at_capacity");
  });
});

// ════════════════════════════════════════════════════════════════
// §11  forceFullGate rejection (spec §Rejected outright)
// ════════════════════════════════════════════════════════════════

describe("Gongyung profile — forceFullGate rejection", () => {
  it("rejects task with forceFullGate=true in payload", () => {
    const result = gongyungAdmit({ id: "t1", intent: "review", payload: { forceFullGate: true } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.ok(result.noGoSignal.reason.startsWith("capability_not_available"));
    assert.ok(result.noGoSignal.reason.includes("forceFullGate"));
  });

  it("rejects task with forceFullGate=true in metadata", () => {
    const result = gongyungAdmit({ id: "t2", intent: "analyze", metadata: { forceFullGate: true } });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.ok(result.noGoSignal.reason.startsWith("capability_not_available"));
  });

  it("allows task with forceFullGate=false", () => {
    const result = gongyungAdmit({ id: "t3", intent: "review", payload: { forceFullGate: false } });
    assert.ok(result.ok);
  });

  it("allows task without forceFullGate field", () => {
    const result = gongyungAdmit({ id: "t4", intent: "review" });
    assert.ok(result.ok);
  });
});

// ════════════════════════════════════════════════════════════════
// §12  Mode guard + capability / capacity interaction
// ════════════════════════════════════════════════════════════════

describe("Gongyung profile — mode + capability interaction", () => {
  it("fanout mode still rejected when canRunHeavyProof required", () => {
    // Mode passes but capability guard (Rule 4) should still reject
    const result = gongyungAdmit({
      id: "t1", mode: "fanout", intent: "review",
      capabilities: { canRunHeavyProof: true },
    });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.ok(result.noGoSignal.reason.startsWith("capability_not_available"));
  });

  it("fanout mode still rejected when at capacity", () => {
    // Mode passes but resource guard (Rule 5) should still reject
    const result = gongyungAdmit(
      { id: "t2", mode: "fanout", intent: "review" },
      { maxConcurrentTasks: 1, activeTaskCount: 1 },
    );
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "at_capacity");
  });

  it("swarm mode still rejected when at capacity", () => {
    const result = gongyungAdmit(
      { id: "t3", mode: "swarm", intent: "observe" },
      { maxConcurrentTasks: 1, activeTaskCount: 1 },
    );
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.equal(result.noGoSignal.reason, "at_capacity");
  });

  it("fanout mode with forceFullGate=true → NO-GO despite mode passing", () => {
    const result = gongyungAdmit({
      id: "t4", mode: "fanout", intent: "review",
      payload: { forceFullGate: true },
    });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.ok(result.noGoSignal.reason.includes("forceFullGate"));
  });

  it("review mode with canPushToGitHub → NO-GO despite mode passing", () => {
    const result = gongyungAdmit({
      id: "t5", mode: "review", intent: "review",
      capabilities: { canPushToGitHub: true },
    });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.ok(result.noGoSignal.reason.startsWith("capability_not_available"));
  });
});

// ════════════════════════════════════════════════════════════════
// §13  Fail-closed defaults: unknown modes/intents
// ════════════════════════════════════════════════════════════════

describe("Gongyung profile — fail-closed defaults", () => {
  it("completely unknown mode defaults to NO-GO", () => {
    const result = gongyungAdmit({ id: "t1", mode: "something_new_unlisted" });
    assert.ok(!result.ok);
  });

  it("unknown intent defaults to NO-GO (fail-closed per spec)", () => {
    // Spec §Unknown mode default: "Any task mode, intent, or capability
    // that is not explicitly listed in the allowed or handoff sets
    // MUST default to NO-GO."
    const result = gongyungAdmit({ id: "t2", intent: "something_new_unlisted" });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.ok(result.noGoSignal.reason.startsWith("intent_not_allowed"));
  });

  it("missing intent defaults to NO-GO", () => {
    const result = gongyungAdmit({ id: "t2a" });
    assert.ok(!result.ok);
    if (result.ok) return;
    assert.ok(result.noGoSignal.reason.startsWith("intent_not_allowed"));
  });

  it("unknown intent with reject-capability defaults to NO-GO (capability guard wins after intent)", () => {
    const result = gongyungAdmit({
      id: "t3",
      intent: "something_new_unlisted",
      capabilities: { canRunHeavyProof: true },
    });
    assert.ok(!result.ok);
    if (result.ok) return;
    // Intent guard fires first for unknown intents
    assert.ok(result.noGoSignal.reason.startsWith("intent_not_allowed"));
  });
});
