#!/usr/bin/env node
/**
 * NCLEX content PR evaluation receipt — signed exact-head evidence (#1724).
 *
 * A receipt cryptographically binds one evaluation verdict to the exact PR
 * head it was produced against: repo, PR, base/head SHA, diffHash, intentHash,
 * author/reviewer nodes, team/lane, findings, and verdict. Signed with the
 * fleet's shared JCS + JWS path (scripts/lib/a2a-offline-verify.mjs) — one
 * crypto stack, no drift.
 *
 * Pure and offline: this module builds, signs, and verifies receipt objects.
 * It never calls a provider, broker, or GitHub, and it never carries prompt
 * text, chain-of-thought, or restricted reference content (only IDs, hashes,
 * and page/section citations allowed by the preset's evidence policy).
 */
import { createPrivateKey, sign as cryptoSign } from "node:crypto";

import { canonicalizeJson, sha256Prefix, verifyJwsSignature, kidOf } from "./lib/a2a-offline-verify.mjs";
import { hasText } from "./a2a-routing-shared.mjs";

export const NCLEX_RECEIPT_SCHEMA = "nclex.content-pr.receipt.v1";
export const NCLEX_RECEIPT_CANONICALIZATION = "rfc8785-jcs-v1";

const SHA40 = /^[0-9a-f]{40}$/;
const VERDICTS = new Set(["PASS", "BLOCK"]);

export class NclexReceiptError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "NclexReceiptError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new NclexReceiptError(code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The signed core of a receipt. Everything the verdict binds to is here;
 * anything not here is not evidence.
 */
export function buildReceiptCore({
  repo,
  prNumber,
  baseSha,
  headSha,
  diffHash,
  intentHash,
  authorNodeId,
  reviewerNodeId,
  team,
  lane,
  verdict,
  findings = [],
  producedAt,
}) {
  if (!hasText(String(repo)) || !/^[\w.-]+\/[\w.-]+$/.test(String(repo).trim())) {
    fail("receipt_invalid", "repo must have the form owner/name");
  }
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) fail("receipt_invalid", "prNumber must be a positive integer");
  for (const [field, value] of [["baseSha", baseSha], ["headSha", headSha]]) {
    if (!SHA40.test(String(value))) fail("receipt_invalid", `${field} must be a 40-char hex SHA`);
  }
  for (const [field, value] of [
    ["diffHash", diffHash],
    ["intentHash", intentHash],
    ["authorNodeId", authorNodeId],
    ["reviewerNodeId", reviewerNodeId],
    ["lane", lane],
  ]) {
    if (!hasText(String(value))) fail("receipt_invalid", `${field} must be a non-empty string`);
  }
  if (team !== "T1" && team !== "T2" && team !== "cross-team") fail("receipt_invalid", "team must be T1|T2|cross-team");
  if (!VERDICTS.has(verdict)) fail("receipt_invalid", "verdict must be PASS or BLOCK");
  if (String(authorNodeId).trim() === String(reviewerNodeId).trim()) {
    fail("receipt_self_review", "reviewerNodeId must differ from authorNodeId");
  }
  if (!Array.isArray(findings) || !findings.every((finding) => isPlainObject(finding) && hasText(finding.findingId))) {
    fail("receipt_invalid", "findings must be an array of objects with stable findingId");
  }
  if (!hasText(String(producedAt)) || Number.isNaN(Date.parse(producedAt))) {
    fail("receipt_invalid", "producedAt must be an ISO timestamp");
  }
  return {
    schema: NCLEX_RECEIPT_SCHEMA,
    canonicalization: NCLEX_RECEIPT_CANONICALIZATION,
    repo: String(repo).trim(),
    prNumber,
    baseSha: String(baseSha).toLowerCase(),
    headSha: String(headSha).toLowerCase(),
    diffHash: String(diffHash).trim(),
    intentHash: String(intentHash).trim(),
    authorNodeId: String(authorNodeId).trim(),
    reviewerNodeId: String(reviewerNodeId).trim(),
    team,
    lane: String(lane).trim(),
    verdict,
    findings: findings.map((finding) => ({
      findingId: String(finding.findingId).trim(),
      blocking: finding.blocking === true,
      note: hasText(finding.note) ? String(finding.note).trim() : undefined,
      evidenceRef: hasText(finding.evidenceRef) ? String(finding.evidenceRef).trim() : undefined,
    })),
    producedAt: new Date(producedAt).toISOString(),
  };
}

/** Stable receipt id: hash of the canonical signed core. */
export function receiptIdOf(core) {
  return sha256Prefix(canonicalizeJson(core));
}

/**
 * Sign a receipt core with an Ed25519 private key. Returns the full receipt
 * `{ ...core, receiptId, signatures: [AgentCardSignature] }`.
 */
export function signReceipt(core, { privateKeyPem, keyId }) {
  if (!isPlainObject(core) || core.schema !== NCLEX_RECEIPT_SCHEMA) fail("receipt_invalid", "core must come from buildReceiptCore");
  if (!hasText(String(keyId))) fail("receipt_invalid", "keyId is required");
  let key;
  try {
    key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not ed25519");
  } catch {
    fail("receipt_invalid", "privateKeyPem must be an Ed25519 private key");
  }
  const protectedHeader = Buffer.from(
    JSON.stringify({ alg: "EdDSA", kid: String(keyId).trim(), canonicalization: NCLEX_RECEIPT_CANONICALIZATION }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(canonicalizeJson(core), "utf8").toString("base64url");
  const signature = cryptoSign(null, Buffer.from(`${protectedHeader}.${payload}`, "utf8"), key).toString("base64url");
  return {
    ...core,
    receiptId: receiptIdOf(core),
    signatures: [{ protected: protectedHeader, signature }],
  };
}

/**
 * Verify a signed receipt against a keyring ({ keyId: publicKeyPem }).
 * Fail-closed with a stable reason code; never throws on malformed input.
 */
export function verifyReceipt(receipt, keyring) {
  if (!isPlainObject(receipt)) return { ok: false, reason: "receipt_malformed" };
  let core;
  try {
    const { receiptId, signatures, ...rest } = receipt;
    core = buildReceiptCore(rest);
    if (!hasText(String(receiptId)) || receiptId !== receiptIdOf(core)) {
      return { ok: false, reason: "receipt_id_mismatch" };
    }
    if (!Array.isArray(signatures) || signatures.length !== 1) {
      return { ok: false, reason: "receipt_signature_missing" };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof NclexReceiptError ? error.code : "receipt_malformed" };
  }
  const [entry] = receipt.signatures;
  const kid = kidOf(entry);
  const keyPem = isPlainObject(keyring) ? keyring[kid ?? ""] : undefined;
  if (!kid || typeof keyPem !== "string" || !hasText(keyPem)) {
    return { ok: false, reason: "receipt_key_unknown" };
  }
  if (!verifyJwsSignature(core, entry, keyPem)) {
    return { ok: false, reason: "receipt_signature_invalid" };
  }
  return { ok: true, receiptId: receipt.receiptId, reviewerNodeId: core.reviewerNodeId, verdict: core.verdict };
}
