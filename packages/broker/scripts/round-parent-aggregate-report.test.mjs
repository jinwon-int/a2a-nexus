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
