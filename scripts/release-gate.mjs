#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

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

for (const step of steps) {
  console.log(`release gate: ${step.name} [${step.tier}]`);
  const result = spawnSync(step.command, step.args, { stdio: 'inherit' });
  if (result.error) {
    fail(`${step.name} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('release gate ok');
