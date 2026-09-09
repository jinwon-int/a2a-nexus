/**
 * Incremental broker-side task-lineage index (#2078 C3).
 *
 * `buildTaskLineageReadProjection` rebuilds an O(tasks) index for every
 * lineage read. This module maintains the same structures incrementally as
 * task records are written (`Broker.setTaskRecord`), so lineage endpoints stop
 * paying the per-request rebuild plus the full `listTasks` read.
 *
 * Invariants — this index holds exactly the same structures
 * (`TaskLineageReadIndexV1`) the pure per-snapshot builder produces, so one
 * view function (`projectionFromTaskLineageReadIndex`) serves both:
 *
 * - Task records are never removed. Retention only prunes the live map; the
 *   repository overlay still returns pruned rows on canonical reads, so the
 *   lineage universe must keep them too. `compact()` shrinks a pruned entry's
 *   record reference to its projection-relevant fields (pruned tasks are
 *   terminal, so their projected fields are frozen).
 * - Canonical-parent and reference edges are add-only: `parentTaskId`,
 *   `parentRoundId`, and `referenceTaskIds` are fixed at task creation. A
 *   replacement record whose structural fields changed marks the index dirty;
 *   the broker then rebuilds it from its canonical snapshot.
 * - Cycle detection happens at edge-materialization time: adding a canonical
 *   edge walks the parent chain once (with a cycle-reachable shortcut), marks
 *   the new cycle's members, and marks their canonical descendants, matching
 *   the pure builder's whole-component resolution.
 * - Anomaly counters transition incrementally (parents/references arriving
 *   late decrement `parent_missing`/`reference_unavailable`), so aggregate
 *   diagnostics stay identical to a from-scratch build over the same set.
 */

import {
  compareIndexedTask,
  indexedTaskFromRecord,
  projectionFromTaskLineageReadIndex,
  TASK_LINEAGE_MAX_REFERENCE_IDS_PER_NODE,
  type IndexedTask,
  type TaskLineageAnomalyCodeV1,
  type TaskLineageEdgeTypeV1,
  type TaskLineageReadIndexV1,
  type TaskLineageReadProjectionV1,
} from "./task-lineage-read.js";
import type { TaskRecord } from "./types.js";

/** Retention keeps the row but drops the payload — so does this projection. */
function slimLineageTaskRecord(record: TaskRecord): TaskRecord {
  return {
    ...record,
    payload: {},
    message: "",
    result: undefined,
    error: undefined,
    errorHistory: undefined,
    artifactIds: undefined,
  };
}

/**
 * Duplicate raw occurrences shift the `duplicate_edge` anomaly count even when
 * the deduped reference list is unchanged, so replacements that change the raw
 * array rebuild the index rather than silently keeping stale counts.
 */
function rawReferencesDiffer(
  left: unknown,
  right: unknown,
): boolean {
  const leftRaw = Array.isArray(left) ? left : [];
  const rightRaw = Array.isArray(right) ? right : [];
  return (
    leftRaw.length !== rightRaw.length
    || leftRaw.some((reference, index) => reference !== rightRaw[index])
  );
}

function insertSorted(sorted: IndexedTask[], entry: IndexedTask): void {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareIndexedTask(sorted[mid]!, entry) < 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  sorted.splice(low, 0, entry);
}

interface IndexedEntry extends IndexedTask {
  /** Valid deduped references whose target record is not indexed yet. */
  absentReferenceCount: number;
  /** Raw `referenceTaskIds` entries (duplicates included) whose target is indexed. */
  presentRawReferenceCount: number;
  parentMissing: boolean;
  referenceOutputTruncated: boolean;
}

export class TaskLineageIndex {
  readonly #byId = new Map<string, IndexedEntry>();
  readonly #childEdgesByTask = new Map<
    string,
    Map<string, Set<TaskLineageEdgeTypeV1>>
  >();
  readonly #roundChildren = new Map<string, IndexedEntry[]>();
  readonly #tasksWithVisibleChildren = new Set<string>();
  readonly #canonicalCycleReachable = new Set<string>();
  readonly #anomalies = new Map<TaskLineageAnomalyCodeV1, number>();

  /** Records waiting for their canonical parent to be indexed. */
  readonly #pendingChildrenByParent = new Map<string, Set<string>>();
  /** Raw reference occurrence counts waiting for their target record. */
  readonly #pendingRawReferenceCounts = new Map<string, Map<string, number>>();
  readonly #rejectedRecordIds = new Set<string>();
  readonly #compactedRecordIds = new Set<string>();
  readonly #sorted: IndexedEntry[] = [];
  #dirty = false;

  get dirty(): boolean {
    return this.#dirty;
  }

  has(taskId: string): boolean {
    return this.#byId.has(taskId) || this.#rejectedRecordIds.has(taskId);
  }

  /** Live index structures for `projectionFromTaskLineageReadIndex`. */
  snapshot(): TaskLineageReadIndexV1 {
    return {
      byId: this.#byId,
      childEdgesByTask: this.#childEdgesByTask,
      roundChildren: this.#roundChildren,
      tasksWithVisibleChildren: this.#tasksWithVisibleChildren,
      canonicalCycleReachable: this.#canonicalCycleReachable,
      anomalies: this.#anomalies,
    };
  }

  projection(): TaskLineageReadProjectionV1 {
    return projectionFromTaskLineageReadIndex(this.snapshot());
  }

  /**
   * Drop the retained full record of a retention-pruned task. Pruned tasks are
   * terminal, so every projected field is frozen; the entry stays because the
   * repository overlay still serves the row on canonical reads.
   */
  compact(recordId: string): void {
    const entry = this.#byId.get(recordId);
    if (!entry || this.#compactedRecordIds.has(recordId)) return;
    this.#compactedRecordIds.add(recordId);
    entry.task = slimLineageTaskRecord(entry.task);
  }

  upsert(record: TaskRecord): void {
    const existing = this.#byId.get(record.id);
    if (existing) {
      this.#reindexExisting(existing, record);
      return;
    }
    const parseAnomalies = new Map<TaskLineageAnomalyCodeV1, number>();
    const indexed = indexedTaskFromRecord(record, parseAnomalies);
    if (!indexed) {
      if (!this.#rejectedRecordIds.has(record.id)) {
        this.#rejectedRecordIds.add(record.id);
        this.#addAnomalies(parseAnomalies);
      }
      return;
    }
    this.#rejectedRecordIds.delete(record.id);
    this.#addAnomalies(parseAnomalies);
    this.#insert(indexed as IndexedEntry);
  }

  // ---------------------------------------------------------------- insert

  #insert(indexed: IndexedEntry): void {
    indexed.absentReferenceCount = 0;
    indexed.presentRawReferenceCount = 0;
    indexed.parentMissing = false;
    indexed.referenceOutputTruncated = false;

    this.#byId.set(indexed.taskId, indexed);
    insertSorted(this.#sorted, indexed);

    if (indexed.parentRoundId) {
      const stamped = this.#roundChildren.get(indexed.parentRoundId);
      if (stamped) stamped.push(indexed);
      else this.#roundChildren.set(indexed.parentRoundId, [indexed]);
    }

    if (indexed.parentRecorded) {
      if (indexed.parentTaskId && this.#byId.has(indexed.parentTaskId)) {
        this.#materializeCanonicalEdge(indexed.parentTaskId, indexed);
      } else if (indexed.parentTaskId) {
        let pending = this.#pendingChildrenByParent.get(indexed.parentTaskId);
        if (!pending) {
          pending = new Set();
          this.#pendingChildrenByParent.set(indexed.parentTaskId, pending);
        }
        pending.add(indexed.taskId);
        indexed.parentMissing = true;
        this.#bumpAnomaly("task_lineage.parent_missing", 1);
      } else {
        // Parent recorded with an unusable identifier: permanently missing.
        this.#bumpAnomaly("task_lineage.parent_missing", 1);
      }
    }

    // Raw (duplicate-inclusive) reference occurrence counts per target id.
    // The pure builder counts raw entries whose target is indexed — including
    // duplicates — so transitions must add whole occurrence counts, not one
    // per deduped reference.
    const rawReferenceCounts = new Map<string, number>();
    const rawReferences = Array.isArray(indexed.task.referenceTaskIds)
      ? indexed.task.referenceTaskIds
      : [];
    for (const reference of rawReferences) {
      rawReferenceCounts.set(
        reference,
        (rawReferenceCounts.get(reference) ?? 0) + 1,
      );
    }
    for (const reference of indexed.referenceTaskIds) {
      if (this.#byId.has(reference)) {
        this.#materializeReferenceEdge(reference, indexed);
        if (reference === indexed.parentTaskId) {
          this.#bumpAnomaly("task_lineage.duplicate_edge", 1);
        }
      } else {
        const rawOccurrences = rawReferenceCounts.get(reference) ?? 1;
        let waiters = this.#pendingRawReferenceCounts.get(reference);
        if (!waiters) {
          waiters = new Map();
          this.#pendingRawReferenceCounts.set(reference, waiters);
        }
        waiters.set(
          indexed.taskId,
          (waiters.get(indexed.taskId) ?? 0) + rawOccurrences,
        );
        indexed.absentReferenceCount += 1;
      }
    }
    if (indexed.absentReferenceCount > 0) {
      this.#bumpAnomaly(
        "task_lineage.reference_unavailable",
        indexed.absentReferenceCount,
      );
    }
    if (indexed.invalidReferenceCount > 0) {
      this.#bumpAnomaly(
        "task_lineage.reference_unavailable",
        indexed.invalidReferenceCount,
      );
    }
    for (const [reference, rawCount] of rawReferenceCounts) {
      if (this.#byId.has(reference)) indexed.presentRawReferenceCount += rawCount;
    }
    if (indexed.presentRawReferenceCount > TASK_LINEAGE_MAX_REFERENCE_IDS_PER_NODE) {
      indexed.referenceOutputTruncated = true;
      this.#bumpAnomaly("task_lineage.reference_output_truncated", 1);
    }

    // Materialize edges for records that were waiting on this one.
    this.#resolveParentWaiters(indexed);
    this.#resolveReferenceWaiters(indexed);
  }

  #resolveParentWaiters(parent: IndexedEntry): void {
    const waiting = this.#pendingChildrenByParent.get(parent.taskId);
    if (!waiting) return;
    this.#pendingChildrenByParent.delete(parent.taskId);
    for (const childId of waiting) {
      const child = this.#byId.get(childId);
      if (!child || !child.parentMissing) continue;
      child.parentMissing = false;
      this.#bumpAnomaly("task_lineage.parent_missing", -1);
      this.#materializeCanonicalEdge(parent.taskId, child);
    }
  }

  #resolveReferenceWaiters(reference: IndexedEntry): void {
    const waiting = this.#pendingRawReferenceCounts.get(reference.taskId);
    if (!waiting) return;
    this.#pendingRawReferenceCounts.delete(reference.taskId);
    for (const [taskId, rawOccurrences] of waiting) {
      const dependent = this.#byId.get(taskId);
      if (!dependent) continue;
      dependent.absentReferenceCount -= 1;
      this.#bumpAnomaly("task_lineage.reference_unavailable", -1);
      dependent.presentRawReferenceCount += rawOccurrences;
      if (
        !dependent.referenceOutputTruncated
        && dependent.presentRawReferenceCount
          > TASK_LINEAGE_MAX_REFERENCE_IDS_PER_NODE
      ) {
        dependent.referenceOutputTruncated = true;
        this.#bumpAnomaly("task_lineage.reference_output_truncated", 1);
      }
      this.#materializeReferenceEdge(reference.taskId, dependent);
      if (reference.taskId === dependent.parentTaskId) {
        this.#bumpAnomaly("task_lineage.duplicate_edge", 1);
      }
    }
  }

  // ------------------------------------------------------------------ edges

  #addChildEdge(
    anchorTaskId: string,
    child: IndexedEntry,
    edge: TaskLineageEdgeTypeV1,
  ): void {
    let children = this.#childEdgesByTask.get(anchorTaskId);
    if (!children) {
      children = new Map();
      this.#childEdgesByTask.set(anchorTaskId, children);
    }
    let edges = children.get(child.taskId);
    if (!edges) {
      edges = new Set();
      children.set(child.taskId, edges);
    }
    edges.add(edge);
    this.#tasksWithVisibleChildren.add(anchorTaskId);
  }

  #materializeCanonicalEdge(
    parentId: string,
    child: IndexedEntry,
  ): void {
    this.#addChildEdge(parentId, child, "canonical_parent");
    this.#detectCycleOnNewCanonicalEdge(child.taskId, parentId);
  }

  #materializeReferenceEdge(
    referenceTaskId: string,
    dependent: IndexedEntry,
  ): void {
    this.#addChildEdge(referenceTaskId, dependent, "reference");
  }

  /**
   * A canonical edge child→parent just appeared. If the parent's ancestry
   * reaches the child, a cycle closed; mark its members and every canonical
   * descendant (ancestry enters the cycle). Tasks already marked reachable
   * short-circuit the walk — their ancestry provably enters a cycle.
   */
  #detectCycleOnNewCanonicalEdge(childId: string, parentId: string): void {
    const chain: string[] = [childId];
    const seen = new Set<string>(chain);
    let current = this.#byId.get(parentId);
    let cycleClosed = false;
    while (current) {
      if (this.#canonicalCycleReachable.has(current.taskId)) {
        // The child's ancestry passes through this task's ancestry, which
        // already enters a cycle — the child is cycle-reachable.
        cycleClosed = true;
        break;
      }
      if (seen.has(current.taskId)) {
        cycleClosed = true;
        break;
      }
      seen.add(current.taskId);
      chain.push(current.taskId);
      current = current.parentTaskId
        ? this.#byId.get(current.parentTaskId)
        : undefined;
    }
    if (!cycleClosed) return;
    for (const taskId of chain) {
      this.#canonicalCycleReachable.add(taskId);
    }
    for (const taskId of chain) {
      this.#markCanonicalDescendantsReachable(taskId);
    }
  }

  #markCanonicalDescendantsReachable(ancestorId: string): void {
    const queue = [ancestorId];
    while (queue.length > 0) {
      const taskId = queue.pop()!;
      for (const [childId, edges] of this.#childEdgesByTask.get(taskId) ?? []) {
        if (!edges.has("canonical_parent")) continue;
        if (this.#canonicalCycleReachable.has(childId)) continue;
        this.#canonicalCycleReachable.add(childId);
        queue.push(childId);
      }
    }
  }

  // ----------------------------------------------------------------- update

  #reindexExisting(existing: IndexedEntry, record: TaskRecord): void {
    const parseAnomalies = new Map<TaskLineageAnomalyCodeV1, number>();
    const next = indexedTaskFromRecord(record, parseAnomalies);
    if (!next) {
      // A previously indexable record turned unparsable: structural change.
      this.#dirty = true;
      return;
    }
    const structureChanged =
      existing.parentRecorded !== next.parentRecorded
      || existing.parentTaskId !== next.parentTaskId
      || existing.parentRoundId !== next.parentRoundId
      || existing.invalidReferenceCount !== next.invalidReferenceCount
      || existing.referenceTaskIds.length !== next.referenceTaskIds.length
      || existing.referenceTaskIds.some(
        (reference, index) => reference !== next.referenceTaskIds[index],
      )
      || rawReferencesDiffer(existing.task.referenceTaskIds, record.referenceTaskIds);
    if (structureChanged) {
      this.#dirty = true;
      return;
    }
    // Same structure: refresh the live record reference and round total.
    this.#compactedRecordIds.delete(existing.taskId);
    existing.task = record;
    existing.parentRoundTotal = next.parentRoundTotal;
  }

  // -------------------------------------------------------------- anomalies

  #bumpAnomaly(
    code: TaskLineageAnomalyCodeV1,
    delta: number,
  ): void {
    if (delta === 0) return;
    const next = (this.#anomalies.get(code) ?? 0) + delta;
    if (next > 0) this.#anomalies.set(code, next);
    else this.#anomalies.delete(code);
  }

  #addAnomalies(values: ReadonlyMap<TaskLineageAnomalyCodeV1, number>): void {
    for (const [code, count] of values) {
      this.#bumpAnomaly(code, count);
    }
  }
}
