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
 * Cold-start resync, documented trade-off: the adapter exposes no sequence
 * read, so after a process restart the tracked counter is stale. On a
 * `source_sequence_conflict` the gate probes upward from its counter —
 * rejected transactions allocate nothing and are cheap — until the append is
 * accepted (at most once per process; the counter is warm afterwards). The
 * proper fix is a sequence-read query (§6 follow-up).
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
        // original sequence — no duplicate fact, no invented ordering.
        this.#expectedSequence = BigInt(outcome.sourceSequence);
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
