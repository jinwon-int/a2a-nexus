import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./round-closeout-report.mjs', import.meta.url).pathname;

test('round closeout report emits per-lane JSON and markdown safely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'round-closeout-'));
  const tasks = [
    { id: 'r-01-a', status: 'succeeded', assignedWorkerId: 'a', payload: { parentRoundOrder: 1 }, output: { analysisStatus: 'done', analysisSummary: 'recommendation risk evidence CI test acceptance implementation schema diff rollback source evidence', findings: ['ok'], evidenceRefs: ['e1'] } },
    { id: 'r-02-b', status: 'succeeded', assignedWorkerId: 'b', payload: { parentRoundOrder: 2, supplementOf: 'r-02' }, output: { analysisStatus: 'blocked', analysisSummary: 'source bundle 0 files blocked', sourceProjection: { quality: 'zero_files' } } },
    { id: 'r-03-c', status: 'queued', assignedWorkerId: 'c', payload: { parentRoundOrder: 3 } },
  ];
  const input = join(dir, 'tasks.json');
  writeFileSync(input, JSON.stringify({ items: tasks }));
  const json = JSON.parse(execFileSync(process.execPath, [script, '--round-id', 'r', '--tasks', input], { encoding: 'utf8' }));
  assert.equal(json.schemaVersion, 'a2a-round-closeout.v1');
  assert.equal(json.summary.total, 3);
  assert.equal(json.summary.pending, 1);
  assert.equal(json.summary.nonSubstantive, 2);
  assert.equal(json.lanes[0].workerId, 'a');
  assert.equal(json.lanes[1].evidenceQuality, 'source_projection_zero_files');
  assert.match(json.lanes[1].failureReason, /supplement or rerun/);
  assert.equal(json.lanes[1].supplementOf, 'r-02');
  const md = execFileSync(process.execPath, [script, '--round-id', 'r', '--tasks', input, '--markdown', '--out-dir', join(dir, 'out')], { encoding: 'utf8' });
  assert.match(md, /A2A round closeout: r/);
  assert.match(readFileSync(join(dir, 'out', 'closeout.md'), 'utf8'), /\| order \| worker \|/);
});
