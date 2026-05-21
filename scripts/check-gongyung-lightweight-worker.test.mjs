import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const specDir = 'docs/specs/a2a-gongyung-lightweight-worker';
const fixturePath = 'fixtures/contract/gongyung-worker-registration.json';
const cardPath = 'examples/workers/gongyung-lightweight-worker/worker-card.json';

const requiredSpecFiles = ['spec.md', 'plan.md', 'tasks.md', 'analyze.md'];

const forbiddenRuntimePaths = [
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
];

test('Gongyung lightweight worker spec packet is complete', () => {
  for (const file of requiredSpecFiles) {
    const content = readFileSync(`${specDir}/${file}`, 'utf8');
    assert.ok(content.length > 100, `${file} must have substantive content`);
    // Spec must reference #393 or Gongyung
    assert.match(content, /393|gongyung|lightweight/i, `${file} must reference the issue or Gongyung`);
  }
});

test('Gongyung lightweight worker spec defines allowed and rejected task classes', () => {
  const spec = readFileSync(`${specDir}/spec.md`, 'utf8');
  assert.match(spec, /dockerRequired/i, 'spec must reference dockerRequired flag');
  assert.match(spec, /buildRequired/i, 'spec must reference buildRequired flag');
  assert.match(spec, /testRequired/i, 'spec must reference testRequired flag');
  assert.match(spec, /repoPatch/i, 'spec must reference repoPatch flag');
  assert.match(spec, /untrustedCode/i, 'spec must reference untrustedCode flag');
  assert.match(spec, /blocked/i, 'spec must reference blocked outcome for rejections');
});

test('Gongyung lightweight worker spec defines artifact and evidence boundaries', () => {
  const spec = readFileSync(`${specDir}/spec.md`, 'utf8');
  assert.match(spec, /~\/\.hermes\/a2a\/artifacts/i, 'spec must define artifact output path');
  assert.match(spec, /manifest/i, 'spec must reference evidence manifest');
  assert.match(spec, /redact/i, 'spec must reference redaction');
  assert.match(spec, /AGENTS\.md|SOUL\.md|USER\.md/i, 'spec must forbid runtime bootstrap file inclusion');
});

test('Gongyung lightweight worker spec references #384 as prior art', () => {
  const spec = readFileSync(`${specDir}/spec.md`, 'utf8');
  assert.match(spec, /384|hermes.*worker.*integration/i, 'spec must reference prior Hermes worker integration');
});

test('Gongyung worker registration fixture is valid', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.equal(fixture.nodeId, 'gongyung');
  assert.equal(fixture.role, 'analyst');
  assert.equal(fixture.workerMode, 'mobile');
  assert.equal(fixture.metadata.runtime, 'hermes-agent');
  assert.equal(fixture.metadata.openClawRequired, 'false');
  assert.equal(fixture.metadata.workerProfile, 'lightweight');
  assert.equal(fixture.metadata.dockerAvailable, 'false');
  assert.equal(fixture.metadata.deviceClass, 'android-termux');
  assert.ok(Array.isArray(fixture.rejectedTaskFlags));
  assert.ok(fixture.rejectedTaskFlags.includes('dockerRequired'));
  assert.deepStrictEqual(
    fixture.capabilities,
    { canAnalyze: true, canBackfill: false, canPatchWorkspace: false, canPromoteLive: false,
      workspaceIds: ['hermes-gongyung'], environments: ['research'] }
  );
});

test('Gongyung worker registration fixture has evidence manifest template and safety confirmations', () => {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.ok(fixture.evidenceManifestFixture, 'fixture must have evidence manifest template');
  assert.equal(fixture.evidenceManifestFixture.workerId, 'gongyung');
  assert.equal(fixture.evidenceManifestFixture.status, 'accepted');
  assert.ok(fixture.evidenceManifestFixture.redactionStatement.length > 20);
  assert.equal(fixture.safetyConfirmations.noDeployOrRestart, true);
  assert.equal(fixture.safetyConfirmations.noDbMutation, true);
  assert.equal(fixture.safetyConfirmations.noTerminalAckMutation, true);
  assert.equal(fixture.safetyConfirmations.evidenceIsRedactedForPublic, true);
  assert.equal(fixture.safetyConfirmations.rejectedTasksProduceBlockedEvidence, true);
});

test('Gongyung worker card is valid and self-consistent', () => {
  const card = JSON.parse(readFileSync(cardPath, 'utf8'));
  assert.match(card.workerName, /^[a-z0-9][a-z0-9-]{2,63}$/, 'workerName must match naming pattern');
  assert.equal(card.kind, 'hermes-poll-worker');
  assert.equal(card.runtime, 'hermes-agent');
  assert.equal(card.workerMode, 'mobile');
  assert.equal(card.dockerAvailable, false);
  assert.equal(card.openClawRequired, false);
  assert.equal(card.workerProfile, 'lightweight');
  assert.equal(card.deviceClass, 'android-termux');
  assert.ok(Array.isArray(card.capabilities));
  assert.ok(card.capabilities.includes('docs'));
  assert.ok(card.capabilities.includes('canary-ops'));
  // Admission rules must reject docker/build/test/patch/untrusted-code tasks
  assert.ok(card.admissionRules.rejectedFlags.includes('dockerRequired'));
  assert.ok(card.admissionRules.rejectedFlags.includes('buildRequired'));
  assert.ok(card.admissionRules.rejectedFlags.includes('testRequired'));
  assert.ok(card.admissionRules.rejectedFlags.includes('repoPatch'));
  assert.ok(card.admissionRules.rejectedFlags.includes('untrustedCode'));
  assert.equal(card.admissionRules.rejectionOutcome, 'blocked');
  // Evidence rules must forbid runtime bootstrap files
  assert.ok(card.evidenceRules.forbidden.includes('runtimeBootstrapFileNames'));
  assert.ok(card.evidenceRules.forbidden.includes('agentWorkspaceDump'));
});

test('Gongyung fixture and card have no leaked secrets or private paths', () => {
  const fixtureText = readFileSync(fixturePath, 'utf8');
  const cardText = readFileSync(cardPath, 'utf8');
  const combined = fixtureText + '\n' + cardText;
  const secretPatterns = [
    /ghp_[A-Za-z0-9_]{20,}/,
    /github_pat_[A-Za-z0-9_]+/,
    /xox[baprs]-[A-Za-z0-9-]+/,
    /-----BEGIN .*PRIVATE KEY-----/,
  ];
  for (const pattern of secretPatterns) {
    assert.ok(!pattern.test(combined), `fixture/card must not contain secret pattern ${pattern}`);
  }
  // The fixture and card legitimately name forbidden field labels (privateHostPath,
  // providerToken, rawSessionDump, etc.) inside forbiddenProfileFields and
  // evidenceRules.forbidden arrays. That is intentional documentation of what
  // the lightweight profile forbids. Check only that no actual host-specific
  // paths or credentials appear as value content.
  const parsedFixture = JSON.parse(fixtureText);
  const parsedCard = JSON.parse(cardText);
  const valueStrings = JSON.stringify(parsedFixture) + JSON.stringify(parsedCard);
  const hostPathPatterns = [
    /\/home\/[\w.]+\//,
    /\/Users\/[\w.]+\//,
  ];
  for (const pattern of hostPathPatterns) {
    assert.ok(!pattern.test(valueStrings), `fixture/card must not contain private host path pattern ${pattern}`);
  }
});

test('Spec plan correctly sizes and scopes the implementation lane', () => {
  const plan = readFileSync(`${specDir}/plan.md`, 'utf8');
  assert.match(plan, /Medium|Small/, 'plan must have a size classification');
  assert.match(plan, /a2a-plane/, 'plan must reference a2a-plane');
  assert.match(plan, /Seoseo|source/, 'plan must reference execution lane');
});

test('Spec tasks checklist covers required deliverables', () => {
  const tasks = readFileSync(`${specDir}/tasks.md`, 'utf8');
  assert.match(tasks, /spec\.md/, 'tasks must reference spec.md');
  assert.match(tasks, /plan\.md/, 'tasks must reference plan.md');
  assert.match(tasks, /tasks\.md/, 'tasks must reference tasks.md');
  assert.match(tasks, /analyze\.md/, 'tasks must reference analyze.md');
  assert.match(tasks, /fixture|registration/, 'tasks must reference fixture');
  assert.match(tasks, /validation|test/, 'tasks must reference validation');
});

test('Spec analysis confirms no broker changes needed', () => {
  const analyze = readFileSync(`${specDir}/analyze.md`, 'utf8');
  assert.match(analyze, /384|Hermes|hermes/i, 'analysis must reference #384 or Hermes');
  assert.match(analyze, /register|heartbeat|evidence/i, 'analysis must reference worker lifecycle');
  assert.match(analyze, /local tests only|no production|localhost|127\.0\.0\.1/i, 'analysis must confirm local-only');
});
