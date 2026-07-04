import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeAudit } from './check-dependency-advisories.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts/check-dependency-advisories.mjs');

function writeFixture(doc) {
  const dir = fs.mkdtempSync(path.join(repo, 'node_modules/.tmp-advisory-'));
  const file = path.join(dir, 'audit.json');
  fs.writeFileSync(file, JSON.stringify(doc));
  return file;
}

test('summarizeAudit uses npm metadata vulnerability counts', () => {
  const summary = summarizeAudit({ metadata: { vulnerabilities: { info: 0, low: 1, moderate: 2, high: 3, critical: 4, total: 10 } } });
  assert.equal(summary.total, 10);
  assert.equal(summary.highOrCritical, 7);
});

test('warn-only CLI exits zero for high and critical advisories', () => {
  const fixture = writeFixture({
    vulnerabilities: {
      leftpad: { severity: 'high', via: [{ title: 'synthetic high advisory' }] },
      shellwords: { severity: 'critical', via: [{ title: 'synthetic critical advisory' }] },
    },
  });
  const res = spawnSync(process.execPath, [script, '--audit-json', fixture], { cwd: repo, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /dependency advisories summary: total=2/);
  assert.match(res.stderr, /dependency advisories warning: high_or_critical=2/);
});

test('clean audit fixture exits zero without warnings', () => {
  const fixture = writeFixture({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } });
  const res = spawnSync(process.execPath, [script, '--audit-json', fixture], { cwd: repo, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /total=0/);
  assert.equal(res.stderr, '');
});

test('unreadable audit file skips with reason instead of failing closed', () => {
  const res = spawnSync(process.execPath, [script, '--audit-json', '/no/such/audit.json'], { cwd: repo, encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /dependency advisories skipped: reason=audit_json_unreadable/);
});


test('malformed explicit audit fixture fails instead of silently skipping', () => {
  const dir = fs.mkdtempSync(path.join(repo, 'node_modules/.tmp-advisory-'));
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{not json');
  const res = spawnSync(process.execPath, [script, '--audit-json', file], { cwd: repo, encoding: 'utf8' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /audit_json_malformed/);
});
