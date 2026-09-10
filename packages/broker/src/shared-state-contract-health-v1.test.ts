/**
 * Slice R: `/health` `stateContract` bound to the observability catalog's
 * public-aggregate projection (spec sections 7.3/7.4).
 *
 * What this pins, on top of the Slice M guarantees it preserves:
 * - the published member IS the catalog projection (kind/visibility present,
 *   the catalog's own parse accepted it — it could not have been built
 *   otherwise);
 * - the exact process count never reaches the public member (one|multiple
 *   band only);
 * - the security-primitive bands are REAL: epoch age derives from process
 *   uptime, pressure from the live limiter counters, replay counts from the
 *   replay cache;
 * - the V1 primitive domains honestly report not-applicable.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSharedStateHealthDeclarationV1,
  buildSharedStatePublicObservabilityV1,
} from "./shared-state-contract-health-v1.js";
import type { SharedStateHealthProjectionV1 } from "./shared-state-storage-contract-v1.js";
import { startTestServer, withEnv } from "./server-test-helpers.js";

function declarationInput(overrides: Partial<Parameters<typeof buildSharedStateHealthDeclarationV1>[0]> = {}) {
  return {
    configuredGrade: "single-process",
    effectiveGrade: "single-process",
    gradeDefaulted: true,
    serving: true,
    ownership: "held" as const,
    reasonCodes: [] as SharedStateHealthProjectionV1["reasonCodes"],
    expectedProcessCount: 1,
    persistenceBackend: "sqlite" as const,
    clockSafety: "safe" as const,
    processUptimeSec: 45,
    rateLimitDenied: 0,
    rateLimitTotal: 100,
    ...overrides,
  };
}

test("declaration bands derive from uptime and denial share, not guesses", () => {
  const young = buildSharedStateHealthDeclarationV1(declarationInput());
  assert.equal(young.primitives.replay.epochAgeBand, "under-1m");
  assert.equal(young.primitives.replay.pressureBand, "none");

  const old = buildSharedStateHealthDeclarationV1(declarationInput({ processUptimeSec: 172_800 }));
  assert.equal(old.primitives.replay.epochAgeBand, "one-day-or-more");

  const pressured = buildSharedStateHealthDeclarationV1(
    declarationInput({ rateLimitDenied: 30, rateLimitTotal: 100 }),
  );
  assert.equal(pressured.primitives.rateLimit.pressureBand, "high");

  // one denial in a hundred is 1% — outside the none band, inside low
  const edge = buildSharedStateHealthDeclarationV1(
    declarationInput({ rateLimitDenied: 2, rateLimitTotal: 100 }),
  );
  assert.equal(edge.primitives.rateLimit.pressureBand, "low");
});

test("the projected public member coarsens the process count and keeps only closed vocabularies", () => {
  const projection = buildSharedStatePublicObservabilityV1({
    health: buildSharedStateHealthDeclarationV1(declarationInput()),
    clockContinuity: "reset",
    replay: { accepted: 12, replayed: 3 },
    rateLimit: { windowMs: 60_000, limit: 10, allowed: 500, denied: 2 },
  });
  assert.equal(projection.ok, true);
  if (!projection.ok) return;
  const contract = projection.value.stateContract;
  assert.equal(contract.topology.expectedProcessBand, "one");
  assert.equal(Object.hasOwn(contract.topology, "expectedProcessCount"), false);
  assert.equal(contract.clock.safety, "safe");
  assert.equal(contract.clock.continuity, "reset");
  assert.equal(contract.adapter.migrationState, "not-applicable");
  assert.equal(contract.adapter.contractVersion, null);
});

test("V1 primitive domains report not-applicable; security primitives report real counters", () => {
  const projection = buildSharedStatePublicObservabilityV1({
    health: buildSharedStateHealthDeclarationV1(declarationInput()),
    clockContinuity: "reset",
    replay: { accepted: 50, replayed: 3 },
    rateLimit: { windowMs: 60_000, limit: 10, allowed: 500, denied: 2 },
  });
  assert.equal(projection.ok, true);
  if (!projection.ok) return;
  const domains = projection.value.domains;
  for (const name of ["leaseClaim", "idempotency", "outbox", "claimGraphProjection"] as const) {
    assert.equal(domains[name].availability, "not-applicable");
    if (domains[name].availability === "not-applicable") {
      assert.equal(domains[name].reasonCode, "primitive-not-implemented");
    }
  }
  assert.equal(domains.replay.availability, "available");
  if (domains.replay.availability === "available") {
    // public floor is five: replayed=3 suppresses every nonzero member of the
    // group (including accepted=50) so the small value cannot be recovered by
    // subtraction; zeros stay zero.
    assert.equal(domains.replay.counts.replayed.state, "suppressed");
    assert.equal(domains.replay.counts.accepted.state, "suppressed");
    assert.equal(domains.replay.counts.storeErrors.state, "zero");
  }
  assert.equal(domains.rateLimit.availability, "available");
});

test("rate-limit store errors flow into the public projection (#1504 Slice T)", () => {
  const projection = buildSharedStatePublicObservabilityV1({
    health: buildSharedStateHealthDeclarationV1(declarationInput()),
    clockContinuity: "reset",
    replay: { accepted: 50, replayed: 3 },
    rateLimit: {
      windowMs: 60_000,
      limit: 10,
      allowed: 500,
      denied: 2,
      storeErrors: 7,
    },
  });
  assert.equal(projection.ok, true);
  if (!projection.ok) return;
  const rateLimit = projection.value.domains.rateLimit;
  assert.equal(rateLimit.availability, "available");
  if (rateLimit.availability === "available") {
    // denied=2 is nonzero-but-below the public floor, so the whole group is
    // suppressed — including storeErrors=7 — to keep small values
    // unrecoverable; zeros still stay zero.
    assert.equal(rateLimit.counts.storeErrors.state, "suppressed");
    assert.equal(rateLimit.counts.allowed.state, "suppressed");
  }

  const allBig = buildSharedStatePublicObservabilityV1({
    health: buildSharedStateHealthDeclarationV1(declarationInput()),
    clockContinuity: "reset",
    replay: { accepted: 50, replayed: 3 },
    rateLimit: {
      windowMs: 60_000,
      limit: 10,
      allowed: 500,
      denied: 50,
      storeErrors: 7,
    },
  });
  assert.equal(allBig.ok, true);
  if (!allBig.ok) return;
  const big = allBig.value.domains.rateLimit;
  if (big.availability === "available") {
    assert.equal(big.counts.storeErrors.state, "reported");
    assert.equal(big.counts.storeErrors.value, 7);
  }
});

test("/health stateContract reports the defaulted grade and held fence through the catalog projection", async () => {
  await withEnv({
    BROKER_DEPLOYMENT_GRADE: undefined,
    BROKER_EXPECTED_PROCESS_COUNT: undefined,
  }, async () => {
    const server = await startTestServer({ edgeSecret: "s" });
    try {
      const res = await fetch(`${server.baseUrl}/health`, {
        headers: { "x-a2a-edge-secret": "s" },
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      const contract = body.stateContract;
      assert.equal(body.stateContractCatalog.visibility, "public-aggregate");
      assert.equal(contract.configuredGrade, "single-process");
      assert.equal(contract.effectiveGrade, "single-process");
      assert.equal(contract.gradeDefaulted, true);
      assert.equal(contract.serving, true);
      assert.deepEqual(contract.reasonCodes, []);
      assert.equal(contract.topology.expectedProcessBand, "one");
      assert.equal(contract.topology.ownership, "held");
      assert.equal(contract.adapter.backendClass, "legacy-sqlite");
      assert.equal(contract.adapter.durability, "durable");
      assert.equal(contract.adapter.contractVersion, null);
      assert.equal(contract.clock.continuity, "reset");
      assert.equal(contract.securityPrimitives.replay.resetRisk, true);
      assert.equal(contract.securityPrimitives.rateLimit.lastResetReason, "process_start");
      const domains = body.stateContractDomains;
      assert.equal(domains.leaseClaim.availability, "not-applicable");
      assert.equal(domains.claimGraphProjection.availability, "not-applicable");
      const encoded = JSON.stringify({ contract, domains });
      assert.equal(encoded.includes("owner_token"), false);
      assert.equal(encoded.includes("shared-state-v1"), false);
      assert.equal(encoded.includes("nonce"), false);
      assert.equal(encoded.includes("bucket"), false);
    } finally {
      await server.close();
    }
  });
});

test("/health stateContract marks an explicit grade as not defaulted", async () => {
  await withEnv({
    BROKER_DEPLOYMENT_GRADE: "single-writer-durable",
    BROKER_EXPECTED_PROCESS_COUNT: "1",
  }, async () => {
    const server = await startTestServer({ edgeSecret: "s" });
    try {
      const res = await fetch(`${server.baseUrl}/health`, {
        headers: { "x-a2a-edge-secret": "s" },
      });
      assert.equal(res.status, 200);
      const contract = (await res.json()).stateContract;
      assert.equal(contract.configuredGrade, "single-writer-durable");
      assert.equal(contract.effectiveGrade, "single-writer-durable");
      assert.equal(contract.gradeDefaulted, false);
      assert.equal(contract.securityPrimitives.replay.resetRisk, true);
    } finally {
      await server.close();
    }
  });
});

test("an incoherent declaration (single writer, seven processes) fails closed", () => {
  const projection = buildSharedStatePublicObservabilityV1({
    health: buildSharedStateHealthDeclarationV1(
      declarationInput({ expectedProcessCount: 7 }),
    ),
    clockContinuity: "reset",
    replay: { accepted: 0, replayed: 0 },
    rateLimit: { windowMs: 60_000, limit: 10, allowed: 0, denied: 0 },
  });
  assert.equal(projection.ok, false);
  if (!projection.ok) {
    assert.equal(projection.error.code, "health_declaration_invalid");
  }
});
