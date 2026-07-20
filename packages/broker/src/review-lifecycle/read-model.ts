/**
 * Operator read model for bounded PR review lineages (#1518 Phase 3a).
 * Projection only — no mutation. Mirrors the trading-dialectic read-model pattern.
 */

import { computeMetrics, openBlockingFindings } from "./lifecycle.js";
import { REVIEW_LINEAGE_KIND, type FindingV1, type LineageMetrics, type ReviewLineageRecord } from "./types.js";

export interface ReviewLineageReadModel {
  kind: typeof REVIEW_LINEAGE_KIND;
  lineageId: string;
  state: ReviewLineageRecord["state"];
  mode: ReviewLineageRecord["mode"];
  headline: string;
  metrics: LineageMetrics;
  openFindings: FindingV1[];
  currentHeadSha: string;
  originalHeadSha: string;
  startedAt: string;
  updatedAt: string;
}

export function projectLineageReadModel(record: ReviewLineageRecord, now: string): ReviewLineageReadModel {
  const metrics = computeMetrics(record, now);
  const open = openBlockingFindings(record);
  const headline =
    record.state === "passed"
      ? `lineage ${record.lineageId}: passed after ${metrics.reviewerRuns} reviewer run(s), ${metrics.correctionGenerations} correction(s)`
      : record.state === "blocked_needs_operator"
        ? `lineage ${record.lineageId}: blocked (${record.terminalReason}) after ${metrics.elapsedSeconds}s — operator disposition required`
        : record.state === "intent_conflict"
          ? `lineage ${record.lineageId}: intent conflict — correction changed the frozen intent`
          : `lineage ${record.lineageId}: ${record.state}, ${open.length} open blocking finding(s)`;
  return {
    kind: REVIEW_LINEAGE_KIND,
    lineageId: record.lineageId,
    state: record.state,
    mode: record.mode,
    headline,
    metrics,
    openFindings: open,
    currentHeadSha: record.currentHeadSha,
    originalHeadSha: record.contract.headSha,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
  };
}
