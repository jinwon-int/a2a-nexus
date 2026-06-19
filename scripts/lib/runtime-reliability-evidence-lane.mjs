#!/usr/bin/env node
/**
 * Runtime reliability evidence lane scaffolding for #921/#922.
 *
 * Source-only helpers for preparing a compact OpenClaw bridge retry packet and
 * classifying its outcome. This file intentionally does not dispatch tasks,
 * post provider messages, restart broker/worker services, replay DB/outbox
 * state, ACK Terminal Brief records, publish releases, or move secrets.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RELIABILITY_SOURCE_PATHS = [
  'docs/release-gate.md',
  'docs/ops/release-gate-step-inventory.json',
  'packages/broker/src/core/store.ts',
  'packages/broker/src/core/sqlite-worker-thread-persistence.ts',
  'packages/broker/src/server-persistence-ack.test.ts',
  'packages/broker/src/core/round-result-collector.ts',
  'scripts/a2a-dispatch-round.mjs',
];

export const RELIABILITY_FOCUS = [
  'persistence ack',
  'idempotency',
  'queue drain',
  'worker liveness',
  'release-gate inventory',
  'round-result collection',
];

export const PROHIBITED_RUNTIME_ACTIONS = [
  'broker restart/deploy',
  'DB mutation/replay',
  'live provider send',
  'release/tag/npm/Docker publish',
  'secret movement',
  'repo visibility change',
  'crossBroker mutation',
  'Terminal Brief ACK/replay',
];

const FORBIDDEN_OPENCLAW_RUNTIME_PATHS = new Set([
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
]);

function normalizeRepoPath(path) {
  return String(path ?? '').replace(/^\.\//, '').replace(/\\/g, '/');
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function clipText(value, maxChars) {
  if (value.length <= maxChars) return value;
  const marker = '\n/* clipped for compact runtime reliability source bundle */\n';
  return `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function safeReportText(value) {
  return String(value ?? '')
    .replace(/ACK\s+replay/gi, 'ACK-replay')
    .replace(/deploy\s+now/gi, 'deploy-now')
    .replace(/restart\s+now/gi, 'restart-now');
}

export function failClosedOnOpenClawRuntimePaths(paths) {
  return [...new Set((paths ?? [])
    .map(normalizeRepoPath)
    .filter((path) => FORBIDDEN_OPENCLAW_RUNTIME_PATHS.has(path) || path.startsWith('.openclaw/')))];
}

export function collectReliabilitySourceBundle(sourceFiles, options = {}) {
  const paths = options.paths ?? DEFAULT_RELIABILITY_SOURCE_PATHS;
  const maxChars = Math.max(256, options.maxChars ?? 24_000);
  const forbidden = failClosedOnOpenClawRuntimePaths(paths);
  if (forbidden.length > 0) {
    throw new Error(`OpenClaw runtime/bootstrap paths are forbidden in sourceBundle: ${forbidden.join(', ')}`);
  }

  const missing = [];
  const perFileBudget = Math.max(1, Math.floor(maxChars / paths.length));
  const files = [];
  let remaining = maxChars;

  for (const path of paths) {
    const content = sourceFiles?.[path];
    if (!hasText(content)) {
      missing.push(path);
      continue;
    }
    const budget = Math.max(1, Math.min(perFileBudget, remaining));
    const contentText = clipText(content, budget);
    remaining -= contentText.length;
    files.push({ path, contentText, charCount: contentText.length });
  }

  if (missing.length > 0) {
    throw new Error(`Missing reliability source file content: ${missing.join(', ')}`);
  }

  const totalChars = files.reduce((sum, file) => sum + file.charCount, 0);
  return {
    kind: 'a2a-nexus.runtime-reliability.sourceBundle',
    version: 1,
    focus: [...RELIABILITY_FOCUS],
    promptBudget: { maxChars, totalChars },
    totalChars,
    files,
  };
}

export function buildReliabilityEvidenceManifest({
  roundId,
  workerId = 'nosuk',
  sourceBundle,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!hasText(roundId)) throw new Error('roundId is required');
  if (!sourceBundle || !Array.isArray(sourceBundle.files) || sourceBundle.files.length === 0) {
    throw new Error('sourceBundle with files is required');
  }
  const forbidden = failClosedOnOpenClawRuntimePaths(sourceBundle.files.map((file) => file.path));
  if (forbidden.length > 0) {
    throw new Error(`OpenClaw runtime/bootstrap paths are forbidden in manifest sourceBundle: ${forbidden.join(', ')}`);
  }

  return {
    kind: 'a2a-nexus.runtime-reliability.evidenceLaneManifest',
    version: 1,
    roundId,
    generatedAt,
    issueLinks: ['#921', '#922'],
    targetWorkerId: workerId,
    sourceBundle,
    dispatch: {
      mode: 'read-only-analysis',
      noLive: true,
      sourceOnly: true,
      targetWorkerId: workerId,
      requiredAnalysis: {
        analysisKind: 'analysis_bridge',
        analysisStatus: 'done',
      },
      classifySeparately: ['worker_timeout', 'handler_failure', 'runtime_findings', 'no_runtime_findings'],
      prohibitedActions: [...PROHIBITED_RUNTIME_ACTIONS],
    },
  };
}

export function classifyReliabilityLaneResult(result) {
  const status = result?.status;
  const output = result?.output ?? result?.result?.output ?? {};
  const error = result?.error ?? {};
  const errorText = [error.name, error.code, error.message, result?.message]
    .filter(Boolean)
    .join(' ');

  if (status === 'failed' || status === 'canceled' || status === 'blocked') {
    if (/handler|artifact/i.test(errorText)) {
      return { classification: 'handler_failure', countsAsRuntimeFinding: false };
    }
    if (/TimeoutError|timeout/i.test(errorText)) {
      return { classification: 'worker_timeout', countsAsRuntimeFinding: false };
    }
    return { classification: 'lane_failure', countsAsRuntimeFinding: false };
  }

  if (status !== 'succeeded') {
    return { classification: 'lane_incomplete', countsAsRuntimeFinding: false };
  }

  const substantiveBridgeKind = output.analysisKind === 'analysis_bridge' || output.analysisKind === 'openclaw_bridge';
  if (!substantiveBridgeKind || output.analysisStatus !== 'done') {
    return { classification: 'non_substantive_evidence', countsAsRuntimeFinding: false };
  }

  const findings = Array.isArray(output.findings) ? output.findings : [];
  if (findings.length === 0) {
    return { classification: 'no_runtime_findings', countsAsRuntimeFinding: false };
  }

  return {
    classification: 'runtime_findings',
    countsAsRuntimeFinding: true,
    findings,
  };
}

export function buildReliabilityBacklogReport({ findings = [], generatedAt = new Date().toISOString() } = {}) {
  const lines = [
    'Runtime reliability backlog proposal',
    '',
    'Refs #921, #922',
    `Generated: ${generatedAt}`,
    '',
    'No live mutations: this proposal is source-only evidence scaffolding; it does not authorize broker restart/deploy, DB mutation/replay, provider send, release publish, crossBroker mutation, or Terminal Brief acknowledgement/replay.',
    '',
  ];

  if (findings.length === 0) {
    lines.push('No runtime reliability backlog items proposed until a source-only analysis_bridge lane returns analysisStatus=done with substantive findings.');
    return `${lines.join('\n')}\n`;
  }

  findings.forEach((finding, index) => {
    lines.push(`${index + 1}. ${safeReportText(finding.title ?? 'Runtime reliability follow-up')}`);
    if (hasText(finding.summary)) lines.push(`   Summary: ${safeReportText(finding.summary.trim())}`);
    lines.push('   Acceptance criteria:');
    const criteria = Array.isArray(finding.acceptanceCriteria) && finding.acceptanceCriteria.length > 0
      ? finding.acceptanceCriteria
      : ['Add source-only regression coverage and keep live mutations approval-gated.'];
    criteria.forEach((criterion) => lines.push(`   - ${safeReportText(criterion)}`));
  });

  return `${lines.join('\n')}\n`;
}

export function readReliabilitySourceFiles(repoRoot, paths = DEFAULT_RELIABILITY_SOURCE_PATHS) {
  const files = {};
  for (const path of paths) {
    files[path] = readFileSync(join(repoRoot, path), 'utf8');
  }
  return files;
}

function runCli() {
  const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const sourceFiles = readReliabilitySourceFiles(repoRoot);
  const sourceBundle = collectReliabilitySourceBundle(sourceFiles);
  const manifest = buildReliabilityEvidenceManifest({
    roundId: 'a2ad-nexus-runtime-reliability-921-source-only-retry',
    workerId: 'nosuk',
    sourceBundle,
  });
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

if (process.argv[1] && relative(process.cwd(), fileURLToPath(import.meta.url)) === relative(process.cwd(), process.argv[1])) {
  runCli();
}
