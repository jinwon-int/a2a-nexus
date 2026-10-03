#!/usr/bin/env node
/**
 * Deterministic tests for the signed NCLEX evaluation receipt (#1724):
 * round-trip, exact-head binding, tamper and key failures, self-review
 * rejection, staleness interplay with the preset's classifyReceipts, and the
 * restricted-artifact fail-closed fixture (bounded note, reference-form
 * evidenceRef).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import {
  NCLEX_EVIDENCE_REF_MAX_CHARS,
  NCLEX_FINDING_NOTE_MAX_CHARS,
  NCLEX_RECEIPT_SCHEMA,
  NclexReceiptError,
  buildReceiptCore,
  receiptIdOf,
  signReceipt,
  verifyReceipt,
} from "./nclex-content-pr-receipt.mjs";
import { classifyReceipts } from "./nclex-content-pr-preset.mjs";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE = "c".repeat(40);

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" });
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" });
const OTHER = generateKeyPairSync("ed25519");
const OTHER_PUBLIC_PEM = OTHER.publicKey.export({ type: "spki", format: "pem" });

function coreFields(overrides = {}) {
  return {
    repo: "jinwon-int/nclex",
    prNumber: 145,
    baseSha: BASE,
    headSha: HEAD_A,
    diffHash: "diffhash-1",
    intentHash: "intenthash-1",
    authorNodeId: "dungae",
    reviewerNodeId: "seoseo",
    team: "T1",
    lane: "content_clinical",
    verdict: "PASS",
    findings: [{ findingId: "F-1", blocking: false, note: "minor wording", evidenceRef: "packet:p.12" }],
    producedAt: "2026-08-06T09:00:00.000Z",
    ...overrides,
  };
}

function signedReceipt(overrides = {}) {
  return signReceipt(buildReceiptCore(coreFields(overrides)), { privateKeyPem: PRIVATE_PEM, keyId: "seoseo-review-key-1" });
}

test("receipt sign/verify round-trip binds every exact-head field", () => {
  const receipt = signedReceipt();
  assert.equal(receipt.schema, NCLEX_RECEIPT_SCHEMA);
  assert.equal(receipt.receiptId, receiptIdOf(buildReceiptCore(coreFields())));
  const result = verifyReceipt(receipt, { "seoseo-review-key-1": PUBLIC_PEM });
  assert.deepEqual(result, { ok: true, receiptId: receipt.receiptId, reviewerNodeId: "seoseo", verdict: "PASS" });
});

test("tampering with any bound field breaks verification (exact-head binding)", () => {
  const receipt = signedReceipt();
  const tampered = { ...receipt, headSha: HEAD_B };
  const result = verifyReceipt(tampered, { "seoseo-review-key-1": PUBLIC_PEM });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "receipt_id_mismatch", "head drift changes the canonical core and receipt id");

  const sigTampered = { ...receipt, verdict: "BLOCK" };
  const result2 = verifyReceipt(sigTampered, { "seoseo-review-key-1": PUBLIC_PEM });
  assert.equal(result2.ok, false);
});

test("unknown or wrong key fails closed", () => {
  const receipt = signedReceipt();
  assert.equal(verifyReceipt(receipt, {}).reason, "receipt_key_unknown");
  const wrong = verifyReceipt(receipt, { "seoseo-review-key-1": OTHER_PUBLIC_PEM });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, "receipt_signature_invalid");
});

test("self-review and malformed fields are rejected at build time", () => {
  assert.throws(
    () => buildReceiptCore(coreFields({ reviewerNodeId: "dungae" })),
    (e) => e.code === "receipt_self_review",
  );
  assert.throws(() => buildReceiptCore(coreFields({ verdict: "MAYBE" })), (e) => e.code === "receipt_invalid");
  assert.throws(() => buildReceiptCore(coreFields({ headSha: "short" })), (e) => e.code === "receipt_invalid");
  assert.throws(
    () => buildReceiptCore(coreFields({ findings: [{ note: "no stable id" }] })),
    (e) => e.code === "receipt_invalid",
  );
  assert.throws(
    () => signReceipt(buildReceiptCore(coreFields()), { privateKeyPem: "not-a-key", keyId: "k" }),
    (e) => e.code === "receipt_invalid",
  );
});

test("receipt never carries prompt, chain-of-thought, or restricted reference bodies", () => {
  const receipt = signedReceipt();
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes("prompt"), false);
  assert.equal(serialized.includes("chainOfThought"), false);
  // Findings carry only stable id, blocking flag, note, and an ID/SHA-style evidenceRef.
  assert.deepEqual(Object.keys(receipt.findings[0]).sort(), ["blocking", "evidenceRef", "findingId", "note"]);
});

test("preset staleness consumes signed receipts: head drift excludes prior PASS", () => {
  const passOld = signedReceipt();
  const passNew = signedReceipt({ headSha: HEAD_B, producedAt: "2026-08-06T10:00:00.000Z" });
  const toPresetShape = (receipt) => ({ receiptId: receipt.receiptId, headSha: receipt.headSha, verdict: receipt.verdict, signed: true });
  const { fresh, stale } = classifyReceipts({
    receipts: [toPresetShape(passOld), toPresetShape(passNew)],
    currentHeadSha: HEAD_B,
  });
  assert.deepEqual(fresh.map((r) => r.receiptId), [passNew.receiptId]);
  assert.deepEqual(stale.map((r) => r.receiptId), [passOld.receiptId]);
});

// Restricted-artifact fail-closed fixture (#1724): a finding carries only a
// short single-line note and a reference-form evidenceRef, never a verbatim
// excerpt of restricted/factcheck-only material. These vectors are mirrored
// verbatim in packages/nclex-evaluation/src/receipt-contract.test.ts, which
// also imports this module to pin constant and verdict parity.
const LONG_ID = "r".repeat(128);
const RESTRICTED_ARTIFACT_VECTORS = {
  acceptedEvidenceRefs: [
    "packet:p.12",
    "pharm-01",
    "pharm-01#p.12",
    `sha256:${"a".repeat(64)}#p.212-214`,
    "b".repeat(64),
    "refs:ati-pharm-2024/ch4#sec-2.1",
    `refs:${LONG_ID}#${"s".repeat(26)}`, // exactly 160 chars
  ],
  rejectedEvidenceRefs: [
    "see page 12 of the textbook",
    "Patient presents with chest pain; give aspirin 325 mg",
    "packet:p.12\nverbatim restricted paragraph",
    "sha256:abc",
    `sha256:${"A".repeat(64)}`,
    "https://refs.example/pharm-01.pdf",
    "#p.12",
    "Packet:p.12",
    `refs:${LONG_ID}#${"s".repeat(27)}`, // 161 chars
  ],
  acceptedNotes: ["minor wording", "  trimmed edge whitespace\n", "가".repeat(280)],
  rejectedNotes: ["line one\nline two", "carriage\rreturn", "tab\tseparated", "unicode\u2028separator", "가".repeat(281)],
};

test("restricted artifact: reference-form evidenceRefs and bounded single-line notes are admitted", () => {
  assert.equal(`refs:${LONG_ID}#${"s".repeat(26)}`.length, NCLEX_EVIDENCE_REF_MAX_CHARS);
  assert.equal(NCLEX_FINDING_NOTE_MAX_CHARS, 280);
  for (const evidenceRef of RESTRICTED_ARTIFACT_VECTORS.acceptedEvidenceRefs) {
    const core = buildReceiptCore(coreFields({ findings: [{ findingId: "F-1", blocking: false, evidenceRef }] }));
    assert.equal(core.findings[0].evidenceRef, evidenceRef, evidenceRef);
  }
  for (const note of RESTRICTED_ARTIFACT_VECTORS.acceptedNotes) {
    const core = buildReceiptCore(coreFields({ findings: [{ findingId: "F-1", blocking: false, note }] }));
    assert.equal(core.findings[0].note, note.trim());
  }
});

test("restricted artifact: prose evidenceRefs and multi-line or oversized notes fail closed at build time", () => {
  for (const evidenceRef of RESTRICTED_ARTIFACT_VECTORS.rejectedEvidenceRefs) {
    assert.throws(
      () => buildReceiptCore(coreFields({ findings: [{ findingId: "F-1", blocking: false, evidenceRef }] })),
      (e) => e instanceof NclexReceiptError && e.code === "receipt_restricted_artifact",
      JSON.stringify(evidenceRef),
    );
  }
  for (const note of RESTRICTED_ARTIFACT_VECTORS.rejectedNotes) {
    assert.throws(
      () => buildReceiptCore(coreFields({ findings: [{ findingId: "F-1", blocking: false, note }] })),
      (e) => e instanceof NclexReceiptError && e.code === "receipt_restricted_artifact",
      JSON.stringify(note),
    );
  }
});

test("restricted artifact: a validly signed receipt smuggling a verbatim excerpt is rejected on verify", () => {
  // signReceipt signs whatever core it is given, so a producer that bypasses
  // buildReceiptCore can still emit a cryptographically valid receipt; the
  // verifier must refuse it before any key lookup or signature check counts.
  const keyring = { "seoseo-review-key-1": PUBLIC_PEM };
  const signWith = (findings) =>
    signReceipt({ ...buildReceiptCore(coreFields()), findings }, { privateKeyPem: PRIVATE_PEM, keyId: "seoseo-review-key-1" });
  const excerpt = "Restricted source paragraph line 1.\nRestricted source paragraph line 2.";
  assert.deepEqual(verifyReceipt(signWith([{ findingId: "F-1", blocking: true, note: excerpt }]), keyring), {
    ok: false,
    reason: "receipt_restricted_artifact",
  });
  const proseRef = signWith([{ findingId: "F-1", blocking: true, evidenceRef: "full restricted text pasted here" }]);
  assert.deepEqual(verifyReceipt(proseRef, keyring), { ok: false, reason: "receipt_restricted_artifact" });
});

test("restricted artifact: undeclared finding fields never enter the signed core", () => {
  const core = buildReceiptCore(
    coreFields({ findings: [{ findingId: "F-1", blocking: false, evidenceRef: "pharm-01#p.12", excerpt: "verbatim body" }] }),
  );
  assert.deepEqual(Object.keys(core.findings[0]).sort(), ["blocking", "evidenceRef", "findingId", "note"]);
  assert.equal(JSON.stringify(core).includes("verbatim body"), false);
});
