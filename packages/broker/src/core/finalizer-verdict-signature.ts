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
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonicalizeJson } from "../a2a/agent-card-signing.js";

const FINALIZER_ROLE_PREFIX = "finalizer:";

/** Registered finalizer public keys, keyed by finalizer keyId → SPKI PEM. */
export interface FinalizerKeyring {
  keys: Record<string, string>;
}

export interface FinalizerVerdictSignatureResult {
  ok: boolean;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const pem = keyring.keys[finalizerKeyId];
  if (!pem) {
    return { ok: false, reason: `finalizerKeyId '${finalizerKeyId}' is not in the registered finalizer keyring (fail-closed)` };
  }
  let key;
  try {
    key = createPublicKey(pem);
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

/** Validate a finalizer keyring document (fail-closed). Enforces the finalizer: role prefix (#1429). */
export function loadFinalizerKeyring(value: unknown): FinalizerKeyring {
  if (!isRecord(value) || !isRecord(value["keys"])) {
    throw new Error("finalizer keyring must be an object with a 'keys' record");
  }
  const keys = value["keys"] as Record<string, unknown>;
  const validated: Record<string, string> = {};
  for (const [keyId, pem] of Object.entries(keys)) {
    if (!keyId.startsWith(FINALIZER_ROLE_PREFIX)) {
      throw new Error(`finalizer keyring keyId '${keyId}' must carry the '${FINALIZER_ROLE_PREFIX}' role prefix (disjoint registries, #1383 V-c)`);
    }
    if (typeof pem !== "string" || !pem.includes("BEGIN PUBLIC KEY")) {
      throw new Error(`finalizer keyring entry '${keyId}' must be a PEM string`);
    }
    validated[keyId] = pem;
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
