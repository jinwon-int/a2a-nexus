/**
 * Request-bound proof-of-possession for the cross-broker terminal-brief
 * receiver (opt-in).
 *
 * Federation peers authenticate transport-level with the edge secret. This
 * adds an identity layer that proves the *sender of this request* holds the
 * private key for the claimed broker id — not merely that a (public,
 * replayable) signed agent card exists.
 *
 * The receiver pins one public key per peer broker id (a JSON trust anchor
 * file). Every inbound projection must carry a `senderProof`: a JWS over a
 * binding `{ brokerId, bodyHash, issuedAt, nonce }`, signed by the pinned
 * key, where `bodyHash` covers the projection body excluding `senderProof`
 * itself. The receiver rejects a proof whose broker id is not pinned, whose
 * body hash does not match the request, whose timestamp is outside the
 * freshness window, whose nonce was already seen (replay), or whose JWS does
 * not verify. A static signed agent card alone is therefore insufficient: an
 * attacker who replays a peer's published card cannot forge a fresh
 * body-bound signature without the private key.
 *
 * Opt-in and fail-closed: with no anchor file configured, behavior is
 * unchanged; with one configured, any of the above failures rejects the
 * projection.
 */
import { readFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { canonicalizeJson } from "a2a-attestation";

export type CrossBrokerTrustAnchors = Map<string, string>;

/** Load `{ "<brokerId>": "<SPKI public key PEM>" }`; null disables the gate. */
export function loadCrossBrokerTrustAnchors(file: string | undefined): CrossBrokerTrustAnchors | null {
  if (!file?.trim()) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const anchors: CrossBrokerTrustAnchors = new Map();
  for (const [brokerId, pem] of Object.entries(parsed)) {
    const id = brokerId.trim();
    if (!id) {
      throw new Error("cross-broker trust anchor broker id must be non-empty");
    }
    if (typeof pem !== "string" || !pem.includes("PUBLIC KEY")) {
      throw new Error(`trust anchor for "${id}" must be an SPKI public key PEM string`);
    }
    anchors.set(id, pem);
  }
  if (anchors.size === 0) {
    throw new Error("cross-broker trust anchor file must pin at least one broker key");
  }
  return anchors;
}

// ---------------------------------------------------------------------------
// JWS over the request binding
// ---------------------------------------------------------------------------

export interface CrossBrokerSenderBinding {
  brokerId: string;
  bodyHash: string;
  issuedAt: string;
  nonce: string;
}

export interface CrossBrokerSenderProof {
  protected: string;
  signature: string;
  binding: CrossBrokerSenderBinding;
}

/** Exported for the conversation-plane worker signature (same JWS plumbing). */
export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

interface KeyAlg {
  alg: "EdDSA" | "ES256";
  cryptoAlg: string | null;
  dsaEncoding?: "ieee-p1363";
}

/** Exported for the conversation-plane worker signature (same JWS plumbing). */
export function algorithmForKey(key: KeyObject): KeyAlg {
  if (key.asymmetricKeyType === "ed25519") return { alg: "EdDSA", cryptoAlg: null };
  if (key.asymmetricKeyType === "ec") {
    if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("ES256 requires a P-256 key");
    }
    return { alg: "ES256", cryptoAlg: "sha256", dsaEncoding: "ieee-p1363" };
  }
  throw new Error(`unsupported key type: ${key.asymmetricKeyType ?? "unknown"}`);
}

/** sha256 over the canonicalized projection body, excluding the proof/card. */
export function crossBrokerBodyHash(body: Record<string, unknown>): string {
  const { senderProof: _omit, senderAgentCard: _card, ...rest } = body;
  return createHash("sha256").update(canonicalizeJson(rest)).digest("hex");
}

/** Sender helper: produce a request-bound proof signed by the broker's key. */
export function buildCrossBrokerSenderProof(
  privateKeyPem: string,
  params: { brokerId: string; body: Record<string, unknown>; nonce: string; issuedAt?: string; kid?: string },
): CrossBrokerSenderProof {
  const key = createPrivateKey(privateKeyPem);
  const { alg, cryptoAlg, dsaEncoding } = algorithmForKey(key);
  const binding: CrossBrokerSenderBinding = {
    brokerId: params.brokerId,
    bodyHash: crossBrokerBodyHash(params.body),
    issuedAt: params.issuedAt ?? new Date().toISOString(),
    nonce: params.nonce,
  };
  const header: Record<string, unknown> = { alg, typ: "JOSE" };
  if (params.kid) header.kid = params.kid;
  const protectedHeader = base64url(canonicalizeJson(header));
  const payload = base64url(canonicalizeJson(binding));
  const signature = cryptoSign(
    cryptoAlg,
    Buffer.from(`${protectedHeader}.${payload}`, "utf8"),
    dsaEncoding ? { key, dsaEncoding } : key,
  );
  return { protected: protectedHeader, signature: signature.toString("base64url"), binding };
}

// ---------------------------------------------------------------------------
// Receiver verification
// ---------------------------------------------------------------------------

export type CrossBrokerVerdict = { ok: true; brokerId: string } | { ok: false; reason: string };

/**
 * Bounded replay cache: nonces seen within the freshness window, scoped per
 * broker id so two trusted peers independently choosing the same nonce never
 * collide (a nonce only guards replay of the SAME sender's proof). Entries
 * are committed only after full signature verification — an attacker must
 * not be able to poison a future valid nonce with an invalid proof.
 */
export class CrossBrokerNonceCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly maxEntries = 10_000) {}

  checkAndAdd(brokerId: string, nonce: string, nowMs: number, windowMs: number): boolean {
    for (const [key, atMs] of this.seen) {
      if (nowMs - atMs > windowMs) this.seen.delete(key);
    }
    const scoped = `${brokerId}\u0000${nonce}`;
    if (this.seen.has(scoped)) return false;
    this.seen.set(scoped, nowMs);
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }
}

const DEFAULT_FRESHNESS_MS = 300_000; // ±5 min

/** Verify the request-bound proof-of-possession on an inbound projection. */
export function verifyCrossBrokerSenderProof(
  anchors: CrossBrokerTrustAnchors,
  body: unknown,
  options: { nonceCache: CrossBrokerNonceCache; now?: number; freshnessMs?: number },
): CrossBrokerVerdict {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!record) {
    return { ok: false, reason: "projection body must be an object" };
  }
  const handoff = record.crossBrokerHandoff as Record<string, unknown> | undefined;
  const claimed =
    (typeof handoff?.handoffBrokerId === "string" && (handoff.handoffBrokerId as string)) ||
    (typeof record.senderBrokerId === "string" && record.senderBrokerId) ||
    (typeof record.originBrokerId === "string" && record.originBrokerId) ||
    "";
  const claimedBrokerId = claimed.trim();
  if (!claimedBrokerId) {
    return { ok: false, reason: "projection must claim a non-empty handoff/origin broker id" };
  }
  const anchor = anchors.get(claimedBrokerId);
  if (!anchor) {
    return { ok: false, reason: `no trust anchor pinned for broker "${claimedBrokerId}"` };
  }

  const proof = record.senderProof as CrossBrokerSenderProof | undefined;
  if (
    !proof ||
    typeof proof !== "object" ||
    !proof.binding ||
    typeof proof.protected !== "string" ||
    typeof proof.signature !== "string"
  ) {
    return { ok: false, reason: "projection must carry a senderProof (request-bound proof of possession)" };
  }
  const { binding } = proof;
  if (binding.brokerId !== claimedBrokerId) {
    return { ok: false, reason: "senderProof brokerId does not match the claimed broker id" };
  }
  if (binding.bodyHash !== crossBrokerBodyHash(record)) {
    return { ok: false, reason: "senderProof bodyHash does not match the request body" };
  }

  const now = options.now ?? Date.now();
  const windowMs = options.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const issuedAtMs = Date.parse(binding.issuedAt);
  if (!Number.isFinite(issuedAtMs) || Math.abs(now - issuedAtMs) > windowMs) {
    return { ok: false, reason: "senderProof issuedAt is outside the freshness window" };
  }
  if (!binding.nonce) {
    return { ok: false, reason: "senderProof nonce is missing" };
  }

  let key: KeyObject;
  let algorithm: KeyAlg;
  try {
    key = createPublicKey(anchor);
    algorithm = algorithmForKey(key);
  } catch {
    return { ok: false, reason: "pinned trust anchor key is unusable" };
  }
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(proof.protected, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "senderProof protected header is malformed" };
  }
  if (header.alg !== algorithm.alg) {
    return { ok: false, reason: "senderProof alg does not match the pinned key" };
  }
  const payload = base64url(canonicalizeJson(binding));
  let verified = false;
  try {
    verified = cryptoVerify(
      algorithm.cryptoAlg,
      Buffer.from(`${proof.protected}.${payload}`, "utf8"),
      algorithm.dsaEncoding ? { key, dsaEncoding: algorithm.dsaEncoding } : key,
      Buffer.from(proof.signature, "base64url"),
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    return { ok: false, reason: `senderProof signature does not verify against the pinned key for "${claimedBrokerId}"` };
  }
  // Replay check LAST: the nonce is committed to the cache only for a fully
  // verified proof. An invalid signature carrying a future valid nonce must
  // not poison the cache and break the later legitimate request, and the
  // cache key is scoped by broker id so two peers using the same nonce do
  // not produce cross-peer false positives.
  if (!options.nonceCache.checkAndAdd(claimedBrokerId, binding.nonce, now, windowMs)) {
    return { ok: false, reason: "senderProof nonce was already used (replay)" };
  }
  return { ok: true, brokerId: claimedBrokerId };
}
