#!/usr/bin/env node
/**
 * Deterministic tests for the signed NCLEX evaluation receipt (#1724):
 * round-trip, exact-head binding, tamper and key failures, self-review
 * rejection, and staleness interplay with the preset's classifyReceipts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import {
  NCLEX_RECEIPT_SCHEMA,
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
