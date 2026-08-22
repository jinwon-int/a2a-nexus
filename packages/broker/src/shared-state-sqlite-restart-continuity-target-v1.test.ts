/**
 * TEST-ONLY Phase 2.4 conformance target backed by the V1 SQLite adapter.
 *
 * Same rule as the Phase 2.7, 2.2, and 2.3 targets: every seam lives here,
 * next to the harness, and never on `SharedStateSqliteAdapterV1`. A snapshot,
 * a crash switch, a cursor, or a reconciliation query on the adapter would be
 * a storage API the contract does not register.
 *
 * This is the first target whose close and reopen are a real restart. The
 * database is a file in a temporary directory, the adapter is handed a
 * `DatabaseSync` rather than owning one, and `close`/`open` release and
 * re-acquire ownership against that same file. Nothing about continuity here
 * is object-state retention.
 *
 * NO fault-point collapse. All four armed points land on distinct real
 * positions:
 *
 * - `before-command-commit` fires as `executeIdempotent` prepares its first
 *   durable write, the outbox link INSERT, so the adapter's own
 *   `BEGIN IMMEDIATE` rolls back with nothing written.
 * - `before-ack-commit` fires at the acknowledgment transaction's COMMIT,
 *   with the updated row staged inside it.
 * - the two `after-*-before-response` points are NOT statement faults. The
 *   transaction genuinely commits and only the answer is lost, which is what
 *   an ambiguous commit is. Phase 2.2 established this shape.
 *
 * The first two match different statements in different commands; the last
 * two are post-commit positions in different commands. Only one fault is ever
 * armed and each is consumed by the single command that follows it.
 *
 * DECLARED SYNTHESIS (owner decision 3). Two values here have no V1
 * counterpart at all, so there is nothing to map them onto and the target
 * produces them:
 *
 * - `leaseMutationCount` has no durable source. `shared_state_lease` carries
 *   seven columns and none of them counts mutations or stores a mutation
 *   digest; `mutateWithFence` writes `resource_version` and nothing else.
 *   Deriving the count from `resource_version` is wrong arithmetic — a claim,
 *   a renewal, and one mutation leave version three and mutation count one.
 *   It is a declared constant zero. This is the INVERSE of the Phase 2.3
 *   `receiptFailedCount`, which is a real query that happens to return zero,
 *   and the descriptor keeps the two in different buckets so a later reader
 *   cannot confuse them.
 * - the backward-clock scenario's `failed`/`unsafe_clock` lifecycle envelope.
 *   V1 evaluates time in exactly one place, inside `transact`; `open`
 *   validates schema, ownership, clock profile, and epoch without consulting
 *   the clock, and its `failed` envelope carries `adapter_unavailable`.
 *
 * The synthesis is cut as narrowly as decision 3 requires. `open` opens the
 * adapter FOR REAL and synthesizes only the envelope, leaving it open. The
 * forbidden write the harness issues next therefore reaches `transact`, whose
 * own time evaluation produces a real rollback, a real `unsafe_clock`
 * unavailable envelope, and a real `failed` state — so the unchanged-snapshot
 * assertions around it are genuine rollback evidence rather than a fixture.
 * Two of that scenario's three facts stay real.
 *
 * ONE counter is collapsed, exactly as Phase 2.2 and 2.3 declared it: V1
 * keeps no durable record of a domain effect separate from the idempotency
 * row it wrote, so `domainEffectCount` is derived from that row count.
 * `idempotentOutboxEffectCount` is NOT collapsed onto it — the outbox link is
 * its own table and its own row.
 *
 * The fault seam intercepts `prepare` AND `exec`, because `COMMIT` is issued
 * through `exec`. Snapshot, cursor, and reconciliation reads use the RAW
 * handle, so a fault armed for a write can never fire while observing state.
 *
 * Two target-specific facts have no precedent and are worth stating:
 *
 * - after a crash fault the harness calls `open` with NO preceding `close`.
 *   The adapter rolls back and stays `ready`, so a bare `open` would answer
 *   `already_open`. The target therefore takes the adapter down itself when a
 *   crash is simulated, which is what a crash is.
 * - `close` must branch on adapter state, because `drain` refuses anything
 *   that is not `ready` and the adapter is `failed` after the forbidden
 *   write.
 *
 * What this does NOT do: check the Phase 2.4 repeat item. That item also
 * requires separately proving authorized runtime/query reconciliation and
 * retention/prune behaviour, which is not this slice.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1,
  SHARED_STATE_RESTART_CONTINUITY_FAULT_POINTS_V1,
  SharedStateRestartContinuityConformanceErrorV1,
  runSharedStateRestartContinuityConformanceV1,
  type SharedStateRestartContinuityConformanceClockV1,
  type SharedStateRestartContinuityConformanceCursorV1,
  type SharedStateRestartContinuityConformanceTargetFactoryV1,
  type SharedStateRestartContinuityConformanceTargetV1,
  type SharedStateRestartContinuityFaultPointV1,
} from "./shared-state-restart-continuity-conformance-v1.js";
import {
  SHARED_STATE_SQLITE_ADAPTER_V1,
  SharedStateSqliteAdapterV1,
} from "./shared-state-sqlite-adapter-v1.js";
import { applySharedStateSqliteSchemaV1 } from "./shared-state-sqlite-schema-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  parseSharedStateStorageLifecycleV1,
  parseSharedStateTransactionResultV1,
  type SharedStateTransactionCommandV1,
} from "./shared-state-storage-contract-v1.js";
import {
  SHARED_STATE_TIME_V1_VALUES as TIME_V,
  evaluateSharedStateTimeV1,
} from "./shared-state-time-v1.js";

/**
 * States what this target is, which fault points are real, and — separately
 * from any collapse — exactly what it synthesizes under owner decision 3. A
 * reader should be able to see both without reading the implementation.
 */
const TEST_ONLY_SQLITE_RESTART_CONTINUITY_TARGET_V1 = Object.freeze({
  label: "test-only-sqlite-restart-continuity-conformance-target",
  production: false,
  sqlite: true,
  shared: false,
  attachedToBrokerRuntime: false,
  adapterApiChanged: false,
  durability: "real-file-backed-close-and-reopen-not-object-state-retention",
  faultSeam: "test-only-database-handle-proxy-not-adapter-api",
  cursorSeam: "test-only-control-not-a-v1-query",
  reconcileSeam: "test-only-control-not-a-v1-query",
  faultPointsArmed: 4,
  durableFaultPositions: 4,
  collapsedFaultPoints: Object.freeze([] as const),
  collapseReason: "none-v1-has-a-real-position-for-every-armed-point",
  countersDerivedFromTheIdempotencyRow: Object.freeze([
    "domainEffectCount",
  ] as const),
  // Owner decision 3. These have no V1 counterpart to map onto; the target
  // produces them and says so. Kept apart from the collapse list above
  // because they are a different category.
  synthesizedValues: Object.freeze([
    "leaseMutationCount",
    "backward-clock-open-lifecycle-envelope",
  ] as const),
  synthesisReason: "v1-has-no-counterpart-declared-under-owner-decision-3",
  // The narrowing decision 3 requires: the adapter really is open, so the
  // write that follows produces a real rollback and a real `unsafe_clock`.
  backwardClockAdapterOpenedForReal: true,
  clockSuppliedBy: "harness-injected-not-target-owned",
  repeatItemChecked: false,
} as const);

const COMMIT_SQL = "COMMIT";
const IDEMPOTENCY_LINK_WRITE_SQL_FRAGMENT =
  "INSERT INTO shared_state_idempotency_outbox_link";

/**
 * Maps each armed crash point onto its real position. The two `before-` points
 * are statements; the two `after-` points are deliberately not, because the
 * transaction has to commit for the answer to be ambiguous.
 */
function triggerFor(
  faultPoint: SharedStateRestartContinuityFaultPointV1,
): { readonly kind: "prepare" | "exec"; readonly fragment: string } | null {
  switch (faultPoint) {
    case "before-command-commit":
      return {
        kind: "prepare",
        fragment: IDEMPOTENCY_LINK_WRITE_SQL_FRAGMENT,
      };
    case "before-ack-commit":
      return { kind: "exec", fragment: COMMIT_SQL };
    case "after-command-commit-before-response":
    case "after-ack-commit-before-response":
      // Not a statement fault: the transaction must genuinely commit and only
      // the response is lost.
      return null;
    default:
      throw new Error(
        `unknown restart fault point: ${String(faultPoint)}`,
      );
  }
}

interface AdversarialSqliteRestartControlV1 {
  /** Accepts the arm request without injecting or simulating anything. */
  readonly skipFaultInjection?: boolean;
  /** Reports an ambiguous commit while rolling the transaction back. */
  readonly ambiguousCommitRollsBack?: boolean;
  /** Reopens onto a fresh database instead of the one just closed. */
  readonly reopenLosesState?: boolean;
  /** Answers the backward-clock open as ready instead of failed. */
  readonly staysReadyOnUnsafeClock?: boolean;
  /** Ignores the cursor floor and replays every event. */
  readonly ignoreReconcileCursor?: boolean;
  /** Counts the outbox link row as a second domain effect. */
  readonly doubleCountDomainEffects?: boolean;
}

interface FaultStateV1 {
  trigger: { readonly kind: "prepare" | "exec"; readonly fragment: string }
    | null;
  fired: boolean;
  firedCount: number;
  readonly firedAt: string[];
}

/**
 * Intercepts statement preparation and direct execution, so a fault can land
 * at a write or at the commit. Nothing here is reachable from the adapter's
 * public surface.
 */
function createFaultInjectingHandleV1(
  db: DatabaseSync,
  state: FaultStateV1,
): DatabaseSync {
  const fire = (kind: string): never => {
    state.firedAt.push(kind);
    state.trigger = null;
    state.fired = true;
    state.firedCount += 1;
    throw new Error("test-only-injected-conformance-fault");
  };
  return new Proxy(db, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === "prepare") {
        return (sql: string): unknown => {
          if (
            state.trigger?.kind === "prepare"
            && sql.includes(state.trigger.fragment)
          ) {
            fire("prepare");
          }
          return target.prepare(sql);
        };
      }
      if (property === "exec") {
        return (sql: string): unknown => {
          if (
            state.trigger?.kind === "exec"
            && sql.includes(state.trigger.fragment)
          ) {
            fire("exec");
          }
          return target.exec(sql);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DatabaseSync;
}

function unavailableResult(operation: string, reasonCode: string): unknown {
  const parsed = parseSharedStateTransactionResultV1({
    kind: V.kinds.transactionResult,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation,
    consistency:
      V.operationConsistency[operation as keyof typeof V.operationConsistency],
    status: "unavailable",
    completeness: "unavailable",
    reasonCode,
  });
  if (!parsed.ok) {
    throw new SharedStateRestartContinuityConformanceErrorV1(
      "invalid_target_result",
    );
  }
  return parsed.value;
}

/**
 * The one synthesized lifecycle envelope, built through the contract parser so
 * it cannot drift from the shape a real one has.
 */
function synthesizedLifecycle(
  state: string,
  reasonCodes: readonly string[],
): unknown {
  const parsed = parseSharedStateStorageLifecycleV1({
    kind: V.kinds.lifecycle,
    lifecycleVersion: V.versions.lifecycle,
    contractVersion: V.versions.contract,
    state,
    reasonCodes,
  });
  if (!parsed.ok) {
    throw new SharedStateRestartContinuityConformanceErrorV1(
      "invalid_target_lifecycle",
    );
  }
  return parsed.value;
}

interface OutboxStateRowV1 {
  readonly stream_key_digest: string;
  readonly stream_sequence: string;
  readonly receipt_state: string;
  readonly acknowledgment_state: string;
}

class SqliteRestartContinuityConformanceTargetV1
implements SharedStateRestartContinuityConformanceTargetV1 {
  #adapter: SharedStateSqliteAdapterV1;
  #reads: DatabaseSync;
  readonly #fault: FaultStateV1;
  readonly #adversarial: AdversarialSqliteRestartControlV1;
  readonly #clock: SharedStateRestartContinuityConformanceClockV1;
  readonly #ownerToken: string;
  readonly #toleranceMs: string;
  /** Armed post-commit crash point, if any. Consumed by one command. */
  #armedAmbiguousCommit: SharedStateRestartContinuityFaultPointV1 | null =
    null;

  constructor(input: {
    readonly adapter: SharedStateSqliteAdapterV1;
    readonly reads: DatabaseSync;
    readonly fault: FaultStateV1;
    readonly adversarial: AdversarialSqliteRestartControlV1;
    readonly clock: SharedStateRestartContinuityConformanceClockV1;
    readonly ownerToken: string;
    readonly toleranceMs: string;
  }) {
    this.#adapter = input.adapter;
    this.#reads = input.reads;
    this.#fault = input.fault;
    this.#adversarial = input.adversarial;
    this.#clock = input.clock;
    this.#ownerToken = input.ownerToken;
    this.#toleranceMs = input.toleranceMs;
  }

  #observed(): string {
    // The harness owns the clock. Passing the injected instant through
    // verbatim is required, not stylistic: the adapter derives
    // `expiresInMs` and `resetInMs` from it and the harness asserts both.
    return this.#clock.readObservedUnixMilliseconds().toString();
  }

  /**
   * Reads the persisted floor and evaluates it exactly as `transact` would.
   * This is the synthesis decision 3 permits, and it is used only to shape the
   * lifecycle answer — the adapter is still opened for real below.
   */
  #clockIsUnsafe(): boolean {
    const row = this.#reads
      .prepare(
        `SELECT persisted_floor_unix_ms FROM shared_state_clock_floor
          WHERE id = 1`,
      )
      .get() as { readonly persisted_floor_unix_ms: string } | undefined;
    if (row === undefined) return false;
    const profile = SHARED_STATE_SQLITE_ADAPTER_V1.clockProfile;
    const requirements = TIME_V.profileRequirements[profile];
    const evaluation = evaluateSharedStateTimeV1(
      {
        kind: TIME_V.kinds.policy,
        timeVersion: TIME_V.version,
        clockProfile: profile,
        clockAuthority: requirements.clockAuthority,
        observationSource: requirements.observationSource,
        timestampUnit: TIME_V.timestampUnit,
        integerEncoding: TIME_V.integerEncoding,
        backwardSkewToleranceMs: this.#toleranceMs,
      },
      {
        kind: TIME_V.kinds.observation,
        timeVersion: TIME_V.version,
        trustBoundary: TIME_V.trustBoundary,
        clockProfile: profile,
        clockAuthority: requirements.clockAuthority,
        observationSource: requirements.observationSource,
        observedAtUnixMs: this.#observed(),
        persistedFloorUnixMs: row.persisted_floor_unix_ms,
        // A fresh lifecycle has observed nothing yet, exactly as the adapter
        // resets its own expectation on open.
        minimumExpectedFloorUnixMs: null,
      },
    );
    return !evaluation.ok || !evaluation.value.safe;
  }

  async open(): Promise<unknown> {
    const opened = this.#adapter.open();
    if (!opened.ok) throw new Error(`adapter open refused: ${opened.error}`);
    if (
      this.#clockIsUnsafe()
      && this.#adversarial.staysReadyOnUnsafeClock !== true
    ) {
      // Declared synthesis, narrowed: the adapter is genuinely open, so the
      // forbidden write that follows reaches it and rolls back for real.
      return synthesizedLifecycle("failed", ["unsafe_clock"]);
    }
    return opened.value;
  }

  async close(): Promise<unknown> {
    // `drain` refuses anything that is not `ready`, and the adapter is
    // `failed` after the forbidden write, so this has to branch.
    const lifecycle = this.#adapter.lifecycle();
    if (lifecycle?.state === "ready") {
      const drained = this.#adapter.drain();
      if (!drained.ok) {
        throw new Error(`adapter drain refused: ${drained.error}`);
      }
    }
    const closed = this.#adapter.close();
    if (!closed.ok) throw new Error(`adapter close refused: ${closed.error}`);
    if (this.#adversarial.reopenLosesState === true) {
      // Violation: the reopened adapter is bound to a fresh database, so
      // everything committed before the close is silently gone.
      const directory = mkdtempSync(
        join(tmpdir(), "shared-state-restart-target-v1-lost-"),
      );
      const fresh = new DatabaseSync(join(directory, "v1.db"));
      assert.equal(applySharedStateSqliteSchemaV1(fresh).ok, true);
      this.#adapter = new SharedStateSqliteAdapterV1({
        db: fresh,
        ownerToken: this.#ownerToken,
        backwardSkewToleranceMs: this.#toleranceMs,
      });
      // The observation surface has to move with the adapter, or the loss
      // would be invisible to the snapshot and this control would pass.
      this.#reads = fresh;
    }
    return closed.value;
  }

  armConformanceCrashFault(
    faultPoint: SharedStateRestartContinuityFaultPointV1,
  ): void {
    if (
      !SHARED_STATE_RESTART_CONTINUITY_FAULT_POINTS_V1.includes(faultPoint)
    ) {
      throw new Error(`unknown restart fault point: ${faultPoint}`);
    }
    if (this.#adversarial.skipFaultInjection === true) return;
    const trigger = triggerFor(faultPoint);
    if (trigger === null) {
      this.#armedAmbiguousCommit = faultPoint;
      return;
    }
    this.#fault.trigger = trigger;
  }

  /**
   * A crash takes the process down. The harness reopens with no close of its
   * own, so the target has to put the adapter in a state a bare `open` can
   * legally leave.
   */
  #simulateCrash(): void {
    const lifecycle = this.#adapter.lifecycle();
    if (lifecycle?.state === "ready") this.#adapter.drain();
    this.#adapter.close();
  }

  async transact(command: SharedStateTransactionCommandV1): Promise<unknown> {
    this.#fault.fired = false;
    const observedAtUnixMs = this.#observed();

    if (this.#armedAmbiguousCommit !== null) {
      this.#armedAmbiguousCommit = null;
      if (this.#adversarial.ambiguousCommitRollsBack === true) {
        // Violation: the caller is told the commit is ambiguous while nothing
        // was written, so a retry would apply a second effect.
        this.#simulateCrash();
        return unavailableResult(command.operation, "ambiguous_commit");
      }
      const committed = this.#adapter.transact(command, { observedAtUnixMs });
      if (!committed.ok) {
        throw new Error(`adapter refused: ${committed.error.code}`);
      }
      // The transaction really committed. Only the answer is lost.
      this.#simulateCrash();
      return unavailableResult(command.operation, "ambiguous_commit");
    }

    const result = this.#adapter.transact(command, { observedAtUnixMs });
    if (this.#fault.fired) {
      // The adapter rolled its own transaction back. Nothing was written.
      this.#simulateCrash();
      return unavailableResult(command.operation, "authority_unavailable");
    }
    if (!result.ok) throw new Error(`adapter refused: ${result.error.code}`);
    return result.value;
  }

  /** Reads committed state through the raw handle, never the fault proxy. */
  #outboxRows(): readonly OutboxStateRowV1[] {
    return this.#reads
      .prepare(
        `SELECT stream_key_digest, stream_sequence, receipt_state,
                acknowledgment_state
           FROM shared_state_outbox`,
      )
      .all() as unknown as readonly OutboxStateRowV1[];
  }

  #count(table: string): number {
    const row = this.#reads
      .prepare(`SELECT COUNT(*) AS total FROM ${table}`)
      .get() as { readonly total: number };
    return row.total;
  }

  /**
   * Stream ordinals are assigned by sorting the stored digests, so the same
   * stream keeps the same ordinal across a close and reopen. The harness
   * matches high-waters by ordinal, so an unstable order would read as a
   * regression.
   */
  #streamOrdinals(): readonly string[] {
    return [
      ...new Set(this.#outboxRows().map((row) => row.stream_key_digest)),
    ].sort((left, right) => left.localeCompare(right));
  }

  async captureConformanceSnapshot(): Promise<unknown> {
    const rows = this.#outboxRows();
    const count = (predicate: (row: OutboxStateRowV1) => boolean): number =>
      rows.filter(predicate).length;
    const maxDecimal = (values: readonly string[]): string => {
      let highest = 0n;
      for (const value of values) {
        const parsed = BigInt(value);
        if (parsed > highest) highest = parsed;
      }
      return highest.toString();
    };

    const leaseRows = this.#reads
      .prepare(
        `SELECT attempt_key_digest, fencing_token, resource_version
           FROM shared_state_lease`,
      )
      .all() as unknown as readonly {
        readonly attempt_key_digest: string | null;
        readonly fencing_token: string;
        readonly resource_version: string;
      }[];
    const rateRows = this.#reads
      .prepare(`SELECT cost FROM shared_state_rate_cost`)
      .all() as unknown as readonly { readonly cost: number }[];
    const graphSourceRows = this.#reads
      .prepare(`SELECT source_sequence FROM shared_state_graph_source`)
      .all() as unknown as readonly { readonly source_sequence: string }[];
    const projectionRows = this.#reads
      .prepare(
        `SELECT checkpoint_sequence FROM shared_state_graph_projection`,
      )
      .all() as unknown as readonly { readonly checkpoint_sequence: string }[];
    const idempotencyCount = this.#count("shared_state_idempotency");
    const linkCount = this.#count("shared_state_idempotency_outbox_link");
    const ordinals = this.#streamOrdinals();

    // Key order matches the schema exactly: the harness compares snapshots by
    // JSON string, so order is part of the comparison.
    return Object.freeze({
      kind: "SharedStateRestartContinuityConformanceSnapshotV1",
      snapshotVersion: 1,
      replayRecordCount: this.#count("shared_state_replay_nonce"),
      rateWindowEntryCount: rateRows.length,
      accumulatedRateCost: rateRows.reduce((sum, row) => sum + row.cost, 0),
      activeLeaseCount: leaseRows.filter(
        (row) => row.attempt_key_digest !== null,
      ).length,
      // `fencing_token` is TEXT, so SQL MAX() would sort lexically and rank
      // "9" above "10". The comparison is done in BigInt instead.
      maximumFencingToken: maxDecimal(
        leaseRows.map((row) => row.fencing_token),
      ),
      leaseResourceVersionHighWater: maxDecimal(
        leaseRows.map((row) => row.resource_version),
      ),
      // Declared synthesis: no durable source exists. See the descriptor.
      leaseMutationCount: 0,
      idempotencyOutcomeCount: idempotencyCount,
      // Collapsed onto the idempotency row, as Phase 2.2 and 2.3 declared.
      domainEffectCount: this.#adversarial.doubleCountDomainEffects === true
        ? idempotencyCount + linkCount
        : idempotencyCount,
      // NOT collapsed: the outbox link is its own table and its own row.
      idempotentOutboxEffectCount: linkCount,
      outboxEventCount: rows.length,
      receiptPendingCount: count((row) => row.receipt_state === "pending"),
      receiptConfirmedCount: count((row) => row.receipt_state === "confirmed"),
      unacknowledgedCount: count(
        (row) => row.acknowledgment_state === "unacknowledged",
      ),
      acknowledgedCount: count(
        (row) => row.acknowledgment_state === "acknowledged",
      ),
      streamHighWaters: ordinals.map((digest, index) => ({
        streamOrdinal: index + 1,
        sequenceHighWater: maxDecimal(
          rows
            .filter((row) => row.stream_key_digest === digest)
            .map((row) => row.stream_sequence),
        ),
      })),
      graphSourceFactCount: graphSourceRows.length,
      graphSourceSequenceHighWater: maxDecimal(
        graphSourceRows.map((row) => row.source_sequence),
      ),
      graphProjectionBatchCount: this.#count("shared_state_graph_batch"),
      graphProjectionCheckpointHighWater: maxDecimal(
        projectionRows.map((row) => row.checkpoint_sequence),
      ),
    });
  }

  async captureConformanceCursor(): Promise<unknown> {
    const rows = this.#outboxRows();
    const ordinals = this.#streamOrdinals();
    return Object.freeze({
      kind: "SharedStateRestartContinuityConformanceCursorV1",
      cursorVersion: 1,
      scope: "test-only-restart-continuity-conformance-control",
      positions: ordinals.map((digest, index) => {
        const forStream = rows
          .filter((row) => row.stream_key_digest === digest)
          .sort((left, right) =>
            BigInt(left.stream_sequence) < BigInt(right.stream_sequence)
              ? -1
              : 1
          );
        let highest = 0n;
        for (const row of forStream) {
          const sequence = BigInt(row.stream_sequence);
          if (sequence > highest) highest = sequence;
        }
        // The acknowledged position is the contiguous acknowledged prefix,
        // not a count of acknowledged rows: one gap ends it.
        let acknowledgedThrough = 0n;
        for (const row of forStream) {
          if (row.acknowledgment_state !== "acknowledged") break;
          acknowledgedThrough = BigInt(row.stream_sequence);
        }
        return {
          streamOrdinal: index + 1,
          afterSequence: highest.toString(),
          acknowledgedThroughSequence: acknowledgedThrough.toString(),
        };
      }),
    });
  }

  async reconcileForConformance(
    cursor: SharedStateRestartContinuityConformanceCursorV1,
  ): Promise<unknown> {
    const rows = this.#outboxRows();
    const ordinals = this.#streamOrdinals();
    const events: Record<string, unknown>[] = [];
    // `eventRank` runs globally across streams, not per stream.
    let rank = 0;
    for (const position of cursor.positions) {
      const digest = ordinals[position.streamOrdinal - 1];
      if (digest === undefined) continue;
      const after = BigInt(position.afterSequence);
      const acknowledged = BigInt(position.acknowledgedThroughSequence);
      const floor = after > acknowledged ? after : acknowledged;
      const forStream = rows
        .filter((row) => row.stream_key_digest === digest)
        .filter((row) => {
          if (this.#adversarial.ignoreReconcileCursor === true) {
            // The acknowledgment filter has to be dropped along with the
            // floor. At the point the harness reconciles, the only event
            // above the floor is also the only unacknowledged one, so a
            // control that dropped the floor alone returned exactly the
            // right answer and never reached the check it exists to fail.
            return true;
          }
          if (row.acknowledgment_state !== "unacknowledged") return false;
          return BigInt(row.stream_sequence) > floor;
        })
        .sort((left, right) =>
          BigInt(left.stream_sequence) < BigInt(right.stream_sequence) ? -1 : 1
        );
      for (const row of forStream) {
        rank += 1;
        events.push({
          eventRank: rank,
          streamOrdinal: position.streamOrdinal,
          streamSequence: row.stream_sequence,
          receiptState: row.receipt_state,
          acknowledgmentState: row.acknowledgment_state,
        });
      }
    }
    return Object.freeze({
      kind: "SharedStateRestartContinuityConformanceReconcileResponseV1",
      responseVersion: 1,
      scope: "test-only-restart-continuity-conformance-control",
      events,
    });
  }
}

interface TargetFixtureV1 {
  readonly factory: SharedStateRestartContinuityConformanceTargetFactoryV1;
  readonly dispose: () => void;
  readonly faults: readonly FaultStateV1[];
}

function createSqliteRestartTargetFixtureV1(
  adversarial: AdversarialSqliteRestartControlV1 = {},
): TargetFixtureV1 {
  const directories: string[] = [];
  const handles: DatabaseSync[] = [];
  const faults: FaultStateV1[] = [];
  let ordinal = 0;
  const toleranceMs = SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1
    .backwardSkewToleranceMs
    .toString();

  const factory: SharedStateRestartContinuityConformanceTargetFactoryV1 =
    Object.freeze({
      // Takes the injected clock, unlike Phase 2.3. This section has time
      // semantics and the harness owns the instant.
      async create(input: {
        readonly clock: SharedStateRestartContinuityConformanceClockV1;
      }): Promise<SharedStateRestartContinuityConformanceTargetV1> {
        ordinal += 1;
        const directory = mkdtempSync(
          join(tmpdir(), "shared-state-restart-target-v1-"),
        );
        directories.push(directory);
        // A real file, not `:memory:`. The reopen below is a real restart.
        const db = new DatabaseSync(join(directory, "v1.db"));
        handles.push(db);
        assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);

        const fault: FaultStateV1 = {
          trigger: null,
          fired: false,
          firedCount: 0,
          firedAt: [],
        };
        faults.push(fault);

        const ownerToken = `restart-conformance-owner-${ordinal}`;
        return new SqliteRestartContinuityConformanceTargetV1({
          adapter: new SharedStateSqliteAdapterV1({
            db: createFaultInjectingHandleV1(db, fault),
            ownerToken,
            // Must match the harness tolerance, not the `"0"` the earlier
            // targets pass: the backward-clock scenario observes exactly one
            // millisecond beyond it.
            backwardSkewToleranceMs: toleranceMs,
          }),
          reads: db,
          fault,
          adversarial,
          clock: input.clock,
          ownerToken,
          toleranceMs,
        });
      },
    });

  return {
    factory,
    faults,
    dispose(): void {
      for (const handle of handles) handle.close();
      for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

async function expectConformanceErrorCode(
  adversarial: AdversarialSqliteRestartControlV1,
  expected: string,
): Promise<void> {
  const fixture = createSqliteRestartTargetFixtureV1(adversarial);
  try {
    await assert.rejects(
      runSharedStateRestartContinuityConformanceV1(fixture.factory),
      (error: unknown) => {
        assert.equal(
          error instanceof SharedStateRestartContinuityConformanceErrorV1,
          true,
        );
        if (
          !(error instanceof SharedStateRestartContinuityConformanceErrorV1)
        ) {
          return false;
        }
        assert.equal(error.code, expected);
        return true;
      },
    );
  } finally {
    fixture.dispose();
  }
}

test("declares the Phase 2.4 target shape, its collapse, and its synthesis", () => {
  assert.deepEqual(TEST_ONLY_SQLITE_RESTART_CONTINUITY_TARGET_V1, {
    label: "test-only-sqlite-restart-continuity-conformance-target",
    production: false,
    sqlite: true,
    shared: false,
    attachedToBrokerRuntime: false,
    adapterApiChanged: false,
    durability: "real-file-backed-close-and-reopen-not-object-state-retention",
    faultSeam: "test-only-database-handle-proxy-not-adapter-api",
    cursorSeam: "test-only-control-not-a-v1-query",
    reconcileSeam: "test-only-control-not-a-v1-query",
    faultPointsArmed: 4,
    durableFaultPositions: 4,
    collapsedFaultPoints: [],
    collapseReason: "none-v1-has-a-real-position-for-every-armed-point",
    countersDerivedFromTheIdempotencyRow: ["domainEffectCount"],
    synthesizedValues: [
      "leaseMutationCount",
      "backward-clock-open-lifecycle-envelope",
    ],
    synthesisReason: "v1-has-no-counterpart-declared-under-owner-decision-3",
    backwardClockAdapterOpenedForReal: true,
    clockSuppliedBy: "harness-injected-not-target-owned",
    repeatItemChecked: false,
  });
  assert.equal(
    TEST_ONLY_SQLITE_RESTART_CONTINUITY_TARGET_V1.faultPointsArmed,
    SHARED_STATE_RESTART_CONTINUITY_FAULT_POINTS_V1.length,
  );
  // No armed point approximates another: the count of real positions equals
  // the count of armed points.
  assert.equal(
    TEST_ONLY_SQLITE_RESTART_CONTINUITY_TARGET_V1.durableFaultPositions,
    SHARED_STATE_RESTART_CONTINUITY_FAULT_POINTS_V1.length,
  );
  assert.equal(
    TEST_ONLY_SQLITE_RESTART_CONTINUITY_TARGET_V1.collapsedFaultPoints.length,
    0,
  );
  // The synthesis list is a different category from the collapse list, and
  // the two must not overlap.
  for (
    const synthesized of TEST_ONLY_SQLITE_RESTART_CONTINUITY_TARGET_V1
      .synthesizedValues
  ) {
    assert.equal(
      (TEST_ONLY_SQLITE_RESTART_CONTINUITY_TARGET_V1
        .countersDerivedFromTheIdempotencyRow as readonly string[])
        .includes(synthesized),
      false,
    );
  }
});

test("keeps every conformance seam off the adapter's public surface", () => {
  for (
    const name of [
      "captureConformanceSnapshot",
      "armConformanceCrashFault",
      "captureConformanceCursor",
      "reconcileForConformance",
    ]
  ) {
    assert.equal(
      name in SharedStateSqliteAdapterV1.prototype,
      false,
      `adapter must not expose ${name}`,
    );
  }
});

test("runs the Phase 2.4 harness through the V1 SQLite adapter", async () => {
  const fixture = createSqliteRestartTargetFixtureV1();
  try {
    const report = await runSharedStateRestartContinuityConformanceV1(
      fixture.factory,
    );
    assert.equal(report.status, "passed");
    assert.equal(report.contractVersion, V.versions.contract);
    assert.equal(
      fixture.faults.length,
      SHARED_STATE_RESTART_CONTINUITY_CONFORMANCE_V1.targetCount,
    );
  } finally {
    fixture.dispose();
  }
});

/**
 * The mapping is only honest if the statement boundaries it names are reached.
 * Exactly two of the four armed points are statement faults, and they must
 * fire at the declared statement kinds — otherwise the crash matrix would be
 * passing because nothing ran rather than because everything rolled back.
 */
test("fires both statement crash points at their declared positions", async () => {
  const fixture = createSqliteRestartTargetFixtureV1();
  try {
    await runSharedStateRestartContinuityConformanceV1(fixture.factory);
    const firedAt = fixture.faults.flatMap((fault) => fault.firedAt);
    assert.equal(firedAt.length, 2);
    // `before-command-commit` is a write-statement fault; `before-ack-commit`
    // is the acknowledgment transaction's commit.
    assert.equal(firedAt.filter((kind) => kind === "prepare").length, 1);
    assert.equal(firedAt.filter((kind) => kind === "exec").length, 1);
  } finally {
    fixture.dispose();
  }
});

test("fails the harness when an armed crash point is never injected", async () => {
  await expectConformanceErrorCode(
    { skipFaultInjection: true },
    "crash_recovery_mismatch",
  );
});

test("fails the harness when an ambiguous commit rolled back instead", async () => {
  await expectConformanceErrorCode(
    { ambiguousCommitRollsBack: true },
    "crash_recovery_mismatch",
  );
});

test("fails the harness when a reopen loses committed state", async () => {
  await expectConformanceErrorCode(
    { reopenLosesState: true },
    "continuity_baseline_mismatch",
  );
});

test("fails the harness when an unsafe clock still opens ready", async () => {
  await expectConformanceErrorCode(
    { staysReadyOnUnsafeClock: true },
    "backward_clock_mismatch",
  );
});

test("fails the harness when reconciliation ignores the cursor", async () => {
  await expectConformanceErrorCode(
    { ignoreReconcileCursor: true },
    "outbox_continuity_mismatch",
  );
});

test("fails the harness when domain effects are double counted", async () => {
  await expectConformanceErrorCode(
    { doubleCountDomainEffects: true },
    "continuity_baseline_mismatch",
  );
});
