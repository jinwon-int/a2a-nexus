import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const spec = 'docs/readiness/fail-closed-gates.json';
const script = 'scanner/readiness/fail-closed-gates.mjs';
const gateIds = [
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
  const dir = mkdtempSync(join(tmpdir(), 'a2a-readiness-gates-'));
  const file = join(dir, 'input.json');
  writeFileSync(file, JSON.stringify(input, null, 2));
  return file;
}

function run(input) {
  return spawnSync(process.execPath, [script, '--spec', spec, '--input', inputPath(input)], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
}

function allGo(overrides = {}) {
  return {
    decision: 'GO',
    gates: Object.fromEntries(
      gateIds.map((id, index) => [
        id,
        {
          status: 'GO',
          evidence: [`a2a-plane#167 (internal tracker, private)#gate-${index + 1}`],
          ...overrides[id],
        },
      ]),
    ),
  };
}

test('GO fails closed when external scanner evidence is missing', () => {
  const input = allGo({ externalScannerEvidence: { status: 'MISSING', evidence: [] } });
  const result = run(input);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /externalScannerEvidence: status is MISSING/);
  assert.match(result.stderr, /externalScannerEvidence: redacted evidence link is missing/);
});

test('GO fails closed when evidence contains an unredacted private path', () => {
  const unsafePath = '/' + 'home/operator/private-scan-output.txt';
  const input = allGo({ externalScannerEvidence: { evidence: [unsafePath] } });
  const result = run(input);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /externalScannerEvidence: evidence is not redacted \(absolute-private-path\)/);
});

test('GO requires operator approval evidence to remain separate from scanner evidence', () => {
  const sharedEvidence = 'a2a-plane#167 (internal tracker, private)#shared-evidence';
  const input = allGo({
    externalScannerEvidence: { evidence: [sharedEvidence] },
    operatorApproval: { evidence: [sharedEvidence] },
  });
  const result = run(input);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /operatorApproval: approval evidence must be separate from externalScannerEvidence/);
});

test('NO-GO remains a valid fail-closed outcome with unresolved gates', () => {
  const input = {
    decision: 'NO-GO',
    gates: {
      publicPrivateBoundary: { status: 'GO', evidence: ['a2a-plane#167 (internal tracker, private)#boundary'] },
    },
  };
  const result = run(input);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"decision": "NO-GO"/);
  assert.match(result.stdout, /externalScannerEvidence: status is MISSING/);
});

test('malformed decision values fail closed instead of skipping evidence checks', () => {
  for (const decision of ['GO ', 'Go-live', 'YES']) {
    const input = { ...allGo(), decision };
    // Strip all evidence so a fail-open run would have plenty to miss.
    for (const gate of Object.values(input.gates)) gate.evidence = [];
    const result = run(input);

    if (decision.trim().toUpperCase() === 'GO') {
      // 'GO ' normalizes to GO and must enforce the full evidence checks.
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /redacted evidence link is missing/);
    } else {
      assert.notEqual(result.status, 0, `decision ${JSON.stringify(decision)} must not pass`);
      assert.match(result.stderr, /decision: unrecognized value/);
    }
  }
});
