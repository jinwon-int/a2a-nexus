/**
 * Opt-in JWS signing for runner execution proofs.
 *
 * Combines the existing tamper-evident chain digest with an asymmetric
 * signature so a downstream consumer can verify "this node instance produced
 * this proof for this input" — not just that the digests are internally
 * consistent. Self-contained (EdDSA / ES256 via node:crypto); the broker's
 * agent-card signer is in a separate package and is not a dependency here.
 *
 * JWS conformance:
 * - ES256 signatures are raw `r || s` (64 bytes), not DER, via the
 *   `dsaEncoding: "ieee-p1363"` crypto option.
 * - EC keys must be P-256 (prime256v1); other curves are rejected.
 * - Verification decodes the protected header and requires its `alg` to match
 *   the verifying key type before accepting the signature.
 *
 * Off by default: with no key, buildExecutionProof returns an unsigned proof
 * exactly as before.
 */
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { stableJsonStringify } from "./execution-proof.js";
import type { ExecutionProof, ExecutionProofSignature } from "./types.js";

type ProofAlg = "EdDSA" | "ES256";

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

interface KeyAlgorithm {
  alg: ProofAlg;
  /** Hash for cryptoSign/Verify; null for EdDSA (which hashes internally). */
  cryptoAlg: string | null;
  /** JWS-mandated raw r||s encoding for ECDSA; undefined for EdDSA. */
  dsaEncoding?: "ieee-p1363";
}

function algorithmForKey(key: KeyObject): KeyAlgorithm {
  if (key.asymmetricKeyType === "ed25519") {
    return { alg: "EdDSA", cryptoAlg: null };
  }
  if (key.asymmetricKeyType === "ec") {
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (curve !== "prime256v1") {
      throw new Error(
        `unsupported execution-proof EC curve: ${curve ?? "unknown"} (ES256 requires P-256/prime256v1)`,
      );
    }
    return { alg: "ES256", cryptoAlg: "sha256", dsaEncoding: "ieee-p1363" };
  }
  throw new Error(
    `unsupported execution-proof signing key type: ${key.asymmetricKeyType ?? "unknown"} (expected ed25519 or ec)`,
  );
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
  const { alg, cryptoAlg, dsaEncoding } = algorithmForKey(key);
  const header: Record<string, unknown> = { alg, typ: "JOSE" };
  if (options.kid) header.kid = options.kid;
  const protectedHeader = base64url(stableJsonStringify(header));
  const payload = base64url(executionProofSigningPayload(proof));
  const signature = cryptoSign(
    cryptoAlg,
    Buffer.from(`${protectedHeader}.${payload}`, "utf8"),
    dsaEncoding ? { key, dsaEncoding } : key,
  );
  return {
    ...proof,
    signature: { protected: protectedHeader, signature: signature.toString("base64url") },
  };
}

/** Verify a proof's signature against a PEM public key. */
export function verifyExecutionProofSignature(proof: ExecutionProof, publicKeyPem: string): boolean {
  const entry: ExecutionProofSignature | undefined = proof.signature;
  if (!entry) return false;

  const key = createPublicKey(publicKeyPem);
  let algorithm: KeyAlgorithm;
  try {
    algorithm = algorithmForKey(key);
  } catch {
    return false;
  }

  // The protected header must decode and declare the algorithm this key
  // implements — a signature whose header claims a different alg is rejected
  // rather than checked against the wrong primitive.
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(entry.protected, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (header.alg !== algorithm.alg) {
    return false;
  }

  const payload = base64url(executionProofSigningPayload(proof));
  try {
    return cryptoVerify(
      algorithm.cryptoAlg,
      Buffer.from(`${entry.protected}.${payload}`, "utf8"),
      algorithm.dsaEncoding ? { key, dsaEncoding: algorithm.dsaEncoding } : key,
      Buffer.from(entry.signature, "base64url"),
    );
  } catch {
    return false;
  }
}
