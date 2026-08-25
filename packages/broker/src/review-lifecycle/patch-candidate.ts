/**
 * Isolated fixer patch-candidate contract (#1518 Phase 5).
 *
 * Candidates are proposal-only metadata bound to the frozen lineage subject.
 * Validation and explicit acceptance are pure: neither operation writes Git,
 * pushes a branch, changes the author HEAD, nor applies a lifecycle event.
 */

import { z } from "zod";

import { canonicalize, sha256Hex } from "./canonical-json.js";
import { classifyPaths } from "./lifecycle.js";
import type { ReviewLineageRecord } from "./types.js";

const nonBlankSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "must not have surrounding whitespace");
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const hashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const timestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
    "expected a UTC ISO-8601 instant",
  )
  .refine((value) => {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return false;
    const normalized = value.includes(".")
      ? value
      : value.replace("Z", ".000Z");
    return new Date(parsed).toISOString() === normalized;
  }, "expected a valid calendar instant");

const patchCandidateInputSchema = z
  .object({
    kind: z.literal("PatchCandidateV1"),
    candidateId: nonBlankSchema,
    lineageId: nonBlankSchema,
    generationKind: z.literal("additive_child"),
    parentOriginalHeadSha: shaSchema,
    baseDiffHash: hashSchema,
    intentHash: hashSchema,
    producerId: nonBlankSchema,
    producerRole: z.literal("fixer"),
    authority: z.literal("propose_only"),
    pathsChanged: z.array(nonBlankSchema).min(1),
    patchDigest: hashSchema,
    createdAt: timestampSchema,
  })
  .strict();

export type PatchCandidateInput = z.infer<typeof patchCandidateInputSchema>;

export const patchCandidateSchema = patchCandidateInputSchema
  .extend({
    candidateHash: hashSchema,
  })
  .strict();

export type PatchCandidateV1 = z.infer<typeof patchCandidateSchema>;

export const patchCandidateAcceptanceSchema = z
  .object({
    kind: z.literal("PatchCandidateAcceptanceV1"),
    acceptanceId: nonBlankSchema,
    candidateId: nonBlankSchema,
    candidateHash: hashSchema,
    lineageId: nonBlankSchema,
    expectedOriginalHeadSha: shaSchema,
    expectedBaseDiffHash: hashSchema,
    expectedIntentHash: hashSchema,
    acceptedBy: nonBlankSchema,
    accepterRole: z.literal("operator"),
    acceptedAt: timestampSchema,
  })
  .strict();

export type PatchCandidateAcceptanceV1 = z.infer<
  typeof patchCandidateAcceptanceSchema
>;

export interface PatchCandidateAcceptanceReceiptV1 {
  kind: "PatchCandidateAcceptanceReceiptV1";
  acceptanceId: string;
  candidateId: string;
  candidateHash: string;
  lineageId: string;
  acceptedBy: string;
  acceptedAt: string;
  effect: "contract_only_no_apply";
}

export type PatchCandidateRejectionCode =
  | "invalid_candidate"
  | "candidate_hash_mismatch"
  | "lineage_mismatch"
  | "state_not_correction_pending"
  | "original_head_mismatch"
  | "original_head_not_current"
  | "base_diff_hash_unavailable"
  | "base_diff_hash_mismatch"
  | "intent_hash_mismatch"
  | "candidate_time_out_of_order"
  | "duplicate_path"
  | "forbidden_path"
  | "scope_drift";

export type ValidatePatchCandidateResult =
  | { ok: true; candidate: PatchCandidateV1; effects: string[] }
  | {
      ok: false;
      code: PatchCandidateRejectionCode;
      effects: string[];
    };

export type PatchCandidateAcceptanceRejectionCode =
  | PatchCandidateRejectionCode
  | "invalid_acceptance"
  | "acceptance_candidate_mismatch"
  | "acceptance_subject_mismatch"
  | "acceptance_actor_not_independent"
  | "acceptance_time_out_of_order";

export type AcceptPatchCandidateResult =
  | {
      ok: true;
      record: ReviewLineageRecord;
      candidate: PatchCandidateV1;
      acceptance: PatchCandidateAcceptanceReceiptV1;
      effects: string[];
    }
  | {
      ok: false;
      code: PatchCandidateAcceptanceRejectionCode;
      record: ReviewLineageRecord;
      effects: string[];
    };

function candidateHash(input: PatchCandidateInput): string {
  return `sha256:${sha256Hex(canonicalize(input))}`;
}

export function createPatchCandidate(input: PatchCandidateInput): PatchCandidateV1 {
  const parsed = patchCandidateInputSchema.parse(input);
  return {
    ...parsed,
    candidateHash: candidateHash(parsed),
  };
}

function candidateRejected(
  code: PatchCandidateRejectionCode,
  detail?: string,
): ValidatePatchCandidateResult {
  return {
    ok: false,
    code,
    effects: [`patch_candidate_rejected:${code}${detail ? `:${detail}` : ""}`],
  };
}

/**
 * Validate an isolated proposal. A successful result is not acceptance.
 */
export function validatePatchCandidate(
  record: ReviewLineageRecord,
  input: unknown,
): ValidatePatchCandidateResult {
  const parsed = patchCandidateSchema.safeParse(input);
  if (!parsed.success) return candidateRejected("invalid_candidate");
  const candidate = parsed.data;

  const { candidateHash: declaredCandidateHash, ...hashInput } = candidate;
  if (candidateHash(hashInput) !== declaredCandidateHash) {
    return candidateRejected(
      "candidate_hash_mismatch",
      candidate.candidateId,
    );
  }
  if (candidate.lineageId !== record.lineageId) {
    return candidateRejected("lineage_mismatch", candidate.lineageId);
  }
  if (record.state !== "correction_pending") {
    return candidateRejected("state_not_correction_pending", record.state);
  }
  if (candidate.parentOriginalHeadSha !== record.contract.headSha) {
    return candidateRejected(
      "original_head_mismatch",
      candidate.parentOriginalHeadSha,
    );
  }
  if (record.currentHeadSha !== record.contract.headSha) {
    return candidateRejected(
      "original_head_not_current",
      record.currentHeadSha,
    );
  }
  if (record.currentDiffHash === null) {
    return candidateRejected("base_diff_hash_unavailable");
  }
  if (candidate.baseDiffHash !== record.currentDiffHash) {
    return candidateRejected(
      "base_diff_hash_mismatch",
      candidate.baseDiffHash,
    );
  }
  if (candidate.intentHash !== record.contract.intentHash) {
    return candidateRejected("intent_hash_mismatch", candidate.intentHash);
  }
  if (Date.parse(candidate.createdAt) < Date.parse(record.updatedAt)) {
    return candidateRejected(
      "candidate_time_out_of_order",
      candidate.createdAt,
    );
  }

  const uniquePaths = new Set(candidate.pathsChanged);
  if (uniquePaths.size !== candidate.pathsChanged.length) {
    return candidateRejected("duplicate_path");
  }
  const { forbidden, outside } = classifyPaths(
    record.contract,
    candidate.pathsChanged,
  );
  if (forbidden.length > 0) {
    return candidateRejected("forbidden_path", forbidden.join(","));
  }
  if (outside.length > 0) {
    return candidateRejected("scope_drift", outside.join(","));
  }

  return {
    ok: true,
    candidate,
    effects: [`patch_candidate_validated:${candidate.candidateId}`],
  };
}

/**
 * Record explicit operator acceptance without applying the patch.
 *
 * The expected original HEAD, diff, intent, candidate ID, and candidate hash
 * are rebound at this boundary. The returned lifecycle record is the exact
 * input object: accepting this contract cannot move a HEAD or consume a
 * correction generation.
 */
export function acceptPatchCandidate(
  record: ReviewLineageRecord,
  candidateInput: unknown,
  acceptanceInput: unknown,
): AcceptPatchCandidateResult {
  const validated = validatePatchCandidate(record, candidateInput);
  if (!validated.ok) {
    return {
      ok: false,
      code: validated.code,
      record,
      effects: validated.effects,
    };
  }

  const parsedAcceptance =
    patchCandidateAcceptanceSchema.safeParse(acceptanceInput);
  if (!parsedAcceptance.success) {
    return {
      ok: false,
      code: "invalid_acceptance",
      record,
      effects: ["patch_candidate_acceptance_rejected:invalid_acceptance"],
    };
  }
  const acceptance = parsedAcceptance.data;
  const candidate = validated.candidate;

  if (
    acceptance.candidateId !== candidate.candidateId ||
    acceptance.candidateHash !== candidate.candidateHash
  ) {
    return {
      ok: false,
      code: "acceptance_candidate_mismatch",
      record,
      effects: [
        "patch_candidate_acceptance_rejected:acceptance_candidate_mismatch",
      ],
    };
  }
  if (
    acceptance.lineageId !== record.lineageId ||
    acceptance.expectedOriginalHeadSha !== record.contract.headSha ||
    acceptance.expectedBaseDiffHash !== record.currentDiffHash ||
    acceptance.expectedIntentHash !== record.contract.intentHash
  ) {
    return {
      ok: false,
      code: "acceptance_subject_mismatch",
      record,
      effects: [
        "patch_candidate_acceptance_rejected:acceptance_subject_mismatch",
      ],
    };
  }
  if (acceptance.acceptedBy === candidate.producerId) {
    return {
      ok: false,
      code: "acceptance_actor_not_independent",
      record,
      effects: [
        "patch_candidate_acceptance_rejected:acceptance_actor_not_independent",
      ],
    };
  }
  if (Date.parse(acceptance.acceptedAt) < Date.parse(candidate.createdAt)) {
    return {
      ok: false,
      code: "acceptance_time_out_of_order",
      record,
      effects: [
        "patch_candidate_acceptance_rejected:acceptance_time_out_of_order",
      ],
    };
  }

  return {
    ok: true,
    record,
    candidate,
    acceptance: {
      kind: "PatchCandidateAcceptanceReceiptV1",
      acceptanceId: acceptance.acceptanceId,
      candidateId: candidate.candidateId,
      candidateHash: candidate.candidateHash,
      lineageId: record.lineageId,
      acceptedBy: acceptance.acceptedBy,
      acceptedAt: acceptance.acceptedAt,
      effect: "contract_only_no_apply",
    },
    effects: [`patch_candidate_accepted_contract_only:${candidate.candidateId}`],
  };
}
