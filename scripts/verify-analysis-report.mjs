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
import { parseArgs } from "node:util";

// Shared broker-independent JCS + JWS primitives (also used by the finalizer
// verdict verifier #1383) — one crypto path, no drift. canonicalizeJson is
// re-exported for callers/tests that build fixtures against this exact JCS.
import {
  canonicalizeJson,
  sha256Prefix,
  verifyJwsSignature,
  kidOf,
} from "./lib/a2a-offline-verify.mjs";

export { canonicalizeJson, verifyJwsSignature };

export const REPORT_VERSION = "verifiable-analysis-report/v1";
export const CANONICALIZATION = "rfc8785-jcs-v1";
export const RESULT_PROVENANCE_SCHEMA = "a2a.result.provenance.v1";
export const BROKER_COUNTERSIG_SCHEMA = "a2a.result.provenance.broker-countersig.v1";
export const RETRIEVAL_SNAPSHOT_SCHEMA = "a2a.retrieval.snapshot.v1";

// ---------------------------------------------------------------------------
// Provenance verification (mirrors provenance.ts semantics, standalone).
// ---------------------------------------------------------------------------
function hashTaskResult(result) {
  // Core result hash excludes BOTH attestation wrappers computed over it:
  // provenance (signatures cover the hash) and finalizerVerdict (#1383 V-c: the
  // finalizer binds subject.resultHash to this hash before embedding, so
  // including it would be an unsatisfiable fixed point). No-op for reports
  // without either field. Mirrors provenance.ts stripResultProvenance.
  const { provenance: _prov, finalizerVerdict: _verdict, ...rest } = result;
  return sha256Prefix(canonicalizeJson(rest));
}

function fail(checks, id, detail) { checks.push({ id, ok: false, detail }); }
function pass(checks, id) { checks.push({ id, ok: true }); }

/**
 * Verify ONE result's provenance chain — the report bundle's checks 3-5
 * (schema, resultHash binding, worker signature, broker countersignature) —
 * against keyring keys `{ [keyId]: pemPublicKey }`. Exported standalone
 * (#1356 G2-d) so bundle-shaped consumers (the M3 attestation exporter) reuse
 * this exact verification instead of re-implementing it.
 *
 * Returns { checks, workerSig, brokerCountersig } where workerSig is
 * "verified" | "invalid" (verified = schema + hash + signature all pass) and
 * brokerCountersig is "verified" | "invalid" | "absent". A missing countersig
 * is reported as "absent" AND as a failed check — report-bundle parity, where
 * an incomplete chain is fail-closed; enum consumers decide how to surface it.
 */
export function verifyResultProvenance(result, taskId, keys) {
  const checks = [];
  const prov = result && typeof result === "object" ? result.provenance : undefined;
  if (!prov || typeof prov !== "object") {
    fail(checks, "provenance-schema", "missing result.provenance");
    return { checks, workerSig: "invalid", brokerCountersig: "absent" };
  }
  if (prov.schemaVersion !== RESULT_PROVENANCE_SCHEMA || prov.canonicalization !== CANONICALIZATION) {
    fail(checks, "provenance-schema", "unsupported provenance schema/canonicalization");
  } else {
    pass(checks, "provenance-schema");
  }
  const actualHash = hashTaskResult(result);
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
      taskId,
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
  let brokerCountersig;
  if (!counter || typeof counter !== "object") {
    fail(checks, "broker-countersignature", "missing brokerCountersig (fail-closed)");
    brokerCountersig = "absent";
  } else {
    const brokerPem = keys[counter.brokerKeyId];
    if (!brokerPem) {
      fail(checks, "broker-countersignature", `brokerKeyId '${counter.brokerKeyId}' not in keyring (fail-closed)`);
      brokerCountersig = "invalid";
    } else {
      const payload = {
        schemaVersion: BROKER_COUNTERSIG_SCHEMA,
        canonicalization: CANONICALIZATION,
        taskId,
        verifiedAt: counter.verifiedAt,
        workerSig: prov.workerSig,
      };
      if (verifyJwsSignature(payload, counter.sig, brokerPem)) {
        pass(checks, "broker-countersignature");
        brokerCountersig = "verified";
      } else {
        fail(checks, "broker-countersignature", "broker countersignature failed verification");
        brokerCountersig = "invalid";
      }
    }
  }
  const workerSig = ["provenance-schema", "result-hash", "worker-signature"]
    .every((id) => checks.find((c) => c.id === id)?.ok)
    ? "verified"
    : "invalid";
  return { checks, workerSig, brokerCountersig };
}

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

  // 3-5. Result provenance: resultHash binding + worker signature + broker
  // countersignature — one source with the standalone verifier (#1356 G2-d).
  checks.push(...verifyResultProvenance(report.result, report.taskId, keys).checks);

  // 6. Retrieval snapshots: each snapshot self-verifies (byteLen + contentHash + signature).
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

  // 7. Result<->source binding (K2 #1374 / closes #1386 T2). A snapshot may only
  //    claim to have fed this result if the SIGNED result declares its
  //    contentHash in result.output.sources[], and every declared source must
  //    have its snapshot present. Because result.output.sources is inside the
  //    signed result, resultHash covers it — so the binding is tamper-bound.
  //    Empty on both sides (analysis with no external source) is allowed.
  const declaredSources = Array.isArray(report.result?.output?.sources)
    ? report.result.output.sources.map((s) => s && s.contentHash).filter((h) => typeof h === "string")
    : [];
  const snapshotHashes = report.sources.map((s) => s && s.contentHash).filter((h) => typeof h === "string");
  if (declaredSources.length > 0 || snapshotHashes.length > 0) {
    const declaredSet = new Set(declaredSources);
    const snapshotSet = new Set(snapshotHashes);
    const unboundSnapshot = snapshotHashes.find((h) => !declaredSet.has(h));
    const danglingDeclaration = declaredSources.find((h) => !snapshotSet.has(h));
    if (unboundSnapshot) {
      fail(checks, "source-binding", `snapshot ${unboundSnapshot} is not declared by result.output.sources (unbound source)`);
    } else if (danglingDeclaration) {
      fail(checks, "source-binding", `result.output.sources declares ${danglingDeclaration} with no matching snapshot`);
    } else {
      pass(checks, "source-binding");
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

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
