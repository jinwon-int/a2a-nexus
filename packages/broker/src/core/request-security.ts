/**
 * request-security.ts — Requester identity extraction, permission assertions,
 * rate limiting, and secret gating.
 *
 * ## Requester-visible status contract (issue #921)
 *
 * Every HTTP request carries an optional x-a2a-requester-id header that
 * identifies the calling party. The broker uses this to:
 *
 * 1. **Authorize reads** — `assertRequesterCanSubscribeToTask()` enforces
 *    that only the task requester, target node, assigned worker, or a
 *    hub/operator role may subscribe to task events.
 * 2. **Authorize writes** — `assertRequesterMatchesParty()` ensures the
 *    requester id matches the expected party for the operation.
 * 3. **Authorize privileged actions** — `assertRequesterHasRole()` gates
 *    operations to specific roles (e.g. hub for SSE broadcast).
 * 4. **Rate-limit** — `classifyRateLimitBucket()` assigns requests to
 *    "worker" or "general" buckets based on path and identity.
 *
 * ### Error contract
 *
 * All permission failures throw `BrokerError(code="unauthorized")` with a
 * human-readable `message`. Callers must propagate these to the HTTP
 * response; they must NOT silently degrade security.
 *
 * ### Visibility matrix
 *
 * | Requester matches | Can subscribe? | Can see results/errors? |
 * |---|---:|---:|
 * | task.requester.id | ✅ | ✅ |
 * | task.targetNodeId | ✅ | ✅ |
 * | task.assignedWorkerId | ✅ | ✅ |
 * | role=hub/operator | ✅ | ✅ |
 * | none of the above | ❌ (BrokerError) | ❌ |
 *
 * Rate limit responses carry x-ratelimit-* headers so requesters can
 * self-throttle: x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset,
 * and x-a2a-ratelimit-bucket.
 */

import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { BrokerError } from "./broker.js";
import type { A2APartyKind, A2APartyRole, ChangeProposal, TaskRecord } from "./types.js";

const requesterKindSchema = z.enum(["session", "node", "user", "service"]);
const requesterRoleSchema = z.enum(["hub", "live-trader", "researcher", "analyst", "operator"]);

export interface RequesterIdentity {
  id: string;
  kind?: A2APartyKind;
  role?: A2APartyRole;
  scopes?: string[];
}

export type RateLimitBucket = "general" | "worker";

const A2A_HTTP_SIGNATURE_COMPONENTS = [
  "@method",
  "@authority",
  "@path",
  "@query",
  "content-digest",
  "x-a2a-requester-id",
  "x-a2a-requester-role",
  "x-a2a-broker-id",
] as const;

export interface A2AHttpSignatureRequest {
  method: string;
  authority: string;
  path: string;
  query: string;
  headers: Record<string, string | undefined>;
  signatureInput: string;
  signature?: string;
}

/**
 * Canonical per-route scope tokens for first-party worker auth (#691). A worker
 * key record may declare a subset of these; the broker fails closed when the
 * declared subset does not include the scope required by the route being called.
 * The token values intentionally match the operation labels used at the route
 * call sites so a verified key's authorization maps 1:1 to the route surface.
 */
export const A2A_WORKER_ROUTE_SCOPES = [
  "workers.assignment-events",
  "worker.register",
  "worker.heartbeat",
  "tasks.list",
  "task.claim",
  "task.start",
  "task.heartbeat",
  "task.checkpoint",
  "task.complete",
  "task.evidence",
  "task.fail",
  "review-lineage.report",
] as const;

export type A2AWorkerRouteScope = (typeof A2A_WORKER_ROUTE_SCOPES)[number];

const A2A_WORKER_ROUTE_SCOPE_SET: ReadonlySet<string> = new Set(A2A_WORKER_ROUTE_SCOPES);

export interface A2AHttpSignatureKeyRecord {
  keyid: string;
  workerId: string;
  publicKeyJwk: Record<string, unknown>;
  /**
   * Server-controlled scope grant for this signing key. When omitted, the key is
   * treated as an unscoped legacy credential authorized for every worker route
   * (transitional dual-auth compatibility). When present, only the listed scopes
   * are authorized and all other worker routes fail closed.
   */
  scopes?: readonly A2AWorkerRouteScope[];
  /**
   * Credential lifecycle status. A "revoked" key is rejected at verification
   * time regardless of a valid signature. Omitted is treated as "active".
   */
  status?: "active" | "revoked";
  /** ISO-8601 instant before which the key is not yet valid (optional). */
  notBefore?: string;
  /** ISO-8601 instant at/after which the key is expired (optional). */
  expiresAt?: string;
  /**
   * Roles this signing key is allowed to assert via x-a2a-requester-role. When
   * declared, a signed request claiming any other role fails closed, so a worker
   * credential cannot impersonate a hub/operator role even though the role header
   * is signature-covered. Omitted = no role restriction (legacy compatibility).
   */
  roles?: readonly A2APartyRole[];
}

export type A2AHttpSignatureKeyRegistry = Record<string, A2AHttpSignatureKeyRecord>;

export function loadA2AHttpSignatureKeyRegistryFile(path: string): A2AHttpSignatureKeyRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read A2A HTTP Signature key registry file ${path}: ${message}`);
  }
  return parseA2AHttpSignatureKeyRegistry(parsed, path);
}

function parseA2AHttpSignatureKeyRegistry(input: unknown, source: string): A2AHttpSignatureKeyRegistry {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`A2A HTTP Signature key registry ${source} must be a JSON object keyed by keyid`);
  }
  const registry: A2AHttpSignatureKeyRegistry = {};
  const workerIds = new Set<string>();
  for (const [registryKey, value] of Object.entries(input as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`A2A HTTP Signature key registry record ${registryKey} must be an object`);
    }
    const record = value as Record<string, unknown>;
    const keyid = stringField(record, "keyid", registryKey);
    const workerId = stringField(record, "workerId", registryKey);
    if (registryKey !== keyid) {
      throw new Error(`A2A HTTP Signature key registry key must match embedded keyid for ${registryKey}`);
    }
    if (workerIds.has(workerId)) {
      throw new Error(`A2A HTTP Signature key registry duplicate workerId ${workerId}`);
    }
    workerIds.add(workerId);
    const publicKeyJwk = record.publicKeyJwk;
    validateA2AHttpSignaturePublicJwk(publicKeyJwk, registryKey);
    const scopes = parseRegistryScopes(record.scopes, registryKey);
    const lifecycle = parseRegistryLifecycle(record, registryKey);
    const roles = parseRegistryRoles(record.roles, registryKey);
    registry[registryKey] = {
      keyid,
      workerId,
      publicKeyJwk: publicKeyJwk as Record<string, unknown>,
      ...(scopes ? { scopes } : {}),
      ...lifecycle,
      ...(roles ? { roles } : {}),
    };
  }
  return registry;
}

function parseRegistryRoles(value: unknown, keyid: string): readonly A2APartyRole[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `A2A HTTP Signature key registry record ${keyid} roles must be a non-empty array of known roles when present`,
    );
  }
  const roles = new Set<A2APartyRole>();
  for (const entry of value) {
    const parsed = requesterRoleSchema.safeParse(entry);
    if (!parsed.success) {
      throw new Error(
        `A2A HTTP Signature key registry record ${keyid} has unknown role ${JSON.stringify(entry)}`,
      );
    }
    roles.add(parsed.data);
  }
  return [...roles];
}

function parseRegistryLifecycle(
  record: Record<string, unknown>,
  keyid: string,
): { status?: "active" | "revoked"; notBefore?: string; expiresAt?: string } {
  const result: { status?: "active" | "revoked"; notBefore?: string; expiresAt?: string } = {};
  if (record.status !== undefined) {
    if (record.status !== "active" && record.status !== "revoked") {
      throw new Error(
        `A2A HTTP Signature key registry record ${keyid} status must be "active" or "revoked" when present`,
      );
    }
    result.status = record.status;
  }
  const notBefore = parseRegistryInstant(record.notBefore, "notBefore", keyid);
  const expiresAt = parseRegistryInstant(record.expiresAt, "expiresAt", keyid);
  if (notBefore !== undefined) result.notBefore = notBefore;
  if (expiresAt !== undefined) result.expiresAt = expiresAt;
  if (notBefore !== undefined && expiresAt !== undefined && Date.parse(notBefore) >= Date.parse(expiresAt)) {
    throw new Error(
      `A2A HTTP Signature key registry record ${keyid} notBefore must be earlier than expiresAt`,
    );
  }
  return result;
}

function parseRegistryInstant(value: unknown, field: string, keyid: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(
      `A2A HTTP Signature key registry record ${keyid} ${field} must be an ISO-8601 instant when present`,
    );
  }
  return value;
}

function parseRegistryScopes(
  value: unknown,
  keyid: string,
): readonly A2AWorkerRouteScope[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `A2A HTTP Signature key registry record ${keyid} scopes must be a non-empty array of known scope tokens when present`,
    );
  }
  const scopes = new Set<A2AWorkerRouteScope>();
  for (const entry of value) {
    if (typeof entry !== "string" || !A2A_WORKER_ROUTE_SCOPE_SET.has(entry)) {
      throw new Error(
        `A2A HTTP Signature key registry record ${keyid} has unknown scope token ${JSON.stringify(entry)}`,
      );
    }
    scopes.add(entry as A2AWorkerRouteScope);
  }
  return [...scopes];
}

function stringField(record: Record<string, unknown>, field: string, keyid: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`A2A HTTP Signature key registry record ${keyid} field ${field} must be a non-empty string`);
  }
  return value.trim();
}

function validateA2AHttpSignaturePublicJwk(input: unknown, keyid: string): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`A2A HTTP Signature key registry record ${keyid} publicKeyJwk must be an object`);
  }
  const jwk = input as Record<string, unknown>;
  if ("d" in jwk) {
    throw new Error(`A2A HTTP Signature key registry record ${keyid} must not contain private key material`);
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || jwk.x.length === 0) {
    throw new Error(`A2A HTTP Signature key registry record ${keyid} publicKeyJwk must be an Ed25519 public JWK`);
  }
  try {
    createPublicKey({ key: jwk, format: "jwk" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`A2A HTTP Signature key registry record ${keyid} publicKeyJwk is invalid: ${message}`);
  }
}

export type A2AHttpSignatureFailureCode =
  | "a2a_signature_malformed"
  | "a2a_signature_unsupported_profile"
  | "a2a_signature_unknown_key"
  | "a2a_signature_key_revoked"
  | "a2a_signature_key_inactive"
  | "a2a_signature_role_denied"
  | "a2a_signature_identity_mismatch"
  | "a2a_signature_time_invalid"
  | "a2a_signature_invalid"
  | "a2a_signature_replay_detected";

export type A2AHttpSignatureVerificationResult =
  | {
      ok: true;
      code?: undefined;
      keyid: string;
      requesterId: string;
      brokerId: string;
      created: number;
      expires: number;
      nonce: string;
    }
  | {
      ok: false;
      code: A2AHttpSignatureFailureCode;
      message: string;
    };

export interface A2AHttpSignatureVerifyOptions {
  nowEpochSeconds?: number;
  /**
   * Accepted forward clock skew (seconds) on the signature `created` timestamp
   * (#1402). A healthy worker whose clock is a fraction of a second ahead of
   * the broker flips `created > floor(broker_now)` at second boundaries,
   * producing intermittent-burst a2a_signature_time_invalid failures. Accepting
   * `created <= now + skew` absorbs that; `expires` stays strict, and the 60s
   * window + nonce cache keep the replay surface bounded. Default 0 (strict,
   * back-compat); the server defaults this to a small window via
   * A2A_SIGNATURE_CLOCK_SKEW_SEC.
   */
  clockSkewSeconds?: number;
  /**
   * Optional nonce cache for replay protection. When provided, the verifier
   * rejects any request whose nonce has already been seen (and is still within
   * its expiry window). Omitted preserves backward-compatible behavior without
   * replay detection. Transport-independent: works with HTTP polling, SSE,
   * webhook, websocket, and future native workers.
   */
  nonceCache?: NonceCache;
}

/**
 * Transport-independent nonce cache interface for replay protection (#917).
 * Implementations may be in-memory (single-process broker) or backed by a
 * shared store (Redis, SQLite) for multi-process deployments. The in-memory
 * implementation InMemoryNonceCache bounds memory and auto-prunes expired
 * entries.
 */
export interface NonceCache {
  /**
   * Record a nonce as seen. Returns true if the nonce was freshly recorded
   * (first use), or false if it was a duplicate (replay attack). The
   * `expiresAtEpochSeconds` determines how long the entry is retained; after
   * this instant the entry may be pruned.
   */
  record(nonce: string, expiresAtEpochSeconds: number): boolean;

  /**
   * Check whether a nonce has been recorded and not yet expired.
   */
  has(nonce: string): boolean;

  /**
   * Remove nonces whose expiresAt is before the given epoch-second cutoff.
   * Called periodically (e.g. per request or on a timer) to bound memory.
   */
  prune(nowEpochSeconds: number): void;

  /**
   * Current number of tracked nonces (for diagnostics).
   */
  size(): number;
}

/**
 * In-memory nonce cache for single-process broker deployments. Uses a Map
 * with configurable maximum size to prevent unbounded memory growth under
 * a nonce flood.
 */
export class InMemoryNonceCache implements NonceCache {
  private readonly nonces = new Map<string, number>();
  private readonly maxNonces: number;

  constructor(maxNonces = 10_000) {
    this.maxNonces = maxNonces;
  }

  record(nonce: string, expiresAtEpochSeconds: number): boolean {
    if (this.nonces.has(nonce)) {
      return false; // Duplicate within the retained expiry window.
    }
    this.nonces.set(nonce, expiresAtEpochSeconds);
    if (this.nonces.size > this.maxNonces) {
      this.prune(expiresAtEpochSeconds);
      // If still over cap after pruning, evict oldest entries.
      if (this.nonces.size > this.maxNonces) {
        let over = this.nonces.size - this.maxNonces;
        for (const key of this.nonces.keys()) {
          if (over <= 0) break;
          this.nonces.delete(key);
          over -= 1;
        }
      }
    }
    return true;
  }

  has(nonce: string): boolean {
    return this.nonces.has(nonce);
  }

  prune(nowEpochSeconds: number): void {
    for (const [nonce, expiresAt] of this.nonces) {
      if (expiresAt <= nowEpochSeconds) {
        this.nonces.delete(nonce);
      }
    }
  }

  size(): number {
    return this.nonces.size;
  }
}

interface ParsedA2AHttpSignatureInput {
  components: string[];
  params: string;
  alg: string;
  keyid: string;
  created: number;
  expires: number;
  nonce: string;
  tag: string;
}

export function buildA2AHttpSignatureBase(request: A2AHttpSignatureRequest): string {
  const parsed = parseA2AHttpSignatureInput(request.signatureInput);
  if (!componentsMatchRequiredProfile(parsed.components)) {
    throw new BrokerError("bad_request", "A2A HTTP signature input components are unsupported");
  }

  const lines = parsed.components.map((component) => {
    const value = signatureComponentValue(request, component);
    if (value === undefined) {
      throw new BrokerError("bad_request", `A2A HTTP signature component is missing: ${component}`);
    }
    return `"${component}": ${value}`;
  });
  lines.push(`"@signature-params": ${parsed.params}`);
  return lines.join("\n");
}

export function verifyA2AHttpSignature(
  request: A2AHttpSignatureRequest,
  keyRegistry: A2AHttpSignatureKeyRegistry,
  options: A2AHttpSignatureVerifyOptions = {},
): A2AHttpSignatureVerificationResult {
  const parsed = safeParseA2AHttpSignatureInput(request.signatureInput);
  if (!parsed) {
    return signatureFailure("a2a_signature_malformed", "Signature-Input must contain an a2a signature label");
  }

  if (
    !componentsMatchRequiredProfile(parsed.components) ||
    parsed.alg !== "ed25519" ||
    parsed.tag !== "a2a-worker-v1"
  ) {
    return signatureFailure("a2a_signature_unsupported_profile", "A2A HTTP signature profile is unsupported");
  }

  const keyRecord = keyRegistry[parsed.keyid];
  if (!keyRecord) {
    return signatureFailure("a2a_signature_unknown_key", "A2A HTTP signature key id is unknown");
  }
  if (keyRecord.status === "revoked") {
    return signatureFailure("a2a_signature_key_revoked", "A2A HTTP signature key has been revoked");
  }

  const requesterId = normalizedHeader(request, "x-a2a-requester-id");
  const brokerId = normalizedHeader(request, "x-a2a-broker-id");
  if (!requesterId || requesterId !== keyRecord.workerId) {
    return signatureFailure("a2a_signature_identity_mismatch", "A2A requester id does not match the signing key owner");
  }
  if (!brokerId) {
    return signatureFailure("a2a_signature_malformed", "x-a2a-broker-id is required by the A2A HTTP signature profile");
  }
  if (keyRecord.roles !== undefined) {
    const role = normalizedHeader(request, "x-a2a-requester-role");
    if (!role || !keyRecord.roles.includes(role as A2APartyRole)) {
      return signatureFailure("a2a_signature_role_denied", "A2A requester role is not authorized for this signing key");
    }
  }

  const nowEpochSeconds = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const clockSkewSeconds = Math.max(0, Math.floor(options.clockSkewSeconds ?? 0));
  // `created` tolerates a small forward skew (#1402); `expires` stays strict so
  // the acceptance window never extends past the signer's stated expiry.
  if (parsed.created > nowEpochSeconds + clockSkewSeconds || parsed.expires <= nowEpochSeconds || parsed.expires <= parsed.created) {
    return signatureFailure("a2a_signature_time_invalid", "A2A HTTP signature created/expires window is invalid");
  }
  if (keyRecord.notBefore !== undefined && nowEpochSeconds < Math.floor(Date.parse(keyRecord.notBefore) / 1000)) {
    return signatureFailure("a2a_signature_key_inactive", "A2A HTTP signature key is not yet valid");
  }
  if (keyRecord.expiresAt !== undefined && nowEpochSeconds >= Math.floor(Date.parse(keyRecord.expiresAt) / 1000)) {
    return signatureFailure("a2a_signature_key_inactive", "A2A HTTP signature key has expired");
  }

  const signatureBytes = parseA2AHttpSignatureBytes(request.signature);
  if (!signatureBytes) {
    return signatureFailure("a2a_signature_malformed", "Signature must contain an a2a base64 signature");
  }

  let signingBase: string;
  try {
    signingBase = buildA2AHttpSignatureBase(request);
  } catch (error) {
    return signatureFailure("a2a_signature_malformed", error instanceof Error ? error.message : "A2A HTTP signature base is malformed");
  }

  try {
    const publicKey = createPublicKey({ key: keyRecord.publicKeyJwk, format: "jwk" });
    const valid = verify(null, Buffer.from(signingBase), publicKey, signatureBytes);
    if (!valid) {
      return signatureFailure("a2a_signature_invalid", "A2A HTTP signature verification failed");
    }
  } catch (error) {
    return signatureFailure("a2a_signature_invalid", error instanceof Error ? error.message : "A2A HTTP signature verification failed");
  }

  // Replay protection — transport-independent nonce check (#917).
  // The nonce is covered by the HTTP signature so we know it is authentic;
  // we only need to check whether it has been seen before.
  if (options.nonceCache) {
    options.nonceCache.prune(nowEpochSeconds);
    const fresh = options.nonceCache.record(parsed.nonce, parsed.expires);
    if (!fresh) {
      return signatureFailure(
        "a2a_signature_replay_detected",
        "A2A HTTP signature nonce has already been seen — possible replay",
      );
    }
  }

  return {
    ok: true,
    keyid: parsed.keyid,
    requesterId,
    brokerId,
    created: parsed.created,
    expires: parsed.expires,
    nonce: parsed.nonce,
  };
}

export interface RateLimitDecision {
  key: string;
  limit: number;
  remaining: number;
  resetAtMs: number;
  retryAfterSec: number;
  allowed: boolean;
}

export interface RateLimitPressureSnapshot {
  limit: number;
  windowMs: number;
  activeKeys: number;
  allowedRequests: number;
  deniedRequests: number;
  busiest: Array<{
    key: string;
    inWindow: number;
    remaining: number;
    resetAtMs: number;
  }>;
}

// Hard cap on the number of per-key rate-limit buckets. The key is the
// (self-asserted) requester id or client ip, so an attacker rotating ids could
// grow this map without bound. check() only prunes when the map is over this
// cap, keeping the hot path allocation-free in the common case.
const RATE_LIMITER_MAX_KEYS = 10_000;

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private allowedRequests = 0;
  private deniedRequests = 0;

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, nowMs = Date.now()): RateLimitDecision {
    const windowStart = nowMs - this.windowMs;
    const timestamps = (this.buckets.get(key) ?? []).filter((value) => value > windowStart);
    const allowed = timestamps.length < this.maxRequests;

    if (allowed) {
      timestamps.push(nowMs);
      this.allowedRequests += 1;
    } else {
      this.deniedRequests += 1;
    }

    this.buckets.set(key, timestamps);

    if (this.buckets.size > RATE_LIMITER_MAX_KEYS) {
      this.pruneBuckets(nowMs);
    }

    const earliest = timestamps[0] ?? nowMs;
    const resetAtMs = earliest + this.windowMs;
    const retryAfterSec = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));

    return {
      key,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - timestamps.length),
      resetAtMs,
      retryAfterSec,
      allowed,
    };
  }

  /**
   * Bound the bucket map. First drop buckets that are entirely outside the
   * current window (idle keys); if still over the cap, evict the
   * oldest-inserted buckets so memory stays bounded even under a flood of
   * distinct (e.g. rotated) keys.
   */
  private pruneBuckets(nowMs: number): void {
    const windowStart = nowMs - this.windowMs;
    for (const [key, timestamps] of this.buckets) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1]! <= windowStart) {
        this.buckets.delete(key);
      }
    }
    if (this.buckets.size > RATE_LIMITER_MAX_KEYS) {
      let over = this.buckets.size - RATE_LIMITER_MAX_KEYS;
      for (const key of this.buckets.keys()) {
        if (over <= 0) break;
        this.buckets.delete(key);
        over -= 1;
      }
    }
  }

  snapshot(nowMs = Date.now(), topKeys = 5): RateLimitPressureSnapshot {
    const windowStart = nowMs - this.windowMs;
    const activeEntries = [...this.buckets.entries()]
      .map(([key, timestamps]) => {
        const inWindow = timestamps.filter((value) => value > windowStart);
        if (inWindow.length === 0) {
          this.buckets.delete(key);
          return null;
        }
        this.buckets.set(key, inWindow);
        return {
          key,
          inWindow: inWindow.length,
          remaining: Math.max(0, this.maxRequests - inWindow.length),
          resetAtMs: (inWindow[0] ?? nowMs) + this.windowMs,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => {
        if (b.inWindow !== a.inWindow) {
          return b.inWindow - a.inWindow;
        }
        return a.key.localeCompare(b.key);
      });

    return {
      limit: this.maxRequests,
      windowMs: this.windowMs,
      activeKeys: activeEntries.length,
      allowedRequests: this.allowedRequests,
      deniedRequests: this.deniedRequests,
      busiest: activeEntries.slice(0, topKeys),
    };
  }
}

export function extractRequesterIdentity(req: IncomingMessage): RequesterIdentity | null {
  const id = headerValue(req, "x-a2a-requester-id");
  const rawKind = headerValue(req, "x-a2a-requester-kind");
  const rawRole = headerValue(req, "x-a2a-requester-role");
  const rawScopes = headerValue(req, "x-a2a-requester-scopes") ?? headerValue(req, "x-a2a-requester-scope");

  if (!id) {
    if (rawKind || rawRole || rawScopes) {
      throw new BrokerError(
        "bad_request",
        "x-a2a-requester-id is required when requester kind, role, or scopes headers are present",
      );
    }
    return null;
  }

  const kind = parseRequesterKind(rawKind);
  const role = parseRequesterRole(rawRole);
  const scopes = parseRequesterScopes(rawScopes);

  return {
    id,
    ...(kind ? { kind } : {}),
    ...(role ? { role } : {}),
    ...(scopes ? { scopes } : {}),
  };
}

export interface RateLimitKeyOptions {
  trustedProxy?: boolean;
}

export function rateLimitKey(
  req: IncomingMessage,
  identity: RequesterIdentity | null,
  options: RateLimitKeyOptions = {},
): string {
  if (identity?.id) {
    return `requester:${identity.id}`;
  }

  const forwarded = options.trustedProxy ? headerValue(req, "x-forwarded-for") : undefined;
  const remoteAddress = forwarded?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  return `ip:${remoteAddress}`;
}

export function applyRateLimitHeaders(
  res: ServerResponse<IncomingMessage>,
  decision: RateLimitDecision,
  bucket: RateLimitBucket,
): void {
  res.setHeader("x-a2a-ratelimit-bucket", bucket);
  res.setHeader("x-ratelimit-limit", String(decision.limit));
  res.setHeader("x-ratelimit-remaining", String(decision.remaining));
  res.setHeader("x-ratelimit-reset", String(Math.floor(decision.resetAtMs / 1000)));
}

export function assertEdgeSecret(
  req: IncomingMessage,
  expectedSecret: string | undefined,
): void {
  if (!expectedSecret) {
    return;
  }

  const providedSecret = headerValue(req, "x-a2a-edge-secret");
  if (providedSecret && secretsMatch(providedSecret, expectedSecret)) {
    return;
  }

  throw new BrokerError(
    "unauthorized",
    "x-a2a-edge-secret is required for this route",
  );
}

export function classifyRateLimitBucket(req: IncomingMessage, url: URL): RateLimitBucket {
  const path = url.pathname;
  const segments = path.split("/").filter(Boolean);

  if (req.method === "POST" && path === "/workers/register") {
    return "worker";
  }

  if (req.method === "POST" && segments[0] === "workers" && segments[1] && segments[2] === "heartbeat") {
    return "worker";
  }

  if (
    req.method === "POST" &&
    segments[0] === "tasks" &&
    segments[1] &&
    ["claim", "start", "complete", "evidence", "fail", "heartbeat"].includes(segments[2] ?? "")
  ) {
    return "worker";
  }

  if (
    req.method === "GET" &&
    segments[0] === "a2a" &&
    segments[1] === "workers" &&
    segments[2] &&
    segments[3] === "assignment-events" &&
    headerValue(req, "x-a2a-requester-id") === segments[2]
  ) {
    return "worker";
  }

  const assignedWorkerId =
    url.searchParams.get("assignedWorkerId")?.trim() || url.searchParams.get("worker")?.trim();
  const requesterId = headerValue(req, "x-a2a-requester-id");
  if (
    req.method === "GET" &&
    path === "/tasks" &&
    assignedWorkerId &&
    requesterId === assignedWorkerId
  ) {
    return "worker";
  }

  return "general";
}

/**
 * Fail closed when a verified worker key is not authorized for the route's
 * required scope (#691). A key with no declared scopes is an unscoped legacy
 * credential and is allowed for every worker route; a key with declared scopes
 * is allowed only for the listed routes.
 */
export function assertA2AWorkerScopeAllowed(
  scopes: readonly string[] | undefined,
  requiredScope: A2AWorkerRouteScope,
): void {
  if (scopes === undefined) {
    return;
  }
  if (!scopes.includes(requiredScope)) {
    throw new BrokerError(
      "policy_denied",
      `a2a_signature_scope_denied: signing key is not authorized for ${requiredScope}`,
    );
  }
}

export function requireRequesterIdentity(identity: RequesterIdentity | null): RequesterIdentity {
  if (!identity?.id) {
    throw new BrokerError(
      "unauthorized",
      "x-a2a-requester-id is required for this route",
    );
  }

  return identity;
}

export function assertRequesterMatchesParty(
  identity: RequesterIdentity | null,
  expected: { id: string; role?: A2APartyRole },
  context: string,
): void {
  const requester = requireRequesterIdentity(identity);

  if (requester.id !== expected.id) {
    throw new BrokerError(
      "unauthorized",
      `${context} requester id must match ${expected.id}`,
    );
  }

  if (
    expected.role &&
    (expected.role === "hub" || expected.role === "operator") &&
    requester.role !== expected.role
  ) {
    throw new BrokerError(
      "unauthorized",
      `${context} requester role must match privileged actor role ${expected.role}`,
    );
  }

  if (requester.role && expected.role && requester.role !== expected.role) {
    throw new BrokerError(
      "unauthorized",
      `${context} requester role must match ${expected.role}`,
    );
  }
}

export function assertRequesterCanTouchProposalArtifacts(
  identity: RequesterIdentity | null,
  proposal: ChangeProposal,
): void {
  const requester = requireRequesterIdentity(identity);

  if (requester.role === "operator") {
    return;
  }

  if (requester.id === proposal.sourceNodeId || requester.id === proposal.targetNodeId) {
    return;
  }

  throw new BrokerError(
    "unauthorized",
    "artifact updates require the proposal source, target, or an operator requester",
  );
}

export function assertRequesterCanSubscribeToTask(
  identity: RequesterIdentity | null,
  task: TaskRecord,
): void {
  const requester = requireRequesterIdentity(identity);

  if (requester.role === "hub" || requester.role === "operator") {
    return;
  }

  const allowedIds = new Set(
    [task.requester.id, task.targetNodeId, task.assignedWorkerId].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );

  if (allowedIds.has(requester.id)) {
    return;
  }

  throw new BrokerError(
    "unauthorized",
    "task subscribe requires the task requester, target, assigned worker, or a hub/operator role",
  );
}

export function assertRequesterHasRole(
  identity: RequesterIdentity | null,
  allowedRoles: A2APartyRole[],
  context: string,
): void {
  const requester = requireRequesterIdentity(identity);

  if (!requester.role || !allowedRoles.includes(requester.role)) {
    throw new BrokerError(
      "unauthorized",
      `${context} requester role must be one of: ${allowedRoles.join(", ")}`,
    );
  }
}

/**
 * Verify a GitHub webhook delivery against the shared webhook secret using
 * the X-Hub-Signature-256 header (HMAC-SHA256 over the raw request body).
 *
 * When no secret is configured the check is skipped, preserving existing
 * deployments; when a secret is configured the check fails closed: a missing,
 * malformed, or mismatched signature rejects the delivery before parsing.
 */
export function assertGitHubWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  expectedSecret: string | undefined,
): void {
  if (!expectedSecret) {
    return;
  }

  const prefix = "sha256=";
  if (!signatureHeader || !signatureHeader.startsWith(prefix)) {
    throw new BrokerError(
      "unauthorized",
      "x-hub-signature-256 is required for this route",
    );
  }

  const expectedDigest = createHmac("sha256", expectedSecret)
    .update(rawBody)
    .digest("hex");
  if (!secretsMatch(signatureHeader.slice(prefix.length).toLowerCase(), expectedDigest)) {
    throw new BrokerError(
      "unauthorized",
      "x-hub-signature-256 verification failed",
    );
  }
}

function signatureFailure(
  code: A2AHttpSignatureFailureCode,
  message: string,
): A2AHttpSignatureVerificationResult {
  return { ok: false, code, message };
}

function parseA2AHttpSignatureInput(value: string): ParsedA2AHttpSignatureInput {
  const parsed = safeParseA2AHttpSignatureInput(value);
  if (!parsed) {
    throw new BrokerError("bad_request", "Signature-Input must contain an a2a signature label");
  }
  return parsed;
}

function safeParseA2AHttpSignatureInput(value: string | undefined): ParsedA2AHttpSignatureInput | null {
  if (!value) {
    return null;
  }

  const match = /^a2a=\((?<components>(?:"[^"]+"\s*)+)\)(?<params>(?:;[A-Za-z][A-Za-z0-9_-]*=(?:"[^"]*"|[0-9]+))+)$/.exec(value.trim());
  if (!match?.groups) {
    return null;
  }

  const components = [...match.groups.components.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]).filter(Boolean);
  const rawParams = match.groups.params;
  const params = new Map<string, string>();
  let consumed = 0;
  for (const paramMatch of rawParams.matchAll(/;([A-Za-z][A-Za-z0-9_-]*)=("[^"]*"|[0-9]+)/g)) {
    if (paramMatch.index !== consumed) {
      return null;
    }
    consumed += paramMatch[0].length;
    const rawValue = paramMatch[2] ?? "";
    params.set(paramMatch[1] ?? "", rawValue.startsWith('"') ? rawValue.slice(1, -1) : rawValue);
  }
  if (consumed !== rawParams.length) {
    return null;
  }

  const alg = params.get("alg");
  const keyid = params.get("keyid");
  const created = numberParam(params.get("created"));
  const expires = numberParam(params.get("expires"));
  const nonce = params.get("nonce");
  const tag = params.get("tag");
  if (!alg || !keyid || created === null || expires === null || !nonce || !tag) {
    return null;
  }

  return {
    components,
    params: `(${components.map((component) => `"${component}"`).join(" ")})${rawParams}`,
    alg,
    keyid,
    created,
    expires,
    nonce,
    tag,
  };
}

function numberParam(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function componentsMatchRequiredProfile(components: string[]): boolean {
  return (
    components.length === A2A_HTTP_SIGNATURE_COMPONENTS.length &&
    A2A_HTTP_SIGNATURE_COMPONENTS.every((component, index) => components[index] === component)
  );
}

function signatureComponentValue(request: A2AHttpSignatureRequest, component: string): string | undefined {
  switch (component) {
    case "@method":
      return request.method.toUpperCase();
    case "@authority":
      return request.authority.toLowerCase();
    case "@path":
      return request.path;
    case "@query":
      return request.query;
    default:
      return normalizedHeader(request, component);
  }
}

function normalizedHeader(request: A2AHttpSignatureRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()] ?? request.headers[name];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function parseA2AHttpSignatureBytes(value: string | undefined): Buffer | null {
  if (!value) {
    return null;
  }
  const match = /^a2a=:([A-Za-z0-9+/]+={0,2}):$/.exec(value.trim());
  if (!match?.[1]) {
    return null;
  }
  return Buffer.from(match[1], "base64");
}

function secretsMatch(providedSecret: string, expectedSecret: string): boolean {
  const providedBuffer = Buffer.from(providedSecret);
  const expectedBuffer = Buffer.from(expectedSecret);

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value[0]?.trim() || undefined;
  }
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  return undefined;
}

function parseRequesterKind(value: string | undefined): A2APartyKind | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = requesterKindSchema.safeParse(value);
  if (!parsed.success) {
    throw new BrokerError(
      "bad_request",
      `x-a2a-requester-kind must be one of: ${requesterKindSchema.options.join(", ")}`,
    );
  }
  return parsed.data;
}

function parseRequesterRole(value: string | undefined): A2APartyRole | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = requesterRoleSchema.safeParse(value);
  if (!parsed.success) {
    throw new BrokerError(
      "bad_request",
      `x-a2a-requester-role must be one of: ${requesterRoleSchema.options.join(", ")}`,
    );
  }
  return parsed.data;
}

function parseRequesterScopes(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const scopes = [...new Set(
    value
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )].sort((left, right) => left.localeCompare(right));

  return scopes.length > 0 ? scopes : undefined;
}
