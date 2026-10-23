import { createHash } from "node:crypto";

import type { SettledTaskStatus } from "./types.js";
import { isSettledTaskStatus } from "./broker-status-predicates.js";
import { stableStringify } from "./value-guards.js";
import {
  validateTerminalBriefMetadata as canonicalValidateTerminalBriefMetadata,
} from "./terminal-brief-metadata.js";

const MAX_SUMMARY_CHARS = 500;
const MAX_BRIEF_CHARS = 160;
const MAX_REASON_CHARS = 240;
const MAX_TERMINAL_BRIEF_TITLE_CHARS = 240;

export type CrossBrokerTerminalBriefAckDecision = "accepted" | "duplicate_replay" | "rejected";

export type CrossBrokerTerminalBriefRejectCode =
  | "bad_request"
  | "missing_parent"
  | "wrong_origin"
  | "stale_replay"
  | "terminal_ack_forbidden"
  | "missing_dispatch_metadata"
  | "routing_mismatch"
  /**
   * #2339 PR-1c: the parent round is registered here, but neither the child
   * task id nor the origin task id is one of its anchors. This covers a round
   * with no anchors yet (no child dispatched) and a child the parent never
   * handed off. It blocks a payload-only claim on a registered round, such as
   * a future `completedAt` that pre-empts the real child.
   */
  | "missing_anchor";

export interface TerminalBriefDispatchValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Fields needed for Terminal Brief dispatch metadata validation, extracted so
 * both request and normalized-projection shapes can be checked without casts.
 */
export interface TerminalBriefDispatchValidationInput {
  parentRoundId?: string;
  originBrokerId?: string;
  brokerOfRecordId?: string;
  parentRoundTotal?: number;
  parentRoundNum?: number;
  parentRoundOrder?: number;
  roundNum?: number;
}

/**
 * Validate Terminal Brief projection metadata before dispatch.
 * Requires parentRoundId, originBrokerId, parentRoundTotal, and
 * crossBrokerHandoff fields to be present and valid.
 *
 * Delegates to the canonical schema validation from {@link validateTerminalBriefMetadata}
 * (the canonical all-hands lane schema). The local type
 * {@link TerminalBriefDispatchValidationInput} remains for backward compatibility.
 */
export function validateTerminalBriefForDispatch(
  input: TerminalBriefDispatchValidationInput,
  receiverBrokerId?: string,
  options?: { allowLocalOrigin?: boolean },
): TerminalBriefDispatchValidationResult {
  const canonical = canonicalValidateTerminalBriefMetadata(
    input as Record<string, unknown>,
    receiverBrokerId,
    options?.allowLocalOrigin ? { allowLocalOrigin: true } : undefined,
  );
  const errors = canonical.issues
    .filter((i) => i.severity === "error")
    .map((i) => i.message);
  return { valid: errors.length === 0, errors };
}

export type CrossBrokerHandoffBrokerSource = "explicit" | "legacy_origin";

export interface CrossBrokerTerminalBriefProjectionRequest {
  /** Parent round/task id owned by the receiving broker-of-record. */
  parentRoundId: string;
  /**
   * Broker that minted the parent round (contract meaning, see
   * parent-terminal-brief-aggregation.md "Required projection fields").
   * Legacy relays (before #2339 PR-6) put the producing broker here; when
   * `handoffBrokerId` is absent this value is still read as the producer.
   */
  originBrokerId: string;
  /**
   * Broker that produced / relayed the child Terminal Brief (#2339 PR-6).
   * Optional on the wire for compatibility; absent → `originBrokerId` is the
   * producer and the record is marked `handoffBrokerSource: "legacy_origin"`.
   */
  handoffBrokerId?: string;
  /** Receiving broker id the packet was addressed to. Required when the receiver has a broker id. */
  brokerOfRecordId?: string;
  childTaskId?: string;
  /**
   * Parent-side task that handed the child off (`crossBrokerHandoff.originTaskId`),
   * #2339 PR-1c. Either this or `childTaskId` must be an anchor of a registered round.
   */
  originTaskId?: string;
  childRunId?: string;
  /** Worker that produced the child Terminal Brief, when distinct from the handoff broker. */
  childWorkerId?: string;
  /** Backward-compatible alias accepted from compact handoff packets. */
  workerId?: string;
  status: SettledTaskStatus;
  summary?: string;
  taskBrief?: string;
  /** Handoff broker's rendered operator-facing Terminal Brief title. */
  terminalBriefTitle?: string;
  evidenceUrl?: string;
  completedAt: string;
  emittedAt?: string;
  /** Cross-broker projections are not Terminal Brief ACKs; this must be absent/false. */
  terminalAck?: boolean;
  /** Total worker/task count expected for the parent round (denominator). */
  parentRoundTotal?: number | string;
  /** 1-based worker/task order within the parent round (title numerator). */
  parentRoundOrder?: number | string;
  /** Backward-compatible alias for parentRoundOrder used by live Terminal Brief titles. */
  parentRoundNum?: number | string;
  /** Compact alias for parentRoundOrder used by older notifiers. */
  roundNum?: number | string;
}

export interface CrossBrokerTerminalBriefProjection {
  id: string;
  parentRoundId: string;
  originBrokerId: string;
  /**
   * Producing / relaying broker (#2339 PR-6). Always set by the store on
   * ingest and restore; optional in the type only so snapshots written before
   * the split still type-check and load.
   */
  handoffBrokerId?: string;
  /** Whether `handoffBrokerId` came from the packet or was derived from `originBrokerId`. */
  handoffBrokerSource?: CrossBrokerHandoffBrokerSource;
  brokerOfRecordId?: string;
  childTaskId?: string;
  /** Parent-side handoff task (#2339 PR-1c); not part of the content digest. */
  originTaskId?: string;
  childRunId?: string;
  /** Worker that produced the child Terminal Brief, when distinct from the handoff broker. */
  childWorkerId?: string;
  status: SettledTaskStatus;
  summary?: string;
  taskBrief?: string;
  /** Handoff broker's rendered operator-facing Terminal Brief title. */
  terminalBriefTitle?: string;
  evidenceUrl?: string;
  completedAt: string;
  emittedAt: string;
  receivedAt: string;
  sourceDigest: string;
  replayCount: number;
  ack: {
    decision: "accepted" | "duplicate_replay";
    terminalAck: false;
    reason: string;
    updatedAt: string;
  };
  /** Total worker/task count expected for the parent round (denominator). */
  parentRoundTotal?: number;
  /** 1-based worker/task order within the parent round (title numerator). */
  parentRoundOrder?: number;
  /**
   * #2339 PR-3b: set when a different child with a later `completedAt` took
   * this record's `(parentRoundId, handoffBrokerId, parentRoundOrder)` slot,
   * for example a retry child `<round>-t2r2`. The record is kept for audit
   * and excluded from list/get, so it no longer counts toward the aggregate.
   */
  superseded?: {
    /** Record key of the projection that took the slot. */
    by: string;
    at: string;
  };
}

export interface CrossBrokerTerminalBriefProjectionFilters {
  parentRoundId?: string;
  originBrokerId?: string;
  handoffBrokerId?: string;
  /** #2339 PR-3b: include superseded slot records (audit). Default false. */
  includeSuperseded?: boolean;
}

/** Ingest-side counters for operators (#2339 PR-6 rollout observation). */
export interface CrossBrokerTerminalBriefProjectionDiagnostics {
  /** Accepted packets that carried no `handoffBrokerId` (producer read from `originBrokerId`). */
  legacyOriginAsHandoff: number;
  /** Accepted packets that carried an explicit `handoffBrokerId`. */
  explicitHandoffBroker: number;
  /** #2339 PR-1c `parent_resolved_via=registry`: accepted against a registered local-origin round. */
  parentResolvedViaRegistry: number;
  /** #2339 PR-1c `parent_resolved_via=legacy_task`: accepted via the legacy task-id fallback. */
  parentResolvedViaLegacyTask: number;
  /** #2339 PR-1c: rejected as `missing_anchor`. */
  missingAnchor: number;
  /** #2339 PR-3b: slot records superseded by a later different child (e.g. a retry). */
  slotSuperseded: number;
}

/**
 * #2339 PR-1c: what the projection store needs from a registered parent round.
 * Only `local-origin` rounds are resolved here. A `foreign-handoff` entry only
 * names a relay destination, so it never makes this broker the parent.
 */
export interface RegisteredParentRound {
  parentBrokerId: string;
  handoffBrokerId?: string;
  anchors: readonly string[];
}

export type CrossBrokerTerminalBriefProjectionResult =
  | {
      accepted: true;
      replayed: false;
      record: CrossBrokerTerminalBriefProjection;
      ack: CrossBrokerTerminalBriefProjection["ack"];
    }
  | {
      accepted: true;
      replayed: true;
      record: CrossBrokerTerminalBriefProjection;
      ack: CrossBrokerTerminalBriefProjection["ack"];
    }
  | {
      accepted: false;
      replayed: false;
      ack: {
        decision: "rejected";
        terminalAck: false;
        code: CrossBrokerTerminalBriefRejectCode;
        reason: string;
        updatedAt: string;
      };
    };

/**
 * Minimal Terminal Brief parent-round routing info consumed by the projection
 * store to validate that a child projection matches the expected cross-broker
 * handoff topology.
 *
 * Derived from {@link resolveTerminalBriefParentOriginRoute} at the broker
 * level and passed as-is to the store's validation layer.
 */
export interface ParentRoundRoutingInfo {
  /** Broker that initiated the parent round. */
  initiatingBrokerId: string;
  /** Broker that owns the parent round and operator notifications. */
  parentBrokerId: string;
  /** Broker id that sends the human-facing Terminal Brief. */
  operatorFacingTerminalBriefSender: string;
  /** Cross-broker handoff broker, present when child projection is expected. */
  handoffBrokerId?: string;
  /** Broker that cross-broker projections should be addressed to. */
  projectionDestinationBrokerId?: string;
}

export interface CrossBrokerTerminalBriefProjectionStoreOptions {
  brokerId?: string;
  /**
   * #2339 PR-1c: the parent round registry, consulted first. A registered
   * round is judged against its own record: parent broker, handoff broker, and
   * anchors. `hasParentRound` / `parentBrokerOfRecord` / `getParentRoundRouting`
   * remain the legacy fallback for rounds that were never registered.
   */
  resolveRegisteredParentRound?(parentRoundId: string): RegisteredParentRound | undefined;
  hasParentRound(parentRoundId: string): boolean;
  parentBrokerOfRecord?(parentRoundId: string): string | undefined;
  now?(): Date;
  /**
   * Maximum clock skew (ms) tolerated for a projection's `completedAt` /
   * `emittedAt` ahead of this broker's clock. Defaults to 5 minutes. A
   * future-dated `completedAt` would otherwise pre-empt the record key and turn
   * the real, later projection into `stale_replay` (#2331 phase 2a).
   */
  maxFutureSkewMs?: number;
  /**
   * Optional callback that returns Terminal Brief routing info for a parent
   * round. When the parent round has routing metadata (teamScope,
   * initiatingBrokerId) the store validates incoming projections against the
   * expected handoff topology and rejects mismatches.
   */
  getParentRoundRouting?(parentRoundId: string): ParentRoundRoutingInfo | undefined;
}

/**
 * Broker-local storage/protocol guard for cross-broker child Terminal Brief projections.
 *
 * Records are keyed by parent round, producing broker, and the best available
 * child identity. This keeps duplicate packets for the same child idempotent
 * while allowing several brokerbeta-executed children to aggregate under the same
 * brokeralpha-origin parent round without overwriting each other.
 */
export class CrossBrokerTerminalBriefProjectionStore {
  private readonly records = new Map<string, CrossBrokerTerminalBriefProjection>();
  private readonly diagnosticsCounters: CrossBrokerTerminalBriefProjectionDiagnostics = {
    legacyOriginAsHandoff: 0,
    explicitHandoffBroker: 0,
    parentResolvedViaRegistry: 0,
    parentResolvedViaLegacyTask: 0,
    missingAnchor: 0,
    slotSuperseded: 0,
  };

  constructor(
    records: CrossBrokerTerminalBriefProjection[] = [],
    private readonly options: CrossBrokerTerminalBriefProjectionStoreOptions,
  ) {
    for (const record of records) {
      this.records.set(recordKey(record), normalizeRecord(record));
    }
  }

  ingest(request: CrossBrokerTerminalBriefProjectionRequest): CrossBrokerTerminalBriefProjectionResult {
    const nowDate = this.options.now?.() ?? new Date();
    const now = nowDate.toISOString();
    const normalized = normalizeRequest(request);
    if (!normalized) {
      return reject("bad_request", "cross-broker Terminal Brief projection requires parentRoundId, originBrokerId, terminal status, and completedAt", now);
    }
    const futureLimitMs = nowDate.getTime() + resolveMaxFutureSkewMs(this.options.maxFutureSkewMs);
    if (Date.parse(normalized.completedAt) > futureLimitMs) {
      return reject("bad_request", "cross-broker Terminal Brief projection completedAt is in the future beyond the allowed clock skew", now);
    }
    if (normalized.emittedAt && Date.parse(normalized.emittedAt) > futureLimitMs) {
      return reject("bad_request", "cross-broker Terminal Brief projection emittedAt is in the future beyond the allowed clock skew", now);
    }

    // Dispatch metadata preflight: require parentRoundId, originBrokerId,
    // parentRoundTotal, and crossBrokerHandoff fields before storage and enqueue.
    // This closes the gap where a projection would be stored but never dispatchable.
    const preflight = validateTerminalBriefForDispatch(
      {
        parentRoundId: normalized.parentRoundId,
        originBrokerId: normalized.originBrokerId,
        brokerOfRecordId: normalized.brokerOfRecordId,
        parentRoundTotal: normalized.parentRoundTotal,
        parentRoundOrder: normalized.parentRoundOrder,
      },
      normalizeToken(this.options.brokerId),
      // #2339 PR-6: with an explicit producer the minted origin may be this
      // broker (v0 parent == origin); the producer check runs below on
      // handoffBrokerId. Legacy packets keep the origin-must-differ rule.
      { allowLocalOrigin: normalized.handoffBrokerSource === "explicit" },
    );
    if (!preflight.valid) {
      return reject("missing_dispatch_metadata", `Terminal Brief dispatch metadata validation failed: ${preflight.errors.join("; ")}`, now);
    }
    if (request.terminalAck === true) {
      return reject("terminal_ack_forbidden", "cross-broker Terminal Brief projection is aggregate evidence only and cannot ACK a Terminal Brief", now);
    }

    const receiverBrokerId = normalizeToken(this.options.brokerId);
    const addressedBrokerId = normalizeToken(normalized.brokerOfRecordId);
    if (receiverBrokerId && addressedBrokerId && addressedBrokerId !== receiverBrokerId) {
      return reject("wrong_origin", `projection addressed to broker-of-record ${addressedBrokerId}, not ${receiverBrokerId}`, now);
    }
    // #2339 PR-6: the producer (handoff broker) must be a different broker.
    // `originBrokerId` (the minting broker) may legitimately equal the receiver
    // once relays carry the contract meaning (v0 parent == origin).
    if (receiverBrokerId && normalized.handoffBrokerId === receiverBrokerId) {
      return reject("wrong_origin", "cross-broker projection handoff broker must differ from receiving broker", now);
    }
    // #2339 PR-1c: a registered round is judged against the broker's own
    // record of it, never against payload claims. Rounds that were never
    // registered keep the legacy task-id path unchanged.
    const registered = this.options.resolveRegisteredParentRound?.(normalized.parentRoundId);
    let parentResolvedVia: "registry" | "legacy_task";
    if (registered) {
      parentResolvedVia = "registry";
      if (receiverBrokerId && registered.parentBrokerId !== receiverBrokerId) {
        return reject("wrong_origin", `parent round ${normalized.parentRoundId} belongs to parent broker ${registered.parentBrokerId}`, now);
      }
      if (registered.handoffBrokerId && normalized.handoffBrokerId !== registered.handoffBrokerId) {
        return reject("routing_mismatch", `projection handoffBrokerId "${normalized.handoffBrokerId}" does not match the registered handoff broker "${registered.handoffBrokerId}"`, now);
      }
      const anchors = new Set(registered.anchors);
      const anchored = (normalized.childTaskId !== undefined && anchors.has(normalized.childTaskId))
        || (normalized.originTaskId !== undefined && anchors.has(normalized.originTaskId));
      if (!anchored) {
        this.diagnosticsCounters.missingAnchor += 1;
        return reject(
          "missing_anchor",
          anchors.size === 0
            ? `parent round ${normalized.parentRoundId} has no anchors yet; register the handed-off task before its projection`
            : `neither childTaskId nor originTaskId is an anchor of parent round ${normalized.parentRoundId}`,
          now,
        );
      }
    } else {
      parentResolvedVia = "legacy_task";
      if (!this.options.hasParentRound(normalized.parentRoundId)) {
        return reject("missing_parent", `parent round ${normalized.parentRoundId} is not present on this broker`, now);
      }
      const parentBroker = normalizeToken(this.options.parentBrokerOfRecord?.(normalized.parentRoundId));
      if (receiverBrokerId && parentBroker && parentBroker !== receiverBrokerId) {
        return reject("wrong_origin", `parent round ${normalized.parentRoundId} belongs to broker-of-record ${parentBroker}`, now);
      }

      // Routing validation: when the parent round carries Terminal Brief routing
      // metadata (teamScope, initiatingBrokerId), validate the incoming projection
      // against the expected cross-broker handoff topology.
      const routing = this.options.getParentRoundRouting?.(normalized.parentRoundId);
      if (routing) {
        if (routing.handoffBrokerId && normalized.handoffBrokerId !== routing.handoffBrokerId) {
          return reject("routing_mismatch", `projection handoffBrokerId "${normalized.handoffBrokerId}" does not match the parent round's handoff broker "${routing.handoffBrokerId}"`, now);
        }
        const addressedBroker = normalizeToken(normalized.brokerOfRecordId);
        if (addressedBroker && addressedBroker !== routing.parentBrokerId) {
          return reject("routing_mismatch", `projection brokerOfRecordId "${addressedBroker}" does not match parent round's parent broker "${routing.parentBrokerId}"`, now);
        }
      }
    }

    const key = recordKey(normalized);
    const sourceDigest = digestProjection(normalized);
    const existing = this.records.get(key);
    if (existing?.sourceDigest === sourceDigest) {
      const replayed = {
        ...existing,
        replayCount: existing.replayCount + 1,
        ack: {
          decision: "duplicate_replay" as const,
          terminalAck: false as const,
          reason: "duplicate projection replay suppressed by parentRoundId/originBrokerId/sourceDigest",
          updatedAt: now,
        },
      };
      this.records.set(key, replayed);
      return { accepted: true, replayed: true, record: structuredClone(replayed), ack: replayed.ack };
    }
    if (existing && Date.parse(normalized.completedAt) <= Date.parse(existing.completedAt)) {
      return reject("stale_replay", "projection is older than the stored parentRoundId/originBrokerId aggregate", now);
    }

    // #2339 PR-3b: one live projection per (parentRoundId, handoffBrokerId,
    // parentRoundOrder) slot. A different child in an occupied slot, such as a
    // retry child `<round>-t2r2`, wins only with a later completedAt. The
    // records it displaces are kept as superseded (audit), not deleted.
    const slotRivals = this.liveSlotRivals(normalized, key);
    const newCompletedAt = Date.parse(normalized.completedAt);
    const strongestRival = slotRivals.reduce<CrossBrokerTerminalBriefProjection | undefined>(
      (best, [, rival]) => (!best || Date.parse(rival.completedAt) > Date.parse(best.completedAt) ? rival : best),
      undefined,
    );
    if (strongestRival && newCompletedAt <= Date.parse(strongestRival.completedAt)) {
      return reject(
        "stale_replay",
        `parent round slot ${normalized.parentRoundOrder} is held by a projection that completed at the same time or later`,
        now,
      );
    }

    const record: CrossBrokerTerminalBriefProjection = {
      id: key,
      ...normalized,
      emittedAt: normalized.emittedAt ?? normalized.completedAt,
      receivedAt: now,
      sourceDigest,
      replayCount: existing?.replayCount ?? 0,
      ack: {
        decision: "accepted",
        terminalAck: false,
        reason: "projection stored for broker-of-record aggregation; no Terminal Brief ACK was emitted",
        updatedAt: now,
      },
    };
    this.records.set(key, record);
    for (const [rivalKey, rival] of slotRivals) {
      this.records.set(rivalKey, { ...rival, superseded: { by: key, at: now } });
      this.diagnosticsCounters.slotSuperseded += 1;
    }
    if (record.handoffBrokerSource === "legacy_origin") this.diagnosticsCounters.legacyOriginAsHandoff += 1;
    else this.diagnosticsCounters.explicitHandoffBroker += 1;
    if (parentResolvedVia === "registry") this.diagnosticsCounters.parentResolvedViaRegistry += 1;
    else this.diagnosticsCounters.parentResolvedViaLegacyTask += 1;
    return { accepted: true, replayed: false, record: structuredClone(record), ack: record.ack };
  }

  /** Process-local counters (reset on restart; not persisted in the snapshot). */
  diagnostics(): CrossBrokerTerminalBriefProjectionDiagnostics {
    return { ...this.diagnosticsCounters };
  }

  /**
   * #2339 PR-3b: live records of other children in the same
   * (parentRoundId, handoffBrokerId, parentRoundOrder) slot. A projection
   * without an order has no slot.
   */
  private liveSlotRivals(
    normalized: Pick<CrossBrokerTerminalBriefProjection, "parentRoundId" | "handoffBrokerId" | "originBrokerId" | "parentRoundOrder">,
    key: string,
  ): Array<[string, CrossBrokerTerminalBriefProjection]> {
    // Returns map keys with the records: a restored record's `id` can predate
    // the current key formula (#2339 PR-6), so the map key is the write target.
    if (normalized.parentRoundOrder === undefined) return [];
    const handoff = normalized.handoffBrokerId ?? normalized.originBrokerId;
    return [...this.records.entries()]
      .filter(([candidateKey, candidate]) => candidateKey !== key
        && !candidate.superseded
        && candidate.parentRoundId === normalized.parentRoundId
        && (candidate.handoffBrokerId ?? candidate.originBrokerId) === handoff
        && candidate.parentRoundOrder === normalized.parentRoundOrder);
  }

  get(parentRoundId: string, originBrokerId: string): CrossBrokerTerminalBriefProjection | undefined {
    const record = [...this.records.values()]
      .filter((candidate) => !candidate.superseded)
      .filter((candidate) => candidate.parentRoundId === parentRoundId && candidate.originBrokerId === originBrokerId)
      .sort(compareRecords)[0];
    return record ? structuredClone(record) : undefined;
  }

  list(filters: CrossBrokerTerminalBriefProjectionFilters = {}): CrossBrokerTerminalBriefProjection[] {
    return [...this.records.values()]
      .filter((record) => filters.includeSuperseded === true || !record.superseded)
      .filter((record) => !filters.parentRoundId || record.parentRoundId === filters.parentRoundId)
      .filter((record) => !filters.originBrokerId || record.originBrokerId === filters.originBrokerId)
      .filter((record) => !filters.handoffBrokerId || record.handoffBrokerId === filters.handoffBrokerId)
      .sort(compareRecords)
      .map((record) => structuredClone(record));
  }

  restore(records: CrossBrokerTerminalBriefProjection[]): void {
    this.records.clear();
    for (const record of records) {
      this.records.set(recordKey(record), normalizeRecord(record));
    }
  }

  snapshot(): CrossBrokerTerminalBriefProjection[] {
    // Superseded slot records persist for audit (#2339 PR-3b).
    return this.list({ includeSuperseded: true });
  }
}

function normalizeRequest(request: CrossBrokerTerminalBriefProjectionRequest): Omit<CrossBrokerTerminalBriefProjection, "id" | "receivedAt" | "sourceDigest" | "replayCount" | "ack" | "emittedAt"> & { emittedAt?: string } | undefined {
  const parentRoundId = normalizeToken(request.parentRoundId);
  const originBrokerId = normalizeToken(request.originBrokerId);
  const status = request.status;
  const completedAt = normalizeIso(request.completedAt);
  if (!parentRoundId || !originBrokerId || !isSettledTaskStatus(status) || !completedAt) return undefined;
  const explicitHandoffBrokerId = normalizeToken(request.handoffBrokerId);
  const handoffBrokerId = explicitHandoffBrokerId ?? originBrokerId;
  const handoffBrokerSource: CrossBrokerHandoffBrokerSource = explicitHandoffBrokerId ? "explicit" : "legacy_origin";
  const brokerOfRecordId = normalizeToken(request.brokerOfRecordId);
  const childTaskId = normalizeToken(request.childTaskId);
  const originTaskId = normalizeToken(request.originTaskId);
  const childRunId = normalizeToken(request.childRunId);
  const childWorkerId = normalizeToken(request.childWorkerId ?? request.workerId);
  const emittedAt = normalizeIso(request.emittedAt);
  const evidenceUrl = normalizeHttpUrl(request.evidenceUrl);
  const summary = sanitizeText(request.summary, MAX_SUMMARY_CHARS);
  const taskBrief = sanitizeText(request.taskBrief, MAX_BRIEF_CHARS);
  const terminalBriefTitle = sanitizeRenderedText(request.terminalBriefTitle, MAX_TERMINAL_BRIEF_TITLE_CHARS);
  const parentRoundTotal = normalizePositiveInt(request.parentRoundTotal);
  const parentRoundOrder = normalizePositiveInt(request.parentRoundNum ?? request.parentRoundOrder ?? request.roundNum);
  return {
    parentRoundId,
    originBrokerId,
    handoffBrokerId,
    handoffBrokerSource,
    ...(brokerOfRecordId ? { brokerOfRecordId } : {}),
    ...(childTaskId ? { childTaskId } : {}),
    ...(originTaskId ? { originTaskId } : {}),
    ...(childRunId ? { childRunId } : {}),
    ...(childWorkerId ? { childWorkerId } : {}),
    status,
    ...(summary ? { summary } : {}),
    ...(taskBrief ? { taskBrief } : {}),
    ...(terminalBriefTitle ? { terminalBriefTitle } : {}),
    ...(evidenceUrl ? { evidenceUrl } : {}),
    completedAt,
    ...(emittedAt ? { emittedAt } : {}),
    ...(parentRoundTotal ? { parentRoundTotal } : {}),
    ...(parentRoundOrder ? { parentRoundOrder } : {}),
  };
}

function normalizeRecord(record: CrossBrokerTerminalBriefProjection): CrossBrokerTerminalBriefProjection {
  const parentRoundTotal = normalizePositiveInt(record.parentRoundTotal);
  const parentRoundOrder = normalizePositiveInt(record.parentRoundOrder);
  const terminalBriefTitle = sanitizeRenderedText(record.terminalBriefTitle, MAX_TERMINAL_BRIEF_TITLE_CHARS);
  const {
    parentRoundTotal: _parentRoundTotal,
    parentRoundOrder: _parentRoundOrder,
    terminalBriefTitle: _terminalBriefTitle,
    terminalBriefText: _terminalBriefText,
    ...rest
  } = record as CrossBrokerTerminalBriefProjection & { terminalBriefText?: unknown };
  // Snapshots written before #2339 PR-6 carry no handoffBrokerId: the producer
  // was stored in originBrokerId, so derive it and keep the record key stable.
  const restoredHandoff = normalizeToken(record.handoffBrokerId);
  return {
    ...rest,
    handoffBrokerId: restoredHandoff ?? rest.originBrokerId,
    handoffBrokerSource: restoredHandoff ? (record.handoffBrokerSource === "legacy_origin" ? "legacy_origin" : "explicit") : "legacy_origin",
    ...(terminalBriefTitle ? { terminalBriefTitle } : {}),
    ...(parentRoundTotal ? { parentRoundTotal } : {}),
    ...(parentRoundOrder ? { parentRoundOrder } : {}),
    ack: {
      decision: record.ack?.decision === "duplicate_replay" ? "duplicate_replay" : "accepted",
      terminalAck: false,
      reason: sanitizeText(record.ack?.reason, MAX_REASON_CHARS) ?? "stored cross-broker projection",
      updatedAt: normalizeIso(record.ack?.updatedAt) ?? record.receivedAt,
    },
  };
}

function reject(code: CrossBrokerTerminalBriefRejectCode, reason: string, updatedAt: string): CrossBrokerTerminalBriefProjectionResult {
  return {
    accepted: false,
    replayed: false,
    ack: {
      decision: "rejected",
      terminalAck: false,
      code,
      reason: sanitizeText(reason, MAX_REASON_CHARS) ?? code,
      updatedAt,
    },
  };
}

function digestProjection(record: ReturnType<typeof normalizeRequest> & {}): string {
  // handoffBrokerId is part of the record key, not the content digest, so a
  // packet stored before #2339 PR-6 still dedupes as duplicate_replay.
  // originTaskId (#2339 PR-1c) is judgment input, not content: a relay that
  // starts sending it must not turn an already-stored child into a new update.
  const {
    handoffBrokerId: _handoffBrokerId,
    handoffBrokerSource: _handoffBrokerSource,
    originTaskId: _originTaskId,
    ...content
  } = record;
  return `sha256:${createHash("sha256").update(stableStringify(content)).digest("hex")}`;
}

function recordKey(record: Pick<CrossBrokerTerminalBriefProjection, "parentRoundId" | "originBrokerId" | "handoffBrokerId" | "childTaskId" | "childWorkerId" | "parentRoundOrder">): string {
  const childKey = record.childTaskId
    ?? (record.childWorkerId ? `worker:${record.childWorkerId}` : undefined)
    ?? (record.parentRoundOrder ? `order:${record.parentRoundOrder}` : undefined)
    ?? "broker";
  // Keyed by the producing broker; for legacy records that is originBrokerId,
  // so keys written before #2339 PR-6 are unchanged.
  return `${record.parentRoundId}::${record.handoffBrokerId ?? record.originBrokerId}::${childKey}`;
}

function compareRecords(a: CrossBrokerTerminalBriefProjection, b: CrossBrokerTerminalBriefProjection): number {
  return a.parentRoundId.localeCompare(b.parentRoundId)
    || a.originBrokerId.localeCompare(b.originBrokerId)
    || (a.handoffBrokerId ?? a.originBrokerId).localeCompare(b.handoffBrokerId ?? b.originBrokerId)
    || ((a.parentRoundOrder ?? Number.MAX_SAFE_INTEGER) - (b.parentRoundOrder ?? Number.MAX_SAFE_INTEGER))
    || (a.childTaskId ?? "").localeCompare(b.childTaskId ?? "")
    || (a.childWorkerId ?? "").localeCompare(b.childWorkerId ?? "");
}

const DEFAULT_MAX_FUTURE_SKEW_MS = 5 * 60_000;

function resolveMaxFutureSkewMs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_MAX_FUTURE_SKEW_MS;
}

function normalizeToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIso(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0 && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function normalizeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
  } catch {
    // Ignore malformed or unsafe local evidence URLs.
  }
  return undefined;
}

function sanitizeText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const sanitized = trimmed
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat|sk|xox[abp])-[-_A-Za-z0-9]+\b/g, "[redacted]")
    .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/(^|\s)(?:[A-Za-z]:)?\/[\w./-]+/g, "$1[path]")
    .replace(/\s+/g, " ")
    .slice(0, maxChars);
  return sanitized || undefined;
}

function sanitizeRenderedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const sanitized = trimmed
    .replace(/```[\s\S]*?```/g, "[redacted]")
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat|sk|xox[abp])-[-_A-Za-z0-9]+\b/g, "[redacted]")
    .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/(^|\s)(?:[A-Za-z]:)?\/[\w./-]+/g, "$1[path]")
    .slice(0, maxChars);
  return sanitized || undefined;
}
