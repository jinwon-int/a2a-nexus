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
import { X509Certificate } from "node:crypto";
import { parseArgs } from "node:util";

import { canonicalizeJson, verifyJwsSignature } from "./lib/a2a-offline-verify.mjs";

export const VERDICT_SCHEMA = "a2a.finalizer.verdict.v1";
export const CANONICALIZATION = "rfc8785-jcs-v1";
export const DECISIONS = ["go", "no-go"];
export const ATTESTER_KINDS = ["github-oidc"];
/**
 * Epistemic class of the verdict (#1386 S2). The two kinds have different
 * reproducibility guarantees and MUST NOT be conflated:
 * - "battery": the outcome of deterministic checks — re-running the same
 *   pinned battery on the same artifact reproduces the same verdict.
 * - "judgment": an attested independent judgment (e.g. an LLM/human finalizer
 *   review). It attests that the review OCCURRED and what it concluded; the
 *   judgment itself is NOT reproducible and its assurance must say so.
 */
export const VERDICT_KINDS = ["battery", "judgment"];

function fail(checks, id, detail) { checks.push({ id, ok: false, detail }); }
function pass(checks, id) { checks.push({ id, ok: true }); }

/**
 * Lifecycle check for a keyring record { pem, status, notBefore, expiresAt }
 * (#1383 V-c). Returns a violation string, or undefined when the key is usable
 * for this verdict. Mirrors the broker's in-broker verifier so one keyring file
 * serves both. A revoked key is rejected immediately; a validity window is
 * checked against the verdict's producedAt (a window with no producedAt fails
 * closed).
 */
function finalizerKeyLifecycleViolation(record, verdict) {
  if (record.status === "revoked") return `finalizer key '${verdict.finalizerKeyId}' is revoked`;
  if (record.notBefore !== undefined || record.expiresAt !== undefined) {
    const producedMs = typeof verdict.producedAt === "string" ? Date.parse(verdict.producedAt) : NaN;
    if (!Number.isFinite(producedMs)) {
      return `verdict has no valid producedAt to check against key '${verdict.finalizerKeyId}' validity window (fail-closed)`;
    }
    if (record.notBefore !== undefined && producedMs < Date.parse(record.notBefore)) {
      return `verdict producedAt is before key '${verdict.finalizerKeyId}' notBefore (outside validity window)`;
    }
    if (record.expiresAt !== undefined && producedMs > Date.parse(record.expiresAt)) {
      return `verdict producedAt is after key '${verdict.finalizerKeyId}' expiresAt (outside validity window)`;
    }
  }
  return undefined;
}

function subjectsEqual(a, b) {
  return canonicalizeJson(a) === canonicalizeJson(b);
}

/**
 * Verify an attested-verdict identity (S3 / #1386 H1): a leaf certificate that
 * chains to a configured trusted root (e.g. Fulcio), whose SAN carries the OIDC
 * `attester.subject`, whose validity window covers `producedAt`, and whose key
 * signs the verdict. The chain-to-trusted-root is the load-bearing anchor: the
 * operator cannot mint a passing attester identity without the trusted root's
 * key (GitHub/Sigstore's, not theirs). Broker-independent, node:crypto only.
 *
 * v0 scope: cert chain + SAN identity + validity + payload signature are fully
 * verified here; Rekor transparency-log INCLUSION-PROOF math is left to the
 * Sigstore library / CI step and is only checked for structural presence (a
 * documented boundary — see contracts/a2a/finalizer-verdict.md).
 * Returns { ok, subject } or { ok:false, reason }.
 */
export function verifyAttesterIdentity(verdict, roots) {
  const att = verdict.attester;
  if (!att || typeof att !== "object" || Array.isArray(att) ||
      !ATTESTER_KINDS.includes(att.kind) || typeof att.subject !== "string" ||
      typeof att.leaf !== "string" || !att.sig || typeof att.sig !== "object") {
    return { ok: false, reason: "malformed attester block" };
  }
  if (!Array.isArray(roots) || roots.length === 0) {
    return { ok: false, reason: "no trusted attester roots configured (fail-closed)" };
  }
  let leaf;
  try {
    leaf = new X509Certificate(att.leaf);
  } catch {
    return { ok: false, reason: "leaf certificate parse failed" };
  }
  const chained = roots.some((rootPem) => {
    try {
      const root = new X509Certificate(rootPem);
      return leaf.checkIssued(root) && leaf.verify(root.publicKey);
    } catch {
      return false;
    }
  });
  if (!chained) return { ok: false, reason: "leaf does not chain to a trusted attester root" };

  const at = Date.parse(verdict.producedAt);
  if (!Number.isFinite(at) || at < Date.parse(leaf.validFrom) || at > Date.parse(leaf.validTo)) {
    return { ok: false, reason: "producedAt is outside the leaf certificate validity window" };
  }

  const sanIdentities = (leaf.subjectAltName ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^URI:/, ""));
  if (!sanIdentities.includes(att.subject)) {
    return { ok: false, reason: "leaf SAN does not carry attester.subject" };
  }

  const leafPem = leaf.publicKey.export({ type: "spki", format: "pem" }).toString();
  const { sig: _omit, ...attesterSansSig } = att;
  const signedPayload = { ...verdict, attester: attesterSansSig };
  if (!verifyJwsSignature(signedPayload, att.sig, leafPem)) {
    return { ok: false, reason: "attester signature failed verification" };
  }
  if (!att.rekor || typeof att.rekor !== "object") {
    return { ok: false, reason: "missing Rekor transparency-log reference (fail-closed)" };
  }
  return { ok: true, subject: att.subject };
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
  const roots = (keyring && keyring.roots) || [];

  // A verdict authenticates EITHER by a static registered key (finalizerKeyId +
  // sig) OR by an attested identity (attester block, S3). Exactly one is required.
  const hasStaticKey = typeof verdict?.finalizerKeyId === "string" && verdict?.sig && typeof verdict.sig === "object";
  const hasAttester = verdict?.attester && typeof verdict.attester === "object" && !Array.isArray(verdict.attester);
  const shapeOk =
    verdict && typeof verdict === "object" && !Array.isArray(verdict) &&
    verdict.schemaVersion === VERDICT_SCHEMA &&
    verdict.canonicalization === CANONICALIZATION &&
    VERDICT_KINDS.includes(verdict.kind) &&
    verdict.subject && typeof verdict.subject === "object" &&
    DECISIONS.includes(verdict.decision) &&
    (hasStaticKey || hasAttester);
  if (!shapeOk) {
    fail(checks, "shape", "missing/invalid required fields, schema, kind, decision, or authentication (static key or attester)");
    return { valid: false, kind: undefined, decision: undefined, subject: undefined, finalizerKeyId: undefined, attesterSubject: undefined, checks };
  }

  // Assurance (correctness-separation) invariant — a verdict attests an
  // independent GO, never that the artifact is correct. Kind-aware: a
  // "judgment" verdict is not reproducible and must say so, so the
  // reproducibility claim of deterministic battery verdicts can never be
  // borrowed by judgment verdicts (#1386 H2).
  const a = verdict.assurance;
  const doesNotProve = a && Array.isArray(a.doesNotProve) ? a.doesNotProve : [];
  const assuranceBase =
    a && doesNotProve.includes("analytical-correctness") &&
    typeof a.disclaimer === "string" && a.disclaimer.trim().length > 0;
  const judgmentHonest = verdict.kind !== "judgment" || doesNotProve.includes("reproducibility");
  if (!assuranceBase) {
    fail(checks, "assurance-invariant", "assurance must declare it does NOT prove analytical-correctness with a non-empty disclaimer");
  } else if (!judgmentHonest) {
    fail(checks, "assurance-invariant", "a judgment verdict must declare it does NOT prove reproducibility (judgments are attested, not reproducible)");
  } else {
    pass(checks, "assurance-invariant");
  }

  // Authentication — either the attested-identity path (S3) or the static key.
  // Both cover JCS(verdict sans their own signature), so every signed field
  // (subject, decision, producedAt, and the identity itself) is tamper-bound.
  let attesterSubject;
  if (hasAttester) {
    const att = verifyAttesterIdentity(verdict, roots);
    if (att.ok) {
      attesterSubject = att.subject;
      pass(checks, "attester-identity");
    } else {
      fail(checks, "attester-identity", att.reason);
    }
  } else {
    // Keyring entry is a bare PEM string OR a lifecycle record
    // { pem, status, notBefore, expiresAt } — the SAME format the broker's
    // in-broker verifier accepts (#1383 V-c), so one keyring file serves both.
    const entry = keys[verdict.finalizerKeyId];
    const record = typeof entry === "string" ? { pem: entry } : (entry && typeof entry === "object" ? entry : undefined);
    const lifecycle = record ? finalizerKeyLifecycleViolation(record, verdict) : undefined;
    if (!record || typeof record.pem !== "string") {
      fail(checks, "finalizer-signature", `finalizerKeyId '${verdict.finalizerKeyId}' not in keyring (fail-closed)`);
    } else if (lifecycle) {
      fail(checks, "finalizer-signature", lifecycle);
    } else {
      const { sig: _omit, ...unsigned } = verdict;
      if (verifyJwsSignature(unsigned, verdict.sig, record.pem)) {
        pass(checks, "finalizer-signature");
      } else {
        fail(checks, "finalizer-signature", "finalizer signature failed verification");
      }
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
    kind: verdict.kind,
    decision: verdict.decision,
    subject: verdict.subject,
    finalizerKeyId: verdict.finalizerKeyId,
    attesterSubject,
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
    process.stdout.write(`\n${result.valid ? `OK — verdict integrity verified (kind=${result.kind}, decision=${result.decision})` : "RED — verdict verification failed (fail-closed)"}\n`);
  }
  return result.valid ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
