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

test('echo-handler fallback outputs are degraded evidence, not worker reasoning (#810)', () => {
  const result = classifyEvidenceText('echo handled task: built-in echo fallback responded without invoking external handler or analysis bridge');
  assert.equal(result.classification, 'wrapper_only');
  assert.equal(result.substantive, false);
  assert.equal(result.countsAsWorkerOpinion, false);
  assert.match(result.blockers.join('\n'), /wrapper\/plumbing output/i);
  assert.match(result.reasons.join('\n'), /echo/i);
});

test('echo-handler fallback remains degraded even when it echoes substantive prompt markers (#810)', () => {
  const result = classifyEvidenceText([
    'echo handled task: built-in echo fallback responded without invoking external handler.',
    'Please provide Recommendation, Risk, Evidence ref, Implementation, tests, CI, rollback, and acceptance for this PR.',
  ].join(' '));
  assert.equal(result.classification, 'wrapper_only');
  assert.equal(result.substantive, false);
  assert.equal(result.countsAsWorkerOpinion, false);
  assert.match(result.reasons.join('\n'), /echo/i);
});

test('record classifier keeps echo fallback degraded when status metadata precedes output (#810)', () => {
  const result = classifyEvidenceRecord({
    workerId: 'nosuk',
    status: 'completed',
    output: [
      'echo handled task: built-in echo fallback responded without invoking external handler.',
      'Please provide Recommendation, Risk, Evidence ref, Implementation, tests, CI, rollback, and acceptance for this PR.',
    ].join(' '),
  });
  assert.equal(result.classification, 'wrapper_only');
  assert.equal(result.substantive, false);
  assert.equal(result.countsAsWorkerOpinion, false);
  assert.match(result.reasons.join('\n'), /echo/i);
});

test('substantive analysis about echo fallback is not suppressed by provenance guard (#810)', () => {
  const result = classifyEvidenceText([
    'Recommendation: add a guardrail for the built-in echo fallback behavior in worker evidence classification.',
    'Risk: when the external handler is not invoked, echoed prompts can masquerade as worker analysis.',
    'Evidence ref: a2ad-evidence-classifier.mjs and worker task snapshots.',
    'Implementation: anchor fallback provenance detection and add tests so genuine analysis about echo handlers still counts.',
    'CI: run broker tests and rollback by reverting the classifier pattern change if needed.',
  ].join(' '));
  assert.equal(result.classification, 'substantive');
  assert.equal(result.substantive, true);
  assert.equal(result.countsAsWorkerOpinion, true);
});

test('substantive analysis lines beginning with fallback concepts still count (#810)', () => {
  const result = classifyEvidenceText([
    'Built-in echo fallback handling can mask missing worker analysis in task snapshots.',
    'External handler was not invoked in the fallback path during reproduction, so the finalizer needs a degraded-evidence guard.',
    'Recommendation: keep fallback provenance narrow and tested.',
    'Risk: broad regexes can suppress real worker analysis.',
    'Evidence ref: classifier tests and task record output.',
    'Implementation: exact echo handled task provenance only.',
    'CI: run broker tests and keep rollback by reverting this classifier change.',
  ].join('\n'));
  assert.equal(result.classification, 'substantive');
  assert.equal(result.substantive, true);
  assert.equal(result.countsAsWorkerOpinion, true);
});

test('substantive analysis can quote exact echo fallback output without being suppressed (#810)', () => {
  const result = classifyEvidenceText([
    'Recommendation: add classifier coverage for built-in echo fallback evidence.',
    'Observed fallback output:',
    'echo handled task: built-in echo fallback responded without invoking external handler.',
    'Risk: if this quoted evidence is treated as provenance, real worker analysis is discarded.',
    'Evidence ref: task snapshot output and classifier regression test.',
    'Implementation: keep hard provenance detection anchored to the actual output start only.',
    'CI: run targeted classifier tests and rollback by reverting this classifier patch.',
  ].join('\n'));
  assert.equal(result.classification, 'substantive');
  assert.equal(result.substantive, true);
  assert.equal(result.countsAsWorkerOpinion, true);
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

test('record classifier extracts nested invalid-JSON bridge failures without leaking secret-like keys', () => {
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
  assert.equal(item.classification, 'analysis_bridge_invalid_json');
  assert.equal(item.substantive, false);
  assert.equal(item.countsAsWorkerOpinion, false);
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

test('read-only validation repo mutations are classified as evidence-contract blockers (#868)', () => {
  const item = classifyEvidenceRecord({
    workerId: 'yukson',
    status: 'failed',
    error: {
      code: 'handler_exit_nonzero',
      details: {
        stdout: [
          'read_only_validation_changed_repo',
          'exitCode=4',
          'A read-only github-verify lane attempted to write docs/validation/a2a.md',
        ].join('\n'),
      },
    },
  });
  assert.equal(item.classification, 'read_only_validation_changed_repo');
  assert.equal(item.substantive, false);
  assert.equal(item.countsAsWorkerOpinion, false);
  assert.match(item.blockers.join('\n'), /read-only evidence contract/i);
});

test('docker runner missing PR/Done/Block evidence is handler artifact failure, not substantive evidence (#868)', () => {
  const item = classifyEvidenceRecord({
    workerId: 'bangtong',
    status: 'failed',
    error: {
      code: 'handler_exit_nonzero',
      message: 'handler exited with code 1',
      details: {
        stdout: 'docker_runner_failed: GitHub patch task completed without PR/Done/Block evidence. Treating as failed closed until canonical evidence is available.',
      },
    },
  });
  assert.equal(item.classification, 'handler_artifact_failure');
  assert.equal(item.substantive, false);
  assert.equal(item.countsAsWorkerOpinion, false);
  assert.match(item.blockers.join('\n'), /canonical evidence/i);
});

test('GitHub comment ledger without substantive findings is classified as runner ledger only (#868)', () => {
  const item = classifyEvidenceRecord({
    workerId: 'soonwook',
    status: 'succeeded',
    result: {
      output: {
        github: {
          outcome: 'done',
          commentLedger: {
            entries: [{ kind: 'start', url: 'https://github.com/owner/repo/issues/1#issuecomment-1' }],
            disclaimer: 'GitHub comments are evidence ledger entries, not ACK, read receipt, visibility proof, or operator approval.',
          },
        },
      },
    },
  });
  assert.equal(item.classification, 'runner_ledger_only');
  assert.equal(item.substantive, false);
  assert.equal(item.countsAsWorkerOpinion, false);
  assert.match(item.blockers.join('\n'), /ledger/i);
});

test('CLI can emit finalizer Markdown table for mixed evidence (#868)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'a2ad-evidence-classifier-'));
  try {
    const input = join(dir, 'results.json');
    await writeFile(input, JSON.stringify([
      { workerId: 'bangtong', error: { details: { stdout: 'docker_runner_failed: GitHub patch task completed without PR/Done/Block evidence.' } } },
      { workerId: 'yukson', error: { details: { stdout: 'read_only_validation_changed_repo: docs/validation/a2a.md' } } },
      { workerId: 'nosuk', output: 'Recommendation: staged GO; Risk: routing drift; Evidence ref: source and tests; Implementation: add classifier test; CI: node --test.' },
    ], null, 2));
    const result = spawnSync(process.execPath, [script, '--input', input, '--markdown'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\| worker \| classification \| counts \| blocker \|/);
    assert.match(result.stdout, /bangtong \| handler_artifact_failure/);
    assert.match(result.stdout, /yukson \| read_only_validation_changed_repo/);
    assert.match(result.stdout, /nosuk \| substantive/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bundle classifier accepts broker polling result objects with items arrays (#868)', () => {
  const report = classifyEvidenceBundle({
    runId: 'a2a-skill-guards-open-issues-20260617T110315Z-866',
    items: [
      { worker: 'bangtong', error: { details: { stdout: 'docker_runner_failed: GitHub patch task completed without PR/Done/Block evidence.' } } },
      { worker: 'yukson', error: { details: { stdout: 'read_only_validation_changed_repo: docs/validation/a2a.md' } } },
    ],
  });
  assert.equal(report.counts.handler_artifact_failure, 1);
  assert.equal(report.counts.read_only_validation_changed_repo, 1);
  assert.equal(report.classifications[0].workerId, 'bangtong');
  assert.equal(report.classifications[1].workerId, 'yukson');
});
