/**
 * TEST-ONLY Phase 2.5 conformance target backed by the V1 SQLite adapter.
 *
 * Same rule as the Phase 2.7, 2.2, 2.3, and 2.4 targets: every conformance
 * seam lives here, next to the harness, and never on
 * `SharedStateSqliteAdapterV1`. A snapshot, a fault switch, a readiness
 * projection, or a stale-projection read on the adapter would be a storage API
 * the contract does not register.
 *
 * WHAT THIS SLICE PROVES THAT NO EARLIER ONE DID
 *
 * `lock_timeout`. The in-memory reference target never injects a lock at all —
 * it returns the mapped reason from a table. Here `timeout` is a second
 * `DatabaseSync` on the same file holding a RESERVED lock through
 * `BEGIN IMMEDIATE`, so the adapter's own `BEGIN IMMEDIATE` raises a real
 * `SQLITE_BUSY`. The adapter's `busy_timeout` is zero, so this fails
 * immediately and needs no timer: the proof is deterministic. That, and the
 * distinguishability of the four unavailable reasons on a real store, is the
 * whole of what section 2.5 adds. Everything it shares with Phase 2.7 — the
 * proxy seam, `BEGIN IMMEDIATE` all-or-none — is attributed to Phase 2.7 and
 * is not re-proved here.
 *
 * THE FAULT SWITCH IS LEVEL-TRIGGERED, NOT ONE-SHOT
 *
 * This is the one structural break from all four precedents, and copying them
 * would fail. The harness arms `unavailable` once and then requires four
 * separate commands to be refused, so a fault consumed by the first command is
 * wrong here. `armConformanceFault` therefore heals whatever the previous
 * point established and then installs the new one, and the point stays
 * installed until the next arm — including the explicit `null` disarm, which
 * the harness does use.
 *
 * Healing before arming is required rather than tidy. The seeded order ends
 * scenario A on `lost-fence` and scenario B arms `unavailable` with no disarm
 * in between; without a heal the adapter would still be `failed` and every
 * later command would be refused as `not_ready`, which is a real refusal and
 * must never be dressed up as an injected fault.
 *
 * DECISION 2 (COLLAPSE) — declared
 *
 * `unavailable` and `lost-fence` rest on two different durable premises — a
 * foreign `owner_token` and a mismatched `lifecycle_epoch` — but the adapter
 * reaches both through the same `beginWrite` branch and reports both as
 * `ownership_lost`. Two durable premises, one adapter code path. The reasons
 * the harness sees stay distinct because the target knows which premise it
 * established, not because the adapter distinguishes them.
 *
 * DECISION 3 (DECLARED SYNTHESIS) — declared, and cut narrow
 *
 * The adapter has no readiness surface; its public members are exactly the
 * eight asserted below. So the readiness envelope is synthesized. It is cut as
 * narrowly as decision 3(iii) requires: `lifecycleState` and
 * `lifecycleReasonCodes` are the adapter's real `lifecycle()` envelope, and
 * the synthesized part is only the projection of those real reasons into the
 * readiness vocabulary plus the `ready` boolean. The adapter genuinely is
 * `failed` when the harness reads not-ready, because the target drove it there
 * through a real ownership loss before capturing.
 *
 * `prunedRecordCount` is the second synthesized value: V1 implements no
 * retention prune, so no durable prune record exists to count. It is a
 * declared zero, and the report's `retentionPruneExecution: "not-executed"`
 * says the same thing.
 *
 * LIMIT — `ambiguous_commit` is only half expressible here
 *
 * The armed point throws at `COMMIT` before delegating, so the caller does not
 * learn the outcome — that half holds. The other half, "it may actually have
 * committed", cannot be expressed: a fault thrown after a successful COMMIT
 * leaves the row durably present, and the harness pins
 * `stateMutated: false` and compares the graph state against a baseline, so it
 * would fail as `mutation_applied_while_unavailable`. Phase 2.4 used the
 * opposite direction for a different invariant; that is not a precedent to
 * copy here.
 *
 * What this does NOT do: check the Phase 2.5 repeat item. That item also
 * requires a real partition proof against a live shared authority, which a
 * single-process SQLite file is not.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  SHARED_STATE_PARTITION_CONFORMANCE_V1,
  SHARED_STATE_PARTITION_FAULT_POINTS_V1,
  SHARED_STATE_PARTITION_FAULT_REASONS_V1,
  SharedStatePartitionConformanceErrorV1,
  runSharedStatePartitionConformanceV1,
  seededDeterministicPartitionFaultOrderV1,
  sharedStatePartitionConformanceSnapshotV1Schema,
  sharedStatePartitionReadinessV1Schema,
  sharedStatePartitionStaleReadV1Schema,
  type SharedStatePartitionConformanceTargetFactoryV1,
  type SharedStatePartitionConformanceTargetV1,
  type SharedStatePartitionFaultPointV1,
} from "./shared-state-partition-conformance-v1.js";
import { SharedStateSqliteAdapterV1 } from "./shared-state-sqlite-adapter-v1.js";
import { applySharedStateSqliteSchemaV1 } from "./shared-state-sqlite-schema-v1.js";
import {
  SHARED_STATE_STORAGE_V1_VALUES as V,
  digestSharedStateKeyV1,
  parseSharedStateTransactionCommandV1,
  parseSharedStateTransactionResultV1,
  type SharedStateTransactionCommandV1,
} from "./shared-state-storage-contract-v1.js";

/**
 * States what this target is, which fault points collapse onto one adapter
 * code path, and exactly which values are synthesized because V1 has no
 * counterpart for them. A reader should be able to see all of it without
 * reading the implementation. The two lists are disjoint on purpose: a
 * collapse maps onto something that exists, a synthesis stands in for
 * something that does not, and a gap that is in neither list is a defect
 * rather than an instance of either decision.
 */
const TEST_ONLY_SQLITE_PARTITION_TARGET_V1 = Object.freeze({
  label: "test-only-sqlite-partition-conformance-target",
  production: false,
  sqlite: true,
  shared: false,
  attachedToBrokerRuntime: false,
  adapterApiChanged: false,
  faultSeam: "test-only-database-handle-proxy-and-raw-durable-premise",
  lockSeam: "test-only-second-database-handle-on-the-same-file",
  faultTrigger: "level-triggered-until-the-next-arm",
  faultPointsArmed: 5,
  /**
   * Four armed points rest on a durable premise the adapter really observes.
   * `delayed-read` is a read-path point: it is not a durable premise at all,
   * it is the projection lag that is already there.
   */
  durableFaultPremises: 4,
  /** Decision 2. Two durable premises, one adapter code path. */
  collapsedFaultPoints: Object.freeze(["unavailable", "lost-fence"] as const),
  collapseReason: "distinct-durable-premise-same-adapter-ownership-lost-branch",
  /** Decision 3. Nothing else in this target is synthesized. */
  declaredSyntheses: Object.freeze([
    "readiness.ready",
    "readiness.readinessReasonCodes",
    "snapshot.prunedRecordCount",
  ] as const),
  synthesisReason: "v1-has-no-readiness-surface-and-no-retention-prune",
  /** Real `lifecycle()` output, never synthesized. */
  readinessFieldsTakenFromTheAdapter: Object.freeze([
    "lifecycleState",
    "lifecycleReasonCodes",
  ] as const),
  /** The lock is a real SQLITE_BUSY, not a mapped constant. */
  lockTimeoutProvenBy: "real-sqlite-busy-from-a-competing-reserved-lock",
  ambiguousCommitLimit: "commit-outcome-unknown-yes-may-have-committed-no",
  observationHandle: "raw-never-the-fault-proxy",
  repeatItemChecked: false,
} as const);

const COMMIT_SQL = "COMMIT";

const GRAPH_NAMESPACE = "broker.claim-graph.partition";
const SEEDED_GRAPH_SOURCE_COUNT = 3;

/** The adapter's entire public surface. Nothing conformance-shaped is on it. */
const ADAPTER_PUBLIC_MEMBERS_V1 = Object.freeze([
  "ownerToken",
  "lifecycleEpoch",
  "lifecycle",
  "open",
  "beginWrite",
  "transact",
  "query",
  "drain",
  "close",
] as const);

interface AdversarialSqlitePartitionControlV1 {
  /** Accepts the arm request without establishing any durable premise. */
  readonly skipFaultInjection?: boolean;
  /** Reports one reason for every fault point instead of the mapped one. */
  readonly wrongUnavailableReason?: boolean;
  /** Lets the write actually apply while still reporting it unavailable. */
  readonly mutateWhileUnavailable?: boolean;
  /** Serves the projection as complete and current. */
  readonly staleReadNotLabeled?: boolean;
  /** Reports the adapter ready no matter what its lifecycle says. */
  readonly staysReadyWhilePartitioned?: boolean;
}

interface CommitFaultStateV1 {
  armed: boolean;
  firedCount: number;
}

/**
 * Counts refusals the adapter actually produced, per armed point. This exists
 * because of a failure mode that has now shown up seven times across these
 * slices: a fault matrix that passes because the check was never reached
 * rather than because the behavior was right. A seam that silently stopped
 * being installed would still let every harness assertion pass — the commands
 * would just be refused for some other reason, or not refused at all — so the
 * run asserts exact counts instead of trusting that the seams fired.
 */
interface FaultReachV1 {
  /** Real SQLITE_BUSY from the competing RESERVED lock. */
  busy: number;
  /** Real `ownership_lost` from the adapter's own `beginWrite` guard. */
  ownership: number;
  /** Real throw at the transaction's COMMIT. */
  commit: number;
}

/**
 * Intercepts `exec` so a fault can land at the transaction's COMMIT. Unlike
 * the Phase 2.3 seam this one does NOT disarm on fire: section 2.5 requires a
 * point to keep firing until it is replaced. Reads use the raw handle, so an
 * armed fault can never fire while state is being observed.
 */
function createCommitFaultHandleV1(
  db: DatabaseSync,
  state: CommitFaultStateV1,
): DatabaseSync {
  return new Proxy(db, {
    get(target, property, receiver): unknown {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === "exec") {
        return (sql: string): unknown => {
          if (state.armed && sql.includes(COMMIT_SQL)) {
            state.firedCount += 1;
            throw new Error("test-only-injected-conformance-fault");
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
    throw new SharedStatePartitionConformanceErrorV1("invalid_target_result");
  }
  return parsed.value;
}

function graphDigest(
  domain: "broker.claim-graph.source-stream-key"
    | "broker.claim-graph.source-fact",
  components: readonly {
    readonly field: string;
    readonly type: "utf8" | "bytes";
    readonly value: string;
  }[],
): string {
  const parsed = digestSharedStateKeyV1({
    keyspaceVersion: V.versions.keyspace,
    domain,
    namespace: GRAPH_NAMESPACE,
    components,
  });
  if (!parsed.ok) throw new Error(`seed digest refused: ${parsed.error.code}`);
  return parsed.value.digest;
}

const SEED_STREAM_KEY_DIGEST = graphDigest(
  "broker.claim-graph.source-stream-key",
  [
    { field: "sourceType", type: "utf8", value: "run" },
    { field: "sourceId", type: "utf8", value: "partition-seed" },
  ],
);

/**
 * A graph source append, used only to seed provenance inside `open()`. The
 * harness counts the commands it issues, never the ones a target issues to
 * establish its own starting state, so this seeding stays outside the
 * `targetCommandCount` equality the harness enforces.
 */
function seedGraphSourceCommand(
  ordinal: number,
): SharedStateTransactionCommandV1 {
  const parsed = parseSharedStateTransactionCommandV1({
    kind: V.kinds.transactionCommand,
    contractVersion: V.versions.contract,
    transactionVersion: V.versions.transaction,
    operationVersion: V.versions.operation,
    operation: "appendGraphSource",
    input: {
      namespace: GRAPH_NAMESPACE,
      sourceStreamKeyDigest: SEED_STREAM_KEY_DIGEST,
      sourceFactDigest: graphDigest("broker.claim-graph.source-fact", [
        { field: "nodeType", type: "utf8", value: "Claim" },
        {
          field: "fact",
          type: "bytes",
          value: `25${ordinal.toString(16).padStart(2, "0")}`,
        },
      ]),
      nodeType: "Claim",
      expectedSourceSequence: String(ordinal - 1),
    },
  });
  if (!parsed.ok) throw new Error("seed command refused");
  return parsed.value;
}

const READINESS_VOCABULARY = new Set<string>(V.readinessReasonCodes);

class SqlitePartitionConformanceTargetV1
implements SharedStatePartitionConformanceTargetV1 {
  readonly #adapter: SharedStateSqliteAdapterV1;
  readonly #reads: DatabaseSync;
  /** A genuinely separate connection: a nested BEGIN on the adapter's own
   * handle raises "transaction within a transaction", not SQLITE_BUSY. */
  readonly #rival: DatabaseSync;
  readonly #commitFault: CommitFaultStateV1;
  readonly #reach: FaultReachV1;
  readonly #adversarial: AdversarialSqlitePartitionControlV1;
  readonly #usurperToken: string;
  #armed: SharedStatePartitionFaultPointV1 | null = null;
  #rivalHoldsLock = false;
  /** This section pins `clock: "not-required"`, so the harness injects none
   * and the target keeps its own monotonic observation. */
  #observed = 1_000;

  constructor(input: {
    readonly adapter: SharedStateSqliteAdapterV1;
    readonly reads: DatabaseSync;
    readonly rival: DatabaseSync;
    readonly commitFault: CommitFaultStateV1;
    readonly reach: FaultReachV1;
    readonly adversarial: AdversarialSqlitePartitionControlV1;
    readonly usurperToken: string;
  }) {
    this.#adapter = input.adapter;
    this.#reads = input.reads;
    this.#rival = input.rival;
    this.#commitFault = input.commitFault;
    this.#reach = input.reach;
    this.#adversarial = input.adversarial;
    this.#usurperToken = input.usurperToken;
  }

  async open(): Promise<unknown> {
    const opened = this.#adapter.open();
    if (!opened.ok) throw new Error(`adapter open refused: ${opened.error}`);
    // Provenance sources with no projection batch: the checkpoint stays at 0
    // while the high-water mark reaches 3, which is what makes the stale
    // answer's lag a real stored fact rather than a constant.
    for (let ordinal = 1; ordinal <= SEEDED_GRAPH_SOURCE_COUNT; ordinal += 1) {
      const seeded = this.#adapterTransact(seedGraphSourceCommand(ordinal));
      if (!seeded.ok) {
        throw new Error(`seed refused: ${seeded.error.code}`);
      }
    }
    return opened.value;
  }

  async close(): Promise<unknown> {
    this.#heal();
    const drained = this.#adapter.drain();
    if (!drained.ok) throw new Error(`adapter drain refused: ${drained.error}`);
    const closed = this.#adapter.close();
    if (!closed.ok) throw new Error(`adapter close refused: ${closed.error}`);
    return closed.value;
  }

  #adapterTransact(
    command: SharedStateTransactionCommandV1,
  ): ReturnType<SharedStateSqliteAdapterV1["transact"]> {
    this.#observed += 1;
    return this.#adapter.transact(command, {
      observedAtUnixMs: this.#observed.toString(),
    });
  }

  // ---- durable premises -------------------------------------------------

  #ownershipRow(): { owner_token: string | null; lifecycle_epoch: string } {
    const row = this.#reads
      .prepare(
        `SELECT owner_token, lifecycle_epoch FROM shared_state_ownership
         WHERE id = 1`,
      )
      .get() as { owner_token?: unknown; lifecycle_epoch?: unknown };
    return {
      owner_token: typeof row.owner_token === "string" ? row.owner_token : null,
      lifecycle_epoch: String(row.lifecycle_epoch),
    };
  }

  /** A foreign owner token: the row says someone else holds the authority. */
  #takeOwnershipAway(): void {
    this.#reads
      .prepare(`UPDATE shared_state_ownership SET owner_token = ? WHERE id = 1`)
      .run(this.#usurperToken);
  }

  /**
   * A lifecycle epoch the adapter's session never acquired. The epoch only
   * ever moves up: healing re-acquires through `open()`, which raises the row
   * again rather than putting it back.
   */
  #advanceEpochPastTheSession(): void {
    const current = BigInt(this.#ownershipRow().lifecycle_epoch);
    this.#reads
      .prepare(
        `UPDATE shared_state_ownership SET lifecycle_epoch = ? WHERE id = 1`,
      )
      .run((current + 1_000n).toString());
  }

  #takeRivalLock(): void {
    if (this.#rivalHoldsLock) return;
    // BEGIN IMMEDIATE takes RESERVED straight away, which is exactly what the
    // adapter's own BEGIN IMMEDIATE will collide with.
    this.#rival.exec("BEGIN IMMEDIATE");
    this.#rivalHoldsLock = true;
  }

  #releaseRivalLock(): void {
    if (!this.#rivalHoldsLock) return;
    this.#rival.exec("ROLLBACK");
    this.#rivalHoldsLock = false;
  }

  /**
   * Puts the store and the adapter back into a state where a command can
   * genuinely succeed. Order matters: the commit fault has to go first,
   * because reacquiring ownership issues its own COMMIT.
   */
  #heal(): void {
    this.#commitFault.armed = false;
    this.#releaseRivalLock();
    if (this.#ownershipRow().owner_token !== this.#adapter.ownerToken) {
      this.#reads
        .prepare(
          `UPDATE shared_state_ownership SET owner_token = ? WHERE id = 1`,
        )
        .run(this.#adapter.ownerToken);
    }
    if (this.#adapter.lifecycle()?.state === "failed") {
      const reopened = this.#adapter.open();
      if (!reopened.ok) {
        throw new Error(`adapter reopen refused: ${reopened.error.code}`);
      }
    }
  }

  #establish(faultPoint: SharedStatePartitionFaultPointV1): void {
    switch (faultPoint) {
      case "unavailable":
        this.#takeOwnershipAway();
        break;
      case "lost-fence":
        this.#advanceEpochPastTheSession();
        break;
      case "timeout":
        this.#takeRivalLock();
        break;
      case "ambiguous-commit":
        this.#commitFault.armed = true;
        break;
      case "delayed-read":
        // A read-path point. The projection lag is already stored; nothing is
        // established and nothing needs to be.
        break;
      default:
        throw new Error(`unknown partition fault point: ${String(faultPoint)}`);
    }
  }

  /**
   * Synchronous by contract. Heals the previous point, installs the new one,
   * and — for the two ownership premises — drives the adapter to observe it
   * now, so a readiness capture taken before any command still sees a
   * genuinely failed adapter rather than a claim about one.
   */
  armConformanceFault(
    faultPoint: SharedStatePartitionFaultPointV1 | null,
  ): void {
    if (
      faultPoint !== null
      && !SHARED_STATE_PARTITION_FAULT_POINTS_V1.includes(faultPoint)
    ) {
      throw new Error(`unknown partition fault point: ${faultPoint}`);
    }
    this.#heal();
    this.#armed = faultPoint;
    if (faultPoint === null) return;
    if (this.#adversarial.skipFaultInjection === true) return;
    this.#establish(faultPoint);
    if (faultPoint === "unavailable" || faultPoint === "lost-fence") {
      // `beginWrite` is the adapter's own guard, not a conformance seam. It
      // reads the ownership row and transitions to `failed` on a mismatch.
      const observed = this.#adapter.beginWrite();
      if (observed.ok || observed.error.code !== "ownership_lost") {
        throw new Error("ownership premise did not reach the adapter");
      }
    }
  }

  // ---- the command path -------------------------------------------------

  /** The adapter error code each armed point must actually produce. */
  #expectedRefusal(
    faultPoint: Exclude<SharedStatePartitionFaultPointV1, "delayed-read">,
  ): string {
    // A busy store and a throwing COMMIT both leave the adapter `ready` with
    // nothing written, and both surface as `store_failure`.
    return faultPoint === "unavailable" || faultPoint === "lost-fence"
      ? "ownership_lost"
      : "store_failure";
  }

  async transact(command: SharedStateTransactionCommandV1): Promise<unknown> {
    const fault = this.#armed;
    if (
      fault === null
      || fault === "delayed-read"
      || this.#adversarial.skipFaultInjection === true
    ) {
      const clean = this.#adapterTransact(command);
      if (!clean.ok) throw new Error(`adapter refused: ${clean.error.code}`);
      return clean.value;
    }

    const reasonCode = this.#adversarial.wrongUnavailableReason === true
      ? "authority_unavailable"
      : SHARED_STATE_PARTITION_FAULT_REASONS_V1[fault];

    if (this.#adversarial.mutateWhileUnavailable === true) {
      // Violation: the premise is lifted for the duration of the command, so
      // the write really applies, and the unavailable envelope is a lie about
      // state that moved.
      this.#heal();
      const applied = this.#adapterTransact(command);
      if (!applied.ok) throw new Error(`adapter refused: ${applied.error.code}`);
      return unavailableResult(command.operation, reasonCode);
    }

    if (fault === "unavailable" || fault === "lost-fence") {
      // Re-establish per command rather than leaning on the failed state left
      // by the previous one: every refusal in a level-triggered run is then a
      // fresh ownership check inside the adapter, not a cached verdict.
      this.#heal();
      this.#establish(fault);
    }

    const firedBefore = this.#commitFault.firedCount;
    const refused = this.#adapterTransact(command);
    if (refused.ok) {
      throw new Error("armed fault did not reach the adapter");
    }
    const expected = this.#expectedRefusal(fault);
    if (refused.error.code !== expected) {
      // Any other failure is a real one and is never dressed up as a fault.
      throw new Error(
        `unplanned adapter refusal: ${refused.error.code} (expected ${expected})`,
      );
    }
    if (
      fault === "ambiguous-commit"
      && this.#commitFault.firedCount === firedBefore
    ) {
      throw new Error("commit fault never fired");
    }
    // Record which real adapter boundary produced this refusal, so the run can
    // assert the seams were reached rather than assume it.
    if (fault === "ambiguous-commit") this.#reach.commit += 1;
    else if (fault === "timeout") this.#reach.busy += 1;
    else this.#reach.ownership += 1;
    return unavailableResult(command.operation, reasonCode);
  }

  // ---- observation, always through the raw handle -----------------------

  #count(table: string, where = ""): number {
    const row = this.#reads
      .prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`)
      .get() as { count?: unknown };
    return Number(row.count);
  }

  #maximum(table: string, column: string): bigint {
    const rows = this.#reads
      .prepare(`SELECT ${column} AS value FROM ${table}`)
      .all() as readonly { value?: unknown }[];
    let high = 0n;
    for (const row of rows) {
      // TEXT columns: SQL MAX() would order them lexically and rank "9" above
      // "10". The comparison has to happen in BigInt.
      const value = BigInt(String(row.value));
      if (value > high) high = value;
    }
    return high;
  }

  #checkpointSequence(): bigint {
    const row = this.#reads
      .prepare(`SELECT checkpoint_sequence FROM shared_state_graph_projection`)
      .get() as { checkpoint_sequence?: unknown } | undefined;
    if (row === undefined) return 0n;
    return BigInt(String(row.checkpoint_sequence));
  }

  #leaseResourceVersion(): bigint {
    return this.#maximum("shared_state_lease", "resource_version");
  }

  /**
   * A real observation, not the armed flag read back: the ownership row is
   * compared against what this adapter session holds. The rival lock is the
   * one component the store cannot report, and it is the target's own.
   */
  #authorityReachable(): boolean {
    if (this.#rivalHoldsLock) return false;
    const row = this.#ownershipRow();
    return (
      row.owner_token === this.#adapter.ownerToken
      && row.lifecycle_epoch === this.#adapter.lifecycleEpoch
    );
  }

  async captureConformanceSnapshot(): Promise<unknown> {
    return sharedStatePartitionConformanceSnapshotV1Schema.parse({
      kind: "SharedStatePartitionConformanceSnapshotV1",
      snapshotVersion: 1,
      replayRecordCount: this.#count("shared_state_replay_nonce"),
      rateEntryCount: this.#count("shared_state_rate_cost"),
      activeLeaseCount: this.#count(
        "shared_state_lease",
        "WHERE owner_key_digest IS NOT NULL",
      ),
      maximumFencingToken: this.#maximum(
        "shared_state_lease",
        "fencing_token",
      ).toString(),
      leaseResourceVersion: this.#leaseResourceVersion().toString(),
      idempotencyOutcomeCount: this.#count("shared_state_idempotency"),
      outboxEventCount: this.#count("shared_state_outbox"),
      unacknowledgedEventCount: this.#count(
        "shared_state_outbox",
        "WHERE acknowledgment_state = 'unacknowledged'",
      ),
      acknowledgedEventCount: this.#count(
        "shared_state_outbox",
        "WHERE acknowledgment_state = 'acknowledged'",
      ),
      streamSequenceHighWater: this.#maximum(
        "shared_state_outbox",
        "stream_sequence",
      ).toString(),
      provenanceSourceCount: this.#count("shared_state_graph_source"),
      provenanceCheckpointSequence: this.#checkpointSequence().toString(),
      // Declared synthesis: V1 implements no retention prune, so there is no
      // durable prune record to count. The descriptor above says so.
      prunedRecordCount: 0,
      authorityReachable: this.#authorityReachable(),
    });
  }

  async captureConformanceReadiness(): Promise<unknown> {
    const envelope = this.#adapter.lifecycle();
    if (envelope === null) {
      throw new Error("adapter produced no lifecycle envelope");
    }
    const ready = this.#adversarial.staysReadyWhilePartitioned === true
      ? true
      : envelope.state === "ready";
    // The synthesized half, cut as narrowly as decision 3(iii) asks: the real
    // lifecycle reasons projected into the readiness vocabulary, nothing
    // invented on top.
    const readinessReasonCodes = this.#adversarial
        .staysReadyWhilePartitioned === true
      ? []
      : envelope.reasonCodes.filter((code) => READINESS_VOCABULARY.has(code));
    return sharedStatePartitionReadinessV1Schema.parse({
      kind: "SharedStatePartitionConformanceReadinessV1",
      readinessVersion: 1,
      scope: "test-only-adapter-lifecycle-readiness-control",
      ready,
      lifecycleState: envelope.state,
      lifecycleReasonCodes: envelope.reasonCodes,
      readinessReasonCodes,
    });
  }

  /**
   * Reports the checkpoint, the high-water mark, and the gap between them.
   * There is deliberately no judgment ladder here: Phase 2.7 already proves
   * the `projection_incomplete` / `projection_unavailable` / `no_evidence_path`
   * distinction, and section 2.5's stale-read shape has no field to put a
   * verdict in.
   */
  async readConformanceStaleProjection(): Promise<unknown> {
    const checkpoint = this.#checkpointSequence();
    const highWater = this.#adversarial.staleReadNotLabeled === true
      ? checkpoint
      : this.#maximum("shared_state_graph_source", "source_sequence");
    return sharedStatePartitionStaleReadV1Schema.parse({
      kind: "SharedStatePartitionConformanceStaleReadV1",
      staleReadVersion: 1,
      scope: "test-only-partition-conformance-control",
      freshness: "stale",
      // Derived from the two stored sequences, never hard-coded. Only the
      // complete/incomplete split is needed: the harness checks
      // `!== "complete"`, and the unavailable case belongs to Phase 2.7.
      completeness: checkpoint === highWater ? "complete" : "incomplete",
      asOfSourceSequence: checkpoint.toString(),
      checkpointSequence: checkpoint.toString(),
      sourceSequenceHighWater: highWater.toString(),
      lag: Number(highWater - checkpoint),
    });
  }
}

interface TargetFixtureV1 {
  readonly factory: SharedStatePartitionConformanceTargetFactoryV1;
  readonly dispose: () => void;
  readonly commitFaults: readonly CommitFaultStateV1[];
  /** Shared across every target the run creates, so the totals are run-wide. */
  readonly reach: FaultReachV1;
}

function createSqlitePartitionTargetFixtureV1(
  adversarial: AdversarialSqlitePartitionControlV1 = {},
): TargetFixtureV1 {
  const directories: string[] = [];
  const handles: DatabaseSync[] = [];
  const commitFaults: CommitFaultStateV1[] = [];
  const reach: FaultReachV1 = { busy: 0, ownership: 0, commit: 0 };
  let ordinal = 0;

  const factory: SharedStatePartitionConformanceTargetFactoryV1 = Object.freeze(
    {
      // No argument. This section pins `clock: "not-required"`, so copying the
      // Phase 2.4 `create({clock})` shape would be wrong.
      async create(): Promise<SharedStatePartitionConformanceTargetV1> {
        ordinal += 1;
        const directory = mkdtempSync(
          join(tmpdir(), "shared-state-partition-target-v1-"),
        );
        directories.push(directory);
        const file = join(directory, "v1.db");

        const db = new DatabaseSync(file);
        handles.push(db);
        assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);
        // The competing lock has to come from a different connection: a nested
        // BEGIN IMMEDIATE on the same one is a different error entirely.
        const rival = new DatabaseSync(file);
        handles.push(rival);

        const commitFault: CommitFaultStateV1 = { armed: false, firedCount: 0 };
        commitFaults.push(commitFault);

        return new SqlitePartitionConformanceTargetV1({
          adapter: new SharedStateSqliteAdapterV1({
            db: createCommitFaultHandleV1(db, commitFault),
            ownerToken: `partition-conformance-owner-${ordinal}`,
            backwardSkewToleranceMs: "0",
          }),
          reads: db,
          rival,
          commitFault,
          reach,
          adversarial,
          usurperToken: `partition-conformance-usurper-${ordinal}`,
        });
      },
    },
  );

  return {
    factory,
    commitFaults,
    reach,
    dispose(): void {
      for (const handle of handles) {
        try {
          handle.close();
        } catch {
          // A handle left inside a transaction by a failed run still has to be
          // released; the directory removal below is what actually matters.
        }
      }
      for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

async function expectConformanceErrorCode(
  adversarial: AdversarialSqlitePartitionControlV1,
  expected: string,
): Promise<void> {
  const fixture = createSqlitePartitionTargetFixtureV1(adversarial);
  try {
    await assert.rejects(
      runSharedStatePartitionConformanceV1(fixture.factory),
      (error: unknown) => {
        assert.equal(
          error instanceof SharedStatePartitionConformanceErrorV1,
          true,
        );
        if (!(error instanceof SharedStatePartitionConformanceErrorV1)) {
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

test("declares the Phase 2.5 target shape, its collapse, and its syntheses", () => {
  assert.deepEqual(TEST_ONLY_SQLITE_PARTITION_TARGET_V1, {
    label: "test-only-sqlite-partition-conformance-target",
    production: false,
    sqlite: true,
    shared: false,
    attachedToBrokerRuntime: false,
    adapterApiChanged: false,
    faultSeam: "test-only-database-handle-proxy-and-raw-durable-premise",
    lockSeam: "test-only-second-database-handle-on-the-same-file",
    faultTrigger: "level-triggered-until-the-next-arm",
    faultPointsArmed: 5,
    durableFaultPremises: 4,
    collapsedFaultPoints: ["unavailable", "lost-fence"],
    collapseReason:
      "distinct-durable-premise-same-adapter-ownership-lost-branch",
    declaredSyntheses: [
      "readiness.ready",
      "readiness.readinessReasonCodes",
      "snapshot.prunedRecordCount",
    ],
    synthesisReason: "v1-has-no-readiness-surface-and-no-retention-prune",
    readinessFieldsTakenFromTheAdapter: [
      "lifecycleState",
      "lifecycleReasonCodes",
    ],
    lockTimeoutProvenBy: "real-sqlite-busy-from-a-competing-reserved-lock",
    ambiguousCommitLimit: "commit-outcome-unknown-yes-may-have-committed-no",
    observationHandle: "raw-never-the-fault-proxy",
    repeatItemChecked: false,
  });

  // The declared numbers must match the vocabulary they describe.
  assert.equal(
    TEST_ONLY_SQLITE_PARTITION_TARGET_V1.faultPointsArmed,
    SHARED_STATE_PARTITION_FAULT_POINTS_V1.length,
  );
  // Every armed point except the read-path one rests on a durable premise.
  assert.equal(
    TEST_ONLY_SQLITE_PARTITION_TARGET_V1.durableFaultPremises,
    SHARED_STATE_PARTITION_FAULT_POINTS_V1.filter(
      (point) => point !== "delayed-read",
    ).length,
  );
  // Decision 2 is a mapping and decision 3 is a substitution. They are
  // different categories, so the two lists must not overlap: a value in both
  // would mean the target claimed to map something it actually invented.
  const collapsed = new Set<string>(
    TEST_ONLY_SQLITE_PARTITION_TARGET_V1.collapsedFaultPoints,
  );
  for (const synthesized of TEST_ONLY_SQLITE_PARTITION_TARGET_V1
    .declaredSyntheses) {
    assert.equal(collapsed.has(synthesized), false);
  }
  // Both collapsed points are real armed points, and both really do map onto
  // the single `ownership_lost` branch.
  for (const point of TEST_ONLY_SQLITE_PARTITION_TARGET_V1.collapsedFaultPoints) {
    assert.equal(SHARED_STATE_PARTITION_FAULT_POINTS_V1.includes(point), true);
  }
  // The readiness fields taken from the adapter and the synthesized readiness
  // fields together account for the whole envelope, so nothing is left
  // undeclared.
  assert.deepEqual(
    [
      ...TEST_ONLY_SQLITE_PARTITION_TARGET_V1
        .readinessFieldsTakenFromTheAdapter,
      ...TEST_ONLY_SQLITE_PARTITION_TARGET_V1.declaredSyntheses
        .filter((name) => name.startsWith("readiness."))
        .map((name) => name.slice("readiness.".length)),
    ].sort(),
    ["lifecycleReasonCodes", "lifecycleState", "readinessReasonCodes", "ready"],
  );
});

test("keeps every conformance seam off the adapter's public surface", () => {
  for (
    const name of [
      "captureConformanceSnapshot",
      "armConformanceFault",
      "captureConformanceReadiness",
      "readConformanceStaleProjection",
      "readiness",
      "armFault",
      "snapshot",
    ]
  ) {
    assert.equal(
      name in SharedStateSqliteAdapterV1.prototype,
      false,
      `adapter must not expose ${name}`,
    );
  }
  // And the surface it does have is exactly the lifecycle/write surface plus
  // the narrowed Q2 outbox query, so a conformance seam cannot be added
  // without this failing.
  assert.deepEqual(
    Object.getOwnPropertyNames(SharedStateSqliteAdapterV1.prototype)
      .filter((name) => name !== "constructor")
      .sort(),
    [...ADAPTER_PUBLIC_MEMBERS_V1].sort(),
  );
});

test("runs the Phase 2.5 harness through the V1 SQLite adapter", async () => {
  const fixture = createSqlitePartitionTargetFixtureV1();
  try {
    const report = await runSharedStatePartitionConformanceV1(fixture.factory);
    assert.equal(report.status, "passed");
    assert.equal(report.contractVersion, V.versions.contract);
    assert.equal(
      report.controls.targetCount,
      SHARED_STATE_PARTITION_CONFORMANCE_V1.targetCount,
    );
    assert.equal(
      fixture.commitFaults.length,
      SHARED_STATE_PARTITION_CONFORMANCE_V1.targetCount,
    );
    // Both previously uncovered reasons are carried by real cases, and the
    // seeded order is the one the fault matrix was built against.
    assert.deepEqual(report.faultPoints.previouslyUncovered, [
      "lock_timeout",
      "delayed-read",
    ]);
    assert.deepEqual(
      report.faultPoints.cases.map((entry) => entry.faultPoint),
      [...seededDeterministicPartitionFaultOrderV1()],
    );

    // Every unavailable answer the harness accepted came from a real adapter
    // refusal, and these are exactly how many of each. Exact equalities, not
    // lower bounds: a seam that stopped being installed, or one that started
    // firing somewhere it should not, moves one of these numbers.
    //
    //   busy      2 = scenario A's `timeout` replay + scenario B's rate reserve
    //   commit    1 = scenario A's `ambiguous-commit` replay
    //   ownership 10 = A(`unavailable`, `lost-fence`) + B 1 + C 4 + D 2 + F 1
    assert.deepEqual(fixture.reach, { busy: 2, ownership: 10, commit: 1 });
    // The 13 refusals above plus 5 commands issued with nothing armed are the
    // 18 the harness pins, so no command took an unaccounted path.
    assert.equal(
      fixture.reach.busy + fixture.reach.ownership + fixture.reach.commit + 5,
      SHARED_STATE_PARTITION_CONFORMANCE_V1.expectedTargetCommandCount,
    );
    assert.equal(
      report.controls.targetCommandCount,
      SHARED_STATE_PARTITION_CONFORMANCE_V1.expectedTargetCommandCount,
    );
    // The commit seam fired once, in the one target that armed it.
    assert.equal(
      fixture.commitFaults.reduce((sum, state) => sum + state.firedCount, 0),
      1,
    );
  } finally {
    fixture.dispose();
  }
});

/**
 * The point of this slice. `lock_timeout` is the reason the in-memory
 * reference model never actually injects — it returns the mapped constant. Here
 * the reason has to come from a real busy store, so this asserts the collision
 * happens rather than trusting that it did.
 */
test("proves lock_timeout with a real SQLITE_BUSY, not a mapped constant", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "shared-state-partition-busy-v1-"),
  );
  const file = join(directory, "v1.db");
  const db = new DatabaseSync(file);
  const rival = new DatabaseSync(file);
  try {
    assert.equal(applySharedStateSqliteSchemaV1(db).ok, true);
    const adapter = new SharedStateSqliteAdapterV1({
      db,
      ownerToken: "busy-probe-owner",
      backwardSkewToleranceMs: "0",
    });
    assert.equal(adapter.open().ok, true);

    rival.exec("BEGIN IMMEDIATE");
    // The collision is on the write lock, so a read still succeeds — which is
    // why the snapshot control can observe state while a fault is armed.
    assert.equal(
      typeof (
        db.prepare(`SELECT COUNT(*) AS count FROM shared_state_outbox`).get() as {
          count?: unknown;
        }
      ).count,
      "number",
    );

    const busy = adapter.transact(seedGraphSourceCommand(1), {
      observedAtUnixMs: "1001",
    });
    assert.equal(busy.ok, false);
    if (busy.ok) throw new Error("unreachable");
    // Nothing was staged: the adapter never got past its own BEGIN IMMEDIATE.
    assert.equal(busy.error.code, "store_failure");
    // A busy store is not a broken adapter. It stays writable once the lock
    // goes away, which is what makes `lock_timeout` the honest reason rather
    // than `authority_unavailable`.
    assert.equal(adapter.lifecycle()?.state, "ready");

    rival.exec("ROLLBACK");
    const afterRelease = adapter.transact(seedGraphSourceCommand(1), {
      observedAtUnixMs: "1002",
    });
    assert.equal(afterRelease.ok, true);
  } finally {
    db.close();
    rival.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * The harness arms `unavailable` once and then requires four separate commands
 * to be refused. A one-shot switch copied from the earlier targets would let
 * the second command through, so this pins the level-triggered behavior
 * directly rather than relying on the full run to notice.
 */
test("keeps an armed fault firing across every following command", async () => {
  const fixture = createSqlitePartitionTargetFixtureV1();
  try {
    const target = await fixture.factory.create();
    await target.open();
    target.armConformanceFault("ambiguous-commit");
    const before = fixture.commitFaults[0]!.firedCount;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await target.transact(seedGraphSourceCommand(attempt)) as {
        status?: unknown;
        reasonCode?: unknown;
      };
      assert.equal(result.status, "unavailable");
      assert.equal(result.reasonCode, "ambiguous_commit");
    }
    // Three commands, three commits intercepted — not one consumed arm.
    assert.equal(fixture.commitFaults[0]!.firedCount, before + 3);
    // And the explicit disarm the harness uses really does restore service.
    target.armConformanceFault(null);
    const recovered = await target.transact(seedGraphSourceCommand(1)) as {
      status?: unknown;
    };
    assert.equal(recovered.status, "committed");
    await target.close();
  } finally {
    fixture.dispose();
  }
});

/**
 * The readiness envelope is half synthesized, so the half that is not has to
 * be shown to be real: the adapter is genuinely `failed` through its own
 * ownership check, not reported failed by the target.
 */
test("drives the adapter into a real failed state before reporting not-ready", async () => {
  const fixture = createSqlitePartitionTargetFixtureV1();
  try {
    const target = await fixture.factory.create();
    await target.open();
    const before = await target.captureConformanceReadiness() as {
      ready?: unknown;
      lifecycleState?: unknown;
      readinessReasonCodes?: unknown;
    };
    assert.equal(before.ready, true);
    assert.equal(before.lifecycleState, "ready");
    assert.deepEqual(before.readinessReasonCodes, []);

    target.armConformanceFault("unavailable");
    const during = await target.captureConformanceReadiness() as {
      ready?: unknown;
      lifecycleState?: unknown;
      lifecycleReasonCodes?: unknown;
      readinessReasonCodes?: unknown;
    };
    assert.equal(during.ready, false);
    // Real adapter output, taken from `lifecycle()`.
    assert.equal(during.lifecycleState, "failed");
    assert.deepEqual(during.lifecycleReasonCodes, ["adapter_unavailable"]);
    // Synthesized, but only as a projection of the real reasons above.
    assert.deepEqual(during.readinessReasonCodes, ["adapter_unavailable"]);

    target.armConformanceFault(null);
    const after = await target.captureConformanceReadiness() as {
      ready?: unknown;
      lifecycleState?: unknown;
    };
    assert.equal(after.ready, true);
    assert.equal(after.lifecycleState, "ready");
    await target.close();
  } finally {
    fixture.dispose();
  }
});

/**
 * The stale answer must be a stored fact. Seeded provenance with no projection
 * batch leaves a checkpoint of 0 against a high-water mark of 3, so the lag the
 * harness reads is the real gap rather than a constant the target chose.
 */
test("serves the stale answer from stored checkpoint and high-water state", async () => {
  const fixture = createSqlitePartitionTargetFixtureV1();
  try {
    const target = await fixture.factory.create();
    await target.open();
    const stale = await target.readConformanceStaleProjection() as {
      completeness?: unknown;
      asOfSourceSequence?: unknown;
      checkpointSequence?: unknown;
      sourceSequenceHighWater?: unknown;
      lag?: unknown;
    };
    assert.equal(stale.completeness, "incomplete");
    assert.equal(stale.checkpointSequence, "0");
    assert.equal(
      stale.sourceSequenceHighWater,
      String(SEEDED_GRAPH_SOURCE_COUNT),
    );
    assert.equal(stale.asOfSourceSequence, stale.checkpointSequence);
    assert.equal(stale.lag, SEEDED_GRAPH_SOURCE_COUNT);
    await target.close();
  } finally {
    fixture.dispose();
  }
});

/**
 * Each control has to reach the harness check it was written for. A control
 * that passes has not proved the implementation correct — it has proved the
 * control too weak — so these pin the exact code, not merely a rejection.
 */
test("fails closed on each adversarial partition violation", async () => {
  // Item: a protected request must never return an empty local decision.
  await expectConformanceErrorCode(
    { skipFaultInjection: true },
    "empty_local_decision",
  );
  // Item: the reported reason must match the injected fault. The seeded order
  // opens on `timeout`, so a blanket `authority_unavailable` is caught there.
  await expectConformanceErrorCode(
    { wrongUnavailableReason: true },
    "unavailable_reason_mismatch",
  );
  // Item: no mutation applies while the authority is unavailable.
  await expectConformanceErrorCode(
    { mutateWhileUnavailable: true },
    "mutation_applied_while_unavailable",
  );
  // Item: a partitioned read must be explicitly labeled stale.
  await expectConformanceErrorCode(
    { staleReadNotLabeled: true },
    "stale_read_not_labeled",
  );
  // Item: the adapter must report not-ready while partitioned.
  await expectConformanceErrorCode(
    { staysReadyWhilePartitioned: true },
    "not_ready_state_mismatch",
  );
});
