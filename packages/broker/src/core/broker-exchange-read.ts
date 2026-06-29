// Exchange read paths for InMemoryA2ABroker, extracted from the broker
// god-class into free functions. Each merges the optional durable repository
// with the in-memory cache (warming the cache with normalized repository
// records, exactly as before) and returns normalized/sorted results. The
// caller owns the cache Map and passes it in, so these stay behavior-preserving
// while following the existing broker-*.ts free-function convention.
import type { A2AExchangeState } from "./types.js";
import type { ExchangeRuntimeRepository } from "./exchange-repository.js";
import { normalizeExchangeState } from "./broker-exchange-normalizers.js";
import { sortedCopy, sortNewestFirst } from "./broker-helpers.js";

/**
 * Read a single exchange by id, preferring the durable repository and warming
 * the in-memory cache with the normalized record. Returns null when unknown.
 */
export function readExchange(
  exchanges: Map<string, A2AExchangeState>,
  repository: ExchangeRuntimeRepository | undefined,
  id: string,
): A2AExchangeState | null {
  const repositoryExchange = repository?.getExchange(id);
  if (repositoryExchange) {
    const exchange = normalizeExchangeState(repositoryExchange);
    exchanges.set(exchange.id, exchange);
    return exchange;
  }
  return exchanges.get(id) ?? null;
}

/**
 * List all exchanges (newest first), overlaying the durable repository onto the
 * in-memory cache and warming the cache with normalized repository records.
 */
export function readExchanges(
  exchanges: Map<string, A2AExchangeState>,
  repository: ExchangeRuntimeRepository | undefined,
): A2AExchangeState[] {
  const exchangesById = new Map(exchanges);
  if (repository) {
    for (const repositoryExchange of repository.listExchanges().map(normalizeExchangeState)) {
      exchanges.set(repositoryExchange.id, repositoryExchange);
      exchangesById.set(repositoryExchange.id, repositoryExchange);
    }
  }
  return sortedCopy(exchangesById.values(), sortNewestFirst);
}
