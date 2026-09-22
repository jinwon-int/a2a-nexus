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

test('packer reports external bare imports instead of guessing them (#2227)', () => {
  const { repo } = makeFakeRepo();
  try {
    const lib = join(repo, 'packages', 'broker', 'scripts', 'lib');
    writeFileSync(join(lib, 'source-carriers.mjs'), 'import { z } from "zod";\nexport const stats = () => z.string();\n');
    const result = runPacker(repo);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.packedWorkspaces, ['a2a-attestation', 'a2a-attestation-core']);
    assert.equal(summary.externalDeps.some((d) => d.endsWith('→ zod')), true);
    // 외부 npm 의존성은 임의로 포장하지 않는다
    assert.equal(existsSync(join(repo, 'artifact', 'node_modules', 'zod')), false);
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
