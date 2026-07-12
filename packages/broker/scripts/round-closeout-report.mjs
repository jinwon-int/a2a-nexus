#!/usr/bin/env node
/**
 * Operator-facing A2A/A2AD round closeout report.
 * Source-only/offline: reads a task snapshot JSON file and emits JSON or Markdown.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyEvidenceRecord } from './a2ad-evidence-classifier.mjs';
import { encodeMarkdownCell } from './lib/markdown-cell.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'blocked']);

function option(name) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage() {
  return [
    'Usage: node scripts/round-closeout-report.mjs --round-id ID --tasks tasks.json [--json|--markdown] [--out-dir DIR]',
    '',
    'Reads local task snapshots only. No broker writes, provider sends, DB/ACK/replay, deploy/restart, or secrets.',
  ].join('\n');
}

function extractTasks(snapshot) {
  if (Array.isArray(snapshot)) return snapshot;
  if (Array.isArray(snapshot?.items)) return snapshot.items;
  if (Array.isArray(snapshot?.tasks)) return snapshot.tasks;
  throw new Error('tasks snapshot must be an array or object with .items/.tasks');
}

function safeText(value) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text
    .replace(/(?:ghp|gho|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g, '[REDACTED:gh-token]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[REDACTED:api-key]')
    .replace(/AKIA[A-Z0-9]{16}/g, '[REDACTED:aws-key]')
    .replace(/Bearer [A-Za-z0-9._-]{20,}/g, 'Bearer [REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:pem-begin]');
}

function outputOf(task) {
  return task?.output && typeof task.output === 'object' ? task.output :
    (task?.result?.output && typeof task.result.output === 'object' ? task.result.output : undefined);
}

function sourceProjectionBlocker(sourceProjection) {
  const quality = String(sourceProjection?.quality ?? '').trim();
  if (!quality) return null;
  if (['zero_files', 'missing_required', 'missing', 'failed'].includes(quality)) {
    return `source projection quality=${quality}; supplement or rerun required before this lane counts as worker opinion`;
  }
  return null;
}

function failureReason(task, output, evidence, projectionBlocker) {
  const err = task?.error ?? task?.result?.error ?? output?.error;
  if (err) return safeText(err.code ?? err.message ?? err).slice(0, 240);
  if (projectionBlocker) return projectionBlocker;
  if (!evidence.countsAsWorkerOpinion && evidence.blockers?.length) return safeText(evidence.blockers.join('; ')).slice(0, 240);
  if (!TERMINAL.has(String(task?.status ?? ''))) return 'pending: task is not terminal';
  return '';
}

function laneRow(task, index) {
  const output = outputOf(task);
  const evidence = classifyEvidenceRecord(task, index);
  const status = String(task?.status ?? 'missing');
  const order = task?.payload?.parentRoundOrder ?? task?.parentRoundOrder ?? null;
  const worker = task?.assignedWorkerId ?? task?.targetNodeId ?? task?.worker ?? evidence.workerId;
  const sourceProjection = output?.sourceProjection ?? task?.sourceProjection ?? null;
  const projectionBlocker = sourceProjectionBlocker(sourceProjection);
  const evidenceQuality = projectionBlocker ? `source_projection_${sourceProjection.quality}` : evidence.classification;
  const countsAsWorkerOpinion = projectionBlocker ? false : Boolean(evidence.countsAsWorkerOpinion);
  return {
    parentRoundOrder: order,
    taskId: task?.id ?? evidence.taskId ?? `missing-${index + 1}`,
    workerId: worker,
    status,
    terminal: TERMINAL.has(status),
    evidenceQuality,
    substantive: projectionBlocker ? false : Boolean(evidence.substantive),
    countsAsWorkerOpinion,
    failureReason: failureReason(task, output, evidence, projectionBlocker),
    sourceProjectionQuality: sourceProjection?.quality ?? null,
    supplementOf: task?.payload?.supplementOf ?? null,
    supersedesTaskId: task?.payload?.supersedesTaskId ?? null,
  };
}

function summarize(rows) {
  return {
    total: rows.length,
    terminal: rows.filter((r) => r.terminal).length,
    succeeded: rows.filter((r) => r.status === 'succeeded').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    blocked: rows.filter((r) => r.status === 'blocked').length,
    pending: rows.filter((r) => !r.terminal).length,
    substantive: rows.filter((r) => r.substantive).length,
    nonSubstantive: rows.filter((r) => !r.countsAsWorkerOpinion).length,
  };
}

function renderMarkdown(report) {
  const rows = report.lanes.map((r) => [
    r.parentRoundOrder ?? '', r.workerId, r.taskId, r.status, r.evidenceQuality,
    r.sourceProjectionQuality ?? '', r.failureReason || '', r.supplementOf ?? ''
  ]);
  return [
    `# A2A round closeout: ${report.roundId}`,
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    '',
    `- total: ${report.summary.total}`,
    `- succeeded: ${report.summary.succeeded}`,
    `- failed: ${report.summary.failed}`,
    `- pending: ${report.summary.pending}`,
    `- nonSubstantive: ${report.summary.nonSubstantive}`,
    '',
    '## Lanes',
    '',
    '| order | worker | task | status | evidence | source | reason | supplementOf |',
    '|---:|---|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.map((cell) => encodeMarkdownCell(cell)).join(' | ')} |`),
    '',
    'Safety: local snapshot report only; no broker writes, live actions, provider sends, DB/ACK/replay, releases, or secrets.',
    '',
  ].join('\n');
}

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage());
    return;
  }
  const roundId = option('--round-id');
  const tasksPath = option('--tasks');
  if (!roundId || !tasksPath) throw new Error('missing --round-id or --tasks');
  const tasks = extractTasks(JSON.parse(readFileSync(tasksPath, 'utf8')));
  const lanes = tasks.map(laneRow).sort((a, b) => (a.parentRoundOrder ?? 9999) - (b.parentRoundOrder ?? 9999) || a.taskId.localeCompare(b.taskId));
  const report = { schemaVersion: 'a2a-round-closeout.v1', roundId, generatedAt: new Date().toISOString(), summary: summarize(lanes), lanes };
  const asMarkdown = process.argv.includes('--markdown');
  const rendered = asMarkdown ? renderMarkdown(report) : JSON.stringify(report, null, 2);
  const outDir = option('--out-dir');
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'closeout.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(outDir, 'closeout.md'), renderMarkdown(report));
  }
  console.log(rendered);
}

try { main(); } catch (error) {
  console.error('round-closeout-report: ' + safeText(error?.message ?? error));
  process.exit(1);
}
