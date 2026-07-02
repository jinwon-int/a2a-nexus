import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DISABLED_ADVISORY_SIDECAR_RECOMMENDATION,
} from "./a2a-advisory-sidecar-contract.js";
import {
  ADVISORY_SIDECAR_DEFAULT_OFF_BOUNDARY,
  defaultDisabledAdvisorySidecarRecommendation,
  resolveDefaultOffAdvisorySidecarRecommendation,
} from "./a2a-advisory-sidecar-resolver.js";

const validRawRecommendation = {
  schemaVersion: 1,
  taskType: "github-issue-cleanup",
  recommendedWorkerIds: ["workerbeta"],
  recommendedModel: "minimax/minimax-m3",
  confidence: 0.72,
  reason: "Read-only issue cleanup; finalizer remains authoritative.",
  needsHuman: true,
  wikiQueries: ["A2A advisory sidecar default-off resolver"],
  advisoryOnly: true,
};

test("default-off advisory resolver returns deterministic disabled fallback when unconfigured (#789)", () => {
  const resolved = resolveDefaultOffAdvisorySidecarRecommendation();

  assert.equal(resolved.status, "fallback");
  assert.equal(resolved.fallbackReason, "disabled");
  assert.equal(resolved.effectiveStatus, "disabled");
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.configured, false);
  assert.equal(resolved.advisoryOnly, true);
  assert.deepEqual(resolved.recommendation, DEFAULT_DISABLED_ADVISORY_SIDECAR_RECOMMENDATION);
});

test("default-off advisory resolver ignores raw output while disabled (#789)", () => {
  const resolved = resolveDefaultOffAdvisorySidecarRecommendation({
    enabled: false,
    configured: true,
    status: "enabled",
    rawOutput: validRawRecommendation,
  });

  assert.equal(resolved.status, "fallback");
  assert.equal(resolved.fallbackReason, "disabled");
  assert.equal(resolved.effectiveStatus, "disabled");
  assert.deepEqual(resolved.recommendation, DEFAULT_DISABLED_ADVISORY_SIDECAR_RECOMMENDATION);
});

test("default-off advisory resolver treats enabled but unconfigured as disabled (#789)", () => {
  const resolved = resolveDefaultOffAdvisorySidecarRecommendation({
    enabled: true,
    configured: false,
    status: "enabled",
    rawOutput: validRawRecommendation,
  });

  assert.equal(resolved.status, "fallback");
  assert.equal(resolved.fallbackReason, "disabled");
  assert.equal(resolved.effectiveStatus, "disabled");
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.configured, false);
});

test("default-off advisory resolver validates caller-supplied output only when enabled and configured (#789)", () => {
  const resolved = resolveDefaultOffAdvisorySidecarRecommendation({
    enabled: true,
    configured: true,
    status: "enabled",
    rawOutput: validRawRecommendation,
  });

  assert.equal(resolved.status, "recommended");
  assert.equal(resolved.fallbackReason, undefined);
  assert.equal(resolved.effectiveStatus, "enabled");
  assert.equal(resolved.recommendation.taskType, "github-issue-cleanup");
  assert.deepEqual(resolved.recommendation.recommendedWorkerIds, ["workerbeta"]);
  assert.equal(resolved.recommendation.advisoryOnly, true);
});

test("default-off advisory resolver preserves timeout and unavailable fallback when explicitly observed (#789)", () => {
  for (const status of ["timeout", "unavailable"] as const) {
    const resolved = resolveDefaultOffAdvisorySidecarRecommendation({
      enabled: true,
      configured: true,
      status,
      rawOutput: validRawRecommendation,
    });

    assert.equal(resolved.status, "fallback");
    assert.equal(resolved.fallbackReason, status);
    assert.equal(resolved.effectiveStatus, status);
    assert.equal(resolved.recommendation.confidence, 0);
    assert.equal(resolved.recommendation.advisoryOnly, true);
  }
});

test("default-off advisory resolver exposes a no-side-effect integration boundary (#789)", () => {
  const boundary = resolveDefaultOffAdvisorySidecarRecommendation().boundary;

  assert.deepEqual(boundary, ADVISORY_SIDECAR_DEFAULT_OFF_BOUNDARY);
  assert.equal(boundary.startsSidecarProcess, false);
  assert.equal(boundary.sendsProviderRequests, false);
  assert.equal(boundary.mutatesBrokerState, false);
  assert.equal(boundary.mutatesDatabase, false);
  assert.equal(boundary.dispatchesTasks, false);
  assert.equal(boundary.changesRouting, false);
  assert.equal(boundary.bypassesFinalizer, false);
  assert.equal(boundary.bypassesWorkerCapabilityChecks, false);
  assert.equal(boundary.bypassesModelAllowlists, false);
  assert.equal(boundary.bypassesApprovalGates, false);
  assert.equal(boundary.bypassesSecretRedaction, false);
});

test("default disabled advisory recommendation helper is pure and shared with the #785 contract (#789)", () => {
  assert.deepEqual(
    defaultDisabledAdvisorySidecarRecommendation(),
    DEFAULT_DISABLED_ADVISORY_SIDECAR_RECOMMENDATION,
  );
});
