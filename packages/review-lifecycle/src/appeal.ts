/**
 * Finalizer appeal disposition contract (#1518 Phase 5).
 *
 * This module is deliberately pure and disconnected from the broker runtime
 * and existing signed finalizer merge gate. Appeal requests and dispositions
 * live in ReviewLineageRecord so the exactly-once invariants survive cloning,
 * persistence, and replay instead of relying on caller-held side state.
 */

import { z } from "zod";

import { canonicalize } from "./canonical-json.js";
import type {
  AppealDispositionStateV1,
  AppealRequestV1,
  FinalizerDispositionV1,
  ReviewLineageRecord,
} from "./types.js";

const nonBlankSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value, "must not have surrounding whitespace");
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

export const appealRequestSchema = z
  .object({
    kind: z.literal("AppealRequestV1"),
    appealId: nonBlankSchema,
    lineageId: nonBlankSchema,
    findingId: nonBlankSchema,
    requestedBy: nonBlankSchema,
    requesterRole: z.enum(["author", "operator"]),
    reason: nonBlankSchema,
    requestedAt: timestampSchema,
  })
  .strict();

export const finalizerDispositionSchema = z
  .object({
    kind: z.literal("FinalizerDispositionV1"),
    dispositionId: nonBlankSchema,
    appealId: nonBlankSchema,
    lineageId: nonBlankSchema,
    findingId: nonBlankSchema,
    finalizerId: nonBlankSchema,
    disposition: z.enum(["upheld", "overruled_by_finalizer"]),
    justification: nonBlankSchema,
    decidedAt: timestampSchema,
  })
  .strict();

export type AppealRequestRejectionCode =
  | "appeal_state_missing"
  | "invalid_appeal_request"
  | "lineage_mismatch"
  | "appeal_id_conflict"
  | "finding_not_found"
  | "finding_already_appealed"
  | "finding_not_appealable"
  | "appeal_time_out_of_order";

export type RequestFindingAppealResult =
  | {
      ok: true;
      idempotent: boolean;
      record: ReviewLineageRecord;
      effects: string[];
    }
  | {
      ok: false;
      code: AppealRequestRejectionCode;
      record: ReviewLineageRecord;
      effects: string[];
    };

export type FinalizerDispositionRejectionCode =
  | "appeal_state_missing"
  | "invalid_disposition"
  | "lineage_mismatch"
  | "disposition_id_conflict"
  | "appeal_not_found"
  | "appeal_finding_mismatch"
  | "finalizer_owner_conflict"
  | "finding_already_disposed"
  | "finding_not_appealable"
  | "disposition_time_out_of_order";

export type ApplyFinalizerDispositionResult =
  | {
      ok: true;
      idempotent: boolean;
      record: ReviewLineageRecord;
      effects: string[];
    }
  | {
      ok: false;
      code: FinalizerDispositionRejectionCode;
      record: ReviewLineageRecord;
      effects: string[];
    };

function validAppealState(
  record: ReviewLineageRecord,
): AppealDispositionStateV1 | null {
  const state = record.appeal;
  if (
    !state ||
    state.kind !== "AppealDispositionStateV1" ||
    state.lineageId !== record.lineageId ||
    !Array.isArray(state.requests) ||
    !Array.isArray(state.dispositions)
  ) {
    return null;
  }
  return state;
}

function appealRejected(
  code: AppealRequestRejectionCode,
  record: ReviewLineageRecord,
  detail?: string,
): RequestFindingAppealResult {
  return {
    ok: false,
    code,
    record,
    effects: [`appeal_request_rejected:${code}${detail ? `:${detail}` : ""}`],
  };
}

/**
 * Record an explicit dispute before a finalizer can dispose the finding.
 *
 * Exact retries are idempotent. A finding can have at most one appeal request
 * in this Phase 5 contract; new-evidence classes must use a new finding ID.
 */
export function requestFindingAppeal(
  record: ReviewLineageRecord,
  input: unknown,
): RequestFindingAppealResult {
  const state = validAppealState(record);
  if (!state) return appealRejected("appeal_state_missing", record);

  const parsed = appealRequestSchema.safeParse(input);
  if (!parsed.success) {
    return appealRejected("invalid_appeal_request", record);
  }
  const request: AppealRequestV1 = parsed.data;

  if (request.lineageId !== record.lineageId) {
    return appealRejected(
      "lineage_mismatch",
      record,
      request.lineageId,
    );
  }

  const existingById = state.requests.find(
    (entry) => entry.appealId === request.appealId,
  );
  if (existingById) {
    if (canonicalize(existingById) === canonicalize(request)) {
      return {
        ok: true,
        idempotent: true,
        record,
        effects: [`appeal_request_idempotent:${request.appealId}`],
      };
    }
    return appealRejected(
      "appeal_id_conflict",
      record,
      request.appealId,
    );
  }

  const finding = record.ledger.findings.find(
    (entry) => entry.findingId === request.findingId,
  );
  if (!finding) {
    return appealRejected(
      "finding_not_found",
      record,
      request.findingId,
    );
  }
  if (
    state.requests.some((entry) => entry.findingId === request.findingId)
  ) {
    return appealRejected(
      "finding_already_appealed",
      record,
      request.findingId,
    );
  }
  if (finding.disposition !== "open" && finding.disposition !== "reopened") {
    return appealRejected(
      "finding_not_appealable",
      record,
      request.findingId,
    );
  }
  if (Date.parse(request.requestedAt) < Date.parse(record.updatedAt)) {
    return appealRejected(
      "appeal_time_out_of_order",
      record,
      request.appealId,
    );
  }

  return {
    ok: true,
    idempotent: false,
    record: {
      ...record,
      appeal: {
        ...state,
        requests: [...state.requests, request],
      },
      updatedAt: request.requestedAt,
    },
    effects: [`appeal_requested:${request.appealId}:${request.findingId}`],
  };
}

function dispositionRejected(
  code: FinalizerDispositionRejectionCode,
  record: ReviewLineageRecord,
  detail?: string,
): ApplyFinalizerDispositionResult {
  return {
    ok: false,
    code,
    record,
    effects: [`finalizer_disposition_rejected:${code}${detail ? `:${detail}` : ""}`],
  };
}

/**
 * Apply one finalizer disposition to one recorded appeal.
 *
 * An exact disposition retry is an idempotent no-op. Reusing a disposition ID
 * with a different payload, assigning a second finalizer, or disposing a
 * finding twice fails closed. The lifecycle state and HEAD never transition
 * here; Phase 6 integration remains a separate boundary.
 */
export function applyFinalizerDisposition(
  record: ReviewLineageRecord,
  input: unknown,
): ApplyFinalizerDispositionResult {
  const state = validAppealState(record);
  if (!state) return dispositionRejected("appeal_state_missing", record);

  const parsed = finalizerDispositionSchema.safeParse(input);
  if (!parsed.success) {
    return dispositionRejected("invalid_disposition", record);
  }
  const disposition: FinalizerDispositionV1 = parsed.data;

  if (disposition.lineageId !== record.lineageId) {
    return dispositionRejected(
      "lineage_mismatch",
      record,
      disposition.lineageId,
    );
  }

  const existingById = state.dispositions.find(
    (entry) => entry.dispositionId === disposition.dispositionId,
  );
  if (existingById) {
    if (canonicalize(existingById) === canonicalize(disposition)) {
      return {
        ok: true,
        idempotent: true,
        record,
        effects: [
          `finalizer_disposition_idempotent:${disposition.dispositionId}`,
        ],
      };
    }
    return dispositionRejected(
      "disposition_id_conflict",
      record,
      disposition.dispositionId,
    );
  }

  const appeal = state.requests.find(
    (entry) => entry.appealId === disposition.appealId,
  );
  if (!appeal) {
    return dispositionRejected(
      "appeal_not_found",
      record,
      disposition.appealId,
    );
  }
  if (appeal.findingId !== disposition.findingId) {
    return dispositionRejected(
      "appeal_finding_mismatch",
      record,
      disposition.findingId,
    );
  }

  const finding = record.ledger.findings.find(
    (entry) => entry.findingId === disposition.findingId,
  );
  if (!finding) {
    // A recorded appeal for a now-missing finding is corrupted lineage state.
    return dispositionRejected(
      "appeal_finding_mismatch",
      record,
      disposition.findingId,
    );
  }

  if (
    state.finalizerOwnerId !== null &&
    state.finalizerOwnerId !== disposition.finalizerId
  ) {
    return dispositionRejected(
      "finalizer_owner_conflict",
      record,
      disposition.finalizerId,
    );
  }

  if (
    state.dispositions.some(
      (entry) => entry.findingId === disposition.findingId,
    )
  ) {
    return dispositionRejected(
      "finding_already_disposed",
      record,
      disposition.findingId,
    );
  }

  if (finding.disposition !== "open" && finding.disposition !== "reopened") {
    return dispositionRejected(
      "finding_not_appealable",
      record,
      disposition.findingId,
    );
  }
  if (
    Date.parse(disposition.decidedAt) < Date.parse(appeal.requestedAt) ||
    Date.parse(disposition.decidedAt) < Date.parse(record.updatedAt)
  ) {
    return dispositionRejected(
      "disposition_time_out_of_order",
      record,
      disposition.dispositionId,
    );
  }

  const nextAppeal: AppealDispositionStateV1 = {
    ...state,
    finalizerOwnerId: state.finalizerOwnerId ?? disposition.finalizerId,
    dispositions: [...state.dispositions, disposition],
  };

  if (disposition.disposition === "upheld") {
    return {
      ok: true,
      idempotent: false,
      record: {
        ...record,
        appeal: nextAppeal,
        updatedAt: disposition.decidedAt,
      },
      effects: [`finding_upheld:${disposition.findingId}`],
    };
  }

  const nextFindings = record.ledger.findings.map((entry) =>
    entry.findingId === disposition.findingId
      ? { ...entry, disposition: "overruled_by_finalizer" as const }
      : entry,
  );
  const sameSignatureStillOpen = nextFindings.some(
    (entry) =>
      entry.blocking &&
      entry.signature === finding.signature &&
      (entry.disposition === "open" || entry.disposition === "reopened"),
  );
  const unresolvedSignatures = { ...record.unresolvedSignatures };
  if (!sameSignatureStillOpen) {
    delete unresolvedSignatures[finding.signature];
  }

  return {
    ok: true,
    idempotent: false,
    record: {
      ...record,
      ledger: {
        ...record.ledger,
        findings: nextFindings,
      },
      appeal: nextAppeal,
      unresolvedSignatures,
      updatedAt: disposition.decidedAt,
    },
    effects: [`finding_overruled_by_finalizer:${disposition.findingId}`],
  };
}
