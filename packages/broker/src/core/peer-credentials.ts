/**
 * peer-credentials.ts — Minimum-scope peer broker credentials for the
 * cross-broker handoff surface (contracts/a2a/broker-handoff-protocol.md
 * "Peer permission scopes").
 *
 * The handoff contract freezes three peer scopes — `handoff:create`,
 * `handoff:status`, `handoff:evidence` (plus optional `handoff:comment`) — and
 * requires that "a peer missing the required scope fails closed before task
 * creation or evidence mutation". Until now those scopes existed only in the
 * contract and conformance fixtures; runtime authorization was the coarse
 * edge-secret + requester-role gate. This module implements the runtime half:
 *
 * - A **peer credential registry** file (root-only permissions enforced at
 *   load time) maps a peer broker id to a secret digest and an explicit scope
 *   subset. Raw broker edge secrets are NOT reused; each peer credential is a
 *   dedicated secret with the minimum scope set for its direction.
 * - Peers authenticate with `x-a2a-peer-broker-id` + `x-a2a-peer-secret`
 *   headers. Verification is timing-safe against the stored sha256 digest.
 * - Route handlers call {@link assertPeerHandoffScope} with the scope the
 *   route requires. Mode `off` disables the gate, `auto` verifies whenever
 *   peer headers are present (legacy callers without peer headers keep the
 *   pre-existing role/edge-secret behavior), `enforce` requires a verified
 *   peer credential and fails closed without one.
 *
 * The registry file stores `secretSha256` digests, never raw secrets, so the
 * raw credential exists only on the sending peer. A `secret` field is also
 * accepted for in-memory/test registries but is rejected when loading from a
 * file, to keep raw secrets out of provisioned artifacts.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";

import { BrokerError } from "./broker.js";

/** Canonical peer scope tokens frozen by the broker handoff protocol (v0). */
export const A2A_PEER_HANDOFF_SCOPES = [
  "handoff:create",
  "handoff:status",
  "handoff:evidence",
  "handoff:comment",
] as const;

export type A2APeerHandoffScope = (typeof A2A_PEER_HANDOFF_SCOPES)[number];

const A2A_PEER_HANDOFF_SCOPE_SET: ReadonlySet<string> = new Set(A2A_PEER_HANDOFF_SCOPES);

export type PeerHandoffScopeMode = "off" | "auto" | "enforce";

export const A2A_PEER_HANDOFF_SCOPE_MODES: readonly PeerHandoffScopeMode[] = ["off", "auto", "enforce"];

export interface PeerCredentialRecord {
  /** Peer broker id (e.g. the opposite team's broker). */
  peerBrokerId: string;
  /** Hex sha256 digest of the peer secret. */
  secretSha256: string;
  /** Explicit minimum scope subset granted to this peer credential. */
  scopes: readonly A2APeerHandoffScope[];
  /** Optional lifecycle switch; `revoked` fails closed while staying listed. */
  status?: "active" | "revoked";
}

export type PeerCredentialRegistry = Record<string, PeerCredentialRecord>;

export interface VerifiedPeer {
  peerBrokerId: string;
  scopes: readonly A2APeerHandoffScope[];
}

/**
 * Load and validate a peer credential registry file. Fails closed on: missing
 * or malformed file, raw `secret` fields, unknown scope tokens, duplicate ids,
 * and (on POSIX hosts) group/other-accessible file permissions — the registry
 * must be root-only (e.g. 0600/0400).
 */
export function loadPeerCredentialRegistryFile(path: string): PeerCredentialRegistry {
  assertRootOnlyFileMode(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read A2A peer credential registry file ${path}: ${message}`);
  }
  return parsePeerCredentialRegistry(parsed, path, { allowRawSecret: false });
}

/** Parse an in-memory registry object (tests may use raw `secret` fields). */
export function parsePeerCredentialRegistry(
  input: unknown,
  source: string,
  options: { allowRawSecret?: boolean } = {},
): PeerCredentialRegistry {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`A2A peer credential registry ${source} must be a JSON object keyed by peer broker id`);
  }
  const registry: PeerCredentialRegistry = {};
  for (const [registryKey, value] of Object.entries(input as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`A2A peer credential registry record ${registryKey} must be an object`);
    }
    const record = value as Record<string, unknown>;
    const embeddedId = typeof record.peerBrokerId === "string" ? record.peerBrokerId.trim() : undefined;
    if (embeddedId && embeddedId !== registryKey) {
      throw new Error(`A2A peer credential registry key must match embedded peerBrokerId for ${registryKey}`);
    }
    const peerBrokerId = registryKey.trim();
    if (!peerBrokerId) {
      throw new Error("A2A peer credential registry contains an empty peer broker id key");
    }
    const secretSha256 = resolveSecretDigest(record, registryKey, options.allowRawSecret === true);
    const scopes = parsePeerScopes(record.scopes, registryKey);
    const status = parsePeerStatus(record.status, registryKey);
    registry[peerBrokerId] = {
      peerBrokerId,
      secretSha256,
      scopes,
      ...(status ? { status } : {}),
    };
  }
  return registry;
}

export function parsePeerHandoffScopeMode(value: string | undefined, source: string): PeerHandoffScopeMode {
  if (value === undefined || value === "") return "auto";
  if ((A2A_PEER_HANDOFF_SCOPE_MODES as readonly string[]).includes(value)) {
    return value as PeerHandoffScopeMode;
  }
  throw new Error(
    `${source} must be one of ${A2A_PEER_HANDOFF_SCOPE_MODES.join("|")} when set (got ${JSON.stringify(value)})`,
  );
}

/**
 * Resolve the peer identity asserted by the request headers against the
 * registry. Returns `null` when the request carries no peer headers. Throws
 * `BrokerError("unauthorized")` (fail closed) when peer headers are present
 * but incomplete, unknown, revoked, or the secret does not verify.
 */
export function resolvePeerFromRequest(
  registry: PeerCredentialRegistry | null,
  req: IncomingMessage,
): VerifiedPeer | null {
  const peerBrokerId = headerValue(req, "x-a2a-peer-broker-id");
  const peerSecret = headerValue(req, "x-a2a-peer-secret");
  if (!peerBrokerId && !peerSecret) return null;
  if (!registry) {
    throw new BrokerError("unauthorized", "peer credentials are not accepted by this broker");
  }
  if (!peerBrokerId || !peerSecret) {
    throw new BrokerError(
      "unauthorized",
      "x-a2a-peer-broker-id and x-a2a-peer-secret must be presented together",
    );
  }
  const record = registry[peerBrokerId];
  if (!record || record.status === "revoked" || !peerSecretMatches(record, peerSecret)) {
    // Single indistinguishable failure message: do not leak which part failed.
    throw new BrokerError("unauthorized", "peer credential rejected");
  }
  return { peerBrokerId: record.peerBrokerId, scopes: record.scopes };
}

/**
 * Fail-closed scope assertion for a handoff route.
 *
 * - `off`: never asserts.
 * - `auto`: asserts only when the caller presented (and passed) peer
 *   credential verification; header-less callers fall through to the
 *   pre-existing role/edge-secret gates.
 * - `enforce`: requires a verified peer with the scope; header-less callers
 *   fail closed.
 */
export function assertPeerHandoffScope(
  mode: PeerHandoffScopeMode,
  peer: VerifiedPeer | null,
  requiredScope: A2APeerHandoffScope,
  operation: string,
): void {
  if (mode === "off") return;
  if (peer === null) {
    if (mode === "enforce") {
      throw new BrokerError(
        "unauthorized",
        `${operation} requires a peer credential with the ${requiredScope} scope`,
      );
    }
    return;
  }
  if (!peer.scopes.includes(requiredScope)) {
    throw new BrokerError(
      "unauthorized",
      `peer ${peer.peerBrokerId} is not granted the ${requiredScope} scope required for ${operation}`,
    );
  }
}

/** Registry lookup helper for non-HTTP surfaces (e.g. the GitHub handoff lane). */
export function peerHasHandoffScope(
  registry: PeerCredentialRegistry | null,
  peerBrokerId: string | undefined,
  requiredScope: A2APeerHandoffScope,
): boolean {
  if (!registry || !peerBrokerId) return false;
  const record = registry[peerBrokerId];
  if (!record || record.status === "revoked") return false;
  return record.scopes.includes(requiredScope);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function peerSecretMatches(record: PeerCredentialRecord, providedSecret: string): boolean {
  const provided = Buffer.from(sha256Hex(providedSecret), "hex");
  const expected = Buffer.from(record.secretSha256, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function resolveSecretDigest(
  record: Record<string, unknown>,
  registryKey: string,
  allowRawSecret: boolean,
): string {
  const rawSecret = record.secret;
  const digest = record.secretSha256;
  if (rawSecret !== undefined) {
    if (!allowRawSecret) {
      throw new Error(
        `A2A peer credential registry record ${registryKey} must store secretSha256, not a raw secret`,
      );
    }
    if (typeof rawSecret !== "string" || rawSecret.length === 0) {
      throw new Error(`A2A peer credential registry record ${registryKey} secret must be a non-empty string`);
    }
    return sha256Hex(rawSecret);
  }
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/i.test(digest)) {
    throw new Error(
      `A2A peer credential registry record ${registryKey} secretSha256 must be a 64-hex-char sha256 digest`,
    );
  }
  return digest.toLowerCase();
}

function parsePeerScopes(value: unknown, registryKey: string): readonly A2APeerHandoffScope[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `A2A peer credential registry record ${registryKey} scopes must be a non-empty array of handoff scope tokens`,
    );
  }
  const scopes = new Set<A2APeerHandoffScope>();
  for (const entry of value) {
    if (typeof entry !== "string" || !A2A_PEER_HANDOFF_SCOPE_SET.has(entry)) {
      throw new Error(
        `A2A peer credential registry record ${registryKey} has unknown handoff scope ${JSON.stringify(entry)}`,
      );
    }
    scopes.add(entry as A2APeerHandoffScope);
  }
  return [...scopes];
}

function parsePeerStatus(value: unknown, registryKey: string): "active" | "revoked" | undefined {
  if (value === undefined) return undefined;
  if (value !== "active" && value !== "revoked") {
    throw new Error(
      `A2A peer credential registry record ${registryKey} status must be "active" or "revoked" when present`,
    );
  }
  return value;
}

function assertRootOnlyFileMode(path: string): void {
  if (process.platform === "win32") return;
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to stat A2A peer credential registry file ${path}: ${message}`);
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `A2A peer credential registry file ${path} must not be group/other accessible (expected 0600-style permissions)`,
    );
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
