import { randomUUID } from "node:crypto";
import { BrokerError } from "./broker-error.js";
import { assertExchangeMessageActor } from "./broker-exchange-guards.js";
import { readBrokerExchangeMessages, type BrokerExchangeMessageListFilters } from "./broker-exchange-message-read.js";
import { isoNow } from "./broker-helpers.js";
import type { ExchangeMessageRuntimeRepository } from "./exchange-repository.js";
import type {
  A2AExchangeMessageRecord,
  A2AExchangeMessageRequest,
  A2AExchangeRequest,
  A2AExchangeState,
  AuditAction,
  AuditEvent,
  WorkerRecord,
} from "./types.js";

export interface StartBrokerExchangeContext {
  setExchangeMessageRecord(message: A2AExchangeMessageRecord): void;
  setExchangeRecord(exchange: A2AExchangeState): void;
  persistState(): void;
}

export function startBrokerExchange(
  request: A2AExchangeRequest,
  context: StartBrokerExchangeContext,
): A2AExchangeState {
  const now = isoNow();
  const exchangeId = randomUUID();
  const rootMessage: A2AExchangeMessageRecord = {
    id: randomUUID(),
    exchangeId,
    kind: "root",
    message: request.message,
    requester: request.requester,
    via: request.via,
    targetNodeId: request.target.id,
    createdAt: now,
    updatedAt: now,
  };
  const exchange: A2AExchangeState = {
    id: exchangeId,
    requester: request.requester,
    target: request.target,
    targetNodeId: request.target.id,
    message: request.message,
    maxTurns: request.maxTurns ?? 8,
    intent: request.intent ?? "chat",
    status: "queued",
    rootMessageId: rootMessage.id,
    latestMessageId: rootMessage.id,
    messageCount: 1,
    lastMessageAt: now,
    createdAt: now,
    updatedAt: now,
  };

  context.setExchangeMessageRecord(rootMessage);
  context.setExchangeRecord(exchange);
  context.persistState();
  return exchange;
}

export interface ListBrokerExchangeMessagesContext {
  exchangeMessages: Map<string, A2AExchangeMessageRecord>;
  exchangeMessageRepository?: ExchangeMessageRuntimeRepository;
  requireExchange(exchangeId: string): A2AExchangeState;
  requireExchangeMessage(exchangeId: string, messageId: string): A2AExchangeMessageRecord;
}

export function listBrokerExchangeMessages(
  exchangeId: string,
  filters: BrokerExchangeMessageListFilters | undefined,
  context: ListBrokerExchangeMessagesContext,
): A2AExchangeMessageRecord[] {
  const exchange = context.requireExchange(exchangeId);
  return readBrokerExchangeMessages({
    exchangeId: exchange.id,
    exchangeMessages: context.exchangeMessages,
    exchangeMessageRepository: context.exchangeMessageRepository,
    filters,
    requireParentMessage: (messageId) => context.requireExchangeMessage(exchange.id, messageId),
  });
}

export interface AddBrokerExchangeMessageContext {
  requireExchange(exchangeId: string): A2AExchangeState;
  requireWorker(nodeId: string): WorkerRecord;
  requireExchangeMessage(exchangeId: string, messageId: string): A2AExchangeMessageRecord;
  setExchangeMessageRecord(message: A2AExchangeMessageRecord): void;
  setExchangeRecord(exchange: A2AExchangeState): void;
  applyExchangeMessageDecision(
    exchange: A2AExchangeState,
    message: A2AExchangeMessageRecord,
    hasExplicitAssignment: boolean,
  ): void;
  appendAuditEvent(input: {
    actorId: string;
    action: AuditAction;
    targetType: AuditEvent["targetType"];
    targetId: string;
    proposalId?: string;
    note?: string;
  }): AuditEvent;
  persistState(): void;
}

export function addBrokerExchangeMessage(
  exchangeId: string,
  request: A2AExchangeMessageRequest,
  context: AddBrokerExchangeMessageContext,
): A2AExchangeMessageRecord {
  const exchange = context.requireExchange(exchangeId);

  if (!request.actor?.id) {
    throw new BrokerError("bad_request", "actor.id is required");
  }
  if (!request.message) {
    throw new BrokerError("bad_request", "message is required");
  }

  assertExchangeMessageActor(exchange, request);

  if (request.targetNodeId) {
    context.requireWorker(request.targetNodeId);
  }
  if (request.assignedWorkerId) {
    context.requireWorker(request.assignedWorkerId);
  }
  if (request.parentMessageId) {
    context.requireExchangeMessage(exchange.id, request.parentMessageId);
  }

  const now = isoNow();
  const message: A2AExchangeMessageRecord = {
    id: randomUUID(),
    exchangeId,
    kind: "thread",
    message: request.message,
    actor: request.actor,
    via: request.via,
    decision: request.decision,
    targetNodeId: request.targetNodeId ?? exchange.target.id,
    assignedWorkerId: request.assignedWorkerId,
    parentMessageId: request.parentMessageId ?? exchange.rootMessageId,
    createdAt: now,
    updatedAt: now,
  };

  context.setExchangeMessageRecord(message);
  exchange.messageCount += 1;
  exchange.lastMessageAt = now;
  exchange.latestMessageId = message.id;
  exchange.updatedAt = now;
  context.applyExchangeMessageDecision(
    exchange,
    message,
    Boolean(request.targetNodeId || request.assignedWorkerId),
  );
  context.setExchangeRecord(exchange);
  context.appendAuditEvent({
    actorId: request.actor.id,
    action: "exchange.message.added",
    targetType: "exchange-message",
    targetId: message.id,
    note: request.decision ? `${request.decision}: ${request.message}` : request.message,
  });
  context.persistState();
  return message;
}
