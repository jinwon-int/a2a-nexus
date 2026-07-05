#!/usr/bin/env node
/**
 * Lane reliability ledger gate (#1299 M1).
 *
 * Validates the report-only ledger that aggregates finalizer evidence classes and
 * acceptance/review outcomes by anonymous routing axes. This script never calls
 * a broker, never mutates live state, and never judges whether a lane's finding
 * was correct — it only enforces schema, taxonomy, and privacy boundaries.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EVIDENCE_CLASSES } from './a2ad-finalizer-gate.mjs';

const COUNT_FIELDS = [
  'dispatchedCount',
  'substantiveCount',
  'acceptancePassCount',
  'acceptanceFailCount',
  'reviewPassCount',
];

// Axes must be anonymous classes, never concrete workers, nodes, URLs, or host
// identifiers. The list is intentionally conservative and can grow as the fleet
// vocabulary changes.
const KNOWN_NODE_WORDS = [
  'bang' + 'tong',
  'so' + 'gyo',
  'no' + 'suk',
  'yuk' + 'son',
  'gong' + 'yung',
  'soon' + 'wook',
  'dun' + 'gae',
  'jin' + 'gun',
  'dae' + 'gyo',
  'gong' + 'myoung',
  'seo' + 'seo',
  'gwak' + 'ga',
];
const AXIS_FORBIDDEN = new RegExp(`(?:https?:\\/\\/|github\\.com\\/|\\b(?:${KNOWN_NODE_WORDS.join('|')}|vps\\d+|worker-[a-z0-9_-]+|node-[a-z0-9_-]+)\\b)`, 'i');
const ISO_WINDOW = /^\d{4}-\d{2}(?:-\d{2})?$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateAxis(entry, field, where, failures) {
  const value = entry?.[field];
  if (!isNonEmptyString(value)) {
    failures.push(`${where}: ${field} is required`);
    return;
  }
  if (AXIS_FORBIDDEN.test(value)) {
    failures.push(`${where}: ${field} must be an anonymous class, not a worker/node/url/private identifier`);
  }
}

function validateCount(entry, field, where, failures) {
  const value = entry?.[field];
  if (!Number.isInteger(value) || value < 0) failures.push(`${where}: ${field} must be a non-negative integer`);
}

function breakdownTotal(breakdown) {
  return Object.values(breakdown ?? {}).reduce((sum, value) => sum + (Number.isInteger(value) && value > 0 ? value : 0), 0);
}

export function evaluateLaneReliabilityLedger(doc) {
  if (!doc || !Array.isArray(doc.entries)) return ['entries must be an array'];
  const failures = [];
  const seen = new Set();
  const evidenceSet = new Set(EVIDENCE_CLASSES);

  doc.entries.forEach((entry, index) => {
    const where = `entry #${index} (${entry?.id ?? 'no id'})`;
    if (!isNonEmptyString(entry?.id)) failures.push(`${where}: id is required`);
    else if (seen.has(entry.id)) failures.push(`${where}: duplicate id`);
    else seen.add(entry.id);

    for (const field of ['adapterClass', 'modelClass', 'taskClass']) validateAxis(entry, field, where, failures);
    if (!isNonEmptyString(entry?.window)) failures.push(`${where}: window is required`);
    else if (!ISO_WINDOW.test(entry.window)) failures.push(`${where}: window must be YYYY-MM or YYYY-MM-DD`);
    else if (AXIS_FORBIDDEN.test(entry.window)) failures.push(`${where}: window must not contain worker/node/url/private identifiers`);

    for (const field of COUNT_FIELDS) validateCount(entry, field, where, failures);

    if (Number.isInteger(entry?.substantiveCount) && Number.isInteger(entry?.dispatchedCount)
      && entry.substantiveCount > entry.dispatchedCount) {
      failures.push(`${where}: substantiveCount must be <= dispatchedCount`);
    }
    if (Number.isInteger(entry?.acceptancePassCount) && Number.isInteger(entry?.acceptanceFailCount)
      && Number.isInteger(entry?.dispatchedCount)
      && entry.acceptancePassCount + entry.acceptanceFailCount > entry.dispatchedCount) {
      failures.push(`${where}: acceptancePassCount + acceptanceFailCount must be <= dispatchedCount`);
    }
    if (Number.isInteger(entry?.reviewPassCount) && Number.isInteger(entry?.dispatchedCount)
      && entry.reviewPassCount > entry.dispatchedCount) {
      failures.push(`${where}: reviewPassCount must be <= dispatchedCount`);
    }

    const breakdown = entry?.evidenceClassBreakdown;
    if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) {
      failures.push(`${where}: evidenceClassBreakdown must be an object`);
    } else {
      for (const [evidenceClass, count] of Object.entries(breakdown)) {
        if (!evidenceSet.has(evidenceClass)) {
          failures.push(`${where}: evidenceClassBreakdown.${evidenceClass} is not a known finalizer evidence class`);
        } else if (!Number.isInteger(count) || count < 0) {
          failures.push(`${where}: evidenceClassBreakdown.${evidenceClass} must be a non-negative integer`);
        }
      }
      if (Number.isInteger(entry?.dispatchedCount) && breakdownTotal(breakdown) > entry.dispatchedCount) {
        failures.push(`${where}: evidenceClassBreakdown total must be <= dispatchedCount`);
      }
    }

    if (!Array.isArray(entry?.sourceRoundIds)) {
      failures.push(`${where}: sourceRoundIds must be an array`);
    } else {
      const roundIds = new Set();
      entry.sourceRoundIds.forEach((roundId, roundIndex) => {
        if (!isNonEmptyString(roundId)) failures.push(`${where}: sourceRoundIds[${roundIndex}] must be a non-empty string`);
        else if (roundIds.has(roundId)) failures.push(`${where}: duplicate sourceRoundIds entry '${roundId}'`);
        else roundIds.add(roundId);
        if (typeof roundId === 'string' && /https?:\/\//i.test(roundId)) failures.push(`${where}: sourceRoundIds[${roundIndex}] must be an id, not a URL`);
      });
    }
  });
  return failures;
}

export function summarizeLaneReliabilityLedger(doc) {
  const summary = {
    entries: Array.isArray(doc?.entries) ? doc.entries.length : 0,
    dispatchedCount: 0,
    substantiveCount: 0,
    acceptancePassCount: 0,
    acceptanceFailCount: 0,
    reviewPassCount: 0,
    evidenceClassBreakdown: {},
  };
  for (const entry of doc?.entries ?? []) {
    for (const field of COUNT_FIELDS) summary[field] += Number.isInteger(entry?.[field]) ? entry[field] : 0;
    for (const [evidenceClass, count] of Object.entries(entry.evidenceClassBreakdown ?? {})) {
      if (Number.isInteger(count) && count > 0) summary.evidenceClassBreakdown[evidenceClass] = (summary.evidenceClassBreakdown[evidenceClass] ?? 0) + count;
    }
  }
  return summary;
}

function main() {
  const ledgerPath = process.env.LANE_RELIABILITY_LEDGER || 'docs/ops/lane-reliability-ledger.json';
  const resolved = path.resolve(process.cwd(), ledgerPath);
  const doc = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const failures = evaluateLaneReliabilityLedger(doc);
  if (failures.length) {
    console.error(`lane reliability ledger FAILED (${failures.length} problem(s) in ${ledgerPath}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  const summary = summarizeLaneReliabilityLedger(doc);
  console.log(`lane reliability ledger ok (${summary.entries} entr${summary.entries === 1 ? 'y' : 'ies'}; dispatched=${summary.dispatchedCount}; substantive=${summary.substantiveCount}; acceptance pass/fail=${summary.acceptancePassCount}/${summary.acceptanceFailCount}; reviewPass=${summary.reviewPassCount}; evidence ${JSON.stringify(summary.evidenceClassBreakdown)})`);
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isDirectRun) main();
