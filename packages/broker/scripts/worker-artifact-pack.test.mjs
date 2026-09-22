// worker-artifact-pack.mjs 시험 (#2227 제안 1).
//
// packer는 저장소 쪽 도구라 실제 저장소 레이아웃(package.json workspaces +
// packages/broker/scripts + packages/attestation)을 기준으로 동작한다. 시험은
// 같은 모양의 가짜 저장소를 tmpdir에 만들고 A2A_PACK_REPO_ROOT로 가리켜
// 실행한다 — 실제 저장소를 건드리지 않는다.
//
// 핵심 계약: payload의 import 그래프가 요구하는 워크스페이스 패키지는
// node_modules/<name>(package.json + dist)으로 반드시 함께 포장된다. #2227의
// "파일 복사 artifact에 워크스페이스 패키지가 없어 기동 실패"를 구조적으로
// 막는 것이 이 도구의 존재 이유다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const packerPath = join(testDir, 'worker-artifact-pack.mjs');

const HANDLER_SOURCE = [
  "import { resolveWorkerModelInputs } from './worker-model-policy.mjs';",
  "import { retrievalSnapshotToSourceCarrier } from 'a2a-attestation';",
  'export const BUILD_INFO = { name: "a2a-task-handler", version: "0.3.0" };',
  'export function handle() { return resolveWorkerModelInputs().model + retrievalSnapshotToSourceCarrier(""); }',
  '',
].join('\n');

const WORKER_MODEL_POLICY_SOURCE = 'export function resolveWorkerModelInputs() { return { model: "x" }; }\n';

const ATTESTATION_INDEX_SOURCE = [
  "import { coreHash } from 'a2a-attestation-core';",
  'export function retrievalSnapshotToSourceCarrier(value) { return coreHash(String(value)); }',
  '',
].join('\n');

function makeFakeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'artifact-pack-repo-'));
  const scripts = join(repo, 'packages', 'broker', 'scripts');
  const lib = join(scripts, 'lib');
  mkdirSync(lib, { recursive: true });
  mkdirSync(join(scripts, 'handlers'), { recursive: true }); // 실수로 생긴 중첩 디렉터리도 payload로 흡수되면 안 된다
  mkdirSync(join(scripts, 'handlers', 'lib'), { recursive: true });

  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fake-monorepo', workspaces: ['packages/*'] }));
  writeFileSync(join(scripts, 'a2a-task-handler.mjs'), HANDLER_SOURCE);
  writeFileSync(join(scripts, 'worker-model-policy.mjs'), WORKER_MODEL_POLICY_SOURCE);
  writeFileSync(join(scripts, 'worker-artifact-rollout-guard.mjs'), '// guard ships with the payload\n');
  writeFileSync(join(scripts, 'worker-artifact-pack.test.mjs'), 'import test from "node:test";\n'); // 제외 대상
  writeFileSync(join(lib, 'source-carriers.mjs'), 'export const stats = () => 0;\n');

  // workspace package 1: a2a-attestation (dist가 트랜지티브 워크스페이스 임포트를 가짐)
  const attestation = join(repo, 'packages', 'attestation');
  mkdirSync(join(attestation, 'dist'), { recursive: true });
  writeFileSync(join(attestation, 'package.json'), JSON.stringify({
    name: 'a2a-attestation', version: '0.1.0', type: 'module', exports: { '.': './dist/index.js' },
  }));
  writeFileSync(join(attestation, 'dist', 'index.js'), ATTESTATION_INDEX_SOURCE);

  // workspace package 2: a2a-attestation-core (트랜지티브로 포장돼야 한다)
  const core = join(repo, 'packages', 'attestation-core');
  mkdirSync(join(core, 'dist'), { recursive: true });
  writeFileSync(join(core, 'package.json'), JSON.stringify({
    name: 'a2a-attestation-core', version: '0.1.0', type: 'module', exports: { '.': './dist/index.js' },
  }));
  writeFileSync(join(core, 'dist', 'index.js'), 'export function coreHash(value) { return value; }\n');

  // 워커 데몬 빌드 산출물(dist/worker.js + 상대 임포트) — packer가 클로저로 포장한다
  const brokerDist = join(repo, 'packages', 'broker', 'dist');
  mkdirSync(join(brokerDist, 'workers'), { recursive: true });
  writeFileSync(join(brokerDist, 'worker.js'), [
    "import { bootWorker } from './workers/boot.js';",
    "import { coreHash } from 'a2a-attestation-core';",
    'export const ready = bootWorker() && coreHash(\"w\");',
    '',
  ].join('\n'));
  writeFileSync(join(brokerDist, 'workers', 'boot.js'), [
    "import { stringSchema } from 'zod-shim';",
    'export function bootWorker() { return !!stringSchema; }',
    '',
  ].join('\n'));

  // 저장소 루트 node_modules의 실제 npm 패키지 — 워커 클로저가 요구하면 벤도링된다
  const zod = join(repo, 'node_modules', 'zod-shim');
  mkdirSync(zod, { recursive: true });
  writeFileSync(join(zod, 'package.json'), JSON.stringify({ name: 'zod-shim', version: '1.0.0', type: 'module', main: 'index.js' }));
  writeFileSync(join(zod, 'index.js'), 'export const stringSchema = () => true;\n');

  return { repo, scripts };
}

function runPacker(repo, args = []) {
  return spawnSync(process.execPath, [packerPath, '--out', join(repo, 'artifact'), ...args], {
    env: { ...process.env, A2A_PACK_REPO_ROOT: repo },
    encoding: 'utf8',
  });
}

test('packer ships payload, handlers mirror, and the transitive workspace package graph (#2227)', () => {
  const { repo } = makeFakeRepo();
  try {
    const result = runPacker(repo);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.packedWorkspaces, ['a2a-attestation', 'a2a-attestation-core']);

    const artifact = join(repo, 'artifact');
    // payload: 핸들러·정책·가드·lib — .test.mjs와 packer 자신은 제외
    assert.equal(existsSync(join(artifact, 'scripts', 'a2a-task-handler.mjs')), true);
    assert.equal(existsSync(join(artifact, 'scripts', 'lib', 'source-carriers.mjs')), true);
    assert.equal(existsSync(join(artifact, 'scripts', 'worker-artifact-rollout-guard.mjs')), true);
    assert.equal(existsSync(join(artifact, 'scripts', 'worker-artifact-pack.test.mjs')), false);
    assert.equal(existsSync(join(artifact, 'scripts', 'worker-artifact-pack.mjs')), false);
    // handlers 미러는 바이트 동일
    assert.equal(
      readFileSync(join(artifact, 'handlers', 'a2a-task-handler.mjs'), 'utf8'),
      readFileSync(join(artifact, 'scripts', 'a2a-task-handler.mjs'), 'utf8'),
    );
    // 워크스페이스 패키지: package.json + dist 전체
    assert.equal(existsSync(join(artifact, 'node_modules', 'a2a-attestation', 'package.json')), true);
    assert.equal(existsSync(join(artifact, 'node_modules', 'a2a-attestation', 'dist', 'index.js')), true);
    // 트랜지티브 워크스페이스 임포트도 포장
    assert.equal(existsSync(join(artifact, 'node_modules', 'a2a-attestation-core', 'dist', 'index.js')), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('packer reports payload-level unknown externals without vendoring them (#2227)', () => {
  const { repo } = makeFakeRepo();
  try {
    const lib = join(repo, 'packages', 'broker', 'scripts', 'lib');
    writeFileSync(join(lib, 'source-carriers.mjs'), 'import { x } from "left-pad";\nexport const stats = () => x;\n');
    const result = runPacker(repo);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    // payload의 미지 의존성은 리포트만 한다(임의 포장 금지) — 워커 클로저가 요구하는
    // zod-shim은 벤도링되지만 payload의 left-pad는 대상이 아니다.
    assert.equal(summary.externalDeps.some((d) => d.endsWith('→ left-pad')), true);
    assert.equal(existsSync(join(repo, 'artifact', 'node_modules', 'left-pad')), false);
    assert.equal(existsSync(join(repo, 'artifact', 'node_modules', 'zod-shim')), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('packer fails closed when a needed workspace package has no build output (#2227)', () => {
  const { repo } = makeFakeRepo();
  try {
    rmSync(join(repo, 'packages', 'attestation', 'dist'), { recursive: true, force: true });
    const result = runPacker(repo);
    assert.equal(result.status, 1);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, false);
    assert.match(summary.error, /no build output/);
    assert.match(summary.hint, /npm run build -w a2a-attestation/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('--check plans without writing (#2227)', () => {
  const { repo } = makeFakeRepo();
  try {
    const result = runPacker(repo, ['--check']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.checkOnly, true);
    assert.deepEqual(summary.packedWorkspaces, ['a2a-attestation', 'a2a-attestation-core']);
    assert.equal(existsSync(join(repo, 'artifact')), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('packer ships the worker daemon closure and vendors its npm deps (#2227 확장)', () => {
  const { repo } = makeFakeRepo();
  try {
    const result = runPacker(repo);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.workerDaemon, true);
    const artifact = join(repo, 'artifact');
    // 워커 엔트리 + 상대 임포트 클로저
    assert.equal(existsSync(join(artifact, 'dist', 'worker.js')), true);
    assert.equal(existsSync(join(artifact, 'dist', 'workers', 'boot.js')), true);
    // 클로저의 npm 의존성은 저장소 node_modules에서 벤도링
    assert.deepEqual(summary.vendoredNpmDeps, ['zod-shim']);
    assert.equal(existsSync(join(artifact, 'node_modules', 'zod-shim', 'package.json')), true);
    assert.equal(existsSync(join(artifact, 'node_modules', 'zod-shim', 'index.js')), true);
    // 워크스페이스 패키지와 병존
    assert.equal(existsSync(join(artifact, 'node_modules', 'a2a-attestation', 'dist', 'index.js')), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
