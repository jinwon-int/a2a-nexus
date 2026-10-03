/**
 * Broker-side NCLEX receipt contract tests (#1724).
 *
 * The golden fixture below was produced by the OFFLINE module
 * (scripts/nclex-content-pr-receipt.mjs) — the TS verifier must accept its
 * exact JCS/JWS output, pinning one crypto path across both implementations.
 * The restricted-artifact vectors are mirrored verbatim from
 * scripts/nclex-content-pr-receipt.test.mjs, and a parity test imports the
 * offline module itself so the two validators cannot drift.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

import { canonicalizeJson } from "a2a-attestation";

import {
  NCLEX_EVIDENCE_REF_MAX_CHARS,
  NCLEX_EVIDENCE_REF_PATTERN,
  NCLEX_FINDING_NOTE_MAX_CHARS,
  NCLEX_RECEIPT_SCHEMA,
  NclexReceiptValidationError,
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

// Restricted-artifact fail-closed fixture (#1724). Mirrored verbatim from
// scripts/nclex-content-pr-receipt.test.mjs — keep both tables identical.
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

interface OfflineReceiptModule {
  NCLEX_FINDING_NOTE_MAX_CHARS: number;
  NCLEX_EVIDENCE_REF_MAX_CHARS: number;
  NCLEX_EVIDENCE_REF_PATTERN: RegExp;
  buildReceiptCore(fields: Record<string, unknown>): Record<string, unknown>;
  signReceipt(core: Record<string, unknown>, key: { privateKeyPem: string; keyId: string }): Record<string, unknown>;
}

async function loadOfflineReceiptModule(): Promise<OfflineReceiptModule> {
  // Computed specifier: the offline module is a plain .mjs script outside the
  // TS program (same pattern as broker worker-analysis-readiness.test.ts).
  const url = new URL("../../../scripts/nclex-content-pr-receipt.mjs", import.meta.url).href;
  return (await import(url)) as OfflineReceiptModule;
}

function goldenCoreWith(findings: unknown[]): Record<string, unknown> {
  const { receiptId: _receiptId, signatures: _signatures, ...core } = GOLDEN_RECEIPT;
  return { ...core, findings };
}

function outcomeOf(run: () => unknown): string {
  try {
    run();
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? "untyped";
  }
}

test("restricted artifact: TS and offline validators share caps and evidenceRef grammar (#1724)", async () => {
  const offline = await loadOfflineReceiptModule();
  assert.equal(NCLEX_FINDING_NOTE_MAX_CHARS, 280);
  assert.equal(NCLEX_EVIDENCE_REF_MAX_CHARS, 160);
  assert.equal(offline.NCLEX_FINDING_NOTE_MAX_CHARS, NCLEX_FINDING_NOTE_MAX_CHARS);
  assert.equal(offline.NCLEX_EVIDENCE_REF_MAX_CHARS, NCLEX_EVIDENCE_REF_MAX_CHARS);
  assert.equal(offline.NCLEX_EVIDENCE_REF_PATTERN.source, NCLEX_EVIDENCE_REF_PATTERN.source);
  assert.equal(offline.NCLEX_EVIDENCE_REF_PATTERN.flags, NCLEX_EVIDENCE_REF_PATTERN.flags);
});

test("restricted artifact: both validators reach the same verdict on every vector (#1724)", async () => {
  const offline = await loadOfflineReceiptModule();
  const cases: Array<{ finding: Record<string, unknown>; expected: string }> = [
    ...RESTRICTED_ARTIFACT_VECTORS.acceptedEvidenceRefs.map((evidenceRef) => ({ finding: { evidenceRef }, expected: "ok" })),
    ...RESTRICTED_ARTIFACT_VECTORS.rejectedEvidenceRefs.map((evidenceRef) => ({
      finding: { evidenceRef },
      expected: "receipt_restricted_artifact",
    })),
    ...RESTRICTED_ARTIFACT_VECTORS.acceptedNotes.map((note) => ({ finding: { note }, expected: "ok" })),
    ...RESTRICTED_ARTIFACT_VECTORS.rejectedNotes.map((note) => ({ finding: { note }, expected: "receipt_restricted_artifact" })),
  ];
  for (const { finding, expected } of cases) {
    const core = goldenCoreWith([{ findingId: "F-1", blocking: false, ...finding }]);
    const label = JSON.stringify(finding);
    assert.equal(outcomeOf(() => parseReceiptCore(core)), expected, `TS ${label}`);
    assert.equal(outcomeOf(() => offline.buildReceiptCore(core)), expected, `offline ${label}`);
  }
  assert.throws(
    () => parseReceiptCore(goldenCoreWith([{ findingId: "F-1", blocking: false, note: "a\nb" }])),
    (error: unknown) => error instanceof NclexReceiptValidationError && error.code === "receipt_restricted_artifact",
  );
});

test("restricted artifact: an offline-signed receipt smuggling a verbatim excerpt fails closed on the broker side (#1724)", async () => {
  const offline = await loadOfflineReceiptModule();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const keyring = { k1: publicKey.export({ type: "spki", format: "pem" }) as string };
  // signReceipt signs whatever core it is handed, so a producer that bypasses
  // buildReceiptCore can still emit a cryptographically valid receipt.
  const base = offline.buildReceiptCore(goldenCoreWith([]));
  const excerpt = offline.signReceipt(
    { ...base, findings: [{ findingId: "F-1", blocking: true, note: "Restricted paragraph 1.\nRestricted paragraph 2." }] },
    { privateKeyPem, keyId: "k1" },
  );
  assert.deepEqual(verifySignedReceipt(excerpt, keyring), { ok: false, reason: "receipt_restricted_artifact" });
  const proseRef = offline.signReceipt(
    { ...base, findings: [{ findingId: "F-1", blocking: true, evidenceRef: "full restricted text pasted here" }] },
    { privateKeyPem, keyId: "k1" },
  );
  assert.deepEqual(verifySignedReceipt(proseRef, keyring), { ok: false, reason: "receipt_restricted_artifact" });
});

test("restricted artifact: undeclared finding fields never reach the parsed core (#1724)", () => {
  const core = parseReceiptCore(
    goldenCoreWith([{ findingId: "F-1", blocking: false, evidenceRef: "pharm-01#p.12", excerpt: "verbatim body" }]),
  );
  assert.deepEqual(core.findings, [{ findingId: "F-1", blocking: false, evidenceRef: "pharm-01#p.12" }]);
  assert.equal(JSON.stringify(core).includes("verbatim body"), false);
});
