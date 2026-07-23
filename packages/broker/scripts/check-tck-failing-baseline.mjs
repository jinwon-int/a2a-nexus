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
 *   2. Honesty — selectors must be present and mutually exclusive. A
 *      pre-verbose baseline cannot claim independently measured values, while
 *      a per-test baseline must match a sufficient history measurement exactly.
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

function isPassTotal(v) {
  return v != null && typeof v === 'object' && Number.isInteger(v.pass) && Number.isInteger(v.total);
}

function selectorMatches(selector, nodeId) {
  return nodeId === selector || nodeId.startsWith(`${selector}[`) || (selector.endsWith('::') && nodeId.startsWith(selector));
}

function selectorsOverlap(a, b) {
  return selectorMatches(a, b) || selectorMatches(b, a);
}

/**
 * Anchor the classification to the EXACT committed measurement it claims to
 * decompose: same date + level + transport + optional source identity, with a
 * jsonrpc category. Binding the workflow source for per-test baselines keeps
 * independent same-day runs unambiguous; legacy pre-verbose rows remain
 * compatible without a source pin.
 */
function findAnchorMeasurement(history, coarseBaseline) {
  const measurements = Array.isArray(history?.measurements) ? history.measurements : [];
  const { date, level, transport, source } = coarseBaseline ?? {};
  return (
    measurements.find(
      (m) => m
        && m.date === date
        && m.level === level
        && m.transport === transport
        && (!source || m.source === source)
        && isPassTotal(m.categories?.jsonrpc),
    ) ?? null
  );
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
  const isPreVerboseBaseline = baseline.provenance?.NOT_a_per_test_run;
  if (typeof isPreVerboseBaseline !== 'boolean') {
    failures.push('tck-failing-categories: provenance.NOT_a_per_test_run must be an explicit boolean');
  }

  // Invariant 1 — the coarse baseline must pin, and match, an EXACT committed
  // measurement (date + level + transport), not just "some jsonrpc row".
  const cb = baseline.coarseBaseline;
  let anchor = null;
  if (
    !cb || cb.category !== 'jsonrpc' || cb.level !== 'must' || cb.transport !== 'jsonrpc'
    || typeof cb.date !== 'string' || cb.date.length === 0
  ) {
    failures.push(
      'tck-failing-categories.coarseBaseline must pin { category:"jsonrpc", level:"must", transport:"jsonrpc", date, pass, total }',
    );
  } else if (isPreVerboseBaseline === false && (typeof cb.source !== 'string' || cb.source.length === 0)) {
    failures.push('tck-failing-categories.coarseBaseline.source must pin the exact workflow run for a per-test baseline');
  } else {
    anchor = findAnchorMeasurement(history, cb);
    if (!anchor) {
      failures.push(
        `tck-failing-categories.coarseBaseline finds no tck-history measurement at date ${cb.date} level must transport jsonrpc${cb.source ? ` source ${cb.source}` : ''} (mis-anchored or stale identity)`,
      );
    } else {
      const jr = anchor.categories.jsonrpc;
      if (cb.pass !== jr.pass || cb.total !== jr.total) {
        failures.push(
          `tck-failing-categories.coarseBaseline (${cb.pass}/${cb.total}) must match the anchored must/jsonrpc measurement ${jr.pass}/${jr.total} (${cb.date})`,
        );
      }
    }
  }

  // Sub-category shape + honesty invariant 2.
  const subs = Array.isArray(baseline.subCategories) ? baseline.subCategories : [];
  const ids = new Set();
  const selectorOwners = [];
  for (const sub of subs) {
    if (!sub || typeof sub.id !== 'string') {
      failures.push('tck-failing-categories: each subCategory needs a string id');
      continue;
    }
    if (ids.has(sub.id)) failures.push(`tck-failing-categories: duplicate subCategory id ${sub.id}`);
    ids.add(sub.id);
    if (!VALID_READINESS.has(sub.promotionReadiness)) {
      failures.push(`tck-failing-categories: subCategory ${sub.id} invalid promotionReadiness ${sub.promotionReadiness}`);
    }
    if (!VALID_SOURCE_KIND.has(sub.sourceKind)) {
      failures.push(`tck-failing-categories: subCategory ${sub.id} sourceKind must be one of ${[...VALID_SOURCE_KIND].join('/')}`);
    }
    if (!Array.isArray(sub.pytestNodeIdSelectors) || sub.pytestNodeIdSelectors.length === 0) {
      failures.push(`tck-failing-categories: subCategory ${sub.id} needs non-empty pytestNodeIdSelectors`);
    } else {
      const ownSelectors = new Set();
      for (const selector of sub.pytestNodeIdSelectors) {
        if (
          typeof selector !== 'string'
          || !selector.startsWith('tests/compatibility/')
          || !selector.split('::').at(-1)?.startsWith('test_')
        ) {
          failures.push(`tck-failing-categories: subCategory ${sub.id} has invalid pytest node-id selector ${String(selector)}`);
          continue;
        }
        if (ownSelectors.has(selector)) {
          failures.push(`tck-failing-categories: subCategory ${sub.id} repeats pytest node-id selector ${selector}`);
          continue;
        }
        ownSelectors.add(selector);
        selectorOwners.push({ id: sub.id, selector });
      }
    }

    // Coherent emission-state transition (honesty invariant). Every sub-category
    // must carry an EXPLICIT boolean `pendingEmission`:
    //   pendingEmission=true  → not yet measured by an official per-test run:
    //     measuredPassTotal MUST be null, sourceKind MUST NOT be official-tck,
    //     and it cannot be `promoted`.
    //   pendingEmission=false → emission-complete: sourceKind MUST be official-tck
    //     and measuredPassTotal MUST be a {pass,total} record (the supported
    //     representation of a real measured sub-category).
    // `promoted` is only reachable from the emission-complete state.
    const pe = sub.pendingEmission;
    if (typeof pe !== 'boolean') {
      failures.push(`tck-failing-categories: subCategory ${sub.id} pendingEmission must be an explicit boolean`);
    } else if (pe === true) {
      if (sub.measuredPassTotal !== null) {
        failures.push(`tck-failing-categories: subCategory ${sub.id} pendingEmission=true requires measuredPassTotal=null (no unmeasured conformance)`);
      }
      if (sub.sourceKind === 'official-tck') {
        failures.push(`tck-failing-categories: subCategory ${sub.id} pendingEmission=true is inconsistent with sourceKind=official-tck (that asserts a real measurement)`);
      }
      if (sub.promotionReadiness === 'promoted') {
        failures.push(`tck-failing-categories: subCategory ${sub.id} cannot be 'promoted' while pendingEmission=true`);
      }
    } else {
      // pendingEmission === false — emission-complete
      if (sub.sourceKind !== 'official-tck') {
        failures.push(`tck-failing-categories: subCategory ${sub.id} pendingEmission=false requires sourceKind=official-tck`);
      }
      if (!isPassTotal(sub.measuredPassTotal)) {
        failures.push(`tck-failing-categories: subCategory ${sub.id} pendingEmission=false requires a measuredPassTotal {pass,total} (emission-complete representation)`);
      } else if (isPreVerboseBaseline === false) {
        const measured = anchor?.subCategories?.[sub.id];
        if (!isPassTotal(measured)) {
          failures.push(`tck-failing-categories: subCategory ${sub.id} has no matching measured sub-category in the anchored tck-history row`);
        } else if (sub.measuredPassTotal.pass !== measured.pass || sub.measuredPassTotal.total !== measured.total) {
          failures.push(
            `tck-failing-categories: subCategory ${sub.id} measuredPassTotal (${sub.measuredPassTotal.pass}/${sub.measuredPassTotal.total}) must match anchored history ${measured.pass}/${measured.total}`,
          );
        }
      }
    }
    if (sub.promotionReadiness === 'promoted' && !(sub.sourceKind === 'official-tck' && pe === false && isPassTotal(sub.measuredPassTotal))) {
      failures.push(`tck-failing-categories: subCategory ${sub.id} 'promoted' requires sourceKind=official-tck, pendingEmission=false, and a measuredPassTotal`);
    }
  }
  for (const required of REQUIRED_SUBCATEGORY_IDS) {
    if (!ids.has(required)) failures.push(`tck-failing-categories: missing required subCategory ${required} (the five #1500 categories must all be classified)`);
  }
  if (isPreVerboseBaseline === false) {
    if (anchor?.pytestOutcomeAccounting?.sufficientForMeasurement !== true) {
      failures.push('tck-failing-categories: a per-test baseline requires sufficientForMeasurement=true in the anchored tck-history row');
    }
    const pendingIds = subs.filter((sub) => sub?.pendingEmission !== false).map((sub) => sub?.id ?? '<unknown>');
    if (pendingIds.length > 0) {
      failures.push(`tck-failing-categories: a per-test baseline requires every subCategory to be emission-complete; pending: ${pendingIds.join(', ')}`);
    }
  }
  for (let i = 0; i < selectorOwners.length; i++) {
    for (let j = i + 1; j < selectorOwners.length; j++) {
      const left = selectorOwners[i];
      const right = selectorOwners[j];
      if (left.id !== right.id && selectorsOverlap(left.selector, right.selector)) {
        failures.push(
          `tck-failing-categories: selectors overlap across ${left.id} and ${right.id}: ${left.selector} <> ${right.selector}`,
        );
      }
    }
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
  console.log('tck failing-category baseline ok: classification and measured values are consistent with tck-history.json');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
