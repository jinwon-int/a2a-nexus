/**
 * Signed web-retrieval snapshots for the retrieval gateway (#2017, spec:
 * docs/specs/web-retrieval-snapshot-gateway).
 *
 * Mirrors the docker runner's retrieval snapshot design (canonicalized
 * payload, signature over everything except `signature`, EdDSA/ES256) so a
 * future shared-type migration stays mechanical. Canonicalization here is the
 * broker's sorted-keys canonical JSON (review-lifecycle/canonical-json.ts),
 * labeled explicitly in every snapshot.
 */

import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";

import { canonicalize, sha256Hex } from "../review-lifecycle/canonical-json.js";
import {
  WEB_RETRIEVAL_CANONICALIZATION,
  WEB_RETRIEVAL_SNAPSHOT_SCHEMA,
} from "./web-retrieval-contract.mjs";

export type WebSnapshotSignature = {
  keyId: string;
  alg: "EdDSA" | "ES256";
  value: string;
};

export type WebRetrievalSnapshot = {
  schemaVersion: typeof WEB_RETRIEVAL_SNAPSHOT_SCHEMA;
  canonicalization: typeof WEB_RETRIEVAL_CANONICALIZATION;
  provider: string;
  requestQuery?: string;
  url: string;
  retrievedAt: string;
  byteLen: number;
  contentHash: string;
  contentType?: string;
  content: string;
  signature?: WebSnapshotSignature;
};

export class WebRetrievalSnapshotError extends Error {
  readonly code:
    | "invalid_url"
    | "invalid_field"
    | "signature_missing"
    | "signature_invalid"
    | "schema_version_invalid";

  constructor(code: WebRetrievalSnapshotError["code"], message: string) {
    super(message);
    this.name = "WebRetrievalSnapshotError";
    this.code = code;
  }
}

function assertNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WebRetrievalSnapshotError("invalid_field", `${field} must be a non-empty string`);
  }
  return value;
}

export function assertPublicHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebRetrievalSnapshotError("invalid_url", "snapshot url is not a valid absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new WebRetrievalSnapshotError("invalid_url", "snapshot url must be http(s)");
  }
  if (parsed.username || parsed.password) {
    throw new WebRetrievalSnapshotError("invalid_url", "snapshot url must not carry credentials");
  }
  return parsed;
}

export function buildWebRetrievalSnapshot(params: {
  provider: string;
  url: string;
  retrievedAt: string;
  content: string;
  contentType?: string;
  requestQuery?: string;
}): WebRetrievalSnapshot {
  const url = assertNonEmpty(params.url, "url");
  assertPublicHttpUrl(url);
  const provider = assertNonEmpty(params.provider, "provider");
  const retrievedAt = assertNonEmpty(params.retrievedAt, "retrievedAt");
  if (typeof params.content !== "string") {
    throw new WebRetrievalSnapshotError("invalid_field", "content must be a string");
  }
  const snapshot: WebRetrievalSnapshot = {
    schemaVersion: WEB_RETRIEVAL_SNAPSHOT_SCHEMA,
    canonicalization: WEB_RETRIEVAL_CANONICALIZATION,
    provider,
    url,
    retrievedAt,
    byteLen: Buffer.byteLength(params.content, "utf8"),
    contentHash: `sha256:${sha256Hex(params.content)}`,
    content: params.content,
  };
  if (params.contentType !== undefined) snapshot.contentType = assertNonEmpty(params.contentType, "contentType");
  if (params.requestQuery !== undefined) snapshot.requestQuery = assertNonEmpty(params.requestQuery, "requestQuery");
  return snapshot;
}

/** Stable dedup id: identical url + content ⇒ identical id (order of fields fixed by canonicalize). */
export function snapshotIdFor(snapshot: Pick<WebRetrievalSnapshot, "url" | "contentHash">): string {
  return `web-${sha256Hex(canonicalize({ contentHash: snapshot.contentHash, url: snapshot.url }))}`;
}

function signingPayload(snapshot: WebRetrievalSnapshot): string {
  const { signature: _omit, ...rest } = snapshot;
  return canonicalize(rest);
}

function algForKeyObject(key: ReturnType<typeof createPrivateKey>): "EdDSA" | "ES256" {
  if (key.asymmetricKeyType === "ed25519") return "EdDSA";
  if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") return "ES256";
  throw new Error(`unsupported web snapshot signing key type: ${key.asymmetricKeyType ?? "unknown"}`);
}

function algForPrivateKey(privateKeyPem: string): "EdDSA" | "ES256" {
  return algForKeyObject(createPrivateKey(privateKeyPem));
}

function algForPublicKey(publicKeyPem: string): "EdDSA" | "ES256" {
  return algForKeyObject(createPublicKey(publicKeyPem));
}

export function signWebRetrievalSnapshot(
  snapshot: WebRetrievalSnapshot,
  options: { privateKeyPem: string; keyId: string },
): WebRetrievalSnapshot {
  const keyId = assertNonEmpty(options.keyId, "keyId");
  const alg = algForPrivateKey(options.privateKeyPem);
  const value = cryptoSign(null, Buffer.from(signingPayload(snapshot), "utf8"), options.privateKeyPem).toString("hex");
  return { ...snapshot, signature: { keyId, alg, value } };
}

export function verifyWebRetrievalSnapshot(
  snapshot: WebRetrievalSnapshot,
  options: { publicKeyPem: string },
): { ok: true } | { ok: false; reason: string } {
  if (snapshot.schemaVersion !== WEB_RETRIEVAL_SNAPSHOT_SCHEMA) {
    return { ok: false, reason: `schema_version_invalid: ${String(snapshot.schemaVersion)}` };
  }
  if (!snapshot.signature) {
    return { ok: false, reason: "signature_missing" };
  }
  const { signature } = snapshot;
  if (signature.alg !== "EdDSA" && signature.alg !== "ES256") {
    return { ok: false, reason: `signature_alg_invalid: ${String(signature.alg)}` };
  }
  const expectedAlg = algForPublicKey(options.publicKeyPem);
  if (signature.alg !== expectedAlg) {
    return { ok: false, reason: `signature_alg_mismatch: snapshot=${signature.alg} key=${expectedAlg}` };
  }
  let expected: WebRetrievalSnapshot;
  try {
    expected = buildWebRetrievalSnapshot({
      provider: snapshot.provider,
      url: snapshot.url,
      retrievedAt: snapshot.retrievedAt,
      content: snapshot.content,
      contentType: snapshot.contentType,
      requestQuery: snapshot.requestQuery,
    });
    // Rebuild may normalize; keep declared byteLen/contentHash authoritative checks explicit:
    if (expected.byteLen !== snapshot.byteLen || expected.contentHash !== snapshot.contentHash) {
      return { ok: false, reason: "content_hash_mismatch" };
    }
  } catch (error) {
    return { ok: false, reason: `snapshot_rebuild_failed: ${(error as Error).message}` };
  }
  const ok = cryptoVerify(
    null,
    Buffer.from(signingPayload(expected), "utf8"),
    createPublicKey(options.publicKeyPem),
    Buffer.from(signature.value, "hex"),
  );
  if (!ok) return { ok: false, reason: "signature_invalid" };
  return { ok: true };
}

/**
 * The "unsigned web citation rejected" gate: every web-derived citation in a
 * round's evidence must carry a signature that verifies against the round's
 * trusted public key. Unsigned or tampered snapshots are rejected with a
 * classified reason — never silently dropped.
 */
export function assertWebCitationsSigned(
  snapshots: WebRetrievalSnapshot[],
  options: { publicKeyPem: string },
): { ok: true } | { ok: false; rejections: Array<{ index: number; reason: string }> } {
  const rejections: Array<{ index: number; reason: string }> = [];
  for (const [index, snapshot] of snapshots.entries()) {
    const verdict = verifyWebRetrievalSnapshot(snapshot, options);
    if (!verdict.ok) rejections.push({ index, reason: verdict.reason });
  }
  return rejections.length === 0 ? { ok: true } : { ok: false, rejections };
}
