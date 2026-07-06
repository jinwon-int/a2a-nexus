/**
 * Shared offline verification primitives for A2A signed attestations
 * (verifiable analysis reports #1378, finalizer verdicts #1383).
 *
 * BROKER-INDEPENDENT by design: re-implements RFC 8785 (JCS) canonicalization
 * and the A2A 1.0 JWS verification from packages/broker/src/a2a/agent-card-signing.ts
 * with only node:crypto, so a third party verifies attestations without the
 * broker or this monorepo's runtime. Both offline verifiers import from here so
 * they can never drift onto divergent crypto paths.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

/** RFC 8785 (JCS) — mirrors agent-card-signing.ts canonicalizeJson. */
export function canonicalizeJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("RFC 8785 cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry === undefined ? null : entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`RFC 8785 cannot canonicalize value of type ${typeof value}`);
}

export function sha256Prefix(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function algorithmForKey(key) {
  if (key.asymmetricKeyType === "ed25519") return { alg: "EdDSA", cryptoAlg: null };
  if (key.asymmetricKeyType === "ec") return { alg: "ES256", cryptoAlg: "sha256" };
  return null;
}

function readDerLength(input, offset) {
  const first = input[offset];
  if (first === undefined) throw new Error("invalid ECDSA DER signature length");
  if (first < 0x80) return { length: first, offset: offset + 1 };
  const octets = first & 0x7f;
  if (octets === 0 || octets > 2) throw new Error("unsupported ECDSA DER length encoding");
  let length = 0;
  for (let i = 0; i < octets; i += 1) {
    const value = input[offset + 1 + i];
    if (value === undefined) throw new Error("truncated ECDSA DER length");
    length = (length << 8) | value;
  }
  return { length, offset: offset + 1 + octets };
}

function encodeDerLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x100) return Buffer.from([0x81, length]);
  return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
}

function normalizeUnsignedInteger(input) {
  let value = input;
  while (value.length > 1 && value[0] === 0) value = value.subarray(1);
  return value[0] !== undefined && (value[0] & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), value]) : value;
}

function joseEcdsaSignatureToDer(raw, partLength) {
  if (raw.length !== partLength * 2) throw new Error(`invalid ES256 signature length: ${raw.length}`);
  const r = normalizeUnsignedInteger(raw.subarray(0, partLength));
  const s = normalizeUnsignedInteger(raw.subarray(partLength));
  const rPart = Buffer.concat([Buffer.from([0x02]), encodeDerLength(r.length), r]);
  const sPart = Buffer.concat([Buffer.from([0x02]), encodeDerLength(s.length), s]);
  const body = Buffer.concat([rPart, sPart]);
  return Buffer.concat([Buffer.from([0x30]), encodeDerLength(body.length), body]);
}

/**
 * Verify an AgentCardSignature `{protected, signature}` over `payloadObject`
 * (signature covers `${protected}.${base64url(JCS(payload))}`). Fail-closed.
 */
export function verifyJwsSignature(payloadObject, signatureEntry, publicKeyPem) {
  if (!signatureEntry || typeof signatureEntry.protected !== "string" || typeof signatureEntry.signature !== "string") {
    return false;
  }
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return false;
  }
  const algorithm = algorithmForKey(key);
  if (!algorithm) return false;
  let payload;
  try {
    payload = base64url(canonicalizeJson(payloadObject));
  } catch {
    return false;
  }
  const signingInput = `${signatureEntry.protected}.${payload}`;
  let signature = Buffer.from(signatureEntry.signature, "base64url");
  try {
    if (algorithm.alg === "ES256") signature = joseEcdsaSignatureToDer(signature, 32);
    return cryptoVerify(algorithm.cryptoAlg, Buffer.from(signingInput, "utf8"), key, signature);
  } catch {
    return false;
  }
}

/** Decode the `kid` claim from a JWS protected header, or null. */
export function kidOf(signatureEntry) {
  try {
    const header = JSON.parse(Buffer.from(signatureEntry.protected, "base64url").toString("utf8"));
    return typeof header.kid === "string" ? header.kid : null;
  } catch {
    return null;
  }
}
