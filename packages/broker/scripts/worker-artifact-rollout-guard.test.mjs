import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { __test as handlerInternals } from './a2a-task-handler.mjs';

const testDir = dirname(fileURLToPath(import.meta.url));
const guardPath = join(testDir, 'worker-artifact-rollout-guard.mjs');

const handlerSource = `
import { resolveWorkerModelInputs } from './worker-model-policy.mjs';
import { sourceCarrierStats } from './lib/source-carriers.mjs';
import { payloadWithRetrievalSnapshotSourceCarriers } from './lib/retrieval-snapshot-carriers.mjs';
import { runLiveOperationTask } from './lib/live-operation-adapter.mjs';
const HANDLER_VERSION = '0.2.12';
const sourceSha256 = 'computed';
export const BUILD_INFO = {
  name: 'a2a-task-handler',
  version: HANDLER_VERSION,
  source: 'repo:scripts/a2a-task-handler.mjs',
  sourceSha256,
  contract: 'stdin A2A task JSON -> stdout WorkerHandlerOutcome JSON',
  credentialFree: true,
  hostNeutral: true,
};
`;

const workerModelPolicySource = `
export function resolveWorkerModelInputs() { return { model: 'minimax-m3', fromPayload: false }; }
`;

const sourceCarriersSource = `
export function sourceCarrierStats() { return { totalFiles: 0, totalBytes: 0 }; }
`;

const retrievalSnapshotCarriersSource = `
export function payloadWithRetrievalSnapshotSourceCarriers(payload) { return payload; }
`;

const liveOperationAdapterSource = `
export function runLiveOperationTask() { return { handled: false }; }
`;

const analysisExecutionTelemetrySource = `
export function recordAnalysisExecutionTelemetry() { return { recorded: false }; }
`;

const finalizerToolPolicySource = `
export function finalizeToolPolicy() { return { allowed: true }; }
`;

const utf8ByteBudgetSource = `
export function withinUtf8ByteBudget(payloadBytes, budgetBytes) { return payloadBytes <= budgetBytes; }
`;

const jevClassifierSource = `
export function resolveJevConfig() { return { enabled: false }; }
export function classifyTaskWithJev() { return null; }
export function parseJevTimeoutMs() { return 1500; }
`;

const jevReviewShadowSource = `
export function receiptShadowInputs() { return undefined; }
export function reviewShadowInputs() { return undefined; }
export function receiptShadowQuestions() { return []; }
export function reviewShadowQuestions() { return []; }
export async function observeReceiptShadow() { return { attempted: false }; }
export async function observeReviewSufficiencyShadow() { return { attempted: false }; }
`;
const jevProbeObservationSource = `
export function probeObservationInputs() { return undefined; }
export function probeObservationQuestions() { return []; }
export function probeObservationState() { return ''; }
`;
const analysisHarnessFingerprintSource = `export const HARNESS_FINGERPRINT_VERSION = 'test';\n`;
const analysisSourceBundleSource = `
export function normalizePromptViewTelemetry() { return undefined; }
`;

function makeWorkerRoot({
  bridgeHandlersContent = 'bridge-ok\n',
  handlersExecutable = true,
  buildInfoRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  includeBuildInfo = true,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'worker-artifact-'));
  const scripts = join(root, 'scripts');
  const handlers = join(root, 'handlers');
  const dist = join(root, 'dist');
  mkdirSync(scripts);
  mkdirSync(handlers);
  mkdirSync(join(scripts, 'lib'), { recursive: true });
  mkdirSync(join(handlers, 'lib'), { recursive: true });
  if (includeBuildInfo) mkdirSync(dist, { recursive: true });

  const files = {
    sourceHandler: join(scripts, 'a2a-task-handler.mjs'),
    compatHandler: join(handlers, 'a2a-task-handler.mjs'),
    sourceWorkerModelPolicy: join(scripts, 'worker-model-policy.mjs'),
    compatWorkerModelPolicy: join(handlers, 'worker-model-policy.mjs'),
    sourceCarriers: join(scripts, 'lib', 'source-carriers.mjs'),
    compatSourceCarriers: join(handlers, 'lib', 'source-carriers.mjs'),
    sourceRetrievalSnapshotCarriers: join(scripts, 'lib', 'retrieval-snapshot-carriers.mjs'),
    compatRetrievalSnapshotCarriers: join(handlers, 'lib', 'retrieval-snapshot-carriers.mjs'),
    sourceLiveOperationAdapter: join(scripts, 'lib', 'live-operation-adapter.mjs'),
    compatLiveOperationAdapter: join(handlers, 'lib', 'live-operation-adapter.mjs'),
    sourceAnalysisExecutionTelemetry: join(scripts, 'lib', 'analysis-execution-telemetry.mjs'),
    compatAnalysisExecutionTelemetry: join(handlers, 'lib', 'analysis-execution-telemetry.mjs'),
    sourceFinalizerToolPolicy: join(scripts, 'finalizer-tool-policy.mjs'),
    compatFinalizerToolPolicy: join(handlers, 'finalizer-tool-policy.mjs'),
    sourceUtf8ByteBudget: join(scripts, 'lib', 'utf8-byte-budget.mjs'),
    compatUtf8ByteBudget: join(handlers, 'lib', 'utf8-byte-budget.mjs'),
    sourceJevClassifier: join(scripts, 'lib', 'jev-classifier.mjs'),
    compatJevClassifier: join(handlers, 'lib', 'jev-classifier.mjs'),
    sourceJevReviewShadow: join(scripts, 'lib', 'jev-review-shadow.mjs'),
    compatJevReviewShadow: join(handlers, 'lib', 'jev-review-shadow.mjs'),
    sourceJevProbeObservation: join(scripts, 'lib', 'jev-probe-observation.mjs'),
    compatJevProbeObservation: join(handlers, 'lib', 'jev-probe-observation.mjs'),
    sourceAnalysisSourceBundle: join(scripts, 'lib', 'analysis-source-bundle.mjs'),
    compatAnalysisSourceBundle: join(handlers, 'lib', 'analysis-source-bundle.mjs'),
    sourceAnalysisHarnessFingerprint: join(scripts, 'lib', 'analysis-harness-fingerprint.mjs'),
    compatAnalysisHarnessFingerprint: join(handlers, 'lib', 'analysis-harness-fingerprint.mjs'),
    sourceBridge: join(scripts, 'hermes-a2a-analysis-bridge.mjs'),
    compatBridge: join(handlers, 'hermes-a2a-analysis-bridge.mjs'),
    sourceOnlyBridge: join(scripts, 'source-only-local-analysis-bridge.mjs'),
  };

  writeFileSync(files.sourceHandler, handlerSource);
  writeFileSync(files.compatHandler, handlerSource);
  writeFileSync(files.sourceWorkerModelPolicy, workerModelPolicySource);
  writeFileSync(files.compatWorkerModelPolicy, workerModelPolicySource);
  writeFileSync(files.sourceCarriers, sourceCarriersSource);
  writeFileSync(files.compatSourceCarriers, sourceCarriersSource);
  writeFileSync(files.sourceRetrievalSnapshotCarriers, retrievalSnapshotCarriersSource);
  writeFileSync(files.compatRetrievalSnapshotCarriers, retrievalSnapshotCarriersSource);
  writeFileSync(files.sourceLiveOperationAdapter, liveOperationAdapterSource);
  writeFileSync(files.compatLiveOperationAdapter, liveOperationAdapterSource);
  writeFileSync(files.sourceAnalysisExecutionTelemetry, analysisExecutionTelemetrySource);
  writeFileSync(files.compatAnalysisExecutionTelemetry, analysisExecutionTelemetrySource);
  writeFileSync(files.sourceFinalizerToolPolicy, finalizerToolPolicySource);
  writeFileSync(files.compatFinalizerToolPolicy, finalizerToolPolicySource);
  writeFileSync(files.sourceUtf8ByteBudget, utf8ByteBudgetSource);
  writeFileSync(files.compatUtf8ByteBudget, utf8ByteBudgetSource);
  writeFileSync(files.sourceJevClassifier, jevClassifierSource);
  writeFileSync(files.compatJevClassifier, jevClassifierSource);
  writeFileSync(files.sourceJevReviewShadow, jevReviewShadowSource);
  writeFileSync(files.compatJevReviewShadow, jevReviewShadowSource);
  writeFileSync(files.sourceJevProbeObservation, jevProbeObservationSource);
  writeFileSync(files.compatJevProbeObservation, jevProbeObservationSource);
  writeFileSync(files.sourceAnalysisSourceBundle, analysisSourceBundleSource);
  writeFileSync(files.compatAnalysisSourceBundle, analysisSourceBundleSource);
  writeFileSync(files.sourceAnalysisHarnessFingerprint, analysisHarnessFingerprintSource);
  writeFileSync(files.compatAnalysisHarnessFingerprint, analysisHarnessFingerprintSource);
  writeFileSync(files.sourceBridge, 'bridge-ok\n');
  writeFileSync(files.compatBridge, bridgeHandlersContent);
  writeFileSync(files.sourceOnlyBridge, 'source-only-bridge-ok\n');

  if (includeBuildInfo) {
    files.buildInfo = join(dist, 'build-info.json');
    writeFileSync(files.buildInfo, JSON.stringify({
      revision: buildInfoRevision,
      version: '0.1.0',
    }));
  }

  chmodSync(files.sourceHandler, 0o755);
  chmodSync(files.compatHandler, handlersExecutable ? 0o755 : 0o644);
  chmodSync(files.sourceBridge, 0o755);
  chmodSync(files.compatBridge, 0o755);
  chmodSync(files.sourceOnlyBridge, 0o755);

  return { root, files };
}

const BRIDGE_ENV_KEYS = [
  'A2A_DANSO_ANALYSIS_BIN', 'A2A_PIRI_ANALYSIS_BIN', 'A2A_HERMES_ANALYSIS_BIN', 'A2A_OPENCLAW_ANALYSIS_BIN',
  'OPENCLAW_BIN', 'A2A_PIRI_BIN', 'A2A_PIRI_PATCH_BIN',
  'A2A_ANALYSIS_BRIDGE_ADAPTER', 'A2A_WORKER_BRIDGE_ADAPTER',
  'A2A_OPENCLAW_BRIDGE_DISABLED', 'A2A_PIRI_PATCH_BRIDGE_DISABLED',
];

function runGuard(root, env = {}) {
  const childEnv = { ...process.env, A2A_WORKER_ROOT: root, ...env };
  for (const key of [...BRIDGE_ENV_KEYS, 'A2A_WORKER_ENV_PATH', 'WORKER_ENV_PATH', 'A2A_WORKER_TARGET_REVISION', 'A2A_ROLLOUT_GUARD_STRICT_BRIDGE_ROOT']) {
    if (!(key in env)) delete childEnv[key];
  }
  return spawnSync(process.execPath, [guardPath, '--deployed'], {
    cwd: resolve('.'),
    env: childEnv,
    encoding: 'utf8',
  });
}

test('deployed guard fails closed when bridge compat path content drifts from scripts source', () => {
  const { root } = makeWorkerRoot({ bridgeHandlersContent: 'bridge-drift\n' });
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.results.some((r) => r.guard === 'bridge-compat-path' && r.ok === false), true);
});

test('deployed guard fails closed when handler executable bit drifts across scripts and handlers paths', () => {
  const { root } = makeWorkerRoot({ handlersExecutable: false });
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.results.some((r) => r.guard === 'artifact-executable-parity' && r.ok === false), true);
});

test('deployed guard fails closed when handler transitive support module is missing from handlers compat path', () => {
  const { root, files } = makeWorkerRoot();
  rmSync(files.compatWorkerModelPolicy);
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.results.some((r) => r.guard === 'handler-support-compat-path' && r.ok === false), true);
});



test('deployed guard fails closed when source carrier support module is missing from handlers compat path (#1274)', () => {
  const { root, files } = makeWorkerRoot();
  rmSync(files.compatSourceCarriers);
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.match(JSON.stringify(output.results), /lib\/source-carriers\.mjs/);
  assert.equal(output.results.some((r) => r.guard === 'handler-support-compat-path' && r.ok === false), true);
});

test('deployed guard fails closed when retrieval snapshot support module is missing from handlers compat path', () => {
  const { root, files } = makeWorkerRoot();
  rmSync(files.compatRetrievalSnapshotCarriers);
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.match(JSON.stringify(output.results), /lib\/retrieval-snapshot-carriers\.mjs/);
  assert.equal(output.results.some((r) => r.guard === 'handler-support-compat-path' && r.ok === false), true);
});

test('deployed guard fails closed when live operation support module is missing from handlers compat path', () => {
  const { root, files } = makeWorkerRoot();
  rmSync(files.compatLiveOperationAdapter);
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.match(JSON.stringify(output.results), /lib\/live-operation-adapter\.mjs/);
  assert.equal(output.results.some((r) => r.guard === 'handler-support-compat-path' && r.ok === false), true);
});

test('deployed guard fails closed when analysis execution telemetry support module is missing from handlers compat path', () => {
  const { root, files } = makeWorkerRoot();
  rmSync(files.compatAnalysisExecutionTelemetry);
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.match(JSON.stringify(output.results), /lib\/analysis-execution-telemetry\.mjs/);
  assert.equal(output.results.some((r) => r.guard === 'handler-support-compat-path' && r.ok === false), true);
});

test('deployed guard fails closed when finalizer tool policy support module is missing from handlers compat path', () => {
  const { root, files } = makeWorkerRoot();
  rmSync(files.compatFinalizerToolPolicy);
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.match(JSON.stringify(output.results), /finalizer-tool-policy\.mjs/);
  assert.equal(output.results.some((r) => r.guard === 'handler-support-compat-path' && r.ok === false), true);
});

test('deployed guard fails closed when utf8 byte budget support module is missing from handlers compat path', () => {
  const { root, files } = makeWorkerRoot();
  rmSync(files.compatUtf8ByteBudget);
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.match(JSON.stringify(output.results), /lib\/utf8-byte-budget\.mjs/);
  assert.equal(output.results.some((r) => r.guard === 'handler-support-compat-path' && r.ok === false), true);
});

test('deployed guard fails closed when jev classifier support module is missing from handlers compat path', () => {
  const { root, files } = makeWorkerRoot();
  rmSync(files.compatJevClassifier);
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.match(JSON.stringify(output.results), /lib\/jev-classifier\.mjs/);
  assert.equal(output.results.some((r) => r.guard === 'handler-support-compat-path' && r.ok === false), true);
});

test('deployed guard fails closed when analysis source bundle support module is missing from handlers compat path (#2311)', () => {
  const { root, files } = makeWorkerRoot();
  rmSync(files.compatAnalysisSourceBundle);
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.match(JSON.stringify(output.results), /lib\/analysis-source-bundle\.mjs/);
  assert.equal(output.results.some((r) => r.guard === 'handler-support-compat-path' && r.ok === false), true);
});

test('deployed guard accepts a configured standard source-only analysis bridge', () => {
  const { root, files } = makeWorkerRoot();
  const result = runGuard(root, { A2A_HERMES_ANALYSIS_BIN: files.sourceOnlyBridge });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.results.some((r) => r.guard === 'configured-analysis-bridge-artifacts' && r.ok === true), true);
});

test('deployed guard fails closed when env file points at a missing node-specific analysis bridge', () => {
  const { root } = makeWorkerRoot();
  const envPath = join(root, 'worker.env');
  writeFileSync(envPath, [
    'WORKER_ID=worker-custom',
    `A2A_HERMES_ANALYSIS_BIN=${join(root, 'scripts', 'custom-source-analysis-bridge.mjs')}`,
    '',
  ].join('\n'));
  const result = runGuard(root, { A2A_WORKER_ENV_PATH: envPath });
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  const guardResult = output.results.find((r) => r.guard === 'configured-analysis-bridge-artifacts');
  assert.equal(guardResult?.ok, false);
  assert.match(JSON.stringify(guardResult), /custom-source-analysis-bridge\.mjs/);
});

// ---------------------------------------------------------------------------
// #2227 — handler module resolution smoke
//
// handler 0.2.20이 워크스페이스 의존성 a2a-attestation을 들여왔는데, 파일 복사
// artifact에는 그 패키지가 없어 핸들러가 기동하자마자 ERR_MODULE_NOT_FOUND로
// 죽었다. 경로·마커·정책 가드는 전부 exit=0으로 통과했다. 해소 스모크가 이
// 결함 클래스를 배포 전에 잡는지 검증한다.

const attestationImportSource = [
  'import { retrievalSnapshotToSourceCarrier } from "a2a-attestation";',
  'export function payloadWithRetrievalSnapshotSourceCarriers(payload) {',
  '  void retrievalSnapshotToSourceCarrier;',
  '  return payload;',
  '}',
  '',
].join('\n');

test('module resolution smoke is skipped for fixture trees without node_modules (#2227)', () => {
  const { root } = makeWorkerRoot();
  const result = runGuard(root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  const smoke = output.results.find((r) => r.guard === 'handler-module-resolution');
  assert.equal(smoke?.ok, true);
  assert.equal(smoke?.detail?.checked, false);
});

test('module resolution smoke fails the guard when a workspace package is missing from the artifact (#2227)', () => {
  const { root, files } = makeWorkerRoot();
  // artifact 실측 상태 재현: node_modules는 있지만(zod 1개) a2a-attestation은 없다.
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(files.sourceRetrievalSnapshotCarriers, attestationImportSource);
  writeFileSync(files.compatRetrievalSnapshotCarriers, attestationImportSource);

  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  const smoke = output.results.find((r) => r.guard === 'handler-module-resolution');
  assert.equal(smoke?.ok, false);
  assert.match(String(smoke?.error ?? ''), /failed to import/);
  assert.match(JSON.stringify(smoke), /ERR_MODULE_NOT_FOUND/);
});

test('module resolution smoke passes and reports the imported build info when the workspace package ships (#2227)', () => {
  const { root, files } = makeWorkerRoot();
  mkdirSync(join(root, 'node_modules', 'a2a-attestation', 'dist'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'a2a-attestation', 'package.json'), JSON.stringify({
    name: 'a2a-attestation',
    version: '0.1.0',
    type: 'module',
    main: 'dist/index.js',
    exports: { '.': './dist/index.js' },
  }));
  writeFileSync(
    join(root, 'node_modules', 'a2a-attestation', 'dist', 'index.js'),
    'export function retrievalSnapshotToSourceCarrier(value) { return value; }\n',
  );
  writeFileSync(files.sourceRetrievalSnapshotCarriers, attestationImportSource);
  writeFileSync(files.compatRetrievalSnapshotCarriers, attestationImportSource);

  const result = runGuard(root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  const smoke = output.results.find((r) => r.guard === 'handler-module-resolution');
  assert.equal(smoke?.ok, true);
  assert.equal(smoke?.detail?.checked, true);
  assert.equal(smoke?.detail?.importedFrom, 'handlers (runtime copy)');
  assert.equal(smoke?.detail?.importedBuildInfo?.version, '0.2.12');
});

// ---------------------------------------------------------------------------
// #2311 — workspace dependency export check
//
// 워커 배포가 dist/만 갱신하고 node_modules/a2a-attestation은 08-25 설치본으로
// 남겨 두었다. dist가 redactSecrets를 import하면서 dist/worker.js가 ESM 링크
// 단계에서 죽었는데, 가드는 11/11 통과했다. dist가 a2a-* 워크스페이스 패키지에서
// named import하는 이름이 배포 node_modules 사본에 실제로 있는지 검증한다.

// Multi-line, aliased, type-only and default/namespace shapes the scanner must handle.
const distWorkerSource = [
  'import { readFileSync } from "node:fs";',
  'import {',
  '  attestRun,',
  '  redactSecrets as redactGithubEgress,',
  '  type AttestationBundle,',
  '} from "a2a-attestation";',
  'import type { OnlyTypes } from "a2a-attestation";',
  'import * as referee from "a2a-policy-referee";',
  'export { scoreItem } from "a2a-nclex-evaluation";',
  'void readFileSync; void attestRun; void redactGithubEgress; void referee;',
  '',
].join('\n');

function writeWorkspacePackage(root, packageName, indexSource, { pkg } = {}) {
  const dir = join(root, 'node_modules', packageName);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg ?? {
    name: packageName,
    version: '0.1.0',
    type: 'module',
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
  }));
  writeFileSync(join(dir, 'dist', 'index.js'), indexSource);
  return dir;
}

function makeWorkerRootWithDist({ attestationIndex }) {
  const fixture = makeWorkerRoot();
  mkdirSync(join(fixture.root, 'dist', 'workers'), { recursive: true });
  writeFileSync(join(fixture.root, 'dist', 'worker.js'), distWorkerSource);
  // *.test.js never links at runtime and must not be scanned.
  writeFileSync(join(fixture.root, 'dist', 'workers', 'worker.test.js'), 'import { testOnlyName } from "a2a-attestation";\n');
  writeWorkspacePackage(fixture.root, 'a2a-attestation', attestationIndex);
  writeWorkspacePackage(fixture.root, 'a2a-policy-referee', 'export const evaluatePolicy = () => true;\n');
  writeWorkspacePackage(fixture.root, 'a2a-nclex-evaluation', 'export function scoreItem() { return 1; }\n', {
    pkg: { name: 'a2a-nclex-evaluation', version: '0.2.0', type: 'module', main: 'dist/index.js' },
  });
  return fixture;
}

test('workspace dependency export check is skipped for deployed fixture trees without dist/ (#2311)', () => {
  // includeBuildInfo:false keeps dist/ absent so this guard stays skipped;
  // deployed-build-info will fail for this fixture — assert only the exports guard.
  const { root } = makeWorkerRoot({ includeBuildInfo: false });
  const result = runGuard(root);
  const output = JSON.parse(result.stdout);
  const check = output.results.find((r) => r.guard === 'workspace-dependency-exports');
  assert.equal(check?.ok, true);
  assert.equal(check?.detail?.checked, false);
});

test('workspace dependency export check fails naming the export a stale node_modules package lacks (#2311)', () => {
  const { root } = makeWorkerRootWithDist({
    // 08-25 설치본 재현: attestRun은 있지만 redactSecrets는 없다.
    attestationIndex: 'export function attestRun() { return {}; }\n',
  });
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  const check = output.results.find((r) => r.guard === 'workspace-dependency-exports');
  assert.equal(check?.ok, false);
  assert.match(String(check?.error ?? ''), /a2a-attestation: missing redactSecrets/);
  const attestation = check.detail.packages.find((p) => p.package === 'a2a-attestation');
  assert.deepEqual(attestation.missingExports, ['redactSecrets']);
  assert.deepEqual(attestation.importers.redactSecrets, ['worker.js']);
  // type-only and test-file imports are not runtime requirements.
  assert.doesNotMatch(JSON.stringify(check), /AttestationBundle|OnlyTypes|testOnlyName/);
  // other workspace packages still pass individually.
  assert.equal(check.detail.packages.find((p) => p.package === 'a2a-nclex-evaluation')?.ok, true);
  assert.equal(check.detail.packages.find((p) => p.package === 'a2a-policy-referee')?.ok, true);
});

test('workspace dependency export check passes when deployed packages match dist imports (#2311)', () => {
  const { root } = makeWorkerRootWithDist({
    attestationIndex: 'export function attestRun() { return {}; }\nexport function redactSecrets(text) { return text; }\n',
  });
  const result = runGuard(root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  const check = output.results.find((r) => r.guard === 'workspace-dependency-exports');
  assert.equal(check?.ok, true);
  assert.equal(check?.detail?.checked, true);
  assert.deepEqual(check.detail.packages.map((p) => [p.package, p.ok, p.requiredNames]), [
    ['a2a-attestation', true, 2],
    ['a2a-nclex-evaluation', true, 1],
    ['a2a-policy-referee', true, 0],
  ]);
});

test('workspace dependency export check fails closed when an imported workspace package is not installed (#2311)', () => {
  const { root } = makeWorkerRootWithDist({
    attestationIndex: 'export function attestRun() { return {}; }\nexport function redactSecrets(text) { return text; }\n',
  });
  rmSync(join(root, 'node_modules', 'a2a-policy-referee'), { recursive: true });
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  const check = output.results.find((r) => r.guard === 'workspace-dependency-exports');
  assert.equal(check?.ok, false);
  assert.match(String(check?.error ?? ''), /a2a-policy-referee: package not installed/);
});

test('workspace dependency export check never echoes env secret values (#2311)', () => {
  const secret = 'fixture-SECRETVALUE-must-never-appear';
  const { root } = makeWorkerRootWithDist({ attestationIndex: 'export function attestRun() { return {}; }\n' });
  const result = runGuard(root, { GITHUB_TOKEN: secret, A2A_BROKER_TOKEN: secret });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /SECRETVALUE/);
});

test('deployed guard fails closed when dist/build-info.json is missing (#2423)', () => {
  const { root } = makeWorkerRoot({ includeBuildInfo: false });
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false);
  assert.equal(output.results.some((r) => r.guard === 'deployed-build-info' && r.ok === false), true);
  const check = output.results.find((r) => r.guard === 'deployed-build-info');
  assert.match(String(check?.error ?? ''), /build-info\.json missing/);
});

test('deployed guard fails closed when dist/build-info.json revision is dirty (#2423)', () => {
  const { root } = makeWorkerRoot({
    buildInfoRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-dirty',
  });
  const result = runGuard(root);
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  const check = output.results.find((r) => r.guard === 'deployed-build-info');
  assert.equal(check?.ok, false);
  assert.match(String(check?.error ?? ''), /clean 40-hex/);
});

test('deployed guard fails closed when build-info revision disagrees with A2A_WORKER_TARGET_REVISION (#2423)', () => {
  const { root } = makeWorkerRoot();
  const result = runGuard(root, {
    A2A_WORKER_TARGET_REVISION: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });
  assert.notEqual(result.status, 0);
  const output = JSON.parse(result.stdout);
  const check = output.results.find((r) => r.guard === 'deployed-build-info');
  assert.equal(check?.ok, false);
  assert.match(String(check?.error ?? ''), /A2A_WORKER_TARGET_REVISION/);
});

test('deployed guard passes deployed-build-info for a clean 40-hex revision (#2423)', () => {
  const { root } = makeWorkerRoot();
  const result = runGuard(root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  const check = output.results.find((r) => r.guard === 'deployed-build-info');
  assert.equal(check?.ok, true);
  assert.equal(check?.detail?.revision, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});
// ---------------------------------------------------------------------------
// #2429 — a configured analysis bridge that resolves outside the worker root
// is never refreshed by an artifact rollout (a Termux worker ran a live checkout 229
// commits behind main this way while `--deployed` kept passing).

function makeOutsideBridge() {
  const outside = mkdtempSync(join(tmpdir(), 'outside-checkout-'));
  const bridge = join(outside, 'packages', 'broker', 'scripts', 'claude-a2a-analysis-bridge.mjs');
  mkdirSync(dirname(bridge), { recursive: true });
  writeFileSync(bridge, '#!/usr/bin/env node\nprocess.stdout.write("{}");\n');
  chmodSync(bridge, 0o755);
  return { outside, bridge };
}

test('deployed guard warns when a configured analysis bridge resolves outside the worker root (#2429)', () => {
  const { root } = makeWorkerRoot();
  const { outside, bridge } = makeOutsideBridge();
  try {
    const result = runGuard(root, { A2A_HERMES_ANALYSIS_BIN: bridge });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    const guardResult = output.results.find((r) => r.guard === 'configured-analysis-bridge-artifacts');
    assert.equal(guardResult?.ok, true);
    const check = guardResult.detail.checks.find((c) => c.name === 'A2A_HERMES_ANALYSIS_BIN');
    assert.equal(check?.outsideWorkerRoot, true);
    assert.equal(guardResult.detail.warnings.length, 1);
    assert.match(guardResult.detail.warnings[0], /A2A_HERMES_ANALYSIS_BIN points outside the worker root/);
    assert.match(guardResult.detail.warnings[0], /#2429/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('deployed guard fails closed on an outside-root bridge when A2A_ROLLOUT_GUARD_STRICT_BRIDGE_ROOT=1 (#2429)', () => {
  const { root } = makeWorkerRoot();
  const { outside, bridge } = makeOutsideBridge();
  try {
    const result = runGuard(root, { A2A_HERMES_ANALYSIS_BIN: bridge, A2A_ROLLOUT_GUARD_STRICT_BRIDGE_ROOT: '1' });
    assert.notEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    const guardResult = output.results.find((r) => r.guard === 'configured-analysis-bridge-artifacts');
    assert.equal(guardResult?.ok, false);
    assert.match(guardResult.error, /outside the worker root/);
    assert.equal(guardResult.detail.failed[0].name, 'A2A_HERMES_ANALYSIS_BIN');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('deployed guard does not flag a bridge inside the worker root, even in strict mode (#2429)', () => {
  const { root, files } = makeWorkerRoot();
  const result = runGuard(root, { A2A_HERMES_ANALYSIS_BIN: files.sourceOnlyBridge, A2A_ROLLOUT_GUARD_STRICT_BRIDGE_ROOT: '1' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  const guardResult = output.results.find((r) => r.guard === 'configured-analysis-bridge-artifacts');
  assert.equal(guardResult?.ok, true);
  const check = guardResult.detail.checks.find((c) => c.name === 'A2A_HERMES_ANALYSIS_BIN');
  assert.equal(check?.outsideWorkerRoot, false);
  assert.equal(guardResult.detail.warnings, undefined);
});

// ---------------------------------------------------------------------------
// #2461 — the guard checks the host patch bridge slots too and reports the
// slot the handler EFFECTIVELY selects per lane. A Termux worker had
// OPENCLAW_BIN realigned to the artifact while A2A_PIRI_ANALYSIS_BIN and
// A2A_PIRI_PATCH_BIN (both higher precedence) still pointed at a live checkout;
// the patch slot was never checked at all.

function makeOutsideScripts(names) {
  const outside = mkdtempSync(join(tmpdir(), 'outside-checkout-'));
  const paths = {};
  for (const name of names) {
    const file = join(outside, 'packages', 'broker', 'scripts', name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '#!/usr/bin/env node\nprocess.stdout.write("{}");\n');
    chmodSync(file, 0o755);
    paths[name] = file;
  }
  return { outside, paths };
}

function writeArtifactScript(root, name) {
  const file = join(root, 'scripts', name);
  writeFileSync(file, '#!/usr/bin/env node\nprocess.stdout.write("{}");\n');
  chmodSync(file, 0o755);
  return file;
}

function bridgeGuardResult(result) {
  const output = JSON.parse(result.stdout);
  return output.results.find((r) => r.guard === 'configured-analysis-bridge-artifacts');
}

test('deployed guard flags the effective analysis and patch bridges of the #2461 checkout drift', () => {
  const { root } = makeWorkerRoot();
  const artifactOpenclaw = writeArtifactScript(root, 'claude-a2a-analysis-bridge.mjs');
  const { outside, paths } = makeOutsideScripts(['claude-a2a-analysis-bridge.mjs', 'claude-a2a-patch-bridge.mjs']);
  try {
    const envPath = join(root, 'worker.env');
    writeFileSync(envPath, [
      'A2A_WORKER_BRIDGE_ADAPTER=claude-code',
      `OPENCLAW_BIN=${artifactOpenclaw}`,
      `A2A_PIRI_ANALYSIS_BIN=${paths['claude-a2a-analysis-bridge.mjs']}`,
      `A2A_PIRI_PATCH_BIN=${paths['claude-a2a-patch-bridge.mjs']}`,
      '',
    ].join('\n'));
    const result = runGuard(root, { A2A_WORKER_ENV_PATH: envPath });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const guardResult = bridgeGuardResult(result);
    assert.equal(guardResult.ok, true);
    const { effective, checks, warnings } = guardResult.detail;
    assert.equal(effective.analysis.slot, 'A2A_PIRI_ANALYSIS_BIN');
    assert.equal(effective.analysis.selectedBy, 'declared-adapter');
    assert.equal(effective.analysis.outsideWorkerRoot, true);
    assert.equal(effective.patch.slot, 'A2A_PIRI_PATCH_BIN');
    assert.equal(effective.patch.outsideWorkerRoot, true);
    assert.deepEqual(checks.find((c) => c.name === 'A2A_PIRI_PATCH_BIN')?.roles, ['patch']);
    assert.deepEqual(checks.find((c) => c.name === 'OPENCLAW_BIN')?.roles, ['analysis', 'patch']);
    assert.equal(checks.find((c) => c.name === 'OPENCLAW_BIN')?.effectiveFor, undefined);
    assert.equal(warnings.length, 2);
    assert.match(warnings.join('\n'), /A2A_PIRI_ANALYSIS_BIN points outside the worker root .* effective analysis bridge/);
    assert.match(warnings.join('\n'), /A2A_PIRI_PATCH_BIN points outside the worker root .* effective patch bridge/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('deployed guard notes a shadowed outside-root patch slot without calling it effective (#2461)', () => {
  const { root } = makeWorkerRoot();
  const artifactPatch = writeArtifactScript(root, 'claude-a2a-patch-bridge.mjs');
  const { outside, paths } = makeOutsideScripts(['claude-a2a-patch-bridge.mjs']);
  try {
    const result = runGuard(root, { A2A_PIRI_BIN: artifactPatch, A2A_PIRI_PATCH_BIN: paths['claude-a2a-patch-bridge.mjs'] });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const guardResult = bridgeGuardResult(result);
    assert.equal(guardResult.detail.effective.patch.slot, 'A2A_PIRI_BIN');
    assert.equal(guardResult.detail.effective.patch.outsideWorkerRoot, false);
    assert.equal(guardResult.detail.warnings.length, 1);
    assert.match(guardResult.detail.warnings[0], /A2A_PIRI_PATCH_BIN points outside the worker root/);
    assert.match(guardResult.detail.warnings[0], /not selected now \(patch lane uses A2A_PIRI_BIN\)/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('strict bridge-root mode fails closed on an outside-root patch bridge (#2461)', () => {
  const { root } = makeWorkerRoot();
  const { outside, paths } = makeOutsideScripts(['claude-a2a-patch-bridge.mjs']);
  try {
    const result = runGuard(root, { A2A_PIRI_PATCH_BIN: paths['claude-a2a-patch-bridge.mjs'], A2A_ROLLOUT_GUARD_STRICT_BRIDGE_ROOT: '1' });
    assert.notEqual(result.status, 0);
    const guardResult = bridgeGuardResult(result);
    assert.equal(guardResult.ok, false);
    assert.equal(guardResult.detail.failed[0].name, 'A2A_PIRI_PATCH_BIN');
    assert.equal(guardResult.detail.effective.patch.slot, 'A2A_PIRI_PATCH_BIN');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a missing patch-only bridge warns but does not fail the guard (#2461)', () => {
  const { root } = makeWorkerRoot();
  const result = runGuard(root, { A2A_PIRI_BIN: join(root, 'scripts', 'missing-patch-bridge.mjs') });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const guardResult = bridgeGuardResult(result);
  assert.equal(guardResult.ok, true);
  assert.equal(guardResult.detail.checks[0].ok, false);
  assert.match(guardResult.detail.warnings[0], /A2A_PIRI_BIN \(host patch bridge, effective\) is missing or not executable/);
});

test('a disabled host patch bridge has no effective patch slot (#2461)', () => {
  const { root } = makeWorkerRoot();
  const { outside, paths } = makeOutsideScripts(['claude-a2a-patch-bridge.mjs']);
  try {
    const result = runGuard(root, { A2A_PIRI_PATCH_BIN: paths['claude-a2a-patch-bridge.mjs'], A2A_PIRI_PATCH_BRIDGE_DISABLED: '1' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const guardResult = bridgeGuardResult(result);
    assert.equal(guardResult.detail.effective.patch.slot, null);
    assert.equal(guardResult.detail.effective.patch.disabled, true);
    assert.match(guardResult.detail.warnings[0], /not selected now \(host patch bridge is disabled\)/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the declared adapter selects a lower-precedence analysis slot, and the guard follows it (#2370, #2461)', () => {
  const { root } = makeWorkerRoot();
  const piri = writeArtifactScript(root, 'piri-a2a-analysis-bridge.mjs');
  const { outside, paths } = makeOutsideScripts(['claude-a2a-analysis-bridge.mjs']);
  try {
    const result = runGuard(root, {
      A2A_WORKER_BRIDGE_ADAPTER: 'claude-code',
      A2A_PIRI_ANALYSIS_BIN: piri,
      A2A_HERMES_ANALYSIS_BIN: paths['claude-a2a-analysis-bridge.mjs'],
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const guardResult = bridgeGuardResult(result);
    assert.equal(guardResult.detail.effective.analysis.slot, 'A2A_HERMES_ANALYSIS_BIN');
    assert.equal(guardResult.detail.effective.analysis.selectedBy, 'declared-adapter');
    assert.equal(guardResult.detail.effective.analysis.adapterMismatch, false);
    assert.equal(guardResult.detail.warnings.length, 1);
    assert.match(guardResult.detail.warnings[0], /A2A_HERMES_ANALYSIS_BIN .* effective analysis\+?\w* bridge/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('the guard warns when the declared adapter contradicts every analysis slot (#2370)', () => {
  const { root } = makeWorkerRoot();
  const piri = writeArtifactScript(root, 'piri-a2a-analysis-bridge.mjs');
  const result = runGuard(root, { A2A_WORKER_BRIDGE_ADAPTER: 'claude-code', A2A_PIRI_ANALYSIS_BIN: piri });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const guardResult = bridgeGuardResult(result);
  assert.equal(guardResult.detail.effective.analysis.adapterMismatch, true);
  assert.match(guardResult.detail.warnings[0], /declared bridge adapter claude_code .* analysis_bridge_adapter_mismatch/);
});

test('A2A_DANSO_ANALYSIS_BIN is checked as the top-precedence analysis slot (#2461)', () => {
  const { root } = makeWorkerRoot();
  const result = runGuard(root, { A2A_DANSO_ANALYSIS_BIN: join(root, 'scripts', 'missing-danso-a2a-analysis-bridge.mjs') });
  assert.notEqual(result.status, 0);
  const guardResult = bridgeGuardResult(result);
  assert.equal(guardResult.ok, false);
  assert.equal(guardResult.detail.failed[0].name, 'A2A_DANSO_ANALYSIS_BIN');
  assert.equal(guardResult.detail.effective.analysis.slot, 'A2A_DANSO_ANALYSIS_BIN');
});

test('process env outranks the deployed env file for the effective selection (#2461)', () => {
  const { root } = makeWorkerRoot();
  const artifactPatch = writeArtifactScript(root, 'claude-a2a-patch-bridge.mjs');
  const { outside, paths } = makeOutsideScripts(['claude-a2a-patch-bridge.mjs']);
  try {
    const envPath = join(root, 'worker.env');
    writeFileSync(envPath, `A2A_PIRI_BIN=${paths['claude-a2a-patch-bridge.mjs']}\n`);
    const result = runGuard(root, { A2A_WORKER_ENV_PATH: envPath, A2A_PIRI_BIN: artifactPatch });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const guardResult = bridgeGuardResult(result);
    const check = guardResult.detail.checks.find((c) => c.name === 'A2A_PIRI_BIN');
    assert.equal(check.source, 'process.env');
    assert.equal(guardResult.detail.effective.patch.outsideWorkerRoot, false);
    assert.equal(guardResult.detail.warnings, undefined);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// Parity: the guard's mirror must pick the same slot as the handler's own
// selection functions. Distinct paths per slot let us map the handler's
// returned command back to the slot name. Spec values: a runtime keyword
// becomes an existing fixture bridge file; `raw:<v>` is passed literally.
test('guard effective-bridge selection matches the handler selection functions (#2461 parity)', () => {
  const { root } = makeWorkerRoot();
  // File names carry only the runtime keyword (slot names would leak extra
  // keywords such as "hermes"/"piri" into the runtime detection).
  const slotIndex = (slot) => BRIDGE_ENV_KEYS.indexOf(slot);
  const file = (slot, runtime) => join(root, 'scripts', `slot${slotIndex(slot)}-${runtime}-a2a-bridge.mjs`);
  const cases = [
    {},
    { A2A_PIRI_ANALYSIS_BIN: 'piri' },
    { A2A_PIRI_ANALYSIS_BIN: 'piri', A2A_HERMES_ANALYSIS_BIN: 'hermes', OPENCLAW_BIN: 'openclaw' },
    { A2A_DANSO_ANALYSIS_BIN: 'danso', A2A_PIRI_ANALYSIS_BIN: 'piri' },
    { A2A_WORKER_BRIDGE_ADAPTER: 'raw:claude-code', A2A_PIRI_ANALYSIS_BIN: 'piri', A2A_OPENCLAW_ANALYSIS_BIN: 'claude' },
    { A2A_WORKER_BRIDGE_ADAPTER: 'raw:claude-code', A2A_PIRI_ANALYSIS_BIN: 'claude', OPENCLAW_BIN: 'claude' },
    { A2A_ANALYSIS_BRIDGE_ADAPTER: 'raw:codex', A2A_WORKER_BRIDGE_ADAPTER: 'raw:claude-code', A2A_PIRI_ANALYSIS_BIN: 'claude', A2A_HERMES_ANALYSIS_BIN: 'codex' },
    { A2A_WORKER_BRIDGE_ADAPTER: 'raw:hermes', A2A_PIRI_ANALYSIS_BIN: 'piri' },
    // codex wrapper names that also mention claude: codex must win (keyword order).
    { A2A_ANALYSIS_BRIDGE_ADAPTER: 'raw:codex', A2A_PIRI_ANALYSIS_BIN: 'claude', A2A_HERMES_ANALYSIS_BIN: 'codex-claude' },
    { A2A_WORKER_BRIDGE_ADAPTER: 'raw:unknown-runtime', A2A_HERMES_ANALYSIS_BIN: 'hermes', OPENCLAW_BIN: 'openclaw' },
    // declared piri with no piri-named slot: the handler's in-repo default wins.
    { A2A_WORKER_BRIDGE_ADAPTER: 'raw:piri', A2A_PIRI_ANALYSIS_BIN: 'source-only' },
    { A2A_WORKER_BRIDGE_ADAPTER: 'raw:piri', A2A_HERMES_ANALYSIS_BIN: 'hermes' },
    // declared adapter with no slot at all: default bridge, mismatch.
    { A2A_WORKER_BRIDGE_ADAPTER: 'raw:claude-code' },
    // whitespace-only / unset-token first adapter var wins the raw `||`.
    { A2A_ANALYSIS_BRIDGE_ADAPTER: 'raw:  ', A2A_WORKER_BRIDGE_ADAPTER: 'raw:hermes', A2A_PIRI_ANALYSIS_BIN: 'claude', A2A_HERMES_ANALYSIS_BIN: 'hermes' },
    { A2A_ANALYSIS_BRIDGE_ADAPTER: 'raw:none', A2A_WORKER_BRIDGE_ADAPTER: 'raw:hermes', A2A_PIRI_ANALYSIS_BIN: 'claude', A2A_HERMES_ANALYSIS_BIN: 'hermes' },
    // literal unset tokens are real candidates for the handler.
    { A2A_DANSO_ANALYSIS_BIN: 'raw:none', A2A_PIRI_ANALYSIS_BIN: 'claude' },
    { A2A_PIRI_BIN: 'raw:null', A2A_PIRI_PATCH_BIN: 'claude' },
    { A2A_PIRI_ANALYSIS_BIN: 'raw:   ', A2A_HERMES_ANALYSIS_BIN: 'hermes' },
    { OPENCLAW_BIN: 'openclaw' },
    { A2A_PIRI_PATCH_BIN: 'claude', OPENCLAW_BIN: 'openclaw' },
    { A2A_PIRI_BIN: 'piri', A2A_PIRI_PATCH_BIN: 'claude', OPENCLAW_BIN: 'openclaw' },
    { A2A_PIRI_PATCH_BIN: 'claude', A2A_PIRI_PATCH_BRIDGE_DISABLED: 'raw:1' },
    { OPENCLAW_BIN: 'openclaw', A2A_OPENCLAW_BRIDGE_DISABLED: 'raw:yes' },
    { A2A_PIRI_BIN: 'piri', A2A_OPENCLAW_BRIDGE_DISABLED: 'raw:0' },
  ];
  for (const spec of cases) {
    const env = {};
    for (const [key, value] of Object.entries(spec)) {
      if (value.startsWith('raw:')) {
        env[key] = value.slice(4);
      } else {
        env[key] = file(key, value);
        writeFileSync(env[key], '#!/usr/bin/env node\n');
        chmodSync(env[key], 0o755);
      }
    }
    const slotOf = (command) => (command
      ? Object.keys(env).filter((key) => key.endsWith('_BIN')).find((key) => env[key].trim() === command) ?? null
      : null);
    const handlerAnalysis = handlerInternals.analysisBridgeCommand(env);
    const expectedAnalysis = slotOf(handlerAnalysis);
    const expectedPatch = handlerInternals.isOpenClawBridgeConfigured(env)
      ? slotOf(handlerInternals.hostPatchBridgeCommand(env))
      : null;
    const expectedMismatch = handlerInternals.analysisBridgeArtifactPreflight(handlerAnalysis, env)?.error?.code === 'analysis_bridge_adapter_mismatch';
    const result = runGuard(root, env);
    const guardResult = bridgeGuardResult(result);
    const label = JSON.stringify(spec);
    assert.equal(guardResult.detail.effective.analysis.slot, expectedAnalysis, `analysis slot for ${label}`);
    assert.equal(guardResult.detail.effective.patch.slot, expectedPatch, `patch slot for ${label}`);
    assert.equal(guardResult.detail.effective.analysis.adapterMismatch, expectedMismatch, `adapter mismatch for ${label}`);
    if (expectedMismatch) {
      assert.match((guardResult.detail.warnings ?? []).join('\n'), /analysis_bridge_adapter_mismatch/, `mismatch warning for ${label}`);
    }
  }
});

test('the guard warns about a literal unset token the handler would run (#2461)', () => {
  const { root } = makeWorkerRoot();
  const claude = writeArtifactScript(root, 'claude-a2a-analysis-bridge.mjs');
  const result = runGuard(root, { A2A_DANSO_ANALYSIS_BIN: 'none', A2A_PIRI_ANALYSIS_BIN: claude });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const guardResult = bridgeGuardResult(result);
  assert.equal(guardResult.detail.effective.analysis.slot, 'A2A_DANSO_ANALYSIS_BIN');
  assert.equal(guardResult.detail.effective.analysis.literalUnsetToken, true);
  assert.match(guardResult.detail.warnings.join('\n'), /A2A_DANSO_ANALYSIS_BIN is set to the literal "none"/);
});
