import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SHARED_STATE_OBSERVABILITY_V1_VALUES as V,
  parseSharedStateObservabilityCandidateV1,
  parseSharedStateObservabilityCatalogV1,
  parseSharedStateOperatorObservabilityProjectionV1,
  parseSharedStatePublicObservabilityProjectionV1,
  parseSharedStatePublicReadinessProjectionV1,
  projectSharedStateOperatorObservabilityV1,
  projectSharedStatePublicObservabilityV1,
  projectSharedStatePublicReadinessV1,
  type SharedStateObservabilityErrorCodeV1,
  type SharedStateObservabilityResultV1,
} from "./shared-state-observability-v1.js";
import { SHARED_STATE_STORAGE_V1_VALUES as SV } from "./shared-state-storage-v1-values.js";

type JsonRecord = Record<string, unknown>;

interface GoldenFixture {
  readonly catalogVersion: string;
  readonly safeCandidates: readonly JsonRecord[];
}

interface NegativeMutation {
  readonly path: readonly string[];
  readonly value: unknown;
}

interface NegativeCase {
  readonly caseId: string;
  readonly mutations: readonly NegativeMutation[];
  readonly expectedCode: SharedStateObservabilityErrorCodeV1;
  readonly expectedPath: readonly (string | number)[];
}

interface NegativeFixture {
  readonly catalogVersion: string;
  readonly cases: readonly NegativeCase[];
}

const fixtureUrl = new URL(
  "../fixtures/shared-state-storage/observability-v1-golden.json",
  import.meta.url,
);
const negativeFixtureUrl = new URL(
  "../fixtures/shared-state-storage/observability-v1-negative-leaks.json",
  import.meta.url,
);

const fixture = JSON.parse(
  readFileSync(fixtureUrl, "utf8"),
) as GoldenFixture;
const negativeFixture = JSON.parse(
  readFileSync(negativeFixtureUrl, "utf8"),
) as NegativeFixture;

function expectOk<T>(
  result: SharedStateObservabilityResultV1<T>,
): T {
  assert.equal(
    result.ok,
    true,
    result.ok ? undefined : JSON.stringify(result.error),
  );
  return result.value;
}

function expectError(
  result: SharedStateObservabilityResultV1<unknown>,
  code: SharedStateObservabilityErrorCodeV1,
  path: readonly (string | number)[],
): void {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, code);
  assert.deepEqual(result.error.path, path);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function applyMutation(
  input: JsonRecord,
  mutation: NegativeMutation,
): void {
  assert.ok(mutation.path.length > 0);
  let current: JsonRecord = input;
  for (const segment of mutation.path.slice(0, -1)) {
    const nested = current[segment];
    if (
      nested === null ||
      typeof nested !== "object" ||
      Array.isArray(nested)
    ) {
      const replacement: JsonRecord = {};
      Object.defineProperty(current, segment, {
        configurable: true,
        enumerable: true,
        value: replacement,
        writable: true,
      });
      current = replacement;
    } else {
      current = nested as JsonRecord;
    }
  }
  Object.defineProperty(
    current,
    mutation.path[mutation.path.length - 1]!,
    {
      configurable: true,
      enumerable: true,
      value: clone(mutation.value),
      writable: true,
    },
  );
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [
    key,
    ...stringsIn(nested),
  ]);
}

const firstCandidate = fixture.safeCandidates[0]!;
const secondCandidate = fixture.safeCandidates[1]!;

test("canonical catalog is frozen, closed, versioned, and inventories every pinned observability area", () => {
  assert.equal(fixture.catalogVersion, V.version);
  assert.equal(negativeFixture.catalogVersion, V.version);
  assert.ok(Object.isFrozen(V));
  assert.ok(Object.isFrozen(V.catalog));

  const parsed = expectOk(parseSharedStateObservabilityCatalogV1(V.catalog));
  assert.equal(parsed, V.catalog);
  assert.deepEqual(
    parsed.requirements.map((entry) => entry.area),
    [
      "deployment-topology",
      "readiness",
      "adapter-lifecycle-ownership",
      "clock-continuity-migration",
      "replay",
      "rate-limit",
      "lease-claim",
      "idempotency",
      "outbox",
      "claim-graph-projection",
    ],
  );
  assert.equal(parsed.runtimeIntegration, "not-implemented");
  assert.equal(parsed.healthDeclarationBinding, "pure-parser-only");
  assert.equal(parsed.routeBinding, "not-implemented");
  assert.equal(
    parsed.operatorAuthorization,
    "required-outside-pure-projector",
  );
  assert.deepEqual(parsed.aggregation, {
    maximumCount: 1_000_000_000,
    publicFloor: 5,
    operatorFloor: 3,
    belowFloorValue: null,
    propagation: "entire-count-group",
  });
  assert.deepEqual(parsed.absentSemantics, {
    unavailable: "reason-code-with-no-metrics",
    notApplicable: "reason-code-with-no-metrics",
    unknownBand: "observed-but-not-classifiable",
  });

  const unknown = clone(V.catalog) as unknown as JsonRecord;
  unknown.extra = true;
  expectError(
    parseSharedStateObservabilityCatalogV1(unknown),
    "unknown_field",
    ["extra"],
  );
  const missing = clone(V.catalog) as unknown as JsonRecord;
  delete missing.routeBinding;
  expectError(
    parseSharedStateObservabilityCatalogV1(missing),
    "invalid_value",
    ["routeBinding"],
  );
  const wrongVersion = {
    ...clone(V.catalog),
    catalogVersion: "a2a.shared-state.observability/v2",
  };
  expectError(
    parseSharedStateObservabilityCatalogV1(wrongVersion),
    "unknown_catalog_version",
    ["catalogVersion"],
  );
  const wrongKind = {
    ...clone(V.catalog),
    kind: "SharedStateObservabilityCatalogV2",
  };
  expectError(
    parseSharedStateObservabilityCatalogV1(wrongKind),
    "invalid_discriminant",
    ["kind"],
  );
});

test("all synthetic golden candidates produce valid readiness, public, and separately authorized operator projections", () => {
  for (const candidate of fixture.safeCandidates) {
    const parsedCandidate = expectOk(
      parseSharedStateObservabilityCandidateV1(candidate),
    );
    const readiness = expectOk(projectSharedStatePublicReadinessV1(candidate));
    const publicProjection = expectOk(
      projectSharedStatePublicObservabilityV1(candidate),
    );
    const operatorProjection = expectOk(
      projectSharedStateOperatorObservabilityV1(candidate),
    );

    expectOk(parseSharedStatePublicReadinessProjectionV1(readiness));
    expectOk(
      parseSharedStatePublicObservabilityProjectionV1(publicProjection),
    );
    expectOk(
      parseSharedStateOperatorObservabilityProjectionV1(operatorProjection),
    );

    assert.equal(readiness.visibility, "public-readiness-aggregate");
    assert.equal(publicProjection.visibility, "public-aggregate");
    assert.equal(
      operatorProjection.visibility,
      "authorized-operator-aggregate",
    );
    assert.equal(operatorProjection.authorizationRequired, true);
    assert.equal(readiness.ready, publicProjection.stateContract.serving);
    assert.equal(
      publicProjection.stateContract.topology.expectedProcessBand,
      parsedCandidate.health.topology.expectedProcessCount === 1
        ? "one"
        : "multiple",
    );
    assert.equal(
      Object.hasOwn(publicProjection.stateContract.topology, "expectedProcessCount"),
      false,
    );
    assert.equal(
      Object.hasOwn(publicProjection.stateContract.adapter, "schemaVersion"),
      false,
    );
  }
});

test("public and operator aggregation floors suppress whole groups and prevent subtraction reconstruction", () => {
  const publicProjection = expectOk(
    projectSharedStatePublicObservabilityV1(firstCandidate),
  );
  const operatorProjection = expectOk(
    projectSharedStateOperatorObservabilityV1(firstCandidate),
  );

  assert.deepEqual(publicProjection.domains.replay, {
    availability: "available",
    counts: {
      accepted: { state: "suppressed", value: null },
      replayed: { state: "suppressed", value: null },
      unavailable: { state: "zero", value: 0 },
      storeErrors: { state: "zero", value: 0 },
    },
  });
  assert.deepEqual(operatorProjection.domains.replay, {
    availability: "available",
    counts: {
      accepted: { state: "reported", value: 120 },
      replayed: { state: "reported", value: 4 },
      unavailable: { state: "zero", value: 0 },
      storeErrors: { state: "zero", value: 0 },
    },
  });

  assert.equal(
    publicProjection.domains.rateLimit.availability,
    "available",
  );
  assert.equal(
    operatorProjection.domains.rateLimit.availability,
    "available",
  );
  if (
    publicProjection.domains.rateLimit.availability !== "available" ||
    operatorProjection.domains.rateLimit.availability !== "available"
  ) {
    return;
  }
  assert.equal(
    publicProjection.domains.rateLimit.counts.allowed.state,
    "suppressed",
  );
  assert.equal(
    publicProjection.domains.rateLimit.counts.denied.state,
    "suppressed",
  );
  assert.equal(
    operatorProjection.domains.rateLimit.counts.allowed.state,
    "suppressed",
  );
  assert.equal(
    operatorProjection.domains.rateLimit.counts.denied.state,
    "suppressed",
  );

  assert.equal(publicProjection.domains.outbox.availability, "available");
  assert.equal(operatorProjection.domains.outbox.availability, "available");
  if (
    publicProjection.domains.outbox.availability !== "available" ||
    operatorProjection.domains.outbox.availability !== "available"
  ) {
    return;
  }
  assert.equal(
    publicProjection.domains.outbox.counts.pending.state,
    "reported",
  );
  assert.equal(
    publicProjection.domains.outbox.counts.receiptConfirmed.state,
    "reported",
  );
  assert.equal(
    operatorProjection.domains.outbox.counts.pending.state,
    "suppressed",
  );
  assert.equal(
    operatorProjection.domains.outbox.counts.duplicateReplays.state,
    "suppressed",
  );
  assert.equal(
    operatorProjection.domains.outbox.counts.orderViolations.state,
    "zero",
  );

  assert.equal(
    operatorProjection.domains.claimGraphProjection.availability,
    "available",
  );
  if (
    operatorProjection.domains.claimGraphProjection.availability ===
    "available"
  ) {
    assert.deepEqual(
      operatorProjection.domains.claimGraphProjection.counts.failedBatches,
      { state: "reported", value: 3 },
    );
  }
});

test("public projection omits operator-only configuration, high-water, policy, and failure aggregates", () => {
  const publicProjection = expectOk(
    projectSharedStatePublicObservabilityV1(firstCandidate),
  );
  const operatorProjection = expectOk(
    projectSharedStateOperatorObservabilityV1(firstCandidate),
  );
  const publicJson = JSON.stringify(publicProjection);
  const operatorJson = JSON.stringify(operatorProjection);

  for (const field of [
    "windowBand",
    "limitBand",
    "retentionPolicyClass",
    "highWaterClass",
    "projectionVersion",
    "sourceHighWaterClass",
    "checkpointHighWaterClass",
    "failedBatches",
    "rollbackBatches",
    "renewalFailures",
    "fencingRejections",
  ]) {
    assert.equal(publicJson.includes(`"${field}"`), false, field);
    assert.equal(operatorJson.includes(`"${field}"`), true, field);
  }
});

test("unavailable and not-applicable projections carry one bounded reason and no metrics", () => {
  const publicProjection = expectOk(
    projectSharedStatePublicObservabilityV1(secondCandidate),
  );
  const operatorProjection = expectOk(
    projectSharedStateOperatorObservabilityV1(secondCandidate),
  );

  assert.deepEqual(publicProjection.domains.replay, {
    availability: "unavailable",
    reasonCode: "collection-failed",
  });
  assert.deepEqual(operatorProjection.domains.leaseClaim, {
    availability: "unavailable",
    reasonCode: "adapter-unavailable",
  });
  assert.deepEqual(publicProjection.domains.idempotency, {
    availability: "not-applicable",
    reasonCode: "primitive-not-implemented",
  });
  assert.equal(
    Object.hasOwn(publicProjection.domains.replay, "counts"),
    false,
  );
  assert.equal(
    Object.hasOwn(operatorProjection.domains.idempotency, "counts"),
    false,
  );
});

test("all closed bands, availability reasons, reset reasons, readiness reasons, and graph completeness states are accepted", () => {
  for (const band of V.ageBands) {
    const candidate = clone(firstCandidate);
    (candidate.observations as JsonRecord).leaseClaim =
      clone((candidate.observations as JsonRecord).leaseClaim);
    ((candidate.observations as JsonRecord).leaseClaim as JsonRecord)
      .oldestAgeBand = band;
    expectOk(parseSharedStateObservabilityCandidateV1(candidate));
  }
  for (const band of V.pressureBands) {
    const candidate = clone(firstCandidate);
    ((candidate.observations as JsonRecord).leaseClaim as JsonRecord)
      .pressureBand = band;
    expectOk(parseSharedStateObservabilityCandidateV1(candidate));
  }
  for (const band of V.lagBands) {
    const candidate = clone(firstCandidate);
    ((candidate.observations as JsonRecord).outbox as JsonRecord).lagBand =
      band;
    expectOk(parseSharedStateObservabilityCandidateV1(candidate));
  }
  for (const highWaterClass of V.highWaterClasses) {
    const candidate = clone(firstCandidate);
    ((candidate.observations as JsonRecord).outbox as JsonRecord)
      .highWaterClass = highWaterClass;
    expectOk(parseSharedStateObservabilityCandidateV1(candidate));
  }
  for (const windowBand of V.rateWindowBands) {
    const candidate = clone(firstCandidate);
    ((candidate.observations as JsonRecord).rateLimit as JsonRecord)
      .windowBand = windowBand;
    expectOk(parseSharedStateObservabilityCandidateV1(candidate));
  }
  for (const limitBand of V.rateLimitBands) {
    const candidate = clone(firstCandidate);
    ((candidate.observations as JsonRecord).rateLimit as JsonRecord)
      .limitBand = limitBand;
    expectOk(parseSharedStateObservabilityCandidateV1(candidate));
  }
  for (const retentionPolicyClass of V.idempotencyRetentionPolicyClasses) {
    const candidate = clone(firstCandidate);
    ((candidate.observations as JsonRecord).idempotency as JsonRecord)
      .retentionPolicyClass = retentionPolicyClass;
    expectOk(parseSharedStateObservabilityCandidateV1(candidate));
  }
  for (const projectionVersion of V.graphProjectionVersionClasses) {
    const candidate = clone(firstCandidate);
    ((candidate.observations as JsonRecord)
      .claimGraphProjection as JsonRecord).projectionVersion =
        projectionVersion;
    expectOk(parseSharedStateObservabilityCandidateV1(candidate));
  }
  for (const reasonCode of V.unavailableReasonCodes) {
    const candidate = clone(firstCandidate);
    (candidate.observations as JsonRecord).leaseClaim = {
      availability: "unavailable",
      reasonCode,
    };
    expectOk(parseSharedStateObservabilityCandidateV1(candidate));
  }
  for (const reasonCode of V.notApplicableReasonCodes) {
    const candidate = clone(firstCandidate);
    (candidate.observations as JsonRecord).leaseClaim = {
      availability: "not-applicable",
      reasonCode,
    };
    expectOk(parseSharedStateObservabilityCandidateV1(candidate));
  }
  for (const reasonCode of SV.resetReasonCodes) {
    const candidate = clone(firstCandidate);
    const primitives = (candidate.health as JsonRecord)
      .primitives as JsonRecord;
    (primitives.replay as JsonRecord).lastResetReason = reasonCode;
    (primitives.rateLimit as JsonRecord).lastResetReason = reasonCode;
    expectOk(parseSharedStateObservabilityCandidateV1(candidate));
  }
  for (const reasonCode of SV.readinessReasonCodes) {
    expectOk(
      parseSharedStatePublicReadinessProjectionV1({
        kind: V.kinds.readiness,
        catalogVersion: V.version,
        visibility: "public-readiness-aggregate",
        ready: false,
        effectiveGrade: "multi-process-unsupported",
        reasonCodes: [reasonCode],
      }),
    );
  }

  const completeCandidate = clone(firstCandidate);
  (completeCandidate.health as JsonRecord).completeness = {
    graphProjection: "complete",
    negativeEvidenceAllowed: true,
  };
  ((completeCandidate.observations as JsonRecord)
    .claimGraphProjection as JsonRecord).completeness = "complete";
  expectOk(parseSharedStateObservabilityCandidateV1(completeCandidate));
  expectOk(parseSharedStateObservabilityCandidateV1(firstCandidate));
  expectOk(parseSharedStateObservabilityCandidateV1(secondCandidate));
});

test("aggregate count bounds are exact and successful projections stay parser-valid", () => {
  for (const value of [0, V.limits.maxAggregateCount]) {
    const candidate = clone(firstCandidate);
    (((candidate.observations as JsonRecord).replay as JsonRecord)
      .counts as JsonRecord).accepted = value;
    expectOk(parseSharedStateObservabilityCandidateV1(candidate));
    expectOk(projectSharedStatePublicObservabilityV1(candidate));
    expectOk(projectSharedStateOperatorObservabilityV1(candidate));
  }

  for (const [value, code] of [
    [-1, "out_of_range"],
    [V.limits.maxAggregateCount + 1, "out_of_range"],
    [1.5, "invalid_type"],
  ] as const) {
    const candidate = clone(firstCandidate);
    (((candidate.observations as JsonRecord).replay as JsonRecord)
      .counts as JsonRecord).accepted = value;
    expectError(
      parseSharedStateObservabilityCandidateV1(candidate),
      code,
      ["observations", "replay", "counts", "accepted"],
    );
  }
});

test("negative leak corpus is rejected recursively by the parser and every projector with stable codes and paths", () => {
  assert.ok(negativeFixture.cases.length >= 30);
  const seen = new Set<SharedStateObservabilityErrorCodeV1>();
  for (const negative of negativeFixture.cases) {
    const candidate = clone(firstCandidate);
    for (const mutation of negative.mutations) {
      applyMutation(candidate, mutation);
    }
    for (const result of [
      parseSharedStateObservabilityCandidateV1(candidate),
      projectSharedStatePublicReadinessV1(candidate),
      projectSharedStatePublicObservabilityV1(candidate),
      projectSharedStateOperatorObservabilityV1(candidate),
    ]) {
      expectError(result, negative.expectedCode, negative.expectedPath);
    }
    seen.add(negative.expectedCode);
  }
  assert.deepEqual(
    [...seen].sort(),
    [
      "forbidden_observability_field",
      "health_declaration_invalid",
      "health_observation_mismatch",
      "invalid_discriminant",
      "invalid_enum",
      "invalid_type",
      "out_of_range",
      "unknown_catalog_version",
      "unknown_field",
    ].sort(),
  );
});

test("projection parsers reject duplicate reasons, unsafe mixed suppression, unknown fields, bad versions, and below-floor reports", () => {
  const readiness = expectOk(
    projectSharedStatePublicReadinessV1(firstCandidate),
  );
  expectError(
    parseSharedStatePublicReadinessProjectionV1({
      ...readiness,
      ready: false,
      reasonCodes: ["adapter_unavailable", "adapter_unavailable"],
    }),
    "duplicate_value",
    ["reasonCodes", 1],
  );
  expectError(
    parseSharedStatePublicReadinessProjectionV1({
      ...readiness,
      ready: false,
    }),
    "invalid_value",
    ["ready"],
  );

  const publicProjection = expectOk(
    projectSharedStatePublicObservabilityV1(firstCandidate),
  );
  const unsafe = clone(publicProjection);
  if (unsafe.domains.replay.availability !== "available") {
    assert.fail("golden replay observation must be available");
  }
  unsafe.domains.replay.counts.accepted = {
    state: "reported",
    value: 5,
  };
  expectError(
    parseSharedStatePublicObservabilityProjectionV1(unsafe),
    "unsafe_aggregate_combination",
    ["domains", "replay", "counts"],
  );

  const belowFloor = clone(publicProjection);
  if (belowFloor.domains.idempotency.availability !== "available") {
    assert.fail("golden idempotency observation must be available");
  }
  belowFloor.domains.idempotency.counts.new = {
    state: "reported",
    value: 4,
  };
  expectError(
    parseSharedStatePublicObservabilityProjectionV1(belowFloor),
    "out_of_range",
    ["domains", "idempotency", "counts", "new", "value"],
  );

  expectError(
    parseSharedStatePublicObservabilityProjectionV1({
      ...publicProjection,
      extra: true,
    }),
    "unknown_field",
    ["extra"],
  );
  expectError(
    parseSharedStatePublicObservabilityProjectionV1({
      ...publicProjection,
      catalogVersion: "a2a.shared-state.observability/v2",
    }),
    "unknown_catalog_version",
    ["catalogVersion"],
  );
  expectError(
    parseSharedStateOperatorObservabilityProjectionV1({
      ...expectOk(projectSharedStateOperatorObservabilityV1(firstCandidate)),
      taskId: "task-SENTINEL-OUTPUT-0001",
    }),
    "forbidden_observability_field",
    ["taskId"],
  );
});

test("every stable observability error code is exercised with an exact path", () => {
  const exercised = new Set<SharedStateObservabilityErrorCodeV1>([
    "invalid_value",
    "duplicate_value",
    "unsafe_aggregate_combination",
  ]);
  for (const negative of negativeFixture.cases) {
    exercised.add(negative.expectedCode);
  }
  expectError(
    parseSharedStateObservabilityCatalogV1(null),
    "invalid_type",
    [],
  );
  exercised.add("invalid_type");
  assert.deepEqual([...exercised].sort(), [...V.errorCodes].sort());
});

test("successful serialized outputs contain no negative-corpus sentinel substring or identity-bearing field", () => {
  const sentinels = new Set(
    stringsIn(negativeFixture)
      .filter((value) => value.includes("SENTINEL"))
      .flatMap((value) =>
        value.match(/SENTINEL[A-Za-z0-9_-]*/g) ?? [],
      ),
  );
  assert.ok(sentinels.size >= 15);

  for (const candidate of fixture.safeCandidates) {
    const outputs = [
      expectOk(projectSharedStatePublicReadinessV1(candidate)),
      expectOk(projectSharedStatePublicObservabilityV1(candidate)),
      expectOk(projectSharedStateOperatorObservabilityV1(candidate)),
    ];
    for (const output of outputs) {
      const serialized = JSON.stringify(output);
      for (const sentinel of sentinels) {
        assert.equal(serialized.includes(sentinel), false, sentinel);
      }
      for (const forbiddenField of [
        "taskId",
        "workerId",
        "providerId",
        "ownerId",
        "requesterId",
        "eventId",
        "receiptId",
        "streamKey",
        "bucketKey",
        "nonce",
        "digest",
        "payload",
        "claimText",
        "artifactPath",
        "worktreePath",
        "dbPath",
        "dsn",
        "topTasks",
        "byWorker",
        "timestamp",
        "ageSec",
        "sourceHighWater",
        "checkpointHighWater",
      ]) {
        assert.equal(
          serialized.includes(`"${forbiddenField}"`),
          false,
          forbiddenField,
        );
      }
    }
  }
});
