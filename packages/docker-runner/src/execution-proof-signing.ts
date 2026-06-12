/**
 * Opt-in JWS signing for runner execution proofs.
 *
 * Combines the existing tamper-evident chain digest with an asymmetric
 * signature so a downstream consumer can verify "this node instance produced
 * this proof for this input" — not just that the digests are internally
 * consistent. Self-contained (EdDSA/ES256 via node:crypto); the broker's
 * agent-card signer is in a separate package and is not a dependency here.
 *
 * Off by default: with no key, buildExecutionProof returns an unsigned proof
 * exactly as before.
 */
import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { stableJsonStringify } from "./execution-proof.js";
import type { ExecutionProof, ExecutionProofSignature } from "./types.js";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function algorithmForKey(key: KeyObject): { alg: "EdDSA" | "ES256"; cryptoAlg: string | null } {
  if (key.asymmetricKeyType === "ed25519") return { alg: "EdDSA", cryptoAlg: null };
  if (key.asymmetricKeyType === "ec") return { alg: "ES256", cryptoAlg: "sha256" };
  throw new Error(`unsupported execution-proof signing key type: ${key.asymmetricKeyType ?? "unknown"} (expected ed25519 or ec)`);
}

/** The exact bytes a proof signature covers: canonical(proof sans signature). */
export function executionProofSigningPayload(proof: ExecutionProof): string {
  const { signature: _omit, ...rest } = proof;
  return stableJsonStringify(rest);
}

/** Return a copy of the proof carrying a JWS signature. */
export function signExecutionProof(
  proof: ExecutionProof,
  options: { privateKeyPem: string; kid?: string },
): ExecutionProof {
  const key = createPrivateKey(options.privateKeyPem);
  const { alg, cryptoAlg } = algorithmForKey(key);
  const header: Record<string, unknown> = { alg, typ: "JOSE" };
  if (options.kid) header.kid = options.kid;
  const protectedHeader = base64url(stableJsonStringify(header));
  const payload = base64url(executionProofSigningPayload(proof));
  const signature = cryptoSign(cryptoAlg, Buffer.from(`${protectedHeader}.${payload}`, "utf8"), key);
  return { ...proof, signature: { protected: protectedHeader, signature: signature.toString("base64url") } };
}

/** Verify a proof's signature against a PEM public key. */
export function verifyExecutionProofSignature(proof: ExecutionProof, publicKeyPem: string): boolean {
  const entry: ExecutionProofSignature | undefined = proof.signature;
  if (!entry) return false;
  const key = createPublicKey(publicKeyPem);
  const { cryptoAlg } = algorithmForKey(key);
  const payload = base64url(executionProofSigningPayload(proof));
  return cryptoVerify(
    cryptoAlg,
    Buffer.from(`${entry.protected}.${payload}`, "utf8"),
    key,
    Buffer.from(entry.signature, "base64url"),
  );
}
