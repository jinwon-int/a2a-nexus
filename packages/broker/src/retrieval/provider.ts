/**
 * Retrieval providers for the web-retrieval gateway (#2017).
 *
 * Providers are host-side only: credentials are passed at construction on the
 * host and are never copied into results, snapshots, logs, or task payloads.
 * This slice ships no live wiring — CI and tests use the fixture provider or
 * an injected fetch impl. The first live use is the separately approved
 * canary (#2020).
 */

import { buildWebRetrievalSnapshot, type WebRetrievalSnapshot } from "./snapshot.js";

export type ProviderSearchHit = { url: string; title?: string };

export interface RetrievalProvider {
  readonly name: string;
  search(query: string): Promise<ProviderSearchHit[]>;
  scrape(url: string): Promise<{ body: string; contentType?: string }>;
}

/** Deterministic, network-free provider for tests and fixtures. */
export function createFixtureProvider(
  entries: { searchHits?: Record<string, ProviderSearchHit[]>; pages?: Record<string, { body: string; contentType?: string }> },
  providerName = "fixture",
): RetrievalProvider {
  const searchHits = entries.searchHits ?? {};
  const pages = entries.pages ?? {};
  return {
    name: providerName,
    async search(query) {
      return (searchHits[query] ?? []).map((hit) => ({ ...hit }));
    },
    async scrape(url) {
      const page = pages[url];
      if (!page) throw new Error(`fixture provider has no page for ${url}`);
      return { body: page.body, contentType: page.contentType };
    },
  };
}

export type SearchScrapeProviderConfig = {
  /** Fully-qualified https endpoint for the search API. */
  searchEndpoint: string;
  /** Fully-qualified https endpoint for the scrape API. */
  scrapeEndpoint: string;
  /** Host-side credential. Never logged, never copied into results. */
  apiKey: string;
  userAgent?: string;
};

type FetchLike = (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Search/scrape API adapter. Request transport is injected so unit tests stay
 * fixture-only; the adapter itself performs no implicit network access at
 * import/construct time. Key usage: the Authorization header is added per
 * request from the host-side config and is never exposed on returned data.
 */
export function createSearchScrapeProvider(
  config: SearchScrapeProviderConfig,
  deps: { fetchImpl: FetchLike; now?: () => Date },
): RetrievalProvider {
  if (!/^https:\/\//.test(config.searchEndpoint) || !/^https:\/\//.test(config.scrapeEndpoint)) {
    throw new Error("search/scrape endpoints must be https");
  }
  const headers = (): Record<string, string> => {
    const base: Record<string, string> = {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    };
    if (config.userAgent) base["user-agent"] = config.userAgent;
    return base;
  };
  const fail = async (status: number): Promise<never> => {
    throw new Error(`provider request failed with status ${status}`);
  };
  return {
    name: "search-scrape",
    async search(query) {
      const response = await deps.fetchImpl(config.searchEndpoint, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ query }),
      });
      if (!response.ok) await fail(response.status);
      const payload = JSON.parse(await response.text()) as { results?: Array<{ url?: string; title?: string }> };
      return (payload.results ?? [])
        .filter((hit): hit is { url: string; title?: string } => typeof hit.url === "string" && hit.url.length > 0)
        .map((hit) => ({ url: hit.url, title: hit.title }));
    },
    async scrape(url) {
      const response = await deps.fetchImpl(config.scrapeEndpoint, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ url }),
      });
      if (!response.ok) await fail(response.status);
      const payload = JSON.parse(await response.text()) as { content?: string; contentType?: string };
      if (typeof payload.content !== "string") throw new Error("provider scrape response missing content");
      return { body: payload.content, contentType: payload.contentType };
    },
  };
}

export function snapshotFromProviderResult(params: {
  provider: string;
  url: string;
  retrievedAt: string;
  body: string;
  contentType?: string;
  requestQuery?: string;
}): WebRetrievalSnapshot {
  return buildWebRetrievalSnapshot({
    provider: params.provider,
    url: params.url,
    retrievedAt: params.retrievedAt,
    content: params.body,
    contentType: params.contentType,
    requestQuery: params.requestQuery,
  });
}
