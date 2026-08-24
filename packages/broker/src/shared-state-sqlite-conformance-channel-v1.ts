/**
 * TEST-ONLY conformance channel: one worker thread carrying both the closed
 * lane protocol and the conformance control family.
 *
 * The lane must never see a control message. Its `#receive` treats an
 * unrecognised envelope as a crossed response and declares the dispatched
 * ticket ambiguous, so leaking one control reply into the lane would fail every
 * subsequent query closed for reasons that have nothing to do with the harness
 * under test. This module is the filter that prevents it.
 *
 * Both families ride one `MessagePort`, which is what makes the harnesses' sync
 * `void` arm/apply methods work in worker mode: `postMessage` delivery is
 * ordered, so a control posted before the next lane request is applied before
 * that request executes even though the caller never awaits it.
 */
import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildSharedStateSqliteConformanceRequestV1,
  isSharedStateSqliteConformanceMessageV1,
  parseSharedStateSqliteConformanceReplyV1,
  type SharedStateSqliteConformanceControlNameV1,
} from "./shared-state-sqlite-conformance-control-v1.js";
import type {
  SharedStateSqliteWorkerChannelFactoryV1,
  SharedStateSqliteWorkerChannelHandlersV1,
  SharedStateSqliteWorkerChannelV1,
} from "./shared-state-sqlite-worker-lane-v1.js";
import type { SharedStateSqliteWorkerRequestV1 } from "./shared-state-sqlite-worker-protocol-v1.js";
import type { SharedStateSqliteWorkerBootstrapV1 } from "./shared-state-sqlite-worker-runtime-v1.js";

const ENTRY_BASENAME = "shared-state-sqlite-conformance-worker-entry-v1";

export function resolveSharedStateSqliteConformanceEntryPathV1(): string {
  const directory = dirname(fileURLToPath(import.meta.url));
  const compiled = join(directory, `${ENTRY_BASENAME}.js`);
  if (existsSync(compiled)) return compiled;
  const source = join(directory, `${ENTRY_BASENAME}.ts`);
  if (existsSync(source)) return source;
  return compiled;
}

export interface SharedStateSqliteConformanceChannelV1 {
  /** Hand this to `createSharedStateSqliteWorkerLaneV1`. */
  readonly laneChannel: SharedStateSqliteWorkerChannelFactoryV1;
  /**
   * Sends a control and resolves with its reply value. Rejects when the worker
   * reports the control failed, so a broken probe surfaces as a test error
   * rather than as a silently empty snapshot.
   */
  control(
    name: SharedStateSqliteConformanceControlNameV1,
    input?: unknown,
  ): Promise<unknown>;
  /**
   * Sends a control without awaiting it, for the harness methods typed
   * `: void`. Ordering against later lane requests is still guaranteed.
   */
  send(
    name: SharedStateSqliteConformanceControlNameV1,
    input?: unknown,
  ): void;
  terminate(): Promise<void>;
}

export function createSharedStateSqliteConformanceChannelV1(
  bootstrap: SharedStateSqliteWorkerBootstrapV1,
): SharedStateSqliteConformanceChannelV1 {
  const worker = new Worker(resolveSharedStateSqliteConformanceEntryPathV1(), {
    workerData: {
      filePath: bootstrap.filePath,
      ownerToken: bootstrap.ownerToken,
      backwardSkewToleranceMs: bootstrap.backwardSkewToleranceMs,
    },
  });

  const pending = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  let nextSequence = 1n;
  let terminating = false;
  let laneMessage: ((message: unknown) => void) | null = null;
  let laneLoss:
    | ((reason: "worker_error" | "worker_exit") => void)
    | null = null;

  worker.on("message", (message: unknown) => {
    if (isSharedStateSqliteConformanceMessageV1(message)) {
      const reply = parseSharedStateSqliteConformanceReplyV1(message);
      if (!reply) return;
      const waiter = pending.get(reply.sequence);
      if (!waiter) return;
      pending.delete(reply.sequence);
      if (reply.ok) waiter.resolve(reply.value);
      else {
        waiter.reject(
          new Error(
            `conformance control ${reply.control} failed: ${reply.failure ?? "unknown"}`,
          ),
        );
      }
      return;
    }
    laneMessage?.(message);
  });

  const failPending = (reason: string): void => {
    for (const [, waiter] of pending) {
      waiter.reject(new Error(`conformance worker ${reason}`));
    }
    pending.clear();
  };

  worker.on("error", () => {
    failPending("error");
    laneLoss?.("worker_error");
  });
  worker.on("exit", () => {
    failPending("exit");
    if (!terminating) laneLoss?.("worker_exit");
  });

  const post = (
    name: SharedStateSqliteConformanceControlNameV1,
    input: unknown,
  ): string => {
    const sequence = nextSequence.toString();
    nextSequence += 1n;
    worker.postMessage(
      buildSharedStateSqliteConformanceRequestV1(sequence, name, input),
    );
    return sequence;
  };

  return Object.freeze({
    laneChannel: (
      handlers: SharedStateSqliteWorkerChannelHandlersV1,
    ): SharedStateSqliteWorkerChannelV1 => {
      laneMessage = handlers.onMessage;
      laneLoss = handlers.onLoss;
      return Object.freeze({
        post(request: SharedStateSqliteWorkerRequestV1): void {
          worker.postMessage(request);
        },
        async terminate(): Promise<void> {
          if (terminating) return;
          terminating = true;
          await worker.terminate();
        },
      });
    },

    control(
      name: SharedStateSqliteConformanceControlNameV1,
      input?: unknown,
    ): Promise<unknown> {
      return new Promise<unknown>((resolve, reject) => {
        const sequence = post(name, input ?? null);
        pending.set(sequence, { resolve, reject });
      });
    },

    send(
      name: SharedStateSqliteConformanceControlNameV1,
      input?: unknown,
    ): void {
      post(name, input ?? null);
    },

    async terminate(): Promise<void> {
      if (terminating) return;
      terminating = true;
      failPending("terminated");
      await worker.terminate();
    },
  });
}
