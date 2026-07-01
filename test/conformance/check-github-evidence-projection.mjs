import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const fixturePath = path.join(root, 'fixtures', 'contract', 'github-evidence-projection.json');
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
    `github evidence projection fixture matched forbidden pattern ${pattern}`,
  );
}

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

// --- v0Freeze marker ---
assert.ok(fixture.v0Freeze, 'github evidence projection fixture must carry v0Freeze marker');
assert.ok(fixture.v0Freeze.frozenAt, 'v0Freeze must include frozenAt');
assert.equal(
  fixture.v0Freeze.round,
  'a2a-terminal-brief-github-evidence-20260511T000448Z',
);
assert.equal(fixture.contract, 'contracts/a2a/github-evidence-projection.md');
assert.equal(fixture.parentIssue, 'a2a-plane#204 (internal tracker, private)');
assert.equal(fixture.issue, 'a2a-plane#205 (internal tracker, private)');
assert.equal(fixture.team, 'team1-bangtong');
assert.equal(fixture.brokerOfRecord, 'gwakga');

// --- Evidence comment kinds ---
assert.deepEqual(
  fixture.evidenceCommentKinds.sort(),
  ['block', 'done', 'pr', 'start'],
);

// --- Non-ACK signals ---
assert.ok(fixture.nonAckSignals.includes('githubCommentUrl'));
assert.ok(fixture.nonAckSignals.includes('githubCommentId'));
assert.ok(fixture.nonAckSignals.includes('commentPosted'));
assert.ok(fixture.nonAckSignals.includes('commentVisible'));

// --- ACK-safe receipt types must NOT include githubCommentUrl ---
const ackSafeReceiptTypes = fixture.ackSafeReceiptTypes;
assert.deepEqual(ackSafeReceiptTypes.sort(), [
  'current_session_visible',
  'manual_operator_receipt',
]);
assert.ok(
  !ackSafeReceiptTypes.includes('githubCommentUrl'),
  'githubCommentUrl must not be in ackSafeReceiptTypes',
);

// --- Manifest binding rules ---
const mb = fixture.manifestBinding;
assert.ok(mb.keyFormat, 'manifestBinding must define keyFormat');
assert.ok(mb.rules.includes('first-write-wins for each evidence key'));
assert.ok(mb.rules.includes('duplicate post returns existing comment URL, no new comment created'));
assert.ok(mb.rules.includes('conflict on same key with different logical payload'));
assert.ok(mb.rules.includes('replay returns existing evidence URLs without posting'));

// --- Scenario validation ---
const scenarios = new Map(fixture.scenarios.map((s) => [s.name, s]));

const requiredScenarioNames = [
  'start-comment-is-evidence-ledger-not-ack',
  'pr-comment-is-evidence-not-approval',
  'duplicate-evidence-key-returns-existing-comment',
  'same-key-different-payload-conflicts',
  'replay-terminal-task-returns-existing-evidence-without-posting',
  'block-comment-is-evidence-not-terminal-ack',
  'github-comment-url-is-explicitly-non-ack-and-non-approval',
];

for (const name of requiredScenarioNames) {
  assert.ok(scenarios.has(name), `missing required scenario: ${name}`);
}

// Every scenario: terminalOutboxAckMutated must be false
for (const [name, scenario] of scenarios) {
  walk(scenario.then, (value, trail) => {
    if (trail.at(-1) === 'terminalOutboxAckMutated') {
      assert.equal(value, false, `scenario ${name}: terminalOutboxAckMutated must be false`);
    }
    if (trail.at(-1) === 'liveProviderSend') {
      assert.equal(value, false, `scenario ${name}: liveProviderSend must be false`);
    }
  });
}

// Start scenario
const startScenario = scenarios.get('start-comment-is-evidence-ledger-not-ack');
assert.equal(startScenario.then.evidenceKind, 'start');
assert.equal(startScenario.then.commentPosted, true);
assert.equal(startScenario.then.redacted, true);
assert.equal(startScenario.then.isApproval, false);
assert.equal(startScenario.then.isTerminalAck, false);
assert.equal(startScenario.then.isReadReceipt, false);
assert.equal(startScenario.then.evidenceClass, 'accepted-send');
assert.ok(
  startScenario.then.reasonCodes.includes('github-comment-is-evidence-ledger-not-ack'),
);
assert.ok(
  startScenario.then.reasonCodes.includes('manual-or-visible-receipt-required'),
);

// PR scenario
const prScenario = scenarios.get('pr-comment-is-evidence-not-approval');
assert.equal(prScenario.then.evidenceKind, 'pr');
assert.equal(prScenario.then.isApproval, false);
assert.equal(prScenario.then.commentPosted, true);
assert.ok(
  prScenario.then.reasonCodes.includes('pr-comment-is-not-operator-approval'),
);

// Duplicate scenario
const dupScenario = scenarios.get('duplicate-evidence-key-returns-existing-comment');
assert.equal(dupScenario.then.status, 'deduplicated');
assert.equal(dupScenario.then.newCommentPosted, false);
assert.ok(dupScenario.then.returnedExistingCommentUrl);

// Conflict scenario
const conflictScenario = scenarios.get('same-key-different-payload-conflicts');
assert.equal(conflictScenario.then.status, 'conflict');
assert.equal(conflictScenario.then.newCommentPosted, false);
assert.ok(
  conflictScenario.then.reasonCodes.includes('refuse-overwrite-existing-evidence'),
);

// Replay scenario
const replayScenario = scenarios.get(
  'replay-terminal-task-returns-existing-evidence-without-posting',
);
assert.equal(replayScenario.then.newCommentsPosted, 0);
assert.equal(replayScenario.then.returnedExistingEvidence, true);
assert.ok(
  replayScenario.then.reasonCodes.includes('replay-suppression'),
);
assert.ok(
  replayScenario.then.reasonCodes.includes('no-new-side-effects'),
);

// Block scenario
const blockScenario = scenarios.get('block-comment-is-evidence-not-terminal-ack');
assert.equal(blockScenario.then.evidenceKind, 'block');
assert.equal(blockScenario.then.isTerminalAck, false);
assert.equal(blockScenario.then.blockerCategory, 'safety');

// Non-ACK/approval boundary scenario
const boundaryScenario = scenarios.get(
  'github-comment-url-is-explicitly-non-ack-and-non-approval',
);
assert.equal(boundaryScenario.then.isApproval, false);
assert.equal(boundaryScenario.then.isTerminalAck, false);
assert.equal(boundaryScenario.then.isReadReceipt, false);
assert.equal(boundaryScenario.then.mayBeUsedAsApproval, false);
assert.equal(boundaryScenario.then.mayBeUsedAsTerminalAck, false);
assert.equal(boundaryScenario.then.mayBeUsedAsReadReceipt, false);
assert.ok(
  boundaryScenario.then.reasonCodes.includes('github-comment-not-in-ackSafeReceiptTypes'),
);
assert.ok(
  boundaryScenario.then.reasonCodes.includes('approval-must-be-explicit-separate-channel'),
);

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
  'noCommunityPost',
  'noAutomaticMergeOrApproval',
  'noRepositoryVisibilityChange',
  'redacted',
  'syntheticFixtureOnly',
];

for (const key of requiredSafetyKeys) {
  assert.equal(
    fixture.safetyConfirmations[key],
    true,
    `safety confirmation ${key} must be true`,
  );
}

// --- Assertions ---
assert.ok(Array.isArray(fixture.assertions) && fixture.assertions.length >= 8);
const assertionsSet = new Set(fixture.assertions);
assert.ok(
  assertionsSet.has('start, pr, done, and block are the only evidence comment kinds'),
);
assert.ok(
  assertionsSet.has(
    'every evidence comment carries isApproval: false, isTerminalAck: false, isReadReceipt: false',
  ),
);
assert.ok(
  assertionsSet.has('githubCommentUrl is not in ackSafeReceiptTypes'),
);
assert.ok(
  assertionsSet.has('no scenario promotes githubCommentUrl to terminal ACK or approval'),
);
assert.ok(
  assertionsSet.has('all comment bodies are redacted (no secrets, private paths, session dumps)'),
);

// --- Deep walk: isApproval, isTerminalAck never true anywhere in fixture ---
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

walk(fixture, (value, trail) => {
  if (trail.at(-1) === 'isApproval' && typeof value === 'boolean') {
    assert.equal(value, false, `isApproval must be false at ${trail.join('.')}`);
  }
  if (trail.at(-1) === 'isTerminalAck' && typeof value === 'boolean') {
    assert.equal(value, false, `isTerminalAck must be false at ${trail.join('.')}`);
  }
  if (trail.at(-1) === 'isReadReceipt' && typeof value === 'boolean') {
    assert.equal(value, false, `isReadReceipt must be false at ${trail.join('.')}`);
  }
  if (trail.at(-1) === 'mayBeUsedAsApproval' && typeof value === 'boolean') {
    assert.equal(value, false, `mayBeUsedAsApproval must be false at ${trail.join('.')}`);
  }
  if (trail.at(-1) === 'mayBeUsedAsTerminalAck' && typeof value === 'boolean') {
    assert.equal(value, false, `mayBeUsedAsTerminalAck must be false at ${trail.join('.')}`);
  }
  if (trail.at(-1) === 'mayBeUsedAsReadReceipt' && typeof value === 'boolean') {
    assert.equal(value, false, `mayBeUsedAsReadReceipt must be false at ${trail.join('.')}`);
  }
});

console.log(
  JSON.stringify({
    ok: true,
    checkedFixture: 'fixtures/contract/github-evidence-projection.json',
    scenarioCount: fixture.scenarios.length,
    evidenceCommentKinds: fixture.evidenceCommentKinds,
  }),
);
