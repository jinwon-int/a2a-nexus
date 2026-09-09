/**
 * Startup state-source checks for spec section 7.1 step 2 (#1504 §4): before
 * serving, the broker must validate the version, capability, schema, and clock
 * of the durable state it is about to open. This module holds the closed code
 * vocabulary and the pure evaluators; the call sites are the
 * `SqliteBrokerStateStore` constructor (version/clock, before any schema
 * mutation), the JSON snapshot parser (envelope version bound), and
 * `createBrokerServer` (grade↔backend capability).
 *
 * Scope honesty: these checks govern the CURRENT serving stores
 * (`legacy-process` backend class, `broker_metadata`/snapshot version axes).
 * They do not claim `SharedStateStorageAdapterV1` conformance, do not open the
 * worker-lane V1 adapter, and do not add a durable time floor to a store that
 * has no floor contract. The clock tolerance is the maximum of the section 4.2
 * declared backward-skew range (300000 ms) applied as a one-shot startup
 * observation, not the V1 per-observation floor protocol.
 *
 * Pure module: no clock reads, no I/O, no environment access. Inputs arrive
 * already observed so the failure decision is testable without a database.
 */

/** Closed failure vocabulary — stable codes, safe to match in ops tooling. */
export const SHARED_STATE_STARTUP_CHECK_CODES_V1 = Object.freeze([
  "schema_version_newer",
  "state_version_newer",
  "grade_backend_mismatch",
  "clock_backward_beyond_tolerance",
] as const);

export type SharedStateStartupCheckCodeV1 =
  (typeof SHARED_STATE_STARTUP_CHECK_CODES_V1)[number];

export interface SharedStateStartupCheckFailureV1 {
  readonly code: SharedStateStartupCheckCodeV1;
  /** Operator-readable detail; carries observed vs known values, never secrets. */
  readonly detail: string;
}

/**
 * Maximum backward-skew the startup clock observation tolerates. This is the
 * top of the section 4.2 declared tolerance range (0..300000 ms); the current
 * store has no declared per-deployment tolerance, so the spec maximum is the
 * only defensible bound without inventing configuration.
 */
export const STARTUP_CLOCK_BACKWARD_TOLERANCE_MS = 300_000;

function fail(code: SharedStateStartupCheckCodeV1, detail: string): SharedStateStartupCheckFailureV1 {
  return { code, detail };
}

/**
 * A persisted version marker is openable when it is absent (fresh store or
 * pre-versioning database), equal to a known version, or older than it — the
 * in-place forward path (CREATE IF NOT EXISTS + ensureColumn + snapshot import)
 * stays the sanctioned upgrade. A GREATER or unparsable marker means the state
 * was written by a different (newer or tampered) schema this binary cannot
 * honestly interpret, and opening it would both misread rows and silently
 * rewrite the marker downward.
 */
function evaluatePersistedVersionV1(input: {
  code: SharedStateStartupCheckCodeV1;
  label: string;
  observed: string | number | null | undefined;
  known: number;
}): SharedStateStartupCheckFailureV1 | undefined {
  const { code, label, observed, known } = input;
  if (observed === undefined || observed === null || observed === "") {
    return undefined;
  }
  const parsed = typeof observed === "number" ? observed : Number(observed);
  if (!Number.isFinite(parsed)) {
    return fail(code, `${label} metadata is present but not a version number: ${JSON.stringify(observed)} (this binary opens ${known})`);
  }
  if (parsed > known) {
    return fail(code, `${label} metadata ${parsed} is newer than this binary opens (${known}); downgrade refused to avoid misreading newer rows and rewriting the marker`);
  }
  return undefined;
}

/** `schema_version` metadata from `broker_metadata` vs this binary's schema. */
export function evaluatePersistedSchemaVersionV1(input: {
  observed: string | number | null | undefined;
  known: number;
}): SharedStateStartupCheckFailureV1 | undefined {
  return evaluatePersistedVersionV1({ ...input, code: "schema_version_newer", label: "schema_version" });
}

/** `state_version` metadata / snapshot envelope version vs this binary's version. */
export function evaluatePersistedStateVersionV1(input: {
  observed: string | number | null | undefined;
  known: number;
}): SharedStateStartupCheckFailureV1 | undefined {
  return evaluatePersistedVersionV1({ ...input, code: "state_version_newer", label: "state_version" });
}

/**
 * The configured deployment grade promises a state-source capability. Section 3
 * defines `single-writer-durable` as exactly one logical SQLite writer, so it
 * must not be served by a non-SQLite backend. Applies only when the store comes
 * from configuration; an injected `options.stateStore` bypasses backend
 * resolution entirely, so there is no configured value to cross-check.
 */
export function evaluateGradeBackendCapabilityV1(input: {
  configuredGrade: string;
  backend: "json-file" | "sqlite";
}): SharedStateStartupCheckFailureV1 | undefined {
  const { configuredGrade, backend } = input;
  if (configuredGrade === "single-writer-durable" && backend !== "sqlite") {
    return fail(
      "grade_backend_mismatch",
      `configured grade single-writer-durable requires the sqlite persistence backend, got ${backend}`,
    );
  }
  return undefined;
}

/**
 * One-shot startup clock observation: the last durable write must not be in
 * the future by more than the tolerance. A larger step means the host clock
 * moved backward past the section 4.2 bound since the last persist, so every
 * timestamp this process would write lands before durable history and audit
 * ordering can no longer be trusted. Missing or unparsable markers are not
 * evidence of a backward clock and stay openable (a fresh store has none).
 * Boundary per section 4.2: a step of exactly the tolerance is safe.
 */
export function evaluatePersistedClockV1(input: {
  persistedAtIso: string | null | undefined;
  nowUnixMs: number;
  toleranceMs?: number;
}): SharedStateStartupCheckFailureV1 | undefined {
  const { persistedAtIso, nowUnixMs } = input;
  const toleranceMs = input.toleranceMs ?? STARTUP_CLOCK_BACKWARD_TOLERANCE_MS;
  if (persistedAtIso === undefined || persistedAtIso === null || persistedAtIso === "") {
    return undefined;
  }
  const persistedMs = Date.parse(persistedAtIso);
  if (!Number.isFinite(persistedMs)) {
    return undefined;
  }
  const backwardMs = persistedMs - nowUnixMs;
  if (backwardMs > toleranceMs) {
    return fail(
      "clock_backward_beyond_tolerance",
      `last durable write ${persistedAtIso} is ${backwardMs} ms ahead of the host clock, beyond the ${toleranceMs} ms tolerance; refusing to append backward-dated writes`,
    );
  }
  return undefined;
}
