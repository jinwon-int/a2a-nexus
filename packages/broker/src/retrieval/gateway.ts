/**
 * Host-side retrieval gateway (#2017, spec:
 * docs/specs/web-retrieval-snapshot-gateway).
 *
 * Task containers never fetch: lanes submit retrieval requests, the gateway
 * enforces the manifest's allowlist/budget fail-closed, dedups by
 * url+content, and returns signed snapshots only. Everything is injectable
 * (provider, clock, signing key) so tests stay fixture-only; there is no live
 * wiring in this slice (first live use is the separately approved #2020
 * canary).
 */

import {
  isDeniedInternalRetrievalHost,
} from "./web-retrieval-contract.mjs";
import {
  assertPublicHttpUrl,
  buildWebRetrievalSnapshot,
  signWebRetrievalSnapshot,
  snapshotIdFor,
  type WebRetrievalSnapshot,
} from "./snapshot.js";
import type { RetrievalProvider } from "./provider.js";

export type GatewayDenialCode =
  | "invalid_url"
  | "host_not_allowed"
  | "internal_host_denied"
  | "budget_requests_exhausted"
  | "budget_bytes_exhausted"
  | "provider_error";

export type GatewayDenial = { status: "denied"; code: GatewayDenialCode; message: string };
export type GatewayHit = { status: "ok"; snapshot: WebRetrievalSnapshot; dedupHit: boolean };

export type GatewayResult = GatewayHit | GatewayDenial;


export type SigningKey = { privateKeyPem: string; keyId: string };

/** Validated-at-the-edge manifest `retrieval` block shape (runtime validation lives in web-retrieval-contract.mjs). */
export type RetrievalManifestBlock = {
  allowedHosts: string[];
  maxRequests?: number;
  maxBytes?: number;
  phases?: string[];
};

function hostOf(url: string): string {
  return assertPublicHttpUrl(url).hostname.toLowerCase().replace(/\.$/, "");
}

function urlAllowed(url: string, allowedHosts: ReadonlySet<string>): GatewayDenial | null {
  let host: string;
  try {
    host = hostOf(url);
  } catch (error) {
    return { status: "denied", code: "invalid_url", message: (error as Error).message };
  }
  if (isDeniedInternalRetrievalHost(host)) {
    return { status: "denied", code: "internal_host_denied", message: `host '${host}' is internal/metadata and never retrievable` };
  }
  if (!allowedHosts.has(host)) {
    return { status: "denied", code: "host_not_allowed", message: `host '${host}' is outside this lane's retrieval allowlist` };
  }
  return null;
}

export class RetrievalGateway {
  private readonly provider: RetrievalProvider;
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly maxRequests: number;
  private readonly maxBytes: number;
  private readonly signingKey: SigningKey;
  private readonly now: () => Date;
  private readonly cache = new Map<string, WebRetrievalSnapshot>();
  private readonly idByUrl = new Map<string, string>();
  private requestsUsed = 0;
  private bytesUsed = 0;
  private cacheHits = 0;

  constructor(options: {
    provider: RetrievalProvider;
    block: RetrievalManifestBlock;
    signingKey: SigningKey;
    now?: () => Date;
  }) {
    this.provider = options.provider;
    this.allowedHosts = new Set(options.block.allowedHosts);
    this.maxRequests = options.block.maxRequests ?? 10;
    this.maxBytes = options.block.maxBytes ?? 1_000_000;
    this.signingKey = options.signingKey;
    this.now = options.now ?? (() => new Date());
  }

  get budget(): { requestsUsed: number; maxRequests: number; bytesUsed: number; maxBytes: number; cacheHits: number } {
    return {
      requestsUsed: this.requestsUsed,
      maxRequests: this.maxRequests,
      bytesUsed: this.bytesUsed,
      maxBytes: this.maxBytes,
      cacheHits: this.cacheHits,
    };
  }

  /** Search returns allowlist-filtered hits only; it does not fetch page bodies and does not consume the request budget. */
  async search(query: string): Promise<{ status: "ok"; hits: Array<{ url: string; title?: string }> } | GatewayDenial> {
    if (this.requestsUsed >= this.maxRequests) {
      return { status: "denied", code: "budget_requests_exhausted", message: `request budget exhausted (${this.requestsUsed}/${this.maxRequests})` };
    }
    let hits: Array<{ url: string; title?: string }>;
    try {
      hits = await this.provider.search(query);
    } catch (error) {
      return { status: "denied", code: "provider_error", message: `provider search failed: ${(error as Error).message}` };
    }
    const allowed: Array<{ url: string; title?: string }> = [];
    for (const hit of hits) {
      const denial = urlAllowed(hit.url, this.allowedHosts);
      if (denial === null) {
        allowed.push(hit.title === undefined ? { url: hit.url } : { url: hit.url, title: hit.title });
      }
    }
    return { status: "ok", hits: allowed };
  }

  /**
   * Fetch a page through the provider and return a signed snapshot.
   * Dedup happens on two levels: a repeated URL skips the provider call
   * entirely (no budget charge), and identical content fetched via a
   * different URL collapses to the same snapshot id.
   */
  async scrape(url: string, options: { requestQuery?: string } = {}): Promise<GatewayResult> {
    const denial = urlAllowed(url, this.allowedHosts);
    if (denial) return denial;
    if (this.requestsUsed >= this.maxRequests) {
      return { status: "denied", code: "budget_requests_exhausted", message: `request budget exhausted (${this.requestsUsed}/${this.maxRequests})` };
    }

    const cachedId = this.idByUrl.get(url);
    if (cachedId !== undefined) {
      const cached = this.cache.get(cachedId);
      if (cached) {
        this.cacheHits += 1;
        return { status: "ok", snapshot: cached, dedupHit: true };
      }
    }

    let body: string;
    let contentType: string | undefined;
    try {
      const page = await this.provider.scrape(url);
      body = page.body;
      contentType = page.contentType;
      // Charge the request budget only on a successful provider response: a
      // provider outage must not silently consume the lane's whole budget,
      // while every fetched byte still passes the byte-budget check below.
      this.requestsUsed += 1;
    } catch (error) {
      return { status: "denied", code: "provider_error", message: `provider scrape failed: ${(error as Error).message}` };
    }

    const candidate = buildWebRetrievalSnapshot({
      provider: this.provider.name,
      url,
      retrievedAt: this.now().toISOString(),
      content: body,
      contentType,
      requestQuery: options.requestQuery,
    });
    const id = snapshotIdFor(candidate);
    const cached = this.cache.get(id);
    if (cached) {
      this.cacheHits += 1;
      return { status: "ok", snapshot: cached, dedupHit: true };
    }

    if (this.bytesUsed + candidate.byteLen > this.maxBytes) {
      return { status: "denied", code: "budget_bytes_exhausted", message: `byte budget exhausted (${this.bytesUsed}/${this.maxBytes} used, ${candidate.byteLen} requested)` };
    }
    const signed = signWebRetrievalSnapshot(candidate, this.signingKey);
    this.cache.set(id, signed);
    this.idByUrl.set(url, id);
    this.bytesUsed += signed.byteLen;
    return { status: "ok", snapshot: signed, dedupHit: false };
  }

  cachedSnapshot(id: string): WebRetrievalSnapshot | undefined {
    return this.cache.get(id);
  }
}

/**
 * Correlation control for A2AD rounds: group snapshot ids cited by more than
 * one phase so finalizers can label them as SHARED, not independent.
 */
export function labelSharedCitations(phaseCitations: Record<string, Array<string>>): {
  sharedGroups: Array<{ snapshotId: string; phases: string[] }>;
  uniqueByPhase: Record<string, number>;
} {
  const bySnapshot = new Map<string, Set<string>>();
  const uniqueByPhase: Record<string, number> = {};
  for (const [phase, ids] of Object.entries(phaseCitations)) {
    const unique = new Set(ids);
    uniqueByPhase[phase] = unique.size;
    for (const id of unique) {
      if (!bySnapshot.has(id)) bySnapshot.set(id, new Set());
      bySnapshot.get(id)!.add(phase);
    }
  }
  const sharedGroups = [...bySnapshot.entries()]
    .filter(([, phases]) => phases.size > 1)
    .map(([snapshotId, phases]) => ({ snapshotId, phases: [...phases].sort() }))
    .sort((a, b) => a.snapshotId.localeCompare(b.snapshotId));
  return { sharedGroups, uniqueByPhase };
}

export function createRetrievalGateway(options: {
  provider: RetrievalProvider;
  block: RetrievalManifestBlock;
  signingKey: SigningKey;
  now?: () => Date;
}): RetrievalGateway {
  return new RetrievalGateway(options);
}
