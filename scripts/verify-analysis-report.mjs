#!/usr/bin/env node
/**
 * Independent offline verifier for Verifiable Analysis Report v1 (#1378).
 *
 * Contract: contracts/a2a/verifiable-analysis-report.md
 *
 * v1 aligns the offline report bundle to the broker's ACTUAL provenance
 * primitives landed in #1380 (packages/broker/src/core/provenance.ts) rather
 * than a parallel scheme: RFC 8785 (JCS) canonicalization and the A2A 1.0 JWS
 * signature construction from packages/broker/src/a2a/agent-card-signing.ts.
 *
 * The verifier re-implements JCS + JWS verification with only node:crypto so a
 * third party can check a bundle WITHOUT the broker or this monorepo — that
 * broker-independence is the whole point. The re-implementation mirrors
 * agent-card-signing.ts byte-for-byte; a dev-time round-trip against the real
 * broker signers confirms compatibility (see the PR evidence).
 *
 * Safety: source-only verification. Reads the report + keyring, recomputes
 * hashes and verifies signatures. No network, no writes, no issue/PR/dispatch/
 * restart/credential action. Never emits private key material.
 *
 * Usage:
 *   node scripts/verify-analysis-report.mjs <report.json> --keyring <keyring.json> [--json]
 * Exit 0 = GREEN (every check passed); non-zero = fail-closed.
 */
import fs from "node:fs";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { parseArgs } from "node:util";

export const REPORT_VERSION = "verifiable-analysis-report/v1";
export const CANONICALIZATION = "rfc8785-jcs-v1";
export const RESULT_PROVENANCE_SCHEMA = "a2a.result.provenance.v1";
export const BROKER_COUNTERSIG_SCHEMA = "a2a.result.provenance.broker-countersig.v1";
export const RETRIEVAL_SNAPSHOT_SCHEMA = "a2a.retrieval.snapshot.v1";

// ---------------------------------------------------------------------------
// RFC 8785 (JCS) canonicalization — mirrors agent-card-signing.ts canonicalizeJson.
// ---------------------------------------------------------------------------
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

function sha256Prefix(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// JWS verification — mirrors agent-card-signing.ts verifyAgentCardSignature.
// Signature covers `${protected}.${base64url(JCS(payload))}`. ES256 signatures
// are stored JOSE-raw (r||s) and converted to DER for node's verify.
// ---------------------------------------------------------------------------
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

/** Verify an AgentCardSignature `{protected, signature}` over `payloadObject`. Fail-closed. */
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
function kidOf(signatureEntry) {
  try {
    const header = JSON.parse(Buffer.from(signatureEntry.protected, "base64url").toString("utf8"));
    return typeof header.kid === "string" ? header.kid : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provenance verification (mirrors provenance.ts semantics, standalone).
// ---------------------------------------------------------------------------
function hashTaskResult(result) {
  const { provenance: _omit, ...rest } = result;
  return sha256Prefix(canonicalizeJson(rest));
}

function fail(checks, id, detail) { checks.push({ id, ok: false, detail }); }
function pass(checks, id) { checks.push({ id, ok: true }); }

/**
 * Verify a report bundle against a keyring `{ keys: { [keyId]: pemPublicKey } }`.
 * Returns { green, checks: [{id, ok, detail?}] }. Never throws on a malformed
 * bundle — that is a fail-closed result, not a crash.
 */
export function verifyReport(report, keyring) {
  const checks = [];
  const keys = (keyring && keyring.keys) || {};

  // 1. Shape.
  const shapeOk =
    report && typeof report === "object" &&
    report.reportVersion === REPORT_VERSION &&
    typeof report.taskId === "string" &&
    report.result && typeof report.result === "object" &&
    report.result.provenance && typeof report.result.provenance === "object" &&
    Array.isArray(report.sources);
  if (!shapeOk) {
    fail(checks, "shape", "missing/invalid required fields or reportVersion mismatch");
    return { green: false, checks };
  }

  // 2. Assurance (correctness-separation) invariant — #1379's unique guard, preserved.
  const a = report.assurance;
  const doesNotProve = a && Array.isArray(a.doesNotProve) ? a.doesNotProve : [];
  if (!a || !doesNotProve.includes("analytical-correctness") || !doesNotProve.includes("normative-judgment") ||
      typeof a.disclaimer !== "string" || a.disclaimer.trim().length === 0) {
    fail(checks, "assurance-invariant", "assurance must declare it does NOT prove analytical-correctness/normative-judgment with a non-empty disclaimer");
  } else {
    pass(checks, "assurance-invariant");
  }

  // 3-5. Result provenance: resultHash binding + worker signature + broker countersignature.
  const prov = report.result.provenance;
  if (prov.schemaVersion !== RESULT_PROVENANCE_SCHEMA || prov.canonicalization !== CANONICALIZATION) {
    fail(checks, "provenance-schema", "unsupported provenance schema/canonicalization");
  } else {
    pass(checks, "provenance-schema");
  }
  const actualHash = hashTaskResult(report.result);
  if (actualHash !== prov.resultHash) {
    fail(checks, "result-hash", "resultHash does not match sha256(JCS(result sans provenance)) — result was altered");
  } else {
    pass(checks, "result-hash");
  }
  const workerPem = keys[prov.workerKeyId];
  if (!workerPem) {
    fail(checks, "worker-signature", `workerKeyId '${prov.workerKeyId}' not in keyring (fail-closed)`);
  } else {
    const payload = {
      schemaVersion: RESULT_PROVENANCE_SCHEMA,
      canonicalization: CANONICALIZATION,
      taskId: report.taskId,
      claimedAt: prov.claimedAt,
      resultHash: prov.resultHash,
    };
    if (verifyJwsSignature(payload, prov.workerSig, workerPem)) {
      pass(checks, "worker-signature");
    } else {
      fail(checks, "worker-signature", "worker signature failed verification");
    }
  }
  const counter = prov.brokerCountersig;
  if (!counter || typeof counter !== "object") {
    fail(checks, "broker-countersignature", "missing brokerCountersig (fail-closed)");
  } else {
    const brokerPem = keys[counter.brokerKeyId];
    if (!brokerPem) {
      fail(checks, "broker-countersignature", `brokerKeyId '${counter.brokerKeyId}' not in keyring (fail-closed)`);
    } else {
      const payload = {
        schemaVersion: BROKER_COUNTERSIG_SCHEMA,
        canonicalization: CANONICALIZATION,
        taskId: report.taskId,
        verifiedAt: counter.verifiedAt,
        workerSig: prov.workerSig,
      };
      if (verifyJwsSignature(payload, counter.sig, brokerPem)) {
        pass(checks, "broker-countersignature");
      } else {
        fail(checks, "broker-countersignature", "broker countersignature failed verification");
      }
    }
  }

  // 6. Retrieval snapshots: each snapshot self-verifies (byteLen + contentHash + signature).
  //    v1 verifies each source's authenticity; cryptographic result<->source binding is a
  //    documented gap pending the K2 executor wiring (see contract §5).
  // An empty sources array is allowed (analysis with no external source).
  report.sources.forEach((snap, i) => {
    const id = `source[${i}]`;
    if (!snap || typeof snap !== "object" || snap.schemaVersion !== RETRIEVAL_SNAPSHOT_SCHEMA || snap.canonicalization !== CANONICALIZATION) {
      return fail(checks, id, "unsupported/invalid snapshot");
    }
    if (typeof snap.content !== "string" || snap.byteLen !== Buffer.byteLength(snap.content, "utf8")) {
      return fail(checks, id, "byteLen mismatch");
    }
    if (snap.contentHash !== sha256Prefix(snap.content)) {
      return fail(checks, id, "contentHash mismatch — snapshot content altered");
    }
    const kid = kidOf(snap.signature);
    const pem = kid && keys[kid];
    if (!pem) {
      return fail(checks, id, `snapshot signing key '${kid ?? "?"}' not in keyring (fail-closed)`);
    }
    const { signature: _omit, ...unsigned } = snap;
    if (!verifyJwsSignature(unsigned, snap.signature, pem)) {
      return fail(checks, id, "snapshot signature failed verification");
    }
    return pass(checks, id);
  });

  return { green: checks.every((c) => c.ok), checks };
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { keyring: { type: "string" }, json: { type: "boolean", default: false } },
  });
  const reportPath = positionals[0];
  if (!reportPath || !values.keyring) {
    process.stderr.write("usage: verify-analysis-report.mjs <report.json> --keyring <keyring.json> [--json]\n");
    return 2;
  }
  let report;
  let keyring;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (err) {
    process.stderr.write(`cannot read report: ${err.message}\n`);
    return 2;
  }
  try {
    keyring = JSON.parse(fs.readFileSync(values.keyring, "utf8"));
  } catch (err) {
    process.stderr.write(`cannot read keyring: ${err.message}\n`);
    return 2;
  }

  const result = verifyReport(report, keyring);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const c of result.checks) {
      process.stdout.write(`${c.ok ? "PASS" : "FAIL"}  ${c.id}${c.detail ? ` — ${c.detail}` : ""}\n`);
    }
    process.stdout.write(`\n${result.green ? "GREEN — report verified" : "RED — verification failed (fail-closed)"}\n`);
  }
  return result.green ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
