/**
 * Hermes native A2A worker conformance validation.
 *
 * Validates the no-live conformance fixture and checklist:
 * - No-live conformance fixture JSON schema, safety flags, conformance steps.
 * - Android/Termux caveats documentation.
 * - Prior art references (jinwon-int/a2a-plane#435, #441).
 *
 * Safety: read-only doc and fixture validation. No live broker, provider send,
 * deploy, restart, terminal ACK, database mutation, or secret exposure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const fixturePath = 'fixtures/native-worker/no-live-conformance.json';
const checklistPath = 'docs/hermes-native-worker-conformance-checklist.md';
const androidRunbookPath = 'docs/hermes-android-native-worker-runbook.md';
const gongyungSpecPath = 'docs/specs/gongyung-hermes-worker-profile/spec.md';
const hermesIntegrationSpec = 'docs/specs/hermes-worker-integration/spec.md';

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── File existence checks ─────────────────────────────────────────

test('hermes native worker no-live conformance fixture exists', () => {
  assert.ok(existsSync(join(repoRoot, fixturePath)), `missing: ${fixturePath}`);
});

test('hermes native worker conformance checklist exists', () => {
  assert.ok(existsSync(join(repoRoot, checklistPath)), `missing: ${checklistPath}`);
});

test('hermes android native worker runbook exists', () => {
  assert.ok(existsSync(join(repoRoot, androidRunbookPath)), `missing: ${androidRunbookPath}`);
});

test('gongyung hermes worker profile spec exists', () => {
  assert.ok(existsSync(join(repoRoot, gongyungSpecPath)), `missing: ${gongyungSpecPath}`);
});

test('hermes worker integration spec exists', () => {
  assert.ok(existsSync(join(repoRoot, hermesIntegrationSpec)), `missing: ${hermesIntegrationSpec}`);
});

// ── Fixture schema validation ──────────────────────────────────────

test('fixture has required top-level fields', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, fixturePath), 'utf8'));

  assert.equal(fixture.schema, 'a2a.hermesNativeWorker.noLiveConformance.v1');
  assert.equal(fixture.mode, 'no-live');
  assert.ok(typeof fixture.fixtureId === 'string' && fixture.fixtureId.length > 0);
  assert.ok(typeof fixture.description === 'string' && fixture.description.length > 0);
  assert.equal(fixture.issue, 'https://github.com/jinwon-int/a2a-plane/issues/465');
  assert.equal(fixture.parentIssue, 'https://github.com/jinwon-int/a2a-plane/issues/464');
});

test('fixture references prior art issues 435 and 441', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, fixturePath), 'utf8'));
  const priorArt = fixture.priorArt || [];
  const priorArtStr = priorArt.join(' ');
  assert.ok(priorArtStr.includes('435') || priorArtStr.includes('#435'), 'fixture must reference a2a-plane#435');
  assert.ok(priorArtStr.includes('441') || priorArtStr.includes('#441'), 'fixture must reference a2a-plane#441');
});

test('fixture worker identity reflects Hermes/Android native worker', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, fixturePath), 'utf8'));
  const worker = fixture.worker;

  assert.equal(worker.id, 'gongyung');
  assert.equal(worker.runtime, 'hermes-agent');
  assert.equal(worker.runtimeFlavor, 'termux-hermes');
  assert.equal(worker.openClawRequired, false);
  assert.equal(worker.dockerAvailable, false);
  assert.equal(worker.workerMode, 'mobile');
  assert.equal(worker.transport, 'http-poll');
  assert.equal(worker.brokerUrlMode, 'loopback-only');
  assert.equal(worker.evidenceSchema, 'a2a.hermesWorker.localEvidence.v1');
});

test('fixture worker capabilities match Gongyung profile', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, fixturePath), 'utf8'));
  const caps = fixture.worker.capabilities;

  // Allowed capabilities
  assert.equal(caps.canAnalyze, true);
  assert.equal(caps.canResearch, true);
  assert.equal(caps.canReport, true);
  assert.equal(caps.canReview, true);
  assert.equal(caps.canObserve, true);
  assert.equal(caps.canCheckReadiness, true);
  assert.equal(caps.canCrossCheck, true);
  assert.equal(caps.canHermesOps, true);
  assert.equal(caps.canCanary, true);

  // Rejected capabilities
  assert.equal(caps.canBackfill, false);
  assert.equal(caps.canPatchWorkspace, false);
  assert.equal(caps.canPromoteLive, false);
  assert.equal(caps.canPushToGitHub, false);
  assert.equal(caps.canRunHeavyProof, false);
});

test('fixture rejected intents match Gongyung profile', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, fixturePath), 'utf8'));
  const rejected = fixture.worker.rejectedIntents;

  assert.ok(rejected.includes('docker'), 'rejectedIntents must include docker');
  assert.ok(rejected.includes('patch_repo'), 'rejectedIntents must include patch_repo');
  assert.ok(rejected.includes('build_repo'), 'rejectedIntents must include build_repo');
  assert.ok(rejected.includes('test_repo'), 'rejectedIntents must include test_repo');
});

test('fixture rejected capabilities match Gongyung profile', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, fixturePath), 'utf8'));
  const rejected = fixture.worker.rejectedCapabilities;

  const required = [
    'dockerRequired', 'buildRequired', 'testRequired', 'repoPatch',
    'untrustedCode', 'dependencyHeavy', 'serviceRestart',
    'brokerDBMutation', 'credentialMovement', 'productionACK',
  ];
  for (const cap of required) {
    assert.ok(rejected.includes(cap), `rejectedCapabilities must include ${cap}`);
  }
});

test('fixture conformanceSteps has all 10 steps in order', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, fixturePath), 'utf8'));
  const steps = fixture.conformanceSteps;

  assert.equal(steps.length, 10);
  assert.equal(steps[0].action, 'register');
  assert.equal(steps[1].action, 'heartbeat');
  assert.equal(steps[2].action, 'poll_pending');
  assert.equal(steps[3].action, 'claim_and_start');
  assert.equal(steps[4].action, 'execute_bounded_task');
  assert.equal(steps[5].action, 'write_local_evidence');
  assert.equal(steps[6].action, 'submit_terminal_evidence');
  assert.equal(steps[7].action, 'reconnect_after_interrupt');
  assert.equal(steps[8].action, 'reject_unsafe_task');
  assert.equal(steps[9].action, 'verify_evidence_redacted');
});

test('all conformance steps declare noLive: true', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, fixturePath), 'utf8'));
  for (const step of fixture.conformanceSteps) {
    assert.equal(step.noLive, true, `step ${step.step} (${step.action}) must declare noLive: true`);
  }
});

test('fixture safety flags are all false', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, fixturePath), 'utf8'));
  const safety = fixture.safety;

  for (const [key, val] of Object.entries(safety)) {
    assert.equal(val, false, `safety.${key} must be false in no-live fixture`);
  }
});

test('fixture contains Android/Termux caveats section', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, fixturePath), 'utf8'));
  const caveats = fixture.androidTermuxCaveats;

  assert.ok(caveats.sleepDoze, 'must document sleep/Doze behavior');
  assert.ok(caveats.wakeLock, 'must document wake lock requirement');
  assert.ok(caveats.networkReconnect, 'must document network reconnect');
  assert.ok(caveats.storagePaths, 'must document storage paths');
  assert.ok(caveats.secretHandling, 'must document secret handling');
  assert.ok(caveats.resourceLimits, 'must document resource limits');
  assert.ok(caveats.bootPersistence, 'must document boot persistence');
  assert.ok(caveats.noGateway, 'must document no-Gateway approach');
});

test('fixture has no secret values', () => {
  const content = readFileSync(join(repoRoot, fixturePath), 'utf8');

  // No bot tokens, API keys, or credential patterns
  assert.doesNotMatch(content, /\b[A-Za-z0-9_]{30,}:[A-Za-z0-9_-]{30,}\b/);
  assert.doesNotMatch(content, /sk-[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(content, /api\.telegram\.org/);
  assert.doesNotMatch(content, /providerToken|provider_token/);
  assert.doesNotMatch(content, /edge_secret|EDGE_SECRET/);
});

// ── Checklist validation ───────────────────────────────────────────

test('checklist references prior art issues 435 and 441', () => {
  const content = readFileSync(join(repoRoot, checklistPath), 'utf8');
  assert.match(content, /#435/);
  assert.match(content, /#441/);
});

test('checklist references all required source documents', () => {
  const content = readFileSync(join(repoRoot, checklistPath), 'utf8');

  assert.match(content, /hermes-worker-integration\/spec\.md/);
  assert.match(content, /gongyung-hermes-worker-profile\/spec\.md/);
  assert.match(content, /hermes-android-native-worker-runbook\.md/);
  assert.match(content, /native-worker\/no-live-conformance\.json/);
});

test('checklist covers registration, heartbeat, polling, task execution, evidence', () => {
  const content = readFileSync(join(repoRoot, checklistPath), 'utf8');

  assert.match(content, /## 1\. Registration/);
  assert.match(content, /## 2\. Heartbeat/);
  assert.match(content, /## 3\. Task Polling/);
  assert.match(content, /## 4\. Bounded Task Execution/);
  assert.match(content, /## 5\. Local Redacted Evidence Manifest/);
  assert.match(content, /## 6\. Broker-Visible Result Evidence/);
});

test('checklist documents Android/Termux caveats', () => {
  const content = readFileSync(join(repoRoot, checklistPath), 'utf8');

  assert.match(content, /Android/i);
  assert.match(content, /Termux/i);
  assert.match(content, /Doze/i);
  assert.match(content, /wake/i);
  assert.match(content, /lock/i);
});

test('checklist documents redaction rules', () => {
  const content = readFileSync(join(repoRoot, checklistPath), 'utf8');

  assert.match(content, /Must redact/);
  assert.match(content, /Must keep/);
  assert.match(content, /IMEI/);
  assert.match(content, /provider token/);
  assert.match(content, /nodeId/);
  assert.match(content, /redacted/);
});

test('checklist documents approval-sensitive boundaries', () => {
  const content = readFileSync(join(repoRoot, checklistPath), 'utf8');

  assert.match(content, /Approval-Sensitive/);
  assert.match(content, /Requires separate operator approval/);
  assert.match(content, /Live provider/);
  assert.match(content, /DB mutation/);
  assert.match(content, /PR merge/);
});

test('checklist documents no-live / canary separation', () => {
  const content = readFileSync(join(repoRoot, checklistPath), 'utf8');
  assert.match(content, /No-Live.*Canary/);
  assert.match(content, /separately approved canary packet/);
});

test('checklist documents conformance evidence capture', () => {
  const content = readFileSync(join(repoRoot, checklistPath), 'utf8');
  assert.match(content, /Conformance Evidence Capture/);
  assert.match(content, /node --test/);
});

test('checklist has no secret values', () => {
  const content = readFileSync(join(repoRoot, checklistPath), 'utf8');
  assert.doesNotMatch(content, /\b[A-Za-z0-9_]{30,}:[A-Za-z0-9_-]{30,}\b/);
  assert.doesNotMatch(content, /sk-[A-Za-z0-9]{20,}/);
});

// ── Cross-reference consistency ─────────────────────────────────────

test('fixture profiles field references gongyung spec', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, fixturePath), 'utf8'));
  const profiles = fixture.profiles || [];
  assert.ok(profiles.some(p => p.includes('gongyung-hermes-worker-profile')), 'fixture must reference gongyung profile spec');
});

test('fixture runbook field references android native worker runbook', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, fixturePath), 'utf8'));
  assert.ok(fixture.runbook.includes('hermes-android-native-worker-runbook'), 'fixture must reference android runbook');
});

test('rejection reasons include gongyung_not_docker_runner', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, fixturePath), 'utf8'));
  const rejectStep = fixture.conformanceSteps.find(s => s.action === 'reject_unsafe_task');

  assert.ok(rejectStep, 'conformanceSteps must include reject_unsafe_task step');
  assert.ok(rejectStep.rejectionReasons.includes('gongyung_not_docker_runner'),
    'rejection reasons must include gongyung_not_docker_runner');
});

// ── Runbook validation ─────────────────────────────────────────────

test('android runbook documents no-Gateway boot path', () => {
  const content = readFileSync(join(repoRoot, androidRunbookPath), 'utf8');
  assert.match(content, /not require a full OpenClaw Gateway install/);
  assert.match(content, /termux-wake-lock/);
  assert.match(content, /\.termux\/boot\/a2a-hermes-worker/);
  assert.match(content, /re-registers and heartbeats on every pass/);
});

test('android runbook has no secret values', () => {
  const content = readFileSync(join(repoRoot, androidRunbookPath), 'utf8');
  assert.doesNotMatch(content, /A2A_EDGE_SECRET=.*[A-Za-z0-9_]{8,}/);
  assert.doesNotMatch(content, /sk-[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(content, /\b[A-Za-z0-9_]{30,}:[A-Za-z0-9_-]{30,}\b/);
});
