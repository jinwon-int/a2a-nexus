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

/** The exact bytes a card signature covers: JCS(card sans `signatures`). */
export function agentCardSigningPayload(card: Record<string, unknown>): string {
  const { signatures: _ignored, ...rest } = card;
  return canonicalizeJson(rest);
}

/** Sign a card and return a copy carrying the `signatures` array. */
export function signAgentCard<T extends Record<string, unknown>>(
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
  return {
    ...card,
    signatures: [{ protected: protectedHeader, signature: signature.toString("base64url") }],
  };
}

/** Verify the first signature on a card against a PEM public key. */
export function verifyAgentCardSignature(
  card: Record<string, unknown> & { signatures?: AgentCardSignature[] },
  publicKeyPem: string,
): boolean {
  const entry = card.signatures?.[0];
  if (!entry) {
    return false;
  }
  const key = createPublicKey(publicKeyPem);
  const { cryptoAlg } = algorithmForKey(key);
  const payload = base64url(agentCardSigningPayload(card));
  const signingInput = `${entry.protected}.${payload}`;
  return cryptoVerify(
    cryptoAlg,
    Buffer.from(signingInput, "utf8"),
    key,
    Buffer.from(entry.signature, "base64url"),
  );
}
