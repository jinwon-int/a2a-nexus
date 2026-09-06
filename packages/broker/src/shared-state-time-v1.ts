/**
 * Backend-neutral parser and evaluator for `a2a.shared-state.time/v1`.
 *
 * This module never reads a clock. A later adapter may call the trusted
 * observation parser only at its internal clock-authority boundary. Broker
 * transaction callers cannot select `now` through this surface.
 */

import { SHARED_STATE_TIME_V1_VALUES as V } from "./shared-state-time-v1-values.js";
import { isRecord } from "./core/value-guards.js";

export { SHARED_STATE_TIME_V1_VALUES } from "./shared-state-time-v1-values.js";

export type SharedStateClockProfileV1 = (typeof V.clockProfiles)[number];
export type SharedStateClockAuthorityV1 =
  (typeof V.clockAuthorities)[number];
export type SharedStateClockObservationSourceV1 =
  (typeof V.observationSources)[number];
export type SharedStateTimeEvaluationReasonCodeV1 =
  (typeof V.evaluationReasonCodes)[number];
export type SharedStateTimeErrorCodeV1 = (typeof V.errorCodes)[number];
export type SharedStateLogicalBoundaryKindV1 =
  (typeof V.boundaryKinds)[number];

export interface SharedStateTimeErrorV1 {
  readonly code: SharedStateTimeErrorCodeV1;
  readonly path: readonly (string | number)[];
}

export type SharedStateTimeResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SharedStateTimeErrorV1 };

export interface SharedStateTimePolicyV1 {
  readonly kind: typeof V.kinds.policy;
  readonly timeVersion: typeof V.version;
  readonly clockProfile: SharedStateClockProfileV1;
  readonly clockAuthority: SharedStateClockAuthorityV1;
  readonly observationSource: SharedStateClockObservationSourceV1;
  readonly timestampUnit: typeof V.timestampUnit;
  readonly integerEncoding: typeof V.integerEncoding;
  readonly backwardSkewToleranceMs: string;
}

/**
 * Adapter-internal input. The literal trust boundary and profile-bound source
 * are provenance declarations; they do not make caller-supplied data trusted.
 * Section 6.1 transaction parsers separately reject these clock fields.
 */
export interface TrustedSharedStateTimeObservationV1 {
  readonly kind: typeof V.kinds.observation;
  readonly timeVersion: typeof V.version;
  readonly trustBoundary: typeof V.trustBoundary;
  readonly clockProfile: SharedStateClockProfileV1;
  readonly clockAuthority: SharedStateClockAuthorityV1;
  readonly observationSource: SharedStateClockObservationSourceV1;
  readonly observedAtUnixMs: string;
  readonly persistedFloorUnixMs: string;
  /**
   * The greatest floor already observed in this adapter lifecycle. It is null
   * only for the first evaluation after open/reopen.
   */
  readonly minimumExpectedFloorUnixMs: string | null;
}

interface SharedStateReadyTimeEvaluationV1 {
  readonly safe: true;
  readonly reasonCode:
    | "observation_advanced"
    | "observation_at_floor"
    | "backward_within_tolerance_clamped";
  readonly readiness: "ready";
  readonly writes: "allowed";
  readonly logicalDecisions: "allowed";
  readonly observedAtUnixMs: string;
  readonly priorPersistedFloorUnixMs: string;
  readonly effectiveNowUnixMs: string;
  readonly nextPersistedFloorUnixMs: string;
  readonly floorWriteRequired: boolean;
}

interface SharedStateUnsafeTimeEvaluationV1 {
  readonly safe: false;
  readonly reasonCode:
    | "backward_beyond_tolerance"
    | "stored_floor_regression";
  readonly readiness: "not-ready";
  readonly writes: "forbidden";
  readonly logicalDecisions: "forbidden";
  readonly observedAtUnixMs: string;
  readonly priorPersistedFloorUnixMs: string;
  /**
   * A non-decreasing diagnostic clamp only. Logical decisions are forbidden
   * for unsafe evaluations.
   */
  readonly safeClampUnixMs: string;
  readonly nextPersistedFloorUnixMs: string;
  readonly floorWriteRequired: false;
}

export type SharedStateTimeEvaluationV1 =
  | SharedStateReadyTimeEvaluationV1
  | SharedStateUnsafeTimeEvaluationV1;

export interface SharedStateExpiryBoundaryV1 {
  readonly timeVersion: typeof V.version;
  readonly kind:
    | "replay-ttl"
    | "lease"
    | "idempotency-explicit-retention";
  readonly expiresAtUnixMs: string;
}

export interface SharedStateRateWindowBoundaryV1 {
  readonly timeVersion: typeof V.version;
  readonly kind: "rate-window-entry";
  readonly eventAtUnixMs: string;
  readonly windowMs: string;
}

export type SharedStateLogicalBoundaryV1 =
  | SharedStateExpiryBoundaryV1
  | SharedStateRateWindowBoundaryV1;

export type SharedStateLogicalBoundaryDecisionV1 =
  | {
      readonly kind: SharedStateExpiryBoundaryV1["kind"];
      readonly rule: typeof V.boundaryRules.expiry;
      readonly decision: (typeof V.expiryDecisions)[number];
    }
  | {
      readonly kind: SharedStateRateWindowBoundaryV1["kind"];
      readonly rule: typeof V.boundaryRules.rateWindow;
      readonly decision: (typeof V.rateWindowDecisions)[number];
    };

type RecordValue = Record<string, unknown>;

const POLICY_FIELDS = [
  "kind",
  "timeVersion",
  "clockProfile",
  "clockAuthority",
  "observationSource",
  "timestampUnit",
  "integerEncoding",
  "backwardSkewToleranceMs",
] as const;
const OBSERVATION_FIELDS = [
  "kind",
  "timeVersion",
  "trustBoundary",
  "clockProfile",
  "clockAuthority",
  "observationSource",
  "observedAtUnixMs",
  "persistedFloorUnixMs",
  "minimumExpectedFloorUnixMs",
] as const;
const EXPIRY_BOUNDARY_FIELDS = [
  "timeVersion",
  "kind",
  "expiresAtUnixMs",
] as const;
const RATE_BOUNDARY_FIELDS = [
  "timeVersion",
  "kind",
  "eventAtUnixMs",
  "windowMs",
] as const;
const CANONICAL_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const MAX_TIMESTAMP = BigInt(V.limits.maxTimestampUnixMs);
const MAX_DURATION = BigInt(V.limits.maxDurationMs);
const MAX_TOLERANCE = BigInt(V.limits.maxBackwardSkewToleranceMs);

function errorResult<T>(
  code: SharedStateTimeErrorCodeV1,
  path: readonly (string | number)[] = [],
): SharedStateTimeResultV1<T> {
  return {
    ok: false,
    error: Object.freeze({ code, path: Object.freeze([...path]) }),
  };
}

function firstUnknownField(
  value: RecordValue,
  allowed: readonly string[],
): string | null {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key)).sort()[0] ?? null;
}

function checkEnvelope(
  input: unknown,
  fields: readonly string[],
): SharedStateTimeResultV1<RecordValue> {
  if (!isRecord(input)) return errorResult("invalid_type");
  const unknown = firstUnknownField(input, fields);
  if (unknown !== null) return errorResult("unknown_field", [unknown]);
  if (typeof input.timeVersion !== "string") {
    return errorResult("invalid_type", ["timeVersion"]);
  }
  if (input.timeVersion !== V.version) {
    return errorResult("unknown_time_version", ["timeVersion"]);
  }
  return { ok: true, value: input };
}

function parseProfile(
  value: unknown,
  path: readonly (string | number)[],
): SharedStateTimeResultV1<SharedStateClockProfileV1> {
  if (typeof value !== "string") return errorResult("invalid_type", path);
  if (!V.clockProfiles.includes(value as SharedStateClockProfileV1)) {
    return errorResult("unknown_clock_profile", path);
  }
  return { ok: true, value: value as SharedStateClockProfileV1 };
}

function parseCanonicalInteger(
  value: unknown,
  path: readonly (string | number)[],
  maximum: bigint,
): SharedStateTimeResultV1<{ canonical: string; integer: bigint }> {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return errorResult("unsafe_integer", path);
    return errorResult("invalid_integer", path);
  }
  if (typeof value !== "string") return errorResult("invalid_type", path);
  if (!CANONICAL_DECIMAL_PATTERN.test(value)) {
    return errorResult("invalid_integer", path);
  }
  const integer = BigInt(value);
  if (integer > maximum) return errorResult("integer_overflow", path);
  return { ok: true, value: { canonical: value, integer } };
}

function checkProfileRequirements(
  input: RecordValue,
  profile: SharedStateClockProfileV1,
): SharedStateTimeResultV1<true> {
  const required = V.profileRequirements[profile];
  if (typeof input.clockAuthority !== "string") {
    return errorResult("invalid_type", ["clockAuthority"]);
  }
  if (input.clockAuthority !== required.clockAuthority) {
    return errorResult("clock_authority_mismatch", ["clockAuthority"]);
  }
  if (typeof input.observationSource !== "string") {
    return errorResult("invalid_type", ["observationSource"]);
  }
  if (input.observationSource !== required.observationSource) {
    return errorResult("observation_source_mismatch", ["observationSource"]);
  }
  return { ok: true, value: true };
}

export function parseSharedStateTimePolicyV1(
  input: unknown,
): SharedStateTimeResultV1<SharedStateTimePolicyV1> {
  const envelope = checkEnvelope(input, POLICY_FIELDS);
  if (!envelope.ok) return envelope;
  const value = envelope.value;
  if (value.kind !== V.kinds.policy) {
    return errorResult("invalid_discriminant", ["kind"]);
  }
  const profile = parseProfile(value.clockProfile, ["clockProfile"]);
  if (!profile.ok) return profile;
  const profileCheck = checkProfileRequirements(value, profile.value);
  if (!profileCheck.ok) return profileCheck;
  if (value.timestampUnit !== V.timestampUnit) {
    return errorResult(
      typeof value.timestampUnit === "string" ? "unit_mismatch" : "invalid_type",
      ["timestampUnit"],
    );
  }
  if (value.integerEncoding !== V.integerEncoding) {
    return errorResult(
      typeof value.integerEncoding === "string"
        ? "integer_encoding_mismatch"
        : "invalid_type",
      ["integerEncoding"],
    );
  }
  const tolerance = parseCanonicalInteger(
    value.backwardSkewToleranceMs,
    ["backwardSkewToleranceMs"],
    MAX_TIMESTAMP,
  );
  if (!tolerance.ok) return tolerance;
  if (tolerance.value.integer > MAX_TOLERANCE) {
    return errorResult("tolerance_out_of_range", ["backwardSkewToleranceMs"]);
  }

  return {
    ok: true,
    value: Object.freeze({
      kind: V.kinds.policy,
      timeVersion: V.version,
      clockProfile: profile.value,
      clockAuthority: V.profileRequirements[profile.value].clockAuthority,
      observationSource: V.profileRequirements[profile.value].observationSource,
      timestampUnit: V.timestampUnit,
      integerEncoding: V.integerEncoding,
      backwardSkewToleranceMs: tolerance.value.canonical,
    }),
  };
}

export function parseTrustedSharedStateTimeObservationV1(
  input: unknown,
): SharedStateTimeResultV1<TrustedSharedStateTimeObservationV1> {
  const envelope = checkEnvelope(input, OBSERVATION_FIELDS);
  if (!envelope.ok) return envelope;
  const value = envelope.value;
  if (value.kind !== V.kinds.observation) {
    return errorResult("invalid_discriminant", ["kind"]);
  }
  if (value.trustBoundary !== V.trustBoundary) {
    return errorResult("invalid_discriminant", ["trustBoundary"]);
  }
  const profile = parseProfile(value.clockProfile, ["clockProfile"]);
  if (!profile.ok) return profile;
  const profileCheck = checkProfileRequirements(value, profile.value);
  if (!profileCheck.ok) return profileCheck;
  const observed = parseCanonicalInteger(
    value.observedAtUnixMs,
    ["observedAtUnixMs"],
    MAX_TIMESTAMP,
  );
  if (!observed.ok) return observed;
  const persisted = parseCanonicalInteger(
    value.persistedFloorUnixMs,
    ["persistedFloorUnixMs"],
    MAX_TIMESTAMP,
  );
  if (!persisted.ok) return persisted;

  let minimumExpected: string | null = null;
  if (value.minimumExpectedFloorUnixMs !== null) {
    const parsed = parseCanonicalInteger(
      value.minimumExpectedFloorUnixMs,
      ["minimumExpectedFloorUnixMs"],
      MAX_TIMESTAMP,
    );
    if (!parsed.ok) return parsed;
    minimumExpected = parsed.value.canonical;
  }

  return {
    ok: true,
    value: Object.freeze({
      kind: V.kinds.observation,
      timeVersion: V.version,
      trustBoundary: V.trustBoundary,
      clockProfile: profile.value,
      clockAuthority: V.profileRequirements[profile.value].clockAuthority,
      observationSource: V.profileRequirements[profile.value].observationSource,
      observedAtUnixMs: observed.value.canonical,
      persistedFloorUnixMs: persisted.value.canonical,
      minimumExpectedFloorUnixMs: minimumExpected,
    }),
  };
}

export function evaluateSharedStateTimeV1(
  policyInput: unknown,
  observationInput: unknown,
): SharedStateTimeResultV1<SharedStateTimeEvaluationV1> {
  const policy = parseSharedStateTimePolicyV1(policyInput);
  if (!policy.ok) {
    return errorResult(policy.error.code, ["policy", ...policy.error.path]);
  }
  const observation =
    parseTrustedSharedStateTimeObservationV1(observationInput);
  if (!observation.ok) {
    return errorResult(
      observation.error.code,
      ["observation", ...observation.error.path],
    );
  }
  if (policy.value.clockProfile !== observation.value.clockProfile) {
    return errorResult("profile_mismatch", ["observation", "clockProfile"]);
  }

  const observed = BigInt(observation.value.observedAtUnixMs);
  const persisted = BigInt(observation.value.persistedFloorUnixMs);
  const minimumExpected =
    observation.value.minimumExpectedFloorUnixMs === null
      ? null
      : BigInt(observation.value.minimumExpectedFloorUnixMs);
  const tolerance = BigInt(policy.value.backwardSkewToleranceMs);
  const common = {
    observedAtUnixMs: observation.value.observedAtUnixMs,
    priorPersistedFloorUnixMs: observation.value.persistedFloorUnixMs,
  } as const;

  if (minimumExpected !== null && persisted < minimumExpected) {
    const safeClampUnixMs = minimumExpected.toString();
    return {
      ok: true,
      value: Object.freeze({
        safe: false,
        reasonCode: "stored_floor_regression",
        readiness: "not-ready",
        writes: "forbidden",
        logicalDecisions: "forbidden",
        ...common,
        safeClampUnixMs,
        nextPersistedFloorUnixMs: safeClampUnixMs,
        floorWriteRequired: false,
      }),
    };
  }

  if (observed > persisted) {
    return {
      ok: true,
      value: Object.freeze({
        safe: true,
        reasonCode: "observation_advanced",
        readiness: "ready",
        writes: "allowed",
        logicalDecisions: "allowed",
        ...common,
        effectiveNowUnixMs: observation.value.observedAtUnixMs,
        nextPersistedFloorUnixMs: observation.value.observedAtUnixMs,
        floorWriteRequired: true,
      }),
    };
  }

  if (observed === persisted) {
    return {
      ok: true,
      value: Object.freeze({
        safe: true,
        reasonCode: "observation_at_floor",
        readiness: "ready",
        writes: "allowed",
        logicalDecisions: "allowed",
        ...common,
        effectiveNowUnixMs: observation.value.persistedFloorUnixMs,
        nextPersistedFloorUnixMs: observation.value.persistedFloorUnixMs,
        floorWriteRequired: false,
      }),
    };
  }

  if (persisted - observed <= tolerance) {
    return {
      ok: true,
      value: Object.freeze({
        safe: true,
        reasonCode: "backward_within_tolerance_clamped",
        readiness: "ready",
        writes: "allowed",
        logicalDecisions: "allowed",
        ...common,
        effectiveNowUnixMs: observation.value.persistedFloorUnixMs,
        nextPersistedFloorUnixMs: observation.value.persistedFloorUnixMs,
        floorWriteRequired: false,
      }),
    };
  }

  return {
    ok: true,
    value: Object.freeze({
      safe: false,
      reasonCode: "backward_beyond_tolerance",
      readiness: "not-ready",
      writes: "forbidden",
      logicalDecisions: "forbidden",
      ...common,
      safeClampUnixMs: observation.value.persistedFloorUnixMs,
      nextPersistedFloorUnixMs: observation.value.persistedFloorUnixMs,
      floorWriteRequired: false,
    }),
  };
}

export function parseSharedStateLogicalBoundaryV1(
  input: unknown,
): SharedStateTimeResultV1<SharedStateLogicalBoundaryV1> {
  if (!isRecord(input)) return errorResult("invalid_type");
  const kind = input.kind;
  if (
    typeof kind !== "string" ||
    !V.boundaryKinds.includes(kind as SharedStateLogicalBoundaryKindV1)
  ) {
    return errorResult("invalid_discriminant", ["kind"]);
  }
  const fields =
    kind === "rate-window-entry"
      ? RATE_BOUNDARY_FIELDS
      : EXPIRY_BOUNDARY_FIELDS;
  const envelope = checkEnvelope(input, fields);
  if (!envelope.ok) return envelope;

  if (kind === "rate-window-entry") {
    const eventAt = parseCanonicalInteger(
      input.eventAtUnixMs,
      ["eventAtUnixMs"],
      MAX_TIMESTAMP,
    );
    if (!eventAt.ok) return eventAt;
    const window = parseCanonicalInteger(
      input.windowMs,
      ["windowMs"],
      MAX_TIMESTAMP,
    );
    if (!window.ok) return window;
    if (window.value.integer === 0n || window.value.integer > MAX_DURATION) {
      return errorResult("duration_out_of_range", ["windowMs"]);
    }
    return {
      ok: true,
      value: Object.freeze({
        timeVersion: V.version,
        kind,
        eventAtUnixMs: eventAt.value.canonical,
        windowMs: window.value.canonical,
      }),
    };
  }

  const expiresAt = parseCanonicalInteger(
    input.expiresAtUnixMs,
    ["expiresAtUnixMs"],
    MAX_TIMESTAMP,
  );
  if (!expiresAt.ok) return expiresAt;
  const expiryKind = kind as SharedStateExpiryBoundaryV1["kind"];
  return {
    ok: true,
    value: Object.freeze({
      timeVersion: V.version,
      kind: expiryKind,
      expiresAtUnixMs: expiresAt.value.canonical,
    }),
  };
}

export function evaluateSharedStateLogicalBoundaryV1(
  time: SharedStateTimeEvaluationV1,
  boundaryInput: unknown,
): SharedStateTimeResultV1<SharedStateLogicalBoundaryDecisionV1> {
  if (!time.safe || time.logicalDecisions !== "allowed") {
    return errorResult("time_not_ready", ["time"]);
  }
  const boundary = parseSharedStateLogicalBoundaryV1(boundaryInput);
  if (!boundary.ok) return boundary;
  const now = BigInt(time.effectiveNowUnixMs);

  if (boundary.value.kind === "rate-window-entry") {
    const eventAt = BigInt(boundary.value.eventAtUnixMs);
    const window = BigInt(boundary.value.windowMs);
    const counted = window > now || eventAt > now - window;
    return {
      ok: true,
      value: Object.freeze({
        kind: boundary.value.kind,
        rule: V.boundaryRules.rateWindow,
        decision: counted ? "counted" : "excluded",
      }),
    };
  }

  return {
    ok: true,
    value: Object.freeze({
      kind: boundary.value.kind,
      rule: V.boundaryRules.expiry,
      decision:
        now < BigInt(boundary.value.expiresAtUnixMs) ? "active" : "expired",
    }),
  };
}

/**
 * Derives a persisted absolute expiry from a ready trusted-time evaluation.
 * The caller supplies only a duration; the absolute transaction time remains
 * adapter-controlled.
 */
export function deriveSharedStateExpiryV1(
  time: SharedStateTimeEvaluationV1,
  durationInput: unknown,
): SharedStateTimeResultV1<string> {
  if (!time.safe || time.logicalDecisions !== "allowed") {
    return errorResult("time_not_ready", ["time"]);
  }
  const duration = parseCanonicalInteger(
    durationInput,
    ["durationMs"],
    MAX_TIMESTAMP,
  );
  if (!duration.ok) return duration;
  if (
    duration.value.integer === 0n ||
    duration.value.integer > MAX_DURATION
  ) {
    return errorResult("duration_out_of_range", ["durationMs"]);
  }
  const expiresAt = BigInt(time.effectiveNowUnixMs) + duration.value.integer;
  if (expiresAt > MAX_TIMESTAMP) {
    return errorResult("time_arithmetic_overflow", ["durationMs"]);
  }
  return { ok: true, value: expiresAt.toString() };
}
