import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SHARED_STATE_TIME_V1_VALUES as V,
  deriveSharedStateExpiryV1,
  evaluateSharedStateLogicalBoundaryV1,
  evaluateSharedStateTimeV1,
  parseSharedStateLogicalBoundaryV1,
  parseSharedStateTimePolicyV1,
  parseTrustedSharedStateTimeObservationV1,
  type SharedStateTimeErrorCodeV1,
  type SharedStateTimeEvaluationV1,
  type SharedStateTimeResultV1,
} from "./shared-state-time-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as STORAGE_V,
  parseSharedStateTransactionCommandV1,
} from "./shared-state-storage-contract-v1.js";

interface GoldenFixture {
  readonly timeVersion: string;
  readonly policies: Readonly<Record<string, unknown>>;
  readonly evaluations: readonly {
    readonly id: string;
    readonly policy: string;
    readonly observation: unknown;
    readonly expected: Readonly<Record<string, unknown>>;
  }[];
  readonly boundaries: readonly {
    readonly id: string;
    readonly nowUnixMs: string;
    readonly physicalCleanupState: string;
    readonly boundary: unknown;
    readonly expectedDecision: string;
  }[];
  readonly invalid: readonly {
    readonly id: string;
    readonly entrypoint: string;
    readonly policy?: string;
    readonly observation?: unknown;
    readonly evaluation?: string;
    readonly input?: unknown;
    readonly expectedError: SharedStateTimeErrorCodeV1;
  }[];
}

const fixtureUrl = new URL(
  "../fixtures/shared-state-storage/time-v1-golden.json",
  import.meta.url,
);

async function loadFixture(): Promise<GoldenFixture> {
  return JSON.parse(await readFile(fixtureUrl, "utf8")) as GoldenFixture;
}

function expectOk<T>(result: SharedStateTimeResultV1<T>): T {
  if (!result.ok) assert.fail(result.error.code);
  return result.value;
}

function readyTime(nowUnixMs: string): SharedStateTimeEvaluationV1 {
  return expectOk(
    evaluateSharedStateTimeV1(
      {
        kind: V.kinds.policy,
        timeVersion: V.version,
        clockProfile: "sqlite-single-writer",
        clockAuthority: "adapter-controlled",
        observationSource: "adapter-clock",
        timestampUnit: V.timestampUnit,
        integerEncoding: V.integerEncoding,
        backwardSkewToleranceMs: "0",
      },
      {
        kind: V.kinds.observation,
        timeVersion: V.version,
        trustBoundary: V.trustBoundary,
        clockProfile: "sqlite-single-writer",
        clockAuthority: "adapter-controlled",
        observationSource: "adapter-clock",
        observedAtUnixMs: nowUnixMs,
        persistedFloorUnixMs: nowUnixMs,
        minimumExpectedFloorUnixMs: null,
      },
    ),
  );
}

test("golden time evaluations pin floors, tolerance, restart, profiles, and int64 maximum", async () => {
  const fixture = await loadFixture();
  assert.equal(fixture.timeVersion, V.version);
  const observedReasons = new Set<string>();

  for (const vector of fixture.evaluations) {
    const policy = fixture.policies[vector.policy];
    assert.notEqual(policy, undefined, vector.id);
    const evaluation = expectOk(
      evaluateSharedStateTimeV1(policy, vector.observation),
    );
    observedReasons.add(evaluation.reasonCode);
    for (const [field, expected] of Object.entries(vector.expected)) {
      assert.deepEqual(
        evaluation[field as keyof typeof evaluation],
        expected,
        `${vector.id}.${field}`,
      );
    }
  }

  assert.deepEqual(
    [...observedReasons].sort(),
    [...V.evaluationReasonCodes].sort(),
  );

  const beforeClose = fixture.evaluations.find(
    (vector) => vector.id === "restart-before-close",
  );
  const afterReopen = fixture.evaluations.find(
    (vector) => vector.id === "restart-after-reopen",
  );
  assert.ok(beforeClose);
  assert.ok(afterReopen);
  const before = expectOk(
    evaluateSharedStateTimeV1(
      fixture.policies[beforeClose.policy],
      beforeClose.observation,
    ),
  );
  const afterObservation = {
    ...(afterReopen.observation as Record<string, unknown>),
    persistedFloorUnixMs: before.nextPersistedFloorUnixMs,
  };
  const after = expectOk(
    evaluateSharedStateTimeV1(
      fixture.policies[afterReopen.policy],
      afterObservation,
    ),
  );
  assert.equal(after.safe, true);
  if (after.safe) {
    assert.equal(after.effectiveNowUnixMs, before.nextPersistedFloorUnixMs);
  }
});

test("logical boundaries are exact and independent of physical cleanup", async () => {
  const fixture = await loadFixture();
  const decisionsByLogicalInput = new Map<string, string>();

  for (const vector of fixture.boundaries) {
    const time = readyTime(vector.nowUnixMs);
    const decision = expectOk(
      evaluateSharedStateLogicalBoundaryV1(time, vector.boundary),
    );
    assert.equal(decision.decision, vector.expectedDecision, vector.id);

    const logicalKey = JSON.stringify({
      nowUnixMs: vector.nowUnixMs,
      boundary: vector.boundary,
    });
    const previous = decisionsByLogicalInput.get(logicalKey);
    if (previous !== undefined) {
      assert.equal(
        decision.decision,
        previous,
        `${vector.id} cleanup state changed the logical answer`,
      );
    }
    decisionsByLogicalInput.set(logicalKey, decision.decision);
  }

  const cleanupPair = fixture.boundaries.filter((vector) =>
    vector.id.startsWith("replay-expiry-"),
  ).filter((vector) => vector.nowUnixMs === "1000");
  assert.deepEqual(
    new Set(cleanupPair.map((vector) => vector.physicalCleanupState)),
    new Set(["record-present", "record-removed"]),
  );
});

test("golden invalid vectors cover every stable parser/evaluator error code", async () => {
  const fixture = await loadFixture();
  const evaluations = new Map<string, SharedStateTimeEvaluationV1>();
  for (const vector of fixture.evaluations) {
    evaluations.set(
      vector.id,
      expectOk(
        evaluateSharedStateTimeV1(
          fixture.policies[vector.policy],
          vector.observation,
        ),
      ),
    );
  }

  const observedErrors = new Set<SharedStateTimeErrorCodeV1>();
  for (const vector of fixture.invalid) {
    let result: SharedStateTimeResultV1<unknown>;
    switch (vector.entrypoint) {
      case "policy":
        result = parseSharedStateTimePolicyV1(vector.input);
        break;
      case "observation":
        result = parseTrustedSharedStateTimeObservationV1(vector.input);
        break;
      case "evaluate":
        result = evaluateSharedStateTimeV1(
          fixture.policies[vector.policy ?? ""],
          vector.observation,
        );
        break;
      case "boundary":
        result = parseSharedStateLogicalBoundaryV1(vector.input);
        break;
      case "boundary-evaluation": {
        const time = expectOk(
          evaluateSharedStateTimeV1(
            fixture.policies[vector.policy ?? ""],
            vector.observation,
          ),
        );
        result = evaluateSharedStateLogicalBoundaryV1(time, vector.input);
        break;
      }
      case "derive-expiry": {
        const evaluation = evaluations.get(vector.evaluation ?? "");
        assert.ok(evaluation, vector.id);
        result = deriveSharedStateExpiryV1(evaluation, vector.input);
        break;
      }
      default:
        assert.fail(`unknown fixture entrypoint: ${vector.entrypoint}`);
    }
    assert.equal(result.ok, false, vector.id);
    if (result.ok) continue;
    assert.equal(result.error.code, vector.expectedError, vector.id);
    observedErrors.add(result.error.code);
  }

  assert.deepEqual([...observedErrors].sort(), [...V.errorCodes].sort());
});

test("duration derivation is canonical, bounded, and adapter-time based", () => {
  const time = readyTime("1000");
  assert.equal(expectOk(deriveSharedStateExpiryV1(time, "1")), "1001");
  assert.equal(
    expectOk(deriveSharedStateExpiryV1(time, V.limits.maxDurationMs)),
    "31536001000",
  );
});

test("section 6.1 transaction callers cannot inject time contract fields", () => {
  const keyDigest =
    `${STORAGE_V.versions.keyspace}|security.replay.requester-key|` +
    `security.replay|sha256:${"1".repeat(64)}`;
  const nonceDigest =
    `${STORAGE_V.versions.keyspace}|security.replay.nonce|` +
    `security.replay|sha256:${"2".repeat(64)}`;
  const command = {
    kind: STORAGE_V.kinds.transactionCommand,
    contractVersion: STORAGE_V.versions.contract,
    transactionVersion: STORAGE_V.versions.transaction,
    operationVersion: STORAGE_V.versions.operation,
    operation: "consumeReplayNonce",
    input: {
      namespace: "security.replay",
      keyDigest,
      nonceDigest,
      ttlMs: 1000,
    },
  } as const;
  assert.equal(parseSharedStateTransactionCommandV1(command).ok, true);

  const forbiddenClockFields = [
    "nowMs",
    "timestampMs",
    "expiresAtMs",
    "expiresAtUnixMs",
    "leaseExpiresAtUnixMs",
    "observedAtUnixMs",
    "persistedFloorUnixMs",
    "minimumExpectedFloorUnixMs",
    "effectiveNowUnixMs",
    "safeClampUnixMs",
    "eventAtUnixMs",
    "retainUntilUnixMs",
    "backwardSkewToleranceMs",
  ] as const;

  for (const field of forbiddenClockFields) {
    const parsed = parseSharedStateTransactionCommandV1({
      ...command,
      input: {
        ...command.input,
        nestedClockAttempt: {
          [field]: "1000",
        },
      },
    });
    assert.equal(parsed.ok, false, field);
    if (!parsed.ok) {
      assert.equal(parsed.error.code, "caller_clock_forbidden", field);
      assert.deepEqual(parsed.error.path, [
        "input",
        "nestedClockAttempt",
        field,
      ]);
    }
  }
});
