/**
 * Worker capacity hint tests (R31, plugin-a2a#347).
 *
 * Parent: jinwon-int/a2a-plane#380
 * Run: a2a-r31-worker-capability-profiles-20260516T1825Z
 *
 * Validates that:
 * 1. extractWorkerCapacityHint reads broker workerCapability payload fields.
 * 2. extractWorkerCapacityHintFromTask checks both payload and taskInput.
 * 3. Formatting produces safe, human-readable strings.
 * 4. Sanitization strips raw host data / secrets.
 * 5. Empty/missing fields return undefined.
 *
 * Hermes/Android native workers (R33, plugin-a2a#452):
 * 6. Runtime flavor extraction: termux-hermes, gateway, and unknown.
 * 7. gatewayRequired extraction: boolean and string-boolean.
 * 8. Formatting with flavor prefix and gateway-optional suffix.
 * 9. Backward compatibility: gateway workers without flavor fields.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractWorkerCapacityHint,
  extractWorkerCapacityHintFromTask,
  formatWorkerCapacityHint,
  buildCapacityHintEvidenceLine,
} from "../dist/src/worker-capacity-hints.js";
import type {
  WorkerCapacityHint,
  WorkerCapacityStatus,
  WorkerRuntimeFlavor,
} from "../dist/src/worker-capacity-hints.js";

// ── Tests ──────────────────────────────────────────────────────────

describe("extractWorkerCapacityHint", () => {
  it("returns undefined for empty source", () => {
    assert.equal(extractWorkerCapacityHint(undefined), undefined);
    assert.equal(extractWorkerCapacityHint({}), undefined);
  });

  it("reads workerCapability with healthy status", () => {
    const result = extractWorkerCapacityHint({
      workerCapability: {
        status: "healthy",
        lastSeenAt: Date.now() - 30_000,
        loadLevel: "low",
      },
    });
    assert.ok(result, "should return a hint");
    assert.equal(result!.status, "healthy");
    assert.ok(typeof result!.lastSeenAt === "number");
  });

  it("reads workerCapability with stale status", () => {
    const past = Date.now() - 5 * 60 * 1000;
    const result = extractWorkerCapacityHint({
      workerCapability: {
        status: "stale",
        lastSeenAt: past,
      },
    });
    assert.ok(result);
    assert.equal(result!.status, "stale");
    assert.equal(result!.lastSeenAt, past);
  });

  it("reads workerCapability with capacity_limited status", () => {
    const result = extractWorkerCapacityHint({
      workerCapability: {
        status: "capacity_limited",
        loadLevel: "high",
        taskCapacity: 3,
        activeTasks: 3,
      },
    });
    assert.ok(result);
    assert.equal(result!.status, "capacity_limited");
    assert.ok(result!.note?.includes("high"), "note should mention load level");
  });

  it("maps status aliases correctly", () => {
    // 'live' should map to healthy
    const live = extractWorkerCapacityHint({ workerCapability: { status: "live" } });
    assert.equal(live?.status, "healthy");

    // 'offline' should map to stale
    const offline = extractWorkerCapacityHint({ workerCapability: { status: "offline" } });
    assert.equal(offline?.status, "stale");

    // 'overloaded' should map to capacity_limited
    const overloaded = extractWorkerCapacityHint({ workerCapability: { status: "overloaded" } });
    assert.equal(overloaded?.status, "capacity_limited");

    // unknown status maps to unknown
    const unknown = extractWorkerCapacityHint({ workerCapability: { status: "weird_value" } });
    assert.equal(unknown?.status, "unknown");

    const explicitUnknown = extractWorkerCapacityHint({ workerCapability: { status: "unknown" } });
    assert.equal(explicitUnknown?.status, "unknown");
  });

  it("reads workerCapacity key as fallback", () => {
    const result = extractWorkerCapacityHint({
      workerCapacity: {
        status: "healthy",
        lastSeenAt: Date.now() - 10_000,
      },
    });
    assert.ok(result);
    assert.equal(result!.status, "healthy");
  });

  it("reads workerCapabilities key as additional fallback", () => {
    const result = extractWorkerCapacityHint({
      workerCapabilities: {
        status: "healthy",
      },
    });
    assert.ok(result);
    assert.equal(result!.status, "healthy");
  });

  it("sanitizes loadLevel into safe note", () => {
    const low = extractWorkerCapacityHint({
      workerCapability: { status: "healthy", loadLevel: "low" },
    });
    assert.equal(low?.note, "load: low");

    const high = extractWorkerCapacityHint({
      workerCapability: { status: "capacity_limited", loadLevel: "high" },
    });
    assert.equal(high?.note, "load: high");
  });

  it("sanitizes task counts into safe note", () => {
    const result = extractWorkerCapacityHint({
      workerCapability: { status: "capacity_limited", taskCapacity: 5, activeTasks: 4 },
    });
    assert.equal(result?.note, "tasks: 4/5");
  });

  it("prefers loadLevel note over task count note", () => {
    const result = extractWorkerCapacityHint({
      workerCapability: {
        status: "capacity_limited",
        loadLevel: "high",
        taskCapacity: 5,
        activeTasks: 4,
      },
    });
    // loadLevel should take precedence
    assert.equal(result?.note, "load: high");
  });

  it("ignores non-object workerCapability", () => {
    assert.equal(extractWorkerCapacityHint({ workerCapability: "not_an_object" }), undefined);
    assert.equal(extractWorkerCapacityHint({ workerCapability: null }), undefined);
    assert.equal(extractWorkerCapacityHint({ workerCapability: 42 }), undefined);
  });

  it("returns undefined when no valid field exists", () => {
    assert.equal(
      extractWorkerCapacityHint({ unrelatedField: { status: "healthy" } }),
      undefined,
    );
  });

  it("reads flat workerStatus when no capability object", () => {
    const result = extractWorkerCapacityHint({
      workerStatus: "stale",
      workerLastSeenAt: Date.now() - 300_000,
    });
    assert.ok(result);
    assert.equal(result!.status, "stale");
    assert.ok(typeof result!.lastSeenAt === "number");
  });
});

describe("extractWorkerCapacityHintFromTask", () => {
  it("checks payload first", () => {
    const result = extractWorkerCapacityHintFromTask(
      { workerCapability: { status: "healthy" } },
      { workerCapability: { status: "capacity_limited" } },
    );
    assert.equal(result?.status, "healthy", "should prefer payload");
  });

  it("falls back to taskInput when payload empty", () => {
    const result = extractWorkerCapacityHintFromTask(
      {},
      { workerCapability: { status: "stale" } },
    );
    assert.equal(result?.status, "stale");
  });

  it("returns undefined when nothing found", () => {
    assert.equal(extractWorkerCapacityHintFromTask(undefined, undefined), undefined);
    assert.equal(extractWorkerCapacityHintFromTask({}, {}), undefined);
  });
});

describe("formatWorkerCapacityHint", () => {
  it("returns undefined for no hint", () => {
    assert.equal(formatWorkerCapacityHint(undefined), undefined);
  });

  it("formats healthy hint", () => {
    assert.equal(formatWorkerCapacityHint({ status: "healthy" }), "worker profile: healthy");
  });

  it("formats stale hint without lastSeen", () => {
    assert.equal(formatWorkerCapacityHint({ status: "stale" }), "worker profile: stale — never seen");
  });

  it("formats stale hint with lastSeen", () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const text = formatWorkerCapacityHint({ status: "stale", lastSeenAt: fiveMinAgo });
    assert.ok(text?.startsWith("worker profile: stale — last seen "));
    assert.ok(text?.endsWith(" ago"), "should end with relative time");
  });

  it("formats capacity_limited hint with note", () => {
    const text = formatWorkerCapacityHint({
      status: "capacity_limited",
      note: "load: high",
    });
    assert.equal(text, "worker profile: capacity limited — load: high");
  });

  it("formats capacity_limited hint without note", () => {
    const text = formatWorkerCapacityHint({ status: "capacity_limited" });
    assert.equal(text, "worker profile: capacity limited");
  });

  it("drops unsafe arbitrary notes while formatting", () => {
    const text = formatWorkerCapacityHint({
      status: "capacity_limited",
      note: "token at /root/private should not display",
    });
    assert.equal(text, "worker profile: capacity limited");
  });

  it("formats unknown hint", () => {
    assert.equal(formatWorkerCapacityHint({ status: "unknown" }), "worker profile: unknown");
  });
});

describe("buildCapacityHintEvidenceLine", () => {
  it("returns undefined for no hint", () => {
    assert.equal(buildCapacityHintEvidenceLine(undefined), undefined);
  });

  it("returns same as formatWorkerCapacityHint", () => {
    const hint: WorkerCapacityHint = { status: "healthy" };
    assert.equal(
      buildCapacityHintEvidenceLine(hint),
      formatWorkerCapacityHint(hint),
    );
  });
});

// ── Hermes/Android native worker metadata (R33, plugin-a2a#452) ──

describe("Hermes worker runtime flavor extraction", () => {
  it("extracts runtimeFlavor=termux-hermes from workerCapability", () => {
    const result = extractWorkerCapacityHint({
      workerCapability: {
        status: "healthy",
        runtimeFlavor: "termux-hermes",
        gatewayRequired: false,
      },
    });
    assert.ok(result);
    assert.equal(result!.runtimeFlavor, "termux-hermes");
    assert.equal(result!.gatewayRequired, false);
  });

  it("extracts runtimeFlavor=termux-hermes from workerCapacity fallback", () => {
    const result = extractWorkerCapacityHint({
      workerCapacity: {
        status: "stale",
        runtimeFlavor: "termux-hermes",
      },
    });
    assert.ok(result);
    assert.equal(result!.runtimeFlavor, "termux-hermes");
  });

  it("extracts runtimeFlavor=termux-hermes from workerCapabilities fallback", () => {
    const result = extractWorkerCapacityHint({
      workerCapabilities: {
        status: "capacity_limited",
        runtimeFlavor: "termux-hermes",
      },
    });
    assert.ok(result);
    assert.equal(result!.runtimeFlavor, "termux-hermes");
  });

  it("classifies gateway runtime flavor but omits it from output (backward compat)", () => {
    // Gateway workers with explicit flavor=gateway are normalized but not
    // surfaced as a flavor tag, same as workers with no runtimeFlavor at all.
    const result = extractWorkerCapacityHint({
      workerCapability: {
        status: "healthy",
        runtimeFlavor: "gateway",
      },
    });
    assert.ok(result);
    // Backward compat: we actually SHOW it as "gateway" since it was explicitly set
    assert.equal(result!.runtimeFlavor, "gateway");
  });

  it("classifies unknown runtime flavor", () => {
    const result = extractWorkerCapacityHint({
      workerCapability: {
        status: "healthy",
        runtimeFlavor: "custom-flavor",
      },
    });
    assert.ok(result);
    assert.equal(result!.runtimeFlavor, "unknown");
  });

  it("omits runtimeFlavor when absent (gateway worker default)", () => {
    const result = extractWorkerCapacityHint({
      workerCapability: {
        status: "healthy",
      },
    });
    assert.ok(result);
    assert.equal(result!.runtimeFlavor, undefined);
  });

  it("extracts gatewayRequired as boolean", () => {
    const result = extractWorkerCapacityHint({
      workerCapability: {
        status: "healthy",
        runtimeFlavor: "termux-hermes",
        gatewayRequired: false,
      },
    });
    assert.ok(result);
    assert.equal(result!.gatewayRequired, false);
  });

  it("extracts gatewayRequired from string-boolean values", () => {
    const result = extractWorkerCapacityHint({
      workerCapability: {
        status: "healthy",
        runtimeFlavor: "termux-hermes",
        gatewayRequired: "false",
      },
    });
    assert.ok(result);
    assert.equal(result!.gatewayRequired, false);
  });

  it("extracts gatewayRequired=true from string", () => {
    const result = extractWorkerCapacityHint({
      workerCapability: {
        status: "healthy",
        gatewayRequired: "true",
      },
    });
    assert.ok(result);
    assert.equal(result!.gatewayRequired, true);
  });

  it("omits gatewayRequired when absent (gateway worker default)", () => {
    const result = extractWorkerCapacityHint({
      workerCapability: { status: "healthy" },
    });
    assert.ok(result);
    assert.equal(result!.gatewayRequired, undefined);
  });

  it("does not carry Hermes metadata through flat workerStatus fallback", () => {
    // The flat workerStatus path is a legacy fallback and does not
    // read runtimeFlavor or gatewayRequired fields.
    const result = extractWorkerCapacityHint({
      workerStatus: "live",
      workerLastSeenAt: Date.now() - 60_000,
      runtimeFlavor: "termux-hermes",
      gatewayRequired: false,
    });
    assert.ok(result);
    assert.equal(result!.runtimeFlavor, undefined);
    assert.equal(result!.gatewayRequired, undefined);
  });

  it("extracts Hermes metadata from taskInput fallback when payload is empty", () => {
    const result = extractWorkerCapacityHintFromTask(
      {},
      { workerCapability: { status: "healthy", runtimeFlavor: "termux-hermes" } },
    );
    assert.ok(result);
    assert.equal(result!.runtimeFlavor, "termux-hermes");
  });
});

describe("Hermes worker capacity hint formatting", () => {
  it("formats healthy termux-hermes worker with gateway-optional suffix", () => {
    const text = formatWorkerCapacityHint({
      status: "healthy",
      runtimeFlavor: "termux-hermes",
      gatewayRequired: false,
    });
    assert.equal(text, "termux-hermes worker profile: healthy (gateway-optional)");
  });

  it("formats stale termux-hermes worker", () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const text = formatWorkerCapacityHint({
      status: "stale",
      lastSeenAt: fiveMinAgo,
      runtimeFlavor: "termux-hermes",
      gatewayRequired: false,
    });
    assert.ok(text?.startsWith("termux-hermes worker profile: stale — last seen "));
    assert.ok(text?.endsWith(" ago (gateway-optional)"));
  });

  it("formats capacity_limited termux-hermes worker", () => {
    const text = formatWorkerCapacityHint({
      status: "capacity_limited",
      note: "load: high",
      runtimeFlavor: "termux-hermes",
    });
    assert.equal(
      text,
      "termux-hermes worker profile: capacity limited — load: high",
    );
  });

  it("formats unknown flavor worker", () => {
    const text = formatWorkerCapacityHint({
      status: "healthy",
      runtimeFlavor: "unknown",
    });
    assert.equal(
      text,
      "unknown worker profile: healthy",
    );
  });

  it("does not prefix gateway runtime flavor (backward compat)", () => {
    // Workers classified as 'gateway' flavor do NOT get a flavor prefix
    // since that's the default assumption for all existing workers.
    const text = formatWorkerCapacityHint({
      status: "healthy",
      runtimeFlavor: "gateway",
    });
    assert.equal(text, "worker profile: healthy");
  });

  it("does not add flavor prefix when runtimeFlavor is undefined (existing workers)", () => {
    const text = formatWorkerCapacityHint({ status: "healthy" });
    assert.equal(text, "worker profile: healthy");
  });

  it("does not add gateway-optional suffix when gatewayRequired is undefined or true", () => {
    const text = formatWorkerCapacityHint({ status: "healthy", gatewayRequired: true });
    assert.equal(text, "worker profile: healthy");

    const text2 = formatWorkerCapacityHint({ status: "healthy" });
    assert.equal(text2, "worker profile: healthy");
  });

  it("Hermes evidence line equals formatted output", () => {
    const hint: WorkerCapacityHint = {
      status: "healthy",
      runtimeFlavor: "termux-hermes",
      gatewayRequired: false,
    };
    assert.equal(
      buildCapacityHintEvidenceLine(hint),
      formatWorkerCapacityHint(hint),
    );
  });
});
