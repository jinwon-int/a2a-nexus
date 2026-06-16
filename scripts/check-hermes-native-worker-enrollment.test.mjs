/**
 * Hermes native A2A worker enrollment validation.
 *
 * Validates the enrollment runbook and fixture:
 * - Enrollment runbook structure and required sections.
 * - Enrollment evidence fixture JSON schema, evidence schemas, safety flags.
 * - Cross-reference consistency with no-live conformance and Gongyung profile.
 * - Redaction rules and secret-free content.
 * - GO/NO-GO matrix completeness.
 * - Rollback procedure coverage.
 * - Android/Termux caveats documentation.
 *
 * Safety: read-only doc and fixture validation. No live broker, provider send,
 * deploy, restart, terminal ACK, database mutation, or secret exposure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const repoRoot = process.cwd();
const enrollmentRunbookPath = 'docs/hermes-native-worker-enrollment-runbook.md';
const enrollmentFixturePath = 'fixtures/native-worker/enrollment-evidence.json';
const conformanceFixturePath = 'fixtures/native-worker/no-live-conformance.json';
const conformanceChecklistPath = 'docs/hermes-native-worker-conformance-checklist.md';
const androidRunbookPath = 'docs/hermes-android-native-worker-runbook.md';
const gongyungSpecPath = 'docs/specs/gongyung-hermes-worker-profile/spec.md';
const hermesIntegrationSpec = 'docs/specs/hermes-worker-integration/spec.md';
const workerCapabilityRegistryPath = 'packages/broker/docs/worker-capability-registry.md';

// ── File existence checks ─────────────────────────────────────────

test('hermes native worker enrollment runbook exists', () => {
  assert.ok(existsSync(join(repoRoot, enrollmentRunbookPath)), `missing: ${enrollmentRunbookPath}`);
});

test('hermes native worker enrollment evidence fixture exists', () => {
  assert.ok(existsSync(join(repoRoot, enrollmentFixturePath)), `missing: ${enrollmentFixturePath}`);
});

test('prerequisite no-live conformance fixture exists', () => {
  assert.ok(existsSync(join(repoRoot, conformanceFixturePath)), `missing: ${conformanceFixturePath}`);
});

test('prerequisite conformance checklist exists', () => {
  assert.ok(existsSync(join(repoRoot, conformanceChecklistPath)), `missing: ${conformanceChecklistPath}`);
});

test('prerequisite android runbook exists', () => {
  assert.ok(existsSync(join(repoRoot, androidRunbookPath)), `missing: ${androidRunbookPath}`);
});

test('prerequisite gongyung spec exists', () => {
  assert.ok(existsSync(join(repoRoot, gongyungSpecPath)), `missing: ${gongyungSpecPath}`);
});

test('prerequisite hermes integration spec exists', () => {
  assert.ok(existsSync(join(repoRoot, hermesIntegrationSpec)), `missing: ${hermesIntegrationSpec}`);
});

test('worker capability registry exists', () => {
  assert.ok(existsSync(join(repoRoot, workerCapabilityRegistryPath)), `missing: ${workerCapabilityRegistryPath}`);
});

test('worker capability registry frames Gongyung and Daegyo as mobile no-live workers', () => {
  const content = readFileSync(join(repoRoot, workerCapabilityRegistryPath), 'utf8');

  assert.match(content, /gongyung/i);
  assert.match(content, /daegyo/i);
  assert.match(content, /mobile\s*\/\s*non-docker/i);
  assert.match(content, /no-live, source-only `analyze` \/ `verify`/i);
  assert.match(content, /must reject: Docker-runner, live-impact, provider-send, and generic GitHub-write\/proof-marker payloads/i);
  assert.match(content, /termux-proot-distro-a2a-runner\.md/);
  assert.match(content, /#805/);
  assert.match(content, /#807/);
});

// ── Runbook structure validation ──────────────────────────────────

test('enrollment runbook has required top-level sections', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');

  assert.match(content, /## 1\. Overview/);
  assert.match(content, /## 2\. Pre-Enrollment Prerequisites/);
  assert.match(content, /## 3\. Enrollment Preflight Checks/);
  assert.match(content, /## 4\. Enrollment Procedure/);
  assert.match(content, /## 5\. Post-Enrollment Health Verification/);
  assert.match(content, /## 6\. Allowed and Rejected Task Classes/);
  assert.match(content, /## 7\. GO\/NO-GO Matrix/);
  assert.match(content, /## 8\. Rollback \/ Disable Path/);
  assert.match(content, /## 9\. Android \/ Termux Caveats/);
  assert.match(content, /## 10\. Approval-Sensitive Boundaries/);
  assert.match(content, /## 11\. Evidence Inventory/);
  assert.match(content, /## 12\. Residual Risks/);
  assert.match(content, /## 13\. Related Documents/);
  assert.match(content, /## Safety Confirmation/);
});

test('enrollment runbook references issue 504 and parent 503', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');
  assert.match(content, /#504/);
  assert.match(content, /#503/);
  assert.match(content, /seoseo/);
});

test('enrollment runbook references prerequisite documents', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');

  assert.match(content, /hermes-android-native-worker-runbook/);
  assert.match(content, /hermes-native-worker-conformance-checklist/);
  assert.match(content, /gongyung-hermes-worker-profile/);
  assert.match(content, /hermes-worker-integration/);
  assert.match(content, /no-live-conformance\.json/);
  assert.match(content, /enrollment-evidence\.json/);
  assert.match(content, /platform-adapter-interface/);
});

test('enrollment runbook relative links resolve to repo files', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');
  const sourceDir = dirname(enrollmentRunbookPath);
  const links = Array.from(content.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g))
    .map(match => match[1])
    .filter(href => href.endsWith('.md') || href.endsWith('.json'));

  assert.ok(links.length > 0, 'runbook must contain relative repo links');

  for (const href of links) {
    assert.ok(!href.startsWith('../..'), `link must not escape above repo root: ${href}`);
    const resolved = normalize(join(sourceDir, href));
    assert.ok(existsSync(join(repoRoot, resolved)), `broken runbook link: ${href} -> ${resolved}`);
  }
});

test('enrollment runbook documents GO/NO-GO matrix with all required gates', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');

  const expectedGates = [
    'G1_noLiveConformance',
    'G2_workerProfile',
    'G3_registrationPayload',
    'G4_evidenceRedaction',
    'G5_preflightAllPass',
    'G6_operatorApproval',
    'G7_envBackup',
    'G8_rollbackProcedure',
    'G9_nonLoopbackAuthorized',
    'G10_enrollmentEvidence',
  ];
  for (const gate of expectedGates) {
    assert.match(content, new RegExp(gate), `runbook must reference gate ${gate}`);
  }
});

test('enrollment runbook documents rollback procedure with steps', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');

  assert.match(content, /## 8\. Rollback/);
  assert.match(content, /Step R1/);
  assert.match(content, /Step R2/);
  assert.match(content, /Step R3/);
  assert.match(content, /Step R4/);
  assert.match(content, /Step R5/);
  assert.match(content, /rollbackEvidence/);
  assert.match(content, /loopbackRecoverySuccess/);
});

test('enrollment runbook documents Android/Termux caveats', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');

  assert.match(content, /Android/i);
  assert.match(content, /Termux/i);
  assert.match(content, /Doze/i);
  assert.match(content, /wake.lock/i);
  assert.match(content, /Tailscale/);
  assert.match(content, /battery/i);
  assert.match(content, /tunnel/i);
});

test('enrollment runbook documents allowed and rejected task intents', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');

  assert.match(content, /## 6\. Allowed and Rejected Task Classes/);
  assert.match(content, /gongyung_not_docker_runner/);
  assert.match(content, /dockerRequired/);
  assert.match(content, /credentialMovement/);
  assert.match(content, /productionACK/);
});

test('enrollment runbook documents enrollment preflight gates P1-P10', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');

  for (let i = 1; i <= 10; i++) {
    assert.match(content, new RegExp(`P${i}\\b`), `runbook must reference preflight gate P${i}`);
  }
});

test('enrollment runbook documents approval-sensitive boundaries', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');

  assert.match(content, /Approval-Sensitive Boundaries/);
  assert.match(content, /Requires separate operator approval/);
  assert.match(content, /Live provider/);
  assert.match(content, /DB mutation/);
  assert.match(content, /PR merge/);
  assert.match(content, /Force push/);
});

test('enrollment runbook documents enrollment procedure steps', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');

  assert.match(content, /Step E1/);
  assert.match(content, /Step E2/);
  assert.match(content, /Step E3/);
  assert.match(content, /Step E4/);
  assert.match(content, /Step E5/);
  assert.match(content, /Step E6/);
  assert.match(content, /Step E7/);
  assert.match(content, /A2A_BROKER_URL/);
  assert.match(content, /--action register/);
  assert.match(content, /--action run-once/);
});

test('enrollment runbook documents evidence inventory', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');
  assert.match(content, /## 11\. Evidence Inventory/);
  assert.match(content, /pre\.json/);
  assert.match(content, /post\.json/);
  assert.match(content, /go-nogo/);
  assert.match(content, /rollback/);
  assert.match(content, /readiness-check/);
});

test('enrollment runbook documents residual risks', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');
  assert.match(content, /## 12\. Residual Risks/);
  assert.match(content, /Mitigation/);
  assert.match(content, /Likelihood/);
  assert.match(content, /Impact/);
});

test('enrollment runbook has no secret values', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');

  assert.doesNotMatch(content, /\b[A-Za-z0-9_]{30,}:[A-Za-z0-9_-]{30,}\b/);
  assert.doesNotMatch(content, /sk-[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(content, /api\.telegram\.org/);
  assert.doesNotMatch(content, /providerToken|provider_token/);
  assert.doesNotMatch(content, /edge_secret|EDGE_SECRET/);
});

test('enrollment runbook safety confirmation has required negative statements', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');

  assert.match(content, /noProductionDeploy|no production deploy/i);
  assert.match(content, /noGatewayRestart|Gateway.*restart/i);
  assert.match(content, /noLiveProviderSend|no live provider/i);
  assert.match(content, /noDbMutation|DB mutation/i);
  assert.match(content, /noTerminalAck|Terminal.outbox ACK/i);
  assert.match(content, /noCredentialMovement|credential movement/i);
  assert.match(content, /noSecretDisclosure|secret disclosure/i);
});

// ── Fixture schema validation ─────────────────────────────────────

test('enrollment fixture has required top-level fields', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, enrollmentFixturePath), 'utf8'));

  assert.equal(fixture.schema, 'a2a.hermesNativeWorker.enrollmentEvidence.v1');
  assert.equal(fixture.mode, 'enrollment-dry-run');
  assert.ok(typeof fixture.fixtureId === 'string' && fixture.fixtureId.length > 0);
  assert.ok(typeof fixture.description === 'string' && fixture.description.length > 0);
  assert.equal(fixture.issue, 'https://github.com/jinwon-int/a2a-plane/issues/504');
  assert.equal(fixture.parentIssue, 'https://github.com/jinwon-int/a2a-plane/issues/503');
});

test('enrollment fixture references prior art issues', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, enrollmentFixturePath), 'utf8'));
  const priorArt = fixture.priorArt || [];
  const priorArtStr = priorArt.join(' ');

  assert.ok(priorArtStr.includes('/issues/393'), 'fixture must reference a2a-plane#393');
  assert.ok(priorArtStr.includes('/issues/464'), 'fixture must reference a2a-plane#464');
  assert.ok(priorArtStr.includes('/issues/465'), 'fixture must reference a2a-plane#465');
  assert.ok(priorArtStr.includes('/issues/504'), 'fixture must reference a2a-plane#504');
});

test('enrollment fixture has reference fields', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, enrollmentFixturePath), 'utf8'));

  assert.ok(fixture.profiles.some(p => p.includes('gongyung-hermes-worker-profile')), 'fixture must reference gongyung profile');
  assert.ok(fixture.runbook.includes('hermes-native-worker-enrollment-runbook'), 'fixture must reference enrollment runbook');
  assert.ok(fixture.priorFixture.includes('no-live-conformance.json'), 'fixture must reference no-live conformance fixture');
  assert.ok(fixture.referenceWorker.includes('hermes-reference-worker'), 'fixture must reference worker');
});

test('enrollment fixture has valid evidence schemas', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, enrollmentFixturePath), 'utf8'));
  const schemas = fixture.evidenceSchemas;

  assert.ok(schemas.enrollmentPreSnapshot, 'must have enrollmentPreSnapshot schema');
  assert.ok(schemas.enrollmentPostSnapshot, 'must have enrollmentPostSnapshot schema');
  assert.ok(schemas.enrollmentGoNoGo, 'must have enrollmentGoNoGo schema');
  assert.ok(schemas.rollbackEvidence, 'must have rollbackEvidence schema');

  assert.equal(schemas.enrollmentPreSnapshot.schemaId, 'a2a.hermesWorker.enrollmentPreSnapshot.v1');
  assert.equal(schemas.enrollmentPostSnapshot.schemaId, 'a2a.hermesWorker.enrollmentEvidence.v1');
  assert.equal(schemas.enrollmentGoNoGo.schemaId, 'a2a.hermesWorker.enrollmentGoNoGo.v1');
  assert.equal(schemas.rollbackEvidence.schemaId, 'a2a.hermesWorker.rollbackEvidence.v1');
});

test('enrollment fixture evidence schemas have requiredFields and forbiddenFields', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, enrollmentFixturePath), 'utf8'));
  const schemas = fixture.evidenceSchemas;

  for (const [key, schema] of Object.entries(schemas)) {
    assert.ok(schema.requiredFields, `${key} must have requiredFields`);
    assert.ok(Array.isArray(schema.requiredFields) && schema.requiredFields.length > 0,
      `${key} requiredFields must be a non-empty array`);
    if (schema.schemaId === 'a2a.hermesWorker.enrollmentGoNoGo.v1') {
      // enrollmentGoNoGo uses forbiddenFields embedded in other schema entries (pre/post/rollback)
      // and validatedGoNoGoDecision shape. Its forbidden fields are the same as the others.
      assert.ok(schema.forbiddenFields, `${key} must have forbiddenFields`);
      assert.ok(Array.isArray(schema.forbiddenFields) && schema.forbiddenFields.length > 0,
        `${key} forbiddenFields must be a non-empty array`);
    } else {
      assert.ok(schema.forbiddenFields, `${key} must have forbiddenFields`);
      assert.ok(Array.isArray(schema.forbiddenFields) && schema.forbiddenFields.length > 0,
        `${key} forbiddenFields must be a non-empty array`);
    }
  }
});

test('enrollment fixture go-nogo schema has 10 required gates', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, enrollmentFixturePath), 'utf8'));
  const gates = fixture.evidenceSchemas.enrollmentGoNoGo.requiredGates;

  assert.equal(gates.length, 10, 'enrollmentGoNoGo must have exactly 10 required gates');
  assert.ok(gates.includes('G1_noLiveConformance'));
  assert.ok(gates.includes('G6_operatorApproval'));
  assert.ok(gates.includes('G8_rollbackProcedure'));
  assert.ok(gates.includes('G10_enrollmentEvidence'));
});

test('enrollment fixture schema validDecisions includes GO, NO_GO, BLOCKED', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, enrollmentFixturePath), 'utf8'));
  const decisions = fixture.evidenceSchemas.enrollmentGoNoGo.validDecisions;

  assert.ok(decisions.includes('GO'));
  assert.ok(decisions.includes('NO_GO'));
  assert.ok(decisions.includes('BLOCKED'));
});

test('enrollment fixture go-nogo schema has required safety confirmation fields', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, enrollmentFixturePath), 'utf8'));
  const safetyFields = fixture.evidenceSchemas.enrollmentGoNoGo.requiredSafetyConfirmationFields;

  const expected = [
    'noProductionDeploy',
    'noGatewayRestart',
    'noBrokerWorkerRestart',
    'noLiveProviderSend',
    'noDbMutation',
    'noTerminalAck',
    'noCredentialMovement',
    'noSecretDisclosure',
  ];
  for (const field of expected) {
    assert.ok(safetyFields.includes(field), `requiredSafetyConfirmationFields must include ${field}`);
  }
});

test('enrollment fixture has valid and invalid sample payloads', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, enrollmentFixturePath), 'utf8'));

  assert.ok(fixture.samplePayloads.valid, 'must have valid sample payload');
  assert.ok(fixture.samplePayloads.invalid, 'must have invalid sample payload');

  // Valid sample must have GO decision
  assert.equal(fixture.samplePayloads.valid.decision, 'GO');
  assert.ok(fixture.samplePayloads.valid.workerId, 'valid sample must have workerId');
  assert.ok(fixture.samplePayloads.valid.operatorApprovalCommentUrl, 'valid sample must have operatorApprovalCommentUrl');

  // Invalid sample must have null/empty/missing fields
  assert.equal(fixture.samplePayloads.invalid.decision, 'MAYBE', 'invalid sample should have invalid decision');
  assert.equal(fixture.samplePayloads.invalid.workerId, null, 'invalid sample should have null workerId');
});

test('enrollment fixture safety flags are all false', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, enrollmentFixturePath), 'utf8'));
  const safety = fixture.safety;

  for (const [key, val] of Object.entries(safety)) {
    assert.equal(val, false, `safety.${key} must be false in enrollment fixture`);
  }
});

test('enrollment fixture contains Android/Termux caveats section', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, enrollmentFixturePath), 'utf8'));
  const caveats = fixture.androidTermuxCaveats;

  assert.ok(caveats.enrollmentWakeLock, 'must document enrollment wake lock');
  assert.ok(caveats.enrollmentNetwork, 'must document enrollment network/tunnel stability');
  assert.ok(caveats.enrollmentBattery, 'must document enrollment battery impact');
  assert.ok(caveats.enrollmentStorage, 'must document enrollment storage permissions');
  assert.ok(caveats.bootAfterEnrollment, 'must document boot after enrollment');
});

test('enrollment fixture has no secret values', () => {
  const content = readFileSync(join(repoRoot, enrollmentFixturePath), 'utf8');

  assert.doesNotMatch(content, /\b[A-Za-z0-9_]{30,}:[A-Za-z0-9_-]{30,}\b/);
  assert.doesNotMatch(content, /sk-[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(content, /api\.telegram\.org/);
  // Schema definitions reference field names like "providerToken" as forbiddenFields —
  // they are not actual secret values. Check only that no actual token/secret value
  // appears outside a field-name context.
  assert.doesNotMatch(content, /"providerToken":\s*"/, 'fixture must not contain an actual providerToken value');
  assert.doesNotMatch(content, /sk-[A-Za-z0-9]{20,}/);
});

// ── Cross-reference consistency ─────────────────────────────────────

test('enrollment runbook references conformance checklist', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');
  assert.match(content, /hermes-native-worker-conformance-checklist\.md/);
  assert.match(content, /no-live conformance/);
});

test('enrollment fixture references enrollment runbook', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, enrollmentFixturePath), 'utf8'));
  assert.ok(fixture.runbook.includes('hermes-native-worker-enrollment-runbook'), 'fixture must reference enrollment runbook');
});

test('enrollment fixture references prior no-live fixture', () => {
  const fixture = JSON.parse(readFileSync(join(repoRoot, enrollmentFixturePath), 'utf8'));
  assert.ok(fixture.priorFixture.includes('no-live-conformance.json'), 'fixture must reference no-live conformance fixture');
});

test('enrollment runbook and fixture both reference all 4 evidence types', () => {
  const runbook = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');
  const fixture = JSON.parse(readFileSync(join(repoRoot, enrollmentFixturePath), 'utf8'));

  // Runbook must reference all evidence schemas
  assert.match(runbook, /enrollmentPreSnapshot|enrollment.*pre\.json/);
  assert.match(runbook, /enrollmentEvidence|enrollment.*post\.json/);
  assert.match(runbook, /enrollmentGoNoGo/);
  assert.match(runbook, /rollbackEvidence/);

  // Fixture must have all 4 schemas
  assert.ok(fixture.evidenceSchemas.enrollmentPreSnapshot);
  assert.ok(fixture.evidenceSchemas.enrollmentPostSnapshot);
  assert.ok(fixture.evidenceSchemas.enrollmentGoNoGo);
  assert.ok(fixture.evidenceSchemas.rollbackEvidence);
});

test('enrollment runbook documents safety boundary matching fixture', () => {
  const runbook = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');
  const fixture = JSON.parse(readFileSync(join(repoRoot, enrollmentFixturePath), 'utf8'));

  const safetyKeys = Object.keys(fixture.safety);
  for (const key of safetyKeys) {
    // Convert camelCase to human-readable patterns with flexible matching.
    // Accept common alternate terms (DB ↔ database, publish ↔ publication).
    let readable = key.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    readable = readable.replace(/\bdatabase\b/g, 'db');
    const tokens = readable.split(/\s+/);
    const allPresent = tokens.every(t => runbook.toLowerCase().includes(t));
    assert.ok(allPresent, `runbook safety boundary must mention all tokens of '${readable}' (key=${key})`);
  }
});

// ── GO/NO-GO matrix validation ─────────────────────────────────────

test('enrollment go-nogo matrix has correct gate structure', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');

  assert.match(content, /GO.*NO.GO.*Matrix/);
  assert.match(content, /Required condition/);
  assert.match(content, /Evidence source/);
  assert.match(content, /Fail-closed/);
  assert.match(content, /ALL gates GO/);
  assert.match(content, /One or more NO-GO/);
});

test('enrollment go-nogo matrix has GO, NO-GO, and BLOCKED decisions', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');

  assert.match(content, /\*\*GO\*\*/);
  assert.match(content, /\*\*NO-GO\*\*/);
  assert.match(content, /\*\*BLOCKED\*\*/);
});

test('enrollment go-nogo evidence packet template references enrollment evidence', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');
  assert.match(content, /enrollmentGoNoGo\.v1/);
  assert.match(content, /gateResults/);
  assert.match(content, /blockers/);
  assert.match(content, /safetyConfirmation/);
});

// ── Rollback validation ────────────────────────────────────────────

test('rollback procedure documents when to rollback', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');
  assert.match(content, /When to rollback/);
  assert.match(content, /cannot maintain heartbeat/);
  assert.match(content, /claims.*unsafe task/);
  assert.match(content, /leaks secret/);
});

test('rollback procedure documents all rollback invariants', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');
  assert.match(content, /Rollback invariants/);
  assert.match(content, /No evidence deletion/);
  assert.match(content, /No comment deletion/);
  assert.match(content, /No terminal-outbox mutation/);
  assert.match(content, /No provider send/);
  assert.match(content, /No DB mutation/);
  assert.match(content, /No restart of unrelated services/);
});

test('rollback procedure documents post-rollback state', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');
  assert.match(content, /Post-rollback state/);
  assert.match(content, /Env file/);
  assert.match(content, /Worker loop/);
  assert.match(content, /Broker registration/);
  assert.match(content, /Rollback evidence/);
});

// ── Workflow consistency ────────────────────────────────────────────

test('enrollment runbook documents that enrollment ACT requires explicit GO', () => {
  const content = readFileSync(join(repoRoot, enrollmentRunbookPath), 'utf8');
  assert.match(content, /Enrollment ACT/i, 'runbook must mention Enrollment ACT');
  assert.match(content, /requires explicit/i, 'runbook must state ACT requires explicit GO');
});
