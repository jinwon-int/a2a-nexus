/**
 * Worker capacity projection tests (#1597).
 *
 * The projection is what an operator reads when choosing a worker. The matrix
 * in #1597 was maintained by hand instead, went stale, and misrouted work
 * twice — its own issue body records that. These tests pin the routing-relevant
 * fields to the projection so the answer comes from the broker, not from a
 * table someone has to remember to update.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildWorkerCapacitySummary } from "./broker-worker-capacity.js";
import type { WorkerRecord } from "./types.js";

const NOW = Date.parse("2026-08-10T00:00:00.000Z");

function worker(nodeId: string, overrides: Partial<WorkerRecord["capabilities"]> = {}): WorkerRecord {
  return {
    nodeId,
    role: "analyst",
    displayName: nodeId,
    lastSeenAt: new Date(NOW - 1_000).toISOString(),
    createdAt: new Date(NOW - 60_000).toISOString(),
    updatedAt: new Date(NOW - 1_000).toISOString(),
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["test"],
      environments: ["research"],
      ...overrides,
    },
  };
}

test("#1597: capacity projects the implementation capability the claim gate enforces", () => {
  const summary = buildWorkerCapacitySummary(
    {
      workers: [
        worker("patcher", {
          canPatchWorkspace: true,
          implementationCapability: {
            capable: true,
            runtime: "claude-native",
            providerId: "anthropic",
            modelTier: "sonnet",
            availability: "canary_passed",
          },
        }),
      ],
      tasks: [],
      identityWarnings: {},
    },
    { nowMs: NOW },
  );

  const item = summary.items.find((i) => i.nodeId === "patcher");
  assert.ok(item);
  assert.equal(item.implementationCapability?.capable, true);
  assert.equal(item.implementationCapability?.runtime, "claude-native");
  assert.equal(item.implementationCapability?.providerId, "anthropic");
  assert.equal(item.implementationCapability?.modelTier, "sonnet");
});

test("#1597: an incapable worker still projects its profile, so 'no' is visible too", () => {
  const summary = buildWorkerCapacitySummary(
    {
      workers: [
        worker("analyst-only", {
          implementationCapability: {
            capable: false,
            runtime: "unknown",
            availability: "disabled",
          },
        }),
      ],
      tasks: [],
      identityWarnings: {},
    },
    { nowMs: NOW },
  );

  const item = summary.items.find((i) => i.nodeId === "analyst-only");
  assert.equal(item?.implementationCapability?.capable, false);
  assert.equal(item?.implementationCapability?.availability, "disabled");
});

test("#1597: a worker that declared no profile omits the field rather than guessing", () => {
  const summary = buildWorkerCapacitySummary(
    { workers: [worker("legacy")], tasks: [], identityWarnings: {} },
    { nowMs: NOW },
  );

  const item = summary.items.find((i) => i.nodeId === "legacy");
  assert.ok(item);
  assert.equal("implementationCapability" in item, false);
});
