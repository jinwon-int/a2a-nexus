import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(new URL('../..', import.meta.url).pathname);
const script = path.join(repo, 'scanner/readiness/check-approval-records.mjs');
function fixtureRoot(record) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-record-'));
  fs.mkdirSync(path.join(dir, 'fixtures/approvals'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'fixtures/approvals/approval-record.schema.json'), path.join(dir, 'fixtures/approvals/approval-record.schema.json'));
  fs.writeFileSync(path.join(dir, 'fixtures/approvals/sample.json'), JSON.stringify(record, null, 2));
  return dir;
}

test('valid approval record passes', () => {
  const cwd = fixtureRoot({ action: 'release-tag', target: 'v0.1.0-alpha.1', approverRole: 'operator', approvedAt: '2026-07-01T00:00:00Z', rollbackBoundary: 'no tag is created by this record', evidenceIssue: 1166 });
  const r = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('personal/private fields fail closed', () => {
  const cwd = fixtureRoot({ action: 'release-tag', target: 'v0.1.0-alpha.1', approverRole: 'operator', approvedAt: '2026-07-01T00:00:00Z', rollbackBoundary: 'none', evidenceIssue: 1166, channel: 'private DM' });
  const r = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /forbidden_private_field|additional_property/);
});
