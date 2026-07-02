import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  runGuard,
  classifyTaskEvidence,
} from './a2a-skill-guard.mjs';

function tempFile(name, value) {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-skill-guard-'));
  const p = join(dir, name);
  writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return p;
}

test('manifest guard fails source-only A2AD lanes shaped as GitHub patch tasks (#1035)', () => {
  const manifest = tempFile('manifest.json', {
    roundId: 'r1',
    lanes: [{
      id: 'r1:1',
      intent: 'propose_patch',
      target: { id: 'workerBeta', role: 'analyst' },
      payload: { mode: 'github-propose-patch', sourceOnly: true, noGitHubWrites: true },
    }],
  });

  const out = runGuard(['manifest', '--manifest', manifest, '--mode', 'a2ad']);

  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /source-only A2AD.*intent=analyze/.test(e)), out.errors.join('\n'));
});

test('manifest guard accepts canonical source-only A2AD analysis lanes (#1035)', () => {
  const manifest = tempFile('manifest.json', {
    roundId: 'r1',
    defaults: { intent: 'analyze', payload: { mode: 'analysis-only', sourceOnly: true, noGitHubWrites: true, noLive: true } },
    lanes: [{ id: 'r1:1', target: { id: 'workerBeta', role: 'analyst' }, message: 'review' }],
  });

  const out = runGuard(['manifest', '--manifest', manifest, '--mode', 'a2ad']);

  assert.equal(out.ok, true, out.errors.join('\n'));
});

test('formal-evidence guard blocks finalizer drafts that cite quorum without succeeded task IDs (#1035)', () => {
  const tasks = tempFile('tasks.json', { items: [
    { id: 'task-a', status: 'succeeded', payload: { parentRoundId: 'r1' }, output: { findings: ['ok'] } },
    { id: 'task-b', status: 'running', payload: { parentRoundId: 'r1' } },
  ] });
  const draft = tempFile('draft.md', 'Formal A2A quorum reached: 2/2 succeeded.');

  const out = runGuard(['formal-evidence', '--round-status', tasks, '--round', 'r1', '--finalizer-draft', draft]);

  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /must cite succeeded task id/.test(e)), out.errors.join('\n'));
  assert.ok(out.errors.some((e) => /non-terminal/.test(e)), out.errors.join('\n'));
});

test('pr-body-boundary guard rejects PR-only live-validation closure keywords (#1035)', () => {
  const body = tempFile('body.md', 'This PR only adds source checks. Closes #123. No live deploy.');

  const out = runGuard(['pr-body-boundary', '--body', body, '--mode', 'pr-only-live-validation']);

  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /Refs #123/.test(e)), out.errors.join('\n'));
});

test('repo-sweep-closeout guard requires zero open issues and PRs (#1035)', () => {
  const issues = tempFile('issues.json', [{ number: 1035, state: 'OPEN' }]);
  const prs = tempFile('prs.json', []);

  const out = runGuard(['repo-sweep-closeout', '--issues', issues, '--prs', prs]);

  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /open issues: 1/.test(e)), out.errors.join('\n'));
});

test('manifest guard fails source bundles with oversized raw artifact injection (#1027/#1035)', () => {
  const manifest = tempFile('manifest.json', {
    roundId: 'r1',
    defaults: { intent: 'analyze', payload: { mode: 'analysis-only', sourceOnly: true, noGitHubWrites: true, noLive: true } },
    lanes: [{
      id: 'r1:1',
      target: { id: 'workerBeta', role: 'analyst' },
      message: 'review',
      payload: { sourceBundle: { files: [{ path: 'raw.log', content: 'x'.repeat(120) }] } },
    }],
  });

  const out = runGuard(['manifest', '--manifest', manifest, '--mode', 'a2ad', '--max-artifact-chars', '64']);

  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /raw\.log.*exceeds.*64/.test(e)), out.errors.join('\n'));
});

test('formal-evidence guard detects verifier regression against protected baseline (#1027)', () => {
  const tasks = tempFile('tasks.json', { items: [
    { id: 'task-a', status: 'succeeded', payload: { parentRoundId: 'r1' }, output: { findings: ['ok'] } },
  ] });
  const baseline = tempFile('baseline.json', { protectedAcceptedTaskIds: ['task-a'] });
  const draft = tempFile('draft.md', 'Formal A2A quorum reached. task-a is now rejected by verifier.');

  const out = runGuard(['formal-evidence', '--round-status', tasks, '--round', 'r1', '--finalizer-draft', draft, '--baseline', baseline]);

  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /verifier regression.*task-a/.test(e)), out.errors.join('\n'));
});

test('scorecard reports cost per accepted substantive change (#1027)', () => {
  const tasks = tempFile('tasks.json', { items: [
    { id: 'task-a', status: 'succeeded', output: { findings: ['real finding'], acceptedChanges: 2, estimatedCostUsd: 1.5 } },
    { id: 'task-b', status: 'failed', error: { code: 'docker_runner_failed' }, output: { estimatedCostUsd: 0.5 } },
  ] });

  const out = runGuard(['scorecard', '--tasks', tasks]);

  assert.equal(out.ok, true);
  assert.equal(out.report.cost.totalCostUsd, 2);
  assert.equal(out.report.cost.acceptedChanges, 2);
  assert.equal(out.report.cost.costPerAcceptedChangeUsd, 1);
});

test('scorecard classifies infra/wrapper output as non-substantive evidence (#1035)', () => {
  assert.deepEqual(classifyTaskEvidence({ status: 'failed', error: { code: 'docker_runner_failed' } }), {
    evidenceClass: 'infra_blocker',
    countsTowardScore: false,
  });
  assert.deepEqual(classifyTaskEvidence({ status: 'succeeded', output: { summary: 'generic a2ad-review task accepted' } }), {
    evidenceClass: 'wrapper_only',
    countsTowardScore: false,
  });
  assert.deepEqual(classifyTaskEvidence({ status: 'succeeded', output: { findings: ['real finding'] } }), {
    evidenceClass: 'substantive',
    countsTowardScore: true,
  });
});
