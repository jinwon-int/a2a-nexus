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
 * Resync, documented trade-off: the adapter exposes no sequence read, so a
 * cold-started gate — or one another append authority has raced past — holds
 * a stale counter. On a `source_sequence_conflict` the gate probes upward
 * from its counter — rejected transactions allocate nothing and are cheap —
 * until the append is accepted. The counter is updated only monotonically
 * upward from committed appended/replayed results (BigInt comparison), so a
 * replayed historical fact returns that fact's ORIGINAL sequence without
 * regressing the warm cache into re-probing, and no high-water is ever
 * invented. The proper fix is a sequence-read query (§6 follow-up, open).
 */

import { BrokerError } from "./core/broker-error.js";
import type { SharedStateServingFenceV1 } from "./shared-state-serving-fence-v1.js";

/** Bound on the cold-start resync probe; beyond it the gate fails closed. */
const GRAPH_SOURCE_RESYNC_PROBE_LIMIT = 1_000_000;

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
    let attempts = 0;
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
        && attempts < GRAPH_SOURCE_RESYNC_PROBE_LIMIT
      ) {
        // Cold-start resync: walk the tracked counter up to the durable
        // high-water. Rejected transactions allocate nothing.
        attempts += 1;
        this.#expectedSequence += 1n;
        continue;
      }
      throw new BrokerError(
        "state_unavailable",
        `task_graph_source_state_unavailable: ${
          outcome.outcome === "sequence_conflict"
            ? "sequence_resync_probe_limit_exceeded"
            : outcome.reasonCode
        }`,
      );
    }
  }
}
