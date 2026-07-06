#!/usr/bin/env node
/**
 * Independent offline verifier for a signed Finalizer Verdict v1 (#1383).
 *
 * Contract: contracts/a2a/finalizer-verdict.md
 *
 * A finalizer verdict is a signed, subject-bound GO/NO-GO attestation produced
 * by an independent finalizer. This verifier answers a single fail-closed
 * question about the verdict's INTEGRITY: is it well-formed, does it carry the
 * correctness-separation assurance, and is its signature valid for the named
 * finalizer key? It is BROKER-INDEPENDENT (shared JCS+JWS primitives, node:crypto
 * only) so a third party can check a verdict without the broker.
 *
 * It deliberately does NOT decide enforcement. Subject-binding to a live
 * artifact, decision=go, registered-key membership, and independence
 * (finalizer key != producing worker key) are the GATE's job
 * (scripts/check-finalizer-verdict.mjs) — this verifier can optionally check
 * subject binding when the expected subject is supplied.
 *
 * Safety: source-only verification. No network, no writes, no dispatch/restart/
 * credential action. Never emits private key material.
 *
 * Usage:
 *   node scripts/verify-finalizer-verdict.mjs <verdict.json> --keyring <keyring.json> [--json]
 * Exit 0 = verdict integrity OK; non-zero = fail-closed.
 */
import fs from "node:fs";
import { parseArgs } from "node:util";

import { canonicalizeJson, verifyJwsSignature } from "./lib/a2a-offline-verify.mjs";

export const VERDICT_SCHEMA = "a2a.finalizer.verdict.v1";
export const CANONICALIZATION = "rfc8785-jcs-v1";
export const DECISIONS = ["go", "no-go"];

function fail(checks, id, detail) { checks.push({ id, ok: false, detail }); }
function pass(checks, id) { checks.push({ id, ok: true }); }

function subjectsEqual(a, b) {
  return canonicalizeJson(a) === canonicalizeJson(b);
}

/**
 * Verify a finalizer verdict's integrity against a keyring
 * `{ keys: { [keyId]: pemPublicKey } }`. Returns { valid, decision, subject,
 * finalizerKeyId, checks }. Never throws — a malformed verdict is a fail-closed
 * result. If `opts.expectedSubject` is supplied, also checks subject binding.
 */
export function verifyVerdict(verdict, keyring, opts = {}) {
  const checks = [];
  const keys = (keyring && keyring.keys) || {};

  const shapeOk =
    verdict && typeof verdict === "object" && !Array.isArray(verdict) &&
    verdict.schemaVersion === VERDICT_SCHEMA &&
    verdict.canonicalization === CANONICALIZATION &&
    verdict.subject && typeof verdict.subject === "object" &&
    DECISIONS.includes(verdict.decision) &&
    typeof verdict.finalizerKeyId === "string" &&
    verdict.sig && typeof verdict.sig === "object";
  if (!shapeOk) {
    fail(checks, "shape", "missing/invalid required fields, schema, or decision");
    return { valid: false, decision: undefined, subject: undefined, finalizerKeyId: undefined, checks };
  }

  // Assurance (correctness-separation) invariant — a verdict attests an
  // independent GO, never that the artifact is correct.
  const a = verdict.assurance;
  const doesNotProve = a && Array.isArray(a.doesNotProve) ? a.doesNotProve : [];
  if (!a || !doesNotProve.includes("analytical-correctness") ||
      typeof a.disclaimer !== "string" || a.disclaimer.trim().length === 0) {
    fail(checks, "assurance-invariant", "assurance must declare it does NOT prove analytical-correctness with a non-empty disclaimer");
  } else {
    pass(checks, "assurance-invariant");
  }

  // Signature — covers JCS(verdict sans sig), so every signed field (subject,
  // decision, finalizerKeyId, producedAt) is tamper-bound.
  const pem = keys[verdict.finalizerKeyId];
  if (!pem) {
    fail(checks, "finalizer-signature", `finalizerKeyId '${verdict.finalizerKeyId}' not in keyring (fail-closed)`);
  } else {
    const { sig: _omit, ...unsigned } = verdict;
    if (verifyJwsSignature(unsigned, verdict.sig, pem)) {
      pass(checks, "finalizer-signature");
    } else {
      fail(checks, "finalizer-signature", "finalizer signature failed verification");
    }
  }

  // Optional subject binding (the gate always supplies this; standalone use may not).
  if (opts.expectedSubject !== undefined) {
    if (subjectsEqual(verdict.subject, opts.expectedSubject)) {
      pass(checks, "subject-binding");
    } else {
      fail(checks, "subject-binding", "verdict.subject does not match the expected artifact");
    }
  }

  return {
    valid: checks.every((c) => c.ok),
    decision: verdict.decision,
    subject: verdict.subject,
    finalizerKeyId: verdict.finalizerKeyId,
    checks,
  };
}

function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { keyring: { type: "string" }, json: { type: "boolean", default: false } },
  });
  const verdictPath = positionals[0];
  if (!verdictPath || !values.keyring) {
    process.stderr.write("usage: verify-finalizer-verdict.mjs <verdict.json> --keyring <keyring.json> [--json]\n");
    return 2;
  }
  let verdict;
  let keyring;
  try {
    verdict = JSON.parse(fs.readFileSync(verdictPath, "utf8"));
  } catch (err) {
    process.stderr.write(`cannot read verdict: ${err.message}\n`);
    return 2;
  }
  try {
    keyring = JSON.parse(fs.readFileSync(values.keyring, "utf8"));
  } catch (err) {
    process.stderr.write(`cannot read keyring: ${err.message}\n`);
    return 2;
  }

  const result = verifyVerdict(verdict, keyring);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const c of result.checks) {
      process.stdout.write(`${c.ok ? "PASS" : "FAIL"}  ${c.id}${c.detail ? ` — ${c.detail}` : ""}\n`);
    }
    process.stdout.write(`\n${result.valid ? `OK — verdict integrity verified (decision=${result.decision})` : "RED — verdict verification failed (fail-closed)"}\n`);
  }
  return result.valid ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
