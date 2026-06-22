import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const fixturePath = path.join(root, 'fixtures', 'contract', 'claim-lease-stale-classification.json');

const fixtureText = fs.readFileSync(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText);

// --- Meta assertions ---
assert.equal(fixture.fixtureId, 'a2a-nexus.contract.claim-lease-stale-classification.v1');
assert.equal(fixture.contract, 'contracts/a2a/terminal-evidence.schema.json');
assert.ok(fixture.v0Freeze, 'fixture must carry v0Freeze marker');
assert.ok(fixture.v0Freeze.frozenAt, 'v0Freeze must include frozenAt');
assert.equal(fixture.v0Freeze.sourceOnly, true);
assert.equal(fixture.v0Freeze.noLive, true);

// --- Safety assertions ---
assert.equal(fixture.safety.sourceOnly, true);
assert.equal(fixture.safety.noLive, true);
assert.equal(fixture.safety.providerSend, false);
assert.equal(fixture.safety.dbMutation, false);
assert.equal(fixture.safety.terminalAckMutation, false);
assert.equal(fixture.safety.deployOrRestart, false);

// --- Classification rules cover all evidenceClasses ---
const expectedEvidenceClasses = [
  'fresh_claim',
  'stale_claim_no_progress',
  'stale_claim_last_progress_present',
  'nonterminal_claimed_missing_evidence',
  'nonterminal_running_missing_evidence',
];
assert.deepEqual(
  fixture.evidenceClasses.sort(),
  expectedEvidenceClasses.sort(),
);

const ruleByName = new Map(
  Object.entries(fixture.classificationRules).map(([name, rule]) => [name, rule]),
);
for (const ec of expectedEvidenceClasses) {
  assert.ok(ruleByName.has(ec), `classificationRules missing entry for ${ec}`);
}

// --- staleClaimThresholdMs is positive ---
assert.ok(fixture.staleClaimThresholdMs > 0, 'staleClaimThresholdMs must be positive');
assert.equal(typeof fixture.staleClaimThresholdMs, 'number');

// --- Scenario assertions ---
assert.ok(Array.isArray(fixture.scenarios) && fixture.scenarios.length >= 5,
  'must have at least 5 scenarios');

const scenarioByName = new Map(fixture.scenarios.map((s) => [s.name, s]));

// S01: fresh-claim-within-threshold
const s01 = scenarioByName.get('fresh-claim-within-threshold');
assert.equal(s01.given.state, 'claimed');
assert.equal(s01.given.lastProgressAt, null);
assert.equal(s01.then.evidenceClass, 'fresh_claim');
assert.equal(s01.then.stale, false);
assert.equal(s01.then.finalizerAction, 'wait_or_poll');
assert.ok(s01.then.deltaMs <= fixture.staleClaimThresholdMs);

// S02: stale-claim-no-progress-past-threshold
const s02 = scenarioByName.get('stale-claim-no-progress-past-threshold');
assert.equal(s02.given.state, 'claimed');
assert.equal(s02.given.lastProgressAt, null);
const s02Delta = new Date(s02.given.now) - new Date(s02.given.claimedAt);
assert.ok(s02Delta > fixture.staleClaimThresholdMs, 'S02 must be past threshold');
assert.equal(s02.then.evidenceClass, 'stale_claim_no_progress');
assert.equal(s02.then.stale, true);
assert.equal(s02.then.finalizerAction, 'record_nonterminal_stale_claim');
assert.ok(Array.isArray(s02.then.suggestedNextAction));
assert.ok(s02.then.suggestedNextAction.includes('cancel'));

// S03: claim-old-but-last-progress-recent
const s03 = scenarioByName.get('claim-old-but-last-progress-recent');
assert.equal(s03.given.state, 'claimed');
assert.ok(s03.given.lastProgressAt !== null);
const s03ClaimedDelta = new Date(s03.given.now) - new Date(s03.given.claimedAt);
assert.ok(s03ClaimedDelta > fixture.staleClaimThresholdMs,
  'S03 claimedAt must be old');
const s03ProgressDelta = new Date(s03.given.now) - new Date(s03.given.lastProgressAt);
assert.ok(s03ProgressDelta <= fixture.staleClaimThresholdMs,
  'S03 lastProgressAt must be within threshold');
assert.equal(s03.then.evidenceClass, 'stale_claim_last_progress_present');
assert.equal(s03.then.stale, false);
assert.equal(s03.then.finalizerAction, 'wait_or_poll');

// S04: nonterminal-claimed-missing-evidence-daegyo
const s04 = scenarioByName.get('nonterminal-claimed-missing-evidence-daegyo');
assert.equal(s04.given.state, 'claimed');
assert.equal(s04.given.completedAt, null);
assert.equal(s04.given.result, null);
assert.equal(s04.given.error, null);
assert.equal(s04.given.assignedWorkerId, 'daegyo');
assert.equal(s04.given.workerLiveness.status, 'online');
assert.equal(s04.then.evidenceClass, 'nonterminal_claimed_missing_evidence');
assert.equal(s04.then.stale, true);
assert.equal(s04.then.countsAsSubstantive, false);
assert.equal(s04.then.countsForCloseout, false);
assert.equal(s04.then.finalizerAction, 'record_missing_evidence');

// S05: running-no-progress-stale
const s05 = scenarioByName.get('running-no-progress-stale');
assert.equal(s05.given.state, 'running');
assert.equal(s05.given.lastProgressAt, null);
const s05Delta = new Date(s05.given.now) - new Date(s05.given.startedAt);
assert.ok(s05Delta > fixture.staleClaimThresholdMs);
assert.equal(s05.then.evidenceClass, 'nonterminal_running_missing_evidence');
assert.equal(s05.then.stale, true);

// S06: running-with-recent-progress-not-stale
const s06 = scenarioByName.get('running-with-recent-progress-not-stale');
assert.equal(s06.given.state, 'running');
assert.ok(s06.given.lastProgressAt !== null);
assert.equal(s06.then.stale, false);
assert.equal(s06.then.finalizerAction, 'wait_or_poll');

// --- Stale claim detection function (in-test helper, not runtime) ---
function classifyStaleClaim(task, thresholdMs, now) {
  const nowMs = new Date(now).getTime();
  const state = task.state;
  const claimedAt = task.claimedAt
    ? new Date(task.claimedAt).getTime()
    : (task.createdAt ? new Date(task.createdAt).getTime() : null);
  const lastProgressAt = task.lastProgressAt ? new Date(task.lastProgressAt).getTime() : null;
  const startedAt = task.startedAt ? new Date(task.startedAt).getTime() : null;

  if (state === 'claimed' && claimedAt) {
    if (lastProgressAt) {
      const progressDelta = nowMs - lastProgressAt;
      if (progressDelta > thresholdMs) {
        return { evidenceClass: 'stale_claim_no_progress', stale: true };
      }
      return { evidenceClass: 'stale_claim_last_progress_present', stale: false };
    }
    const delta = nowMs - claimedAt;
    if (delta > thresholdMs) {
      if (task.completedAt === null && task.result === null && task.error === null) {
        return { evidenceClass: 'nonterminal_claimed_missing_evidence', stale: true };
      }
      return { evidenceClass: 'stale_claim_no_progress', stale: true };
    }
    return { evidenceClass: 'fresh_claim', stale: false };
  }

  if (state === 'running' && startedAt) {
    if (lastProgressAt) {
      const progressDelta = nowMs - lastProgressAt;
      if (progressDelta > thresholdMs) {
        return { evidenceClass: 'nonterminal_running_missing_evidence', stale: true };
      }
      return { evidenceClass: null, stale: false };
    }
    const delta = nowMs - startedAt;
    if (delta > thresholdMs) {
      return { evidenceClass: 'nonterminal_running_missing_evidence', stale: true };
    }
    return { evidenceClass: null, stale: false };
  }

  return { evidenceClass: null, stale: false };
}

// --- Validate classification function against scenarios ---
for (const scenario of fixture.scenarios) {
  const g = scenario.given;
  const expected = scenario.then;

  const result = classifyStaleClaim(g, fixture.staleClaimThresholdMs,
    g.now || g.pollEndTime || g.createdAt);

  if (expected.evidenceClass) {
    assert.equal(result.evidenceClass, expected.evidenceClass,
      `${scenario.id} ${scenario.name}: expected evidenceClass ${expected.evidenceClass}, got ${result.evidenceClass}`);
  }
  if (expected.stale !== undefined) {
    assert.equal(result.stale, expected.stale,
      `${scenario.id} ${scenario.name}: expected stale=${expected.stale}, got ${result.stale}`);
  }
}

// --- finalizerAssertions ---
assert.ok(Array.isArray(fixture.finalizerAssertions) && fixture.finalizerAssertions.length >= 5,
  'must have at least 5 finalizer assertions');
assert.ok(fixture.finalizerAssertions.some((a) => a.includes('claimedAt') || a.includes('ClaimedAt')),
  'must mention ClaimedAt requirement');
assert.ok(fixture.finalizerAssertions.some((a) => a.includes('LastProgressAt') || a.includes('lastProgress')),
  'must mention LastProgressAt');
assert.ok(fixture.finalizerAssertions.some((a) => a.includes('nonterminal_claimed_missing_evidence')),
  'must mention nonterminal_claimed_missing_evidence');

// --- Forbidden runtime path check ---
const forbiddenRuntimePaths = [
  'AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/',
];
const secretLikePatterns = [
  /ghp_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]+/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\/Users\/[A-Za-z0-9._-]+\//,
];
for (const forbiddenPath of forbiddenRuntimePaths) {
  assert.ok(!fixtureText.includes(forbiddenPath),
    `fixture must not reference ${forbiddenPath}`);
}
for (const pattern of secretLikePatterns) {
  assert.ok(!pattern.test(fixtureText),
    `fixture matched forbidden pattern ${pattern}`);
}

// --- issues coverage ---
assert.ok(Array.isArray(fixture.issues) && fixture.issues.length >= 3);
const issueRefs = fixture.issues.join(' ');
assert.ok(issueRefs.includes('982'), 'must reference #982');
assert.ok(issueRefs.includes('983'), 'must reference #983');
assert.ok(issueRefs.includes('985'), 'must reference #985');

console.log(JSON.stringify({
  ok: true,
  fixtureId: fixture.fixtureId,
  scenarios: fixture.scenarios.length,
  evidenceClasses: fixture.evidenceClasses.length,
  staleClaimThresholdMs: fixture.staleClaimThresholdMs,
}));
