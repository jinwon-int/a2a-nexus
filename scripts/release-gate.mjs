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

// Build/compile steps must finish before validators that load their output
// (test:conformance and runner-import-smoke import compiled package dist/), so
// they run first as a sequential, fail-fast barrier. The remaining validators
// are independent and read-only, so they fan out in parallel. Output is
// buffered per step and flushed in selection order to keep logs deterministic.
// Set RELEASE_GATE_CONCURRENCY=1 to force a fully sequential run.
const BARRIER_FIRST = new Set(['packages']);
const concurrency = (() => {
  const raw = Number.parseInt(process.env.RELEASE_GATE_CONCURRENCY ?? '', 10);
  if (Number.isInteger(raw) && raw > 0) return raw;
  return Math.max(1, Math.min(os.cpus().length, 8));
})();

const barrierSteps = steps.filter((step) => BARRIER_FIRST.has(step.name));
const parallelSteps = steps.filter((step) => !BARRIER_FIRST.has(step.name));

function runStep(step, { buffer }) {
  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, buffer ? {} : { stdio: 'inherit' });
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

// Barrier phase: sequential, fail-fast, live output.
for (const step of barrierSteps) {
  console.log(`release gate: ${step.name} [${step.tier}] (build barrier)`);
  const { status, error } = await runStep(step, { buffer: false });
  if (error) fail(`${step.name} failed to spawn: ${error}`);
  if (status !== 0) process.exit(status);
}

// Parallel phase: bounded concurrency, buffered output, run all then aggregate.
const completed = new Map();
let cursor = 0;
async function worker() {
  while (cursor < parallelSteps.length) {
    const step = parallelSteps[cursor++];
    const result = await runStep(step, { buffer: true });
    completed.set(step.name, result);
  }
}
await Promise.all(
  Array.from({ length: Math.min(concurrency, parallelSteps.length || 1) }, worker),
);

const failures = [];
for (const step of parallelSteps) {
  const result = completed.get(step.name);
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
