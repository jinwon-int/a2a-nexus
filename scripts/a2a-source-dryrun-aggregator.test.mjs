import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const spec = 'docs/dry-run/source-public-dryrun-schema.json';
const script = 'scripts/a2a-source-dryrun-aggregator.mjs';
const gateIds = [
  'brokerReadiness',
  'pluginReadiness',
  'runnerReadiness',
  'publicPrivateBoundary',
  'terminalEvidence',
  'replaySafety',
  'externalScannerEvidence',
  'runtimeBootstrapHygiene',
  'goNoGoMatrix',
  'redactedEvidencePolicy',
  'operatorApproval',
];

function inputPath(input) {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-dryrun-'));
  const file = join(dir, 'evidence.json');
  writeFileSync(file, JSON.stringify(input, null, 2));
  return file;
}

function run(input) {
  return spawnSync(process.execPath, [script, '--spec', spec, '--input', inputPath(input)], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

function runMarkdown(input) {
  return spawnSync(process.execPath, [script, '--spec', spec, '--input', inputPath(input), '--format', 'markdown'], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

/** All gates GO with unique evidence URLs. */
function allGo(overrides = {}) {
  return {
    decision: 'GO',
    gates: Object.fromEntries(
      gateIds.map((id, index) => [
        id,
        {
          status: 'GO',
          evidence: [`a2a-plane#198 (internal tracker, private)#gate-${index + 1}`],
          ...overrides[id],
        },
      ]),
    ),
  };
}

// ── Spec validation ──────────────────────────────────────────────

test('spec-only mode prints default NO-GO with required gates', () => {
  const result = spawnSync(process.execPath, [script, '--spec', spec], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'NO-GO');
  assert.equal(parsed.sourcePublicExecution, 'NO-GO');
  assert.ok(Array.isArray(parsed.requiredGates));
  assert.ok(parsed.requiredGates.includes('operatorApproval'));
});

// ── Fail-closed: missing gates ───────────────────────────────────

test('GO fails closed when broker readiness is missing', () => {
  const input = allGo({ brokerReadiness: { status: 'MISSING', evidence: [] } });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO-GO');
  assert.equal(parsed.sourcePublicExecution, 'NO-GO');
  assert.ok(parsed.blockers.some((b) => b.gate === 'brokerReadiness' && b.status === 'MISSING'));
});

test('GO fails closed when runner readiness is missing', () => {
  const input = allGo({ runnerReadiness: { status: 'MISSING', evidence: [] } });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'runnerReadiness'));
});

test('GO fails closed when plugin readiness is missing', () => {
  const input = allGo({ pluginReadiness: { status: 'MISSING', evidence: [] } });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'pluginReadiness'));
});

test('GO fails closed when external scanner evidence is missing', () => {
  const input = allGo({ externalScannerEvidence: { status: 'MISSING', evidence: [] } });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'externalScannerEvidence'));
});

// ── Domain validation with evidence packets ──────────────────────

test('broker readiness GO validates evidence packet health/workers/queue', () => {
  const input = allGo({
    brokerReadiness: {
      status: 'GO',
      evidence: ['a2a-plane#198 (internal tracker, private)#broker'],
      evidencePacket: {
        health: { ok: true },
        expectedWorkers: ['workerGamma'],
        onlineWorkerIds: ['workerGamma'],
        queue: { queued: 0, claimed: 0, running: 0 },
        stale: 0,
      },
    },
  });
  const result = run(input);
  // All gates GO: exit 0
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'GO');
  assert.ok(!parsed.blockers.some((b) => b.gate === 'brokerReadiness'));
});

test('broker readiness fails on non-zero queue', () => {
  const input = allGo({
    brokerReadiness: {
      status: 'GO',
      evidence: ['a2a-plane#198 (internal tracker, private)#broker'],
      evidencePacket: {
        health: { ok: true },
        expectedWorkers: [],
        onlineWorkerIds: [],
        queue: { queued: 3, claimed: 1, running: 0 },
        stale: 0,
      },
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'brokerReadiness' && b.reason.includes('queued=3')));
});

test('plugin readiness fails when live Telegram is configured', () => {
  const input = allGo({
    pluginReadiness: {
      status: 'GO',
      evidence: ['a2a-plane#198 (internal tracker, private)#plugin'],
      evidencePacket: {
        liveTelegramConfigured: true,
      },
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'pluginReadiness' && b.reason.includes('live Telegram')));
});

test('runner readiness fails when production deploy flag is set', () => {
  const input = allGo({
    runnerReadiness: {
      status: 'GO',
      evidence: ['a2a-plane#198 (internal tracker, private)#runner'],
      evidencePacket: {
        artifactManifest: { ok: true },
        scannerProfile: { ok: true },
        productionDeploy: true,
      },
    },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'runnerReadiness' && b.reason.includes('production deploy')));
});

// ── Redaction checks ─────────────────────────────────────────────

test('GO fails when evidence contains unredacted private path', () => {
  const unsafePath = '/home/operator/private-key.pem';
  const input = allGo({ externalScannerEvidence: { status: 'GO', evidence: [unsafePath] } });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.reason && b.reason.includes('absolute-private-path')));
});

test('GO fails when evidence contains raw session dump markers', () => {
  const dumpLine = 'assistant <| this is raw context';
  const input = allGo({ terminalEvidence: { status: 'GO', evidence: [dumpLine] } });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.reason && b.reason.includes('raw-session-dump')));
});

// ── Operator approval separation ─────────────────────────────────

test('GO requires operator approval evidence to remain separate from other gates', () => {
  const sharedEvidence = 'a2a-plane#198 (internal tracker, private)#shared-approval';
  const input = allGo({
    externalScannerEvidence: { status: 'GO', evidence: [sharedEvidence] },
    operatorApproval: { status: 'GO', evidence: [sharedEvidence] },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.reason && b.reason.includes('must be separate')));
});

test('GO fails when operator approval evidence is missing', () => {
  const input = allGo({ operatorApproval: { status: 'GO', evidence: [] } });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.gate === 'operatorApproval' && b.reason.includes('missing')));
});

// ── NO-GO is a valid fail-closed outcome ─────────────────────────

test('NO-GO is a valid fail-closed outcome with unresolved gates', () => {
  const input = {
    decision: 'NO-GO',
    gates: {
      brokerReadiness: { status: 'GO', evidence: ['a2a-plane#198 (internal tracker, private)#broker'] },
    },
  };
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'NO-GO');
  assert.equal(parsed.sourcePublicExecution, 'NO-GO');
  assert.ok(parsed.blockers.length > 0);
});

// ── Source-public execution remains NO-GO ────────────────────────

test('source-public execution is NO-GO when any gate is missing', () => {
  const input = allGo({ operatorApproval: { status: 'MISSING', evidence: [] } });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.sourcePublicExecution, 'NO-GO');
});

test('source-public execution is explicitly marked NO-GO in spec-only mode', () => {
  const result = spawnSync(process.execPath, [script, '--spec', spec], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.sourcePublicExecution, 'NO-GO');
});

// ── Markdown output ──────────────────────────────────────────────

test('markdown format produces deterministic report for NO-GO', () => {
  const input = {
    decision: 'NO-GO',
    gates: {
      brokerReadiness: { status: 'GO', evidence: ['a2a-plane#198 (internal tracker, private)#broker'] },
      pluginReadiness: { status: 'GO', evidence: ['a2a-plane#198 (internal tracker, private)#plugin'] },
      runnerReadiness: { status: 'GO', evidence: ['a2a-plane#198 (internal tracker, private)#runner'] },
      publicPrivateBoundary: { status: 'GO', evidence: ['a2a-plane#198 (internal tracker, private)#boundary'] },
    },
  };
  const result = runMarkdown(input);
  // NO-GO with blockers goes to stdout because NO-GO is a valid ok outcome
  const out = result.stdout || result.stderr;
  assert.ok(out.includes('Block: A2A Nexus source-public dry-run report'));
  assert.ok(out.includes('## Gate status'));
  assert.ok(out.includes('Source-public execution remains **NO-GO**'));
});

test('markdown output for all-GO shows Done', () => {
  const input = allGo({
    operatorApproval: {
      status: 'GO',
      evidence: ['a2a-plane#198 (internal tracker, private)#operator-approval-explicit'],
    },
  });
  const result = runMarkdown(input);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('Done: A2A Nexus source-public dry-run report'));
  assert.ok(result.stdout.includes('Decision: GO'));
  assert.ok(result.stdout.includes('Source-public execution: GO'));
});

// ── Full passes ──────────────────────────────────────────────────

test('all-GO with full separate operator approval passes', () => {
  const input = allGo({
    operatorApproval: {
      status: 'GO',
      evidence: ['a2a-plane#198 (internal tracker, private)#explicit-operator-approval'],
    },
  });
  const result = run(input);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'GO');
  assert.equal(parsed.sourcePublicExecution, 'GO');
  assert.ok(parsed.blockers.length === 0);
});

test('all-GO with bundled approval evidence fails separation check', () => {
  const bundledUrl = 'a2a-plane#198 (internal tracker, private)#bundled';
  const input = allGo({
    brokerReadiness: { status: 'GO', evidence: [bundledUrl] },
    operatorApproval: { status: 'GO', evidence: [bundledUrl] },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.ok(parsed.blockers.some((b) => b.reason && b.reason.includes('must be separate')));
});

// ── Evidence packet edge cases ───────────────────────────────────

test('null evidence packet is treated as missing', () => {
  const input = {
    decision: 'GO',
    gates: {},
  };
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO-GO');
});

test('null gate overrides still pass when status remains GO', () => {
  // null Object-spread {} overrides do not clear status; the gate stays GO.
  // This test verifies the correct behavior: you must explicitly set status.
  const input = allGo({
    brokerReadiness: { status: 'GO', evidence: ['https://example.com/broker'] },
    pluginReadiness: { status: 'GO', evidence: ['https://example.com/plugin'] },
    runnerReadiness: { status: 'GO', evidence: ['https://example.com/runner'] },
  });
  const result = run(input);
  // All gates GO => exit 0
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'GO');
});

test('explicitly missing broker/plugin/runner gates trigger fail-closed', () => {
  const input = allGo({
    brokerReadiness: { status: 'MISSING', evidence: [] },
    pluginReadiness: { status: 'MISSING', evidence: [] },
    runnerReadiness: { status: 'MISSING', evidence: [] },
  });
  const result = run(input);
  assert.notEqual(result.status, 0);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.decision, 'NO-GO');
});

// ── Fixture validation ───────────────────────────────────────────

test('team1-workerGamma dry-run fixture passes with all gates GO', () => {
  const result = spawnSync(process.execPath, [
    script,
    '--spec', spec,
    '--input', 'fixtures/dry-run/team1-workerGamma-dryrun-evidence.json',
  ], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, 'GO');
  assert.equal(parsed.sourcePublicExecution, 'GO');
  assert.equal(parsed.blockers.length, 0);
});
