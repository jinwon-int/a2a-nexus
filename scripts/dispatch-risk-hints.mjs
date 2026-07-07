#!/usr/bin/env node
/**
 * Pre-dispatch risk hints (#1300 M2-b).
 *
 * Combines two memory sources into an informational hint list for a task
 * class about to be dispatched:
 *  1. M1 lane-reliability ledger — combos in this task class whose
 *     substantive-output rate is at or below the warning threshold, with
 *     counts-only phrasing ("substantive M/N").
 *  2. Round-quality scorecard failure taxonomy — categories whose cumulative
 *     count crosses the threshold (default 5), so a recurring failure class
 *     (e.g. environment) is visible BEFORE dispatch instead of after seven
 *     rounds of rediscovery.
 *
 * Hints are INFORMATIONAL ONLY: they never block a dispatch or exclude a
 * lane — routing changes require the M2-d preconditions plus a separate
 * operator flip (#1263 pattern). Missing inputs produce an explicit
 * `no_data` result, never a silent success. Anonymous axes pass through
 * unchanged. Report-only: no broker calls, no writes.
 *
 * Usage:
 *   node scripts/dispatch-risk-hints.mjs --task-class analyze [--ledger f] [--scorecard f] [--failure-threshold 5] [--min-samples 5] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const DEFAULT_LEDGER = path.join('docs', 'ops', 'lane-reliability-ledger.json');
const DEFAULT_SCORECARD = path.join('docs', 'ops', 'round-quality-scorecard.json');
export const DEFAULT_FAILURE_THRESHOLD = 5;
export const DEFAULT_MIN_SAMPLES = 5;
/** Substantive rate at or below this fraction produces a ledger warning. */
const LOW_SUBSTANTIVE_RATE = 0.5;

function activeEntries(ledger) {
  const superseded = new Set((ledger?.entries ?? []).map((entry) => entry?.supersedes).filter(Boolean));
  return (ledger?.entries ?? []).filter((entry) => entry && !superseded.has(entry.id));
}

/**
 * Pure hint builder. Returns { noData, hints: [{ kind, text }] }.
 * `ledger`/`scorecard` may be null when their files are unavailable.
 */
export function buildDispatchRiskHints({
  ledger,
  scorecard,
  taskClass,
  failureThreshold = DEFAULT_FAILURE_THRESHOLD,
  minSamples = DEFAULT_MIN_SAMPLES,
}) {
  const hints = [];
  const ledgerEntries = ledger ? activeEntries(ledger) : [];
  const scorecardEntries = scorecard?.entries ?? [];

  if (ledgerEntries.length === 0 && scorecardEntries.length === 0) {
    return { noData: true, hints: [] };
  }

  // 1. Ledger: low-substantive combos for this task class (counts-only).
  const combos = new Map();
  for (const entry of ledgerEntries) {
    if (entry.taskClass !== taskClass) continue;
    const key = `${entry.adapterClass} ${entry.modelClass ?? ''}`;
    const combo = combos.get(key) ?? {
      adapterClass: entry.adapterClass,
      modelClass: entry.modelClass,
      dispatchedCount: 0,
      substantiveCount: 0,
    };
    combo.dispatchedCount += entry.dispatchedCount ?? 0;
    combo.substantiveCount += entry.substantiveCount ?? 0;
    combos.set(key, combo);
  }
  for (const combo of [...combos.values()].sort((a, b) => a.adapterClass.localeCompare(b.adapterClass))) {
    if (combo.dispatchedCount < minSamples) continue; // small-sample guard: no rate judgment
    if (combo.substantiveCount / combo.dispatchedCount <= LOW_SUBSTANTIVE_RATE) {
      hints.push({
        kind: 'ledger',
        text: `adapterClass=${combo.adapterClass}${combo.modelClass ? ` modelClass=${combo.modelClass}` : ''} taskClass=${taskClass}: substantive ${combo.substantiveCount}/${combo.dispatchedCount} — expect low substantive yield for this combo`,
      });
    }
  }

  // 2. Scorecard taxonomy: cumulative failure categories over the threshold.
  // Scorecard entries carry no task-class axis, so these hints are global
  // recurrence signals (documented in a2ad-round-dispatch.md).
  const cumulative = {};
  for (const entry of scorecardEntries) {
    const breakdown = entry?.failureBreakdown;
    if (!breakdown || typeof breakdown !== 'object') continue;
    for (const [category, count] of Object.entries(breakdown)) {
      if (Number.isInteger(count) && count > 0) {
        cumulative[category] = (cumulative[category] ?? 0) + count;
      }
    }
  }
  for (const category of Object.keys(cumulative).sort()) {
    if (cumulative[category] >= failureThreshold) {
      hints.push({
        kind: 'taxonomy',
        text: `failureClass ${category} cumulative ${cumulative[category]} across scorecard rounds (global signal) — review the operators-guide judgment criteria for this class before dispatch`,
      });
    }
  }

  return { noData: false, hints };
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'task-class': { type: 'string' },
      ledger: { type: 'string', default: DEFAULT_LEDGER },
      scorecard: { type: 'string', default: DEFAULT_SCORECARD },
      'failure-threshold': { type: 'string', default: String(DEFAULT_FAILURE_THRESHOLD) },
      'min-samples': { type: 'string', default: String(DEFAULT_MIN_SAMPLES) },
      json: { type: 'boolean', default: false },
    },
  });
  if (!values['task-class']) {
    process.stderr.write('usage: dispatch-risk-hints.mjs --task-class <class> [--ledger f] [--scorecard f] [--failure-threshold n] [--min-samples n] [--json]\n');
    return 2;
  }

  const result = buildDispatchRiskHints({
    ledger: readJsonOrNull(values.ledger),
    scorecard: readJsonOrNull(values.scorecard),
    taskClass: values['task-class'],
    failureThreshold: Math.max(1, Number.parseInt(values['failure-threshold'], 10) || DEFAULT_FAILURE_THRESHOLD),
    minSamples: Math.max(1, Number.parseInt(values['min-samples'], 10) || DEFAULT_MIN_SAMPLES),
  });

  if (values.json) {
    process.stdout.write(`${JSON.stringify({ taskClass: values['task-class'], ...result }, null, 2)}\n`);
    return 0;
  }
  if (result.noData) {
    process.stdout.write('no_data: neither ledger nor scorecard is readable/populated\n');
    return 1;
  }
  if (result.hints.length === 0) {
    process.stdout.write(`no risk hints for taskClass=${values['task-class']} (informational only)\n`);
    return 0;
  }
  for (const hint of result.hints) {
    process.stdout.write(`[${hint.kind}] ${hint.text}\n`);
  }
  process.stdout.write('hints are informational only — they never block dispatch or exclude lanes\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
