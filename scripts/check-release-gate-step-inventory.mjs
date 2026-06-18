#!/usr/bin/env node
/**
 * Report-only release-gate step inventory guard (#880/#882).
 *
 * This intentionally does not retire or skip any release-gate step. It checks
 * that docs/ops/release-gate-step-inventory.json stays in lockstep with the
 * executable steps in scripts/release-gate.mjs, so future tiering/removal PRs
 * start from source-backed data rather than ad-hoc prose.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createDocCheckContext } from './lib/doc-check.mjs';

const VALID_TIERS = new Set([
  'core',
  'public-readiness',
  'historical-transition',
  'approval-gated',
  'package-publication',
]);

const VALID_RETIREMENT = new Set(['keep', 'candidate-after-review', 'manual-approval-required']);

export function extractReleaseGateSteps(source) {
  const steps = [];
  const pattern = /^\s*\['([^']+)',\s*'([^']+)',\s*\[(.*?)\]\],/gm;
  for (const match of source.matchAll(pattern)) {
    const [, name, command, argSource] = match;
    const args = [...argSource.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    steps.push({ name, command, args });
  }
  return steps;
}

export function compareInventory({ releaseGateSource, inventory }) {
  const failures = [];
  const steps = extractReleaseGateSteps(releaseGateSource);
  if (steps.length === 0) failures.push('release-gate.mjs step parser found no steps');
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
    return { ok: false, failures: ['inventory must be a JSON object'], summary: null };
  }
  if (inventory.generatedFrom !== 'scripts/release-gate.mjs') {
    failures.push('inventory.generatedFrom must be scripts/release-gate.mjs');
  }
  if (!Array.isArray(inventory.entries)) {
    failures.push('inventory.entries must be an array');
    return { ok: false, failures, summary: null };
  }
  if (inventory.entries.length !== steps.length) {
    failures.push(`inventory has ${inventory.entries.length} entries but release-gate has ${steps.length} steps`);
  }

  const names = new Set();
  const summary = Object.create(null);
  const byName = new Map(inventory.entries.map((entry) => [entry && entry.name, entry]));

  for (const [index, step] of steps.entries()) {
    const entry = byName.get(step.name);
    if (!entry) {
      failures.push(`missing inventory entry for release-gate step ${step.name}`);
      continue;
    }
    if (names.has(entry.name)) failures.push(`duplicate inventory entry for ${entry.name}`);
    names.add(entry.name);
    if (inventory.entries[index]?.name !== step.name) {
      failures.push(`inventory order mismatch at #${index}: expected ${step.name}, got ${inventory.entries[index]?.name}`);
    }
    if (entry.command !== step.command) failures.push(`${step.name}: command mismatch`);
    if (JSON.stringify(entry.args) !== JSON.stringify(step.args)) failures.push(`${step.name}: args mismatch`);
    if (!VALID_TIERS.has(entry.tier)) failures.push(`${step.name}: invalid tier ${entry.tier}`);
    if (!VALID_RETIREMENT.has(entry.retirement)) failures.push(`${step.name}: invalid retirement ${entry.retirement}`);
    if (typeof entry.note !== 'string' || entry.note.length < 20) failures.push(`${step.name}: note must explain classification`);
    summary[entry.tier] = (summary[entry.tier] ?? 0) + 1;
  }

  return { ok: failures.length === 0, failures, summary };
}

function main() {
  const { parseJson, readRel, fail, finish } = createDocCheckContext({
    name: 'release-gate step inventory',
  });
  const inventory = parseJson('docs/ops/release-gate-step-inventory.json');
  const releaseGateSource = readRel('scripts/release-gate.mjs');
  if (releaseGateSource === null) fail('missing scripts/release-gate.mjs');
  const result = compareInventory({ releaseGateSource: releaseGateSource ?? '', inventory });
  for (const message of result.failures) fail(message);
  console.log(`release-gate inventory summary: ${JSON.stringify(result.summary)}`);
  finish('release-gate step inventory ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
