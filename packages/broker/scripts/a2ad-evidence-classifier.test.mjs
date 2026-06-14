import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  classifyEvidenceBundle,
  classifyEvidenceRecord,
  classifyEvidenceText,
} from './a2ad-evidence-classifier.mjs';

const script = new URL('./a2ad-evidence-classifier.mjs', import.meta.url).pathname;

test('source-root bridge failures are blocked from substantive worker opinions', () => {
  const result = classifyEvidenceText('analysis bridge blocked: repo root missing for jinwon-int/a2a-plane; check A2A_ANALYSIS_REPO_MAP_JSON');
  assert.equal(result.classification, 'source_blocked');
  assert.equal(result.substantive, false);
  assert.equal(result.countsAsWorkerOpinion, false);
  assert.match(result.blockers.join('\n'), /source mapping\/analysis bridge failure/i);
});

test('GitHub PR source failures are blocked from substantive worker opinions', () => {
  const result = classifyEvidenceText('analysis bridge blocked: GitHub PR source unavailable for jinwon-int/a2a-nexus#627: gh pr diff 627 failed');
  assert.equal(result.classification, 'source_blocked');
  assert.equal(result.substantive, false);
  assert.equal(result.countsAsWorkerOpinion, false);
});

test('wrapper-only dry-run outputs are reportable but not worker reasoning', () => {
  const result = classifyEvidenceText('Hermes reference worker completed local dry-run evidence');
  assert.equal(result.classification, 'wrapper_only');
  assert.equal(result.substantive, false);
  assert.equal(result.countsAsWorkerOpinion, false);
  assert.match(result.blockers.join('\n'), /wrapper\/plumbing output/i);
});

test('substantive outputs can count as A2AD worker opinion', () => {
  const text = [
    'Recommendation: staged GO, immediate NO-GO until source bundle mapping and CI parity are validated.',
    'Risk: package naming drift can break release gates and rollback docs.',
    'Evidence ref: package.json workspace diff, CI parity checker, and rollback fixture.',
    'Implementation: add a regression test and require finalizer to keep release/tag hold until acceptance checks pass.',
  ].join(' ');
  const result = classifyEvidenceText(text);
  assert.equal(result.classification, 'substantive');
  assert.equal(result.substantive, true);
  assert.equal(result.countsAsWorkerOpinion, true);
});

test('bundle summary exposes finalizer blockers for mixed evidence', () => {
  const report = classifyEvidenceBundle({
    results: [
      { workerId: 'sogyo', output: 'analysis bridge blocked: source root unavailable' },
      { workerId: 'gongyung', output: 'Hermes reference worker completed local dry-run evidence' },
      {
        workerId: 'nosuk',
        output: 'Recommendation: staged GO; Risk: issue routing drift; Evidence ref: GitHub issue and CI logs; Implementation: add schema test and rollback acceptance gate.',
      },
    ],
  });
  assert.equal(report.counts.source_blocked, 1);
  assert.equal(report.counts.wrapper_only, 1);
  assert.equal(report.counts.substantive, 1);
  assert.equal(report.ok, true);
  assert.match(report.finalizerBlockers.join('\n'), /sogyo: source mapping/i);
  assert.match(report.finalizerBlockers.join('\n'), /gongyung: wrapper\/plumbing/i);
});

test('record classifier extracts nested error stdout/stderr without leaking secret-like keys', () => {
  const item = classifyEvidenceRecord({
    workerId: 'bangtong',
    token: 'should-not-matter',
    error: {
      details: {
        stdout: 'openclaw_analysis_failed: Hermes analysis bridge response did not contain valid JSON',
        stderr: 'ignored',
      },
    },
  });
  assert.equal(item.workerId, 'bangtong');
  assert.equal(item.classification, 'source_blocked');
});

test('CLI exits non-zero when required substantive evidence is absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a2ad-evidence-classifier-'));
  try {
    const input = join(dir, 'results.json');
    await writeFile(input, JSON.stringify([{ workerId: 'daegyo', output: 'analysis-only completed' }], null, 2));
    const result = spawnSync(process.execPath, [script, '--input', input, '--require-substantive'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /blocked finalization/);
    assert.match(result.stdout, /wrapper_only/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CLI succeeds when minimum substantive evidence is present', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a2ad-evidence-classifier-'));
  try {
    const input = join(dir, 'results.json');
    await writeFile(input, JSON.stringify([
      {
        workerId: 'soonwook',
        output: 'Recommendation: staged GO; Risk: release drift; Evidence ref: CI and source evidence; Implementation: update tests and rollback acceptance gate before final GO.',
      },
    ], null, 2));
    const result = spawnSync(process.execPath, [script, '--input', input, '--require-substantive'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /substantive/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
