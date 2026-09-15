/**
 * Claim-graph source gate for #1504 §4 Slice X — the wiring layer between
 * the broker's terminal task transitions and the fence-mediated V1
 * `appendGraphSource` primitive (§5.6, namespace `broker.claim-graph`).
 *
 * The gate is constructed only when the default-off
 * `BROKER_SHARED_STATE_V1_GRAPH` flag is `on`. It tracks the namespace
 * high-water sequence (the optimistic CAS value `appendGraphSource`
 * requires) and never invents one: every decision comes from a committed
 * adapter envelope, and an unavailable authority throws retryable
 * `state_unavailable` so the terminal transition fails whole (§5.6 partition:
 * source append fails if its authority is unavailable).
 *
 * Resync (Q4-successor source design): the append attempt stays replay-first —
 * a historical fact replays its ORIGINAL sequence in one CAS call and never
 * regresses the warm cache. On a `source_sequence_conflict` the gate no longer
 * probes upward with rejected appends (the old linear walk needed one rejected
 * transaction per gap — 1,000,000 durable conflicts for a cold gate at
 * high-water 1,000,000). It instead reads the durable namespace high-water
 * through the fence's narrow fail-closed `queryGraphSourceHighWater` window
 * onto the closed additive query, then retries the SAME CAS append at the
 * observed value. The query authorizes nothing: ownership and the
 * compare-and-set are enforced by the retrying append itself. If a concurrent
 * append authority advances the namespace again between the read and the
 * retry, the CAS conflicts once more and the bounded cycle repeats.
 *
 * Bounds and fail-closed posture: the conflict cycle is capped at
 * `GRAPH_SOURCE_CONFLICT_RETRY_BUDGET` rounds — exhausted, the gate throws
 * retryable `state_unavailable` and the terminal transition fails whole. A
 * high-water observation BELOW the tracked expectation means the source
 * ledger regressed under this gate (rollback or corrupted store): the gate
 * fails closed and never resets its cache or silently re-appends a historical
 * sequence. A successful appended/replayed result retains the greater of the
 * tracked expectation and the returned committed sequence (BigInt
 * comparison), so history can neither regress nor invent ordering. No flag,
 * default, authority, or takeover posture changes with this resync.
 */

import { BrokerError } from "./core/broker-error.js";
import type { SharedStateServingFenceV1 } from "./shared-state-serving-fence-v1.js";

/**
 * Bound on the conflict-resync cycle: each round is one conflicted CAS append
 * plus one durable high-water read. Beyond it the gate fails closed instead
 * of probing.
 */
const GRAPH_SOURCE_CONFLICT_RETRY_BUDGET = 8;

export class SharedStateGraphSourceGateV1 {
  #expectedSequence = 0n;

  constructor(
    private readonly getFence: () => SharedStateServingFenceV1 | undefined,
  ) {}

  appendTerminalTaskFact(
    input: {
      readonly brokerAuthorityId: string;
      readonly taskId: string;
      readonly status: string;
      readonly completedAt: string;
    },
    nowMs = Date.now(),
  ): { readonly sequence: string } {
    const fence = this.getFence();
    if (!fence) {
      throw new BrokerError(
        "state_unavailable",
        "task_graph_source_state_unavailable: serving fence missing",
      );
    }
    let conflictRounds = 0;
    for (;;) {
      const outcome = fence.appendTaskRunGraphSource(
        {
          brokerAuthorityId: input.brokerAuthorityId,
          taskId: input.taskId,
          status: input.status,
          completedAt: input.completedAt,
          expectedSourceSequence: this.#expectedSequence.toString(),
        },
        nowMs,
      );
      if (outcome.outcome === "appended" || outcome.outcome === "replayed") {
        // The fact digest dedupes repeats, so a replayed answer is the same
        // original sequence — no duplicate fact, no invented ordering. The
        // tracked counter moves only monotonically upward (BigInt compare):
        // a replayed HISTORICAL fact must not regress the warm cache, or the
        // next fresh append would re-probe expectations it has already
        // passed. The replay itself still returns the original sequence.
        const committed = BigInt(outcome.sourceSequence);
        if (committed > this.#expectedSequence) {
          this.#expectedSequence = committed;
        }
        return { sequence: outcome.sourceSequence };
      }
      if (
        outcome.outcome === "sequence_conflict"
        && conflictRounds < GRAPH_SOURCE_CONFLICT_RETRY_BUDGET
      ) {
        // Cold-start or raced resync: read the durable namespace high-water
        // (one strict closed query) and retry the same CAS at that value.
        // The read never authorizes the append — the retry enforces ownership
        // and the compare-and-set itself.
        conflictRounds += 1;
        const observed = fence.queryGraphSourceHighWater();
        if (observed.outcome !== "observed") {
          throw new BrokerError(
            "state_unavailable",
            `task_graph_source_state_unavailable: ${observed.reasonCode}`,
          );
        }
        const durable = BigInt(observed.sourceSequenceHighWater);
        if (durable < this.#expectedSequence) {
          // The ledger regressed below what this gate already observed
          // (rolled-back or inconsistent source). Fail closed: never reset
          // the cache, never silently reallocate a historical sequence.
          throw new BrokerError(
            "state_unavailable",
            "task_graph_source_state_unavailable: source_high_water_below_tracked_expectation",
          );
        }
        this.#expectedSequence = durable;
        continue;
      }
      throw new BrokerError(
        "state_unavailable",
        `task_graph_source_state_unavailable: ${
          outcome.outcome === "sequence_conflict"
            ? "sequence_resync_conflict_retry_budget_exceeded"
            : outcome.reasonCode
        }`,
      );
    }
  }
}
