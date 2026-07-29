/**
 * Closed vocabulary for `a2a.shared-state.time/v1`.
 *
 * This catalog is backend-neutral and contains no clock reads, configuration,
 * storage, scheduling, or runtime integration.
 */

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

export const SHARED_STATE_TIME_V1_VALUES = deepFreeze({
  version: "a2a.shared-state.time/v1",
  kinds: {
    policy: "SharedStateTimePolicyV1",
    observation: "TrustedSharedStateTimeObservationV1",
  },
  timestampUnit: "unix-epoch-millisecond",
  integerEncoding: "canonical-unsigned-decimal-string",
  trustBoundary: "adapter-internal",
  clockProfiles: [
    "sqlite-single-writer",
    "shared-backend-server",
  ],
  clockAuthorities: [
    "adapter-controlled",
    "backend-server",
  ],
  observationSources: [
    "adapter-clock",
    "backend-server-clock",
  ],
  profileRequirements: {
    "sqlite-single-writer": {
      clockAuthority: "adapter-controlled",
      observationSource: "adapter-clock",
      floorAuthority: "adapter-durable",
    },
    "shared-backend-server": {
      clockAuthority: "backend-server",
      observationSource: "backend-server-clock",
      floorAuthority: "same-backend-linearizable",
    },
  },
  floorAuthorities: [
    "adapter-durable",
    "same-backend-linearizable",
  ],
  evaluationReasonCodes: [
    "observation_advanced",
    "observation_at_floor",
    "backward_within_tolerance_clamped",
    "backward_beyond_tolerance",
    "stored_floor_regression",
  ],
  readinessOutcomes: [
    "ready",
    "not-ready",
  ],
  writeOutcomes: [
    "allowed",
    "forbidden",
  ],
  logicalDecisionOutcomes: [
    "allowed",
    "forbidden",
  ],
  boundaryKinds: [
    "replay-ttl",
    "lease",
    "idempotency-explicit-retention",
    "rate-window-entry",
  ],
  expiryBoundaryKinds: [
    "replay-ttl",
    "lease",
    "idempotency-explicit-retention",
  ],
  expiryDecisions: [
    "active",
    "expired",
  ],
  rateWindowDecisions: [
    "counted",
    "excluded",
  ],
  boundaryRules: {
    expiry: "active-iff-now-lt-expires-at",
    rateWindow: "counted-iff-event-at-gt-now-minus-window",
  },
  errorCodes: [
    "invalid_type",
    "unknown_field",
    "unknown_time_version",
    "invalid_discriminant",
    "unknown_clock_profile",
    "profile_mismatch",
    "clock_authority_mismatch",
    "observation_source_mismatch",
    "unit_mismatch",
    "integer_encoding_mismatch",
    "invalid_integer",
    "unsafe_integer",
    "integer_overflow",
    "tolerance_out_of_range",
    "duration_out_of_range",
    "time_not_ready",
    "time_arithmetic_overflow",
  ],
  limits: {
    /**
     * Signed int64 maximum. This is deliberately narrower than uint64 so the
     * same persisted representation fits common SQLite and shared backends.
     */
    maxTimestampUnixMs: "9223372036854775807",
    maxDurationMs: "31536000000",
    maxBackwardSkewToleranceMs: "300000",
  },
} as const);

export type SharedStateTimeV1Values =
  typeof SHARED_STATE_TIME_V1_VALUES;
