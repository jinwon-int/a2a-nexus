/**
 * TEST-ONLY conformance control channel for worker-mode V1 SQLite targets.
 *
 * WHY THIS EXISTS. Every Phase 2 conformance harness needs two things the
 * closed lane protocol deliberately cannot carry: out-of-band observation
 * (snapshots, cursors, evidence probes) and fault injection at SQLite statement
 * boundaries. Inline targets get both by holding the `DatabaseSync` themselves.
 * In worker mode the worker owns that connection, so the access has to travel.
 *
 * WHAT THIS IS NOT. It is not an extension of
 * `shared-state-sqlite-worker-protocol-v1.ts`. That protocol stays exactly as
 * decision W0 fixed it — five commands, no test affordance, no arbitrary SQL.
 * These messages ride the same port but are a separate, separately parsed
 * family, and the lane never sees them: the conformance channel filters them
 * out before the lane's `onMessage`. Sending one of these to the production
 * worker entry does nothing, because that entry's runtime cannot correlate a
 * message with no ticket and answers nothing.
 *
 * NO MAIN-THREAD BYPASS. Because observation travels here, a worker-mode target
 * opens no second connection and holds no raw read handle on the main thread.
 * The worker remains the single V1 authority for its file, and this channel
 * does not weaken that: it asks the owning thread to observe, rather than
 * observing behind its back.
 *
 * NO ARBITRARY SQL. The control set is closed and enumerated, exactly like the
 * lane protocol it sits beside. A harness that needs a new probe adds a named
 * control here, which makes the out-of-band access each harness requires an
 * explicit, reviewable list rather than an open channel.
 *
 * ORDERING. Controls and lane requests share one `MessagePort`, and
 * `postMessage` delivery is ordered. That is what makes the harnesses' sync
 * `void` arm/apply methods satisfiable in worker mode: an arm posted before the
 * next lane request is guaranteed to be applied before that request executes,
 * even though the caller cannot await it.
 */
import { z } from "zod";

export const SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1 = Object.freeze({
  kind: "SharedStateSqliteConformanceControlV1",
  controlVersion: 1,
  requestKind: "SharedStateSqliteConformanceRequestV1",
  replyKind: "SharedStateSqliteConformanceReplyV1",
  eventKind: "SharedStateSqliteConformanceEventV1",
  scope: "test-only-worker-mode-conformance",
  extendsLaneProtocol: false,
  carriesArbitrarySql: false,
  usedByProductionEntry: false,
} as const);

/**
 * Where a fault fires relative to the statement it is matched against.
 *
 * - `before-prepare` fires instead of preparing the matched statement, so
 *   nothing is written.
 * - `after-run` prepares and really runs the matched statement, then fires, so
 *   the row exists and the transaction still has to roll back.
 * - `before-exec` fires instead of executing a matched bare statement, which is
 *   how a fault lands immediately before `COMMIT`.
 */
export const SHARED_STATE_SQLITE_CONFORMANCE_FAULT_PHASES_V1 = Object.freeze([
  "before-prepare",
  "after-run",
  "before-exec",
] as const);

export type SharedStateSqliteConformanceFaultPhaseV1 =
  (typeof SHARED_STATE_SQLITE_CONFORMANCE_FAULT_PHASES_V1)[number];

/**
 * A fault plan is computed on the main thread by the target that knows its
 * harness's vocabulary, and executed mechanically in the worker. Keeping the
 * meaning of a fault point out of the worker is what lets one conformance entry
 * serve every harness.
 */
export const sharedStateSqliteConformanceFaultPlanV1Schema = z
  .object({
    point: z.string().min(1).max(96),
    sqlFragment: z.string().min(1).max(512),
    phase: z.enum(SHARED_STATE_SQLITE_CONFORMANCE_FAULT_PHASES_V1),
    /** Section 2.5 needs a point that keeps firing until it is replaced. */
    repeating: z.boolean(),
  })
  .strict();

export type SharedStateSqliteConformanceFaultPlanV1 = z.infer<
  typeof sharedStateSqliteConformanceFaultPlanV1Schema
>;

/**
 * The closed control set. Each entry names one out-of-band capability a harness
 * needs, so this list is the reviewable inventory of everything worker-mode
 * conformance reaches for beyond the lane protocol.
 */
export const SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1 = Object.freeze([
  /** Arms a fault plan. Replaces any armed plan. */
  "armFault",
  /** Clears any armed plan and resets the fired flag. */
  "disarmFault",
  /** Reports whether the armed plan fired, and at which points. */
  "readFaultState",
  /**
   * Sets the instant this worker's own clock will report for later commands.
   *
   * This is not a caller clock field: it does not ride the lane protocol, it is
   * not attached to any command, and the production entry has no such control.
   * It replaces the conformance worker's clock, which that worker still owns
   * and still reads for itself at execution time — the harness needs a
   * deterministic instant because it probes expiry boundaries exactly.
   */
  "setObservedInstant",
  /**
   * Phase 2.6 — performs one named adversarial deletion. The violations are a
   * closed set rather than a table list, so this stays as far from an arbitrary
   * SQL channel as the lane protocol it sits beside.
   */
  "expiryViolation",
  /** Phase 2.6 — builds the conformance snapshot from inside the worker. */
  "expirySnapshot",
  /**
   * Phase 2.6 — reports whether a command is a retained safety replay, and the
   * exact instant an existing replay nonce expires. Capacity shedding and the
   * inclusive-boundary probe both need that read, and the connection it needs
   * belongs to the worker.
   */
  "expirySafetyReplayState",
] as const);

/**
 * The closed set of Phase 2.6 violations a target may ask the worker to commit
 * on its behalf. Each exists so the harness can prove it catches the violation;
 * none is reachable outside a conformance run.
 */
export const SHARED_STATE_SQLITE_EXPIRY_VIOLATIONS_V1 = Object.freeze([
  /** Cleanup physically removes a logically active replay record. */
  "early-eviction-deletes",
  /** Capacity pressure drops unexpired safety records. */
  "pressure-evicts-unexpired",
  /** An implicit TTL silently retires an unacknowledged outbox row. */
  "implicit-ttl-on-outbox",
] as const);

export type SharedStateSqliteExpiryViolationV1 =
  (typeof SHARED_STATE_SQLITE_EXPIRY_VIOLATIONS_V1)[number];

export type SharedStateSqliteConformanceControlNameV1 =
  (typeof SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1)[number];

const sequenceSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,39})$/u);

export const sharedStateSqliteConformanceRequestV1Schema = z
  .object({
    kind: z.literal(
      SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1.requestKind,
    ),
    controlVersion: z.literal(
      SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1.controlVersion,
    ),
    sequence: sequenceSchema,
    control: z.enum(SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1),
    input: z.unknown(),
  })
  .strict();

export type SharedStateSqliteConformanceRequestV1 = z.infer<
  typeof sharedStateSqliteConformanceRequestV1Schema
>;

export const sharedStateSqliteConformanceReplyV1Schema = z
  .object({
    kind: z.literal(SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1.replyKind),
    controlVersion: z.literal(
      SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1.controlVersion,
    ),
    sequence: sequenceSchema,
    control: z.enum(SHARED_STATE_SQLITE_CONFORMANCE_CONTROLS_V1),
    ok: z.boolean(),
    value: z.unknown(),
    failure: z.string().nullable(),
  })
  .strict();

export type SharedStateSqliteConformanceReplyV1 = z.infer<
  typeof sharedStateSqliteConformanceReplyV1Schema
>;

/**
 * Recognises any message belonging to this family. The conformance channel uses
 * it to keep control traffic away from the lane, which would otherwise treat an
 * unrecognised envelope as a crossed response and declare the dispatched ticket
 * ambiguous.
 */
export function isSharedStateSqliteConformanceMessageV1(
  message: unknown,
): boolean {
  if (typeof message !== "object" || message === null) return false;
  const kind = (message as Record<string, unknown>)["kind"];
  return (
    kind === SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1.requestKind
    || kind === SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1.replyKind
    || kind === SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1.eventKind
  );
}

export function parseSharedStateSqliteConformanceRequestV1(
  input: unknown,
): SharedStateSqliteConformanceRequestV1 | null {
  const parsed = sharedStateSqliteConformanceRequestV1Schema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseSharedStateSqliteConformanceReplyV1(
  input: unknown,
): SharedStateSqliteConformanceReplyV1 | null {
  const parsed = sharedStateSqliteConformanceReplyV1Schema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function buildSharedStateSqliteConformanceRequestV1(
  sequence: string,
  control: SharedStateSqliteConformanceControlNameV1,
  input: unknown,
): SharedStateSqliteConformanceRequestV1 {
  return {
    kind: SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1.requestKind,
    controlVersion: SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1.controlVersion,
    sequence,
    control,
    input,
  };
}

export function buildSharedStateSqliteConformanceReplyV1(
  sequence: string,
  control: SharedStateSqliteConformanceControlNameV1,
  outcome:
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly failure: string },
): SharedStateSqliteConformanceReplyV1 {
  return outcome.ok
    ? {
        kind: SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1.replyKind,
        controlVersion:
          SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1.controlVersion,
        sequence,
        control,
        ok: true,
        value: outcome.value,
        failure: null,
      }
    : {
        kind: SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1.replyKind,
        controlVersion:
          SHARED_STATE_SQLITE_CONFORMANCE_CONTROL_V1.controlVersion,
        sequence,
        control,
        ok: false,
        value: null,
        failure: outcome.failure,
      };
}
