#!/usr/bin/env node
/**
 * Release-gate step inventory guard (#880/#882).
 *
 * The inventory is now the executable source for scripts/release-gate.mjs tier
 * selection. This guard keeps the source-backed classification valid so
 * ordinary PR checks can run core/public-readiness gates while historical or
 * approval-gated transition checks stay explicit opt-in paths.
 */
import path from 'node:path';

import { createDocCheckContext } from './lib/doc-check.mjs';
import {
  DEFAULT_TIERS,
  TIER_CONSUMER,
  VALID_CONSUMER,
  VALID_OWNER,
  loadReleaseGateInventory,
  selectReleaseGateEntries,
  summarizeReleaseGateEntries,
} from './lib/release-gate-steps.mjs';

export function compareInventory({ inventory }) {
  const failures = [];
  const summary = Object.create(null);

  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
    return { ok: false, failures: ['inventory must be a JSON object'], summary: null };
  }
  if (inventory.generatedFrom !== 'scripts/release-gate.mjs') {
    failures.push('inventory.generatedFrom must be scripts/release-gate.mjs');
  }
  if (!Array.isArray(inventory.tiers)) failures.push('inventory.tiers must be an array');
  if (!Array.isArray(inventory.entries)) {
    failures.push('inventory.entries must be an array');
    return { ok: false, failures, summary: null };
  }

  const names = new Set();
  const validTiers = new Set(inventory.tiers ?? []);
  const validRetirement = new Set(['keep', 'candidate-after-review', 'manual-approval-required']);

  for (const [index, entry] of inventory.entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      failures.push(`inventory entry #${index} must be an object`);
      continue;
    }
    if (typeof entry.name !== 'string' || entry.name.length === 0) failures.push(`entry #${index}: missing name`);
    if (names.has(entry.name)) failures.push(`duplicate inventory entry for ${entry.name}`);
    names.add(entry.name);
    if (typeof entry.command !== 'string' || entry.command.length === 0) failures.push(`${entry.name}: command must be a string`);
    if (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== 'string')) {
      failures.push(`${entry.name}: args must be an array of strings`);
    }
    if (!validTiers.has(entry.tier)) failures.push(`${entry.name}: invalid tier ${entry.tier}`);
    if (!validRetirement.has(entry.retirement)) failures.push(`${entry.name}: invalid retirement ${entry.retirement}`);
    if (typeof entry.note !== 'string' || entry.note.length < 20) failures.push(`${entry.name}: note must explain classification`);
    if (!VALID_OWNER.has(entry.owner)) failures.push(`${entry.name}: invalid owner ${entry.owner}`);
    if (!VALID_CONSUMER.has(entry.consumer)) failures.push(`${entry.name}: invalid consumer ${entry.consumer}`);
    if (TIER_CONSUMER[entry.tier] !== entry.consumer) {
      failures.push(`${entry.name}: consumer ${entry.consumer} is inconsistent with tier ${entry.tier}`);
    }
    if (typeof entry.retirementCondition !== 'string' || entry.retirementCondition.length < 20) {
      failures.push(`${entry.name}: retirementCondition must state the retirement trigger`);
    }
    if (
      entry.weightMs !== undefined &&
      (typeof entry.weightMs !== 'number' || !Number.isFinite(entry.weightMs) || entry.weightMs < 0)
    ) {
      failures.push(`${entry.name}: weightMs must be a non-negative number when present`);
    }
    summary[entry.tier] = (summary[entry.tier] ?? 0) + 1;
  }

  for (const tier of DEFAULT_TIERS) {
    if (!validTiers.has(tier)) failures.push(`default release-gate tier is not declared: ${tier}`);
  }

  const defaultEntries = inventory.entries.filter((entry) => DEFAULT_TIERS.includes(entry.tier));
  if (defaultEntries.length === 0) failures.push('default release-gate selection is empty');
  if (!defaultEntries.some((entry) => entry.name === 'release-gate-inventory')) {
    failures.push('default release-gate selection must include release-gate-inventory self-check');
  }
  if (!defaultEntries.some((entry) => entry.name === 'external-secrets')) {
    failures.push('default release-gate selection must keep external-secrets public-readiness gate');
  }

  return { ok: failures.length === 0, failures, summary };
}

function main() {
  const { parseJson, fail, finish } = createDocCheckContext({
    name: 'release-gate step inventory',
  });
  const rawInventory = parseJson('docs/ops/release-gate-step-inventory.json');
  const result = compareInventory({ inventory: rawInventory });
  for (const message of result.failures) fail(message);

  let loaded;
  try {
    loaded = loadReleaseGateInventory();
    const defaultSelection = selectReleaseGateEntries(loaded);
    const allSelection = selectReleaseGateEntries(loaded, { all: true });
    console.log(`release-gate default selection: ${JSON.stringify(summarizeReleaseGateEntries(defaultSelection))}`);
    console.log(`release-gate all-tier selection: ${JSON.stringify(summarizeReleaseGateEntries(allSelection))}`);
  } catch (err) {
    fail(err.message);
  }

  console.log(`release-gate inventory summary: ${JSON.stringify(result.summary)}`);
  finish('release-gate step inventory ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
