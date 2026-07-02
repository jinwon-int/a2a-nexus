import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateFleet, validateExpectedInventory, validateObservedList, renderTable } from './a2a-fleet-routing-guard.mjs';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SHA_TEAM1 = 'a'.repeat(64);
const SHA_TEAM2 = 'b'.repeat(64);
const REVISION = 'c0ffee1234567890abcdefc0ffee1234567890ab';

function makeExpected(overrides = {}) {
  return {
    teams: {
      team1: { broker: 'brokerAlpha', brokerUrl: 'https://brokerAlpha.broker.internal', edgeSecretSha256: SHA_TEAM1 },
      team2: { broker: 'brokerBeta', brokerUrl: 'https://brokerBeta.broker.internal', edgeSecretSha256: SHA_TEAM2 },
    },
    nodes: {
      workerDelta: { team: 'team1' },
      workerGamma: { team: 'team1' },
      workerEta: { team: 'team2' },
    },
    expectedService: 'a2a-hermes-worker',
    expectedRoot: '/opt/a2a-broker-worker',
    expectedRevision: REVISION,
    ...overrides,
  };
}

function obs(node, team, overrides = {}) {
  const brokerUrl = team === 'team1' ? 'https://brokerAlpha.broker.internal' : 'https://brokerBeta.broker.internal';
  const sha = team === 'team1' ? SHA_TEAM1 : SHA_TEAM2;
  return {
    node,
    brokerUrl,
    edgeSecretSha256: sha,
    service: 'a2a-hermes-worker',
    root: '/opt/a2a-broker-worker',
    revision: REVISION,
    active: true,
    ...overrides,
  };
}

function makeObserved(overrides = {}) {
  const base = {
    workerDelta: obs('workerDelta', 'team1'),
    workerGamma: obs('workerGamma', 'team1'),
    workerEta: obs('workerEta', 'team2'),
  };
  Object.assign(base, overrides);
  return Object.values(base);
}

// ─── All-green fleet ─────────────────────────────────────────────────────────

test('all-green fleet passes', () => {
  const result = evaluateFleet(makeExpected(), makeObserved());
  assert.equal(result.ok, true);
  assert.equal(result.malformed, false);
  assert.equal(result.violations.length, 0);
  assert.equal(result.rows.length, 3);
  assert.ok(result.rows.every((r) => r.ok));
});

test('trailing slash difference on broker URL still passes', () => {
  const result = evaluateFleet(
    makeExpected(),
    makeObserved({ workerDelta: obs('workerDelta', 'team1', { brokerUrl: 'https://brokerAlpha.broker.internal/' }) }),
  );
  assert.equal(result.ok, true);
});

// ─── Cross-team mispointing ──────────────────────────────────────────────────

test('Team2 node pointed at Team1 broker fails', () => {
  const result = evaluateFleet(
    makeExpected(),
    makeObserved({ workerEta: obs('workerEta', 'team2', { brokerUrl: 'https://brokerAlpha.broker.internal' }) }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.node === 'workerEta' && v.field === 'brokerUrl'));
});

// ─── Auth fingerprint ────────────────────────────────────────────────────────

test('wrong secret fingerprint fails', () => {
  const result = evaluateFleet(
    makeExpected(),
    makeObserved({ workerDelta: obs('workerDelta', 'team1', { edgeSecretSha256: 'd'.repeat(64) }) }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.node === 'workerDelta' && v.field === 'auth'));
});

test('missing/non-sha secret fingerprint fails on auth', () => {
  const result = evaluateFleet(
    makeExpected(),
    makeObserved({ workerDelta: obs('workerDelta', 'team1', { edgeSecretSha256: '' }) }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.node === 'workerDelta' && v.field === 'auth'));
});

// ─── Service name ────────────────────────────────────────────────────────────

test('wrong service name fails (old openclaw-a2a-worker)', () => {
  const result = evaluateFleet(
    makeExpected(),
    makeObserved({ workerGamma: obs('workerGamma', 'team1', { service: 'openclaw-a2a-worker' }) }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.node === 'workerGamma' && v.field === 'service'));
});

// ─── Root drift ──────────────────────────────────────────────────────────────

test('root drift fails when not exempt', () => {
  const result = evaluateFleet(
    makeExpected(),
    makeObserved({ workerDelta: obs('workerDelta', 'team1', { root: '/opt/openclaw-a2a-worker' }) }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.node === 'workerDelta' && v.field === 'root'));
});

test('root drift passes when node is exemptRoot', () => {
  const expected = makeExpected();
  expected.nodes.workerDelta.exemptRoot = true;
  const result = evaluateFleet(
    expected,
    makeObserved({ workerDelta: obs('workerDelta', 'team1', { root: '/opt/openclaw-a2a-worker' }) }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.rows.find((r) => r.node === 'workerDelta').root, 'exempt');
});

// ─── Revision ────────────────────────────────────────────────────────────────

test('stale revision fails', () => {
  const result = evaluateFleet(
    makeExpected(),
    makeObserved({ workerEta: obs('workerEta', 'team2', { revision: 'deadbeef' }) }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.node === 'workerEta' && v.field === 'revision'));
});

// ─── Docker runner image/env drift ───────────────────────────────────────────

test('stale Docker runner image fails even when worker revision matches', () => {
  const result = evaluateFleet(
    makeExpected({ expectedRunnerImage: 'a2a-docker-runner-hermes:c0ffee1' }),
    makeObserved({ workerEta: obs('workerEta', 'team2', { runnerImage: 'a2a-docker-runner-hermes:deadbee' }) }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.node === 'workerEta' && v.field === 'runnerImage'));
});

test('missing Docker runner image fails when expected runner image is configured', () => {
  const result = evaluateFleet(
    makeExpected({ expectedRunnerImage: 'a2a-docker-runner-hermes:c0ffee1' }),
    makeObserved({ workerGamma: obs('workerGamma', 'team1', { runnerImage: '' }) }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.node === 'workerGamma' && v.field === 'runnerImage'));
});

// ─── Active ──────────────────────────────────────────────────────────────────

test('inactive worker fails', () => {
  const result = evaluateFleet(
    makeExpected(),
    makeObserved({ workerGamma: obs('workerGamma', 'team1', { active: false }) }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.node === 'workerGamma' && v.field === 'active'));
});

test('missing observation for an expected node fails', () => {
  const observed = makeObserved();
  const result = evaluateFleet(makeExpected(), observed.filter((o) => o.node !== 'workerDelta'));
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.node === 'workerDelta' && v.field === 'observation'));
});

// ─── Malformed inputs ────────────────────────────────────────────────────────

test('malformed expected inventory fails loudly', () => {
  const result = evaluateFleet({}, makeObserved());
  assert.equal(result.malformed, true);
  assert.equal(result.ok, false);
  assert.ok(result.inputErrors.length > 0);
});

test('observed not an array fails loudly', () => {
  const result = evaluateFleet(makeExpected(), { not: 'an array' });
  assert.equal(result.malformed, true);
  assert.ok(result.inputErrors.some((e) => e.includes('array')));
});

test('node referencing undefined team fails loudly', () => {
  const expected = makeExpected();
  expected.nodes.ghost = { team: 'team9' };
  const result = evaluateFleet(expected, makeObserved());
  assert.equal(result.malformed, true);
  assert.ok(result.inputErrors.some((e) => e.includes('team9')));
});

test('non-sha team edge secret in inventory fails loudly', () => {
  const expected = makeExpected();
  expected.teams.team1.edgeSecretSha256 = 'not-a-hash';
  const result = evaluateFleet(expected, makeObserved());
  assert.equal(result.malformed, true);
});

test('validateExpectedInventory accepts a well-formed inventory', () => {
  assert.deepEqual(validateExpectedInventory(makeExpected()), []);
});

test('validateObservedList accepts well-formed observations', () => {
  assert.deepEqual(validateObservedList(makeObserved()), []);
});

// ─── Multiple violations enumerated ──────────────────────────────────────────

test('multiple violations are all enumerated', () => {
  const result = evaluateFleet(
    makeExpected(),
    makeObserved({
      workerDelta: obs('workerDelta', 'team1', { service: 'openclaw-a2a-worker', active: false }),
      workerEta: obs('workerEta', 'team2', { brokerUrl: 'https://brokerAlpha.broker.internal' }),
    }),
  );
  assert.equal(result.ok, false);
  assert.ok(result.violations.length >= 3);
  assert.ok(result.violations.some((v) => v.node === 'workerDelta' && v.field === 'service'));
  assert.ok(result.violations.some((v) => v.node === 'workerDelta' && v.field === 'active'));
  assert.ok(result.violations.some((v) => v.node === 'workerEta' && v.field === 'brokerUrl'));
});

// ─── --force semantics (simulated at evaluation layer) ───────────────────────

test('--force passes but the run is marked forced (CLI subprocess)', async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');

  const dir = mkdtempSync(join(tmpdir(), 'fleet-guard-'));
  const expectedPath = join(dir, 'expected.json');
  const observedPath = join(dir, 'observed.json');
  writeFileSync(expectedPath, JSON.stringify(makeExpected()));
  writeFileSync(observedPath, JSON.stringify(makeObserved({ workerDelta: obs('workerDelta', 'team1', { active: false }) })));

  const script = fileURLToPath(new URL('./a2a-fleet-routing-guard.mjs', import.meta.url));

  // Without --force: exit 1.
  let failed = false;
  try {
    execFileSync('node', [script, '--expected', expectedPath, '--observed', observedPath], { encoding: 'utf8' });
  } catch (e) {
    failed = true;
    assert.match(e.stderr, /VERDICT: FAIL/);
  }
  assert.equal(failed, true, 'expected non-force run to exit 1');

  // With --force: exit 0 but marked forced.
  const out = execFileSync('node', [script, '--expected', expectedPath, '--observed', observedPath, '--force'], { encoding: 'utf8' });
  assert.match(out, /FORCED-PAST-VIOLATIONS/);

  rmSync(dir, { recursive: true, force: true });
});

test('CLI exits 0 and renders PASS for all-green fleet', async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');

  const dir = mkdtempSync(join(tmpdir(), 'fleet-guard-'));
  const expectedPath = join(dir, 'expected.json');
  const observedPath = join(dir, 'observed.json');
  writeFileSync(expectedPath, JSON.stringify(makeExpected()));
  writeFileSync(observedPath, JSON.stringify(makeObserved()));

  const script = fileURLToPath(new URL('./a2a-fleet-routing-guard.mjs', import.meta.url));
  const out = execFileSync('node', [script, '--expected', expectedPath, '--observed', observedPath], { encoding: 'utf8' });
  assert.match(out, /VERDICT: PASS/);

  const jsonOut = execFileSync('node', [script, '--expected', expectedPath, '--observed', observedPath, '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(jsonOut);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.verdict, 'PASS');

  rmSync(dir, { recursive: true, force: true });
});

test('collect subcommand prints the one-liner and never executes it', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('./a2a-fleet-routing-guard.mjs', import.meta.url));
  const out = execFileSync('node', [script, 'collect'], { encoding: 'utf8' });
  assert.match(out, /systemctl is-active/);
  assert.match(out, /createHash\('sha256'\)/);
  assert.match(out, /BROKER_URL/);
});

// ─── Rendering ───────────────────────────────────────────────────────────────

test('renderTable produces aligned columns with a header', () => {
  const result = evaluateFleet(makeExpected(), makeObserved());
  const table = renderTable(result.rows);
  const lines = table.split('\n');
  assert.match(lines[0], /NODE\s+TEAM\s+BROKER/);
  assert.ok(lines.length >= 5);
});
