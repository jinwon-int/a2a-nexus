import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  BufferedOperatorEvent,
  OperatorReplayWindow,
  OperatorSnapshotEvent,
} from "../server.js";

import { writeSseEvent, writeSseResponseHeaders } from "./sse.js";

export function formatOperatorSseEventId(seq: number): string {
  return `operator:${seq}`;
}

export function parseOperatorSseEventId(raw: string): number | null {
  if (!raw.startsWith("operator:")) {
    return null;
  }
  const seq = Number(raw.slice("operator:".length));
  if (!Number.isFinite(seq) || seq < 0) {
    return null;
  }
  return seq;
}

export function resolveOperatorReplayAfterSeq(
  rawLastEventId: string | undefined,
  replayWindow: OperatorReplayWindow,
): number | null {
  if (!rawLastEventId) {
    return null;
  }

  const parsed = parseOperatorSseEventId(rawLastEventId);
  if (parsed === null) {
    return null;
  }
  if (parsed > replayWindow.currentSeq) {
    return null;
  }
  if (replayWindow.oldestBufferedSeq !== null && parsed < replayWindow.oldestBufferedSeq - 1) {
    return null;
  }

  return parsed;
}

export function handleOperatorEventStream(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  params: {
    currentSnapshot: () => OperatorSnapshotEvent;
    replayEvents: (afterSeq: number) => BufferedOperatorEvent[];
    subscribe: (listener: (event: BufferedOperatorEvent) => void) => () => void;
    replayWindow: () => OperatorReplayWindow;
    heartbeatMs: number;
    /** Test seam: invoked at the snapshot→subscribe boundary to exercise the gap. */
    afterSnapshot?: () => void;
  },
): void {
  writeSseResponseHeaders(res);

  const replayAfterSeq = resolveOperatorReplayAfterSeq(
    req.headers["last-event-id"] as string | undefined,
    params.replayWindow(),
  );

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;

  const cleanup = (): void => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  // Gap-safe ordering: register the live subscription FIRST and buffer events
  // until replay + snapshot have been written, then flush deduped by seq. The
  // operator high-watermark is the replay window's currentSeq at snapshot time;
  // anything beyond it is a live event that must not be dropped.
  let flushed = false;
  let lastSentSeq = replayAfterSeq !== null ? replayAfterSeq : -1;
  const pending: BufferedOperatorEvent[] = [];
  const sendEvent = (event: BufferedOperatorEvent): void => {
    if (event.seq <= lastSentSeq) {
      return;
    }
    lastSentSeq = event.seq;
    writeSseEvent(res, event.event, event.data, formatOperatorSseEventId(event.seq));
  };

  unsubscribe = params.subscribe((event) => {
    if (!flushed) {
      pending.push(event);
      return;
    }
    sendEvent(event);
  });

  req.on("close", () => {
    cleanup();
    if (!res.writableEnded) {
      res.end();
    }
  });
  req.on("error", cleanup);

  if (replayAfterSeq !== null) {
    const missed = params.replayEvents(replayAfterSeq);
    for (const buffered of missed) {
      writeSseEvent(
        res,
        buffered.event,
        buffered.data,
        formatOperatorSseEventId(buffered.seq),
      );
      if (buffered.seq > lastSentSeq) {
        lastSentSeq = buffered.seq;
      }
    }
  }

  const snapshotSeq = params.replayWindow().currentSeq;
  writeSseEvent(
    res,
    "operator-snapshot",
    params.currentSnapshot(),
    formatOperatorSseEventId(snapshotSeq > 0 ? snapshotSeq : 0),
  );
  if (snapshotSeq > lastSentSeq) {
    lastSentSeq = snapshotSeq;
  }

  params.afterSnapshot?.();

  flushed = true;
  for (const event of pending) {
    sendEvent(event);
  }
  pending.length = 0;

  if (params.heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      if (res.writableEnded) {
        cleanup();
        return;
      }
      res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, params.heartbeatMs);
    heartbeatTimer.unref?.();
  }
}
