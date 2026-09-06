// In-broker finalizer-verdict signature verification (#1383 V-c follow-up).
//
// The accept-path admission hook (finalizer-verdict-admission.ts) checks a
// verdict's structure/decision/subject-binding/independence with no crypto.
// This module adds the piece the adversarial round's attack-surface lens
// wanted at accept time: verifying the STATIC-KEY verdict SIGNATURE against a
// registered finalizer keyring, so a structurally-plausible but forged verdict
// is rejected by the broker itself — not only later by the merge gate.
//
// It reuses the broker's OWN RFC 8785 JCS (a2a/agent-card-signing) + node:crypto
// EdDSA verify, so there is no second crypto stack to drift; the signature
// module test pins the JCS output to golden rfc8785-jcs-v1 forms (the same spec
// the offline verifier implements), so the two remain interoperable.
//
// Scope: the STATIC-KEY path (finalizerKeyId + sig). The attester (S3) path
// requires X509/Fulcio chain verification, which stays with the merge gate
// (verify-finalizer-verdict.mjs) to keep cert-chain work out of the completion
// hot path — a documented v0 boundary.
import { verify as cryptoVerify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonicalizeJson } from "./agent-card-signing.js";
import { cachedPublicKey } from "./key-object-cache.js";
import { isRecord } from "./value-guards.js";

const FINALIZER_ROLE_PREFIX = "finalizer:";

/**
 * A registered finalizer key with optional lifecycle (#1383 V-c follow-up).
 * A `revoked` key is rejected immediately (closes the revocation-lag gap); a
 * notBefore/expiresAt window is checked against the verdict's `producedAt`.
 */
export interface FinalizerKeyRecord {
  pem: string;
  status?: "active" | "revoked";
  notBefore?: string;
  expiresAt?: string;
  /** Resolved once by loadFinalizerKeyring so verify skips the per-call PEM re-parse. */
  keyObject?: KeyObject;
}

/**
 * Registered finalizer public keys, keyed by finalizer keyId. The value is
 * either a bare SPKI PEM (active, no window — back-compat) or a lifecycle record.
 */
export interface FinalizerKeyring {
  keys: Record<string, string | FinalizerKeyRecord>;
}

function keyRecordOf(entry: string | FinalizerKeyRecord): FinalizerKeyRecord {
  return typeof entry === "string" ? { pem: entry } : entry;
}

export interface FinalizerVerdictSignatureResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify a static-key finalizer verdict signature: the finalizerKeyId must be
 * registered in the keyring, and the JWS `sig` must verify over
 * `${sig.protected}.${base64url(JCS(verdict sans sig))}` with that key.
 * Fail-closed; never throws.
 */
export function verifyFinalizerVerdictSignature(verdict: unknown, keyring: FinalizerKeyring): FinalizerVerdictSignatureResult {
  if (!isRecord(verdict)) return { ok: false, reason: "verdict is not an object" };
  const finalizerKeyId = verdict["finalizerKeyId"];
  if (typeof finalizerKeyId !== "string" || !finalizerKeyId) {
    return { ok: false, reason: "verdict has no finalizerKeyId (static-key signature path only; attester path verified by the merge gate)" };
  }
  const sig = verdict["sig"];
  if (!isRecord(sig) || typeof sig["protected"] !== "string" || typeof sig["signature"] !== "string") {
    return { ok: false, reason: "verdict.sig is missing or malformed" };
  }
  const entry = keyring.keys[finalizerKeyId];
  if (!entry) {
    return { ok: false, reason: `finalizerKeyId '${finalizerKeyId}' is not in the registered finalizer keyring (fail-closed)` };
  }
  const record = keyRecordOf(entry);
  const { pem } = record;

  // Lifecycle (#1383 V-c follow-up): a revoked key is rejected immediately; a
  // validity window is checked against the verdict's producedAt.
  if (record.status === "revoked") {
    return { ok: false, reason: `finalizerKeyId '${finalizerKeyId}' is revoked` };
  }
  if (record.notBefore !== undefined || record.expiresAt !== undefined) {
    const producedAt = verdict["producedAt"];
    const producedMs = typeof producedAt === "string" ? Date.parse(producedAt) : NaN;
    if (!Number.isFinite(producedMs)) {
      return { ok: false, reason: `verdict has no valid producedAt to check against key '${finalizerKeyId}' validity window (fail-closed)` };
    }
    if (record.notBefore !== undefined && producedMs < Date.parse(record.notBefore)) {
      return { ok: false, reason: `verdict producedAt is before key '${finalizerKeyId}' notBefore (outside validity window)` };
    }
    if (record.expiresAt !== undefined && producedMs > Date.parse(record.expiresAt)) {
      return { ok: false, reason: `verdict producedAt is after key '${finalizerKeyId}' expiresAt (outside validity window)` };
    }
  }

  let key;
  try {
    key = record.keyObject ?? cachedPublicKey(pem);
  } catch {
    return { ok: false, reason: `registered key for '${finalizerKeyId}' is not a parseable public key` };
  }
  if (key.asymmetricKeyType !== "ed25519") {
    return { ok: false, reason: `finalizer key '${finalizerKeyId}' must be Ed25519 (EdDSA)` };
  }
  const { sig: _omit, ...unsigned } = verdict;
  let payload: string;
  try {
    payload = Buffer.from(canonicalizeJson(unsigned)).toString("base64url");
  } catch (error) {
    return { ok: false, reason: `verdict is not canonicalizable: ${error instanceof Error ? error.message : String(error)}` };
  }
  const signingInput = `${sig["protected"]}.${payload}`;
  try {
    const ok = cryptoVerify(null, Buffer.from(signingInput, "utf8"), key, Buffer.from(sig["signature"], "base64url"));
    return ok ? { ok: true } : { ok: false, reason: "finalizer signature failed verification" };
  } catch (error) {
    return { ok: false, reason: `signature verification error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function validateInstant(value: unknown, field: string, keyId: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`finalizer keyring entry '${keyId}' ${field} must be an ISO-8601 instant`);
  }
  return value;
}

/** Validate a finalizer keyring document (fail-closed). Enforces the finalizer: role prefix (#1429) and lifecycle fields. */
export function loadFinalizerKeyring(value: unknown): FinalizerKeyring {
  if (!isRecord(value) || !isRecord(value["keys"])) {
    throw new Error("finalizer keyring must be an object with a 'keys' record");
  }
  const keys = value["keys"] as Record<string, unknown>;
  const validated: Record<string, string | FinalizerKeyRecord> = {};
  for (const [keyId, entry] of Object.entries(keys)) {
    if (!keyId.startsWith(FINALIZER_ROLE_PREFIX)) {
      throw new Error(`finalizer keyring keyId '${keyId}' must carry the '${FINALIZER_ROLE_PREFIX}' role prefix (disjoint registries, #1383 V-c)`);
    }
    const pem = typeof entry === "string" ? entry : isRecord(entry) ? entry["pem"] : undefined;
    if (typeof pem !== "string" || !pem.includes("BEGIN PUBLIC KEY")) {
      throw new Error(`finalizer keyring entry '${keyId}' must be a PEM string (or a record with a 'pem' PEM string)`);
    }
    if (typeof entry === "string") {
      validated[keyId] = entry;
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record["status"] !== undefined && record["status"] !== "active" && record["status"] !== "revoked") {
      throw new Error(`finalizer keyring entry '${keyId}' status must be "active" or "revoked" when present`);
    }
    const notBefore = validateInstant(record["notBefore"], "notBefore", keyId);
    const expiresAt = validateInstant(record["expiresAt"], "expiresAt", keyId);
    if (notBefore !== undefined && expiresAt !== undefined && Date.parse(notBefore) >= Date.parse(expiresAt)) {
      throw new Error(`finalizer keyring entry '${keyId}' notBefore must be earlier than expiresAt`);
    }
    // Resolve the KeyObject once here; an unparseable PEM stays unresolved so
    // verify fails per-verdict with the same reason as before, not at load.
    let keyObject: KeyObject | undefined;
    try {
      keyObject = cachedPublicKey(pem);
    } catch {
      keyObject = undefined;
    }
    validated[keyId] = {
      pem,
      ...(record["status"] !== undefined ? { status: record["status"] as "active" | "revoked" } : {}),
      ...(notBefore !== undefined ? { notBefore } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(keyObject !== undefined ? { keyObject } : {}),
    };
  }
  return { keys: validated };
}

/** Load and validate a finalizer keyring from disk; any failure is a loud throw (startup preflight). */
export function loadFinalizerKeyringFile(path: string): FinalizerKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot load finalizer keyring file '${path}': ${(error as Error).message}`);
  }
  return loadFinalizerKeyring(parsed);
}
