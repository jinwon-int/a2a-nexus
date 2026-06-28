// A2A exchange state/message record normalizers extracted from broker.ts. Pure
// functions that fill default fields on exchange and exchange-message records
// and build the legacy synthetic root message. They hold no broker state.
import type { A2AExchangeMessageRecord, A2AExchangeState } from "./types.js";

export function normalizeExchangeState(exchange: A2AExchangeState): A2AExchangeState {
  return {
    ...exchange,
    targetNodeId: exchange.targetNodeId ?? exchange.target.id,
    assignedWorkerId: exchange.assignedWorkerId,
    currentDecision: exchange.currentDecision,
    rootMessageId: exchange.rootMessageId ?? "",
    latestMessageId: exchange.latestMessageId ?? exchange.rootMessageId ?? "",
    messageCount: exchange.messageCount ?? 0,
    lastMessageAt: exchange.lastMessageAt ?? exchange.updatedAt,
    activeTaskId: exchange.activeTaskId,
  };
}

export function normalizeExchangeMessageRecord(message: A2AExchangeMessageRecord): A2AExchangeMessageRecord {
  return {
    ...message,
    kind: message.kind ?? "thread",
    updatedAt: message.updatedAt ?? message.createdAt,
  };
}

export function createLegacyRootExchangeMessage(exchange: A2AExchangeState): A2AExchangeMessageRecord {
  return {
    id: `legacy-root:${exchange.id}`,
    exchangeId: exchange.id,
    kind: "root",
    message: exchange.message,
    requester: exchange.requester,
    targetNodeId: exchange.targetNodeId ?? exchange.target.id,
    createdAt: exchange.createdAt,
    updatedAt: exchange.updatedAt,
  };
}
