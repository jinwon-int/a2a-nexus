/**
 * Stage-to-task binding contract for WavePlanDagV2 (#1800 item B-2, adopted
 * by operator ruling 2026-09-14).
 *
 * Implements docs/specs/wave-plan-dag-v2/stage-task-binding.md §4–§6 as pure,
 * closed-record functions over the slice-4 evidence ledger, the slice-1
 * admission, and live task-lineage reads:
 *
 * - **Binding is evidence, not authority (D3).** No record below has an
 *   action field. Binding ≠ admission ≠ readiness ≠ dispatch. The only hard
 *   gate in the contract is the §5 mandatory refusal, enforced at the write
 *   path ({@link planWavePlanDagV2StageBinding}); everything else is
 *   operator-visible counting. Task-creation authority stays wherever it
 *   lives today.
 * - **Binding lives on the task side (D1).** The frozen manifest schema gains
 *   no fields; a binding is a `stage_task_binding_recorded` ledger row
 *   (record-store union extension) that says "task T was created for stage S
 *   of admitted manifest M".
 * - **Structural duplicates only (D4).** Duplicate detection means structural
 *   reuse of `(manifestDigest, stageId)` — never semantic similarity.
 * - **Fail-closed ledger, bounded views (D5).** Ledger persistence inherits
 *   the slice-4 posture unchanged (idempotent redelivery by semantic key,
 *   all-or-nothing batches, fail-closed restore). Validation outputs are
 *   bounded projections in the slice-2 posture: closed enums, counts clamped
 *   at {@link WAVE_PLAN_DAG_V2_BINDING_COUNT_CAP} with reached flags, and —
 *   for the §6 frontier — a public surface that carries no task ids and no
 *   digests.
 * - **No new digest scheme (D6).** Snapshot integrity is structural
 *   validation plus fail-closed restore; the only digests in play are the
 *   landed manifest and receipt digests.
 *
 * Default-off: recording is governed by the slice-5 `A2A_WAVE_PLAN_DAG_V2_MODE`
 * gate (`off` default). Nothing in this module is invoked implicitly anywhere
 * in the broker; the single write entry is
 * `InMemoryA2ABroker.recordWavePlanDagV2StageBinding()`, and §8 keeps the
 * slice-3 intake-record union action-free — binding evidence is never a
 * routing input.
 */

import {
  wavePlanDagV2StageBindingEntry,
  WAVE_PLAN_DAG_V2_STAGE_BINDING_SOURCES,
  type WavePlanDagV2StageBindingSource,
  type WavePlanDagV2StoreRejectionReason,
  type WavePlanDagV2StoredEntry,
} from "./record-store.js";
import type { WavePlanDagManifestAdmissionV2 } from "./manifest.js";
import type { WavePlanDagDryRunReceiptV2 } from "./dry-run.js";
import { compareAscii } from "./digest.js";

// ---------------------------------------------------------------------------
// Closed vocabularies (§3, §4.3, §5, §6)
// ---------------------------------------------------------------------------

const STAGE_ID_PATTERN = /^stg_[0-9a-f]{8}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** §3: 1–128 printable ASCII characters, no whitespace or control characters. */
const TASK_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;

/** §4.2 step 3: only open tasks may be bound. */
export const WAVE_PLAN_DAG_V2_BOUND_TASK_OPEN_STATUSES = [
  "blocked",
  "queued",
  "claimed",
  "running",
] as const;
/** §4.2 step 3: terminal tasks cannot carry a new binding. */
export const WAVE_PLAN_DAG_V2_BOUND_TASK_TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "canceled",
] as const;

export type WavePlanDagV2BoundTaskStatusV1 =
  | (typeof WAVE_PLAN_DAG_V2_BOUND_TASK_OPEN_STATUSES)[number]
  | (typeof WAVE_PLAN_DAG_V2_BOUND_TASK_TERMINAL_STATUSES)[number];

const OPEN_STATUS_SET: ReadonlySet<string> = new Set(WAVE_PLAN_DAG_V2_BOUND_TASK_OPEN_STATUSES);
const TERMINAL_STATUS_SET: ReadonlySet<string> = new Set(WAVE_PLAN_DAG_V2_BOUND_TASK_TERMINAL_STATUSES);

/**
 * Binding write-path rejection vocabulary (§4.2/§4.3). Store-local — separate
 * from the §5 spec-reason enum per slice 4: these reasons are produced by the
 * binding preconditions and the store's own flow ordering, never by §5
 * admission.
 */
export const WAVE_PLAN_DAG_V2_STAGE_BINDING_REJECTION_REASONS = [
  "entry_malformed",
  "manifest_not_known",
  "unknown_stage",
  "task_unknown",
  "task_not_open",
  "duplicate_open_binding",
] as const;

export type WavePlanDagV2StageBindingRejectionReason =
  (typeof WAVE_PLAN_DAG_V2_STAGE_BINDING_REJECTION_REASONS)[number];

/** Bounded-view count cap (slice-2 posture: fixed cap plus a reached flag). */
export const WAVE_PLAN_DAG_V2_BINDING_COUNT_CAP = 64;

export const WAVE_PLAN_DAG_V2_STAGE_FOLLOW_UP_CHECK_KIND = "WavePlanDagStageFollowUpCheckV1" as const;
export const WAVE_PLAN_DAG_V2_STAGE_FRONTIER_PROJECTION_KIND = "WavePlanDagStageFrontierProjectionV1" as const;
export const WAVE_PLAN_DAG_V2_STAGE_FRONTIER_PUBLIC_KIND = "WavePlanDagStageFrontierPublicV1" as const;

// ---------------------------------------------------------------------------
// §5 — follow-up check (duplicate guard)
// ---------------------------------------------------------------------------

/** §5 closed state enum. */
export type WavePlanDagStageFollowUpStateV1 =
  | "no_prior_binding"
  | "prior_binding_open"
  | "prior_binding_terminal"
  | "unknown_binding_target"
  | "lineage_unavailable";

/** §5 closed check record: one state plus bounded open/terminal counts. */
export interface WavePlanDagStageFollowUpCheckV1 {
  kind: typeof WAVE_PLAN_DAG_V2_STAGE_FOLLOW_UP_CHECK_KIND;
  version: 1;
  manifestDigest: string;
  stageId: string;
  state: WavePlanDagStageFollowUpStateV1;
  openBoundTaskCount: number;
  openBoundTaskCountCollapsedAtCap: boolean;
  terminalBoundTaskCount: number;
  terminalBoundTaskCountCollapsedAtCap: boolean;
}

/**
 * Live lineage status reader. Returns the task's current status read from the
 * task-lineage read model — never cached — or `null` when the task does not
 * resolve. Status values outside the closed union are treated as unresolved:
 * the check refuses rather than guessing.
 */
export type WavePlanDagV2TaskStatusReader = (taskId: string) => WavePlanDagV2BoundTaskStatusV1 | null;

function clampCount(value: number): { count: number; collapsedAtCap: boolean } {
  return {
    count: Math.min(value, WAVE_PLAN_DAG_V2_BINDING_COUNT_CAP),
    collapsedAtCap: value > WAVE_PLAN_DAG_V2_BINDING_COUNT_CAP,
  };
}

function followUpRecord(
  manifestDigest: string,
  stageId: string,
  state: WavePlanDagStageFollowUpStateV1,
  openCount: number,
  terminalCount: number,
): WavePlanDagStageFollowUpCheckV1 {
  const open = clampCount(openCount);
  const terminal = clampCount(terminalCount);
  return {
    kind: WAVE_PLAN_DAG_V2_STAGE_FOLLOW_UP_CHECK_KIND,
    version: 1,
    manifestDigest,
    stageId,
    state,
    openBoundTaskCount: open.count,
    openBoundTaskCountCollapsedAtCap: open.collapsedAtCap,
    terminalBoundTaskCount: terminal.count,
    terminalBoundTaskCountCollapsedAtCap: terminal.collapsedAtCap,
  };
}

/**
 * §5 follow-up check: a pure function over the ledger rows bound to one stage
 * (`boundTaskIds`), the admitted manifest, and the live lineage status of the
 * bound tasks. Status is read through `taskStatusOf` on every call — never
 * cached in the ledger.
 *
 * Mandatory refusal rule: any future privileged task-creation path that
 * stamps a stage binding MUST run this check and MUST refuse while `state`
 * is `prior_binding_open`. Everything else here is operator-visible counting.
 */
export function wavePlanDagStageFollowUpCheckV1(args: {
  admission: WavePlanDagManifestAdmissionV2;
  manifestDigest: string;
  stageId: string;
  boundTaskIds: readonly string[];
  taskStatusOf: WavePlanDagV2TaskStatusReader;
}): WavePlanDagStageFollowUpCheckV1 {
  const { admission, manifestDigest, stageId, boundTaskIds, taskStatusOf } = args;
  const unknownTarget =
    !admission.ok
    || admission.manifest.manifestDigest !== manifestDigest
    || !admission.graph.stagesById.has(stageId);
  if (unknownTarget) {
    return followUpRecord(manifestDigest, stageId, "unknown_binding_target", 0, 0);
  }
  if (boundTaskIds.length === 0) {
    return followUpRecord(manifestDigest, stageId, "no_prior_binding", 0, 0);
  }

  let openCount = 0;
  let terminalCount = 0;
  for (const taskId of boundTaskIds) {
    const status = taskStatusOf(taskId);
    if (status === null || (!OPEN_STATUS_SET.has(status) && !TERMINAL_STATUS_SET.has(status))) {
      // §5: a status that cannot be resolved makes the whole check refuse —
      // no optimistic interpretation of the unresolved rows.
      return followUpRecord(manifestDigest, stageId, "lineage_unavailable", openCount, terminalCount);
    }
    if (OPEN_STATUS_SET.has(status)) openCount += 1;
    else terminalCount += 1;
  }
  return followUpRecord(
    manifestDigest,
    stageId,
    openCount > 0 ? "prior_binding_open" : "prior_binding_terminal",
    openCount,
    terminalCount,
  );
}

// ---------------------------------------------------------------------------
// §6 — frontier projection (stale guard)
// ---------------------------------------------------------------------------

/** §6 closed per-bound-task frontier states. */
export type WavePlanDagStageFrontierStateV1 =
  | "aligned_open"
  | "aligned_terminal"
  | "divergence_task_terminal_receipt_open"
  | "divergence_receipt_terminal_task_open"
  | "bound_task_missing";

/** §6 receipt basis for the projection as a whole (the manifest-level codes). */
export type WavePlanDagStageFrontierReceiptBasisV1 =
  | "receipt_current"
  | "receipt_stale"
  | "receipt_missing";

export interface WavePlanDagStageFrontierBoundTaskV1 {
  taskId: string;
  frontierState: WavePlanDagStageFrontierStateV1;
}

export interface WavePlanDagStageFrontierStageV1 {
  stageId: string;
  boundTasks: WavePlanDagStageFrontierBoundTaskV1[];
}

interface WavePlanDagStageFrontierCountFields {
  boundStageCount: number;
  boundStageCountCollapsedAtCap: boolean;
  boundTaskCount: number;
  boundTaskCountCollapsedAtCap: boolean;
  alignedOpenCount: number;
  alignedOpenCountCollapsedAtCap: boolean;
  alignedTerminalCount: number;
  alignedTerminalCountCollapsedAtCap: boolean;
  divergenceTaskTerminalReceiptOpenCount: number;
  divergenceTaskTerminalReceiptOpenCountCollapsedAtCap: boolean;
  divergenceReceiptTerminalTaskOpenCount: number;
  divergenceReceiptTerminalTaskOpenCountCollapsedAtCap: boolean;
  boundTaskMissingCount: number;
  boundTaskMissingCountCollapsedAtCap: boolean;
  unboundLeafCount: number;
  unboundLeafCountCollapsedAtCap: boolean;
}

/**
 * §6 operator projection (the named `WavePlanDagStageFrontierProjectionV1`):
 * adds the bound task ids already present in the ledger, stage ids, and the
 * receipt digest. Bounded: fixed clamps with reached flags so a malformed or
 * oversized input cannot inflate the surface.
 */
export type WavePlanDagStageFrontierProjectionV1 = {
  kind: typeof WAVE_PLAN_DAG_V2_STAGE_FRONTIER_PROJECTION_KIND;
  version: 1;
  manifestDigest: string;
  receiptBasis: WavePlanDagStageFrontierReceiptBasisV1;
  /** Latest receipt digest — present only when the basis is `receipt_current`. */
  receiptDigest?: string;
  /** Per-stage rows — populated only when the basis is `receipt_current`. */
  stageFrontiers: WavePlanDagStageFrontierStageV1[];
  /** Unbound subtree leaves (operator identifiers), sorted, capped. */
  unboundLeafTaskIds: string[];
} & WavePlanDagStageFrontierCountFields;

/**
 * §6 public projection: closed enums and clamped counts only — no task ids,
 * no digests, no free text (slice-2 surface split).
 */
export type WavePlanDagStageFrontierPublicV1 = {
  kind: typeof WAVE_PLAN_DAG_V2_STAGE_FRONTIER_PUBLIC_KIND;
  version: 1;
  receiptBasis: WavePlanDagStageFrontierReceiptBasisV1;
} & WavePlanDagStageFrontierCountFields;

/** Visible leaf task ids within one bound task's subtree (`null`: unresolvable). */
export type WavePlanDagV2SubtreeLeafReader = (taskId: string) => string[] | null;

function zeroedCountFields(): WavePlanDagStageFrontierCountFields {
  return {
    boundStageCount: 0,
    boundStageCountCollapsedAtCap: false,
    boundTaskCount: 0,
    boundTaskCountCollapsedAtCap: false,
    alignedOpenCount: 0,
    alignedOpenCountCollapsedAtCap: false,
    alignedTerminalCount: 0,
    alignedTerminalCountCollapsedAtCap: false,
    divergenceTaskTerminalReceiptOpenCount: 0,
    divergenceTaskTerminalReceiptOpenCountCollapsedAtCap: false,
    divergenceReceiptTerminalTaskOpenCount: 0,
    divergenceReceiptTerminalTaskOpenCountCollapsedAtCap: false,
    boundTaskMissingCount: 0,
    boundTaskMissingCountCollapsedAtCap: false,
    unboundLeafCount: 0,
    unboundLeafCountCollapsedAtCap: false,
  };
}

function applyClamps(fields: WavePlanDagStageFrontierCountFields): WavePlanDagStageFrontierCountFields {
  const clamp = (raw: number) => {
    const bounded = clampCount(raw);
    return { count: bounded.count, flag: bounded.collapsedAtCap };
  };
  return {
    boundStageCount: clamp(fields.boundStageCount).count,
    boundStageCountCollapsedAtCap: clamp(fields.boundStageCount).flag,
    boundTaskCount: clamp(fields.boundTaskCount).count,
    boundTaskCountCollapsedAtCap: clamp(fields.boundTaskCount).flag,
    alignedOpenCount: clamp(fields.alignedOpenCount).count,
    alignedOpenCountCollapsedAtCap: clamp(fields.alignedOpenCount).flag,
    alignedTerminalCount: clamp(fields.alignedTerminalCount).count,
    alignedTerminalCountCollapsedAtCap: clamp(fields.alignedTerminalCount).flag,
    divergenceTaskTerminalReceiptOpenCount: clamp(fields.divergenceTaskTerminalReceiptOpenCount).count,
    divergenceTaskTerminalReceiptOpenCountCollapsedAtCap: clamp(fields.divergenceTaskTerminalReceiptOpenCount).flag,
    divergenceReceiptTerminalTaskOpenCount: clamp(fields.divergenceReceiptTerminalTaskOpenCount).count,
    divergenceReceiptTerminalTaskOpenCountCollapsedAtCap: clamp(fields.divergenceReceiptTerminalTaskOpenCount).flag,
    boundTaskMissingCount: clamp(fields.boundTaskMissingCount).count,
    boundTaskMissingCountCollapsedAtCap: clamp(fields.boundTaskMissingCount).flag,
    unboundLeafCount: clamp(fields.unboundLeafCount).count,
    unboundLeafCountCollapsedAtCap: clamp(fields.unboundLeafCount).flag,
  };
}

function isBindingEntry(entry: WavePlanDagV2StoredEntry): entry is Extract<WavePlanDagV2StoredEntry, { entryType: "stage_task_binding_recorded" }> {
  return entry.entryType === "stage_task_binding_recorded";
}

/**
 * §6 frontier projection: compares the plan's view of progress (receipt
 * stage states) with task-graph reality (bound tasks and their subtree
 * leaves) and reports divergences for operator attention only — no mutation,
 * no effect on dispatch.
 *
 * Evidence selection is not optional (§6 `receipt_stale`): the projection
 * refuses unless the presented receipt IS the manifest's latest recorded
 * rehearsal, the receipt belongs to this manifest, and it covers every bound
 * stage (the manifest's own rehearsal receipt always does, per the frozen
 * receipt contract). `receipt_missing` (admitted-unrehearsed) makes no
 * frontier claims at all; ledger counts stay visible in both refusal bases.
 */
export function wavePlanDagStageFrontierProjectionV1(args: {
  manifestDigest: string;
  /** Binding ledger rows for this manifest (arrival order preserved). */
  bindings: readonly WavePlanDagV2StoredEntry[];
  /** The receipt the projection is requested against (typed dry-run output). */
  presentedReceipt: WavePlanDagDryRunReceiptV2 | null;
  /** Receipt digest of the manifest's latest recorded rehearsal, if any. */
  latestReceiptDigest: string | null;
  taskStatusOf: WavePlanDagV2TaskStatusReader;
  subtreeLeafTaskIds: WavePlanDagV2SubtreeLeafReader;
}): { operator: WavePlanDagStageFrontierProjectionV1; public: WavePlanDagStageFrontierPublicV1 } {
  const { manifestDigest, bindings, presentedReceipt, latestReceiptDigest, taskStatusOf, subtreeLeafTaskIds } = args;

  const bindingRows = bindings.filter(isBindingEntry);
  const stageGroups = new Map<string, string[]>();
  const boundTaskIds = new Set<string>();
  for (const row of bindingRows) {
    if (!boundTaskIds.has(row.taskId)) boundTaskIds.add(row.taskId);
    const group = stageGroups.get(row.stageId);
    if (group) group.push(row.taskId);
    else stageGroups.set(row.stageId, [row.taskId]);
  }

  const refuse = (basis: Extract<WavePlanDagStageFrontierReceiptBasisV1, "receipt_stale" | "receipt_missing">) => {
    const operator: WavePlanDagStageFrontierProjectionV1 = {
      kind: WAVE_PLAN_DAG_V2_STAGE_FRONTIER_PROJECTION_KIND,
      version: 1,
      manifestDigest,
      receiptBasis: basis,
      stageFrontiers: [],
      unboundLeafTaskIds: [],
      ...applyClamps({ ...zeroedCountFields(), boundStageCount: stageGroups.size, boundTaskCount: boundTaskIds.size }),
    };
    const pub: WavePlanDagStageFrontierPublicV1 = {
      kind: WAVE_PLAN_DAG_V2_STAGE_FRONTIER_PUBLIC_KIND,
      version: 1,
      receiptBasis: basis,
      boundStageCount: operator.boundStageCount,
      boundStageCountCollapsedAtCap: operator.boundStageCountCollapsedAtCap,
      boundTaskCount: operator.boundTaskCount,
      boundTaskCountCollapsedAtCap: operator.boundTaskCountCollapsedAtCap,
      alignedOpenCount: 0,
      alignedOpenCountCollapsedAtCap: false,
      alignedTerminalCount: 0,
      alignedTerminalCountCollapsedAtCap: false,
      divergenceTaskTerminalReceiptOpenCount: 0,
      divergenceTaskTerminalReceiptOpenCountCollapsedAtCap: false,
      divergenceReceiptTerminalTaskOpenCount: 0,
      divergenceReceiptTerminalTaskOpenCountCollapsedAtCap: false,
      boundTaskMissingCount: 0,
      boundTaskMissingCountCollapsedAtCap: false,
      unboundLeafCount: 0,
      unboundLeafCountCollapsedAtCap: false,
    };
    return { operator, public: pub };
  };

  // §6: admitted-unrehearsed manifests make no frontier claims.
  if (latestReceiptDigest === null || presentedReceipt === null) {
    return refuse(latestReceiptDigest === null ? "receipt_missing" : "receipt_stale");
  }
  // Fail-closed pairing: the presented receipt must be this manifest's own
  // latest rehearsal. The frozen receipt contract guarantees full stage
  // coverage, so a receipt missing a bound stage cannot be the right one.
  const coversAllBoundStages = [...stageGroups.keys()].every((stageId) =>
    presentedReceipt.stages.some((signal) => signal.stageId === stageId));
  if (
    presentedReceipt.receiptDigest !== latestReceiptDigest
    || presentedReceipt.manifestDigest !== manifestDigest
    || !coversAllBoundStages
  ) {
    return refuse("receipt_stale");
  }

  const signalByStage = new Map(presentedReceipt.stages.map((signal) => [signal.stageId, signal]));
  const raw = zeroedCountFields();
  raw.boundStageCount = stageGroups.size;
  raw.boundTaskCount = boundTaskIds.size;

  const unboundLeaves = new Set<string>();
  const stageFrontiers: WavePlanDagStageFrontierStageV1[] = [];
  const stageIds = [...stageGroups.keys()].sort(compareAscii);
  for (const stageId of stageIds) {
    const boundTasks: WavePlanDagStageFrontierBoundTaskV1[] = [];
    const signal = signalByStage.get(stageId);
    const receiptTerminal = signal?.state === "terminal";
    const receiptReason = signal?.reason;
    for (const taskId of stageGroups.get(stageId) ?? []) {
      const status = taskStatusOf(taskId);
      if (status === null || (!OPEN_STATUS_SET.has(status) && !TERMINAL_STATUS_SET.has(status))) {
        boundTasks.push({ taskId, frontierState: "bound_task_missing" });
        raw.boundTaskMissingCount += 1;
        continue;
      }
      let frontierState: WavePlanDagStageFrontierStateV1;
      if (OPEN_STATUS_SET.has(status)) {
        if (receiptTerminal) {
          frontierState = "divergence_receipt_terminal_task_open";
          raw.divergenceReceiptTerminalTaskOpenCount += 1;
        } else {
          frontierState = "aligned_open";
          raw.alignedOpenCount += 1;
        }
      } else {
        // §6 aligned_terminal outcome classes: succeeded expects gate_passed,
        // failed expects gate_failed, canceled accepts any terminal state.
        const expectedClass =
          status === "succeeded" ? "gate_passed"
          : status === "failed" ? "gate_failed"
          : null;
        if (receiptTerminal && (expectedClass === null || receiptReason === expectedClass)) {
          frontierState = "aligned_terminal";
          raw.alignedTerminalCount += 1;
        } else {
          frontierState = "divergence_task_terminal_receipt_open";
          raw.divergenceTaskTerminalReceiptOpenCount += 1;
        }
      }
      boundTasks.push({ taskId, frontierState });
      // §6 leaf_unbound: visible leaves beyond the plan's coverage. Counted
      // here; identifiers surface only on the operator projection.
      const leaves = subtreeLeafTaskIds(taskId);
      for (const leafId of leaves ?? []) {
        if (!boundTaskIds.has(leafId)) unboundLeaves.add(leafId);
      }
    }
    stageFrontiers.push({ stageId, boundTasks });
  }

  const sortedUnboundLeaves = [...unboundLeaves].sort(compareAscii);
  raw.unboundLeafCount = sortedUnboundLeaves.length;
  const counts = applyClamps(raw);
  const operator: WavePlanDagStageFrontierProjectionV1 = {
    kind: WAVE_PLAN_DAG_V2_STAGE_FRONTIER_PROJECTION_KIND,
    version: 1,
    manifestDigest,
    receiptBasis: "receipt_current",
    receiptDigest: presentedReceipt.receiptDigest,
    stageFrontiers,
    unboundLeafTaskIds: sortedUnboundLeaves.slice(0, WAVE_PLAN_DAG_V2_BINDING_COUNT_CAP),
    ...counts,
  };
  const pub: WavePlanDagStageFrontierPublicV1 = {
    kind: WAVE_PLAN_DAG_V2_STAGE_FRONTIER_PUBLIC_KIND,
    version: 1,
    receiptBasis: "receipt_current",
    boundStageCount: counts.boundStageCount,
    boundStageCountCollapsedAtCap: counts.boundStageCountCollapsedAtCap,
    boundTaskCount: counts.boundTaskCount,
    boundTaskCountCollapsedAtCap: counts.boundTaskCountCollapsedAtCap,
    alignedOpenCount: counts.alignedOpenCount,
    alignedOpenCountCollapsedAtCap: counts.alignedOpenCountCollapsedAtCap,
    alignedTerminalCount: counts.alignedTerminalCount,
    alignedTerminalCountCollapsedAtCap: counts.alignedTerminalCountCollapsedAtCap,
    divergenceTaskTerminalReceiptOpenCount: counts.divergenceTaskTerminalReceiptOpenCount,
    divergenceTaskTerminalReceiptOpenCountCollapsedAtCap: counts.divergenceTaskTerminalReceiptOpenCountCollapsedAtCap,
    divergenceReceiptTerminalTaskOpenCount: counts.divergenceReceiptTerminalTaskOpenCount,
    divergenceReceiptTerminalTaskOpenCountCollapsedAtCap: counts.divergenceReceiptTerminalTaskOpenCountCollapsedAtCap,
    boundTaskMissingCount: counts.boundTaskMissingCount,
    boundTaskMissingCountCollapsedAtCap: counts.boundTaskMissingCountCollapsedAtCap,
    unboundLeafCount: counts.unboundLeafCount,
    unboundLeafCountCollapsedAtCap: counts.unboundLeafCountCollapsedAtCap,
  };
  return { operator, public: pub };
}

// ---------------------------------------------------------------------------
// §4.2 — binding write-path preconditions (pure planner)
// ---------------------------------------------------------------------------

/** Closed §4.1 binding request. An extra or missing field is malformed. */
export interface WavePlanDagV2StageBindingRequestV1 {
  manifestDigest: string;
  stageId: string;
  taskId: string;
  bindingSource: WavePlanDagV2StageBindingSource;
}

function parseBindingRequest(input: unknown): WavePlanDagV2StageBindingRequestV1 | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const candidate = input as Record<string, unknown>;
  const keys = Object.keys(candidate).sort(compareAscii);
  if (JSON.stringify(keys) !== JSON.stringify(["bindingSource", "manifestDigest", "stageId", "taskId"])) {
    return null;
  }
  const { manifestDigest, stageId, taskId, bindingSource } = candidate;
  if (typeof manifestDigest !== "string" || !DIGEST_PATTERN.test(manifestDigest)) return null;
  if (typeof stageId !== "string" || !STAGE_ID_PATTERN.test(stageId)) return null;
  if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) return null;
  if (
    typeof bindingSource !== "string"
    || !WAVE_PLAN_DAG_V2_STAGE_BINDING_SOURCES.includes(bindingSource as WavePlanDagV2StageBindingSource)
  ) {
    return null;
  }
  return {
    manifestDigest,
    stageId,
    taskId,
    bindingSource: bindingSource as WavePlanDagV2StageBindingSource,
  };
}

/**
 * Rejection reasons for the full write path: the §4.2/§4.3 preconditions plus
 * the inherited store vocabulary the single append can still surface (e.g.
 * `duplicate_conflict` for a same-triple/different-source rewrite).
 */
export type WavePlanDagV2StageBindingWriteRejectionReason =
  | WavePlanDagV2StageBindingRejectionReason
  | WavePlanDagV2StoreRejectionReason;

export type WavePlanDagV2StageBindingPlan =
  | {
      ok: true;
      entry: Extract<WavePlanDagV2StoredEntry, { entryType: "stage_task_binding_recorded" }>;
      followUp: WavePlanDagStageFollowUpCheckV1;
    }
  | { ok: false; reason: WavePlanDagV2StageBindingRejectionReason; message: string };

/** Result of the broker's single explicit binding write entry (§7). */
export type WavePlanDagV2StageBindingWriteResult =
  | {
      ok: true;
      entry: Extract<WavePlanDagV2StoredEntry, { entryType: "stage_task_binding_recorded" }>;
      followUp: WavePlanDagStageFollowUpCheckV1;
      /** True when this call was an identical redelivery (counted no-op). */
      duplicated: boolean;
    }
  | { ok: false; reason: WavePlanDagV2StageBindingWriteRejectionReason; message: string };

/**
 * §4.2 write-path preconditions, in contract order:
 *
 * 1. The freshly re-run admission must succeed, yield the requested
 *    `manifestDigest`, and the ledger must already hold a `manifest_admitted`
 *    entry for it — otherwise `manifest_not_known`.
 * 2. `stageId` membership in the freshly admitted manifest — otherwise
 *    `unknown_stage` (the stage list is never persisted).
 * 3. `taskId` resolution against the live task read source — unresolvable is
 *    `task_unknown`, terminal is `task_not_open`; only open tasks bind.
 * 4. The §5 follow-up check runs first and refuses while it returns
 *    `prior_binding_open` (`duplicate_open_binding`). A binding over
 *    `prior_binding_terminal` is an explicit re-work act and stays counted
 *    and operator-visible.
 */
export function planWavePlanDagV2StageBinding(args: {
  request: unknown;
  admission: WavePlanDagManifestAdmissionV2;
  manifestAdmittedOnLedger: boolean;
  boundTaskIds: readonly string[];
  taskStatusOf: WavePlanDagV2TaskStatusReader;
}): WavePlanDagV2StageBindingPlan {
  const request = parseBindingRequest(args.request);
  if (request === null) {
    return { ok: false, reason: "entry_malformed", message: "binding request is not a closed §4.1 record" };
  }

  // Step 1 — fresh admission, digest equality, and ledger admission.
  if (
    !args.admission.ok
    || args.admission.manifest.manifestDigest !== request.manifestDigest
    || !args.manifestAdmittedOnLedger
  ) {
    return { ok: false, reason: "manifest_not_known", message: `no admitted manifest ${request.manifestDigest} precedes this binding` };
  }

  // Step 2 — stage membership in the freshly admitted manifest.
  if (!args.admission.graph.stagesById.has(request.stageId)) {
    return { ok: false, reason: "unknown_stage", message: `stage ${request.stageId} is not a member of the admitted manifest` };
  }

  // Step 3 — task resolution and open-status gate.
  const status = args.taskStatusOf(request.taskId);
  if (status === null || (!OPEN_STATUS_SET.has(status) && !TERMINAL_STATUS_SET.has(status))) {
    return { ok: false, reason: "task_unknown", message: `task ${request.taskId} does not resolve in the task read source` };
  }
  if (!OPEN_STATUS_SET.has(status)) {
    return { ok: false, reason: "task_not_open", message: `task ${request.taskId} is terminal (${status}); only open tasks may bind` };
  }

  // Step 4 — the §5 mandatory refusal gate.
  const followUp = wavePlanDagStageFollowUpCheckV1({
    admission: args.admission,
    manifestDigest: request.manifestDigest,
    stageId: request.stageId,
    boundTaskIds: args.boundTaskIds,
    taskStatusOf: args.taskStatusOf,
  });
  if (followUp.state === "prior_binding_open") {
    return { ok: false, reason: "duplicate_open_binding", message: `stage ${request.stageId} already has an open bound task` };
  }

  return {
    ok: true,
    entry: wavePlanDagV2StageBindingEntry({
      manifestDigest: request.manifestDigest,
      stageId: request.stageId,
      taskId: request.taskId,
      bindingSource: request.bindingSource,
    }),
    followUp,
  };
}
