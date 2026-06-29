import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runArtifactScan(args, options = {}) {
  return execFileSync(process.execPath, ['scripts/a2a-round-artifact-scan.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    ...options,
  });
}

describe('a2a round artifact scanner', () => {
  it('flags cross-repo PR evidence and canonical open PR artifacts from a round snapshot', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'a2a-round-artifact-scan-'));
    try {
      const tasksPath = join(tmp, 'tasks.json');
      const openPrsPath = join(tmp, 'open-prs.json');
      writeFileSync(tasksPath, JSON.stringify({
        items: [
          {
            id: 'round-1129-bangtong',
            intent: 'propose_patch',
            assignedWorkerId: 'bangtong',
            status: 'succeeded',
            result: {
              output: {
                repo: 'jinwon-int/a2a-nexus',
                issueUrl: 'https://github.com/jinwon-int/a2a-nexus/issues/1129',
                github: {
                  startCommentUrl: 'https://github.com/jinwon-int/a2a-nexus/issues/1129#issuecomment-1',
                  prUrl: 'https://github.com/jinwon-int/example/pull/1',
                },
              },
            },
          },
          {
            id: 'round-1132-gongmyoung',
            intent: 'analyze',
            assignedWorkerId: 'gongmyoung',
            status: 'succeeded',
            result: { summary: 'source-only validation done' },
          },
        ],
      }), 'utf8');
      writeFileSync(openPrsPath, JSON.stringify([
        {
          number: 1134,
          title: 'Patch: round-1129-bangtong',
          headRefName: 'a2a-patch-20260629-round-1129-bangtong',
          url: 'https://github.com/jinwon-int/a2a-nexus/pull/1134',
          state: 'OPEN',
        },
      ]), 'utf8');

      const report = JSON.parse(runArtifactScan(['--input', tasksPath, '--open-prs', openPrsPath, '--repo', 'jinwon-int/a2a-nexus', '--json']));
      assert.equal(report.ok, false);
      assert.equal(report.totalTasks, 2);
      assert.deepEqual(report.counts, {
        canonicalEvidence: 1,
        crossRepoEvidence: 1,
        missingCompletionEvidence: 0,
        openPrArtifacts: 1,
      });
      assert.deepEqual(report.crossRepoEvidence, [
        {
          taskId: 'round-1129-bangtong',
          worker: 'bangtong',
          status: 'succeeded',
          key: 'prUrl',
          url: 'https://github.com/jinwon-int/example/pull/1',
          repo: 'jinwon-int/example',
          expectedRepo: 'jinwon-int/a2a-nexus',
        },
      ]);
      assert.equal(report.openPrArtifacts[0].number, 1134);
      assert.match(report.summary, /cross-repo evidence=1/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ignores clone repo URLs in diagnostic text and does not treat .git remotes as evidence', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'a2a-round-artifact-scan-'));
    try {
      const tasksPath = join(tmp, 'tasks.json');
      writeFileSync(tasksPath, JSON.stringify({
        items: [
          {
            id: 'round-1123-nosuk',
            intent: 'analyze',
            assignedWorkerId: 'nosuk',
            status: 'failed',
            error: { details: { stdout: JSON.stringify({ repo: 'https://github.com/jinwon-int/a2a-nexus.git' }) } },
          },
        ],
      }), 'utf8');
      const report = JSON.parse(runArtifactScan(['--input', tasksPath, '--repo', 'jinwon-int/a2a-nexus', '--json']));
      assert.equal(report.ok, true);
      assert.deepEqual(report.crossRepoEvidence, []);
      assert.equal(report.counts.canonicalEvidence, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fails propose_patch lanes that finish without PR/Done/Block evidence', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'a2a-round-artifact-scan-'));
    try {
      const tasksPath = join(tmp, 'tasks.json');
      writeFileSync(tasksPath, JSON.stringify({
        tasks: [
          { id: 'round-1125-yukson', intent: 'propose_patch', assignedWorkerId: 'yukson', status: 'succeeded', result: { summary: 'done but no urls' } },
        ],
      }), 'utf8');
      const report = JSON.parse(runArtifactScan(['--input', tasksPath, '--repo', 'jinwon-int/a2a-nexus', '--json']));
      assert.equal(report.ok, false);
      assert.deepEqual(report.missingCompletionEvidence, [
        {
          taskId: 'round-1125-yukson',
          worker: 'yukson',
          status: 'succeeded',
          intent: 'propose_patch',
          reason: 'propose_patch terminal lane lacks canonical prUrl/doneCommentUrl/blockCommentUrl evidence',
        },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
