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
  /**
   * JWS unprotected header (#1919). Optional in JWS and never emitted by this
   * signer, but a card from another A2A implementation may carry it, and the
   * type must be able to hold it rather than silently dropping it on a
   * round-trip.
   *
   * It is deliberately **not** covered by the signature: the signing payload
   * excludes the entire `signatures` array, and only `protected` participates
   * in the signing input. Nothing here may be treated as authenticated.
   */
  header?: Record<string, unknown>;
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

/** The `alg` an entry claims in its protected header, or undefined if unreadable. */
function protectedAlg(entry: AgentCardSignature): string | undefined {
  try {
    const header = JSON.parse(Buffer.from(entry.protected, "base64url").toString("utf8")) as unknown;
    if (header === null || typeof header !== "object" || Array.isArray(header)) return undefined;
    const alg = (header as { alg?: unknown }).alg;
    return typeof alg === "string" ? alg : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Verify **any** signature on a card against a PEM public key (#1919).
 *
 * `signatures` is an array precisely so a card can carry more than one signer —
 * key rotation publishes a card signed by both the old and the new key, and
 * co-signing publishes one signed by two parties. Checking only `signatures[0]`
 * therefore rejected valid signatures based on their position, which broke
 * rotation and cross-implementation verification.
 *
 * Returns true if *some* entry verifies under this key. Still fail-closed: a
 * key that signed nothing on the card is rejected, and no entry is accepted on
 * anything weaker than a real signature check.
 *
 * Two things every entry gets independently, which is what makes "any" safe:
 *
 * - **Its own declared `alg`.** The algorithm is read from the entry's
 *   protected header and must match what this key can verify. Assuming the
 *   key's algorithm for every entry would feed, say, 64 raw EdDSA bytes
 *   through the ECDSA DER conversion — which throws, or worse, silently
 *   misreads.
 * - **Its own failure isolation.** A malformed neighbour must not decide the
 *   outcome for a well-formed entry; that would reintroduce exactly the
 *   position-dependent rejection this fixes, just triggered by junk instead of
 *   by index.
 *
 * The signing payload excludes the whole `signatures` array, so every entry
 * covers identical bytes and the payload is computed once.
 */
export function verifyAgentCardSignature(
  card: object & { signatures?: AgentCardSignature[] },
  publicKeyPem: string,
): boolean {
  const entries = card.signatures;
  if (!Array.isArray(entries) || entries.length === 0) {
    return false;
  }
  const key = createPublicKey(publicKeyPem);
  const { alg, cryptoAlg } = algorithmForKey(key);
  const payload = base64url(agentCardSigningPayload(card));

  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    if (typeof entry.protected !== "string" || typeof entry.signature !== "string") continue;
    // An entry signed under a different algorithm cannot be ours; skip it
    // rather than attempting a mismatched decode.
    if (protectedAlg(entry) !== alg) continue;
    try {
      const signature = Buffer.from(entry.signature, "base64url");
      const cryptoSignature = alg === "ES256" ? joseEcdsaSignatureToDer(signature, 32) : signature;
      if (cryptoVerify(cryptoAlg, Buffer.from(`${entry.protected}.${payload}`, "utf8"), key, cryptoSignature)) {
        return true;
      }
    } catch {
      // Malformed signature bytes for this entry only — keep checking the rest.
      continue;
    }
  }
  return false;
}
