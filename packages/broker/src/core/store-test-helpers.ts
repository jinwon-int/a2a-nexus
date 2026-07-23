import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  type BrokerSnapshot,
} from "./store.js";
import type { TerminalTaskOutboxEvent } from "./terminal-event-outbox.js";

export function withTempFile(name: string): {
  dir: string;
  filePath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "a2a-broker-store-"));
  return {
    dir,
    filePath: join(dir, name),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function readSqliteCount(db: DatabaseSync, tableName: string): number {
  const row = db.prepare(`SELECT count(*) AS count FROM ${tableName}`).get() as { count: number };
  return row.count;
}

export function makeWorker(nodeId: string): BrokerSnapshot["workers"][number] {
  return {
    nodeId,
    role: "analyst",
    capabilities: {
      canAnalyze: true,
      canBackfill: false,
      canPatchWorkspace: false,
      canPromoteLive: false,
      workspaceIds: ["smoke"],
      environments: ["research"],
    },
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    lastSeenAt: "2026-04-27T00:00:00.000Z",
  };
}

export function makeExchange(
  id: string,
  targetNodeId: string,
  createdAt = "2026-04-27T00:00:00.000Z",
): BrokerSnapshot["exchanges"][number] {
  return {
    id,
    requester: { id: "requester", kind: "session", role: "hub" },
    target: { id: targetNodeId, kind: "node", role: "analyst" },
    targetNodeId,
    assignedWorkerId: targetNodeId,
    message: id,
    maxTurns: 4,
    intent: "chat",
    status: "running",
    rootMessageId: `${id}-root`,
    latestMessageId: `${id}-root`,
    messageCount: 1,
    lastMessageAt: createdAt,
    activeTaskId: `${id}-task`,
    createdAt,
    updatedAt: createdAt,
  };
}

export function makeExchangeMessage(
  id: string,
  exchangeId: string,
  kind: BrokerSnapshot["exchangeMessages"][number]["kind"],
  parentMessageId?: string,
  createdAt = "2026-04-27T00:00:00.000Z",
): BrokerSnapshot["exchangeMessages"][number] {
  const message: BrokerSnapshot["exchangeMessages"][number] = {
    id,
    exchangeId,
    kind,
    message: id,
    actor: { id: "requester", kind: "session", role: "hub" },
    createdAt,
    updatedAt: createdAt,
  };
  if (parentMessageId) {
    message.parentMessageId = parentMessageId;
  }
  return message;
}

export function makeProposal(
  id: string,
  status: BrokerSnapshot["proposals"][number]["status"],
  targetNodeId: string,
  createdAt = "2026-04-27T00:00:00.000Z",
): BrokerSnapshot["proposals"][number] {
  return {
    id,
    source: { id: "source-a", kind: "node", role: "analyst" },
    target: { id: targetNodeId, kind: "node", role: "operator" },
    sourceNodeId: "source-a",
    targetNodeId,
    kind: "patch",
    summary: id,
    workspace: { nodeId: targetNodeId, workspaceId: "test" },
    artifactIds: [],
    status,
    createdAt,
    updatedAt: createdAt,
  };
}

export function makeArtifact(
  id: string,
  proposalId: string,
  createdAt = "2026-04-27T00:00:00.000Z",
): BrokerSnapshot["artifacts"][number] {
  return {
    id,
    proposalId,
    kind: "report",
    uri: `memory://${id}`,
    createdAt,
  };
}

export function makeValidation(
  id: string,
  proposalId: string,
  createdAt = "2026-04-27T00:00:00.000Z",
): BrokerSnapshot["validations"][number] {
  return {
    id,
    proposalId,
    nodeId: "validator-a",
    kind: "smoke",
    verdict: "pass",
    metrics: {},
    artifactIds: [],
    createdAt,
  };
}

export function makeTask(
  id: string,
  status: BrokerSnapshot["tasks"][number]["status"],
  assignedWorkerId: string,
): BrokerSnapshot["tasks"][number] {
  return {
    id,
    intent: "chat",
    requester: { id: "requester", kind: "session", role: "hub" },
    target: { id: assignedWorkerId, kind: "node", role: "analyst" },
    message: id,
    targetNodeId: assignedWorkerId,
    assignedWorkerId,
    payload: { correlationId: `corr-${id}` },
    status,
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: id === "task-running" ? "2026-04-27T00:02:00.000Z" : "2026-04-27T00:01:00.000Z",
    taskOrigin: "api",
  };
}

export function makeTombstone(
  taskId: string,
  tombstoneReason: NonNullable<BrokerSnapshot["tombstones"]>[number]["tombstoneReason"],
  tombstonedAt = "2026-04-27T00:02:00.000Z",
): NonNullable<BrokerSnapshot["tombstones"]>[number] {
  return {
    taskId,
    terminalStatus: tombstoneReason === "canceled" ? "canceled" : "failed",
    tombstoneReason,
    durationMs: 120_000,
    requeueCount: 0,
    error: tombstoneReason === "failed" ? { code: "handler_error", message: "failed" } : undefined,
    tombstonedAt,
  };
}

export function makeAuditEvent(
  id: string,
  action: BrokerSnapshot["auditEvents"][number]["action"],
  targetId: string,
  createdAt = "2026-04-27T00:00:00.000Z",
): BrokerSnapshot["auditEvents"][number] {
  return {
    id,
    actorId: "operator-a",
    action,
    targetType: "task",
    targetId,
    createdAt,
  };
}

export function makeTerminalOutboxEvent(id: string, taskId: string, createdAt: string): TerminalTaskOutboxEvent {
  return {
    id,
    kind: "task.terminal",
    taskEventId: Number(createdAt.slice(17, 19)),
    payload: {
      taskId,
      status: "succeeded",
      worker: "worker-a",
      createdAt,
      updatedAt: createdAt,
      completedAt: createdAt,
    },
    createdAt,
    receipt: {
      status: "accepted",
      updatedAt: createdAt,
    },
    attempts: 0,
  };
}

export function makeOutboxEvent(
  id: string,
  taskId: string,
  eventId: number,
  createdAt: string,
  acknowledgedAt: string | null,
): BrokerSnapshot["terminalOutbox"] extends (infer T)[] | undefined ? T : never {
  const event: Record<string, unknown> = {
    id,
    kind: "task.terminal" as const,
    taskEventId: eventId,
    payload: {
      taskId,
      status: "succeeded" as const,
      createdAt,
      updatedAt: createdAt,
    },
    createdAt,
    receipt: {
      status: "produced" as const,
      updatedAt: createdAt,
    },
    attempts: 0,
  };
  if (acknowledgedAt) {
    event.ack = {
      status: "receipt_confirmed" as const,
      evidence: "operator_visible" as const,
      acknowledgedAt,
    };
  }
  return event as unknown as NonNullable<BrokerSnapshot["terminalOutbox"]>[number];
}
