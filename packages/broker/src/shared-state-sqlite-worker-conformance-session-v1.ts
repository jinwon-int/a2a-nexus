/**
 * TEST-ONLY worker-mode session for conformance targets.
 *
 * Every Phase 2 harness closes a target and reopens it, because continuity
 * across a clean close is part of what the contract promises. Inline targets
 * satisfy that by calling `open()` again on an adapter that still holds its
 * connection. Worker mode cannot: a clean close releases ownership and
 * terminates the thread, and the lane refuses to reopen a closed lane by
 * design — a lane that quietly reopened would be creating a replacement
 * authority, which decision W0 forbids.
 *
 * So a reopen here spawns a new worker against the same file. That is a
 * stronger proof than the inline reopen rather than a weaker one: the new
 * worker has to acquire ownership from scratch, which only succeeds if the
 * previous close really released it. An unclean close leaves the token set and
 * the reopen fails, exactly as it should.
 *
 * This lives in its own module because five more harnesses need it, and each
 * one reimplementing the lifecycle would be five chances to get ownership
 * release subtly wrong.
 */
import {
  createSharedStateSqliteConformanceChannelV1,
  type SharedStateSqliteConformanceChannelV1,
} from "./shared-state-sqlite-conformance-channel-v1.js";
import type { SharedStateSqliteAdapterResultV1 } from "./shared-state-sqlite-adapter-v1.js";
import {
  createSharedStateSqliteWorkerLaneV1,
  type SharedStateSqliteWorkerLaneV1,
} from "./shared-state-sqlite-worker-lane-v1.js";
import type { SharedStateStorageLifecycleV1 } from "./shared-state-storage-contract-v1.js";

export interface SharedStateSqliteWorkerConformanceSessionOptionsV1 {
  readonly filePath: string;
  readonly ownerToken: string;
  readonly backwardSkewToleranceMs: string;
  /**
   * Must be at least the harness's peak concurrency. A saturated lane answers
   * the surplus with an operation-preserving `unavailable` result, which is
   * correct lane behaviour but indistinguishable to a harness from an adapter
   * that answered inconsistently.
   */
  readonly queueCapacity: number;
  readonly acknowledgmentTimeoutMs: number;
  readonly drainTimeoutMs: number;
}

export interface SharedStateSqliteWorkerConformanceSessionV1 {
  /** The live lane. Throws if the session is not open. */
  lane(): SharedStateSqliteWorkerLaneV1;
  /** The live control channel. Throws if the session is not open. */
  channel(): SharedStateSqliteConformanceChannelV1;
  /**
   * A control channel for observation, spawning a worker if none is live but
   * never opening the lane on it.
   *
   * Phase 2.4 needs this: it crashes a target and then asks for a snapshot
   * before reopening, so the committed state has to be readable while no
   * lifecycle is held. Controls read the raw connection and do not require an
   * open adapter, so this observes without acquiring ownership. A later `open`
   * still opens the lane normally on the worker this spawned.
   */
  observationChannel(): SharedStateSqliteConformanceChannelV1;
  /** Spawns a worker if needed and opens the lane on it. */
  open(): Promise<
    SharedStateSqliteAdapterResultV1<SharedStateStorageLifecycleV1>
  >;
  /**
   * Drains, closes, and only then terminates the worker.
   *
   * `toleratesDrainFailure` exists for Phase 2.4, where a forbidden write
   * leaves the adapter failed and `drain` legitimately refuses. The inline
   * target branches on the adapter's lifecycle to skip drain in that case;
   * tolerating the refusal is the same thing said from the lane's side. It is
   * opt-in so an ordinary close still surfaces a drain that should have worked.
   */
  close(options?: {
    readonly toleratesDrainFailure?: boolean;
  }): Promise<
    SharedStateSqliteAdapterResultV1<SharedStateStorageLifecycleV1>
  >;
  /**
   * Simulates a crash: best-effort drain and close, then teardown, ignoring
   * every failure. A crash takes the process down, so the harness reopens with
   * no close of its own and the target must leave the file in a state a bare
   * open can legally acquire — which means ownership has to be released, the
   * same thing the inline target does.
   */
  crashForConformance(): Promise<void>;
  /** Forced teardown for fixtures. Never claims ownership was released. */
  dispose(): Promise<void>;
  /**
   * Points the next `open` at a different file.
   *
   * This exists only for the adversarial control that reopens onto an empty
   * database to prove the harness catches silent state loss. Nothing in a
   * passing run calls it, and it cannot affect a session that is already open —
   * it takes effect on the next spawn.
   */
  rebindFilePathForViolation(filePath: string): void;
}

export function createSharedStateSqliteWorkerConformanceSessionV1(
  options: SharedStateSqliteWorkerConformanceSessionOptionsV1,
): SharedStateSqliteWorkerConformanceSessionV1 {
  let channel: SharedStateSqliteConformanceChannelV1 | null = null;
  let lane: SharedStateSqliteWorkerLaneV1 | null = null;
  let filePath = options.filePath;

  const spawn = (): {
    channel: SharedStateSqliteConformanceChannelV1;
    lane: SharedStateSqliteWorkerLaneV1;
  } => {
    const next = createSharedStateSqliteConformanceChannelV1({
      filePath,
      ownerToken: options.ownerToken,
      backwardSkewToleranceMs: options.backwardSkewToleranceMs,
    });
    return {
      channel: next,
      lane: createSharedStateSqliteWorkerLaneV1({
        channel: next.laneChannel,
        queueCapacity: options.queueCapacity,
        acknowledgmentTimeoutMs: options.acknowledgmentTimeoutMs,
        drainTimeoutMs: options.drainTimeoutMs,
      }),
    };
  };

  return Object.freeze({
    lane(): SharedStateSqliteWorkerLaneV1 {
      if (lane === null) {
        throw new Error("worker conformance session is not open");
      }
      return lane;
    },

    channel(): SharedStateSqliteConformanceChannelV1 {
      if (channel === null) {
        throw new Error("worker conformance session is not open");
      }
      return channel;
    },

    observationChannel(): SharedStateSqliteConformanceChannelV1 {
      if (channel === null || lane === null) {
        const spawned = spawn();
        channel = spawned.channel;
        lane = spawned.lane;
      }
      return channel;
    },

    async open(): Promise<
      SharedStateSqliteAdapterResultV1<SharedStateStorageLifecycleV1>
    > {
      if (lane === null || channel === null) {
        const spawned = spawn();
        channel = spawned.channel;
        lane = spawned.lane;
      }
      return lane.open();
    },

    async close(options?: {
      readonly toleratesDrainFailure?: boolean;
    }): Promise<
      SharedStateSqliteAdapterResultV1<SharedStateStorageLifecycleV1>
    > {
      if (lane === null || channel === null) {
        throw new Error("worker conformance session is not open");
      }
      const drained = await lane.drain();
      if (!drained.ok && options?.toleratesDrainFailure !== true) {
        return drained;
      }
      const closed = await lane.close();
      if (!closed.ok) return closed;
      // `lane.close` already terminated the thread after ownership release.
      // Dropping the references is what lets the next `open` acquire fresh.
      await channel.terminate();
      channel = null;
      lane = null;
      return closed;
    },

    async crashForConformance(): Promise<void> {
      const liveLane = lane;
      const liveChannel = channel;
      channel = null;
      lane = null;
      if (liveLane !== null) {
        try {
          await liveLane.drain();
          await liveLane.close();
        } catch {
          // A crash tolerates every failure on the way down.
        }
      }
      if (liveChannel !== null) {
        try {
          await liveChannel.terminate();
        } catch {
          // Same.
        }
      }
    },

    rebindFilePathForViolation(next: string): void {
      filePath = next;
    },

    async dispose(): Promise<void> {
      const live = channel;
      channel = null;
      lane = null;
      if (live === null) return;
      try {
        await live.terminate();
      } catch {
        // Fixture cleanup continues regardless.
      }
    },
  });
}
