import assert from "node:assert/strict";
import test from "node:test";

import {
  SHARED_STATE_LEASE_CONFORMANCE_V1,
  SHARED_STATE_LEASE_FAULT_POINTS_V1,
  SharedStateLeaseConformanceErrorV1,
  runSharedStateLeaseConformanceV1,
  seededDeterministicContenderOrderV1,
  sharedStateLeaseConformanceReportV1Schema,
  sharedStateLeaseConformanceSnapshotV1Schema,
} from "./shared-state-lease-conformance-harness-v1.js";
import {
  TEST_ONLY_DETERMINISTIC_LEASE_REFERENCE_MODEL_V1,
  createTestOnlyDeterministicLeaseReferenceModelFactoryV1,
} from "./shared-state-lease-test-reference-model-v1.js";

const EXPECTED_REPORT = {
  kind: "SharedStateLeaseConformanceReportV1",
  harnessVersion: 1,
  contractVersion: "a2a.shared-state.storage/v1",
  scope: "lease-claim",
  status: "passed",
  scheduler: {
    kind: "seeded-deterministic",
    seed: 1504,
    contenderCount: 32,
    barrier: "explicit-promise",
    transactionLimit: 64,
    transactionCount: 48,
  },
  claims: {
    committedAtBarrier: 1,
    deterministicConflictsAtBarrier: 31,
    conflictReasonCode: "claim_conflict",
    winnerSeededRank: 1,
    winnerAttemptCount: 1,
    winnerAuthorityCheck: "renewed",
    successfulClaimFencingTokens: ["1", "2", "3"],
    laterFencesStrictlyGreater: true,
  },
  expiry: {
    clock: "injected-fake",
    advance: "exactly-through-expiry",
    reclaim: "committed",
  },
  staleFence: {
    reasonCode: "stale_fence",
    renewRejections: 1,
    completeMutationRejections: 1,
    checkpointMutationRejections: 1,
    releaseRejections: 1,
    stateUnchanged: true,
  },
  transactionFaults: [
    {
      faultPoint: "before_mutation",
      failedReasonCode: "authority_unavailable",
      rollback: "all-or-none",
      nextCleanClaim: "committed",
    },
    {
      faultPoint: "after_resource_mutation",
      failedReasonCode: "authority_unavailable",
      rollback: "all-or-none",
      nextCleanClaim: "committed",
    },
    {
      faultPoint: "after_audit_outbox_staging",
      failedReasonCode: "authority_unavailable",
      rollback: "all-or-none",
      nextCleanClaim: "committed",
    },
    {
      faultPoint: "before_commit",
      failedReasonCode: "authority_unavailable",
      rollback: "all-or-none",
      nextCleanClaim: "committed",
    },
  ],
  closeReopen: {
    snapshot: "preserved",
    laterFence: "strictly-greater",
  },
  singleton: {
    secondSimultaneousOwner: "failed-closed",
    reasonCode: "ownership_conflict",
  },
} as const;

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const nested of Object.values(value)) assertDeepFrozen(nested);
}

function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (value === null || typeof value !== "object") return keys;
  for (const [key, nested] of Object.entries(value)) {
    keys.push(key);
    collectKeys(nested, keys);
  }
  return keys;
}

test("labels the deterministic lease reference model as test-only and detached", () => {
  assert.deepEqual(TEST_ONLY_DETERMINISTIC_LEASE_REFERENCE_MODEL_V1, {
    role: "test-only-deterministic-reference-model",
    productionAdapter: false,
    conformingAdapterClaim: false,
    backendClassClaim: "none",
    runtimeIntegration: "not-attached",
  });
  assert.equal(Object.isFrozen(
    TEST_ONLY_DETERMINISTIC_LEASE_REFERENCE_MODEL_V1,
  ), true);
});

test("proves the exact bounded Phase 2.1 lease/claim report", async () => {
  const report = await runSharedStateLeaseConformanceV1(
    createTestOnlyDeterministicLeaseReferenceModelFactoryV1(),
  );

  assert.deepEqual(report, EXPECTED_REPORT);
  assert.equal(
    report.scheduler.contenderCount,
    SHARED_STATE_LEASE_CONFORMANCE_V1.contenderCount,
  );
  assert.equal(
    report.claims.committedAtBarrier
      + report.claims.deterministicConflictsAtBarrier,
    32,
  );
  assert.deepEqual(
    report.transactionFaults.map(({ faultPoint }) => faultPoint),
    SHARED_STATE_LEASE_FAULT_POINTS_V1,
  );
  assertDeepFrozen(report);
});

test("uses a repeatable seeded contender order and explicit bounded output", () => {
  const firstOrder = seededDeterministicContenderOrderV1();
  const secondOrder = seededDeterministicContenderOrderV1();
  assert.deepEqual(firstOrder, secondOrder);
  assert.equal(firstOrder.length, 32);
  assert.equal(new Set(firstOrder).size, 32);
  assert.equal(
    EXPECTED_REPORT.scheduler.transactionCount
      <= EXPECTED_REPORT.scheduler.transactionLimit,
    true,
  );
});

test("keeps reports, snapshots, fault labels, and errors closed and non-reflecting", async () => {
  assert.equal(
    sharedStateLeaseConformanceReportV1Schema.safeParse({
      ...EXPECTED_REPORT,
      reflectedValue: "forbidden",
    }).success,
    false,
  );
  assert.equal(
    sharedStateLeaseConformanceSnapshotV1Schema.safeParse({
      kind: "SharedStateLeaseConformanceSnapshotV1",
      snapshotVersion: 1,
      resourceBinding: "unbound",
      resourceState: "queued",
      resourceVersion: "0",
      maximumFencingToken: "0",
      activeClaim: false,
      attemptCount: 0,
      mutationCount: 0,
      auditCount: 0,
      outboxCount: 0,
      hostPath: "forbidden",
    }).success,
    false,
  );
  assert.equal(
    collectKeys(EXPECTED_REPORT).some((key) => (
      /(?:path|identity|prompt|payload|secret|timestamp|network|host|random)/iu
        .test(key)
    )),
    false,
  );

  const sentinel = "sensitive-target-value";
  await assert.rejects(
    runSharedStateLeaseConformanceV1({
      async create() {
        throw new Error(sentinel);
      },
    }),
    (error: unknown) => {
      assert.equal(error instanceof SharedStateLeaseConformanceErrorV1, true);
      if (!(error instanceof SharedStateLeaseConformanceErrorV1)) return false;
      assert.equal(error.code, "target_lifecycle_failed");
      assert.equal(error.message.includes(sentinel), false);
      assert.equal(error.stack?.includes(sentinel) ?? false, false);
      return true;
    },
  );
});
