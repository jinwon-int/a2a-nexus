#!/usr/bin/env node
/**
 * Regrowth guard for the development-orchestration surface (a2a-nexus#882 §3).
 *
 * The repo accumulated one-off scripts and per-round npm wrappers faster than
 * it consolidated them. This gate freezes three counts at a budget:
 *   - top-level scripts/*.mjs validators (excludes scripts/lib/)
 *   - root package.json "scripts"
 *   - packages/broker/package.json "scripts"
 *
 * Adding a new one-off fails the gate. The intended responses are, in order of
 * preference: (1) consolidate onto an existing engine/helper so the count stays
 * flat, or (2) deliberately raise the relevant budget below with a one-line
 * justification in the PR. The budget only ever ratchets — lower it as cleanup
 * lands so the surface cannot silently regrow.
 *
 * Safety: read-only counting. No repo import, release, publish, visibility,
 * live dispatch, restart, credential, DB, or Terminal ACK action is performed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDocCheckContext } from './lib/doc-check.mjs';

// Budgets reflect the count after the release-gate tier inventory runner and
// its regression test were added. Raising any budget is allowed but must be
// deliberate — see a2a-nexus#882.
export const BUDGETS = {
  scriptsMjs: 154, // +2: #1304 M6-b spec<->broker conformance checker + test — the issue explicitly scopes the CI gate as a new scripts/*.mjs surface (prior raise: #1301 checker pair)
  rootNpmScripts: 100, // ratcheted after C3 historical archive wrappers were consolidated under check:historical (#1201)
  brokerNpmScripts: 150, // includes broker clean:dist stale-build guard from #997/#999 closeout
};

/** Count top-level *.mjs files in a directory (non-recursive; excludes subdirs like lib/). */
export function countTopLevelMjs(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs')).length;
}

function countPackageScripts(rel, readJson) {
  const pkg = readJson(rel);
  return pkg && pkg.scripts ? Object.keys(pkg.scripts).length : 0;
}

/**
 * Pure budget evaluation, separated from filesystem access so it can be tested
 * with synthetic inputs.
 */
export function evaluateBudgets(counts, budgets = BUDGETS) {
  const failures = [];
  const over = (label, actual, budget, hint) => {
    if (actual > budget) {
      failures.push(
        `${label}: ${actual} exceeds budget ${budget}. ${hint} ` +
          `or raise the budget in scripts/check-script-budget.mjs with justification (a2a-nexus#882).`,
      );
    }
  };
  over(
    'scripts/*.mjs',
    counts.scriptsMjs,
    budgets.scriptsMjs,
    'Consolidate onto a shared engine/helper (e.g. scripts/lib/doc-check.mjs)',
  );
  over(
    'root package.json scripts',
    counts.rootNpmScripts,
    budgets.rootNpmScripts,
    'Reuse an existing script or call the .mjs directly',
  );
  over(
    'broker package.json scripts',
    counts.brokerNpmScripts,
    budgets.brokerNpmScripts,
    'Reuse an existing script or call the .mjs directly',
  );
  return { ok: failures.length === 0, failures };
}

export function collectCounts(root) {
  const readJson = (rel) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
    } catch {
      return null;
    }
  };
  return {
    scriptsMjs: countTopLevelMjs(path.join(root, 'scripts')),
    rootNpmScripts: countPackageScripts('package.json', readJson),
    brokerNpmScripts: countPackageScripts('packages/broker/package.json', readJson),
  };
}

function main() {
  const { fail, finish } = createDocCheckContext({ name: 'script budget guard' });
  const counts = collectCounts(process.cwd());
  console.log(
    `script budget: scripts/*.mjs=${counts.scriptsMjs}/${BUDGETS.scriptsMjs} ` +
      `root=${counts.rootNpmScripts}/${BUDGETS.rootNpmScripts} ` +
      `broker=${counts.brokerNpmScripts}/${BUDGETS.brokerNpmScripts}`,
  );
  const { failures } = evaluateBudgets(counts);
  for (const message of failures) fail(message);
  finish('script budget ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
