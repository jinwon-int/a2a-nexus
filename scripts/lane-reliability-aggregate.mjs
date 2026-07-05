#!/usr/bin/env node
/**
 * Lane reliability ledger aggregator (#1299 M1).
 *
 * Converts offline finalizer/broker task readbacks into anonymous, report-only
 * ledger entries. It is intentionally manual: no dispatch routing changes, no
 * live broker calls, no GitHub writes, and no automatic consumption of scores.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { EVIDENCE_CLASSES } from './a2ad-finalizer-gate.mjs';
import { evaluateLaneReliabilityLedger, summarizeLaneReliabilityLedger } from './check-lane-reliability-ledger.mjs';

const evidenceSet = new Set(EVIDENCE_CLASSES);

function usage(exitCode = 1) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`Usage: node scripts/lane-reliability-aggregate.mjs --input <tasks.json> --ledger <ledger.json> --output <ledger.json> --adapter-class <class> --model-class <class> --task-class <class> --window YYYY-MM [--round-id <id>]\n`);
  process.exit(exitCode);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));
}

function taskItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.items)) return parsed.items;
  if (Array.isArray(parsed?.tasks)) return parsed.tasks;
  if (Array.isArray(parsed?.lanes)) return parsed.lanes;
  throw new Error('--input must be a JSON array or an object with items/tasks/lanes');
}

function slug(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function entryId(axis) {
  return `lr-${slug(axis.adapterClass)}-${slug(axis.modelClass)}-${slug(axis.taskClass)}-${slug(axis.window)}`;
}

function getOutput(task) {
  return task.output ?? task.result?.output ?? task.result ?? {};
}

function evidenceClassOf(task) {
  const output = getOutput(task);
  const explicit = task.evidenceClass ?? output.evidenceClass ?? task.result?.evidenceClass;
  if (hasText(explicit)) return String(explicit).trim();
  throw new Error(`missing evidence class for task ${task.id ?? '<no id>'}; run the finalizer gate/classifier first instead of inferring from status`);
}

function validationItems(task) {
  const output = getOutput(task);
  const values = [];
  if (Array.isArray(task.validations)) values.push(...task.validations);
  if (Array.isArray(output.validations)) values.push(...output.validations);
  if (task.validation && typeof task.validation === 'object') values.push(task.validation);
  if (output.validation && typeof output.validation === 'object') values.push(output.validation);
  return values;
}

function verdictPass(validation) {
  const verdict = String(validation.verdict ?? validation.status ?? '').trim().toLowerCase();
  if (['pass', 'passed', 'ok', 'success', 'succeeded'].includes(verdict)) return true;
  if (validation.pass === true || validation.ok === true) return true;
  if (validation.metrics?.acceptance === true) return true;
  return false;
}

function validationCounts(task) {
  const counts = { acceptancePassCount: 0, acceptanceFailCount: 0, reviewPassCount: 0 };
  for (const validation of validationItems(task)) {
    const kind = String(validation.kind ?? '').trim().toLowerCase();
    if (kind === 'acceptance' || validation.metrics?.acceptance !== undefined) {
      if (verdictPass(validation)) counts.acceptancePassCount += 1;
      else counts.acceptanceFailCount += 1;
    }
    if (kind === 'review' && verdictPass(validation)) counts.reviewPassCount += 1;
  }
  return counts;
}

function roundIdOf(task, fallback) {
  return task.parentRoundId ?? task.payload?.parentRoundId ?? task.roundId ?? task.payload?.roundId ?? fallback ?? null;
}

function resolveAxis(task, opts) {
  const payload = task.payload ?? {};
  const reliability = payload.reliability ?? getOutput(task).reliability ?? {};
  return {
    adapterClass: opts.adapterClass ?? reliability.adapterClass ?? payload.adapterClass ?? 'unknown-adapter',
    modelClass: opts.modelClass ?? reliability.modelClass ?? payload.modelClass ?? 'unknown-model',
    taskClass: opts.taskClass ?? reliability.taskClass ?? payload.taskClass ?? payload.intent ?? task.intent ?? 'unknown-task',
    window: opts.window ?? reliability.window,
  };
}

function emptyEntry(axis) {
  return {
    id: entryId(axis),
    adapterClass: axis.adapterClass,
    modelClass: axis.modelClass,
    taskClass: axis.taskClass,
    window: axis.window,
    dispatchedCount: 0,
    substantiveCount: 0,
    acceptancePassCount: 0,
    acceptanceFailCount: 0,
    reviewPassCount: 0,
    evidenceClassBreakdown: {},
    sourceRoundIds: [],
  };
}

export function aggregateLaneReliability({ ledger, tasks, adapterClass, modelClass, taskClass, window, roundId }) {
  if (!hasText(window)) throw new Error('window is required');
  const output = structuredClone(ledger ?? { entries: [] });
  if (!Array.isArray(output.entries)) output.entries = [];
  const entryById = new Map(output.entries.map((entry) => [entry.id, entry]));
  const existingSourceRounds = new Set(output.entries.flatMap((entry) => Array.isArray(entry.sourceRoundIds) ? entry.sourceRoundIds : []));
  const touchedSourceRoundsByEntryId = new Map();

  for (const task of tasks) {
    const sourceRoundId = roundIdOf(task, roundId);
    if (hasText(sourceRoundId) && existingSourceRounds.has(sourceRoundId)) continue;
    const axis = resolveAxis(task, { adapterClass, modelClass, taskClass, window });
    const id = entryId(axis);
    let entry = entryById.get(id);
    if (!entry) {
      entry = emptyEntry(axis);
      output.entries.push(entry);
      entryById.set(id, entry);
    }

    const evidenceClass = evidenceClassOf(task);
    if (!evidenceSet.has(evidenceClass)) {
      throw new Error(`unknown evidence class '${evidenceClass}' for task ${task.id ?? '<no id>'}`);
    }
    entry.dispatchedCount += 1;
    if (evidenceClass === 'substantive') entry.substantiveCount += 1;
    entry.evidenceClassBreakdown[evidenceClass] = (entry.evidenceClassBreakdown[evidenceClass] ?? 0) + 1;
    const counts = validationCounts(task);
    entry.acceptancePassCount += counts.acceptancePassCount;
    entry.acceptanceFailCount += counts.acceptanceFailCount;
    entry.reviewPassCount += counts.reviewPassCount;

    if (hasText(sourceRoundId)) {
      const touched = touchedSourceRoundsByEntryId.get(id) ?? new Set();
      touched.add(sourceRoundId);
      touchedSourceRoundsByEntryId.set(id, touched);
    }
  }

  for (const [id, sourceRoundIds] of touchedSourceRoundsByEntryId) {
    const entry = entryById.get(id);
    if (!entry) continue;
    for (const sourceRoundId of sourceRoundIds) {
      if (!entry.sourceRoundIds.includes(sourceRoundId)) entry.sourceRoundIds.push(sourceRoundId);
    }
  }
  output.entries.sort((a, b) => a.id.localeCompare(b.id));
  return output;
}

function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      ledger: { type: 'string', default: 'docs/ops/lane-reliability-ledger.json' },
      output: { type: 'string' },
      'adapter-class': { type: 'string' },
      'model-class': { type: 'string' },
      'task-class': { type: 'string' },
      window: { type: 'string' },
      'round-id': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) usage(0);
  if (!values.input) usage(1);
  const ledgerPath = values.ledger;
  const outputPath = values.output ?? ledgerPath;
  const ledger = fs.existsSync(path.resolve(process.cwd(), ledgerPath)) ? readJson(ledgerPath) : { entries: [] };
  const tasks = taskItems(readJson(values.input));
  const updated = aggregateLaneReliability({
    ledger,
    tasks,
    adapterClass: values['adapter-class'],
    modelClass: values['model-class'],
    taskClass: values['task-class'],
    window: values.window,
    roundId: values['round-id'],
  });
  const failures = evaluateLaneReliabilityLedger(updated);
  if (failures.length) {
    for (const failure of failures) console.error(failure);
    process.exit(1);
  }
  fs.writeFileSync(path.resolve(process.cwd(), outputPath), `${JSON.stringify(updated, null, 2)}\n`);
  const summary = summarizeLaneReliabilityLedger(updated);
  console.log(`lane reliability aggregate ok (${summary.entries} entries; dispatched=${summary.dispatchedCount}; substantive=${summary.substantiveCount})`);
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isDirectRun) main();
