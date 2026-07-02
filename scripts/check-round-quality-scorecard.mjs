#!/usr/bin/env node
/**
 * Round-quality scorecard gate (#1220 PR 3).
 *
 * Validates docs/ops/round-quality-scorecard.json fail-closed so the quality
 * feedback loop stays machine-readable: unique entry ids, ISO dates, and
 * non-negative integer metrics for carryOverCount / falseFindingCount /
 * reworkIssueCount (plus optional extra counters). The scorecard is how
 * guardpack and process changes get judged by data instead of anecdotes —
 * a malformed entry silently dropped from aggregation would defeat that.
 */
import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_METRICS = ['carryOverCount', 'falseFindingCount', 'reworkIssueCount'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  });
  return failures;
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
  const totals = doc.entries.reduce(
    (acc, entry) => {
      for (const metric of REQUIRED_METRICS) acc[metric] += entry.metrics[metric];
      return acc;
    },
    Object.fromEntries(REQUIRED_METRICS.map((metric) => [metric, 0])),
  );
  console.log(`round quality scorecard ok (${doc.entries.length} entr${doc.entries.length === 1 ? 'y' : 'ies'}; totals ${JSON.stringify(totals)})`);
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isDirectRun) main();
