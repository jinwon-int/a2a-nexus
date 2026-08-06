/**
 * NCLEX content PR evaluation receipt — broker-side contract (#1724).
 *
 * Mirrors scripts/nclex-content-pr-receipt.mjs field-for-field and verifies
 * signatures with the SAME RFC 8785 JCS (a2a-attestation canonicalizeJson) +
 * node:crypto EdDSA path, so receipts signed by the offline module verify
 * identically here — one crypto stack, pinned by golden JCS vectors in both
 * test suites.
 *
 * Fail-closed: malformed cores, unknown key ids, invalid signatures, and
 * self-review are rejected; nothing is admitted on a soft error.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

import { canonicalizeJson } from "a2a-attestation";

export const NCLEX_RECEIPT_SCHEMA = "nclex.content-pr.receipt.v1";
export const NCLEX_RECEIPT_CANONICALIZATION = "rfc8785-jcs-v1";

const SHA40 = /^[0-9a-f]{40}$/;
const VERDICTS = new Set(["PASS", "BLOCK"]);
const TEAMS = new Set(["T1", "T2", "cross-team"]);

export interface NclexReceiptFinding {
  findingId: string;
  blocking: boolean;
  note?: string;
  evidenceRef?: string;
}

export interface NclexReceiptCore {
  schema: typeof NCLEX_RECEIPT_SCHEMA;
  canonicalization: typeof NCLEX_RECEIPT_CANONICALIZATION;
  repo: string;
  prNumber: number;
  baseSha: string;
  headSha: string;
  diffHash: string;
  intentHash: string;
  authorNodeId: string;
  reviewerNodeId: string;
  team: "T1" | "T2" | "cross-team";
  lane: string;
  verdict: "PASS" | "BLOCK";
  findings: NclexReceiptFinding[];
  producedAt: string;
}

export interface NclexSignedReceipt extends NclexReceiptCore {
  receiptId: string;
  signatures: Array<{ protected: string; signature: string }>;
}

export type NclexEvaluationKeyring = Record<string, string>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export class NclexReceiptValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NclexReceiptValidationError";
  }
}

function fail(code: string, message: string): never {
  throw new NclexReceiptValidationError(code, message);
}

/** Validate and normalize the signed core; throws NclexReceiptValidationError. */
export function parseReceiptCore(value: unknown): NclexReceiptCore {
  if (!isPlainObject(value)) fail("receipt_malformed", "receipt core must be an object");
  const core = value as Record<string, unknown>;
  if (core.schema !== NCLEX_RECEIPT_SCHEMA) fail("receipt_malformed", `schema must be ${NCLEX_RECEIPT_SCHEMA}`);
  if (core.canonicalization !== NCLEX_RECEIPT_CANONICALIZATION) {
    fail("receipt_malformed", `canonicalization must be ${NCLEX_RECEIPT_CANONICALIZATION}`);
  }
  if (!hasText(core.repo) || !/^[\w.-]+\/[\w.-]+$/.test(core.repo.trim())) {
    fail("receipt_invalid", "repo must have the form owner/name");
  }
  if (!Number.isSafeInteger(core.prNumber) || (core.prNumber as number) <= 0) {
    fail("receipt_invalid", "prNumber must be a positive integer");
  }
  for (const field of ["baseSha", "headSha"] as const) {
    if (!SHA40.test(String(core[field] ?? ""))) fail("receipt_invalid", `${field} must be a 40-char hex SHA`);
  }
  for (const field of ["diffHash", "intentHash", "authorNodeId", "reviewerNodeId", "lane"] as const) {
    if (!hasText(core[field])) fail("receipt_invalid", `${field} must be a non-empty string`);
  }
  if (!TEAMS.has(core.team as string)) fail("receipt_invalid", "team must be T1|T2|cross-team");
  if (!VERDICTS.has(core.verdict as string)) fail("receipt_invalid", "verdict must be PASS or BLOCK");
  if ((core.authorNodeId as string).trim() === (core.reviewerNodeId as string).trim()) {
    fail("receipt_self_review", "reviewerNodeId must differ from authorNodeId");
  }
  if (
    !Array.isArray(core.findings)
    || !core.findings.every((finding) => isPlainObject(finding) && hasText((finding as Record<string, unknown>).findingId))
  ) {
    fail("receipt_invalid", "findings must be an array of objects with stable findingId");
  }
  if (!hasText(core.producedAt) || Number.isNaN(Date.parse(core.producedAt))) {
    fail("receipt_invalid", "producedAt must be an ISO timestamp");
  }
  return {
    schema: NCLEX_RECEIPT_SCHEMA,
    canonicalization: NCLEX_RECEIPT_CANONICALIZATION,
    repo: (core.repo as string).trim(),
    prNumber: core.prNumber as number,
    baseSha: String(core.baseSha).toLowerCase(),
    headSha: String(core.headSha).toLowerCase(),
    diffHash: (core.diffHash as string).trim(),
    intentHash: (core.intentHash as string).trim(),
    authorNodeId: (core.authorNodeId as string).trim(),
    reviewerNodeId: (core.reviewerNodeId as string).trim(),
    team: core.team as NclexReceiptCore["team"],
    lane: (core.lane as string).trim(),
    verdict: core.verdict as NclexReceiptCore["verdict"],
    findings: (core.findings as Array<Record<string, unknown>>).map((finding) => ({
      findingId: String(finding.findingId).trim(),
      blocking: finding.blocking === true,
      ...(hasText(finding.note) ? { note: String(finding.note).trim() } : {}),
      ...(hasText(finding.evidenceRef) ? { evidenceRef: String(finding.evidenceRef).trim() } : {}),
    })),
    producedAt: new Date(core.producedAt as string).toISOString(),
  };
}

export function receiptIdOf(core: NclexReceiptCore): string {
  // sha256 of the canonical core — identical id to the offline module
  // (both hash canonicalizeJson(core)).
  return `sha256:${createHash("sha256").update(canonicalizeJson(core), "utf8").digest("hex")}`;
}

function kidOf(entry: { protected?: unknown }): string | null {
  try {
    const header = JSON.parse(Buffer.from(String(entry.protected ?? ""), "base64url").toString("utf8"));
    return typeof header.kid === "string" ? header.kid : null;
  } catch {
    return null;
  }
}

export type VerifyReceiptResult =
  | { ok: true; receipt: NclexSignedReceipt }
  | { ok: false; reason: string };

/** Verify a signed receipt against the keyring. Fail-closed, never throws. */
export function verifySignedReceipt(value: unknown, keyring: NclexEvaluationKeyring): VerifyReceiptResult {
  if (!isPlainObject(value)) return { ok: false, reason: "receipt_malformed" };
  const { receiptId, signatures, ...coreValue } = value as Record<string, unknown>;
  let core: NclexReceiptCore;
  try {
    core = parseReceiptCore(coreValue);
  } catch (error) {
    return { ok: false, reason: error instanceof NclexReceiptValidationError ? error.code : "receipt_malformed" };
  }
  if (!hasText(receiptId) || receiptId !== receiptIdOf(core)) {
    return { ok: false, reason: "receipt_id_mismatch" };
  }
  if (!Array.isArray(signatures) || signatures.length !== 1 || !isPlainObject(signatures[0])) {
    return { ok: false, reason: "receipt_signature_missing" };
  }
  const entry = signatures[0] as { protected?: unknown; signature?: unknown };
  if (!hasText(entry.protected) || !hasText(entry.signature)) {
    return { ok: false, reason: "receipt_signature_missing" };
  }
  const kid = kidOf(entry);
  const pem = kid ? keyring[kid] : undefined;
  if (!kid || !hasText(pem)) {
    return { ok: false, reason: "receipt_key_unknown" };
  }
  try {
    const key = createPublicKey(pem);
    const signingInput = `${entry.protected}.${Buffer.from(canonicalizeJson(core), "utf8").toString("base64url")}`;
    const signature = Buffer.from(entry.signature, "base64url");
    if (!cryptoVerify(null, Buffer.from(signingInput, "utf8"), key, signature)) {
      return { ok: false, reason: "receipt_signature_invalid" };
    }
  } catch {
    return { ok: false, reason: "receipt_signature_invalid" };
  }
  return {
    ok: true,
    receipt: { ...core, receiptId, signatures: [{ protected: entry.protected, signature: entry.signature }] },
  };
}
