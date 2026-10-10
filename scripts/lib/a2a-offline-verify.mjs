/**
 * Shared offline verification primitives for A2A signed attestations
 * (verifiable analysis reports #1378, finalizer verdicts #1383).
 *
 * BROKER-INDEPENDENT by design: re-implements RFC 8785 (JCS) canonicalization
 * and the A2A 1.0 JWS verification from packages/broker/src/a2a/agent-card-signing.ts
 * with only node:crypto, so a third party verifies attestations without the
 * broker or this monorepo's runtime. Both offline verifiers import from here so
 * they can never drift onto divergent crypto paths.
 *
 * Also hosts the shared bundle-verifier helpers (check list pass/fail, shape
 * guards, JCS hashing, public-safety markers, CLI tail) that the source-only
 * proof verifiers under scripts/ and scripts/lib/ previously each carried as
 * byte-identical private copies (#2350 PR-3). Still node built-ins only.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import fs from "node:fs";
import { parseArgs } from "node:util";

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

// ---------------------------------------------------------------------------
// Shared bundle-verifier helpers.
// ---------------------------------------------------------------------------

const HASH_RE = /^sha256:[a-f0-9]{64}$/;

/** Append a passing check `{ id, ok: true }` to `checks`. */
export function pass(checks, id) {
  checks.push({ id, ok: true });
}

/** Append a failing check `{ id, ok: false, detail }` to `checks`. */
export function fail(checks, id, detail) {
  checks.push({ id, ok: false, detail });
}

export function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** True for a `sha256:<64 lowercase hex>` string. */
export function isSha256(value) {
  return typeof value === "string" && HASH_RE.test(value);
}

/** `sha256:` hash of the RFC 8785 canonical form of `value`. */
export function hashObject(value) {
  return sha256Prefix(canonicalizeJson(value));
}

/** JCS-equality of two values; false (never throws) when either cannot be canonicalized. */
export function sameJcs(a, b) {
  try {
    return canonicalizeJson(a) === canonicalizeJson(b);
  } catch {
    return false;
  }
}

/** Substrings that indicate private runtime paths/files leaked into a public-safe bundle. */
export const FORBIDDEN_RUNTIME_STRINGS = [
  "/root/",
  "/home/",
  "/Users/",
  ".openclaw/",
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "IDENTITY.md",
];

/** Secret-like token/key patterns that must never appear in a public-safe bundle. */
export const SECRET_LIKE_PATTERNS = [
  /ghp_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]+/,
  /sk_live_[A-Za-z0-9]+/,
  /rk_live_[A-Za-z0-9]+/,
  /pk_live_[A-Za-z0-9]+/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /A2A_EDGE_SECRET=/,
  /EDGE_SECRET=/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
];

/**
 * Walk `value` and collect public-safety findings `{ id, marker, path }`:
 * `private-runtime-marker` / `secret-like-string` for string leaves, and
 * `telegram-id-field` / `provider-id-field` for populated object keys.
 *
 * `rawFieldMarkers` + `rawFieldFindingId` add an optional per-caller key check
 * (the verifiers have historically used different marker sets and finding ids,
 * so these are NOT defaulted — each caller passes exactly its own).
 */
export function unsafeStringFindings(value, {
  trail = [],
  forbiddenStrings = FORBIDDEN_RUNTIME_STRINGS,
  secretPatterns = SECRET_LIKE_PATTERNS,
  rawFieldMarkers = [],
  rawFieldFindingId,
} = {}) {
  const findings = [];
  const visit = (node, pathParts) => {
    if (typeof node === "string") {
      for (const marker of forbiddenStrings) {
        if (node.includes(marker)) findings.push({ id: "private-runtime-marker", marker, path: pathParts.join(".") });
      }
      for (const pattern of secretPatterns) {
        if (pattern.test(node)) findings.push({ id: "secret-like-string", marker: String(pattern), path: pathParts.join(".") });
      }
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...pathParts, String(index)]));
    } else if (node && typeof node === "object") {
      for (const [key, item] of Object.entries(node)) {
        const lower = key.toLowerCase();
        if (item !== false && item !== null && item !== undefined) {
          if (lower.includes("telegram") && lower.includes("id")) {
            findings.push({ id: "telegram-id-field", marker: key, path: [...pathParts, key].join(".") });
          }
          if (lower.includes("provider") && lower.includes("id")) {
            findings.push({ id: "provider-id-field", marker: key, path: [...pathParts, key].join(".") });
          }
          if (rawFieldMarkers.length > 0 && rawFieldMarkers.some((marker) => lower.includes(marker))) {
            findings.push({ id: rawFieldFindingId, marker: key, path: [...pathParts, key].join(".") });
          }
        }
        visit(item, [...pathParts, key]);
      }
    }
  };
  visit(value, trail);
  return findings;
}

/**
 * Shared CLI tail for the offline bundle verifiers:
 * `<script> <input.json> --keyring <keyring.json> [--now ISO] [--json]`.
 *
 * Returns the process exit code: 2 on usage/read errors (message on stderr),
 * otherwise 0 when `result.green` and 1 when not. `--json` prints the raw
 * result; the text mode prints one `PASS`/`FAIL` line per check followed by
 * a blank line and `summary(result)`.
 */
export function runVerifierCli(argv, { usage, inputLabel, verify, summary }) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      keyring: { type: "string" },
      json: { type: "boolean", default: false },
      now: { type: "string" },
    },
  });
  const inputPath = positionals[0];
  if (!inputPath || !values.keyring) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  let input;
  let keyring;
  try {
    input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  } catch (err) {
    process.stderr.write(`cannot read ${inputLabel}: ${err.message}\n`);
    return 2;
  }
  try {
    keyring = JSON.parse(fs.readFileSync(values.keyring, "utf8"));
  } catch (err) {
    process.stderr.write(`cannot read keyring: ${err.message}\n`);
    return 2;
  }
  const result = verify(input, keyring, { now: values.now });
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const check of result.checks) {
      process.stdout.write(`${check.ok ? "PASS" : "FAIL"}  ${check.id}${check.detail ? ` — ${check.detail}` : ""}\n`);
    }
    process.stdout.write(`\n${summary(result)}\n`);
  }
  return result.green ? 0 : 1;
}
