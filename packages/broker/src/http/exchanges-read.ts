// Exchange read-path routes (GET /exchanges, GET /exchanges/:id,
// GET /exchanges/:id/messages), extracted from the server request closure into
// explicit-context handlers (#645 phase-3 dispatcher migration; follows
// http/workers-read.ts and http/proposals-read.ts).

import type { ServerResponse } from "node:http";

import { BrokerError, InMemoryA2ABroker } from "../core/broker.js";
import { SqliteBrokerStateStore, type BrokerStateStore } from "../core/store.js";
import type { A2AExchangeMessageRecord, A2AExchangeState } from "../core/types.js";
import { sendJson } from "./response.js";

interface ThreadedExchangeMessage extends A2AExchangeMessageRecord {
  replies: ThreadedExchangeMessage[];
}

function listExchangesForReadPath(stateStore: BrokerStateStore, broker: InMemoryA2ABroker): A2AExchangeState[] {
  if (stateStore instanceof SqliteBrokerStateStore) {
    return stateStore.readHotExchanges();
  }
  return broker.listExchanges();
}

function getExchangeForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  exchangeId: string,
): A2AExchangeState | null {
  if (stateStore instanceof SqliteBrokerStateStore) {
    return stateStore.readHotExchanges({ id: exchangeId })[0] ?? null;
  }
  return broker.getExchange(exchangeId);
}

function listExchangeMessagesForReadPath(
  stateStore: BrokerStateStore,
  broker: InMemoryA2ABroker,
  exchangeId: string,
  filters: {
    parentMessageId?: string;
    includeDescendants?: boolean;
  },
): A2AExchangeMessageRecord[] {
  if (!(stateStore instanceof SqliteBrokerStateStore)) {
    return broker.listExchangeMessages(exchangeId, filters);
  }

  if (!stateStore.readHotExchanges({ id: exchangeId })[0]) {
    throw new BrokerError("not_found", "exchange not found");
  }

  const items = stateStore.readHotExchangeMessages({ exchangeId });
  if (!filters.parentMessageId) {
    return items;
  }

  if (!items.some((message) => message.id === filters.parentMessageId)) {
    throw new BrokerError("not_found", "exchange message not found");
  }
  if (filters.includeDescendants) {
    const allowedIds = collectThreadMessageIds(items, filters.parentMessageId);
    return items.filter((message) => allowedIds.has(message.id));
  }
  return items.filter((message) => message.parentMessageId === filters.parentMessageId);
}

function collectThreadMessageIds(
  messages: A2AExchangeMessageRecord[],
  parentMessageId: string,
): Set<string> {
  const allowedIds = new Set<string>([parentMessageId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const message of messages) {
      if (message.parentMessageId && allowedIds.has(message.parentMessageId) && !allowedIds.has(message.id)) {
        allowedIds.add(message.id);
        changed = true;
      }
    }
  }
  return allowedIds;
}

function buildMessageThreads(items: A2AExchangeMessageRecord[]): ThreadedExchangeMessage[] {
  const repliesByParent = new Map<string, A2AExchangeMessageRecord[]>();
  const itemIds = new Set(items.map((item) => item.id));
  const roots: A2AExchangeMessageRecord[] = [];

  for (const item of items) {
    if (!item.parentMessageId || !itemIds.has(item.parentMessageId)) {
      roots.push(item);
      continue;
    }
    const siblings = repliesByParent.get(item.parentMessageId) ?? [];
    siblings.push(item);
    repliesByParent.set(item.parentMessageId, siblings);
  }

  const attachReplies = (node: A2AExchangeMessageRecord): ThreadedExchangeMessage => ({
    ...node,
    replies: (repliesByParent.get(node.id) ?? []).map(attachReplies),
  });

  return roots.map(attachReplies);
}

export interface ExchangesReadContext {
  res: ServerResponse;
  stateStore: BrokerStateStore;
  broker: InMemoryA2ABroker;
}

/** GET /exchanges — list all exchanges. */
export function handleExchangesListRequest(ctx: ExchangesReadContext): void {
  sendJson(ctx.res, 200, { items: listExchangesForReadPath(ctx.stateStore, ctx.broker) });
}

/** GET /exchanges/:id — single exchange; 404 when unknown. */
export function handleExchangeByIdRequest(ctx: ExchangesReadContext & { exchangeId: string }): void {
  const exchange = getExchangeForReadPath(ctx.stateStore, ctx.broker, ctx.exchangeId);
  if (!exchange) {
    throw new BrokerError("not_found", "exchange not found");
  }
  sendJson(ctx.res, 200, exchange);
}

/** GET /exchanges/:id/messages — messages plus a threaded view (optionally filtered to a subtree). */
export function handleExchangeMessagesRequest(
  ctx: ExchangesReadContext & { exchangeId: string; parentMessageId?: string; includeDescendants: boolean },
): void {
  const items = listExchangeMessagesForReadPath(ctx.stateStore, ctx.broker, ctx.exchangeId, {
    parentMessageId: ctx.parentMessageId,
    includeDescendants: ctx.includeDescendants,
  });
  sendJson(ctx.res, 200, {
    exchangeId: ctx.exchangeId,
    parentMessageId: ctx.parentMessageId,
    items,
    threads: buildMessageThreads(items),
  });
}
