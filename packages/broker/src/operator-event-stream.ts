// Operator SSE event stream, extracted from createBrokerServer in server.ts.
// Owns the subscriber set, the bounded replay buffer, and the monotonic sequence
// number for the operator dashboard's server-sent-event channel. Mirrors the
// broker's TaskEventDispatcher collaborator pattern: the server keeps the
// broker-coupled projection logic (snapshot/alert diffing) and delegates the
// subscribe/emit/replay mechanics here.
//
// The event-shape types are defined and exported by server.ts; they are imported
// here type-only, so there is no runtime import cycle.
import type {
  BufferedOperatorEvent,
  OperatorEventName,
  OperatorEventPayload,
  OperatorReplayWindow,
} from "./server.js";

export class OperatorEventStream {
  private readonly listeners = new Set<(event: BufferedOperatorEvent) => void>();
  private readonly buffer: BufferedOperatorEvent[] = [];
  private seq = 0;

  constructor(private readonly bufferLimit: number) {}

  /** Number of active subscribers; lets callers skip projections while idle. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  subscribe(listener: (event: BufferedOperatorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Buffer the event (trimming to the limit) and notify every subscriber. */
  emit(event: OperatorEventName, data: OperatorEventPayload): void {
    const buffered: BufferedOperatorEvent = {
      seq: this.seq + 1,
      event,
      data: structuredClone(data),
    };
    this.seq = buffered.seq;
    this.buffer.push(buffered);
    if (this.buffer.length > this.bufferLimit) {
      this.buffer.splice(0, this.buffer.length - this.bufferLimit);
    }

    for (const listener of [...this.listeners]) {
      try {
        listener(buffered);
      } catch (error) {
        console.error(
          `[a2a-broker] operator subscriber threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** Buffered events with seq greater than afterSeq (for SSE replay on reconnect). */
  replay(afterSeq: number): BufferedOperatorEvent[] {
    return this.buffer.filter((event) => event.seq > afterSeq);
  }

  replayWindow(): OperatorReplayWindow {
    return {
      oldestBufferedSeq: this.buffer[0]?.seq ?? null,
      currentSeq: this.seq,
    };
  }
}
