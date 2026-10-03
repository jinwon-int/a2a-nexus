/**
 * NCLEX content PR evaluation receipt — broker-side contract (#1724).
 *
 * Mirrors scripts/nclex-content-pr-receipt.mjs field-for-field and verifies
 * signatures with the SAME RFC 8785 JCS (a2a-attestation canonicalizeJson) +
 * node:crypto EdDSA path, so receipts signed by the offline module verify
 * identically here — one crypto stack, pinned by golden JCS vectors in both
 * test suites.
 *
 * Fail-closed: malformed cores, unknown key ids, invalid signatures,
 * self-review, and restricted-artifact findings (oversized/multi-line notes,
 * prose evidenceRefs) are rejected; nothing is admitted on a soft error.
 */
import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

import { canonicalizeJson } from "a2a-attestation";

export const NCLEX_RECEIPT_SCHEMA = "nclex.content-pr.receipt.v1";
export const NCLEX_RECEIPT_CANONICALIZATION = "rfc8785-jcs-v1";

const SHA40 = /^[0-9a-f]{40}$/;
const VERDICTS = new Set(["PASS", "BLOCK"]);
const TEAMS = new Set(["T1", "T2", "cross-team"]);

// Restricted-artifact boundary (#1724): a finding carries only a short
// single-line note and a reference-form evidenceRef (refs-manifest entry ID or
// sha256 plus an optional page/section locator), never a verbatim excerpt of
// restricted/factcheck-only material. Kept byte-identical with
// scripts/nclex-content-pr-receipt.mjs; receipt-contract.test.ts imports the
// offline module and pins the parity.
export const NCLEX_FINDING_NOTE_MAX_CHARS = 280;
export const NCLEX_EVIDENCE_REF_MAX_CHARS = 160;
export const NCLEX_EVIDENCE_REF_PATTERN =
  /^(?:([a-z][a-z0-9-]{0,31}):)?([A-Za-z0-9][A-Za-z0-9._/-]{0,127})(?:#([A-Za-z0-9][A-Za-z0-9._:/-]{0,63}))?$/;
// C0/C1 controls (newline, CR, tab, ...) plus Unicode line/paragraph separators.
const NOTE_FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

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

/**
 * Restricted-artifact check for one finding's free-text fields (#1724). Runs on
 * the trimmed value; a violation fails closed as `receipt_restricted_artifact`.
 */
function assertFindingCarriesNoRestrictedArtifact(finding: Record<string, unknown>): void {
  if (hasText(finding.note)) {
    const note = finding.note.trim();
    if (NOTE_FORBIDDEN_CHARS.test(note)) {
      fail("receipt_restricted_artifact", "finding note must be a single line without control characters");
    }
    if ([...note].length > NCLEX_FINDING_NOTE_MAX_CHARS) {
      fail("receipt_restricted_artifact", `finding note must be at most ${NCLEX_FINDING_NOTE_MAX_CHARS} characters`);
    }
  }
  if (hasText(finding.evidenceRef)) {
    const ref = finding.evidenceRef.trim();
    const match = ref.length <= NCLEX_EVIDENCE_REF_MAX_CHARS ? NCLEX_EVIDENCE_REF_PATTERN.exec(ref) : null;
    if (!match || (match[1] === "sha256" && !/^[0-9a-f]{64}$/.test(match[2] ?? ""))) {
      fail(
        "receipt_restricted_artifact",
        "finding evidenceRef must be a reference ([namespace:]id[#locator], sha256:<64-hex>), not prose",
      );
    }
  }
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
  for (const finding of core.findings as Array<Record<string, unknown>>) assertFindingCarriesNoRestrictedArtifact(finding);
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
  return receiptIdOfCanonical(canonicalizeJson(core));
}

/** receiptIdOf over an already-canonicalized core, so verify canonicalizes once. */
function receiptIdOfCanonical(canonical: string): string {
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

// Parsed-SPKI memoization: keyrings are tiny and static, so parse each PEM once
// instead of per verify. Bounded with insertion-order eviction; a parse failure
// is never cached and fails the verify exactly as an uncached parse would.
const MAX_CACHED_PUBLIC_KEYS = 64;
const publicKeyCache = new Map<string, KeyObject>();

function publicKeyFor(pem: string): KeyObject {
  const cached = publicKeyCache.get(pem);
  if (cached) return cached;
  const key = createPublicKey(pem);
  if (publicKeyCache.size >= MAX_CACHED_PUBLIC_KEYS) {
    const oldest = publicKeyCache.keys().next().value;
    if (oldest !== undefined) publicKeyCache.delete(oldest);
  }
  publicKeyCache.set(pem, key);
  return key;
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
  const canonical = canonicalizeJson(core);
  if (!hasText(receiptId) || receiptId !== receiptIdOfCanonical(canonical)) {
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
    const key = publicKeyFor(pem);
    const signingInput = `${entry.protected}.${Buffer.from(canonical, "utf8").toString("base64url")}`;
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
