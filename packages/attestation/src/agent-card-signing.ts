/**
 * Signed Agent Cards (A2A 1.0).
 *
 * A2A 1.0 formalizes agent-card authenticity as a JWS signature over the
 * RFC 8785 (JCS) canonicalization of the card, excluding the `signatures`
 * field itself. A receiving agent can verify the card was issued by the
 * holder of the signing key published for the domain.
 *
 * Opt-in: the broker signs the served card only when
 * AGENT_CARD_SIGNING_KEY_FILE points at a PEM private key (Ed25519 or
 * EC P-256). No key, no signature — the card is served unsigned exactly as
 * before.
 */
import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";

// ---------------------------------------------------------------------------
// RFC 8785 (JCS) canonicalization
// ---------------------------------------------------------------------------

/**
 * Serialize a JSON value per RFC 8785: object keys sorted by UTF-16 code
 * units, no insignificant whitespace, ES6 number serialization, standard
 * JSON string escaping. JSON.stringify already implements the required
 * number and string serialization; the work here is recursive key ordering
 * and rejecting values JSON cannot represent.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("RFC 8785 cannot canonicalize a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeJson(entry === undefined ? null : entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const body = keys
      .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
      .join(",");
    return `{${body}}`;
  }
  throw new Error(`RFC 8785 cannot canonicalize value of type ${typeof value}`);
}

// ---------------------------------------------------------------------------
// JWS signing
// ---------------------------------------------------------------------------

export interface AgentCardSignature {
  /** base64url(JSON of the protected header: { alg, typ, kid? }). */
  protected: string;
  /** base64url of the signature over `protected + "." + payload`. */
  signature: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function algorithmForKey(key: KeyObject): { alg: "EdDSA" | "ES256"; cryptoAlg: string | null } {
  if (key.asymmetricKeyType === "ed25519") {
    return { alg: "EdDSA", cryptoAlg: null };
  }
  if (key.asymmetricKeyType === "ec") {
    return { alg: "ES256", cryptoAlg: "sha256" };
  }
  throw new Error(
    `unsupported agent-card signing key type: ${key.asymmetricKeyType ?? "unknown"} (expected ed25519 or ec)`,
  );
}

function readDerLength(input: Buffer, offset: number): { length: number; offset: number } {
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

function encodeDerLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  if (length < 0x100) return Buffer.from([0x81, length]);
  return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff]);
}

function normalizeUnsignedInteger(input: Buffer): Buffer {
  let value = input;
  while (value.length > 1 && value[0] === 0) value = value.subarray(1);
  return value[0] !== undefined && (value[0] & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), value]) : value;
}

function derEcdsaSignatureToJose(der: Buffer, partLength: number): Buffer {
  if (der[0] !== 0x30) throw new Error("invalid ECDSA DER signature");
  let cursor = readDerLength(der, 1).offset;
  if (der[cursor] !== 0x02) throw new Error("invalid ECDSA DER signature r marker");
  const rLen = readDerLength(der, cursor + 1);
  cursor = rLen.offset;
  let r = der.subarray(cursor, cursor + rLen.length);
  cursor += rLen.length;
  if (der[cursor] !== 0x02) throw new Error("invalid ECDSA DER signature s marker");
  const sLen = readDerLength(der, cursor + 1);
  cursor = sLen.offset;
  let s = der.subarray(cursor, cursor + sLen.length);
  r = normalizeUnsignedInteger(r);
  s = normalizeUnsignedInteger(s);
  if (r[0] === 0) r = r.subarray(1);
  if (s[0] === 0) s = s.subarray(1);
  if (r.length > partLength || s.length > partLength) throw new Error("ECDSA signature part too large");
  return Buffer.concat([Buffer.alloc(partLength - r.length), r, Buffer.alloc(partLength - s.length), s]);
}

function joseEcdsaSignatureToDer(raw: Buffer, partLength: number): Buffer {
  if (raw.length !== partLength * 2) throw new Error(`invalid ES256 signature length: ${raw.length}`);
  const r = normalizeUnsignedInteger(raw.subarray(0, partLength));
  const s = normalizeUnsignedInteger(raw.subarray(partLength));
  const rPart = Buffer.concat([Buffer.from([0x02]), encodeDerLength(r.length), r]);
  const sPart = Buffer.concat([Buffer.from([0x02]), encodeDerLength(s.length), s]);
  const body = Buffer.concat([rPart, sPart]);
  return Buffer.concat([Buffer.from([0x30]), encodeDerLength(body.length), body]);
}

/**
 * The exact bytes a card signature covers: JCS(card sans `signatures`).
 *
 * Takes `object` rather than `Record<string, unknown>` so typed callers (an
 * `AgentCard`, a provenance payload) can pass their value directly. A TS
 * interface has no index signature and so does not satisfy `Record<string,
 * unknown>`; requiring it forced every caller to widen through `unknown`,
 * which is how the shipped card lost its type on the signing path (#1912 F2).
 * The single widening now happens here, at the serialization boundary, where
 * the value is about to become JSON regardless.
 */
export function agentCardSigningPayload(card: object): string {
  const { signatures: _ignored, ...rest } = card as Record<string, unknown>;
  return canonicalizeJson(rest);
}

/** Sign a card and return a copy carrying the `signatures` array. */
export function signAgentCard<T extends object>(
  card: T,
  options: { privateKeyPem: string; kid?: string },
): T & { signatures: AgentCardSignature[] } {
  const key = createPrivateKey(options.privateKeyPem);
  const { alg, cryptoAlg } = algorithmForKey(key);
  const header: Record<string, unknown> = { alg, typ: "JOSE" };
  if (options.kid) {
    header.kid = options.kid;
  }
  const protectedHeader = base64url(canonicalizeJson(header));
  const payload = base64url(agentCardSigningPayload(card));
  const signingInput = `${protectedHeader}.${payload}`;
  const signature = cryptoSign(cryptoAlg, Buffer.from(signingInput, "utf8"), key);
  const jwsSignature = alg === "ES256" ? derEcdsaSignatureToJose(signature, 32) : signature;
  return {
    ...card,
    signatures: [{ protected: protectedHeader, signature: jwsSignature.toString("base64url") }],
  };
}

/** Verify the first signature on a card against a PEM public key. */
export function verifyAgentCardSignature(
  card: object & { signatures?: AgentCardSignature[] },
  publicKeyPem: string,
): boolean {
  const entry = card.signatures?.[0];
  if (!entry) {
    return false;
  }
  const key = createPublicKey(publicKeyPem);
  const { alg, cryptoAlg } = algorithmForKey(key);
  const payload = base64url(agentCardSigningPayload(card));
  const signingInput = `${entry.protected}.${payload}`;
  const signature = Buffer.from(entry.signature, "base64url");
  const cryptoSignature = alg === "ES256" ? joseEcdsaSignatureToDer(signature, 32) : signature;
  return cryptoVerify(
    cryptoAlg,
    Buffer.from(signingInput, "utf8"),
    key,
    cryptoSignature,
  );
}
