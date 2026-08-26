#!/usr/bin/env node
import { spawn } from 'node:child_process';
import os from 'node:os';

import {
  loadReleaseGateInventory,
  parseReleaseGateArgs,
  selectReleaseGateEntries,
  summarizeReleaseGateEntries,
} from './lib/release-gate-steps.mjs';

function fail(message) {
  console.error(`release gate: ${message}`);
  process.exit(1);
}

let options;
let inventory;
let steps;
try {
  options = parseReleaseGateArgs(process.argv.slice(2));
  inventory = loadReleaseGateInventory();
  steps = selectReleaseGateEntries(inventory, options);
} catch (err) {
  fail(err.message);
}

const summary = summarizeReleaseGateEntries(steps);
const tierLabel = options.all ? 'all tiers' : options.tiers.join(', ');

if (options.list) {
  for (const step of steps) {
    console.log(`${step.name}\t${step.tier}\t${step.command} ${step.args.join(' ')}`);
  }
  console.log(`release gate selected ${steps.length}/${inventory.entries.length} step(s) (${tierLabel}): ${JSON.stringify(summary)}`);
  process.exit(0);
}

console.log(`release gate selected ${steps.length}/${inventory.entries.length} step(s) (${tierLabel}): ${JSON.stringify(summary)}`);

// The `packages` step compiles every workspace (tsc into each package's
// dist/). Most validators are read-only and independent of that output, so
// they fan out immediately; only the steps below declare a dependency edge on
// `packages` because they load or build compiled dist themselves:
//   - contract-conformance-fixtures: two conformance checks import broker and
//     docker-runner dist and would otherwise race their own `npm run build -w`
//     against the workspace compile on a cold cache;
//   - a2ad-finalizer-lineage-evidence: its broker wave-evidence conformance
//     pin imports broker dist and silently skips when dist is absent.
// Dependency roots start immediately and run concurrently with the pool
// (live output); dependent steps wait for their root inside the pool and are
// reported as failed without running when the root fails, so a red `packages`
// still fails the gate. Output of pooled steps is buffered and flushed in
// selection order to keep logs deterministic. Set RELEASE_GATE_CONCURRENCY=1
// to force a fully sequential run (roots first, then each pooled step).
const STEP_DEPENDENCIES = {
  'contract-conformance-fixtures': ['packages'],
  'a2ad-finalizer-lineage-evidence': ['packages'],
};

const concurrency = (() => {
  const raw = Number.parseInt(process.env.RELEASE_GATE_CONCURRENCY ?? '', 10);
  if (Number.isInteger(raw) && raw > 0) return raw;
  return Math.max(1, Math.min(os.cpus().length, 8));
})();

const selectedNames = new Set(steps.map((step) => step.name));
const dependencyRoots = new Set(
  Object.entries(STEP_DEPENDENCIES)
    .filter(([name]) => selectedNames.has(name))
    .flatMap(([, deps]) => deps.filter((dep) => selectedNames.has(dep))),
);
const rootSteps = steps.filter((step) => dependencyRoots.has(step.name));
const pooledSteps = steps.filter((step) => !dependencyRoots.has(step.name));

function stepEnv(step) {
  // The conformance runner nests its own bounded pool inside this one; hand it
  // a reduced budget so the two pools do not multiply. An explicit operator
  // A2A_CONFORMANCE_CONCURRENCY always wins.
  if (step.name === 'contract-conformance-fixtures' && !process.env.A2A_CONFORMANCE_CONCURRENCY) {
    return {
      ...process.env,
      A2A_CONFORMANCE_CONCURRENCY: String(Math.max(2, Math.ceil(concurrency / 2))),
    };
  }
  return process.env;
}

function runStep(step, { buffer }) {
  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, {
      env: stepEnv(step),
      ...(buffer ? {} : { stdio: 'inherit' }),
    });
    const chunks = [];
    if (buffer) {
      child.stdout.on('data', (c) => chunks.push(c));
      child.stderr.on('data', (c) => chunks.push(c));
    }
    child.on('error', (err) => resolve({ step, status: 1, error: err.message, output: '' }));
    child.on('close', (code) =>
      resolve({ step, status: code ?? 1, output: Buffer.concat(chunks).toString('utf8') }),
    );
  });
}

// One completion promise per step so dependents can await their roots
// regardless of dispatch order.
const completions = new Map(steps.map((step) => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return [step.name, { promise, resolve }];
}));

async function executeStep(step, { buffer }) {
  const deps = (STEP_DEPENDENCIES[step.name] ?? []).filter((dep) => selectedNames.has(dep));
  const depResults = await Promise.all(deps.map((dep) => completions.get(dep).promise));
  const failedDep = deps.find((dep, index) => depResults[index].status !== 0);
  const result = failedDep !== undefined
    ? { step, status: 1, output: `${step.name} skipped: dependency ${failedDep} failed\n` }
    : await runStep(step, { buffer });
  completions.get(step.name).resolve(result);
  return result;
}

function startRoot(step) {
  console.log(`release gate: ${step.name} [${step.tier}] (dependency root)`);
  return executeStep(step, { buffer: false });
}

const rootRuns = [];
for (const step of rootSteps) {
  if (concurrency === 1) await startRoot(step);
  else rootRuns.push(startRoot(step));
}

// Pool phase: bounded concurrency, longest-first dispatch (weightMs) so the
// known-long steps do not land last on an otherwise drained pool. Reporting
// below stays in selection order; only dispatch order changes.
const dispatchOrder = [...pooledSteps].sort((a, b) => (b.weightMs ?? 0) - (a.weightMs ?? 0));
let cursor = 0;
async function worker() {
  while (cursor < dispatchOrder.length) {
    const step = dispatchOrder[cursor++];
    await executeStep(step, { buffer: true });
  }
}
await Promise.all(
  Array.from({ length: Math.min(concurrency, dispatchOrder.length || 1) }, worker),
);
await Promise.all(rootRuns);

const failures = [];
for (const step of steps) {
  const result = await completions.get(step.name).promise;
  console.log(`release gate: ${step.name} [${step.tier}]${result.status === 0 ? '' : ' (FAILED)'}`);
  if (result.error) console.error(`${step.name} failed to spawn: ${result.error}`);
  if (result.output.length) {
    process.stdout.write(result.output.endsWith('\n') ? result.output : `${result.output}\n`);
  }
  if (result.status !== 0) failures.push(step.name);
}

if (failures.length) {
  fail(`${failures.length} step(s) failed: ${failures.join(', ')}`);
}

console.log('release gate ok');
