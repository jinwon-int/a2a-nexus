#!/usr/bin/env node
/**
 * Regrowth guard for the development-orchestration surface (a2a-nexus#882 §3,
 * extended for broker core modules in #1601).
 *
 * The repo accumulated one-off scripts and per-round npm wrappers faster than
 * it consolidated them. This gate freezes five counts at a budget:
 *   - top-level scripts/*.mjs validators (excludes scripts/lib/)
 *   - root package.json "scripts"
 *   - packages/broker/package.json "scripts"
 *   - packages/broker/src/core non-test modules
 *   - the ceremony-named subset of those core modules
 *
 * Adding a new one-off fails the gate. The intended responses are, in order of
 * preference: (1) consolidate onto an existing engine/helper so the count stays
 * flat, or (2) deliberately raise the relevant budget below with a one-line
 * justification in the PR. The budget only ever ratchets — lower it as cleanup
 * lands so the surface cannot silently regrow.
 *
 * On the ceremony budget specifically (#1601): the broker accumulated ~45
 * modules — `*-approval-request`, `*-receipt-ingestor`, `*-preflight-*`,
 * `*-rehearsal`, `*-dry-run-start-*` — that are not features. They are the
 * steps of one operator approval procedure, each rendered as a separate
 * TypeScript module by a separate A2A round. The cost is not the lines; it is
 * that changing the procedure then requires a compile, a test, a review, and a
 * merge. Approval steps belong in the policy document the broker already
 * enforces (`a2a.broker.policy.v1`), as data. This budget does not forbid the
 * existing modules — it freezes them, so the next round has to consolidate
 * rather than append.
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
  scriptsMjs: 159, // -2 from 161: the split-repo-local-demo conformance checker and its test retire with the demo. The demo walked a three-package split-repo story; one of those packages (openclaw-plugin-a2a) is gone and the split repos are provenance mirrors, so the topology it described no longer exists.
  rootNpmScripts: 81, // -1 from 82: check:split-repo-local-demo goes with its checker. check:repo-protection-baseline:test also drops the split-repo test file it used to co-run.
  brokerNpmScripts: 55, // +1 from 54: #1766 adds build:image, the verified image-build entrypoint (preflight -> docker compose build). Deliberate: it is a build entrypoint, not a per-round wrapper, and it cannot fold into `build` — `build` also runs inside the Docker build stage, where invoking docker again is impossible. -43 from 95: #1503 Wave 2 collapses the orchestration-intelligence (21) and rollout-preflight (24→22; rollout_guard and worker_signature_rollout_preflight stay direct as manifest-required gates) aliases into the orchestration/rollout dispatchers sharing scripts/lib/operator-dispatch.mjs; scan:public-readiness stays direct (CI parity requiredScript).
  brokerCoreModules: 179, // +1 from 178: #1800 slice 5 adds core/wave-plan-dag-v2-mode.ts — a two-line rollout-mode resolver whose posture (off default, invalid env throws at startup) must match review-lineage-store's resolver one-for-one; folding it there would couple an independent contract's gate to another domain's module. // +1 from 177: #1863 C3 slice 1 adds core/broker-conversation-task-bridge.ts — the task-lifecycle bridge (result projection + input-required resume) is a distinct concern from the envelope domain and the cross-broker relay. // -38 from 213: #1665 retires the terminal-brief sidecar activation ceremony. Two weeks of instrumentation on both brokers recorded zero real invocations of the 37 sidecar routes, with a control probe re-established on each to prove the probe fires. terminal-brief-sidecar-integration-rehearsal stays — it is reached from the live finalizer workflow, not from the ceremony chain.
  brokerCoreCeremonyModules: 21, // -22 from 43: the same retirement. This budget was frozen and never raised on the argument that an approval step belongs in the broker policy document as data, not as a module. This is the first time it moves, and it moves down by half.
};

/**
 * Filename markers for modules that encode a step of an operator approval
 * procedure rather than a broker capability.
 *
 * Deliberately narrow: `gate` and `closeout` are excluded because they also
 * name genuine lifecycle behaviour (`terminal-brief-closeout-gate` decides
 * whether a round is complete). Every marker here names a stage of a
 * human-approval workflow, which is the thing that should be declared as
 * policy data instead of authored as code.
 */
export const CEREMONY_MODULE_MARKERS = [
  'approval',
  'rehearsal',
  'preflight',
  'dry-run',
  'receipt-ingestor',
  'evidence-collector',
  'review-decision',
  'canary-plan',
  'grant-proposal',
];

const CEREMONY_MODULE_PATTERN = new RegExp(CEREMONY_MODULE_MARKERS.join('|'));

/** True when a core module filename encodes an approval-ceremony stage. */
export function isCeremonyModule(relativePath) {
  return CEREMONY_MODULE_PATTERN.test(relativePath);
}

/** Count top-level *.mjs files in a directory (non-recursive; excludes subdirs like lib/). */
export function countTopLevelMjs(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs')).length;
}

/**
 * List non-test *.ts files under a directory, recursively, as paths relative
 * to that directory. Returns [] when the directory is absent so the guard can
 * run from a checkout that does not contain the broker package.
 */
export function listCoreModules(dir) {
  const out = [];
  const walk = (current, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), rel);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(rel);
      }
    }
  };
  walk(dir, '');
  return out;
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
  over(
    'broker core modules',
    counts.brokerCoreModules,
    budgets.brokerCoreModules,
    'Fold the new behaviour into a cohesive existing core module',
  );
  over(
    'broker core ceremony modules',
    counts.brokerCoreCeremonyModules,
    budgets.brokerCoreCeremonyModules,
    'Declare the approval/rehearsal/preflight step in the broker policy document ' +
      '(a2a.broker.policy.v1) as data instead of adding a module',
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
  const coreModules = listCoreModules(path.join(root, 'packages/broker/src/core'));
  return {
    scriptsMjs: countTopLevelMjs(path.join(root, 'scripts')),
    rootNpmScripts: countPackageScripts('package.json', readJson),
    brokerNpmScripts: countPackageScripts('packages/broker/package.json', readJson),
    brokerCoreModules: coreModules.length,
    brokerCoreCeremonyModules: coreModules.filter(isCeremonyModule).length,
  };
}

function main() {
  const { fail, finish } = createDocCheckContext({ name: 'script budget guard' });
  const counts = collectCounts(process.cwd());
  console.log(
    `script budget: scripts/*.mjs=${counts.scriptsMjs}/${BUDGETS.scriptsMjs} ` +
      `root=${counts.rootNpmScripts}/${BUDGETS.rootNpmScripts} ` +
      `broker=${counts.brokerNpmScripts}/${BUDGETS.brokerNpmScripts} ` +
      `core=${counts.brokerCoreModules}/${BUDGETS.brokerCoreModules} ` +
      `core-ceremony=${counts.brokerCoreCeremonyModules}/${BUDGETS.brokerCoreCeremonyModules}`,
  );
  const { failures } = evaluateBudgets(counts);
  for (const message of failures) fail(message);
  finish('script budget ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
