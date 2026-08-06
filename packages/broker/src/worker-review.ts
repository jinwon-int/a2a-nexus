/**
 * Independent review evidence contract (#1237).
 *
 * Dispatchers can opt in with `task.payload.review.required === true`. When
 * present, successful completion must carry an independent reviewer verdict in
 * `result.validation` or `result.validations[]`: reviewer node id, pass/fail
 * verdict, and a human reason.
 * The reviewer must not be the worker/author completing the task. This is an
 * advisory/manual assignment layer for now; reviewer auto-assignment is out of
 * scope for the first P5 slice.
 *
 * Trusted author identity (#1518/#1548): self-contained review tasks (the
 * completing worker IS the reviewer) declare the author under review via
 * `task.payload.review.authorWorkerId` at dispatch time. The payload is
 * dispatcher-controlled, so the completing worker cannot forge it. When
 * declared, independence compares the reviewer against that author; when
 * absent, the legacy fallback (claimedBy → assignedWorkerId → targetNodeId)
 * applies unchanged. Analysis-only review tasks must NOT attach
 * `payload.acceptance.command`: review validation is independent from smoke
 * acceptance, and an unexecuted acceptance command fails closed as
 * `acceptance_evidence_missing`.
 *
 * Review kind (#1518, routed from #1725 finding 3): merge/acceptance review
 * and dialectic antithesis are distinct contracts. `kind: "acceptance"`
 * (default) keeps the pass-only merge gate. `kind: "antithesis"` marks an
 * A2AD critique lane whose `fail` verdict is successfully collected
 * counter-evidence — terminal success, never `review_verdict_failed` — so a
 * lane that correctly finds defects is preserved as finalizer input instead
 * of being dropped as a lifecycle failure. Wrapper-only/empty evidence stays
 * excluded by the unchanged evidence check above it.
 */
import type { TaskError, TaskRecord, TaskResult, TaskValidationPayload } from "./core/types.js";

export type TaskReviewKind = "acceptance" | "antithesis";

export interface TaskReviewSpec {
  required: boolean;
  /** Dispatcher-declared trusted author identity for self-contained review tasks (#1518/#1548). */
  authorWorkerId?: string;
  /** Review contract kind; absent defaults to "acceptance" semantics. */
  kind?: TaskReviewKind;
  /** Antithesis lanes: the thesis/implementation lane under critique. */
  targetLaneId?: string;
}

export type ParsedTaskReview =
  | { spec: TaskReviewSpec; error?: undefined }
  | { spec?: undefined; error: TaskError }
  | null;

export function parseTaskReview(task: TaskRecord): ParsedTaskReview {
  const raw = (task.payload as Record<string, unknown> | undefined)?.review;
  if (raw === undefined || raw === null) return null;

  const malformed = (detail: string): { error: TaskError } => ({
    error: {
      code: "review_evidence_missing",
      message: `task.payload.review is malformed: ${detail}`,
    },
  });

  if (typeof raw !== "object" || Array.isArray(raw)) return malformed("expected an object");
  const record = raw as Record<string, unknown>;
  if (record.required === true) {
    const rawAuthor = record.authorWorkerId;
    let authorWorkerId: string | undefined;
    if (rawAuthor === undefined || rawAuthor === null) {
      authorWorkerId = undefined;
    } else if (typeof rawAuthor !== "string" || rawAuthor.trim() === "") {
      return malformed("authorWorkerId must be a non-empty string when present");
    } else {
      authorWorkerId = rawAuthor.trim();
    }

    const rawKind = record.kind;
    let kind: TaskReviewKind | undefined;
    if (rawKind === undefined || rawKind === null) {
      kind = undefined;
    } else if (rawKind === "acceptance" || rawKind === "antithesis") {
      kind = rawKind;
    } else {
      return malformed('kind must be "acceptance" or "antithesis" when present');
    }

    const rawTargetLane = record.targetLaneId;
    let targetLaneId: string | undefined;
    if (rawTargetLane === undefined || rawTargetLane === null) {
      targetLaneId = undefined;
    } else if (typeof rawTargetLane !== "string" || rawTargetLane.trim() === "") {
      return malformed("targetLaneId must be a non-empty string when present");
    } else {
      targetLaneId = rawTargetLane.trim();
    }

    return {
      spec: {
        required: true,
        ...(authorWorkerId ? { authorWorkerId } : {}),
        ...(kind ? { kind } : {}),
        ...(targetLaneId ? { targetLaneId } : {}),
      },
    };
  }
  if (record.required === false || record.required === undefined) return { spec: { required: false } };
  return malformed("required must be a boolean when present");
}

function reviewValidation(result: TaskResult | undefined): TaskValidationPayload | undefined {
  if (!result) return undefined;
  if (Array.isArray(result.validations)) {
    return result.validations.find((validation) => validation?.kind === "review");
  }
  return result.validation;
}

export function validateReviewEvidence(task: TaskRecord, result?: TaskResult, authorWorkerId?: string): TaskError | null {
  const parsed = parseTaskReview(task);
  if (parsed === null) return null;
  if (parsed.error) return parsed.error;
  if (!parsed.spec.required) return null;

  const validation = reviewValidation(result);
  const reviewerNodeId = typeof validation?.nodeId === "string" ? validation.nodeId.trim() : "";
  const note = typeof validation?.note === "string" ? validation.note.trim() : "";

  if (!validation || validation.kind !== "review" || !reviewerNodeId || !validation.verdict || !note) {
    return {
      code: "review_evidence_missing",
      message:
        Array.isArray(result?.validations)
          ? "task.payload.review.required is true but result.validations lacks review kind, reviewer nodeId, verdict, or note evidence"
          : "task.payload.review.required is true but result.validation lacks review kind, reviewer nodeId, verdict, or note evidence",
    };
  }

  const authorId = (authorWorkerId ?? parsed.spec.authorWorkerId ?? task.claimedBy ?? task.assignedWorkerId ?? task.targetNodeId ?? "").trim();
  if (authorId && reviewerNodeId === authorId) {
    return {
      code: "review_not_independent",
      message: `reviewer nodeId ${reviewerNodeId} must differ from author worker ${authorId}`,
      details: { reviewerNodeId, authorWorkerId: authorId },
    };
  }

  const kind = parsed.spec.kind ?? "acceptance";
  if (kind === "antithesis") {
    // Dialectic critique lane: a fail verdict IS the successfully collected
    // counter-evidence. Terminal success — the finalizer reads the negative
    // verdict from result.validation; it must not become review_verdict_failed.
    if (validation.verdict !== "pass" && validation.verdict !== "fail") {
      return {
        code: "review_evidence_missing",
        message: `antithesis review verdict must be "pass" or "fail", got "${validation.verdict}"`,
        details: { reviewerNodeId, verdict: validation.verdict, kind },
      };
    }
    return null;
  }

  if (validation.verdict !== "pass") {
    return {
      code: "review_verdict_failed",
      message: `task review verdict is "${validation.verdict}" (requires "pass")`,
      details: { reviewerNodeId, verdict: validation.verdict },
    };
  }

  return null;
}
