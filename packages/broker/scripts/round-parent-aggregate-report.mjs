#!/usr/bin/env node
// Source-only bridge from broker round task snapshots to parent aggregate comment input (#629).
//
// Reads a task snapshot JSON array (or {items}/{tasks}) and emits the taskReport
// shape consumed by parent-aggregate-comment.mjs. This script performs no GitHub
// writes, broker DB mutations, provider sends, deploys, restarts, ACK/replay, or
// secret movement.

import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { buildRoundParentAggregateTaskReport } from '../dist/core/round-status.js';

function readOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function usage() {
  return [
    'Usage: node scripts/round-parent-aggregate-report.mjs --round-id ID --tasks tasks.json [--generated-at ISO]',
    '',
    'Emits parent-aggregate-comment taskReport JSON. Source-only: no live writes.',
  ].join('\n');
}

function extractTasks(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (Array.isArray(snapshot?.items)) return snapshot.items;
  if (Array.isArray(snapshot?.tasks)) return snapshot.tasks;
  throw new Error('tasks snapshot must be an array or an object with .items/.tasks array');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return;
  }
  const roundId = readOption(argv, '--round-id') ?? readOption(argv, '--parent-round-id');
  const tasksPath = readOption(argv, '--tasks');
  const generatedAt = readOption(argv, '--generated-at');
  if (!roundId || !tasksPath) {
    console.error(usage());
    process.exit(2);
  }

  const snapshot = JSON.parse(await readFile(tasksPath, 'utf8'));
  const report = buildRoundParentAggregateTaskReport(extractTasks(snapshot), roundId, { generatedAt });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('round-parent-aggregate-report: ' + message.replace(/\b(TOKEN|SECRET|KEY|PASSWORD)=\S+/gi, '$1=[redacted]'));
  process.exit(1);
});
