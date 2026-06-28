// Task event dispatch/buffering collaborator extracted from the InMemoryA2ABroker
// god-class. Owns the per-task subscriber listeners, the replay buffers and their
// sequence numbers, and the prune-listener set. The broker holds one instance and
// delegates its task-event subscribe/emit/replay/prune surface to it.
//
// The TaskUpdate/TaskUpdateListener/BufferedTaskEvent/TaskUpdateReason types are
// defined and exported by broker.ts (public surface); they are imported here
// type-only, so there is no runtime import cycle.
import { pruneMapEntries } from "./broker-retention-selectors.js";
import { isTerminalTaskStatus } from "./broker-status-predicates.js";
import type { TaskRecord } from "./types.js";
import type {
  BufferedTaskEvent,
  TaskUpdate,
  TaskUpdateListener,
  TaskUpdateReason,
} from "./broker.js";

export class TaskEventDispatcher {
  private readonly listeners = new Map<string, Set<TaskUpdateListener>>();
  private readonly pruneListeners = new Set<(prunedTaskIds: string[]) => void>();
  private readonly buffers = new Map<string, BufferedTaskEvent[]>();
  private readonly seqs = new Map<string, number>();

  constructor(private readonly maxBufferedEventsPerTask: number) {}

  subscribe(taskId: string, listener: TaskUpdateListener): () => void {
    let listeners = this.listeners.get(taskId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(taskId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.listeners.get(taskId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(taskId);
      }
    };
  }

  registerPruneListener(listener: (prunedTaskIds: string[]) => void): () => void {
    this.pruneListeners.add(listener);
    return () => {
      this.pruneListeners.delete(listener);
    };
  }

  emit(task: TaskRecord, reason: TaskUpdateReason): void {
    const listeners = this.listeners.get(task.id);
    const hasActiveSubscribers = listeners && listeners.size > 0;
    const hasBuffer = this.buffers.has(task.id);

    if (!hasActiveSubscribers && !hasBuffer) {
      return;
    }

    const final = isTerminalTaskStatus(task.status);
    const seq = this.advanceSeq(task.id);
    // Snapshot the listener set and clone the task so a listener that mutates its copy (or
    // the broker mutating later) can't alter what other subscribers observe.
    const snapshot: TaskUpdate = {
      task: structuredClone(task),
      reason,
      final,
      seq,
    };

    // Buffer event for replay even if no active subscribers.
    this.bufferEvent(task.id, {
      seq,
      event: "task-status-update",
      data: snapshot,
    });

    if (!hasActiveSubscribers) {
      return;
    }
    for (const listener of [...listeners!]) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error(
          `[a2a-broker] task subscriber for ${task.id} threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** Replay buffered events after the given sequence number. Returns events with seq > afterSeq. */
  replay(taskId: string, afterSeq: number): BufferedTaskEvent[] {
    const buffer = this.buffers.get(taskId);
    if (!buffer) {
      return [];
    }
    return buffer.filter((e) => e.seq > afterSeq);
  }

  /** Number of tasks with a non-empty replay buffer (compact diagnostics). */
  bufferedStreamCount(): number {
    return this.buffers.size;
  }

  /**
   * Prune replay buffers and sequence numbers for tasks no longer retained, then
   * notify prune listeners with the ids actually removed. A listener failure must
   * never break retention.
   */
  prune(retainedTaskIds: Set<string>, prunedTaskIds: string[]): void {
    pruneMapEntries(this.buffers, retainedTaskIds);
    pruneMapEntries(this.seqs, retainedTaskIds);

    if (prunedTaskIds.length > 0) {
      for (const listener of this.pruneListeners) {
        try {
          listener(prunedTaskIds);
        } catch {
          // A cleanup listener failure must never break retention itself.
        }
      }
    }
  }

  private advanceSeq(taskId: string): number {
    const current = this.seqs.get(taskId) ?? 0;
    const next = current + 1;
    this.seqs.set(taskId, next);
    return next;
  }

  private bufferEvent(taskId: string, event: BufferedTaskEvent): void {
    let buffer = this.buffers.get(taskId);
    if (!buffer) {
      buffer = [];
      this.buffers.set(taskId, buffer);
    }
    buffer.push(event);
    // Trim oldest events beyond the limit.
    if (buffer.length > this.maxBufferedEventsPerTask) {
      buffer.splice(0, buffer.length - this.maxBufferedEventsPerTask);
    }
  }
}
