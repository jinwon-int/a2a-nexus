#!/usr/bin/env node
/**
 * Attestation bundle checker (#1301 M3-c).
 *
 * Format: docs/attestation-bundle.md (v0). This is the bundle CONSUMER's
 * tool: it takes only the bundle file (no broker access) and verifies
 *   1. schema — fail-closed: unknown fields, wrong version, missing sections
 *   2. integrity — recomputes sha256 over the RFC 8785 (JCS) canonical form
 *      of the bundle without its integrity field and compares
 *   3. PII/identifier scan — every string leaf must be free of internal node
 *      identifiers, secret shapes, and URLs (reuses the ledger anonymity gate
 *      and the injected-knowledge secret patterns — no new redaction logic).
 * The scan is the SECOND line of defense behind the exporter's redaction
 * pass: a bundle that fails here must not be shipped, regardless of how it
 * was produced.
 *
 * Usage:
 *   node scripts/check-attestation-bundle.mjs <bundle.json> [--json]
 * Exit 0 = bundle verifies; 1 = problems found; 2 = usage/read error.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";

import { canonicalizeJson } from "./lib/a2a-offline-verify.mjs";
import { hintViolation } from "./build-injected-knowledge.mjs";

export const BUNDLE_VERSION = "0";
const TOP_LEVEL_FIELDS = ["bundleVersion", "subject", "contract", "evidence", "integrity"];
const SUBJECT_FIELDS = ["kind", "taskId", "taskIdHash", "intent", "status", "completedAt"];
const CONTRACT_FIELDS = ["acceptance", "declaredScope", "evidenceGate"];
const EVIDENCE_FIELDS = ["redGreen", "validations", "failures", "provenance"];
const VALIDATION_ROLES = new Set(["author", "reviewer", "unknown"]);
const VERIFICATION_FIELDS = ["workerSig", "brokerCountersig"];
const VERIFICATION_WORKER_VERDICTS = new Set(["verified", "invalid"]);
const VERIFICATION_COUNTERSIG_VERDICTS = new Set(["verified", "invalid", "absent"]);

function scanStrings(value, where, problems) {
  if (typeof value === "string") {
    const violation = hintViolation(value);
    if (violation) problems.push(`${where}: ${violation}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanStrings(item, `${where}[${index}]`, problems));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) scanStrings(item, `${where}.${key}`, problems);
  }
}

/** Full v0 verification. Returns a list of problems; empty = bundle verifies. */
export function evaluateAttestationBundle(bundle) {
  const problems = [];
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    return ["bundle must be a JSON object"];
  }
  for (const key of Object.keys(bundle)) {
    if (!TOP_LEVEL_FIELDS.includes(key)) problems.push(`unknown field '${key}' (fail-closed)`);
  }
  if (bundle.bundleVersion !== BUNDLE_VERSION) {
    problems.push(`bundleVersion must be '${BUNDLE_VERSION}'`);
  }

  const subject = bundle.subject;
  if (!subject || typeof subject !== "object") problems.push("subject section is required");
  else {
    for (const key of Object.keys(subject)) {
      if (!SUBJECT_FIELDS.includes(key)) problems.push(`subject has unknown field '${key}' (fail-closed)`);
    }
    if (subject.kind !== "task") problems.push("subject.kind must be 'task' in v0");
    if (typeof subject.taskId !== "string" || !subject.taskId) problems.push("subject.taskId is required");
    if (typeof subject.taskIdHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(subject.taskIdHash)) {
      problems.push("subject.taskIdHash must be sha256:<64 hex> (correlation anchor)");
    }
  }

  const contract = bundle.contract;
  if (!contract || typeof contract !== "object") problems.push("contract section is required");
  else {
    for (const key of Object.keys(contract)) {
      if (!CONTRACT_FIELDS.includes(key)) problems.push(`contract has unknown field '${key}' (fail-closed)`);
    }
    for (const field of CONTRACT_FIELDS) {
      if (contract[field] === undefined) problems.push(`contract.${field} must be present or the literal 'missing'`);
    }
  }

  const evidence = bundle.evidence;
  if (!evidence || typeof evidence !== "object") problems.push("evidence section is required");
  else {
    for (const key of Object.keys(evidence)) {
      if (!EVIDENCE_FIELDS.includes(key)) problems.push(`evidence has unknown field '${key}' (fail-closed)`);
    }
    if (!Array.isArray(evidence.validations)) problems.push("evidence.validations must be an array");
    else {
      evidence.validations.forEach((validation, index) => {
        const where = `evidence.validations[${index}]`;
        if (!validation || typeof validation !== "object") problems.push(`${where} must be an object`);
        else {
          if (!VALIDATION_ROLES.has(validation.role)) problems.push(`${where}.role must be author|reviewer|unknown (roles, never names)`);
          if ("nodeId" in validation) problems.push(`${where} carries nodeId — node identifiers must not appear in bundles`);
        }
      });
    }
    if (!Array.isArray(evidence.failures)) problems.push("evidence.failures must be an array");
    if (evidence.redGreen === undefined) problems.push("evidence.redGreen must be present or the literal 'missing'");
    if (evidence.provenance === undefined) problems.push("evidence.provenance must be present or the literal 'missing'");
    // Optional exporter-embedded verification verdict (#1356 G2-d): enum
    // values only, fail-closed — free-form strings here could smuggle
    // identifiers past the distillation rule.
    const verification = evidence.provenance && typeof evidence.provenance === "object"
      ? evidence.provenance.verification
      : undefined;
    if (verification !== undefined) {
      if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
        problems.push("evidence.provenance.verification must be an object");
      } else {
        for (const key of Object.keys(verification)) {
          if (!VERIFICATION_FIELDS.includes(key)) problems.push(`evidence.provenance.verification has unknown field '${key}' (fail-closed)`);
        }
        if (!VERIFICATION_WORKER_VERDICTS.has(verification.workerSig)) {
          problems.push("evidence.provenance.verification.workerSig must be verified|invalid");
        }
        if (!VERIFICATION_COUNTERSIG_VERDICTS.has(verification.brokerCountersig)) {
          problems.push("evidence.provenance.verification.brokerCountersig must be verified|invalid|absent");
        }
      }
    }
  }

  const integrity = bundle.integrity;
  if (!integrity || typeof integrity !== "object") problems.push("integrity section is required");
  else if (integrity.alg !== "sha256-jcs") problems.push("integrity.alg must be 'sha256-jcs'");
  else if (typeof integrity.hash !== "string") problems.push("integrity.hash is required");
  else {
    const { integrity: _omit, ...body } = bundle;
    try {
      const recomputed = createHash("sha256").update(canonicalizeJson(body), "utf8").digest("hex");
      if (recomputed !== integrity.hash) {
        problems.push(`integrity hash mismatch: bundle says ${integrity.hash.slice(0, 16)}…, recomputed ${recomputed.slice(0, 16)}… (tampered or re-serialized lossily)`);
      }
    } catch (error) {
      problems.push(`integrity recompute failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // PII/identifier second line of defense — scan every string leaf outside
  // the integrity block (hashes are hex, scanning them is harmless but noisy).
  const { integrity: _skip, ...scannable } = bundle;
  scanStrings(scannable, "bundle", problems);
  return problems;
}

function main(argv) {
  const jsonOutput = argv.includes("--json");
  const file = argv.find((arg) => !arg.startsWith("--"));
  if (!file) {
    process.stderr.write("usage: check-attestation-bundle.mjs <bundle.json> [--json]\n");
    return 2;
  }
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    process.stderr.write(`cannot read bundle '${file}': ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const problems = evaluateAttestationBundle(bundle);
  if (jsonOutput) {
    process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, problems }, null, 2)}\n`);
  } else if (problems.length) {
    process.stderr.write(`attestation bundle FAILED (${problems.length} problem(s)):\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  } else {
    process.stdout.write(`attestation bundle ok (subject ${bundle.subject?.taskIdHash ?? "?"}, status ${bundle.subject?.status ?? "?"})\n`);
  }
  return problems.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
