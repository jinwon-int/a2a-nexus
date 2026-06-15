import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(args, options = {}) {
  return execFileSync(process.execPath, ['scripts/round-parent-aggregate-report.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    ...options,
  });
}

describe('round parent aggregate report CLI', () => {
  it('emits parent-aggregate-comment taskReport JSON from task snapshots (#629)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'round-parent-report-'));
    try {
      const tasksPath = join(tmp, 'tasks.json');
      writeFileSync(tasksPath, JSON.stringify({
        items: [
          {
            id: 'round-task-1',
            intent: 'analyze',
            requester: { id: 'hub', kind: 'node', role: 'hub' },
            target: { id: 'sogyo', kind: 'node', role: 'analyst' },
            targetNodeId: 'sogyo',
            assignedWorkerId: 'sogyo',
            status: 'succeeded',
            parentRoundId: 'round-629',
            parentRoundTotal: 2,
            parentRoundOrder: 1,
            createdAt: '2026-06-15T00:00:00.000Z',
            updatedAt: '2026-06-15T00:01:00.000Z',
          },
        ],
      }), 'utf8');

      const stdout = run(['--round-id', 'round-629', '--tasks', tasksPath, '--generated-at', '2026-06-15T10:30:00.000Z']);
      const report = JSON.parse(stdout);
      assert.equal(report.parentRoundId, 'round-629');
      assert.equal(report.generatedAt, '2026-06-15T10:30:00.000Z');
      assert.equal(report.total, 2);
      assert.equal(report.terminal, 1);
      assert.equal(report.active, 1);
      assert.equal(report.reportable, 2);
      assert.match(report.items[0].reportLine, /terminal: sogyo lane=1 task=round-task-1 status=succeeded/);
      assert.match(report.items[1].reportLine, /missing: expected lane 2\/2 has no task record yet/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('surfaces source bundle quality, safe failure reasons, and queued mobile lanes (#758)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'round-parent-report-'));
    try {
      const tasksPath = join(tmp, 'tasks.json');
      writeFileSync(tasksPath, JSON.stringify({
        items: [
          {
            id: 'round-task-dungae',
            intent: 'analyze',
            requester: { id: 'hub', kind: 'node', role: 'hub' },
            target: { id: 'dungae', kind: 'node', role: 'analyst' },
            targetNodeId: 'dungae',
            assignedWorkerId: 'dungae',
            status: 'succeeded',
            parentRoundId: 'round-758',
            parentRoundTotal: 3,
            parentRoundOrder: 1,
            payload: {
              sourceBundle: {
                files: [
                  { path: 'generated/issue-inventory.json', content: '{"ok":true}' },
                  { path: 'scripts/a2ad-finalizer-gate.mjs', content: '' },
                ],
              },
            },
          },
          {
            id: 'round-task-soonwook',
            intent: 'analyze',
            target: { id: 'soonwook', kind: 'node', role: 'analyst' },
            assignedWorkerId: 'soonwook',
            status: 'failed',
            parentRoundId: 'round-758',
            parentRoundTotal: 3,
            parentRoundOrder: 2,
            error: {
              code: 'handler_exit_nonzero',
              message: 'handler exited with code 1',
              details: {
                stdout: JSON.stringify({
                  error: {
                    code: 'openclaw_analysis_failed',
                    message: 'Hermes exited with 1: xAI OAuth state is missing access_token. TOKEN=should-not-leak Authorization: Bearer bearer-secret "access_token":"json-secret" api_key: colon-secret callback?token=query-secret&x=1',
                  },
                }),
              },
            },
          },
          {
            id: 'round-task-daegyo',
            intent: 'analyze',
            target: { id: 'daegyo', kind: 'node', role: 'analyst' },
            assignedWorkerId: 'daegyo',
            status: 'queued',
            parentRoundId: 'round-758',
            parentRoundTotal: 3,
            parentRoundOrder: 3,
          },
        ],
      }), 'utf8');

      const stdout = run(['--round-id', 'round-758', '--tasks', tasksPath, '--generated-at', '2026-06-15T10:30:00.000Z']);
      const report = JSON.parse(stdout);
      assert.equal(report.diagnostics.sourceBundle.quality, 'partial');
      assert.equal(report.diagnostics.sourceBundle.lanesWithSourceBundle, 1);
      assert.equal(report.diagnostics.sourceBundle.lanesMissingSourceBundle, 2);
      assert.equal(report.diagnostics.sourceBundle.maxFileCount, 2);
      assert.equal(report.diagnostics.sourceBundle.emptyContentFiles, 1);
      assert.deepEqual(report.diagnostics.failureReasons, [
        {
          taskId: 'round-task-soonwook',
          worker: 'soonwook',
          status: 'failed',
          reasonCode: 'handler_exit_nonzero',
          message: 'Hermes exited with 1: xAI OAuth state is missing access_token. TOKEN=[redacted] Authorization: Bearer [redacted] "access_token":"[redacted]" api_key: [redacted] callback?token=[redacted]&x=1',
        },
      ]);
      assert.deepEqual(report.diagnostics.pendingLanes, [
        {
          taskId: 'round-task-daegyo',
          worker: 'daegyo',
          status: 'queued',
          reasonCode: 'mobile_no_live_queued',
        },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects snapshots without a task array', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'round-parent-report-'));
    try {
      const tasksPath = join(tmp, 'bad.json');
      writeFileSync(tasksPath, JSON.stringify({ nope: true }), 'utf8');
      assert.throws(
        () => run(['--round-id', 'round-629', '--tasks', tasksPath], { stdio: 'pipe' }),
        /tasks snapshot must be an array/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
