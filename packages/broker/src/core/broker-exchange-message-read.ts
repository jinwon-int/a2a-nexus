import { collectThreadMessageIds } from "./broker-task-diagnostics.js";
import { normalizeExchangeMessageRecord } from "./broker-exchange-normalizers.js";
import { sortExchangeMessages } from "./broker-record-helpers.js";
import { sortedCopy } from "./broker-helpers.js";
import type { ExchangeMessageRuntimeRepository } from "./exchange-repository.js";
import type { A2AExchangeMessageRecord } from "./types.js";

export interface BrokerExchangeMessageListFilters {
  parentMessageId?: string;
  includeDescendants?: boolean;
}

export interface ReadBrokerExchangeMessagesOptions {
  exchangeId: string;
  exchangeMessages: Map<string, A2AExchangeMessageRecord>;
  exchangeMessageRepository?: ExchangeMessageRuntimeRepository;
  filters?: BrokerExchangeMessageListFilters;
  requireParentMessage: (messageId: string) => A2AExchangeMessageRecord;
}

// Read/hydrate exchange message rows for InMemoryA2ABroker. This helper keeps
// repository cache hydration and parent-thread filtering together while broker.ts
// remains responsible for exchange existence and public API behavior.
export function readBrokerExchangeMessages({
  exchangeId,
  exchangeMessages,
  exchangeMessageRepository,
  filters,
  requireParentMessage,
}: ReadBrokerExchangeMessagesOptions): A2AExchangeMessageRecord[] {
  const messagesById = new Map(
    [...exchangeMessages.entries()].filter(([, message]) => message.exchangeId === exchangeId),
  );
  if (exchangeMessageRepository) {
    for (const repositoryMessage of exchangeMessageRepository
      .listExchangeMessages(exchangeId)
      .map(normalizeExchangeMessageRecord)) {
      exchangeMessages.set(repositoryMessage.id, repositoryMessage);
      messagesById.set(repositoryMessage.id, repositoryMessage);
    }
  }
  const items = sortedCopy(messagesById.values(), sortExchangeMessages);

  if (!filters?.parentMessageId) {
    return items;
  }

  requireParentMessage(filters.parentMessageId);
  if (filters.includeDescendants) {
    const allowedIds = collectThreadMessageIds(items, filters.parentMessageId);
    return items.filter((message) => allowedIds.has(message.id));
  }
  return items.filter((message) => message.parentMessageId === filters.parentMessageId);
}
