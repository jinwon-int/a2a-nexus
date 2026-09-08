/**
 * Table-driven router core (#2079 A).
 *
 * The server's request pipeline used to walk a ~35-step chain of
 * `handleXRouteIfMatched` calls, allocating a context object per candidate
 * module and re-deriving endpoint classification (group / route / rate-limit
 * bucket) with two near-duplicate if-chain classifiers on every request.
 *
 * This module is the single source of that dispatch data instead:
 *
 * - every route module exports `createXRouteEntries(deps)` entries;
 * - `buildRouteIndex` buckets entries by `${method}|${segments[0]}` (plus a
 *   method-wildcard bucket) so a request touches only same-prefix candidates;
 * - classification fields (endpoint group, request route, rate-limit bucket,
 *   drain refusal) live on the entry and are derived per request via
 *   `classifyMatch` / `entryRateLimitBucket`.
 *
 * Requests that match no entry keep the legacy if-chain classifiers as the
 * fallback so metrics labels for 404 paths are unchanged.
 *
 * Matching is pure (no auth, no I/O) so the lookup can run before the
 * edge-secret and rate-limit checks without changing their behavior.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RequesterIdentity } from "../core/request-security.js";
import type { RateLimitBucket } from "../core/request-security.js";
import type { EndpointGroup, RequestRouteGroup } from "./route-classification.js";

/**
 * Request-scoped fields shared by every route handler. Field names mirror the
 * per-module route context interfaces on purpose: a module context is
 * reconstructed as `{ ...requestContext, ...deps }`, so `Omit<ModuleContext,
 * keyof BrokerRequestContext>` is the module's deps type.
 */
export interface BrokerRequestContext {
  method: string | undefined;
  /** Decoded pathname (`url.pathname`). */
  path: string;
  /** Decoded path segments (`path.split("/").filter(Boolean)`). */
  segments: string[];
  /** Pattern captures from the matched entry (`":id"` → value). */
  params: Record<string, string>;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  requesterIdentity: RequesterIdentity | null;
  enforceRequesterIdentity: boolean;
}

/** A route pattern: literal segments mixed with `":name"` captures. */
export type RoutePattern = readonly string[];

/**
 * Match `segments` against `pattern`. A literal segment must match exactly and
 * a `":name"` segment captures anything. A trailing `"**"` segment matches the
 * remainder (zero or more segments) for the few open-ended routes whose legacy
 * dispatchers accepted extra trailing segments (e.g. `/exchanges/:id/messages/*`).
 */
export function matchRoutePattern(
  pattern: RoutePattern,
  segments: readonly string[],
): Record<string, string> | null {
  if (pattern.length > 0 && pattern[pattern.length - 1] === "**") {
    const fixed = pattern.length - 1;
    if (segments.length < fixed) {
      return null;
    }
    const head = matchRoutePattern(pattern.slice(0, fixed), segments.slice(0, fixed));
    return head === null ? null : { ...head };
  }
  if (pattern.length !== segments.length) {
    return null;
  }
  let params: Record<string, string> | null = null;
  for (let i = 0; i < pattern.length; i++) {
    const part = pattern[i];
    if (part.startsWith(":")) {
      (params ??= {})[part.slice(1)] = segments[i];
      continue;
    }
    if (part !== segments[i]) {
      return null;
    }
  }
  return params ?? {};
}

export interface BrokerRouteEntry {
  /** Exact HTTP method, or `"*"` for method-agnostic handlers (fallbacks that re-check inside). */
  readonly method: string;
  readonly pattern: RoutePattern;
  /** Fine-grained observability label (former `classifyRequestRoute` output). */
  readonly route: RequestRouteGroup;
  /** Coarse observability label (former `classifyEndpointGroup` output). */
  readonly group: EndpointGroup;
  /**
   * Static rate-limit bucket for the route. Omit when the bucket depends on
   * request headers/query (see {@link bucketOf}); unmatched-derivation then
   * falls back to the legacy classifier.
   */
  readonly rateLimitBucket?: RateLimitBucket;
  /** Request fields the bucket refinement may consult. */
  readonly bucketOf?: (ctx: Pick<BrokerRequestContext, "method" | "segments" | "params" | "req" | "url" | "path">) => RateLimitBucket;
  /**
   * New-work route refused with 503 `broker_draining` while draining (#1405).
   * Today: `GET /tasks` and `POST /tasks/:id/claim`.
   */
  readonly drainRefused?: boolean;
  readonly handle: (ctx: BrokerRequestContext) => boolean | Promise<boolean>;
}

export interface RouteMatch {
  readonly entry: BrokerRouteEntry;
  readonly params: Record<string, string>;
}

export interface RouteIndex {
  /** Exact-method buckets, keyed by `${method}|${segments[0] ?? ""}`. */
  readonly byMethod: Map<string, BrokerRouteEntry[]>;
  /** Wildcard-method buckets, keyed by `segments[0] ?? ""`. */
  readonly byWildcard: Map<string, BrokerRouteEntry[]>;
}

/**
 * Bucket entries by (method, first segment). Entries are kept in insertion
 * order: when two patterns overlap, the earlier-registered entry wins, which
 * is how the legacy handler chain ordered its candidates.
 */
export function buildRouteIndex(entries: readonly BrokerRouteEntry[]): RouteIndex {
  const byMethod = new Map<string, BrokerRouteEntry[]>();
  const byWildcard = new Map<string, BrokerRouteEntry[]>();
  for (const entry of entries) {
    const key = entry.pattern[0] ?? "";
    if (entry.method === "*") {
      const list = byWildcard.get(key);
      if (list) {
        list.push(entry);
      } else {
        byWildcard.set(key, [entry]);
      }
      continue;
    }
    const bucketKey = `${entry.method}|${key}`;
    const list = byMethod.get(bucketKey);
    if (list) {
      list.push(entry);
    } else {
      byMethod.set(bucketKey, [entry]);
    }
  }
  return { byMethod, byWildcard };
}

/**
 * Look up the first entry matching `(method, segments)`. Exact-method entries
 * win over wildcard-method entries; within a bucket, insertion order decides.
 * `skip` drops the first `skip` matches so the caller can fall through to the
 * next candidate when a delegated handler reports "not mine" — mirroring how
 * the legacy handler chain moved to the next module on a `false` return.
 */
export function lookupRoute(
  index: RouteIndex,
  method: string | undefined,
  segments: readonly string[],
  skip = 0,
): RouteMatch | null {
  const key = segments[0] ?? "";
  let remaining = skip;
  const exact = method !== undefined ? index.byMethod.get(`${method}|${key}`) : undefined;
  if (exact) {
    for (const entry of exact) {
      const params = matchRoutePattern(entry.pattern, segments);
      if (params) {
        if (remaining === 0) {
          return { entry, params };
        }
        remaining--;
      }
    }
  }
  const wildcard = index.byWildcard.get(key);
  if (wildcard) {
    for (const entry of wildcard) {
      const params = matchRoutePattern(entry.pattern, segments);
      if (params) {
        if (remaining === 0) {
          return { entry, params };
        }
        remaining--;
      }
    }
  }
  return null;
}

/**
 * Rate-limit bucket for a matched entry: the per-request refinement when the
 * route's bucket depends on request data, otherwise the static field. Returns
 * `undefined` when the entry carries neither, so the caller can fall back to
 * the legacy classifier (which is also the fallback for unmatched requests).
 */
export function entryRateLimitBucket(
  entry: BrokerRouteEntry,
  ctx: Pick<BrokerRequestContext, "method" | "segments" | "params" | "req" | "url" | "path">,
): RateLimitBucket | undefined {
  return entry.bucketOf ? entry.bucketOf(ctx) : entry.rateLimitBucket;
}
