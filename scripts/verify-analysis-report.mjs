#!/usr/bin/env node
/**
 * Independent offline verifier for Verifiable Analysis Report v0 (#1378).
 *
 * Contract: contracts/a2a/verifiable-analysis-report.md
 *
 * Takes a report bundle JSON and a keyring of known public keys and answers a
 * single fail-closed question: does this bundle's signed content verify, was it
 * untampered, and is its correctness-separation invariant intact? It is
 * deliberately BROKER-INDEPENDENT — it re-implements canonicalization and JWS
 * verification with only node:crypto so a third party can run it without the
 * broker or this monorepo's runtime. That independence is the whole point.
 *
 * Safety: source-only verification. Reads the report + keyring, computes hashes
 * and verifies signatures. No network, no writes, no issue/PR/dispatch/restart/
 * credential action. Never emits private key material.
 *
 * Usage:
 *   node scripts/verify-analysis-report.mjs <report.json> --keyring <keyring.json> [--json]
 * Exit 0 = GREEN (every check passed); non-zero = fail-closed.
 */
import fs from "node:fs";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { parseArgs } from "node:util";

export const REPORT_VERSION = "verifiable-analysis-report/v0";

/** Recursively key-sorted canonical JSON: sorted keys, dropped undefined, arrays in order. */
export function stableJsonStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  const record = value;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(canonicalString) {
  return createHash("sha256").update(canonicalString, "utf8").digest("hex");
}

/** `sha256:<hex>` over canonical(value). */
export function digestOf(value) {
  return `sha256:${sha256Hex(stableJsonStringify(value))}`;
}

function algForKey(key) {
  if (key.asymmetricKeyType === "ed25519") return { alg: "EdDSA", cryptoAlg: null };
  if (key.asymmetricKeyType === "ec") {
    if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return { alg: "ES256", cryptoAlg: "sha256", dsaEncoding: "ieee-p1363" };
  }
  return null;
}

/**
 * Verify a detached signature (base64url) over the canonical bytes of `payload`
 * using the PEM public key. Fail-closed on any error. `declaredAlg` (from the
 * bundle) must match the key's algorithm, mirroring the JWS header check in
 * execution-proof-signing.ts so a signature claiming a different alg is rejected
 * rather than checked against the wrong primitive.
 */
export function verifyDetached(payload, signatureB64url, publicKeyPem, declaredAlg) {
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return false;
  }
  const algorithm = algForKey(key);
  if (!algorithm) return false;
  if (declaredAlg && declaredAlg !== algorithm.alg) return false;
  try {
    return cryptoVerify(
      algorithm.cryptoAlg,
      Buffer.from(stableJsonStringify(payload), "utf8"),
      algorithm.dsaEncoding ? { key, dsaEncoding: algorithm.dsaEncoding } : key,
      Buffer.from(signatureB64url, "base64url"),
    );
  } catch {
    return false;
  }
}

function fail(checks, id, detail) {
  checks.push({ id, ok: false, detail });
}
function pass(checks, id) {
  checks.push({ id, ok: true });
}

/**
 * Verify a report bundle against a keyring `{ [keyId]: pemPublicKey }`.
 * Returns { green: boolean, checks: Array<{id, ok, detail?}> }. Never throws on
 * a malformed bundle — a malformed bundle is a fail-closed result, not a crash.
 */
export function verifyReport(report, keyring) {
  const checks = [];
  const keys = (keyring && keyring.keys) || {};

  // 1. Shape + assurance (correctness-separation) invariant.
  const shapeOk =
    report &&
    typeof report === "object" &&
    report.reportVersion === REPORT_VERSION &&
    typeof report.taskId === "string" &&
    typeof report.producedAt === "string" &&
    report.analysis && typeof report.analysis.summary === "string" &&
    report.sources && Array.isArray(report.sources.items) &&
    report.provenance && typeof report.provenance === "object";
  if (!shapeOk) {
    fail(checks, "shape", "missing/invalid required fields or reportVersion mismatch");
    return { green: false, checks };
  }
  const assurance = report.assurance;
  const doesNotProve = (assurance && Array.isArray(assurance.doesNotProve)) ? assurance.doesNotProve : [];
  const assuranceOk =
    assurance &&
    doesNotProve.includes("analytical-correctness") &&
    doesNotProve.includes("normative-judgment") &&
    typeof assurance.disclaimer === "string" &&
    assurance.disclaimer.trim().length > 0;
  if (!assuranceOk) {
    fail(checks, "assurance-invariant", "assurance must declare it does NOT prove analytical-correctness/normative-judgment with a non-empty disclaimer");
  } else {
    pass(checks, "assurance-invariant");
  }

  // 2. Body-hash binding.
  const expectedBodyHash = digestOf(report.analysis.summary);
  if (report.analysis.bodyHash !== expectedBodyHash) {
    fail(checks, "body-hash", "analysis.bodyHash does not match sha256(canonical(analysis.summary))");
  } else {
    pass(checks, "body-hash");
  }

  // 3. Sources-root binding.
  const contentHashes = report.sources.items.map((it) => it && it.contentHash).filter((h) => typeof h === "string").sort();
  const expectedRoot = digestOf(contentHashes);
  if (report.sources.sourcesRoot !== expectedRoot) {
    fail(checks, "sources-root", "sources.sourcesRoot does not match sha256(canonical(sorted item contentHashes))");
  } else {
    pass(checks, "sources-root");
  }

  // 4. Result-hash binding (master tamper check).
  const { provenance } = report;
  const { provenance: _omit, ...bundleSansProvenance } = report;
  const expectedResultHash = digestOf(bundleSansProvenance);
  if (provenance.resultHash !== expectedResultHash) {
    fail(checks, "result-hash", "provenance.resultHash does not match sha256(canonical(bundle sans provenance)) — content was altered");
  } else {
    pass(checks, "result-hash");
  }

  // 5. Worker signature.
  const workerPem = keys[provenance.workerKeyId];
  if (!workerPem) {
    fail(checks, "worker-signature", `workerKeyId '${provenance.workerKeyId}' not in keyring (fail-closed)`);
  } else {
    const workerPayload = { resultHash: provenance.resultHash, taskId: report.taskId, producedAt: report.producedAt };
    if (!verifyDetached(workerPayload, provenance.workerSig, workerPem, provenance.alg)) {
      fail(checks, "worker-signature", "workerSig failed verification");
    } else {
      pass(checks, "worker-signature");
    }
  }

  // 6. Broker countersignature.
  const counter = provenance.brokerCountersig;
  if (!counter || typeof counter !== "object") {
    fail(checks, "broker-countersignature", "missing brokerCountersig (fail-closed)");
  } else {
    const brokerPem = keys[counter.brokerKeyId];
    if (!brokerPem) {
      fail(checks, "broker-countersignature", `brokerKeyId '${counter.brokerKeyId}' not in keyring (fail-closed)`);
    } else {
      const counterPayload = { workerSig: provenance.workerSig, taskId: report.taskId, verifiedAt: counter.verifiedAt };
      if (!verifyDetached(counterPayload, counter.sig, brokerPem, provenance.alg)) {
        fail(checks, "broker-countersignature", "brokerCountersig failed verification");
      } else {
        pass(checks, "broker-countersignature");
      }
    }
  }

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

// Only run as CLI when invoked directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
