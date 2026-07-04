#!/usr/bin/env node
/**
 * Round-quality scorecard gate (#1220 PR 3).
 *
 * Validates docs/ops/round-quality-scorecard.json fail-closed so the quality
 * feedback loop stays machine-readable: unique entry ids, ISO dates, and
 * non-negative integer metrics for carryOverCount / falseFindingCount /
 * reworkIssueCount (plus optional extra counters), and the optional
 * failureBreakdown classification (#1236) restricted to the closed category
 * set with an evidence narrative per counted category. The scorecard is how
 * guardpack and process changes get judged by data instead of anecdotes —
 * a malformed entry silently dropped from aggregation would defeat that.
 */
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_METRICS = ['carryOverCount', 'falseFindingCount', 'reworkIssueCount'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Closed failure-classification taxonomy (#1236). Categories are assigned by
 * the finalizer in disposition comments (never by the implementing worker —
 * oracle independence) and aggregated per round in the optional
 * failureBreakdown object. Definitions and judgment criteria:
 * docs/operators.md "Failure classification".
 */
export const FAILURE_CATEGORIES = [
  'spec_ambiguity',
  'implementation_defect',
  'environment',
  'acceptance_misconfigured',
  'scope_drift',
  'other',
];

export const DEFAULT_OTHER_MAJORITY_WARNING_WINDOW = 2;

export function evaluateScorecard(doc) {
  const failures = [];
  if (!doc || !Array.isArray(doc.entries)) return ['entries must be an array'];
  const seen = new Set();
  doc.entries.forEach((entry, index) => {
    const where = `entry #${index} (${entry?.id ?? 'no id'})`;
    if (typeof entry?.id !== 'string' || entry.id.length === 0) failures.push(`${where}: id is required`);
    else if (seen.has(entry.id)) failures.push(`${where}: duplicate id`);
    else seen.add(entry.id);
    if (typeof entry?.scope !== 'string' || entry.scope.length === 0) failures.push(`${where}: scope is required`);
    for (const field of ['from', 'to']) {
      if (!ISO_DATE.test(entry?.window?.[field] ?? '')) failures.push(`${where}: window.${field} must be YYYY-MM-DD`);
    }
    if (!ISO_DATE.test(entry?.recordedAt ?? '')) failures.push(`${where}: recordedAt must be YYYY-MM-DD`);
    const metrics = entry?.metrics;
    if (!metrics || typeof metrics !== 'object') {
      failures.push(`${where}: metrics object is required`);
      return;
    }
    for (const metric of REQUIRED_METRICS) {
      if (!(metric in metrics)) failures.push(`${where}: metrics.${metric} is required`);
    }
    for (const [metric, value] of Object.entries(metrics)) {
      if (!Number.isInteger(value) || value < 0) failures.push(`${where}: metrics.${metric} must be a non-negative integer`);
    }
    if (!Array.isArray(entry?.evidence) || entry.evidence.length === 0 || !entry.evidence.every((line) => typeof line === 'string' && line.length > 0)) {
      failures.push(`${where}: evidence must be a non-empty string array`);
    }
    const breakdown = entry?.failureBreakdown;
    if (breakdown !== undefined) {
      if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) {
        failures.push(`${where}: failureBreakdown must be an object mapping failure categories to counts`);
        return;
      }
      const evidenceText = Array.isArray(entry?.evidence) ? entry.evidence.join('\n') : '';
      for (const [category, count] of Object.entries(breakdown)) {
        if (!FAILURE_CATEGORIES.includes(category)) {
          failures.push(`${where}: failureBreakdown.${category} is not a known failure category (expected one of: ${FAILURE_CATEGORIES.join(', ')})`);
        } else if (!Number.isInteger(count) || count < 0) {
          failures.push(`${where}: failureBreakdown.${category} must be a non-negative integer`);
        } else if (count > 0 && !evidenceText.includes(category)) {
          failures.push(`${where}: failureBreakdown.${category} is counted but no evidence line explains it (a classification without a narrative cannot be audited)`);
        }
      }
    }
  });
  return failures;
}

function failureBreakdownTotal(breakdown) {
  if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) return 0;
  return Object.values(breakdown).reduce((sum, value) => sum + (Number.isInteger(value) && value > 0 ? value : 0), 0);
}

export function evaluateScorecardWarnings(doc, options = {}) {
  if (!doc || !Array.isArray(doc.entries)) return [];
  const windowSize = options.otherMajorityWindow ?? DEFAULT_OTHER_MAJORITY_WARNING_WINDOW;
  if (!Number.isInteger(windowSize) || windowSize <= 0) return [];
  const ignored = new Set(options.ignoreEntryIds ?? []);
  const warnings = [];
  const streak = [];
  for (const entry of doc.entries) {
    if (!entry?.id || ignored.has(entry.id)) {
      streak.length = 0;
      continue;
    }
    const breakdown = entry.failureBreakdown;
    const total = failureBreakdownTotal(breakdown);
    const other = Number.isInteger(breakdown?.other) ? breakdown.other : 0;
    if (total > 0 && other > total / 2) {
      streak.push(entry.id);
      if (streak.length >= windowSize) {
        warnings.push(`failureBreakdown.other majority in ${streak.length} consecutive entries (${streak.join(', ')}); failed-lane readback excerpts may be too sparse for narrower classification`);
      }
    } else {
      streak.length = 0;
    }
  }
  return warnings;
}

function main() {
  const scorecardPath = process.env.ROUND_QUALITY_SCORECARD || 'docs/ops/round-quality-scorecard.json';
  const resolved = path.resolve(process.cwd(), scorecardPath);
  const doc = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const failures = evaluateScorecard(doc);
  if (failures.length) {
    console.error(`round quality scorecard FAILED (${failures.length} problem(s) in ${scorecardPath}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  const warnings = evaluateScorecardWarnings(doc);
  for (const warning of warnings) console.error(`round quality scorecard warning: ${warning}`);
  const totals = doc.entries.reduce(
    (acc, entry) => {
      for (const metric of REQUIRED_METRICS) acc[metric] += entry.metrics[metric];
      return acc;
    },
    Object.fromEntries(REQUIRED_METRICS.map((metric) => [metric, 0])),
  );
  const failureTotals = {};
  for (const entry of doc.entries) {
    for (const [category, count] of Object.entries(entry.failureBreakdown ?? {})) {
      failureTotals[category] = (failureTotals[category] ?? 0) + count;
    }
  }
  const failureSummary = Object.keys(failureTotals).length ? `; failures ${JSON.stringify(failureTotals)}` : '';
  console.log(`round quality scorecard ok (${doc.entries.length} entr${doc.entries.length === 1 ? 'y' : 'ies'}; totals ${JSON.stringify(totals)}${failureSummary})`);
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isDirectRun) main();
