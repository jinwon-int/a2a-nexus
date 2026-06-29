import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function runReadiness(args) {
  return execFileSync(process.execPath, ['scripts/a2a-worker-readiness-matrix.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('a2a worker readiness matrix', () => {
  it('separates online status from patch-capable readiness and explains blockers', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'a2a-worker-readiness-'));
    try {
      const capacityPath = join(tmp, 'capacity.json');
      const auditPath = join(tmp, 'audit.json');
      writeFileSync(capacityPath, JSON.stringify({
        workers: [
          { id: 'bangtong', online: true, active: 0, metadata: { platform: 'linux' } },
          { id: 'dungae', online: true, active: 0, metadata: { platform: 'linux' } },
          { id: 'gongyung', online: true, active: 0, metadata: { platform: 'termux' } },
        ],
      }), 'utf8');
      writeFileSync(auditPath, JSON.stringify({
        workers: [
          { id: 'bangtong', hasClaudeConfig: true, hasTrustedOperator: true, hasPatchBridge: true, hasGitHubAuth: true },
          { id: 'dungae', hasClaudeConfig: false, hasTrustedOperator: true, hasPatchBridge: true, hasGitHubAuth: true },
          { id: 'gongyung', hasClaudeConfig: true, hasTrustedOperator: true, hasPatchBridge: false, hasGitHubAuth: true, mobile: true },
        ],
      }), 'utf8');

      const report = JSON.parse(runReadiness(['--capacity', capacityPath, '--audit', auditPath, '--json']));
      assert.equal(report.ok, false);
      assert.deepEqual(report.counts, {
        total: 3,
        online: 3,
        analysisCapable: 3,
        patchCapable: 1,
        blockedPatch: 2,
      });
      assert.deepEqual(report.workers.map((worker) => ({ id: worker.id, patchCapable: worker.patchCapable, blockers: worker.blockers })), [
        { id: 'bangtong', patchCapable: true, blockers: [] },
        { id: 'dungae', patchCapable: false, blockers: ['missing Claude config'] },
        { id: 'gongyung', patchCapable: false, blockers: ['missing patch bridge script'] },
      ]);
      assert.match(report.summary, /online=3/);
      assert.match(report.summary, /patch-capable=1/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('can limit output to audited workers so stale historical smoke rows do not pollute an implementation readiness report', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'a2a-worker-readiness-'));
    try {
      const capacityPath = join(tmp, 'capacity.json');
      const auditPath = join(tmp, 'audit.json');
      writeFileSync(capacityPath, JSON.stringify({
        items: [
          { nodeId: 'bangtong', status: 'online', counts: { active: 0 } },
          { nodeId: 'seoseo-terminal-smoke-worker-071830', status: 'stale', counts: { active: 0 } },
        ],
      }), 'utf8');
      writeFileSync(auditPath, JSON.stringify([{ id: 'bangtong', hasClaudeConfig: true, hasTrustedOperator: true, hasPatchBridge: true, hasGitHubAuth: true }]), 'utf8');

      const report = JSON.parse(runReadiness(['--capacity', capacityPath, '--audit', auditPath, '--only-audited', '--json']));
      assert.equal(report.counts.total, 1);
      assert.equal(report.workers[0].id, 'bangtong');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('deduplicates repeated worker rows across brokers and prefers the online record', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'a2a-worker-readiness-'));
    try {
      const capacityPath = join(tmp, 'capacity.json');
      const auditPath = join(tmp, 'audit.json');
      writeFileSync(capacityPath, JSON.stringify({
        items: [
          { nodeId: 'soonwook', status: 'stale', counts: { active: 1 } },
          { nodeId: 'soonwook', status: 'online', counts: { active: 0 } },
        ],
      }), 'utf8');
      writeFileSync(auditPath, JSON.stringify([{ id: 'soonwook', hasClaudeConfig: true, hasTrustedOperator: true, hasPatchBridge: true, hasGitHubAuth: true }]), 'utf8');

      const report = JSON.parse(runReadiness(['--capacity', capacityPath, '--audit', auditPath, '--only-audited', '--json']));
      assert.equal(report.counts.total, 1);
      assert.equal(report.workers[0].id, 'soonwook');
      assert.equal(report.workers[0].online, true);
      assert.equal(report.workers[0].patchCapable, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('marks trusted-operator absence as a GitHub side-effect blocker without implying analysis failure', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'a2a-worker-readiness-'));
    try {
      const capacityPath = join(tmp, 'capacity.json');
      const auditPath = join(tmp, 'audit.json');
      writeFileSync(capacityPath, JSON.stringify([{ id: 'yukson', online: true, active: 0 }]), 'utf8');
      writeFileSync(auditPath, JSON.stringify([{ id: 'yukson', hasClaudeConfig: true, hasTrustedOperator: false, hasPatchBridge: true, hasGitHubAuth: true }]), 'utf8');

      const report = JSON.parse(runReadiness(['--capacity', capacityPath, '--audit', auditPath, '--json']));
      assert.equal(report.workers[0].analysisCapable, true);
      assert.equal(report.workers[0].patchCapable, false);
      assert.deepEqual(report.workers[0].blockers, ['missing trusted-operator policy for GitHub mutation']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
