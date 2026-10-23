/**
 * Shared scaffolding for the shared-state conformance harnesses (#2080 step 3).
 *
 * The eight source-only harnesses each grew byte-identical copies of the same
 * helpers (deepFreeze, the seeded LCG shuffle, the bounded-count schema, the
 * conformance error class, the cross-profile time evaluator). This module is
 * now the single definition of each; the harnesses pass only what genuinely
 * differs (their constant objects, the error-code unions, the report shapes).
 *
 * The per-harness `.test.ts` files pin every report schema, so any behavioral
 * drift in these extractions fails the harness tests.
 */
import { z } from "zod";

import {
  SHARED_STATE_STORAGE_V1_VALUES as STORAGE_V,
  digestSharedStateKeyV1,
} from "./shared-state-storage-contract-v1.js";
import {
  SHARED_STATE_TIME_V1_VALUES as TIME_V,
  evaluateSharedStateTimeV1,
  type SharedStateClockProfileV1,
  type SharedStateTimeEvaluationV1,
  type SharedStateTimePolicyV1,
} from "./shared-state-time-v1.js";

/** Structural shape every harness error report shares (zod-pinned per harness). */
export interface SharedStateConformanceErrorReportShapeV1 {
  readonly kind: string;
  readonly errorVersion: 1;
  readonly code: string;
}

/** Recursively freezes plain report/state objects. Byte-identical in 7 harnesses. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

/**
 * Deterministic Fisher-Yates driven by the contract's LCG constants
 * (1_664_525 / 1_013_904_223). Shuffles `order` in place, freezes it, and
 * returns it — exactly what every harness's inline loop did.
 */
export function seededDeterministicShuffleV1<T>(order: T[], seed: number): readonly T[] {
  let state = seed >>> 0;
  for (let index = order.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const other = state % (index + 1);
    [order[index], order[other]] = [order[other]!, order[index]!];
  }
  return Object.freeze(order);
}

/** Count schema bounded by the harness's own operation/transaction limit. */
export function boundedCountSchemaV1(max: number) {
  return z.number().int().nonnegative().max(max);
}

/**
 * The report-carrying conformance error class (publicReport + toJSON), used by
 * six harnesses. The report shape itself stays zod-pinned per harness.
 */
export function createReportConformanceErrorClassV1<Kind extends string, Report extends SharedStateConformanceErrorReportShapeV1>(
  kind: Kind,
): new (code: Report["code"]) => Error & {
  readonly name: Kind;
  readonly code: Report["code"];
  readonly publicReport: Report;
  toJSON(): Report;
} {
  const conformanceError = class extends Error {
    constructor(code: Report["code"]) {
      super(code);
      this.name = kind;
      const self = this as unknown as {
        code: Report["code"];
        publicReport: Report;
      };
      self.code = code;
      self.publicReport = deepFreeze({
        kind,
        errorVersion: 1 as const,
        code,
      }) as unknown as Report;
      this.stack = `${kind}: ${String(code)}`;
    }
    toJSON(): Report {
      return (this as unknown as { publicReport: Report }).publicReport;
    }
  };
  return conformanceError as never;
}

/**
 * The simple conformance error class (no publicReport/toJSON) — the lease
 * harness shape.
 */
export function createSimpleConformanceErrorClassV1<Kind extends string, Code extends string>(
  kind: Kind,
): new (code: Code) => Error & {
  readonly name: Kind;
  readonly code: Code;
} {
  const conformanceError = class extends Error {
    constructor(code: Code) {
      super(code);
      this.name = kind;
      (this as unknown as { code: Code }).code = code;
      this.stack = `${kind}: ${String(code)}`;
    }
  };
  return conformanceError as never;
}

/**
 * The cross-profile time evaluator: derives the policy per clock profile and
 * evaluates the observation under every profile, requiring one common result.
 * The only harness-specific inputs are the backward-skew tolerance and the
 * harness's `fail`.
 */
export function createHarnessTimeEvaluatorV1(options: {
  backwardSkewToleranceMs: number;
  fail: (code: "time_evaluator_mismatch") => never;
}): (observed: bigint, persistedFloor: bigint) => SharedStateTimeEvaluationV1 {
  const { backwardSkewToleranceMs, fail } = options;
  const timePolicyForProfile = (
    clockProfile: SharedStateClockProfileV1,
  ): SharedStateTimePolicyV1 => {
    const requirements = TIME_V.profileRequirements[clockProfile];
    return {
      kind: TIME_V.kinds.policy,
      timeVersion: TIME_V.version,
      clockProfile,
      clockAuthority: requirements.clockAuthority,
      observationSource: requirements.observationSource,
      timestampUnit: TIME_V.timestampUnit,
      integerEncoding: TIME_V.integerEncoding,
      backwardSkewToleranceMs: backwardSkewToleranceMs.toString(),
    };
  };
  const timePolicies = Object.freeze(
    TIME_V.clockProfiles.map(timePolicyForProfile),
  );
  return (observed: bigint, persistedFloor: bigint): SharedStateTimeEvaluationV1 => {
    let commonEvaluation: SharedStateTimeEvaluationV1 | null = null;
    for (const policy of timePolicies) {
      const result = evaluateSharedStateTimeV1(policy, {
        kind: TIME_V.kinds.observation,
        timeVersion: TIME_V.version,
        trustBoundary: TIME_V.trustBoundary,
        clockProfile: policy.clockProfile,
        clockAuthority: policy.clockAuthority,
        observationSource: policy.observationSource,
        observedAtUnixMs: observed.toString(),
        persistedFloorUnixMs: persistedFloor.toString(),
        minimumExpectedFloorUnixMs: persistedFloor.toString(),
      });
      if (!result.ok) return fail("time_evaluator_mismatch");
      if (
        commonEvaluation !== null
        && JSON.stringify(commonEvaluation) !== JSON.stringify(result.value)
      ) {
        return fail("time_evaluator_mismatch");
      }
      commonEvaluation = result.value;
    }
    return commonEvaluation ?? fail("time_evaluator_mismatch");
  };
}

/**
 * The explicit promise barrier shared by the lease, idempotency and outbox
 * harnesses (#2350 A9). Each harness subclasses it, passing only what differs:
 * its own contender limit and its own `fail`.
 */
export class SharedStateConformancePromiseBarrierV1 {
  readonly #expected: number;
  readonly #fail: (code: "barrier_not_ready") => never;
  #arrived = 0;
  #released = false;
  readonly #allArrived: Promise<void>;
  readonly #gate: Promise<void>;
  #resolveAllArrived!: () => void;
  #resolveGate!: () => void;

  constructor(
    expected: number,
    options: {
      readonly maxExpected: number;
      readonly fail: (code: "barrier_not_ready") => never;
    },
  ) {
    const { maxExpected, fail } = options;
    this.#fail = fail;
    if (
      !Number.isSafeInteger(expected)
      || expected <= 0
      || expected > maxExpected
    ) {
      fail("barrier_not_ready");
    }
    this.#expected = expected;
    this.#allArrived = new Promise((resolve) => {
      this.#resolveAllArrived = resolve;
    });
    this.#gate = new Promise((resolve) => {
      this.#resolveGate = resolve;
    });
  }

  async arriveAndWait(): Promise<void> {
    if (this.#released || this.#arrived >= this.#expected) {
      this.#fail("barrier_not_ready");
    }
    this.#arrived += 1;
    if (this.#arrived === this.#expected) this.#resolveAllArrived();
    await this.#gate;
  }

  async waitUntilAllArrived(): Promise<void> {
    await this.#allArrived;
  }

  release(): void {
    if (this.#released || this.#arrived !== this.#expected) {
      this.#fail("barrier_not_ready");
    }
    this.#released = true;
    this.#resolveGate();
  }
}

/**
 * The logical-millisecond fake clock shared by the lease and idempotency
 * harnesses: starts at 0n, advances only by a bounded safe-integer step.
 */
export class SharedStateConformanceLogicalFakeClockV1 {
  readonly #fail: (code: "target_operation_failed") => never;
  #logicalMilliseconds = 0n;

  constructor(fail: (code: "target_operation_failed") => never) {
    this.#fail = fail;
  }

  readLogicalMilliseconds(): bigint {
    return this.#logicalMilliseconds;
  }

  advanceExactlyBy(milliseconds: number): void {
    if (
      !Number.isSafeInteger(milliseconds)
      || milliseconds < 0
      || milliseconds > STORAGE_V.limits.maxDurationMs
    ) {
      this.#fail("target_operation_failed");
    }
    this.#logicalMilliseconds += BigInt(milliseconds);
  }
}

/**
 * The observed-Unix-millisecond fake clock shared by the expiry and
 * restart-continuity harnesses. Harness-owned control, not an adapter clock
 * API; only the initial instant and `fail` are harness-specific.
 */
export class SharedStateConformanceObservedFakeClockV1 {
  readonly #fail: (code: "clock_control_failed") => never;
  #observed: bigint;

  constructor(
    initialInstant: bigint,
    fail: (code: "clock_control_failed") => never,
  ) {
    this.#observed = initialInstant;
    this.#fail = fail;
  }

  readObservedUnixMilliseconds(): bigint {
    return this.#observed;
  }

  advanceExactlyBy(milliseconds: number): void {
    if (
      !Number.isSafeInteger(milliseconds)
      || milliseconds < 0
      || milliseconds > STORAGE_V.limits.maxDurationMs
    ) {
      this.#fail("clock_control_failed");
    }
    this.#observed += BigInt(milliseconds);
  }

  observeExactlyAt(instant: bigint): void {
    if (
      instant < 0n
      || instant > BigInt(TIME_V.limits.maxTimestampUnixMs)
    ) {
      this.#fail("clock_control_failed");
    }
    this.#observed = instant;
  }
}

/** One canonical keyspace component, as every harness generates them. */
export interface SharedStateConformanceKeyComponentV1 {
  readonly field: string;
  readonly type: "utf8" | "uint" | "bytes";
  readonly value: string;
}

/**
 * The keyspace digest helper (byte-identical in the claim-graph, expiry,
 * partition and restart-continuity harnesses): digests under the storage V1
 * keyspace version and maps any rejection to `invalid_generated_command`.
 */
export function createConformanceKeyDigestV1<Domain extends string>(
  fail: (code: "invalid_generated_command") => never,
): (
  domain: Domain,
  namespace: string,
  components: readonly SharedStateConformanceKeyComponentV1[],
) => string {
  return (domain, namespace, components) => {
    const parsed = digestSharedStateKeyV1({
      keyspaceVersion: STORAGE_V.versions.keyspace,
      domain,
      namespace,
      components,
    });
    if (!parsed.ok) return fail("invalid_generated_command");
    return parsed.value.digest;
  };
}
