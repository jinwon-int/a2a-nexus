import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_RELIABILITY_SOURCE_PATHS,
  buildReliabilityBacklogReport,
  buildReliabilityEvidenceManifest,
  classifyReliabilityLaneResult,
  collectReliabilitySourceBundle,
  failClosedOnOpenClawRuntimePaths,
} from './runtime-reliability-evidence-lane.mjs';

const sourceFiles = {
  'docs/release-gate.md': '# Release Gate\nNo deploy, no restart, no DB mutation. Persistence ack and queue drain notes.\n',
  'docs/ops/release-gate-step-inventory.json': '{"entries":[{"name":"message-id-ack-boundary"}]}\n',
  'packages/broker/src/core/store.ts': 'export interface Store { ackPersistence(): Promise<void>; }\n',
  'packages/broker/src/core/sqlite-worker-thread-persistence.ts': 'export const workerLiveness = true;\n',
  'packages/broker/src/server-persistence-ack.test.ts': 'test("durable persistence ack", () => {});\n',
  'packages/broker/src/core/round-result-collector.ts': 'export function collectRoundResults() {}\n',
  'scripts/a2a-dispatch-round.mjs': 'const CLASS_ACCEPTED_UNCONFIRMED = "accepted-unconfirmed";\n',
};

test('collectReliabilitySourceBundle keeps the source-only bundle focused and budgeted', () => {
  const bundle = collectReliabilitySourceBundle(sourceFiles, { maxChars: 1_400 });

  assert.equal(bundle.kind, 'a2a-nexus.runtime-reliability.sourceBundle');
  assert.deepEqual(bundle.focus, [
    'persistence ack',
    'idempotency',
    'queue drain',
    'worker liveness',
    'release-gate inventory',
    'round-result collection',
  ]);
  assert.deepEqual(bundle.files.map((file) => file.path), DEFAULT_RELIABILITY_SOURCE_PATHS);
  assert.ok(bundle.totalChars <= 1_400, `bundle exceeded prompt budget: ${bundle.totalChars}`);
  assert.ok(bundle.files.every((file) => file.contentText.length > 0));
  assert.ok(bundle.files.every((file) => !file.path.startsWith('.openclaw/')));
});

test('buildReliabilityEvidenceManifest is a no-live analysis bridge retry for #921/#922', () => {
  const sourceBundle = collectReliabilitySourceBundle(sourceFiles, { maxChars: 2_000 });
  const manifest = buildReliabilityEvidenceManifest({
    roundId: 'a2ad-nexus-runtime-reliability-921-nosuk-retry',
    workerId: 'nosuk',
    sourceBundle,
  });

  assert.equal(manifest.issueLinks.includes('#921'), true);
  assert.equal(manifest.issueLinks.includes('#922'), true);
  assert.equal(manifest.dispatch.mode, 'read-only-analysis');
  assert.equal(manifest.dispatch.noLive, true);
  assert.equal(manifest.dispatch.sourceOnly, true);
  assert.equal(manifest.dispatch.requiredAnalysis.analysisKind, 'analysis_bridge');
  assert.equal(manifest.dispatch.requiredAnalysis.analysisStatus, 'done');
  assert.deepEqual(manifest.dispatch.prohibitedActions, [
    'broker restart/deploy',
    'DB mutation/replay',
    'live provider send',
    'release/tag/npm/Docker publish',
    'secret movement',
    'repo visibility change',
    'crossBroker mutation',
    'Terminal Brief ACK/replay',
  ]);
});

test('classifyReliabilityLaneResult separates worker timeout and handler failure from findings', () => {
  assert.equal(
    classifyReliabilityLaneResult({ status: 'failed', error: { name: 'TimeoutError', message: 'lane timed out' } }).classification,
    'worker_timeout',
  );
  assert.equal(
    classifyReliabilityLaneResult({ status: 'failed', error: { message: 'handler artifact failed before analysis' } }).classification,
    'handler_failure',
  );
  assert.equal(
    classifyReliabilityLaneResult({ status: 'succeeded', output: { analysisKind: 'openclaw_bridge', analysisStatus: 'done', findings: [] } }).classification,
    'no_runtime_findings',
  );
  assert.equal(
    classifyReliabilityLaneResult({
      status: 'succeeded',
      output: {
        analysisKind: 'analysis_bridge',
        bridgeAdapter: 'claude_code',
        analysisStatus: 'done',
        findings: [{ title: 'durable ack ambiguity', acceptanceCriteria: ['document ack boundary'] }],
      },
    }).classification,
    'runtime_findings',
  );
});

test('buildReliabilityBacklogReport renders acceptance criteria without live mutations', () => {
  const report = buildReliabilityBacklogReport({
    findings: [
      {
        title: 'Persistence ack replay risk',
        acceptanceCriteria: ['Add source-only regression coverage for durable ack retry classification.'],
      },
    ],
  });

  assert.match(report, /Refs #921, #922/);
  assert.match(report, /Acceptance criteria/);
  assert.match(report, /No live mutations/);
  assert.doesNotMatch(report, /deploy now|restart now|ACK replay/i);
});

test('failClosedOnOpenClawRuntimePaths reports exact forbidden branch/artifact paths', () => {
  assert.deepEqual(
    failClosedOnOpenClawRuntimePaths([
      'docs/release-gate.md',
      'AGENTS.md',
      '.openclaw/session/context.json',
      'packages/broker/src/core/store.ts',
    ]),
    ['AGENTS.md', '.openclaw/session/context.json'],
  );
});
