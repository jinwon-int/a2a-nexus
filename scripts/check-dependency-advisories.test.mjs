import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADVISORY_ALLOWLIST,
  collectBlockingAdvisories,
  evaluateAllowlist,
  summarizeAudit,
  validateAllowlist,
} from './check-dependency-advisories.mjs';

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

function writeAllowlist(entries) {
  const dir = fs.mkdtempSync(path.join(repo, 'node_modules/.tmp-advisory-'));
  const file = path.join(dir, 'allowlist.json');
  fs.writeFileSync(file, JSON.stringify(entries));
  return file;
}

const HIGH_FIXTURE = {
  vulnerabilities: {
    leftpad: {
      severity: 'high',
      via: [{ title: 'synthetic high advisory', severity: 'high', name: 'leftpad', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }],
    },
  },
};

// The gate was armed in #2050: auto-merge only requires CI
// `conclusion == 'success'`, so exiting 0 on high/critical let a vulnerable PR
// land unattended. Restoring the warn-only exit 0 must fail this test.
test('armed CLI exits non-zero for unwaived high advisories (#2050)', () => {
  const fixture = writeFixture(HIGH_FIXTURE);
  const res = spawnSync(process.execPath, [script, '--audit-json', fixture], { cwd: repo, encoding: 'utf8' });
  assert.equal(res.status, 1, `expected exit 1, got ${res.status}: ${res.stdout}${res.stderr}`);
  assert.match(res.stdout, /dependency advisories summary: total=1/);
  assert.match(res.stderr, /dependency advisories failed: high_or_critical=1 unwaived=1/);
  assert.match(res.stderr, /GHSA-AAAA-BBBB-CCCC/);
});

test('armed CLI exits non-zero for unwaived critical advisories (#2050)', () => {
  const fixture = writeFixture({
    vulnerabilities: { shellwords: { severity: 'critical', via: [{ title: 'synthetic critical advisory' }] } },
  });
  const res = spawnSync(process.execPath, [script, '--audit-json', fixture], { cwd: repo, encoding: 'utf8' });
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stderr, /unwaived=1/);
  assert.match(res.stderr, /pkg:shellwords\(critical,shellwords\)/);
});

test('an unexpired allowlist entry waives the advisory and the gate exits zero', () => {
  const fixture = writeFixture(HIGH_FIXTURE);
  const allowlist = writeAllowlist([
    { id: 'GHSA-aaaa-bbbb-cccc', package: 'leftpad', reason: 'reviewed: not reachable from published entrypoints', expires: '2999-01-01', issue: '#2050' },
  ]);
  const res = spawnSync(process.execPath, [script, '--audit-json', fixture, '--allowlist-json', allowlist], { cwd: repo, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /dependency advisories waived: id=GHSA-AAAA-BBBB-CCCC severity=high expires=2999-01-01/);
  assert.match(res.stdout, /dependency advisories ok: high_or_critical=1 all_waived=1/);
});

test('an expired allowlist entry stops waiving and the gate fails again', () => {
  const fixture = writeFixture(HIGH_FIXTURE);
  const allowlist = writeAllowlist([
    { id: 'GHSA-aaaa-bbbb-cccc', reason: 'accepted while the upstream fix was pending', expires: '2020-01-01' },
  ]);
  const res = spawnSync(process.execPath, [script, '--audit-json', fixture, '--allowlist-json', allowlist], { cwd: repo, encoding: 'utf8' });
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stderr, /dependency advisories allowlist expired: id=GHSA-AAAA-BBBB-CCCC expired=2020-01-01/);
});

test('a malformed allowlist entry fails the gate even with a clean audit', () => {
  const fixture = writeFixture({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } });
  const allowlist = writeAllowlist([{ id: 'GHSA-aaaa-bbbb-cccc', reason: 'short' }]);
  const res = spawnSync(process.execPath, [script, '--audit-json', fixture, '--allowlist-json', allowlist], { cwd: repo, encoding: 'utf8' });
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stderr, /allowlist_invalid/);
  assert.match(res.stderr, /reason must explain/);
  assert.match(res.stderr, /expires must be a YYYY-MM-DD date/);
});

test('low and moderate advisories still pass the armed gate', () => {
  const fixture = writeFixture({
    vulnerabilities: {
      lowpkg: { severity: 'low', via: [{ title: 'low advisory', severity: 'low' }] },
      modpkg: { severity: 'moderate', via: [{ title: 'moderate advisory', severity: 'moderate' }] },
    },
  });
  const res = spawnSync(process.execPath, [script, '--audit-json', fixture], { cwd: repo, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /low=1 moderate=1 high=0 critical=0/);
  assert.equal(res.stderr, '');
});

test('high counts without per-advisory detail fail closed instead of passing', () => {
  const fixture = writeFixture({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 } } });
  const res = spawnSync(process.execPath, [script, '--audit-json', fixture], { cwd: repo, encoding: 'utf8' });
  assert.equal(res.status, 1, res.stdout);
  assert.match(res.stderr, /unidentifiable=true/);
});

test('the shipped allowlist is structurally valid and empty by default', () => {
  assert.deepEqual(validateAllowlist(ADVISORY_ALLOWLIST), []);
  assert.deepEqual(ADVISORY_ALLOWLIST, []);
});

test('collectBlockingAdvisories ignores non-blocking severities', () => {
  const findings = collectBlockingAdvisories({
    vulnerabilities: {
      lowpkg: { severity: 'low', via: [{ severity: 'low' }] },
      hipkg: { severity: 'high', via: [{ severity: 'high', source: 123456 }] },
    },
  });
  assert.deepEqual(findings.map((finding) => finding.id), ['123456']);
});

test('evaluateAllowlist waives by pkg pseudo-id when no advisory id exists', () => {
  const findings = collectBlockingAdvisories({
    vulnerabilities: { shellwords: { severity: 'critical', via: [{ title: 'no id' }] } },
  });
  const result = evaluateAllowlist({
    findings,
    allowlist: [{ id: 'pkg:shellwords', reason: 'reviewed and accepted for now', expires: '2999-01-01' }],
    now: new Date('2026-09-06T00:00:00Z'),
  });
  assert.equal(result.unwaived.length, 0);
  assert.equal(result.waived.length, 1);
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
