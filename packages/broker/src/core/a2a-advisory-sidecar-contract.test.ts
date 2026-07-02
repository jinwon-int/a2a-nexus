import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DISABLED_ADVISORY_SIDECAR_RECOMMENDATION,
  buildAdvisorySidecarFallback,
  isAdvisorySidecarRecommendation,
  resolveAdvisorySidecarRecommendation,
  validateAdvisorySidecarRecommendation,
} from "./a2a-advisory-sidecar-contract.js";

const validRecommendation = {
  schemaVersion: 1,
  taskType: "github-issue-triage",
  recommendedWorkerIds: ["workerbeta", "workergamma"],
  recommendedModel: "minimax/minimax-m3",
  confidence: 0.81234,
  reason: "Low-risk source-only issue triage; use Team1 research workers.",
  needsHuman: true,
  wikiQueries: ["A2A advisory sidecar", "worker capability allowlist"],
  advisoryOnly: true,
};

test("validates advisory sidecar recommendations (#785)", () => {
  const recommendation = validateAdvisorySidecarRecommendation(validRecommendation);

  assert.ok(recommendation);
  assert.equal(recommendation.schemaVersion, 1);
  assert.equal(recommendation.taskType, "github-issue-triage");
  assert.deepEqual(recommendation.recommendedWorkerIds, ["workerbeta", "workergamma"]);
  assert.equal(recommendation.recommendedModel, "minimax/minimax-m3");
  assert.equal(recommendation.confidence, 0.8123);
  assert.equal(recommendation.needsHuman, true);
  assert.equal(recommendation.advisoryOnly, true);
  assert.equal(isAdvisorySidecarRecommendation(recommendation), true);
});

test("rejects malformed advisory sidecar output (#785)", () => {
  assert.equal(validateAdvisorySidecarRecommendation(null), null);
  assert.equal(validateAdvisorySidecarRecommendation({ ...validRecommendation, taskType: "" }), null);
  assert.equal(validateAdvisorySidecarRecommendation({ ...validRecommendation, confidence: 1.1 }), null);
  assert.equal(validateAdvisorySidecarRecommendation({ ...validRecommendation, confidence: Number.NaN }), null);
  assert.equal(validateAdvisorySidecarRecommendation({ ...validRecommendation, recommendedWorkerIds: "workerbeta" }), null);
  assert.equal(validateAdvisorySidecarRecommendation({ ...validRecommendation, advisoryOnly: false }), null);
});

test("resolves disabled, timeout, unavailable, and malformed states to deterministic fallback (#785)", () => {
  assert.deepEqual(
    resolveAdvisorySidecarRecommendation("disabled", validRecommendation),
    {
      status: "fallback",
      fallbackReason: "disabled",
      recommendation: DEFAULT_DISABLED_ADVISORY_SIDECAR_RECOMMENDATION,
    },
  );

  for (const status of ["timeout", "unavailable"] as const) {
    const resolved = resolveAdvisorySidecarRecommendation(status, validRecommendation);
    assert.equal(resolved.status, "fallback");
    assert.equal(resolved.fallbackReason, status);
    assert.equal(resolved.recommendation.confidence, 0);
    assert.deepEqual(resolved.recommendation.recommendedWorkerIds, []);
    assert.equal(resolved.recommendation.recommendedModel, null);
    assert.equal(resolved.recommendation.needsHuman, true);
    assert.equal(resolved.recommendation.advisoryOnly, true);
  }

  const malformed = resolveAdvisorySidecarRecommendation("enabled", { ...validRecommendation, reason: "" });
  assert.equal(malformed.status, "fallback");
  assert.equal(malformed.fallbackReason, "malformed");
  assert.equal(malformed.recommendation.confidence, 0);
  assert.equal(malformed.recommendation.needsHuman, true);
});

test("preserves unsupported model recommendations without authorizing them (#785)", () => {
  const recommendation = validateAdvisorySidecarRecommendation({
    ...validRecommendation,
    recommendedModel: "unsupported/vendor-sidecar-model",
  });

  assert.ok(recommendation);
  assert.equal(recommendation.recommendedModel, "unsupported/vendor-sidecar-model");
  assert.equal(recommendation.advisoryOnly, true);
});

test("rejects secret-like fields anywhere in untrusted sidecar output (#785)", () => {
  assert.equal(validateAdvisorySidecarRecommendation({ ...validRecommendation, apiKey: "redacted" }), null);
  assert.equal(
    validateAdvisorySidecarRecommendation({
      ...validRecommendation,
      nested: { refresh_token: "redacted" },
    }),
    null,
  );
});

test("enabled sidecar output resolves to a recommendation only after validation (#785)", () => {
  const resolved = resolveAdvisorySidecarRecommendation("enabled", validRecommendation);

  assert.equal(resolved.status, "recommended");
  assert.equal(resolved.fallbackReason, undefined);
  assert.equal(resolved.recommendation.reason, validRecommendation.reason);
});

test("fallback builder is pure and advisory-only (#785)", () => {
  const fallback = buildAdvisorySidecarFallback("malformed");

  assert.equal(fallback.schemaVersion, 1);
  assert.equal(fallback.taskType, "unknown");
  assert.deepEqual(fallback.recommendedWorkerIds, []);
  assert.equal(fallback.recommendedModel, null);
  assert.equal(fallback.confidence, 0);
  assert.equal(fallback.needsHuman, true);
  assert.equal(fallback.advisoryOnly, true);
});
