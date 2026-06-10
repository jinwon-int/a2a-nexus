import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const fixturePath = path.join(root, 'fixtures', 'contract', 'terminal-brief-canary-acceptance.json');
const fixtureText = fs.readFileSync(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText);

// --- Secret/redaction checks ---
const secretLikePatterns = [
  /ghp_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]+/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\/Users\/[A-Za-z0-9._-]+\//,
];

for (const pattern of secretLikePatterns) {
  assert.ok(
    !pattern.test(fixtureText),
    `terminal brief canary acceptance fixture matched forbidden pattern ${pattern}`,
  );
}

// --- OpenClaw runtime/bootstrap path guard ---
const forbiddenRuntimePaths = [
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  '.openclaw/',
];

for (const forbiddenPath of forbiddenRuntimePaths) {
  assert.ok(
    !fixtureText.includes(forbiddenPath),
    `fixture text must not reference OpenClaw runtime/bootstrap path ${forbiddenPath}`,
  );
}

// --- Metadata checks ---
assert.equal(fixture.fixtureId, 'a2a-nexus.contract.terminal-brief-canary-acceptance.v1');
assert.equal(fixture.contract, 'docs/specs/a2a-terminal-brief-canary/spec.md');
assert.equal(fixture.parentIssue, 'https://github.com/jinwon-int/a2a-plane/issues/364');
assert.equal(fixture.issue, 'https://github.com/jinwon-int/a2a-plane/issues/365');
assert.equal(fixture.team, 'team1-bangtong');
assert.equal(fixture.brokerOfRecord, 'seoseo');
assert.equal(fixture.round, 'R27');

// --- v0Freeze marker ---
assert.ok(fixture.v0Freeze, 'fixture must carry v0Freeze marker');
assert.ok(fixture.v0Freeze.frozenAt, 'v0Freeze must include frozenAt');
assert.ok(fixture.v0Freeze.round, 'v0Freeze must include round');

// --- Five hardening gaps ---
const gaps = fixture.hardeningGaps;
assert.ok(gaps, 'fixture must define hardeningGaps');

const expectedGapKeys = [
  'gap1BacklogFalseSuppression',
  'gap2SessionKeyRequirement',
  'gap3ConfigShapeFlexibility',
  'gap4CursorSelectionSafety',
  'gap5OperatorEventsRestore',
];

for (const gapKey of expectedGapKeys) {
  assert.ok(gaps[gapKey], `missing hardening gap: ${gapKey}`);
  assert.ok(gaps[gapKey].description, `${gapKey} must have description`);
  assert.ok(Array.isArray(gaps[gapKey].acceptanceRules), `${gapKey} must have acceptanceRules array`);
  assert.ok(gaps[gapKey].acceptanceRules.length >= 3, `${gapKey} must have at least 3 acceptance rules`);
  assert.ok(Array.isArray(gaps[gapKey].assertionKeys), `${gapKey} must have assertionKeys array`);
  assert.ok(gaps[gapKey].assertionKeys.length >= 3, `${gapKey} must have at least 3 assertion keys`);
}

// --- Scenarios ---
assert.ok(Array.isArray(fixture.scenarios), 'fixture must contain scenarios array');
assert.ok(fixture.scenarios.length >= 12, `fixture must have at least 12 scenarios, got ${fixture.scenarios.length}`);

const scenarios = new Map(fixture.scenarios.map((s) => [s.name, s]));

const requiredScenarioNames = [
  'preflight-rejects-terminal-task-before-poller-start',
  'mid-poll-terminal-detection-stops-poller',
  'explicit-sessionKey-required-for-monitor-status',
  'sessionKey-presence-logged-in-canary-output',
  'object-backed-config-normalized',
  'array-backed-config-normalized',
  'shape-assumption-failure-produces-visible-error',
  'cursor-selects-latest-entry-safely',
  'replayed-cursor-does-not-trigger-duplicate-evidence',
  'cursor-selection-failure-produces-visible-error',
  'operatorEvents-restored-on-success-exit',
  'operatorEvents-restored-on-error-exit',
  'operatorEvents-restored-on-interrupt-exit',
  'operatorEvents-baseline-captured-before-modification',
];

for (const name of requiredScenarioNames) {
  assert.ok(scenarios.has(name), `missing required scenario: ${name}`);
}

// --- Gap assignment verification ---
// Every scenario must reference a valid gap
const validGapKeys = new Set(expectedGapKeys);
for (const [name, scenario] of scenarios) {
  assert.ok(validGapKeys.has(scenario.gap), `scenario "${name}" references unknown gap "${scenario.gap}"`);
}

// --- Gap 1 scenario checks ---
const gap1Scenarios = ['preflight-rejects-terminal-task-before-poller-start', 'mid-poll-terminal-detection-stops-poller'];
for (const name of gap1Scenarios) {
  const s = scenarios.get(name);
  assert.equal(s.gap, 'gap1BacklogFalseSuppression', `${name} must belong to gap1BacklogFalseSuppression`);
  assert.equal(s.then.backlogSuppressionSignal, false, `${name}: backlogSuppressionSignal must be false`);
  assert.ok(s.then.reasonCodes.length >= 1, `${name}: must have reason codes`);
}

// --- Gap 2 scenario checks ---
const gap2Scenarios = ['explicit-sessionKey-required-for-monitor-status', 'sessionKey-presence-logged-in-canary-output'];
for (const name of gap2Scenarios) {
  const s = scenarios.get(name);
  assert.equal(s.gap, 'gap2SessionKeyRequirement', `${name} must belong to gap2SessionKeyRequirement`);
}

const sessionKeyScenario = scenarios.get('explicit-sessionKey-required-for-monitor-status');
assert.equal(sessionKeyScenario.then.missingKeyCallsProduceVisibleError, true);
assert.equal(sessionKeyScenario.then.missingKeyCallsNeverProduceEmptyState, true);

const sessionKeyLogScenario = scenarios.get('sessionKey-presence-logged-in-canary-output');
assert.equal(sessionKeyLogScenario.then.sessionKeyPresenceConfirmed, true);
assert.equal(sessionKeyLogScenario.then.rawSessionKeyNeverLogged, true);

// --- Gap 3 scenario checks ---
const gap3Scenarios = ['object-backed-config-normalized', 'array-backed-config-normalized', 'shape-assumption-failure-produces-visible-error'];
for (const name of gap3Scenarios) {
  const s = scenarios.get(name);
  assert.equal(s.gap, 'gap3ConfigShapeFlexibility', `${name} must belong to gap3ConfigShapeFlexibility`);
}

const objectConfigScenario = scenarios.get('object-backed-config-normalized');
assert.equal(objectConfigScenario.then.preflightAccepted, true);
assert.equal(objectConfigScenario.then.normalizedToCanonicalForm, true);
assert.equal(objectConfigScenario.then.shapeRecordedInEvidence, true);

const arrayConfigScenario = scenarios.get('array-backed-config-normalized');
assert.equal(arrayConfigScenario.then.preflightAccepted, true);
assert.equal(arrayConfigScenario.then.normalizedToCanonicalForm, true);
assert.equal(arrayConfigScenario.then.shapeRecordedInEvidence, true);

const invalidShapeScenario = scenarios.get('shape-assumption-failure-produces-visible-error');
assert.equal(invalidShapeScenario.then.preflightAccepted, false);
assert.equal(invalidShapeScenario.then.visibleErrorProduced, true);

// --- Gap 4 scenario checks ---
const gap4Scenarios = ['cursor-selects-latest-entry-safely', 'replayed-cursor-does-not-trigger-duplicate-evidence', 'cursor-selection-failure-produces-visible-error'];
for (const name of gap4Scenarios) {
  const s = scenarios.get(name);
  assert.equal(s.gap, 'gap4CursorSelectionSafety', `${name} must belong to gap4CursorSelectionSafety`);
}

const cursorScenario = scenarios.get('cursor-selects-latest-entry-safely');
assert.equal(cursorScenario.then.selectedCursorId, 'cursor-latest-001');
assert.equal(cursorScenario.then.staleRejected, true);
assert.equal(cursorScenario.then.selectionIdempotent, true);

const replayScenario = scenarios.get('replayed-cursor-does-not-trigger-duplicate-evidence');
assert.equal(replayScenario.then.replaySuppressed, true);
assert.equal(replayScenario.then.duplicateEvidenceNotProduced, true);

const cursorFailScenario = scenarios.get('cursor-selection-failure-produces-visible-error');
assert.equal(cursorFailScenario.then.cursorSelected, false);
assert.equal(cursorFailScenario.then.visibleErrorProduced, true);
assert.equal(cursorFailScenario.then.silentFallbackNotAllowed, true);

// --- Gap 5 scenario checks ---
const gap5Scenarios = [
  'operatorEvents-restored-on-success-exit',
  'operatorEvents-restored-on-error-exit',
  'operatorEvents-restored-on-interrupt-exit',
  'operatorEvents-baseline-captured-before-modification',
];
for (const name of gap5Scenarios) {
  const s = scenarios.get(name);
  assert.equal(s.gap, 'gap5OperatorEventsRestore', `${name} must belong to gap5OperatorEventsRestore`);
}

for (const name of ['operatorEvents-restored-on-success-exit', 'operatorEvents-restored-on-error-exit', 'operatorEvents-restored-on-interrupt-exit']) {
  const s = scenarios.get(name);
  assert.equal(s.then.operatorEventsRestored, true, `${name}: operatorEventsRestored must be true`);
  assert.deepEqual(s.then.restoredValue, { enabled: false }, `${name}: restoredValue must be {enabled: false}`);
}

const baselineScenario = scenarios.get('operatorEvents-baseline-captured-before-modification');
assert.equal(baselineScenario.then.baselineRecorded, true);
assert.equal(baselineScenario.then.canRestoreToInitialState, true);

// --- Assertions ---
assert.ok(Array.isArray(fixture.assertions), 'fixture must contain assertions array');
assert.ok(fixture.assertions.length >= 13, `fixture must have at least 13 assertions, got ${fixture.assertions.length}`);

const assertionsSet = new Set(fixture.assertions);
const requiredAssertions = [
  'backlog false suppression must not occur',
  'terminal task must produce visible error',
  'every a2a.monitor.status call must carry an explicit sessionKey',
  'missing sessionKey must cause visible error',
  'operatorEvents must be restored',
  'no live provider send, no terminal-outbox ACK mutation',
];

for (const required of requiredAssertions) {
  const found = [...assertionsSet].some((a) => a.includes(required));
  assert.ok(found, `assertion must contain "${required}"`);
}

// --- Safety confirmations ---
const requiredSafetyKeys = [
  'noProductionDeployOrRestart',
  'noGatewayRestart',
  'noBrokerRestart',
  'noWorkerRestart',
  'noLiveProviderSend',
  'noTerminalOutboxAckMutation',
  'noProductionDatabaseMutation',
  'noSecretRotationOrDisclosure',
  'noHistoryRewrite',
  'noForcePush',
  'noReleasePublication',
  'noAutomaticMergeOrApproval',
  'noRepositoryVisibilityChange',
  'redacted',
  'syntheticFixtureOnly',
  'noRawSessionDump',
  'noHostSpecificPrivatePath',
  'noOpenClawRuntimeBootstrapArtifact',
];

for (const key of requiredSafetyKeys) {
  assert.equal(
    fixture.safetyConfirmations[key],
    true,
    `safety confirmation ${key} must be true`,
  );
}

// --- Deep-value checks: certain boolean invariants must never be violated ---
function walk(value, visit, trail = []) {
  visit(value, trail);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, [...trail, index]));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      walk(item, visit, [...trail, key]);
    }
  }
}

// Verify that backlogSuppressionSignal is never true in any scenario
walk(fixture, (value, trail) => {
  if (trail.at(-1) === 'backlogSuppressionSignal' && typeof value === 'boolean') {
    assert.equal(value, false, `backlogSuppressionSignal must be false at ${trail.join('.')}`);
  }
});

// Verify that liveProviderSend is never true anywhere in the fixture
walk(fixture, (value, trail) => {
  if (trail.at(-1) === 'noLiveProviderSend' && typeof value === 'boolean') {
    assert.equal(value, true, `noLiveProviderSend must be true at ${trail.join('.')}`);
  }
});

console.log(
  JSON.stringify({
    ok: true,
    checkedFixture: 'fixtures/contract/terminal-brief-canary-acceptance.json',
    scenarioCount: fixture.scenarios.length,
    hardeningGapCount: Object.keys(fixture.hardeningGaps).length,
    coveredGaps: expectedGapKeys,
    safetyConfirmations: Object.keys(fixture.safetyConfirmations).length,
  }),
);
