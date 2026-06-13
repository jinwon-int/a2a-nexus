import type { IncomingMessage, ServerResponse } from "node:http";

import { projectBrokerTask } from "../a2a/task-projection.js";
import { InMemoryA2ABroker } from "../core/broker.js";
import type { TaskStatusEvent } from "../core/task-events.js";
import type { TaskRecord, TaskStatus } from "../core/types.js";

import { writeSseEvent, writeSseResponseHeaders } from "./sse.js";

export function handleWorkerAssignmentEventStream(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  params: {
    broker: InMemoryA2ABroker;
    workerId: string;
    heartbeatMs: number;
  },
): void {
  const { broker, workerId, heartbeatMs } = params;
  const stream = broker.getTaskEventStream();

  writeSseResponseHeaders(res);

  const lastEventIdHeader = req.headers["last-event-id"] as string | undefined;
  const replayAfterId = lastEventIdHeader ? Number(lastEventIdHeader) : -1;
  const afterId = Number.isFinite(replayAfterId) && replayAfterId >= 0 ? replayAfterId : -1;

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
    if (isWorkerAssignmentEvent(event, workerId)) {
      writeSseEvent(res, "worker-assignment", buildWorkerAssignmentEvent(event), String(event.id));
    }
  }

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

  unsubscribe = stream.onStatus((event) => {
    if (isWorkerAssignmentEvent(event, workerId)) {
      writeSseEvent(res, "worker-assignment", buildWorkerAssignmentEvent(event), String(event.id));
    }
  });

  req.on("close", () => {
    cleanup();
    if (!res.writableEnded) {
      res.end();
    }
  });
  req.on("error", cleanup);

  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      if (res.writableEnded) {
        cleanup();
        return;
      }
      res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, heartbeatMs);
    heartbeatTimer.unref?.();
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

  const lastEventIdHeader = req.headers["last-event-id"] as string | undefined;
  const replayAfterId = lastEventIdHeader ? Number(lastEventIdHeader) : -1;
  const afterId = Number.isFinite(replayAfterId) && replayAfterId >= 0 ? replayAfterId : -1;

  for (const event of stream.subscribeTerminal({ afterId })) {
    writeSseEvent(res, "task-terminal", event, String(event.id));
  }

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

  unsubscribe = stream.onTerminal((event) => {
    writeSseEvent(res, "task-terminal", event, String(event.id));
  });

  req.on("close", () => {
    cleanup();
    if (!res.writableEnded) {
      res.end();
    }
  });
  req.on("error", cleanup);

  // Match the other SSE handlers: skip the heartbeat entirely when disabled
  // (heartbeatMs <= 0) — otherwise setInterval(..., 0) becomes a ~1ms
  // busy-loop — and unref the timer so it never keeps the process alive.
  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      if (res.writableEnded) {
        cleanup();
        return;
      }
      res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }
}

export function handleTaskEventStream(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
  params: {
    broker: InMemoryA2ABroker;
    task: TaskRecord;
    heartbeatMs: number;
  },
): void {
  const { broker, task, heartbeatMs } = params;

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

  // If reconnecting with a valid Last-Event-ID, replay missed events first.
  if (replayAfterSeq >= 0) {
    const missed = broker.replayTaskEvents(task.id, replayAfterSeq);
    for (const buffered of missed) {
      writeSseEvent(
        res,
        buffered.event,
        {
          task: projectBrokerTask(buffered.data.task),
          reason: buffered.data.reason,
          final: buffered.data.final,
        },
        broker.formatSseEventId(task.id, buffered.seq),
      );
    }
  }

  // Always send a fresh snapshot as the opening event.
  const snapshotSeq = broker.replayTaskEvents(task.id, -1).length;
  // Use seq=0 for the initial snapshot if no buffered events exist.
  writeSseEvent(
    res,
    "task-snapshot",
    {
      task: projectBrokerTask(task),
      reason: "snapshot",
      final: isTerminalSnapshotStatus(task.status),
    },
    broker.formatSseEventId(task.id, snapshotSeq > 0 ? snapshotSeq : 0),
  );

  if (isTerminalSnapshotStatus(task.status)) {
    // Nothing further will fire for an already-terminal task. Close immediately so the
    // caller doesn't hold the connection open waiting for an update that never comes.
    res.end();
    return;
  }

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

  unsubscribe = broker.subscribeToTask(task.id, (update) => {
    writeSseEvent(
      res,
      "task-status-update",
      {
        task: projectBrokerTask(update.task),
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
  });

  req.on("close", () => {
    cleanup();
    if (!res.writableEnded) {
      res.end();
    }
  });
  req.on("error", cleanup);

  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      if (res.writableEnded) {
        cleanup();
        return;
      }
      res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }
}

export function isTerminalSnapshotStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}
