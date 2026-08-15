/**
 * Broker-side NCLEX receipt contract tests (#1724).
 *
 * The golden fixture below was produced by the OFFLINE module
 * (scripts/nclex-content-pr-receipt.mjs) — the TS verifier must accept its
 * exact JCS/JWS output, pinning one crypto path across both implementations.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { canonicalizeJson } from "a2a-attestation";

import {
  NCLEX_RECEIPT_SCHEMA,
  parseReceiptCore,
  receiptIdOf,
  verifySignedReceipt,
} from "./receipt-contract.js";

const GOLDEN_PUBLIC_PEM =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAPx+nQ+SawKcgL7iQJExBGhi/cGPd3zip7Tu0JrJ26WY=\n-----END PUBLIC KEY-----\n";

// Signed by scripts/nclex-content-pr-receipt.mjs signReceipt (Ed25519).
const GOLDEN_RECEIPT = {
  schema: "nclex.content-pr.receipt.v1",
  canonicalization: "rfc8785-jcs-v1",
  repo: "jinwon-int/nclex",
  prNumber: 145,
  baseSha: "cccccccccccccccccccccccccccccccccccccccc",
  headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  diffHash: "diffhash-1",
  intentHash: "intenthash-1",
  authorNodeId: "dungae",
  reviewerNodeId: "seoseo",
  team: "T1",
  lane: "content_clinical",
  verdict: "PASS",
  findings: [{ findingId: "F-1", blocking: false, note: "minor wording", evidenceRef: "packet:p.12" }],
  producedAt: "2026-08-06T09:00:00.000Z",
  receiptId: "sha256:cccfe3d5f7074280e74bd69057e73693fdbde09e8025751526810cbc897edaad",
  signatures: [
    {
      protected:
        "eyJhbGciOiJFZERTQSIsImtpZCI6InNlb3Nlby1yZXZpZXcta2V5LTEiLCJjYW5vbmljYWxpemF0aW9uIjoicmZjODc4NS1qY3MtdjEifQ",
      signature:
        "l7oQOoF54zKCdA1Gj7_RuPT32u-vN1G0jatIN8WMo4NUUaR_LwTZEsvKewfVyecJBANK3vF1lVPMkS8yN0NeAA",
    },
  ],
} as const;

const KEYRING = { "seoseo-review-key-1": GOLDEN_PUBLIC_PEM };

test("offline-module golden receipt verifies identically on the broker side (#1724)", () => {
  const result = verifySignedReceipt(GOLDEN_RECEIPT, KEYRING);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.receipt.receiptId, GOLDEN_RECEIPT.receiptId);
    assert.equal(result.receipt.schema, NCLEX_RECEIPT_SCHEMA);
  }
});

test("receiptIdOf matches the offline canonical hash for the golden core", () => {
  const { receiptId, signatures, ...core } = GOLDEN_RECEIPT;
  const parsed = parseReceiptCore(core);
  assert.equal(receiptIdOf(parsed), GOLDEN_RECEIPT.receiptId);
});

test("tampered golden receipt fails closed with a stable reason", () => {
  const tampered = { ...GOLDEN_RECEIPT, headSha: "b".repeat(40) };
  const result = verifySignedReceipt(tampered, KEYRING);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "receipt_id_mismatch");

  const sigTampered = { ...GOLDEN_RECEIPT, verdict: "BLOCK" };
  const result2 = verifySignedReceipt(sigTampered, KEYRING);
  assert.equal(result2.ok, false);

  assert.deepEqual(verifySignedReceipt(GOLDEN_RECEIPT, {}).ok, false);
  assert.deepEqual(verifySignedReceipt(null, KEYRING).ok, false);
  const selfReview = {
    ...GOLDEN_RECEIPT,
    reviewerNodeId: "dungae",
  };
  const selfResult = verifySignedReceipt(selfReview, KEYRING);
  assert.equal(selfResult.ok, false);
  if (!selfResult.ok) assert.equal(selfResult.reason, "receipt_self_review");
});

test("freshly signed receipt (TS-built core, offline-shaped signature) verifies", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const publicPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const core = parseReceiptCore({
    schema: NCLEX_RECEIPT_SCHEMA,
    canonicalization: "rfc8785-jcs-v1",
    repo: "jinwon-int/nclex",
    prNumber: 1,
    baseSha: "c".repeat(40),
    headSha: "d".repeat(40),
    diffHash: "dh",
    intentHash: "ih",
    authorNodeId: "author",
    reviewerNodeId: "reviewer",
    team: "T2",
    lane: "evidence_adversarial",
    verdict: "BLOCK",
    findings: [{ findingId: "F-9", blocking: true }],
    producedAt: "2026-08-06T10:00:00.000Z",
  });
  const receiptId = receiptIdOf(core);
  // Rebuild the JWS the same way the offline module does (JCS protected+payload, Ed25519).
  const protectedHeader = Buffer.from(
    JSON.stringify({ alg: "EdDSA", kid: "k1", canonicalization: "rfc8785-jcs-v1" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(canonicalizeJson(core), "utf8").toString("base64url");
  const signature = cryptoSign(null, Buffer.from(`${protectedHeader}.${payload}`, "utf8"), privatePem).toString("base64url");
  const receipt = { ...core, receiptId, signatures: [{ protected: protectedHeader, signature }] };
  const result = verifySignedReceipt(receipt, { k1: publicPem });
  assert.equal(result.ok, true);
});
