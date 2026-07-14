#!/usr/bin/env node
/**
 * TCK failing-category baseline guard (a2a-nexus#1500, item 1).
 *
 * Validates docs/tck-failing-categories.json — the machine-readable
 * classification of the coarse `jsonrpc` TCK failing bucket into the five
 * stable sub-categories named in #1500. This is the structural layer the
 * promotion protocol consumes.
 *
 * Fully OFFLINE / source-only: reads only two committed files
 * (tck-failing-categories.json + tck-history.json). No network.
 *
 * The guard enforces two invariants:
 *   1. Consistency — the classification's `coarseBaseline` must match the
 *      committed `jsonrpc` measurement in tck-history.json (no drift between
 *      the lump total and its decomposition).
 *   2. Honesty — because the harness only emits coarse directory buckets, no
 *      sub-category may claim an independently-measured pass/total; every
 *      `measuredPassTotal` must stay null until per-test emission exists. This
 *      prevents the file from overstating conformance.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const brokerDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(brokerDir, 'docs/tck-failing-categories.json');
const HISTORY = resolve(brokerDir, 'docs/tck-history.json');

const REQUIRED_SUBCATEGORY_IDS = [
  'jsonrpc-error-codes-and-errorinfo',
  'jsonrpc-task-not-found-and-invalid-task',
  'jsonrpc-artifact-message-projection',
  'jsonrpc-streaming-subscribe-ordering',
  'jsonrpc-version-negotiation',
];
const VALID_READINESS = new Set(['blocked-pending-fresh-run', 'candidate-pending-fresh-run', 'promoted']);
const VALID_SOURCE_KIND = new Set(['official-tck', 'code-derived', 'prose-derived']);

function latestJsonrpc(history) {
  const measurements = Array.isArray(history?.measurements) ? history.measurements : [];
  for (let i = measurements.length - 1; i >= 0; i -= 1) {
    const jr = measurements[i]?.categories?.jsonrpc;
    if (jr && Number.isInteger(jr.pass) && Number.isInteger(jr.total)) {
      return { pass: jr.pass, total: jr.total, date: measurements[i].date };
    }
  }
  return null;
}

/**
 * Pure evaluator so tests can drive it without spawning.
 * @param {any} baseline parsed tck-failing-categories.json
 * @param {any} history parsed tck-history.json
 * @returns {string[]} failure messages (empty === clean)
 */
export function evaluateFailingBaseline(baseline, history) {
  const failures = [];
  if (baseline == null) return ['missing docs/tck-failing-categories.json'];
  if (history == null) return ['missing docs/tck-history.json'];

  if (baseline.schemaVersion !== 1) failures.push('tck-failing-categories: schemaVersion must be 1');
  if (baseline.provenance?.NOT_a_per_test_run !== true) {
    failures.push('tck-failing-categories: provenance.NOT_a_per_test_run must be true (honesty marker: numbers are not from a per-test TCK run)');
  }

  // Invariant 1 — coarse baseline consistency with committed history.
  const jr = latestJsonrpc(history);
  const cb = baseline.coarseBaseline;
  if (!jr) {
    failures.push('tck-history.json has no jsonrpc measurement to anchor the classification');
  } else if (!cb || cb.pass !== jr.pass || cb.total !== jr.total) {
    failures.push(
      `tck-failing-categories.coarseBaseline (${cb?.pass}/${cb?.total}) must match tck-history jsonrpc ${jr.pass}/${jr.total} (${jr.date})`,
    );
  }

  // Sub-category shape + honesty invariant 2.
  const subs = Array.isArray(baseline.subCategories) ? baseline.subCategories : [];
  const ids = new Set();
  for (const sub of subs) {
    if (!sub || typeof sub.id !== 'string') {
      failures.push('tck-failing-categories: each subCategory needs a string id');
      continue;
    }
    if (ids.has(sub.id)) failures.push(`tck-failing-categories: duplicate subCategory id ${sub.id}`);
    ids.add(sub.id);
    if (sub.measuredPassTotal !== null) {
      failures.push(
        `tck-failing-categories: subCategory ${sub.id} measuredPassTotal must be null until the harness emits per-sub-category granularity (do not claim unmeasured conformance)`,
      );
    }
    if (!VALID_READINESS.has(sub.promotionReadiness)) {
      failures.push(`tck-failing-categories: subCategory ${sub.id} invalid promotionReadiness ${sub.promotionReadiness}`);
    }
    // Provenance honesty: every sub-category must declare how its status was
    // derived, and stay flagged pending real per-test emission until the harness
    // emits sub-category granularity. A `code-derived`/`prose-derived` entry may
    // NOT be promoted (only an `official-tck`, emission-complete entry can).
    if (!VALID_SOURCE_KIND.has(sub.sourceKind)) {
      failures.push(`tck-failing-categories: subCategory ${sub.id} sourceKind must be one of ${[...VALID_SOURCE_KIND].join('/')}`);
    }
    if (sub.pendingEmission !== true && sub.sourceKind !== 'official-tck') {
      failures.push(`tck-failing-categories: subCategory ${sub.id} pendingEmission must stay true until sourceKind is official-tck (no unmeasured promotion)`);
    }
    if (sub.promotionReadiness === 'promoted' && (sub.sourceKind !== 'official-tck' || sub.pendingEmission === true)) {
      failures.push(`tck-failing-categories: subCategory ${sub.id} cannot be 'promoted' without official-tck sourceKind and pendingEmission=false`);
    }
  }
  for (const required of REQUIRED_SUBCATEGORY_IDS) {
    if (!ids.has(required)) failures.push(`tck-failing-categories: missing required subCategory ${required} (the five #1500 categories must all be classified)`);
  }

  return failures;
}

function main() {
  const failures = [];
  let baseline = null;
  let history = null;
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch (err) {
    failures.push(`cannot read docs/tck-failing-categories.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    history = JSON.parse(readFileSync(HISTORY, 'utf8'));
  } catch (err) {
    failures.push(`cannot read docs/tck-history.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!failures.length) failures.push(...evaluateFailingBaseline(baseline, history));

  if (failures.length) {
    console.error(`tck failing-category baseline guard failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log('tck failing-category baseline ok: classification consistent with tck-history.json and claims no unmeasured conformance');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
