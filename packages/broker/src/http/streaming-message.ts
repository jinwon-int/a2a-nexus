import type { IncomingMessage, ServerResponse } from "node:http";

import {
  executeSendMessage,
  specStreamStatusUpdate,
  specStreamTaskSnapshot,
} from "../a2a/json-rpc.js";
import { projectBrokerTask } from "../a2a/task-projection.js";
import { InMemoryA2ABroker } from "../core/broker.js";
import type { TaskRecord } from "../core/types.js";

import { isTerminalSnapshotStatus } from "./task-event-streams.js";
import { attachSseConnectionCleanup, startSseHeartbeat } from "./sse-stream-lifecycle.js";
import { writeSseEvent, writeSseResponseHeaders } from "./sse.js";

/**
 * Parse the raw JSON-RPC body and return the request when it is a single
 * (non-batch) SendStreamingMessage call with a JSON-RPC id, including
 * `id:null`. Returns null for everything else so the generic JSON-RPC executor
 * handles it (including the batch case, which the dispatcher rejects with
 * -32600).
 */
export function parseSingleStreamingMessageRequest(
  rawBody: string,
): { id: string | number | null; params: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (Array.isArray(parsed) || typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const request = parsed as Record<string, unknown>;
  if (request.method !== "SendStreamingMessage") {
    return null;
  }
  if (request.jsonrpc !== "2.0") {
    // Preserve the generic JSON-RPC envelope validation path. The streaming
    // fast path must not accept malformed requests that the unary dispatcher
    // would reject with -32600.
    return null;
  }
  const id = request.id;
  if (typeof id !== "string" && typeof id !== "number" && id !== null) {
    // A streaming notification is meaningless: there is no id to correlate
    // streamed envelopes with. Let the generic layer answer.
    return null;
  }
  return { id, params: request.params };
}

/**
 * A2A 1.0 SendStreamingMessage response: an SSE stream where every data
 * payload is a JSON-RPC result envelope correlated by the request id. The
 * opening event carries the SendMessage result (context + task snapshot);
 * subsequent task-status-update events stream until the task is terminal.
 * SSE event ids reuse the broker's task-event sequence so Last-Event-Id
 * reconnects on /a2a/tasks/:id/events can resume the same stream.
 *
 * `responseShape: "spec"` (clients that negotiated an A2A-Version header)
 * streams A2A 1.0 StreamResponse oneofs — { task } for the opening snapshot
 * and { statusUpdate } for subsequent events — while "legacy" keeps the
 * historical envelopes for header-less plugin clients.
 */
export function handleStreamingMessageResponse(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  params: {
    broker: InMemoryA2ABroker;
    rpcId: string | number | null;
    sendResult: ReturnType<typeof executeSendMessage>;
    task: TaskRecord;
    heartbeatMs: number;
    responseShape?: "spec" | "legacy";
  },
): void {
  const { broker, rpcId, sendResult, task, heartbeatMs } = params;
  const spec = params.responseShape === "spec";

  writeSseResponseHeaders(res);

  const envelope = (result: Record<string, unknown>): Record<string, unknown> => ({
    jsonrpc: "2.0",
    id: rpcId,
    result,
  });

  const snapshotSeq = broker.replayTaskEvents(task.id, -1).length;
  writeSseEvent(
    res,
    "task-snapshot",
    envelope(
      spec
        ? specStreamTaskSnapshot(task, broker)
        : {
            ...sendResult,
            task: projectBrokerTask(task),
            final: isTerminalSnapshotStatus(task.status),
          },
    ),
    broker.formatSseEventId(task.id, snapshotSeq > 0 ? snapshotSeq : 0),
  );

  if (isTerminalSnapshotStatus(task.status)) {
    res.end();
    return;
  }

  let stopHeartbeat: () => void = () => undefined;
  let unsubscribe: (() => void) | null = null;

  const cleanup = (): void => {
    stopHeartbeat();
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  unsubscribe = broker.subscribeToTask(task.id, (update) => {
    writeSseEvent(
      res,
      "task-status-update",
      envelope(
        spec
          ? specStreamStatusUpdate(update.task, update.final)
          : {
              task: projectBrokerTask(update.task),
              reason: update.reason,
              final: update.final,
            },
      ),
      broker.formatSseEventId(task.id, update.seq),
    );
    if (update.final) {
      cleanup();
      if (!res.writableEnded) {
        res.end();
      }
    }
  });

  attachSseConnectionCleanup(req, res, cleanup);

  if (heartbeatMs > 0) {
    stopHeartbeat = startSseHeartbeat(res, heartbeatMs, cleanup);
  }
}
