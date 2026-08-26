import type { IncomingMessage, ServerResponse } from "node:http";

import { specTaskStateName } from "../a2a/json-rpc.js";
import { projectBrokerTask } from "../a2a/task-projection.js";
import { InMemoryA2ABroker } from "../core/broker.js";
import type { TaskUpdate } from "../core/broker.js";
import type { TaskStatusEvent, TerminalTaskEvent } from "../core/task-events.js";
import type { TaskRecord, TaskStatus } from "../core/types.js";

import {
  attachSseConnectionCleanup,
  parseSseReplayAfterId,
  startSseHeartbeat,
} from "./sse-stream-lifecycle.js";
import { writeSseEvent, writeSseResponseHeaders } from "./sse.js";

export function handleWorkerAssignmentEventStream(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  params: {
    broker: InMemoryA2ABroker;
    workerId: string;
    heartbeatMs: number;
    /** Test seam: invoked at the snapshot→subscribe boundary to exercise the gap. */
    afterSnapshot?: () => void;
  },
): void {
  const { broker, workerId, heartbeatMs, afterSnapshot } = params;
  const stream = broker.getTaskEventStream();

  writeSseResponseHeaders(res);

  const afterId = parseSseReplayAfterId(req.headers["last-event-id"] as string | undefined);

  let stopHeartbeat: () => void = () => undefined;
  let unsubscribe: (() => void) | null = null;

  const cleanup = (): void => {
    stopHeartbeat();
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  // Gap-safe ordering: register the live subscription FIRST and buffer events
  // until the snapshot + replay have been written, then flush deduped by event
  // id. Registering after the snapshot would drop any assignment emitted in the
  // snapshot→subscribe window.
  let flushed = false;
  let lastSentId = afterId;
  const pending: TaskStatusEvent[] = [];
  const sendAssignment = (event: TaskStatusEvent): void => {
    if (!isWorkerAssignmentEvent(event, workerId)) {
      return;
    }
    if (event.id <= lastSentId) {
      return;
    }
    lastSentId = event.id;
    writeSseEvent(res, "worker-assignment", buildWorkerAssignmentEvent(event), String(event.id));
  };

  unsubscribe = stream.onStatus((event) => {
    if (!flushed) {
      pending.push(event);
      return;
    }
    sendAssignment(event);
  });

  attachSseConnectionCleanup(req, res, cleanup);

  const queuedTasks = broker.listTasks({ assignedWorkerId: workerId, status: "queued" });
  writeSseEvent(res, "worker-assignment-snapshot", {
    workerId,
    count: queuedTasks.length,
    tasks: queuedTasks.map((task) => ({
      taskId: task.id,
      status: task.status,
      assignedWorkerId: task.assignedWorkerId ?? task.targetNodeId,
      updatedAt: task.updatedAt,
    })),
  });

  for (const event of stream.subscribe({ afterId })) {
    sendAssignment(event);
  }

  afterSnapshot?.();

  flushed = true;
  for (const event of pending) {
    sendAssignment(event);
  }
  pending.length = 0;

  if (heartbeatMs > 0) {
    stopHeartbeat = startSseHeartbeat(res, heartbeatMs, cleanup);
  }
}

export function isWorkerAssignmentEvent(event: TaskStatusEvent, workerId: string): boolean {
  return (
    event.status === "queued" &&
    event.metadata.assignedWorkerId === workerId &&
    (event.kind === "created" ||
      event.kind === "approved" ||
      event.kind === "reassigned" ||
      event.kind === "requeued")
  );
}

export function buildWorkerAssignmentEvent(event: TaskStatusEvent): {
  id: number;
  taskId: string;
  status: TaskStatus;
  reason: TaskStatusEvent["kind"];
  assignedWorkerId: string;
  updatedAt: string;
  metadata: TaskStatusEvent["metadata"];
} {
  return {
    id: event.id,
    taskId: event.taskId,
    status: event.status,
    reason: event.kind,
    assignedWorkerId: event.metadata.assignedWorkerId ?? "",
    updatedAt: event.timestamp,
    metadata: event.metadata,
  };
}

export function handleTerminalTaskEventStream(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  params: {
    broker: InMemoryA2ABroker;
    heartbeatMs: number;
  },
): void {
  const { broker, heartbeatMs } = params;
  const stream = broker.getTaskEventStream();

  writeSseResponseHeaders(res);

  const afterId = parseSseReplayAfterId(req.headers["last-event-id"] as string | undefined);

  let stopHeartbeat: () => void = () => undefined;
  let unsubscribe: (() => void) | null = null;

  const cleanup = (): void => {
    stopHeartbeat();
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  // Gap-safe ordering: register the live subscription before replaying buffered
  // events so a terminal event emitted during replay is buffered and flushed
  // (deduped by id) instead of dropped.
  let flushed = false;
  let lastSentId = afterId;
  const pending: TerminalTaskEvent[] = [];
  const sendTerminal = (event: TerminalTaskEvent): void => {
    if (event.id <= lastSentId) {
      return;
    }
    lastSentId = event.id;
    writeSseEvent(res, "task-terminal", event, String(event.id));
  };

  unsubscribe = stream.onTerminal((event) => {
    if (!flushed) {
      pending.push(event);
      return;
    }
    sendTerminal(event);
  });

  for (const event of stream.subscribeTerminal({ afterId })) {
    sendTerminal(event);
  }

  flushed = true;
  for (const event of pending) {
    sendTerminal(event);
  }
  pending.length = 0;

  attachSseConnectionCleanup(req, res, cleanup);

  // Match the other SSE handlers: skip the heartbeat entirely when disabled
  // (heartbeatMs <= 0) — otherwise setInterval(..., 0) becomes a ~1ms
  // busy-loop — and unref the timer so it never keeps the process alive.
  if (heartbeatMs > 0) {
    stopHeartbeat = startSseHeartbeat(res, heartbeatMs, cleanup);
  }
}

export function handleTaskEventStream(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  params: {
    broker: InMemoryA2ABroker;
    task: TaskRecord;
    heartbeatMs: number;
    /**
     * Task payload encoding: "spec" (client negotiated an A2A-Version header)
     * projects the v1.0 ProtoJSON Task (TASK_STATE_* states); "legacy" keeps
     * the historical lowercase projection for header-less clients (#1912 D1).
     */
    responseShape?: "spec" | "legacy";
    /** Test seam: invoked at the snapshot→subscribe boundary to exercise the gap. */
    afterSnapshot?: () => void;
  },
): void {
  const { broker, task, heartbeatMs, afterSnapshot } = params;
  const spec = params.responseShape === "spec";
  // This route is a broker extension, so the envelope (event names, reason,
  // final, projection fields) stays identical in both shapes — only the
  // status.state vocabulary flips to the v1.0 ProtoJSON encoding for
  // negotiated clients (#1912 D1). Full spec Task shapes (contextId, ProtoJSON
  // artifacts) remain the JSON-RPC spec path's contract.
  const projectForShape = (record: TaskRecord): Record<string, unknown> => {
    const projected = projectBrokerTask(record) as unknown as Record<string, unknown>;
    if (spec) {
      (projected.status as Record<string, unknown>).state = specTaskStateName(
        (projected.status as { state: Parameters<typeof specTaskStateName>[0] }).state,
      );
    }
    return projected;
  };

  writeSseResponseHeaders(res);

  // Parse Last-Event-ID for reconnect replay.
  const lastEventIdHeader = req.headers["last-event-id"] as string | undefined;
  let replayAfterSeq = -1;
  if (lastEventIdHeader) {
    const parsed = broker.parseSseEventId(lastEventIdHeader);
    if (parsed && parsed.taskId === task.id) {
      replayAfterSeq = parsed.seq;
    }
  }

  // Already-terminal task: emit the snapshot and close. No future updates fire,
  // so there is no subscription to register and no race to close.
  if (isTerminalSnapshotStatus(task.status)) {
    const snapshotSeq = broker.countBufferedTaskEvents(task.id);
    writeSseEvent(
      res,
      "task-snapshot",
      { task: projectForShape(task), reason: "snapshot", final: true },
      broker.formatSseEventId(task.id, snapshotSeq > 0 ? snapshotSeq : 0),
    );
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

  // Gap-safe ordering: register the live subscription FIRST and buffer updates
  // until replay + snapshot have been written, then flush deduped by seq. The
  // snapshot SSE id keeps its existing value (buffered-event count) for
  // reconnect compatibility, while dedup uses the true high-watermark (the max
  // buffered seq) so a live update emitted in the snapshot→subscribe window is
  // delivered exactly once.
  let flushed = false;
  let lastSentSeq = replayAfterSeq >= 0 ? replayAfterSeq : -1;
  const pending: TaskUpdate[] = [];
  const sendUpdate = (update: TaskUpdate): void => {
    if (update.seq <= lastSentSeq) {
      return;
    }
    lastSentSeq = update.seq;
    writeSseEvent(
      res,
      "task-status-update",
      {
        task: projectForShape(update.task),
        reason: update.reason,
        final: update.final,
      },
      broker.formatSseEventId(task.id, update.seq),
    );
    if (update.final) {
      cleanup();
      if (!res.writableEnded) {
        res.end();
      }
    }
  };

  unsubscribe = broker.subscribeToTask(task.id, (update) => {
    if (!flushed) {
      pending.push(update);
      return;
    }
    sendUpdate(update);
  });

  attachSseConnectionCleanup(req, res, cleanup);

  // Replay missed events first when reconnecting with a valid Last-Event-ID.
  if (replayAfterSeq >= 0) {
    const missed = broker.replayTaskEvents(task.id, replayAfterSeq);
    for (const buffered of missed) {
      writeSseEvent(
        res,
        buffered.event,
        {
          task: projectForShape(buffered.data.task),
          reason: buffered.data.reason,
          final: buffered.data.final,
        },
        broker.formatSseEventId(task.id, buffered.seq),
      );
      if (buffered.seq > lastSentSeq) {
        lastSentSeq = buffered.seq;
      }
    }
  }

  // Always send a fresh snapshot as the opening event.
  const buffered = broker.replayTaskEvents(task.id, -1);
  const snapshotSeq = buffered.length; // existing snapshot SSE id (buffered-event count)
  const watermarkSeq = buffered.length ? buffered[buffered.length - 1]!.seq : 0;
  writeSseEvent(
    res,
    "task-snapshot",
    {
      task: projectForShape(task),
      reason: "snapshot",
      final: false,
    },
    broker.formatSseEventId(task.id, snapshotSeq > 0 ? snapshotSeq : 0),
  );
  if (watermarkSeq > lastSentSeq) {
    lastSentSeq = watermarkSeq;
  }

  afterSnapshot?.();

  // Flush updates buffered during replay/snapshot, then stream live.
  flushed = true;
  for (const update of pending) {
    sendUpdate(update);
  }
  pending.length = 0;

  if (heartbeatMs > 0) {
    stopHeartbeat = startSseHeartbeat(res, heartbeatMs, cleanup);
  }
}

export function isTerminalSnapshotStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}
