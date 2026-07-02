import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const fixtureDir = path.join(root, 'fixtures', 'contract');

const fixtureFiles = {
  lifecycle: 'task-lifecycle.json',
  workers: 'worker-registration-capabilities.json',
  cancellation: 'cancellation-idempotency.json',
  evidence: 'terminal-evidence.json',
  githubEvidenceProjection: 'github-evidence-projection.json',
  crossBroker: 'broker-beta-cross-broker-handoff.json',
  parentTerminalBriefAggregation: 'parent-terminal-brief-aggregation.json',
  terminalBriefParentOriginRouting: 'terminal-brief-parent-origin-routing.json',
  checkpointInterrupt: 'checkpoint-interrupt.json',
  publicPolicy: 'public-compatibility-policy.json',
  replayTrace: 'second-worker-replay-trace.json',
  liveCanaryApprovalBoundary: 'live-canary-replay-approval-boundary.json',
  stabilityGate: 'r20-stability-gate.json',
  workerCapabilityProfile: 'worker-capability-profile.json',
  embeddedExecutionStability: 'embedded-execution-stability-policy.json',
  adapterReceiptCapability: 'adapter-receipt-capability.json',
  harnessNeutralAnalysisAdapter: 'harness-neutral-analysis-adapter.json',
  terminalEvidenceStateMachine: 'terminal-evidence-state-machine.json',
};

const forbiddenRuntimePaths = [
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  '.openclaw/',
];

const secretLikePatterns = [
  /ghp_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]+/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\/Users\/[A-Za-z0-9._-]+\//,
];

function readFixture(fileName) {
  const fullPath = path.join(fixtureDir, fileName);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

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

const fixtures = Object.fromEntries(
  Object.entries(fixtureFiles).map(([name, file]) => [name, readFixture(file)]),
);
const allFixtureText = Object.values(fixtureFiles)
  .map((file) => fs.readFileSync(path.join(fixtureDir, file), 'utf8'))
  .join('\n');

for (const forbiddenPath of forbiddenRuntimePaths) {
  assert.ok(
    !allFixtureText.includes(forbiddenPath),
    `fixture text must not reference OpenClaw runtime/bootstrap path ${forbiddenPath}`,
  );
}
for (const pattern of secretLikePatterns) {
  assert.ok(!pattern.test(allFixtureText), `fixture text matched forbidden pattern ${pattern}`);
}

const {
  lifecycle,
  workers,
  cancellation,
  evidence,
  githubEvidenceProjection,
  crossBroker,
  parentTerminalBriefAggregation,
  terminalBriefParentOriginRouting,
  checkpointInterrupt,
  publicPolicy,
  replayTrace,
  liveCanaryApprovalBoundary,
  stabilityGate,
  workerCapabilityProfile,
  embeddedExecutionStability,
  adapterReceiptCapability,
  harnessNeutralAnalysisAdapter,
  terminalEvidenceStateMachine,
} = fixtures;

assert.deepEqual(lifecycle.terminalStates.sort(), ['blocked', 'cancelled', 'done', 'pr']);
for (const state of lifecycle.terminalStates) {
  assert.deepEqual(lifecycle.allowedTransitions[state], [], `${state} must be terminal`);
}
for (const event of lifecycle.events) {
  assert.ok(lifecycle.states.includes(event.state), `unknown lifecycle state ${event.state}`);
  if (event.from) {
    assert.ok(
      lifecycle.allowedTransitions[event.from]?.includes(event.state),
      `transition ${event.from} -> ${event.state} is not allowed`,
    );
  }
}
assert.equal(lifecycle.task.brokerOfRecord, 'broker-beta');
assert.ok(lifecycle.events.some((event) => event.state === 'pr' && event.evidenceRef === 'terminal-pr-evidence'));

// Contract v0: cancellation states must not be terminal (cancelling) and terminal (cancelled)
assert.ok(lifecycle.states.includes('cancelling'), 'cancelling must be in states');
assert.ok(lifecycle.states.includes('cancelled'), 'cancelled must be in states');
assert.ok(!lifecycle.terminalStates.includes('cancelling'), 'cancelling must not be terminal');
assert.ok(lifecycle.terminalStates.includes('cancelled'), 'cancelled must be terminal');

// Cancellation transitions
assert.deepEqual(lifecycle.allowedTransitions.queued.sort(), ['blocked', 'cancelled', 'claimed']);
assert.deepEqual(lifecycle.allowedTransitions.claimed.sort(), ['blocked', 'cancelled', 'running']);
assert.ok(lifecycle.allowedTransitions.running.includes('cancelling'), 'running must allow cancelling');
assert.deepEqual(lifecycle.allowedTransitions.cancelling, ['cancelled']);
assert.deepEqual(lifecycle.allowedTransitions.cancelled, []);

// Cancellation event trace
assert.ok(Array.isArray(lifecycle.cancellationEvents) && lifecycle.cancellationEvents.length >= 2);
const cancelEvents = lifecycle.cancellationEvents;
assert.equal(cancelEvents[0].state, 'queued');
assert.equal(cancelEvents[1].type, 'task.cancel-requested');
assert.equal(cancelEvents[1].from, 'queued');
assert.equal(cancelEvents[1].state, 'cancelled');
assert.equal(cancelEvents[1].source, 'operator');

// All fixtures must carry v0Freeze markers
for (const [name, fixture] of Object.entries(fixtures)) {
  assert.ok(fixture.v0Freeze, `${name} fixture must carry v0Freeze marker`);
  assert.ok(fixture.v0Freeze.frozenAt, `${name} v0Freeze must include frozenAt`);
  assert.ok(fixture.v0Freeze.round, `${name} v0Freeze must include round`);
}

// v0 assertions include cancellation semantics
const v0Assertions = new Set(lifecycle.assertions);
assert.ok(v0Assertions.has('cancelling is a non-terminal transitory state; only cancelled is terminal'));
assert.ok(v0Assertions.has('cancellation from queued or claimed goes directly to cancelled (no cancelling intermediary)'));
assert.ok(v0Assertions.has('all terminal states (done, pr, blocked, cancelled) have empty allowedTransitions'));


// Terminal Evidence State Machine (#965)
const terminalEvidenceStateNames = new Set(terminalEvidenceStateMachine.states.map((state) => state.name));
assert.deepEqual(
  [...terminalEvidenceStateNames].sort(),
  ['accepted', 'acknowledged', 'blocked', 'claimed', 'done', 'failed', 'operator_visible', 'provider_accepted', 'started'],
);
assert.equal(terminalEvidenceStateMachine.contract, 'contracts/a2a/terminal-evidence.schema.json');
assert.equal(terminalEvidenceStateMachine.docs, 'docs/specs/terminal-evidence-state-machine.md');
assert.ok(Array.isArray(terminalEvidenceStateMachine.examples), 'state machine must include examples');
assert.deepEqual(
  terminalEvidenceStateMachine.examples.map((example) => example.kind).sort(),
  ['acknowledged', 'blocked', 'done', 'operator_visible', 'pr', 'provider_accepted'],
);
for (const state of terminalEvidenceStateMachine.states) {
  assert.ok(Array.isArray(state.allowedNext), `${state.name} must declare allowedNext`);
  assert.ok(Array.isArray(state.requiredEvidence), `${state.name} must declare requiredEvidence`);
  for (const previous of state.allowedPrevious) {
    assert.ok(terminalEvidenceStateNames.has(previous), `${state.name} references unknown previous state ${previous}`);
  }
  for (const next of state.allowedNext) {
    assert.ok(terminalEvidenceStateNames.has(next), `${state.name} references unknown next state ${next}`);
  }
}
const stateByName = new Map(terminalEvidenceStateMachine.states.map((state) => [state.name, state]));
assert.equal(stateByName.get('provider_accepted').terminalForCloseout, false);
assert.equal(stateByName.get('provider_accepted').operatorVisible, false);
assert.equal(stateByName.get('operator_visible').terminalForCloseout, false);
assert.equal(stateByName.get('operator_visible').operatorVisible, true);
assert.equal(stateByName.get('acknowledged').terminalForCloseout, true);
assert.equal(stateByName.get('acknowledged').owner, 'operator');
assert.equal(terminalEvidenceStateMachine.finalizer.ownerField, 'finalizerOwner');
assert.equal(terminalEvidenceStateMachine.finalizer.ackOwner, 'operator');
assert.equal(terminalEvidenceStateMachine.safety.providerAcceptedIsTerminalAck, false);
assert.equal(terminalEvidenceStateMachine.safety.providerAcceptedCountsForCloseout, false);
assert.equal(terminalEvidenceStateMachine.safety.operatorVisibleCountsAsTerminalAck, false);
assert.equal(terminalEvidenceStateMachine.safety.acknowledgedRequiresOperatorEvidence, true);

const workerNamePattern = /^[a-z0-9][a-z0-9-]{2,63}$/;
for (const worker of workers.workers) {
  assert.match(worker.workerName, workerNamePattern, `unsafe workerName ${worker.workerName}`);
  assert.ok(Array.isArray(worker.capabilities) && worker.capabilities.length > 0);
  for (const capability of worker.capabilities) {
    assert.match(capability, /^[a-z0-9][a-z0-9-]{1,40}$/);
  }
  assert.equal(worker.policyVersion, 'a2a-nexus-safety-v1');
  for (const forbiddenField of workers.forbiddenFields) {
    assert.ok(!(forbiddenField in worker), `worker must not include ${forbiddenField}`);
  }
}
assert.equal(workers.readModelExpectations.providerSendIsNotTerminalEvidence, true);
assert.equal(workers.readModelExpectations.secondWorkerProofIsPublicSafe, true);
assert.equal(workers.readModelExpectations.secondReferenceReplayProofIsPublicSafe, true);

const workerNames = new Set(workers.workers.map((worker) => worker.workerName));
const secondWorkerProof = workers.compatibilityProofs?.find(
  (proof) => proof.proofId === 'second-worker-compatibility-worker-zeta-20260510',
);
assert.ok(secondWorkerProof, 'expected worker-zeta second-worker compatibility proof');
assert.equal(secondWorkerProof.issue, 'a2a-plane#152 (internal tracker, private)');
assert.equal(secondWorkerProof.round, 'a2a-vnext-contract-smoke-crossbroker-20260510');
assert.equal(secondWorkerProof.brokerOfRecord, 'broker-beta');
assert.ok(workerNames.has(secondWorkerProof.workerName), 'second-worker proof must reference a registered worker');
assert.equal(secondWorkerProof.validationCommand, 'node test/conformance/check-contract-fixtures.mjs');
assert.equal(secondWorkerProof.requiresPrivateTopology, false);
assert.equal(secondWorkerProof.liveProviderSend, false);
assert.equal(secondWorkerProof.terminalAckMutation, false);

const soonwookReplayProof = workers.compatibilityProofs?.find(
  (proof) => proof.proofId === 'second-worker-replay-trace-worker-eta-20260509',
);
assert.ok(soonwookReplayProof, 'expected worker-eta second-reference replay proof');
assert.equal(soonwookReplayProof.issue, 'a2a-plane#168 (internal tracker, private)');
assert.equal(soonwookReplayProof.parentIssue, 'a2a-plane#163 (internal tracker, private)');
assert.equal(soonwookReplayProof.run, 'a2a-public-readiness-next-20260509T165108Z');
assert.equal(soonwookReplayProof.brokerOfRecord, 'broker-beta');
assert.ok(workerNames.has(soonwookReplayProof.workerName), 'replay proof must reference a registered worker');
assert.equal(soonwookReplayProof.validationCommand, 'node test/conformance/check-contract-fixtures.mjs');
assert.equal(soonwookReplayProof.requiresPrivateTopology, false);
assert.equal(soonwookReplayProof.liveProviderSend, false);
assert.equal(soonwookReplayProof.terminalAckMutation, false);

const scenarioByName = new Map(cancellation.scenarios.map((scenario) => [scenario.name, scenario]));
assert.equal(scenarioByName.get('duplicate-create-returns-existing-task')?.then.newTaskCreated, false);
assert.equal(scenarioByName.get('duplicate-create-returns-existing-task')?.then.status, 'deduplicated');
assert.equal(scenarioByName.get('same-key-different-envelope-conflicts')?.then.status, 'conflict');
assert.equal(scenarioByName.get('cancel-before-running-blocks-task')?.then.state, 'blocked');
assert.equal(scenarioByName.get('cancel-before-running-blocks-task')?.then.terminal, true);
assert.equal(scenarioByName.get('cancel-after-terminal-is-idempotent-noop')?.then.changed, false);
assert.equal(scenarioByName.get('cancel-after-terminal-is-idempotent-noop')?.then.state, 'pr');

const evidenceKinds = new Set(evidence.evidence.map((item) => item.kind));
assert.deepEqual([...evidenceKinds].sort(), ['blocked', 'done', 'pr']);
for (const item of evidence.evidence) {
  assert.equal(item.redacted, true, `${item.evidenceId} must be redacted`);
  assert.equal(item.terminalOutboxAckMutated, false, `${item.evidenceId} must not mutate terminal ACK`);
  assert.equal(item.liveProviderSend, false, `${item.evidenceId} must not require live provider send`);
}
for (const [key, value] of Object.entries(evidence.safetyConfirmations)) {
  assert.equal(value, true, `safety confirmation ${key} must be true`);
}

// GitHub evidence projection validation
assert.ok(evidence.githubEvidenceProjection, 'terminal-evidence fixture must reference githubEvidenceProjection');
assert.equal(
  evidence.githubEvidenceProjection.contract,
  'contracts/a2a/github-evidence-projection.md',
);
assert.equal(
  evidence.githubEvidenceProjection.fixture,
  'fixtures/contract/github-evidence-projection.json',
);

const gep = githubEvidenceProjection;
assert.equal(gep.contract, 'contracts/a2a/github-evidence-projection.md');
assert.equal(gep.parentIssue, 'a2a-plane#204 (internal tracker, private)');
assert.equal(gep.issue, 'a2a-plane#205 (internal tracker, private)');
assert.equal(gep.team, 'team1-worker-gamma');
assert.equal(gep.brokerOfRecord, 'broker-beta');
assert.deepEqual(gep.evidenceCommentKinds.sort(), ['block', 'done', 'pr', 'start']);
assert.ok(gep.nonAckSignals.includes('githubCommentUrl'));
assert.ok(gep.nonAckSignals.includes('githubCommentId'));
assert.ok(gep.nonAckSignals.includes('commentPosted'));
assert.ok(gep.nonAckSignals.includes('commentVisible'));
assert.deepEqual(gep.ackSafeReceiptTypes.sort(), ['current_session_visible', 'manual_operator_receipt']);
assert.ok(!gep.ackSafeReceiptTypes.includes('githubCommentUrl'), 'githubCommentUrl must not be ACK-safe');

const gepScenarios = new Map(gep.scenarios.map((s) => [s.name, s]));
const dupScenario = gepScenarios.get('duplicate-evidence-key-returns-existing-comment');
assert.equal(dupScenario.then.status, 'deduplicated');
assert.equal(dupScenario.then.newCommentPosted, false);
const conflictScenario = gepScenarios.get('same-key-different-payload-conflicts');
assert.equal(conflictScenario.then.status, 'conflict');
const replayScenario = gepScenarios.get('replay-terminal-task-returns-existing-evidence-without-posting');
assert.equal(replayScenario.then.newCommentsPosted, 0);
assert.equal(replayScenario.then.returnedExistingEvidence, true);

// Every gep scenario: isApproval/isTerminalAck/isReadReceipt must be false where present
walk(gep, (value, trail) => {
  if (trail.at(-1) === 'isApproval' && typeof value === 'boolean') {
    assert.equal(value, false, `gep isApproval must be false at ${trail.join('.')}`);
  }
  if (trail.at(-1) === 'isTerminalAck' && typeof value === 'boolean') {
    assert.equal(value, false, 'gep isTerminalAck must be false');
  }
  if (trail.at(-1) === 'isReadReceipt' && typeof value === 'boolean') {
    assert.equal(value, false, 'gep isReadReceipt must be false');
  }
  if (trail.at(-1) === 'mayBeUsedAsApproval' && typeof value === 'boolean') {
    assert.equal(value, false, 'gep mayBeUsedAsApproval must be false');
  }
});

for (const [key, value] of Object.entries(gep.safetyConfirmations)) {
  assert.equal(value, true, `gep safety confirmation ${key} must be true`);
}

assert.equal(crossBroker.contract, 'contracts/a2a/broker-handoff-protocol.md');
assert.equal(crossBroker.round, 'a2a-vnext-contract-smoke-crossbroker-20260510');
assert.equal(crossBroker.team, 'team2');
assert.equal(crossBroker.worker, 'worker-epsilon');
assert.equal(crossBroker.sourceBrokerId, 'broker-alpha');
assert.equal(crossBroker.destinationBrokerId, 'broker-beta');
assert.equal(crossBroker.brokerOfRecord, 'broker-beta');
assert.equal(crossBroker.handoffEnvelope.brokerOfRecord, 'broker-beta');
assert.equal(crossBroker.handoffEnvelope.destinationBrokerId, 'broker-beta');
assert.equal(crossBroker.policyInvariants.sourceBrokerDoesNotDispatchDestinationWorkers, true);
assert.equal(crossBroker.policyInvariants.destinationBrokerOwnsWorkerAssignment, true);
assert.equal(crossBroker.policyInvariants.providerSendIsAcceptedSendOnly, true);

const crossBrokerScenarioByName = new Map(
  crossBroker.scenarios.map((scenario) => [scenario.name, scenario]),
);
const acceptedHandoff = crossBrokerScenarioByName.get('broker-beta-accepts-handoff-and-assigns-team2-worker');
assert.equal(acceptedHandoff?.then.state, 'accepted');
assert.equal(acceptedHandoff?.then.brokerOfRecord, 'broker-beta');
assert.equal(acceptedHandoff?.then.workerPool, 'team2');
assert.equal(acceptedHandoff?.then.assignedByBroker, 'broker-beta');
assert.equal(acceptedHandoff?.then.sourceBrokerDispatchedWorker, false);
assert.equal(acceptedHandoff?.then.terminalOutboxAckMutated, false);
assert.equal(acceptedHandoff?.then.liveProviderSend, false);

const duplicateHandoff = crossBrokerScenarioByName.get('duplicate-handoff-returns-existing-broker-beta-task');
assert.equal(duplicateHandoff?.then.status, 'deduplicated');
assert.equal(duplicateHandoff?.then.newTaskCreated, false);
assert.equal(duplicateHandoff?.then.brokerOfRecord, 'broker-beta');

const refusedHandoff = crossBrokerScenarioByName.get('missing-create-scope-refuses-before-task-creation');
assert.equal(refusedHandoff?.then.status, 'refused');
assert.equal(refusedHandoff?.then.destinationTaskCreated, false);
assert.equal(refusedHandoff?.then.workerDispatched, false);

const evidenceRelay = crossBrokerScenarioByName.get('terminal-evidence-relay-is-redacted-metadata-only');
assert.equal(evidenceRelay?.given.terminalEvidence.redacted, true);
assert.equal(evidenceRelay?.then.evidenceRelayed, true);
assert.equal(evidenceRelay?.then.providerSendEvidenceClass, 'accepted-send');
assert.equal(evidenceRelay?.then.terminalAckMayBeRecorded, false);
assert.equal(evidenceRelay?.then.terminalOutboxAckMutated, false);
assert.equal(evidenceRelay?.then.liveProviderSend, false);

assert.ok(
  crossBroker.noLiveFixtureCommands.includes('node test/conformance/check-contract-fixtures.mjs'),
);
assert.ok(crossBroker.visibilityGaps.length >= 1);
for (const [key, value] of Object.entries(crossBroker.safetyConfirmations)) {
  assert.equal(value, true, `cross-broker safety confirmation ${key} must be true`);
}


// Parent Terminal Brief aggregation validation
assert.equal(
  parentTerminalBriefAggregation.contract,
  'contracts/a2a/parent-terminal-brief-aggregation.md',
);
assert.equal(parentTerminalBriefAggregation.parentIssue, 'a2a-plane#269 (internal tracker, private)');
assert.equal(parentTerminalBriefAggregation.originBrokerId, 'broker-beta');
assert.equal(parentTerminalBriefAggregation.parentBrokerId, 'broker-beta');
assert.equal(parentTerminalBriefAggregation.handoffBrokerId, 'broker-alpha');
assert.equal(parentTerminalBriefAggregation.childBrokerId, 'broker-alpha');
assert.equal(parentTerminalBriefAggregation.brokerOfRecord, 'broker-alpha');
assert.equal(parentTerminalBriefAggregation.canaryMode, 'no-live-synthetic-projection');
assert.equal(parentTerminalBriefAggregation.terminalBriefTitlePolicy.scope, 'parent-broker-only');
assert.equal(parentTerminalBriefAggregation.terminalBriefTitlePolicy.rendererBrokerId, parentTerminalBriefAggregation.parentBrokerId);
assert.equal(parentTerminalBriefAggregation.terminalBriefTitlePolicy.exampleTitle, 'A2A Terminal Brief 완료: worker-epsilon(1/7)');
assert.equal(parentTerminalBriefAggregation.terminalBriefTitlePolicy.knownTotalExampleTitle, 'A2A Terminal Brief 완료: worker-epsilon(1/7)');
assert.equal(parentTerminalBriefAggregation.terminalBriefTitlePolicy.unknownTotalExampleTitle, 'A2A Terminal Brief 완료: worker-delta(2)');
assert.equal(parentTerminalBriefAggregation.terminalBriefTitlePolicy.unknownTotalDenominatorForbidden, true);
assert.equal(parentTerminalBriefAggregation.terminalBriefTitlePolicy.parentBrokerOnly, true);
assert.equal(parentTerminalBriefAggregation.terminalBriefTitlePolicy.liveProviderSend, false);
assert.equal(parentTerminalBriefAggregation.terminalBriefTitlePolicy.terminalOutboxAckMutated, false);
assert.equal(parentTerminalBriefAggregation.terminalBriefTitlePolicy.isApproval, false);
assert.equal(parentTerminalBriefAggregation.terminalBriefTitlePolicy.isTerminalAck, false);
assert.equal(parentTerminalBriefAggregation.terminalBriefTitlePolicy.isReadReceipt, false);
assert.ok(parentTerminalBriefAggregation.terminalBriefTitlePolicy.forbiddenTitleFields.includes('runtimeBootstrapPath'));
assert.deepEqual(parentTerminalBriefAggregation.terminalBriefTitlePolicy.coveredOriginBrokerIds, ['broker-beta', 'broker-alpha']);
assert.equal(parentTerminalBriefAggregation.terminalBriefTitlePolicy.symmetricMode, true);
assert.equal(parentTerminalBriefAggregation.terminalBriefTitlePolicy.parentBrokerMayDifferFromOrigin, true);
assert.ok(parentTerminalBriefAggregation.v1Symmetric, 'v1Symmetric section must exist');
assert.equal(parentTerminalBriefAggregation.v1Symmetric.parentBrokerMayDifferFromOrigin, true);
assert.ok(
  parentTerminalBriefAggregation.v1Symmetric.coveredSymmetricPairs.some(
    (pair) => pair[0] === 'broker-alpha' && pair[1] === 'broker-beta',
  ),
  'v1Symmetric must cover broker-alpha→broker-beta pair',
);

const parentProjection = parentTerminalBriefAggregation.projection;
for (const field of parentTerminalBriefAggregation.requiredProjectionFields) {
  assert.ok(field in parentProjection, `parent projection must include ${field}`);
}
assert.equal(parentProjection.parentRoundId, parentTerminalBriefAggregation.parentRoundId);
assert.equal(parentProjection.originBrokerId, 'broker-beta');
assert.equal(parentProjection.parentBrokerId, 'broker-beta');
assert.equal(parentProjection.handoffBrokerId, 'broker-alpha');
assert.equal(parentProjection.childBrokerId, 'broker-alpha');
assert.equal(parentProjection.terminalKind, 'pr');
assert.equal(parentProjection.projectionState, 'projected');
assert.equal(parentProjection.redacted, true);
assert.equal(parentProjection.terminalOutboxAckMutated, false);
assert.equal(parentProjection.liveProviderSend, false);
assert.equal(parentProjection.isApproval, false);
assert.equal(parentProjection.isTerminalAck, false);
assert.equal(parentProjection.isReadReceipt, false);
assert.equal(parentProjection.terminalBriefTitle, 'A2A Terminal Brief 완료: worker-epsilon(1/7)');
assert.equal(parentProjection.terminalBriefTitleOwnerBrokerId, parentTerminalBriefAggregation.parentBrokerId);
assert.equal(parentProjection.terminalBriefTitleRenderedByParentBrokerOnly, true);
assert.equal(parentProjection.workerId, 'worker-epsilon');
assert.deepEqual(parentProjection.roundProgress, { completed: 1, total: 7, totalKnown: true });
assert.ok(parentProjection.terminalBriefTitle.length <= parentTerminalBriefAggregation.terminalBriefTitlePolicy.maxChars);
assert.match(
  parentProjection.terminalBriefTitle,
  /^A2A Terminal Brief (완료|실패|차단|PR): [a-z0-9_-]+\(\d+\/\d+\)$/,
);
for (const forbidden of [
  parentProjection.childTaskId,
  parentProjection.childIssueUrl,
  parentProjection.terminalEvidenceUrl,
  parentProjection.terminalSummary,
  parentProjection.childBrokerId,
  parentProjection.handoffBrokerId,
]) {
  assert.ok(
    !parentProjection.terminalBriefTitle.includes(forbidden),
    `parent title must not include verbose/sensitive projection field ${forbidden}`,
  );
}

const parentTitleExamplesByOrigin = new Map();
const symmetricExamplesSeen = [];
for (const example of parentTerminalBriefAggregation.parentRoundTitleExamples) {
  if (example.originDiffersFromParent) {
    symmetricExamplesSeen.push(example);
  } else {
    const existing = parentTitleExamplesByOrigin.get(example.originBrokerId);
    if (!existing) parentTitleExamplesByOrigin.set(example.originBrokerId, example);
  }
}
assert.deepEqual([...parentTitleExamplesByOrigin.keys()].sort(), ['broker-alpha', 'broker-beta']);
assert.ok(symmetricExamplesSeen.length >= 1, 'at least one symmetric origin-broker title example is required');
for (const example of parentTerminalBriefAggregation.parentRoundTitleExamples) {
  if (!example.originDiffersFromParent) {
    assert.equal(example.parentBrokerId, example.originBrokerId);
  } else {
    assert.notEqual(example.parentBrokerId, example.originBrokerId,
      `${example.name}: symmetric example must have different parentBrokerId and originBrokerId`);
  }
  assert.equal(example.rendererBrokerId, example.parentBrokerId);
  assert.equal(example.parentBrokerOnly, true);
  assert.equal(example.liveProviderSend, false);
  assert.equal(example.terminalOutboxAckMutated, false);
  assert.equal(example.isApproval, false);
  assert.equal(example.isTerminalAck, false);
  assert.equal(example.isReadReceipt, false);
  assert.equal(example.unknownTotalDenominatorRendered, false);
  assert.ok(example.terminalBriefTitle.length <= parentTerminalBriefAggregation.terminalBriefTitlePolicy.maxChars);
  assert.ok(
    !/\(\d+\/\?\)/.test(example.terminalBriefTitle),
    `${example.name} must not render an unknown denominator as ?`,
  );
  assert.ok(!example.terminalBriefTitle.includes(example.childBrokerId));
  assert.ok(!example.terminalBriefTitle.includes(example.handoffBrokerId));
  if (example.roundProgress.totalKnown) {
    assert.match(
      example.terminalBriefTitle,
      /^A2A Terminal Brief (완료|실패|차단|PR): [a-z0-9_-]+\(\d+\/\d+\)$/,
    );
  } else {
    assert.equal(example.roundProgress.total, null);
    assert.match(
      example.terminalBriefTitle,
      /^A2A Terminal Brief (완료|실패|차단|PR): [a-z0-9_-]+\(\d+\)$/,
    );
  }
}
assert.equal(
  parentTitleExamplesByOrigin.get('broker-alpha')?.terminalBriefTitle,
  parentTerminalBriefAggregation.terminalBriefTitlePolicy.unknownTotalExampleTitle,
);
assert.equal(parentTitleExamplesByOrigin.get('broker-alpha')?.forbiddenUnknownDenominator, '(2/?)');

const parentLifecycleSteps = new Map(
  parentTerminalBriefAggregation.metadataLifecycle.map((step) => [step.step, step]),
);
assert.equal(parentLifecycleSteps.get('mint-parent-round')?.ownerBrokerId, 'broker-beta');
assert.equal(parentLifecycleSteps.get('mint-parent-round')?.immutableAfterWrite, true);
assert.equal(parentLifecycleSteps.get('handoff-envelope-created')?.destinationBrokerId, 'broker-alpha');
assert.equal(parentLifecycleSteps.get('child-task-terminal-evidence')?.parentMetadataRewritten, false);
assert.equal(parentLifecycleSteps.get('parent-projection-recorded')?.childLifecycleMutated, false);

const parentAggregationScenarioByName = new Map(
  parentTerminalBriefAggregation.scenarios.map((scenario) => [scenario.name, scenario]),
);
const metadataScenario = parentAggregationScenarioByName.get(
  'broker-beta-origin-metadata-is-carried-through-broker-alpha-handoff',
);
assert.equal(metadataScenario?.then.metadataCopiedToChildEnvelope, true);
assert.equal(metadataScenario?.then.originBrokerIdRewritten, false);
assert.equal(metadataScenario?.then.parentRoundIdRewritten, false);
assert.equal(metadataScenario?.then.childBrokerOfRecord, 'broker-alpha');

const titleScenario = parentAggregationScenarioByName.get(
  'broker-beta-origin-parent-brief-title-is-concise-parent-broker-only',
);
assert.equal(titleScenario?.then.terminalBriefTitle, 'A2A Terminal Brief 완료: worker-epsilon(1/7)');
assert.equal(titleScenario?.then.rendererBrokerId, parentTerminalBriefAggregation.parentBrokerId);
assert.equal(titleScenario?.then.parentBrokerOnly, true);
assert.equal(titleScenario?.then.titleDoesNotContainUnknownDenominator, true);
assert.equal(titleScenario?.then.forbiddenUnknownDenominator, '(1/?)');
assert.equal(titleScenario?.then.includesTaskId, false);
assert.equal(titleScenario?.then.includesChildIssueUrl, false);
assert.equal(titleScenario?.then.includesTerminalEvidenceUrl, false);
assert.equal(titleScenario?.then.includesTerminalSummary, false);
assert.equal(titleScenario?.then.includesChildBrokerId, false);
assert.equal(titleScenario?.then.includesHandoffBrokerId, false);
assert.equal(titleScenario?.then.includesReceiptOrAckState, false);
assert.equal(titleScenario?.then.liveProviderSend, false);
assert.equal(titleScenario?.then.terminalOutboxAckMutated, false);
assert.equal(titleScenario?.then.isApproval, false);
assert.equal(titleScenario?.then.isTerminalAck, false);
assert.equal(titleScenario?.then.isReadReceipt, false);

const seoseoOriginUnknownTotalTitleScenario = parentAggregationScenarioByName.get(
  'broker-alpha-origin-parent-brief-title-uses-unknown-total-fallback',
);
assert.equal(seoseoOriginUnknownTotalTitleScenario?.given.originBrokerId, 'broker-alpha');
assert.equal(seoseoOriginUnknownTotalTitleScenario?.given.parentBrokerId, 'broker-alpha');
assert.notEqual(seoseoOriginUnknownTotalTitleScenario?.given.parentBrokerId, 'broker-beta',
  'broker-alpha-origin non-symmetric scenario must have parentBrokerId equal originBrokerId');

/* R12 symmetric origin-broker scenario: broker-alpha-origin, broker-beta-parent with known total */
const symmetricOriginBrokerTitleScenario = parentAggregationScenarioByName.get(
  'symmetric-broker-alpha-origin-broker-beta-parent-title-known-total',
);
assert.ok(symmetricOriginBrokerTitleScenario, 'symmetric-broker-alpha-origin-broker-beta-parent-title-known-total scenario must exist');
assert.equal(symmetricOriginBrokerTitleScenario?.given.originBrokerId, 'broker-alpha');
assert.equal(symmetricOriginBrokerTitleScenario?.given.parentBrokerId, 'broker-beta');
assert.notEqual(symmetricOriginBrokerTitleScenario?.given.originBrokerId,
  symmetricOriginBrokerTitleScenario?.given.parentBrokerId,
  'symmetric scenario must have different originBrokerId and parentBrokerId');
assert.equal(symmetricOriginBrokerTitleScenario?.given.total, 3);
assert.equal(symmetricOriginBrokerTitleScenario?.given.totalKnown, true);
assert.equal(symmetricOriginBrokerTitleScenario?.then.terminalBriefTitle, 'A2A Terminal Brief 완료: worker-epsilon(1/3)');
assert.equal(symmetricOriginBrokerTitleScenario?.then.rendererBrokerId, 'broker-beta');
assert.equal(symmetricOriginBrokerTitleScenario?.then.parentBrokerOnly, true);
assert.equal(symmetricOriginBrokerTitleScenario?.then.originDiffersFromParent, true);
assert.equal(symmetricOriginBrokerTitleScenario?.then.originBrokerId, 'broker-alpha');
assert.equal(symmetricOriginBrokerTitleScenario?.then.liveProviderSend, false);
assert.equal(symmetricOriginBrokerTitleScenario?.then.terminalOutboxAckMutated, false);
assert.equal(symmetricOriginBrokerTitleScenario?.then.isApproval, false);
assert.equal(symmetricOriginBrokerTitleScenario?.then.isTerminalAck, false);
assert.equal(symmetricOriginBrokerTitleScenario?.then.isReadReceipt, false);
assert.ok(!symmetricOriginBrokerTitleScenario?.then.terminalBriefTitle.includes('broker-alpha'),
  'title must not include childBrokerId (broker-alpha)');
assert.ok(!symmetricOriginBrokerTitleScenario?.then.terminalBriefTitle.includes('broker-beta'),
  'title must not included handoffBrokerId (broker-beta)');
assert.equal(seoseoOriginUnknownTotalTitleScenario?.given.total, null);
assert.equal(seoseoOriginUnknownTotalTitleScenario?.given.totalKnown, false);
assert.equal(seoseoOriginUnknownTotalTitleScenario?.then.terminalBriefTitle, 'A2A Terminal Brief 완료: worker-delta(2)');
assert.equal(seoseoOriginUnknownTotalTitleScenario?.then.rendererBrokerId, 'broker-alpha');
assert.equal(seoseoOriginUnknownTotalTitleScenario?.then.parentBrokerOnly, true);
assert.equal(seoseoOriginUnknownTotalTitleScenario?.then.titleOmitsUnknownDenominator, true);
assert.equal(seoseoOriginUnknownTotalTitleScenario?.then.titleDoesNotContainUnknownDenominator, true);
assert.equal(seoseoOriginUnknownTotalTitleScenario?.then.forbiddenUnknownDenominator, '(2/?)');
assert.ok(!seoseoOriginUnknownTotalTitleScenario?.then.terminalBriefTitle.includes('(2/?)'));
assert.equal(seoseoOriginUnknownTotalTitleScenario?.then.liveProviderSend, false);
assert.equal(seoseoOriginUnknownTotalTitleScenario?.then.terminalOutboxAckMutated, false);
assert.equal(seoseoOriginUnknownTotalTitleScenario?.then.isApproval, false);
assert.equal(seoseoOriginUnknownTotalTitleScenario?.then.isTerminalAck, false);
assert.equal(seoseoOriginUnknownTotalTitleScenario?.then.isReadReceipt, false);

const projectedScenario = parentAggregationScenarioByName.get(
  'parent-aggregates-child-terminal-evidence-as-redacted-projection',
);
assert.equal(projectedScenario?.then.projectionState, 'projected');
assert.equal(projectedScenario?.then.parentBriefEntryCreated, true);
assert.equal(projectedScenario?.then.redacted, true);
assert.equal(projectedScenario?.then.terminalOutboxAckMutated, false);
assert.equal(projectedScenario?.then.liveProviderSend, false);
assert.equal(projectedScenario?.then.isApproval, false);
assert.equal(projectedScenario?.then.isTerminalAck, false);
assert.equal(projectedScenario?.then.isReadReceipt, false);

const duplicateParentProjection = parentAggregationScenarioByName.get(
  'duplicate-parent-projection-returns-existing-entry',
);
assert.equal(duplicateParentProjection?.then.status, 'deduplicated');
assert.equal(duplicateParentProjection?.then.newProjectionCreated, false);
assert.equal(duplicateParentProjection?.then.returnedExistingProjection, true);
assert.equal(duplicateParentProjection?.then.liveProviderSend, false);
assert.equal(duplicateParentProjection?.then.terminalOutboxAckMutated, false);

const conflictParentProjection = parentAggregationScenarioByName.get(
  'same-key-different-payload-conflicts',
);
assert.equal(conflictParentProjection?.then.status, 'conflict');
assert.equal(conflictParentProjection?.then.newProjectionCreated, false);
assert.equal(conflictParentProjection?.then.existingProjectionOverwritten, false);
assert.equal(conflictParentProjection?.then.requiresOperatorReview, true);

const unsafeParentProjection = parentAggregationScenarioByName.get(
  'unsafe-child-evidence-becomes-redacted-block-projection',
);
assert.equal(unsafeParentProjection?.then.projectionState, 'blocked');
assert.equal(unsafeParentProjection?.then.terminalKind, 'block');
assert.equal(unsafeParentProjection?.then.unsafeEvidenceCopied, false);
assert.equal(unsafeParentProjection?.then.blockerSummaryRedacted, true);
assert.equal(unsafeParentProjection?.then.childTaskReplayed, false);
assert.equal(unsafeParentProjection?.then.liveProviderSend, false);
assert.equal(unsafeParentProjection?.then.terminalOutboxAckMutated, false);

assert.equal(parentTerminalBriefAggregation.rollbackGuidance.rollbackType, 'metadata-only');
assert.equal(parentTerminalBriefAggregation.rollbackGuidance.deleteChildEvidence, false);
assert.equal(parentTerminalBriefAggregation.rollbackGuidance.overwriteExistingProjection, false);
assert.equal(parentTerminalBriefAggregation.rollbackGuidance.createNewChildTaskForAggregationFailure, false);
assert.equal(parentTerminalBriefAggregation.rollbackGuidance.markProjectionBlockedOrConflict, true);
assert.equal(parentTerminalBriefAggregation.rollbackGuidance.preserveProjectionKey, true);
assert.ok(
  parentTerminalBriefAggregation.validationCommands.includes('node test/conformance/check-contract-fixtures.mjs'),
);
for (const [key, value] of Object.entries(parentTerminalBriefAggregation.safetyConfirmations)) {
  assert.equal(value, true, `parent aggregation safety confirmation ${key} must be true`);
}

// Four-case parent-origin Terminal Brief routing matrix (#634)
assert.equal(
  terminalBriefParentOriginRouting.contract,
  'contracts/a2a/parent-terminal-brief-aggregation.md',
);
assert.equal(terminalBriefParentOriginRouting.issue, 'https://github.com/jinwon-int/a2a-broker/issues/634');
assert.equal(
  terminalBriefParentOriginRouting.invariant,
  'initiating broker == parentBrokerId == originBrokerId == operatorFacingTerminalBriefSender',
);
assert.equal(
  terminalBriefParentOriginRouting.terminalBriefDefaultTitlePolicy.defaultFormatPlaceholder,
  'A2A Terminal Brief 완료: worker(n/N)',
);
assert.equal(
  terminalBriefParentOriginRouting.terminalBriefDefaultTitlePolicy.defaultFormatTemplate,
  'A2A Terminal Brief 완료: <worker>(<completed>/<total>)',
);
assert.equal(terminalBriefParentOriginRouting.terminalBriefDefaultTitlePolicy.statusLabel, '완료');
assert.equal(terminalBriefParentOriginRouting.terminalBriefDefaultTitlePolicy.requiresKnownTotalForDefault, true);
assert.equal(
  terminalBriefParentOriginRouting.terminalBriefDefaultTitlePolicy.operatorFacingOwnerRule,
  'initiatingBrokerId == parentBrokerId == originBrokerId == operatorFacingTerminalBriefSender',
);
assert.equal(
  terminalBriefParentOriginRouting.terminalBriefDefaultTitlePolicy.childOrHandoffMayRenderOperatorFacingTitle,
  false,
);
for (const field of [
  'statusLabel',
  'workerId',
  'parentRoundOrder',
  'parentRoundTotal',
  'parentRoundId',
  'originBrokerId',
  'parentBrokerId',
  'operatorFacingTerminalBriefSender',
]) {
  assert.ok(
    terminalBriefParentOriginRouting.terminalBriefDefaultTitlePolicy.titleMetadataFields.includes(field),
    `default title policy must require metadata field ${field}`,
  );
}
assert.deepEqual(terminalBriefParentOriginRouting.allowedTeamScopes.sort(), ['team1+team2', 'team1-only', 'team2-only']);
const registeredBrokerById = new Map(
  terminalBriefParentOriginRouting.registeredBrokers.map((broker) => [broker.brokerId, broker]),
);
assert.equal(registeredBrokerById.get('broker-alpha')?.teamId, 'team1');
assert.equal(registeredBrokerById.get('broker-beta')?.teamId, 'team2');
assert.equal(terminalBriefParentOriginRouting.routingCases.length, 4, 'exactly four routing cases are required');
const routingCaseById = new Map(
  terminalBriefParentOriginRouting.routingCases.map((routingCase) => [routingCase.caseId, routingCase]),
);
for (const requiredCase of [
  'broker-alpha-team1-local',
  'broker-alpha-allteams-broker-beta-child',
  'broker-beta-team2-local',
  'broker-beta-allteams-broker-alpha-child',
]) {
  assert.ok(routingCaseById.has(requiredCase), `missing routing case ${requiredCase}`);
}
for (const routingCase of terminalBriefParentOriginRouting.routingCases) {
  assert.equal(routingCase.parentBrokerId, routingCase.initiatingBrokerId, `${routingCase.caseId}: parent broker must be initiator`);
  assert.equal(routingCase.originBrokerId, routingCase.initiatingBrokerId, `${routingCase.caseId}: origin broker must be initiator`);
  assert.equal(
    routingCase.operatorFacingTerminalBriefSender,
    routingCase.initiatingBrokerId,
    `${routingCase.caseId}: operator-facing sender must be initiator`,
  );
  assert.equal(routingCase.terminalBriefNotification.senderBrokerId, routingCase.parentBrokerId);
  assert.equal(routingCase.terminalBriefNotification.parentBrokerOnly, true);
  assert.equal(routingCase.terminalBriefNotification.parentOriginOnly, true);
  const titleMetadata = routingCase.terminalBriefNotification.titleMetadata;
  assert.equal(titleMetadata.statusLabel, '완료', `${routingCase.caseId}: default title status must be 완료`);
  assert.equal(titleMetadata.renderedByBrokerId, routingCase.parentBrokerId);
  assert.equal(titleMetadata.renderedByBrokerId, routingCase.originBrokerId);
  assert.equal(titleMetadata.renderedByBrokerId, routingCase.operatorFacingTerminalBriefSender);
  assert.equal(titleMetadata.operatorFacingOwnerIsParentOrigin, true);
  assert.equal(titleMetadata.childOrHandoffRenderedOperatorFacingTitle, false);
  assert.match(titleMetadata.workerId, /^[a-z0-9_-]+$/);
  assert.equal(Number.isInteger(titleMetadata.parentRoundOrder), true);
  assert.equal(Number.isInteger(titleMetadata.parentRoundTotal), true);
  assert.ok(titleMetadata.parentRoundOrder >= 1);
  assert.ok(titleMetadata.parentRoundTotal >= titleMetadata.parentRoundOrder);
  assert.equal(
    titleMetadata.defaultTitle,
    `A2A Terminal Brief 완료: ${titleMetadata.workerId}(${titleMetadata.parentRoundOrder}/${titleMetadata.parentRoundTotal})`,
  );
  assert.match(titleMetadata.defaultTitle, /^A2A Terminal Brief 완료: [a-z0-9_-]+\(\d+\/\d+\)$/);
  if (routingCase.handoffBrokerId) {
    assert.notEqual(titleMetadata.renderedByBrokerId, routingCase.handoffBrokerId);
  }
  for (const [key, value] of Object.entries(routingCase.safety)) {
    assert.equal(value, false, `${routingCase.caseId}: safety ${key} must be false`);
  }
  assert.ok(['local-only', 'local-plus-cross-team-child-projection'].includes(routingCase.expectedPath));
}
const seoseoTeam1 = routingCaseById.get('broker-alpha-team1-local');
assert.equal(seoseoTeam1.requestedTeamScope, 'team1-only');
assert.deepEqual(seoseoTeam1.localTeamIds, ['team1']);
assert.equal(seoseoTeam1.handoffBrokerId, null);
assert.equal(seoseoTeam1.childProjectionRequired, false);
assert.equal(seoseoTeam1.parentSeedRequired, false);
assert.ok(seoseoTeam1.forbiddenBrokerInvolvement.includes('broker-beta'));

const gwakgaTeam2 = routingCaseById.get('broker-beta-team2-local');
assert.equal(gwakgaTeam2.requestedTeamScope, 'team2-only');
assert.deepEqual(gwakgaTeam2.localTeamIds, ['team2']);
assert.equal(gwakgaTeam2.handoffBrokerId, null);
assert.equal(gwakgaTeam2.childProjectionRequired, false);
assert.equal(gwakgaTeam2.parentSeedRequired, false);
assert.ok(gwakgaTeam2.forbiddenBrokerInvolvement.includes('broker-alpha'));

const seoseoAllTeams = routingCaseById.get('broker-alpha-allteams-broker-beta-child');
assert.equal(seoseoAllTeams.requestedTeamScope, 'team1+team2');
assert.deepEqual(seoseoAllTeams.localTeamIds, ['team1']);
assert.equal(seoseoAllTeams.handoffBrokerId, 'broker-beta');
assert.deepEqual(seoseoAllTeams.handoffTeamIds, ['team2']);
assert.equal(seoseoAllTeams.projectionDestinationBrokerId, 'broker-alpha');
assert.equal(seoseoAllTeams.childProjectionRequired, true);
assert.equal(seoseoAllTeams.parentSeedRequired, true);
assert.equal(seoseoAllTeams.terminalBriefNotification.childLocalNotificationSuppressed, true);
assert.equal(seoseoAllTeams.terminalBriefNotification.relaySuccessSuppressesChildLocalNotification, true);
assert.equal(seoseoAllTeams.terminalBriefNotification.relayFailureFallsBackToLocalNotification, true);

const gwakgaAllTeams = routingCaseById.get('broker-beta-allteams-broker-alpha-child');
assert.equal(gwakgaAllTeams.requestedTeamScope, 'team1+team2');
assert.deepEqual(gwakgaAllTeams.localTeamIds, ['team2']);
assert.equal(gwakgaAllTeams.handoffBrokerId, 'broker-alpha');
assert.deepEqual(gwakgaAllTeams.handoffTeamIds, ['team1']);
assert.equal(gwakgaAllTeams.projectionDestinationBrokerId, 'broker-beta');
assert.equal(gwakgaAllTeams.childProjectionRequired, true);
assert.equal(gwakgaAllTeams.parentSeedRequired, true);
assert.equal(gwakgaAllTeams.terminalBriefNotification.childLocalNotificationSuppressed, true);
assert.equal(gwakgaAllTeams.terminalBriefNotification.relaySuccessSuppressesChildLocalNotification, true);
assert.equal(gwakgaAllTeams.terminalBriefNotification.relayFailureFallsBackToLocalNotification, true);

assert.equal(terminalBriefParentOriginRouting.parentlessProjectionPolicy.status, 'missing_parent');
assert.equal(terminalBriefParentOriginRouting.parentlessProjectionPolicy.acceptProjection, false);
assert.equal(terminalBriefParentOriginRouting.parentlessProjectionPolicy.createParentImplicitly, false);
assert.equal(terminalBriefParentOriginRouting.parentlessProjectionPolicy.localFallbackAllowedOnRelayFailure, true);
assert.equal(terminalBriefParentOriginRouting.parentlessProjectionPolicy.terminalOutboxAckMutated, false);
assert.equal(terminalBriefParentOriginRouting.parentlessProjectionPolicy.liveProviderSend, false);
for (const field of [
  'teamScope',
  'initiatingBrokerId',
  'originBrokerId',
  'parentBrokerId',
  'parentRoundId',
  'parentRoundOrder',
  'parentRoundTotal',
  'handoffBrokerId',
  'childBrokerId',
]) {
  assert.ok(terminalBriefParentOriginRouting.requiredMetadataFields.includes(field));
}
for (const forbidden of [
  'originBrokerId means child broker',
  'Team2-only work routes through broker-alpha',
  'Team1-only work routes through broker-beta',
  'provider accepted/send evidence must be treated as non-ACK only',
  'child broker sends an operator-facing parent Terminal Brief after relay success',
  'child or handoff broker renders the operator-facing default Terminal Brief title',
  'non-parent-origin broker owns the operator-facing Terminal Brief title',
  'parentless child projection creates an implicit parent',
]) {
  assert.ok(terminalBriefParentOriginRouting.forbiddenInterpretations.includes(forbidden));
}
assert.ok(
  terminalBriefParentOriginRouting.validationCommands.includes('node test/conformance/check-contract-fixtures.mjs'),
);
for (const [key, value] of Object.entries(terminalBriefParentOriginRouting.safetyConfirmations)) {
  assert.equal(value, true, `parent-origin routing safety confirmation ${key} must be true`);
}
assert.ok(terminalBriefParentOriginRouting.v1Freeze, 'terminal brief parent-origin routing v1 freeze marker must exist');

assert.equal(publicPolicy.sourceIssueUrl, 'a2a-plane#94 (internal tracker, private)');
assert.equal(publicPolicy.reviewIssueUrl, 'a2a-plane#166 (internal tracker, private)');
assert.equal(publicPolicy.round, 'a2a-public-readiness-next-20260509T165108Z');
assert.equal(publicPolicy.policyInvariants.referenceIntegrationIsNotExclusive, true);
assert.equal(publicPolicy.policyInvariants.sourceBrokerIdsAreExamplesNotRequirements, true);
assert.equal(publicPolicy.policyInvariants.compatibilityEvidenceUsesPublicContractsOnly, true);
assert.equal(publicPolicy.policyInvariants.providerSendIsAcceptedSendOnly, true);
assert.ok(
  publicPolicy.requiredPublicEvidence.includes('contracts/compatibility/matrix.md'),
  'issue #94 public follow-up proof must reference the compatibility matrix',
);
assert.ok(
  publicPolicy.requiredPublicEvidence.includes('fixtures/contract/broker-beta-cross-broker-handoff.json'),
  'issue #94 public follow-up proof must reference broker-beta-owned handoff evidence',
);
const portableBrokerIds = new Set(
  publicPolicy.portableBrokerExamples.map((example) => example.brokerId),
);
assert.ok(portableBrokerIds.has('broker-beta'), 'policy proof must include a non-broker-alpha broker example');
assert.ok(
  portableBrokerIds.has('generic-public-broker'),
  'policy proof must include a generic public broker example',
);
assert.ok(
  publicPolicy.forbiddenAssumptions.includes('requires-broker-alpha-as-broker-of-record'),
  'policy proof must forbid broker-alpha-only broker-of-record assumptions',
);
assert.ok(
  publicPolicy.forbiddenAssumptions.includes('requires-provider-message-id-as-terminal-ack'),
  'policy proof must forbid provider message ids as terminal ACK evidence',
);
assert.ok(
  publicPolicy.validationCommands.includes('node test/conformance/check-contract-fixtures.mjs'),
);
for (const [key, value] of Object.entries(publicPolicy.safetyConfirmations)) {
  assert.equal(value, true, `public compatibility policy safety confirmation ${key} must be true`);
}

assert.equal(replayTrace.childIssue, 'a2a-plane#168 (internal tracker, private)');
assert.equal(replayTrace.parentIssue, 'a2a-plane#163 (internal tracker, private)');
assert.equal(replayTrace.brokerOfRecord, 'broker-beta');
assert.ok(workerNames.has(replayTrace.workerName), 'replay fixture must reference a registered worker');
assert.equal(replayTrace.replayProof.totals.terminalResultsCreated, 1);
assert.equal(replayTrace.replayProof.totals.providerSendsProduced, 0);
assert.equal(replayTrace.replayProof.totals.terminalOutboxAcksProduced, 0);
assert.equal(replayTrace.replayProof.totals.duplicateSendsProduced, 0);
assert.equal(replayTrace.replayProof.totals.duplicateAcksProduced, 0);
assert.equal(replayTrace.replayProof.attempts.length, 2);
assert.equal(replayTrace.replayProof.attempts[0].terminalResultCreated, true);
for (const attempt of replayTrace.replayProof.attempts) {
  assert.equal(attempt.providerSendProduced, false, `attempt ${attempt.attempt} must not produce provider send`);
  assert.equal(attempt.terminalOutboxAckProduced, false, `attempt ${attempt.attempt} must not produce terminal ACK`);
}
assert.equal(replayTrace.replayProof.attempts[1].decision, 'suppress-duplicate-return-existing-result');
assert.equal(replayTrace.replayProof.attempts[1].terminalResultCreated, false);
assert.equal(replayTrace.replayProof.attempts[1].returnedExistingTerminalResult, true);
assert.equal(replayTrace.tracePolicy.status, 'compact-redacted-sufficient');
assert.ok(replayTrace.tracePolicy.sampleTrace.length <= replayTrace.tracePolicy.maxEvents);
for (const traceEvent of replayTrace.tracePolicy.sampleTrace) {
  assert.ok(
    Object.keys(traceEvent).length <= replayTrace.tracePolicy.maxEventKeys,
    'trace event must stay compact',
  );
  for (const forbiddenField of replayTrace.tracePolicy.forbiddenFields) {
    assert.ok(!(forbiddenField in traceEvent), `trace event must not include ${forbiddenField}`);
  }
  assert.equal(traceEvent.safetyFlags.liveProviderSend ?? false, false);
  assert.equal(traceEvent.safetyFlags.terminalOutboxAckMutation ?? false, false);
}
assert.equal(replayTrace.safetyConfirmations.requiresPrivateTopology, false);
for (const [key, value] of Object.entries(replayTrace.safetyConfirmations)) {
  if (key === 'requiresPrivateTopology') continue;
  assert.equal(value, true, `replay trace safety confirmation ${key} must be true`);
}

assert.equal(liveCanaryApprovalBoundary.parentIssue, 'a2a-plane#174 (internal tracker, private)');
assert.equal(liveCanaryApprovalBoundary.childIssue, 'a2a-plane#177 (internal tracker, private)');
assert.equal(liveCanaryApprovalBoundary.v0Freeze.round, 'a2a-live-canary-readiness-20260509T173917Z');
assert.equal(liveCanaryApprovalBoundary.brokerOfRecord, 'broker-beta');
assert.ok(workerNames.has(liveCanaryApprovalBoundary.workerName), 'live-canary proof must reference a registered worker');
assert.equal(liveCanaryApprovalBoundary.canaryMode, 'no-live-redacted-replay');
assert.equal(liveCanaryApprovalBoundary.replayNoDuplicateProof.totals.terminalResultsCreated, 1);
assert.equal(liveCanaryApprovalBoundary.replayNoDuplicateProof.totals.liveProviderSendsProduced, 0);
assert.equal(liveCanaryApprovalBoundary.replayNoDuplicateProof.totals.terminalOutboxAckMutations, 0);
assert.equal(liveCanaryApprovalBoundary.replayNoDuplicateProof.totals.duplicateProviderSendsProduced, 0);
assert.equal(liveCanaryApprovalBoundary.replayNoDuplicateProof.totals.duplicateTerminalAckMutations, 0);
assert.equal(liveCanaryApprovalBoundary.replayNoDuplicateProof.attempts.length, 2);
assert.equal(liveCanaryApprovalBoundary.replayNoDuplicateProof.attempts[1].decision, 'suppress-duplicate-return-existing-result');
assert.equal(liveCanaryApprovalBoundary.replayNoDuplicateProof.attempts[1].returnedExistingTerminalResult, true);
for (const attempt of liveCanaryApprovalBoundary.replayNoDuplicateProof.attempts) {
  assert.equal(attempt.liveProviderSendProduced, false, `live-canary attempt ${attempt.attempt} must not produce live sends`);
  assert.equal(attempt.terminalOutboxAckMutated, false, `live-canary attempt ${attempt.attempt} must not mutate terminal outbox ACKs`);
}
assert.equal(liveCanaryApprovalBoundary.scannerApprovalBoundary.scannerSuccessImpliesOperatorApproval, false);
assert.equal(liveCanaryApprovalBoundary.scannerApprovalBoundary.explicitOperatorApprovalPresent, false);
assert.equal(liveCanaryApprovalBoundary.scannerApprovalBoundary.operatorApprovalRequiredForVisibility, true);
assert.equal(liveCanaryApprovalBoundary.scannerApprovalBoundary.approvalEvidenceMustBeSeparate, true);
assert.equal(liveCanaryApprovalBoundary.scannerApprovalBoundary.aggregateDecision, 'NO-GO/Waiting');
const liveCanaryBlockers = new Set(liveCanaryApprovalBoundary.remainingLiveCanaryBlockers.map((blocker) => blocker.gate));
assert.deepEqual(
  [...liveCanaryBlockers].sort(),
  ['externalScannerEvidence', 'operatorApproval', 'terminalEvidence'],
  'remaining live-canary blockers must stay explicit',
);
assert.ok(liveCanaryApprovalBoundary.validationCommands.includes('node test/conformance/check-contract-fixtures.mjs'));
assert.ok(liveCanaryApprovalBoundary.validationCommands.includes('npm run scan:readiness-gates'));
assert.equal(liveCanaryApprovalBoundary.safetyConfirmations.requiresPrivateTopology, false);
for (const [key, value] of Object.entries(liveCanaryApprovalBoundary.safetyConfirmations)) {
  if (key === 'requiresPrivateTopology') continue;
  assert.equal(value, true, `live-canary safety confirmation ${key} must be true`);
}

const examplePath = path.join(root, 'examples', 'compatibility', 'cross-team-conformance.json');
const example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
assert.equal(example.brokerOfRecord, 'broker-beta');
assert.equal(example.publicFollowupIssue, 'a2a-plane#94 (internal tracker, private)');
assert.equal(example.independentReviewIssue, 'a2a-plane#166 (internal tracker, private)');
assert.ok(!example.fixtures.some((fixture) => fixture.startsWith('examples/local/')));
for (const fixture of Object.values(fixtureFiles).map((file) => `fixtures/contract/${file}`)) {
  assert.ok(example.fixtures.includes(fixture), `compatibility example must reference ${fixture}`);
}

walk({ fixtures, example }, (value, trail) => {
  if (typeof value !== 'string') return;
  assert.ok(
    !value.includes('raw session') || trail.join('.') === 'example.intentionallyExcluded.3',
    `raw-session wording must only be listed as excluded at ${trail.join('.')}`,
  );
  assert.ok(
    !value.includes('terminal ACK mutation') || trail.join('.') === 'example.intentionallyExcluded.2',
    `terminal ACK mutation must only be listed as excluded at ${trail.join('.')}`,
  );
});

// --- Checkpoint & Human-Interrupt fixture validation ---

// v0Freeze marker
assert.ok(checkpointInterrupt.v0Freeze, 'checkpoint-interrupt fixture must carry v0Freeze marker');
assert.ok(checkpointInterrupt.v0Freeze.frozenAt, 'checkpoint-interrupt v0Freeze must include frozenAt');
assert.equal(
  checkpointInterrupt.v0Freeze.round,
  'a2a-public-readiness-next-20260509T165108Z',
  'checkpoint-interrupt round must match',
);
assert.equal(checkpointInterrupt.contract, 'contracts/a2a/checkpoint-interrupt.md');

// Checkpoint states are non-terminal transitory states
assert.ok(checkpointInterrupt.checkpointStates.paused, 'paused state must be defined');
assert.ok(checkpointInterrupt.checkpointStates.awaiting_operator, 'awaiting_operator state must be defined');
assert.equal(checkpointInterrupt.checkpointStates.paused.terminal, false);
assert.equal(checkpointInterrupt.checkpointStates.awaiting_operator.terminal, false);
assert.deepEqual(
  checkpointInterrupt.checkpointStates.paused.allowedTransitions.sort(),
  ['blocked', 'cancelled', 'running'],
);
assert.deepEqual(
  checkpointInterrupt.checkpointStates.awaiting_operator.allowedTransitions.sort(),
  ['blocked', 'cancelled', 'running'],
);

// Interrupt decision types
const interruptTypes = new Set(checkpointInterrupt.interruptDecisionTypes.map((d) => d.type));
assert.deepEqual(
  [...interruptTypes].sort(),
  ['ambiguous_scope', 'approval_required', 'conflict_detected', 'safety_gate'],
);
for (const dt of checkpointInterrupt.interruptDecisionTypes) {
  assert.ok(Array.isArray(dt.validOperatorActions) && dt.validOperatorActions.length >= 2);
  assert.ok(dt.validOperatorActions.includes('approved'));
  assert.ok(dt.validOperatorActions.includes('refused'));
}

// Scenario coverage: all decision types must have at least one scenario
const scenarioDecisionTypes = new Set(
  checkpointInterrupt.scenarios
    .filter((s) => s.when?.decisionType || s.given?.decisionType)
    .map((s) => s.when?.decisionType || s.given?.decisionType),
);
for (const dt of interruptTypes) {
  assert.ok(scenarioDecisionTypes.has(dt), `interrupt decision type ${dt} must have at least one scenario`);
}

// Each scenario
const ckScenarioByName = new Map(checkpointInterrupt.scenarios.map((s) => [s.name, s]));

// Worker checkpoint scenario
const checkpointScenario = ckScenarioByName.get('worker-checkpoints-during-safe-file-operation');
assert.ok(checkpointScenario, 'checkpoint scenario must exist');
assert.equal(checkpointScenario.then.state, 'paused');
assert.equal(checkpointScenario.then.terminal, false);
assert.equal(checkpointScenario.then.workerAssigned, false);
assert.equal(checkpointScenario.then.terminalOutboxAckMutated, false);
assert.equal(checkpointScenario.then.liveProviderSend, false);
assert.ok(checkpointScenario.given.completedOperations.includes('write-file'));
assert.ok(checkpointScenario.when.artifactRefs.length > 0);

// Resume scenario
const resumeScenario = ckScenarioByName.get('worker-resumes-from-checkpoint');
assert.ok(resumeScenario, 'resume scenario must exist');
assert.equal(resumeScenario.then.state, 'running');
assert.equal(resumeScenario.then.terminal, false);
assert.equal(resumeScenario.then.checkpointContextProvided, true);
assert.equal(resumeScenario.then.preCheckpointOperationsNotReplayed, true);
assert.equal(resumeScenario.then.terminalOutboxAckMutated, false);
assert.equal(resumeScenario.then.liveProviderSend, false);

// Pause timeout → cancelled
const pauseTimeoutScenario = ckScenarioByName.get('pause-timeout-transitions-to-cancelled');
assert.ok(pauseTimeoutScenario, 'pause timeout scenario must exist');
assert.equal(pauseTimeoutScenario.then.state, 'cancelled');
assert.equal(pauseTimeoutScenario.then.terminal, true);
assert.equal(pauseTimeoutScenario.then.cancelSource, 'timeout');
assert.equal(pauseTimeoutScenario.then.terminalOutboxAckMutated, false);
assert.equal(pauseTimeoutScenario.then.liveProviderSend, false);

// Human interrupt: safety gate approved
const safetyGateScenario = ckScenarioByName.get('human-interrupt-safety-gate-approved');
assert.ok(safetyGateScenario, 'safety gate interrupt scenario must exist');
assert.equal(safetyGateScenario.thenInterrupt.state, 'awaiting_operator');
assert.equal(safetyGateScenario.thenInterrupt.decisionType, 'safety_gate');
assert.equal(safetyGateScenario.thenInterrupt.terminalOutboxAckMutated, false);
assert.equal(safetyGateScenario.thenInterrupt.liveProviderSend, false);
assert.equal(safetyGateScenario.operatorAction.action, 'approved');
assert.equal(safetyGateScenario.thenResume.state, 'running');
assert.equal(safetyGateScenario.thenResume.terminalOutboxAckMutated, false);
assert.equal(safetyGateScenario.thenResume.liveProviderSend, false);

// Human interrupt: ambiguous scope clarified
const ambiguousScenario = ckScenarioByName.get('human-interrupt-ambiguous-scope-clarified');
assert.ok(ambiguousScenario, 'ambiguous scope interrupt scenario must exist');
assert.equal(ambiguousScenario.thenInterrupt.decisionType, 'ambiguous_scope');
assert.equal(ambiguousScenario.operatorAction.action, 'clarified');
assert.equal(ambiguousScenario.thenResume.state, 'running');

// Human interrupt: refused becomes block
const refusedScenario = ckScenarioByName.get('human-interrupt-refused-becomes-block');
assert.ok(refusedScenario, 'refused interrupt scenario must exist');
assert.equal(refusedScenario.operatorAction.action, 'refused');
assert.equal(refusedScenario.then.state, 'blocked');
assert.equal(refusedScenario.then.terminal, true);
assert.equal(refusedScenario.then.blockerCategory, 'safety');
assert.equal(refusedScenario.then.terminalOutboxAckMutated, false);
assert.equal(refusedScenario.then.liveProviderSend, false);

// Interrupt timeout → cancelled
const intTimeoutScenario = ckScenarioByName.get('interrupt-timeout-transitions-to-cancelled');
assert.ok(intTimeoutScenario, 'interrupt timeout scenario must exist');
assert.equal(intTimeoutScenario.then.state, 'cancelled');
assert.equal(intTimeoutScenario.then.terminal, true);
assert.equal(intTimeoutScenario.then.cancelSource, 'timeout');
assert.equal(intTimeoutScenario.then.terminalOutboxAckMutated, false);
assert.equal(intTimeoutScenario.then.liveProviderSend, false);

// Replay: completed task is idempotent noop
const replayDoneScenario = ckScenarioByName.get('replay-completed-task-is-idempotent-noop');
assert.ok(replayDoneScenario, 'replay done scenario must exist');
assert.equal(replayDoneScenario.then.state, 'done');
assert.equal(replayDoneScenario.then.newSideEffects, false);
assert.equal(replayDoneScenario.then.newEvidencePosted, false);
assert.equal(replayDoneScenario.then.terminalOutboxAckMutated, false);
assert.equal(replayDoneScenario.then.liveProviderSend, false);

// Replay: checkpoint resume does not re-execute pre-checkpoint ops
const replayResumeScenario = ckScenarioByName.get('replay-checkpoint-resume-does-not-re-execute-pre-checkpoint-ops');
assert.ok(replayResumeScenario, 'replay resume scenario must exist');
assert.equal(replayResumeScenario.then.completedOperationsReplayed, false);
assert.equal(replayResumeScenario.then.checkpointContextMatches, true);
assert.equal(replayResumeScenario.then.terminalOutboxAckMutated, false);
assert.equal(replayResumeScenario.then.liveProviderSend, false);

// Replay guarantees
const replayGuarantees = checkpointInterrupt.replayGuarantees;
assert.ok(Array.isArray(replayGuarantees) && replayGuarantees.length >= 3);
const guaranteeNames = new Set(replayGuarantees.map((g) => g.guarantee));
assert.ok(guaranteeNames.has('idempotent-operation-replay'));
assert.ok(guaranteeNames.has('checkpoint-resume-replay'));
assert.ok(guaranteeNames.has('terminal-state-immutability'));
assert.ok(guaranteeNames.has('evidence-immutability'));

// Audit trace export
assert.ok(checkpointInterrupt.auditTraceExport, 'audit trace export must be defined');
assert.equal(checkpointInterrupt.auditTraceExport.exportSafety.noSecretsOrPrivatePaths, true);
assert.equal(checkpointInterrupt.auditTraceExport.exportSafety.noProviderMessageIdsAboveAcceptedSend, true);
assert.equal(checkpointInterrupt.auditTraceExport.exportSafety.noTerminalOutboxAckValues, true);
assert.equal(checkpointInterrupt.auditTraceExport.exportSafety.deterministicEventSequence, true);
assert.equal(checkpointInterrupt.auditTraceExport.exportSafety.redacted, true);
assert.equal(checkpointInterrupt.auditTraceExport.schema.redacted, true);
assert.equal(checkpointInterrupt.auditTraceExport.schema.brokerOfRecord, 'broker-beta');
assert.ok(
  checkpointInterrupt.auditTraceExport.schema.events.some((e) => e.type === 'task.paused'),
  'audit trace must include pause event',
);
assert.ok(
  checkpointInterrupt.auditTraceExport.schema.events.some((e) => e.type === 'task.interrupted'),
  'audit trace must include interrupt event',
);
assert.ok(
  checkpointInterrupt.auditTraceExport.schema.events.some((e) => e.type === 'operator.decide'),
  'audit trace must include operator decide event',
);

// Artifact version lineage
assert.ok(checkpointInterrupt.artifactVersionLineage, 'artifact version lineage must be defined');
const lineage = checkpointInterrupt.artifactVersionLineage;
assert.equal(lineage.lineageSafety.pathsAreRepoRelative, true);
assert.equal(lineage.lineageSafety.versionRefsAreDeterministic, true);
assert.equal(lineage.lineageSafety.noHostSpecificPaths, true);
assert.equal(lineage.lineageSafety.noArtifactContentInline, true);
assert.equal(lineage.lineageSafety.noProviderCredentials, true);
assert.ok(lineage.example.artifactPath, 'lineage example must have artifactPath');
assert.ok(lineage.example.versionRef, 'lineage example must have versionRef');

// Safety confirmations
for (const [key, value] of Object.entries(checkpointInterrupt.safetyConfirmations)) {
  assert.equal(value, true, `checkpoint-interrupt safety confirmation ${key} must be true`);
}

// Assertions
assert.ok(Array.isArray(checkpointInterrupt.assertions) && checkpointInterrupt.assertions.length >= 8);
const ckAssertionsSet = new Set(checkpointInterrupt.assertions);
assert.ok(
  ckAssertionsSet.has(
    'paused and awaiting_operator are non-terminal transitory states',
  ),
);
assert.ok(
  ckAssertionsSet.has(
    'all scenarios confirm terminalOutboxAckMutated: false and liveProviderSend: false',
  ),
);
assert.ok(
  ckAssertionsSet.has(
    'checkpoint and interrupt contracts do not imply production DB mutation or persistence rollout',
  ),
);

// Every scenario must confirm safety invariants
for (const scenario of checkpointInterrupt.scenarios) {
  walk(scenario, (value, trail) => {
    if (trail.at(-1) === 'terminalOutboxAckMutated') {
      assert.equal(value, false, `scenario ${scenario.name}: terminalOutboxAckMutated must be false at ${trail.join('.')}`);
    }
    if (trail.at(-1) === 'liveProviderSend') {
      assert.equal(value, false, `scenario ${scenario.name}: liveProviderSend must be false at ${trail.join('.')}`);
    }
  });
}

// R20 stability gate fixture validation
assert.ok(stabilityGate.fixtureId, 'stabilityGate fixture must carry fixtureId');
assert.equal(stabilityGate.contract, 'contracts/a2a/r20-stability-gate.md');
assert.equal(
  stabilityGate.parentIssue,
  'https://github.com/jinwon-int/a2a-broker/issues/636',
);
assert.equal(
  stabilityGate.issue,
  'a2a-plane#327 (internal tracker, private)',
);
assert.equal(stabilityGate.originCoordinator, 'broker-beta');
assert.equal(stabilityGate.receivingBrokerId, 'broker-alpha');
assert.equal(stabilityGate.team, 'team1-worker-delta');

// Gate H1: hot-table persistence
assert.ok(stabilityGate.hotTablePersistence, 'stabilityGate must contain hotTablePersistence');
assert.equal(stabilityGate.hotTablePersistence.gateId, 'H1');
const h1Diagnostics = stabilityGate.hotTablePersistence.boundedDiagnostics;
for (const key of ['processMemoryRssHeap', 'activeTaskTableCount', 'terminalOutboxCounts', 'staleClaimedRunningWork', 'sqliteWalCheckpointPosture', 'snapshotSerializeFrequency']) {
  assert.ok(h1Diagnostics[key], `H1 must include boundedDiagnostics.${key}`);
  assert.equal(h1Diagnostics[key].required, true, `H1 boundedDiagnostics.${key}.required must be true`);
}
assert.ok(Array.isArray(stabilityGate.hotTablePersistence.memoryBoundInvariants) && stabilityGate.hotTablePersistence.memoryBoundInvariants.length >= 4);
for (const invariant of stabilityGate.hotTablePersistence.memoryBoundInvariants) {
  assert.ok(invariant.invariant, 'H1 memoryBoundInvariant must have invariant name');
  assert.ok(invariant.passCondition, 'H1 memoryBoundInvariant must have passCondition');
  assert.ok(invariant.failClosedCondition, 'H1 memoryBoundInvariant must have failClosedCondition');
}
for (const [key, value] of Object.entries(stabilityGate.hotTablePersistence.safetyConfirmations)) {
  assert.equal(value, true, `H1 safety confirmation ${key} must be true`);
}
assert.equal(stabilityGate.hotTablePersistence.aggregateDecision, 'NO-GO/Waiting');

// Gate Q1: queue/outbox hygiene
assert.ok(stabilityGate.queueOutboxHygiene, 'stabilityGate must contain queueOutboxHygiene');
assert.equal(stabilityGate.queueOutboxHygiene.gateId, 'Q1');
const q1Processing = stabilityGate.queueOutboxHygiene.boundedProcessing;
for (const key of ['perRunItemLimit', 'progressReporting', 'dryRunSafety', 'ageBasedStaleness', 'mutationApprovalGate']) {
  assert.ok(q1Processing[key], `Q1 must include boundedProcessing.${key}`);
  assert.equal(q1Processing[key].required, true, `Q1 boundedProcessing.${key}.required must be true`);
}
assert.ok(Array.isArray(stabilityGate.queueOutboxHygiene.hygieneInvariants) && stabilityGate.queueOutboxHygiene.hygieneInvariants.length >= 4);
for (const invariant of stabilityGate.queueOutboxHygiene.hygieneInvariants) {
  assert.ok(invariant.invariant, 'Q1 hygieneInvariant must have invariant name');
  assert.ok(invariant.passCondition, 'Q1 hygieneInvariant must have passCondition');
  assert.ok(invariant.failClosedCondition, 'Q1 hygieneInvariant must have failClosedCondition');
}
for (const [key, value] of Object.entries(stabilityGate.queueOutboxHygiene.safetyConfirmations)) {
  assert.equal(value, true, `Q1 safety confirmation ${key} must be true`);
}
assert.equal(stabilityGate.queueOutboxHygiene.aggregateDecision, 'NO-GO/Waiting');

// Gate C1: no-live canary boundary
assert.ok(stabilityGate.noLiveCanaryBoundary, 'stabilityGate must contain noLiveCanaryBoundary');
assert.equal(stabilityGate.noLiveCanaryBoundary.gateId, 'C1');
assert.ok(Array.isArray(stabilityGate.noLiveCanaryBoundary.noLiveInvariants) && stabilityGate.noLiveCanaryBoundary.noLiveInvariants.length >= 5);
for (const invariant of stabilityGate.noLiveCanaryBoundary.noLiveInvariants) {
  assert.ok(invariant.invariant, 'C1 noLiveInvariant must have invariant name');
  assert.ok(invariant.passCondition, 'C1 noLiveInvariant must have passCondition');
  assert.ok(invariant.failClosedCondition, 'C1 noLiveInvariant must have failClosedCondition');
}
assert.ok(Array.isArray(stabilityGate.noLiveCanaryBoundary.canaryActivationPreconditions) && stabilityGate.noLiveCanaryBoundary.canaryActivationPreconditions.length >= 5);
for (const precondition of stabilityGate.noLiveCanaryBoundary.canaryActivationPreconditions) {
  assert.ok(precondition.precondition, 'C1 canaryActivationPrecondition must have name');
  assert.ok(precondition.passCondition, 'C1 canaryActivationPrecondition must have passCondition');
  assert.ok(precondition.failClosedCondition, 'C1 canaryActivationPrecondition must have failClosedCondition');
}
for (const [key, value] of Object.entries(stabilityGate.noLiveCanaryBoundary.safetyConfirmations)) {
  assert.equal(value, true, `C1 safety confirmation ${key} must be true`);
}
assert.equal(stabilityGate.noLiveCanaryBoundary.aggregateDecision, 'NO-GO/Waiting');

// Gate R14: stale R14 PR reconciliation
assert.ok(stabilityGate.staleR14Reconciliation, 'stabilityGate must contain staleR14Reconciliation');
assert.equal(stabilityGate.staleR14Reconciliation.gateId, 'R14');
assert.ok(Array.isArray(stabilityGate.staleR14Reconciliation.policyActions) && stabilityGate.staleR14Reconciliation.policyActions.length >= 4);
const r14Actions = new Set(stabilityGate.staleR14Reconciliation.policyActions.map((a) => a.action));
for (const requiredAction of ['merge', 'supersede', 'close', 'keep-open']) {
  assert.ok(r14Actions.has(requiredAction), `R14 policyActions must include ${requiredAction}`);
}
for (const action of stabilityGate.staleR14Reconciliation.policyActions) {
  assert.ok(action.passCondition, `R14 action ${action.action} must have passCondition`);
  assert.ok(action.failClosedCondition, `R14 action ${action.action} must have failClosedCondition`);
}
for (const [key, value] of Object.entries(stabilityGate.staleR14Reconciliation.safetyConfirmations)) {
  assert.equal(value, true, `R14 safety confirmation ${key} must be true`);
}
assert.equal(stabilityGate.staleR14Reconciliation.aggregateDecision, 'NO-GO/Waiting');

// Aggregate decision and global safety
assert.equal(stabilityGate.aggregateGateDecision, 'NO-GO/Waiting');
for (const [key, value] of Object.entries(stabilityGate.safetyConfirmations)) {
  assert.equal(value, true, `stabilityGate safety confirmation ${key} must be true`);
}
assert.ok(Array.isArray(stabilityGate.validationCommands) && stabilityGate.validationCommands.length >= 1);
assert.ok(stabilityGate.validationCommands.includes('node test/conformance/check-contract-fixtures.mjs'));
assert.equal(stabilityGate.redacted, true);

// --- Embedded Execution Stability Policy fixture validation ---

assert.ok(embeddedExecutionStability.fixtureId, 'embeddedExecutionStability fixture must carry fixtureId');
assert.match(embeddedExecutionStability.fixtureId, /^a2a-nexus\.contract\.embedded-execution-stability-policy\.v0$/, 'fixtureId must match a2a-nexus.contract.embedded-execution-stability-policy.v0');
assert.equal(embeddedExecutionStability.contract, 'contracts/a2a/embedded-execution-stability-policy.md');
assert.equal(embeddedExecutionStability.parentIssue, 'https://github.com/jinwon-int/a2a-broker/issues/838');
assert.equal(embeddedExecutionStability.originWorker, 'Team1/worker-alpha');
assert.equal(embeddedExecutionStability.targetPackage, 'packages/docker-runner/');
assert.ok(embeddedExecutionStability.v0Freeze, 'embeddedExecutionStability must carry v0Freeze marker');
assert.ok(embeddedExecutionStability.v0Freeze.frozenAt, 'v0Freeze must include frozenAt');
assert.ok(embeddedExecutionStability.v0Freeze.round, 'v0Freeze must include round');

// References must include the contract document and at least the runner config source
assert.ok(Array.isArray(embeddedExecutionStability.references) && embeddedExecutionStability.references.length >= 3);
assert.ok(embeddedExecutionStability.references.includes('packages/docker-runner/src/config.ts'), 'references must include the runner config source');

// Container isolation gate (E1)
assert.ok(embeddedExecutionStability.containerIsolation, 'must contain containerIsolation');
assert.equal(embeddedExecutionStability.containerIsolation.gateId, 'E1');
assert.ok(Array.isArray(embeddedExecutionStability.containerIsolation.processIsolation) && embeddedExecutionStability.containerIsolation.processIsolation.length >= 3);
assert.ok(Array.isArray(embeddedExecutionStability.containerIsolation.filesystemIsolation) && embeddedExecutionStability.containerIsolation.filesystemIsolation.length >= 3);
assert.ok(Array.isArray(embeddedExecutionStability.containerIsolation.networkIsolation) && embeddedExecutionStability.containerIsolation.networkIsolation.length >= 3);
for (const invariant of embeddedExecutionStability.containerIsolation.processIsolation) {
  assert.ok(invariant.invariant, 'processIsolation invariant must have a name');
  assert.ok(invariant.passCondition, 'processIsolation invariant must have a passCondition');
  assert.ok(invariant.failClosedCondition, 'processIsolation invariant must have a failClosedCondition');
}
for (const invariant of embeddedExecutionStability.containerIsolation.filesystemIsolation) {
  assert.ok(invariant.invariant, 'filesystemIsolation invariant must have a name');
  assert.ok(invariant.passCondition, 'filesystemIsolation invariant must have a passCondition');
  assert.ok(invariant.failClosedCondition, 'filesystemIsolation invariant must have a failClosedCondition');
}
for (const invariant of embeddedExecutionStability.containerIsolation.networkIsolation) {
  assert.ok(invariant.invariant, 'networkIsolation invariant must have a name');
  assert.ok(invariant.passCondition, 'networkIsolation invariant must have a passCondition');
  assert.ok(invariant.failClosedCondition, 'networkIsolation invariant must have a failClosedCondition');
}
for (const [key, value] of Object.entries(embeddedExecutionStability.containerIsolation.safetyConfirmations)) {
  assert.equal(value, true, 'containerIsolation safety confirmation ' + key + ' must be true');
}
assert.equal(embeddedExecutionStability.containerIsolation.aggregateDecision, 'PASS/Active');

// Config domain gate (E2)
assert.ok(embeddedExecutionStability.configDomain, 'must contain configDomain');
assert.equal(embeddedExecutionStability.configDomain.gateId, 'E2');
assert.ok(embeddedExecutionStability.configDomain.configSanitization, 'must contain configSanitization');
const sanitizationRules = embeddedExecutionStability.configDomain.configSanitization;
for (const [ruleName, rule] of Object.entries(sanitizationRules)) {
  assert.ok(rule.required === true, ruleName + ' sanitization rule must be required');
  assert.ok(rule.passCondition, ruleName + ' must have passCondition');
  assert.ok(rule.failClosedCondition, ruleName + ' must have failClosedCondition');
}
assert.ok(embeddedExecutionStability.configDomain.credentialScoping, 'must contain credentialScoping');
const scopingRules = embeddedExecutionStability.configDomain.credentialScoping;
for (const [ruleName, rule] of Object.entries(scopingRules)) {
  assert.ok(rule.required === true, ruleName + ' scoping rule must be required');
  assert.ok(rule.passCondition, ruleName + ' must have passCondition');
  assert.ok(rule.failClosedCondition, ruleName + ' must have failClosedCondition');
}
for (const [key, value] of Object.entries(embeddedExecutionStability.configDomain.safetyConfirmations)) {
  assert.equal(value, true, 'configDomain safety confirmation ' + key + ' must be true');
}
assert.equal(embeddedExecutionStability.configDomain.aggregateDecision, 'PASS/Active');

// Workspace hygiene gate (E3)
assert.ok(embeddedExecutionStability.workspaceHygiene, 'must contain workspaceHygiene');
assert.equal(embeddedExecutionStability.workspaceHygiene.gateId, 'E3');
assert.ok(Array.isArray(embeddedExecutionStability.workspaceHygiene.workspaceAlignment) && embeddedExecutionStability.workspaceHygiene.workspaceAlignment.length >= 3);
for (const alignment of embeddedExecutionStability.workspaceHygiene.workspaceAlignment) {
  assert.ok(alignment.invariant, 'workspaceAlignment must have an invariant');
  assert.ok(alignment.passCondition, 'workspaceAlignment must have a passCondition');
  assert.ok(alignment.failClosedCondition, 'workspaceAlignment must have a failClosedCondition');
}
assert.ok(Array.isArray(embeddedExecutionStability.workspaceHygiene.denyPaths) && embeddedExecutionStability.workspaceHygiene.denyPaths.length >= 5);
assert.ok(embeddedExecutionStability.workspaceHygiene.denyPaths.includes('AGENTS.md'), 'denyPaths must include AGENTS.md');
assert.ok(embeddedExecutionStability.workspaceHygiene.denyPaths.includes('.openclaw/**'), 'denyPaths must include .openclaw/**');
assert.ok(Array.isArray(embeddedExecutionStability.workspaceHygiene.preExecutionHygiene) && embeddedExecutionStability.workspaceHygiene.preExecutionHygiene.length >= 2);
assert.ok(Array.isArray(embeddedExecutionStability.workspaceHygiene.postExecutionHygiene) && embeddedExecutionStability.workspaceHygiene.postExecutionHygiene.length >= 2);
for (const check of embeddedExecutionStability.workspaceHygiene.preExecutionHygiene) {
  assert.ok(check.check, 'preExecutionHygiene must have a check name');
  assert.ok(check.passCondition, 'preExecutionHygiene must have a passCondition');
  assert.ok(check.failClosedCondition, 'preExecutionHygiene must have a failClosedCondition');
}
for (const check of embeddedExecutionStability.workspaceHygiene.postExecutionHygiene) {
  assert.ok(check.check, 'postExecutionHygiene must have a check name');
  assert.ok(check.passCondition, 'postExecutionHygiene must have a passCondition');
  assert.ok(check.failClosedCondition, 'postExecutionHygiene must have a failClosedCondition');
}
for (const [key, value] of Object.entries(embeddedExecutionStability.workspaceHygiene.safetyConfirmations)) {
  assert.equal(value, true, 'workspaceHygiene safety confirmation ' + key + ' must be true');
}
assert.equal(embeddedExecutionStability.workspaceHygiene.aggregateDecision, 'PASS/Active');

// Session store guard gate (E4)
assert.ok(embeddedExecutionStability.sessionStoreGuard, 'must contain sessionStoreGuard');
assert.equal(embeddedExecutionStability.sessionStoreGuard.gateId, 'E4');
assert.ok(Array.isArray(embeddedExecutionStability.sessionStoreGuard.readOnlyMountEnforcement) && embeddedExecutionStability.sessionStoreGuard.readOnlyMountEnforcement.length >= 3);
assert.ok(Array.isArray(embeddedExecutionStability.sessionStoreGuard.emptySessionDetection) && embeddedExecutionStability.sessionStoreGuard.emptySessionDetection.length >= 3);
for (const invariant of embeddedExecutionStability.sessionStoreGuard.readOnlyMountEnforcement) {
  assert.ok(invariant.invariant, 'readOnlyMountEnforcement must have an invariant');
  assert.ok(invariant.passCondition, 'readOnlyMountEnforcement must have a passCondition');
  assert.ok(invariant.failClosedCondition, 'readOnlyMountEnforcement must have a failClosedCondition');
}
for (const invariant of embeddedExecutionStability.sessionStoreGuard.emptySessionDetection) {
  assert.ok(invariant.invariant, 'emptySessionDetection must have an invariant');
  assert.ok(invariant.passCondition, 'emptySessionDetection must have a passCondition');
  assert.ok(invariant.failClosedCondition, 'emptySessionDetection must have a failClosedCondition');
}
assert.ok(embeddedExecutionStability.sessionStoreGuard.backupBuildupDetection, 'must contain backupBuildupDetection');
assert.ok(typeof embeddedExecutionStability.sessionStoreGuard.backupBuildupDetection.maxBackupCount === 'number' && embeddedExecutionStability.sessionStoreGuard.backupBuildupDetection.maxBackupCount > 0);
assert.ok(typeof embeddedExecutionStability.sessionStoreGuard.backupBuildupDetection.maxBackupBytes === 'number' && embeddedExecutionStability.sessionStoreGuard.backupBuildupDetection.maxBackupBytes > 0);
assert.ok(Array.isArray(embeddedExecutionStability.sessionStoreGuard.backupBuildupDetection.invariants) && embeddedExecutionStability.sessionStoreGuard.backupBuildupDetection.invariants.length >= 3);
for (const [key, value] of Object.entries(embeddedExecutionStability.sessionStoreGuard.safetyConfirmations)) {
  assert.equal(value, true, 'sessionStoreGuard safety confirmation ' + key + ' must be true');
}
assert.equal(embeddedExecutionStability.sessionStoreGuard.aggregateDecision, 'PASS/Active');

// Post-completion fail-closed gate (E5)
assert.ok(embeddedExecutionStability.postCompletionFailClosed, 'must contain postCompletionFailClosed');
assert.equal(embeddedExecutionStability.postCompletionFailClosed.gateId, 'E5');
assert.ok(Array.isArray(embeddedExecutionStability.postCompletionFailClosed.failureModes) && embeddedExecutionStability.postCompletionFailClosed.failureModes.length >= 3);
const failureModeSet = new Set(embeddedExecutionStability.postCompletionFailClosed.failureModes.map((m) => m.mode));
assert.ok(failureModeSet.has('bootstrap leak'), 'failureModes must include bootstrap leak');
assert.ok(failureModeSet.has('no changes produced'), 'failureModes must include no changes produced');
assert.ok(failureModeSet.has('config mount missing'), 'failureModes must include config mount missing');
for (const mode of embeddedExecutionStability.postCompletionFailClosed.failureModes) {
  assert.ok(typeof mode.exitCode === 'number', mode.mode + ' must have a numeric exitCode');
  assert.ok(mode.evidenceKind, mode.mode + ' must have evidenceKind');
  assert.ok(mode.description, mode.mode + ' must have a description');
  assert.ok(mode.failClosedCondition, mode.mode + ' must have a failClosedCondition');
}
for (const [key, value] of Object.entries(embeddedExecutionStability.postCompletionFailClosed.safetyConfirmations)) {
  assert.equal(value, true, 'postCompletionFailClosed safety confirmation ' + key + ' must be true');
}
assert.equal(embeddedExecutionStability.postCompletionFailClosed.aggregateDecision, 'PASS/Active');

// Aggregate gate decision
assert.equal(embeddedExecutionStability.aggregateGateDecision, 'PASS/Active');
for (const [key, value] of Object.entries(embeddedExecutionStability.safetyConfirmations)) {
  assert.equal(value, true, 'embeddedExecutionStability safety confirmation ' + key + ' must be true');
}
assert.ok(Array.isArray(embeddedExecutionStability.validationCommands) && embeddedExecutionStability.validationCommands.length >= 1);
assert.ok(embeddedExecutionStability.validationCommands.includes('node test/conformance/check-contract-fixtures.mjs'));
assert.equal(embeddedExecutionStability.redacted, true);

// Forbidden runtime paths check for embedded execution stability fixture
const eesFixtureText = fs.readFileSync(path.join(fixtureDir, 'embedded-execution-stability-policy.json'), 'utf8');
for (const forbiddenPath of forbiddenRuntimePaths) {
  assert.ok(
    !eesFixtureText.includes(forbiddenPath),
    'embedded-execution-stability-policy fixture must not reference OpenClaw runtime/bootstrap path ' + forbiddenPath,
  );
}

// --- Worker Capability Profile fixture validation ---

assert.ok(workerCapabilityProfile.fixtureId, 'workerCapabilityProfile must carry fixtureId');
assert.equal(workerCapabilityProfile.contract, 'contracts/a2a/worker-capability-profile.md');
assert.equal(workerCapabilityProfile.issue, 'a2a-plane#382 (internal tracker, private)');
assert.equal(workerCapabilityProfile.parentIssue, 'a2a-plane#380 (internal tracker, private)');
assert.ok(workerCapabilityProfile.v0Freeze, 'workerCapabilityProfile must carry v0Freeze marker');
assert.ok(workerCapabilityProfile.v0Freeze.frozenAt, 'workerCapabilityProfile v0Freeze must include frozenAt');

// Profiles array must be present with at least one entry
assert.ok(Array.isArray(workerCapabilityProfile.profiles) && workerCapabilityProfile.profiles.length >= 1);
const profileWorkerNames = new Set(workerCapabilityProfile.profiles.map((p) => p.workerName));
for (const profile of workerCapabilityProfile.profiles) {
  assert.match(profile.workerName, workerNamePattern, 'unsafe workerName ' + profile.workerName);
  // freshnessTimestamp is required
  assert.ok(profile.freshnessTimestamp, 'freshnessTimestamp is required');
  assert.ok(Date.parse(profile.freshnessTimestamp), 'freshnessTimestamp must be valid ISO-8601');
  // No forbidden fields
  for (const forbidden of workerCapabilityProfile.forbiddenProfileFields) {
    assert.ok(!(forbidden in profile), 'profile must not include forbidden field ' + forbidden);
  }
}

// Assignment recommendations array must be present with at least one entry
assert.ok(Array.isArray(workerCapabilityProfile.assignmentRecommendations)
  && workerCapabilityProfile.assignmentRecommendations.length >= 1);
for (const rec of workerCapabilityProfile.assignmentRecommendations) {
  assert.ok(rec.scenario, 'each recommendation must have a scenario name');
  assert.ok(profileWorkerNames.has(rec.workerName), 'recommendation ' + rec.scenario + ' must reference a defined profile worker');
  assert.ok(typeof rec.recommended === 'boolean', 'recommended must be boolean');
  assert.ok(rec.recommendationReason, 'recommendationReason must be a string');
  assert.ok(typeof rec.operatorOverrideAllowed === 'boolean', 'operatorOverrideAllowed must be boolean');
  // staleProfileTimeoutMs must be a positive number
  assert.ok(typeof rec.staleProfileTimeoutMs === 'number' && rec.staleProfileTimeoutMs > 0);
  assert.ok(typeof rec.staleProfileHardTimeoutMs === 'number' && rec.staleProfileHardTimeoutMs > 0);
  // If profile is stale, freshness must exceed hard timeout
  if (rec.profileStale) {
    const freshnessMs = rec.profileFreshnessSeconds * 1000;
    assert.ok(freshnessMs > rec.staleProfileHardTimeoutMs || freshnessMs > rec.staleProfileTimeoutMs,
      'stale profile ' + rec.scenario + ' must have freshness > timeout');
  }
  // No forbidden fields in recommendation
  for (const forbidden of workerCapabilityProfile.forbiddenProfileFields) {
    assert.ok(!(forbidden in rec), 'recommendation must not include forbidden field ' + forbidden);
  }
}

// Terminal Brief slow lane examples must be present
assert.ok(Array.isArray(workerCapabilityProfile.terminalBriefSlowLaneExamples)
  && workerCapabilityProfile.terminalBriefSlowLaneExamples.length >= 1);
for (const example of workerCapabilityProfile.terminalBriefSlowLaneExamples) {
  assert.ok(example.scenario, 'each slow lane example must have a scenario name');
  const hasSummary = 'terminalSummary' in example;
  const hasBlocker = 'blockerReason' in example;
  const hasAssertion = 'assertion' in example;
  assert.ok(hasSummary || hasBlocker || hasAssertion,
    'slow lane example ' + example.scenario + ' must have terminalSummary, blockerReason, or assertion');
}

// Stale profile policy exists
assert.ok(workerCapabilityProfile.staleProfilePolicy, 'staleProfilePolicy must be defined');
assert.equal(workerCapabilityProfile.staleProfilePolicy.staleProfilesMustNotBeUsedForCapacityCriticalAssignments, true);
assert.equal(workerCapabilityProfile.staleProfilePolicy.neverCausesBrokerCrashOrAssignmentDeadlock, true);

// Safety confirmations
for (const [key, value] of Object.entries(workerCapabilityProfile.safetyConfirmations)) {
  assert.equal(value, true, 'workerCapabilityProfile safety confirmation ' + key + ' must be true');
}

// Validation commands must include conformance test
assert.ok(workerCapabilityProfile.validationCommands.includes('node test/conformance/check-contract-fixtures.mjs'),
  'validationCommands must reference conformance test');

// Forbidden runtime paths from fixture
const wcpFixtureText = fs.readFileSync(path.join(fixtureDir, 'worker-capability-profile.json'), 'utf8');
for (const forbiddenPath of forbiddenRuntimePaths) {
  assert.ok(
    !wcpFixtureText.includes(forbiddenPath),
    'worker-capability-profile fixture must not reference OpenClaw runtime/bootstrap path ' + forbiddenPath,
  );
}


// ─── Adapter receipt capability ──────────────────────────────────────

assert.equal(
  adapterReceiptCapability.contract,
  'contracts/a2a/adapter-receipt-capability.md',
  'adapterReceiptCapability must reference adapter-receipt-capability.md',
);
assert.equal(adapterReceiptCapability.fixtureId, 'a2a-nexus.adapter-receipt-capability.v0');
assert.ok(adapterReceiptCapability.v0Freeze, 'must carry v0Freeze marker');
assert.equal(adapterReceiptCapability.v0Freeze.lane, '6/7');
assert.equal(adapterReceiptCapability.v0Freeze.run, 'a2a-terminal-brief-productization-20260522T225813Z');
assert.ok(adapterReceiptCapability.v0Freeze.frozenAt, 'v0Freeze must include frozenAt');

// Adapter types
assert.ok(Array.isArray(adapterReceiptCapability.adapterTypes)
  && adapterReceiptCapability.adapterTypes.length >= 3);
const adapterTypeIds = new Set(adapterReceiptCapability.adapterTypes.map((t) => t.id));
assert.ok(adapterTypeIds.has('python-telegram-bot'), 'must include python-telegram-bot adapter');
assert.ok(adapterTypeIds.has('go-webhook-bridge'), 'must include go-webhook-bridge adapter');
assert.ok(adapterTypeIds.has('cli-file-outbox'), 'must include cli-file-outbox adapter');

// Capability levels (C1–C6, exactly 6 levels)
assert.ok(Array.isArray(adapterReceiptCapability.capabilityLevels)
  && adapterReceiptCapability.capabilityLevels.length === 6,
  'must define exactly 6 capability levels (C1–C6)',
);
const levelById = new Map(adapterReceiptCapability.capabilityLevels.map((l) => [l.level, l]));
for (const id of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']) {
  assert.ok(levelById.has(id), 'must define level ' + id);
}

// C1 (produced) and C2 (spooled) are receipt level 0, not ACK-safe
assert.equal(levelById.get('C1').receiptLevel, 0, 'C1 produced must map to receipt level 0');
assert.equal(levelById.get('C1').ackSafe, false, 'C1 must not be ACK-safe');
assert.equal(levelById.get('C2').receiptLevel, 0, 'C2 spooled must map to receipt level 0');
assert.equal(levelById.get('C2').ackSafe, false, 'C2 must not be ACK-safe');

// C3 (provider_only) maps to receipt level 1 (accepted-send)
assert.equal(levelById.get('C3').receiptLevel, 1, 'C3 provider_only must map to receipt level 1');
assert.equal(levelById.get('C3').ackSafe, false, 'C3 must not be ACK-safe');

// C4 (requester_visible) maps to receipt level 2
assert.equal(levelById.get('C4').receiptLevel, 2, 'C4 requester_visible must map to receipt level 2');
assert.equal(levelById.get('C4').ackSafe, false);

// C5 (operator_visible) maps to receipt level 3
assert.equal(levelById.get('C5').receiptLevel, 3, 'C5 operator_visible must map to receipt level 3');
assert.equal(levelById.get('C5').ackSafe, false);

// C6 (operator_confirmed) maps to receipt level 4 and is ACK-safe
assert.equal(levelById.get('C6').receiptLevel, 4, 'C6 operator_confirmed must map to receipt level 4');
assert.equal(levelById.get('C6').ackSafe, true, 'C6 must be ACK-safe');

// No new receipt levels introduced beyond {0, 1, 2, 3, 4}
const mappedLevels = new Set(adapterReceiptCapability.capabilityLevels.map((l) => l.receiptLevel));
assert.deepEqual([...mappedLevels].sort(), [0, 1, 2, 3, 4],
  'capability levels must only map to existing receipt levels {0, 1, 2, 3, 4}',
);

// Scenarios
assert.ok(Array.isArray(adapterReceiptCapability.scenarios)
  && adapterReceiptCapability.scenarios.length >= 8,
  'must define at least 8 scenarios',
);

const adapterScenarioByName = new Map(
  adapterReceiptCapability.scenarios.map((s) => [s.name, s]),
);

// cli-produced-only-no-send: receiptLevel 0, not ack-safe
const producedScenario = adapterScenarioByName.get('cli-produced-only-no-send');
assert.ok(producedScenario, 'must define cli-produced-only-no-send scenario');
assert.equal(producedScenario.expect.receiptLevel, 0);
assert.equal(producedScenario.expect.ackSafe, false);
assert.equal(producedScenario.expect.terminalOutboxAckMutated, false);

// spooled-to-sqlite-not-delivered: receiptLevel 0, not ack-safe
const spooledScenario = adapterScenarioByName.get('spooled-to-sqlite-not-delivered');
assert.ok(spooledScenario, 'must define spooled-to-sqlite-not-delivered scenario');
assert.equal(spooledScenario.expect.receiptLevel, 0);
assert.equal(spooledScenario.expect.ackSafe, false);
assert.equal(spooledScenario.given.spoolDurable, true, 'spool must be durable for C2');

// provider-only-accepted-send-non-ack: receiptLevel 1, not ack-safe
const providerOnlyScenario = adapterScenarioByName.get('provider-only-accepted-send-non-ack');
assert.ok(providerOnlyScenario, 'must define provider-only-accepted-send-non-ack scenario');
assert.equal(providerOnlyScenario.expect.receiptLevel, 1);
assert.equal(providerOnlyScenario.expect.ackSafe, false);
assert.equal(providerOnlyScenario.expect.terminalAckMayBeRecorded, false);
assert.ok(providerOnlyScenario.expect.reasonCodes.includes('manual-or-visible-receipt-required'));

// provider-only-go-webhook-non-ack: receiptLevel 1, not ack-safe
const webhookScenario = adapterScenarioByName.get('provider-only-go-webhook-non-ack');
assert.ok(webhookScenario, 'must define provider-only-go-webhook-non-ack scenario');
assert.equal(webhookScenario.expect.receiptLevel, 1);
assert.equal(webhookScenario.expect.ackSafe, false);

// requester-visible-github-comment: receiptLevel 2, not ack-safe
const requesterVisibleScenario = adapterScenarioByName.get('requester-visible-github-comment');
assert.ok(requesterVisibleScenario, 'must define requester-visible-github-comment scenario');
assert.equal(requesterVisibleScenario.expect.receiptLevel, 2);
assert.equal(requesterVisibleScenario.expect.ackSafe, false);
assert.ok(requesterVisibleScenario.given.commentUrl, 'requester visible must include commentUrl');

// operator-visible-manual-receipt: receiptLevel 3, not ack-safe
const operatorVisibleScenario = adapterScenarioByName.get('operator-visible-manual-receipt');
assert.ok(operatorVisibleScenario, 'must define operator-visible-manual-receipt scenario');
assert.equal(operatorVisibleScenario.expect.receiptLevel, 3);
assert.equal(operatorVisibleScenario.expect.ackSafe, false);
assert.equal(operatorVisibleScenario.expect.terminalAckMayBeRecorded, false);
assert.ok(operatorVisibleScenario.expect.reasonCodes.includes('parent-broker-required-for-ack-mutation'));

// operator-confirmed-with-ack-safe-proof: receiptLevel 4, ack-safe
const confirmedScenario = adapterScenarioByName.get('operator-confirmed-with-ack-safe-proof');
assert.ok(confirmedScenario, 'must define operator-confirmed-with-ack-safe-proof scenario');
assert.equal(confirmedScenario.expect.receiptLevel, 4);
assert.equal(confirmedScenario.expect.ackSafe, true);
assert.equal(confirmedScenario.expect.terminalAckMayBeRecorded, true);
assert.equal(confirmedScenario.expect.terminalOutboxAckMutated, false);
assert.ok(confirmedScenario.given.ackSafeReceiptProof, 'C6 scenario must have ackSafeReceiptProof');
assert.equal(confirmedScenario.given.ackSafeReceiptProof.receiptType, 'manual_operator_receipt');

// skip-to-ack-violation: violation detected
const skipToAckScenario = adapterScenarioByName.get('skip-to-ack-violation');
assert.ok(skipToAckScenario, 'must define skip-to-ack-violation scenario');
assert.equal(skipToAckScenario.expect.violation, true);
assert.equal(skipToAckScenario.expect.receiptLevel, 0, 'skip-to-ack must default to receipt level 0');
assert.ok(skipToAckScenario.expect.reasonCodes.includes('ack-safe-receipt-proof-required'));

// provider-message-id-is-non-ack-even-at-C6: even at ACK-capable level, providerMessageId is non-ACK
const providerMsgIdScenario = adapterScenarioByName.get('provider-message-id-is-non-ack-even-at-C6');
assert.ok(providerMsgIdScenario, 'must define provider-message-id-is-non-ack-even-at-C6 scenario');
assert.equal(providerMsgIdScenario.expect.providerAcceptedIsAck, false);
assert.equal(providerMsgIdScenario.expect.providerMessageIdIsAck, false);

// adapter-cannot-mutate-terminal-outbox-ack: violation detected
const outboxMutationScenario = adapterScenarioByName.get('adapter-cannot-mutate-terminal-outbox-ack');
assert.ok(outboxMutationScenario, 'must define adapter-cannot-mutate-terminal-outbox-ack scenario');
assert.equal(outboxMutationScenario.expect.violation, true);
assert.equal(outboxMutationScenario.expect.ackSafe, false);
assert.equal(outboxMutationScenario.expect.terminalOutboxAckMutated, false, 'must force to false');
assert.ok(outboxMutationScenario.expect.reasonCodes.includes('non-openclaw-adapter-cannot-claim-ack-mutation'));

// Every scenario must have terminalOutboxAckMutated: false
for (const scenario of adapterReceiptCapability.scenarios) {
  assert.equal(scenario.expect.terminalOutboxAckMutated, false,
    scenario.name + ': terminalOutboxAckMutated must be false for all non-OpenClaw adapters',
  );
}

// C3+ scenarios must not claim receipt level 4 unless they have ackSafeReceiptProof
for (const scenario of adapterReceiptCapability.scenarios) {
  if (scenario.given.adapterReceiptLevel === 'provider_only'
      && scenario.given.ackSafeReceiptProof === null) {
    assert.ok(scenario.expect.receiptLevel <= 2,
      scenario.name + ': provider_only without ackSafeReceiptProof must not claim receiptLevel > 2',
    );
  }
}

// Safety confirmations
for (const [key, value] of Object.entries(adapterReceiptCapability.safetyConfirmations)) {
  assert.equal(value, true,
    'adapterReceiptCapability safety confirmation ' + key + ' must be true',
  );
}

// Forbidden runtime paths from fixture
const arcFixtureText = fs.readFileSync(
  path.join(fixtureDir, 'adapter-receipt-capability.json'),
  'utf8',
);
for (const forbiddenPath of forbiddenRuntimePaths) {
  assert.ok(
    !arcFixtureText.includes(forbiddenPath),
    'adapter-receipt-capability fixture must not reference OpenClaw runtime/bootstrap path ' + forbiddenPath,
  );
}

// No secret patterns in adapter-receipt-capability fixture
for (const pattern of secretLikePatterns) {
  assert.ok(
    !pattern.test(arcFixtureText),
    'adapter-receipt-capability fixture matched forbidden secret pattern ' + pattern,
  );
}

// Harness-neutral source-only analysis adapter contract (#666)
assert.equal(harnessNeutralAnalysisAdapter.meta.contract, 'harness-neutral-analysis-adapter');
assert.equal(harnessNeutralAnalysisAdapter.meta.issue, 'https://github.com/jinwon-int/a2a-nexus/issues/666');
assert.equal(harnessNeutralAnalysisAdapter.requiredTaskInputs.intent, 'analyze');
assert.equal(harnessNeutralAnalysisAdapter.requiredTaskInputs.taskOrigin, 'github');
assert.equal(harnessNeutralAnalysisAdapter.requiredTaskInputs.payloadFlags.noLive, true);
assert.equal(harnessNeutralAnalysisAdapter.requiredTaskInputs.payloadFlags.sourceOnly, true);
assert.equal(harnessNeutralAnalysisAdapter.requiredTaskInputs.payloadFlags.readOnlyValidation, true);

const requiredRoundFields = new Set(harnessNeutralAnalysisAdapter.requiredTaskInputs.roundMetadata);
for (const field of ['parentRoundId', 'parentRoundTotal', 'parentRoundOrder', 'originBrokerId', 'brokerOfRecordId']) {
  assert.ok(requiredRoundFields.has(field), 'harness-neutral analysis task must require ' + field);
}

assert.deepEqual(
  [...harnessNeutralAnalysisAdapter.evidenceClasses].sort(),
  [
    'handler_artifact_failure',
    'provider_or_model_failure',
    'queued_unclaimed',
    'source_blocked',
    'substantive',
    'wrapper_only',
  ],
  'harness-neutral analysis evidence classes must be explicit and closed',
);

const hnaScenarios = new Map(harnessNeutralAnalysisAdapter.scenarios.map((scenario) => [scenario.name, scenario]));
for (const name of [
  'substantive-analysis',
  'wrapper-only-success',
  'source-mapping-blocked',
  'handler-artifact-failure',
  'queued-unclaimed-lane',
  'provider-model-failure',
]) {
  assert.ok(hnaScenarios.has(name), 'missing harness-neutral analysis scenario ' + name);
}

assert.equal(hnaScenarios.get('substantive-analysis').output.analysisStatus, 'done');
assert.equal(hnaScenarios.get('substantive-analysis').output.evidenceClass, 'substantive');
assert.equal(hnaScenarios.get('substantive-analysis').expect.countsAsWorkerOpinion, true);
assert.ok(hnaScenarios.get('substantive-analysis').output.findings.length > 0);
assert.ok(hnaScenarios.get('substantive-analysis').output.evidenceRefs.length > 0);

for (const name of [
  'wrapper-only-success',
  'source-mapping-blocked',
  'handler-artifact-failure',
  'queued-unclaimed-lane',
  'provider-model-failure',
]) {
  const scenario = hnaScenarios.get(name);
  assert.equal(scenario.expect.countsAsWorkerOpinion, false, name + ' must not count as worker opinion');
  assert.equal(scenario.output.findings.length, 0, name + ' must not carry substantive findings');
}

assert.ok(
  harnessNeutralAnalysisAdapter.finalizerAssertions.includes('Only substantive lanes count as worker opinions.'),
  'harness-neutral analysis finalizer assertions must preserve substantive-only counting',
);

const hnaFixtureText = fs.readFileSync(
  path.join(fixtureDir, 'harness-neutral-analysis-adapter.json'),
  'utf8',
);
for (const forbiddenPath of forbiddenRuntimePaths) {
  assert.ok(
    !hnaFixtureText.includes(forbiddenPath),
    'harness-neutral-analysis-adapter fixture must not reference OpenClaw runtime/bootstrap path ' + forbiddenPath,
  );
}
for (const pattern of secretLikePatterns) {
  assert.ok(
    !pattern.test(hnaFixtureText),
    'harness-neutral-analysis-adapter fixture matched forbidden secret pattern ' + pattern,
  );
}


console.log(JSON.stringify({
  ok: true,
  checkedFixtures: Object.values(fixtureFiles).map((file) => `fixtures/contract/${file}`),
  compatibilityExample: 'examples/compatibility/cross-team-conformance.json',
}));
