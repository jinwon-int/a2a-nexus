#!/usr/bin/env node
/**
 * Decision dialectic hygiene monitor (#1295 DA3).
 *
 * Read-only monitor: reports non-terminal decision.dialectic records whose
 * meta.expiresAt has passed. It never mutates broker state; transition to
 * EXPIRED must happen through an authorized route/finalizer.
 */
import fs from 'node:fs';
import process from 'node:process';

export const NON_TERMINAL_STATES = [
  'OPEN',
  'THESIS_SUBMITTED',
  'ANTITHESIS_SUBMITTED',
  'REBUTTAL_SUBMITTED',
  'WAITING',
];

export const TERMINAL_STATES = [
  'DECISION_ROUTED',
  'ABSTAINED',
  'VETOED',
  'SETTLED',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
];

function parseInstant(value, field) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} is required`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`invalid ${field}: ${value}`);
  return ms;
}

function summarizeTopic(value) {
  const text = typeof value === 'string' && value.trim() ? value.trim().replace(/\s+/g, ' ') : '(untitled dialectic)';
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}

function normalizeRecords(input) {
  if (Array.isArray(input)) return input;
  if (input && Array.isArray(input.items)) return input.items;
  if (input && Array.isArray(input.records)) return input.records;
  if (input && Array.isArray(input.tasks)) return input.tasks;
  return null;
}

export function evaluateDialecticHygiene(input, options = {}) {
  const records = normalizeRecords(input);
  if (!records) {
    return {
      skipped: true,
      reason: 'no dialectic records available (provide --snapshot or broker read-model output)',
      candidates: [],
    };
  }
  const nowMs = parseInstant(options.now ?? new Date().toISOString(), 'now');
  const candidates = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    if (record.kind !== 'decision.dialectic' && record.contract?.kind !== 'decision.dialectic') continue;
    const dialectic = record.contract?.task && typeof record.contract.task === 'object' ? record.contract.task : record;
    const state = dialectic.state;
    if (!NON_TERMINAL_STATES.includes(state)) continue;
    const expiresAt = dialectic.meta?.expiresAt;
    const expiresAtMs = parseInstant(expiresAt, `expiresAt for ${dialectic.taskId ?? record.id ?? 'unknown dialectic'}`);
    if (expiresAtMs >= nowMs) continue;
    candidates.push({
      taskId: String(dialectic.taskId ?? record.id ?? '(unknown)'),
      state,
      expiresAt,
      ageHours: Number(((nowMs - expiresAtMs) / (60 * 60 * 1000)).toFixed(2)),
      topic: summarizeTopic(dialectic.meta?.topic),
      domain: dialectic.meta?.domain ?? null,
      urgency: dialectic.meta?.urgency ?? null,
      recommendedTransition: 'EXPIRED',
    });
  }
  return { skipped: false, candidates };
}

function parseArgs(argv) {
  const args = { snapshot: null, now: undefined, json: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--snapshot') args.snapshot = argv[++index];
    else if (arg === '--now') args.now = argv[++index];
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/check-dialectic-hygiene.mjs [--snapshot file.json] [--now ISO] [--json]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.snapshot) {
    const result = evaluateDialecticHygiene(null, { now: args.now });
    console.log(`decision dialectic hygiene: skipped (${result.reason})`);
    return 0;
  }
  const input = JSON.parse(fs.readFileSync(args.snapshot, 'utf8'));
  const result = evaluateDialecticHygiene(input, { now: args.now });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (result.skipped) console.log(`decision dialectic hygiene: skipped (${result.reason})`);
  else if (result.candidates.length === 0) console.log('decision dialectic hygiene ok (0 expired non-terminal candidate(s))');
  else {
    console.error(`decision dialectic hygiene found ${result.candidates.length} expired non-terminal candidate(s):`);
    for (const candidate of result.candidates) {
      console.error(`  - ${candidate.taskId} ${candidate.state} expired ${candidate.expiresAt} (${candidate.ageHours}h): ${candidate.topic}`);
    }
    return 1;
  }
  return 0;
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isDirectRun) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`decision dialectic hygiene errored: ${error.message}`);
    process.exit(1);
  }
}
