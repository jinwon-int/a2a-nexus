#!/usr/bin/env node
/**
 * Parent-round closeout go/no-go matrix validator.
 *
 * Validates the fixture against the go/no-go matrix schema by running through
 * each scenario and checking that the decision (GO/NO_GO/BLOCKED) and gate
 * results match expectations.
 *
 * Source-only/no-live: This script never executes approval, release, visibility
 * changes, live provider sends, deploys, restarts, DB mutations, terminal ACKs,
 * or production closeout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    spec: { type: 'string', default: 'docs/specs/a2a-parent-round-closeout-go-nogo/schema.json' },
    fixture: { type: 'string' },
    format: { type: 'string', default: 'json' },
    mode: { type: 'string', default: 'dry-run' },
  },
});

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read JSON ${file}: ${error.message}`);
  }
}

/**
 * Validate the schema itself is structurally sound.
 */
function validateSpec(spec) {
  const failures = [];
  if (spec.failClosed !== true) failures.push('spec.failClosed must be true');
  if (!spec.decisionOutputs || !Array.isArray(spec.decisionOutputs)) {
    failures.push('spec.decisionOutputs must be an array');
  } else {
    for (const output of ['GO', 'NO_GO', 'BLOCKED']) {
      if (!spec.decisionOutputs.includes(output)) failures.push(`spec.decisionOutputs missing ${output}`);
    }
  }
  if (spec.defaultDecision !== 'NO_GO') failures.push('spec.defaultDecision must be NO_GO');
  if (spec.sourcePublicExecution !== 'NO_GO') failures.push('spec.sourcePublicExecution must be NO_GO');
  if (!spec.allowedModes || !spec.allowedModes.includes('comment_only')) {
    failures.push('spec.allowedModes must include comment_only');
  }
  if (!Array.isArray(spec.goDecisionRequires) || spec.goDecisionRequires.length === 0) {
    failures.push('spec.goDecisionRequires must list required GO gates');
  }
  if (!Array.isArray(spec.gates) || spec.gates.length === 0) failures.push('spec.gates must be non-empty');

  const requiredGates = new Set(spec.goDecisionRequires || []);
  const definedGates = new Map((spec.gates || []).map((g) => [g.id, g]));

  for (const id of requiredGates) {
    if (!definedGates.has(id)) failures.push(`required gate missing from spec.gates: ${id}`);
  }

  for (const gate of spec.gates || []) {
    if (gate.failClosed !== true) failures.push(`${gate.id}: failClosed must be true`);
    if (gate.requiredForGo !== true) failures.push(`${gate.id}: requiredForGo must be true`);
  }

  const denyPaths = new Set(spec.runtimeBootstrapDenyPaths || []);
  for (const requiredPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    if (!denyPaths.has(requiredPath)) failures.push(`runtimeBootstrapDenyPaths missing ${requiredPath}`);
  }

  const forbidden = new Set(spec.forbiddenLiveFlags || []);
  for (const flag of [
    'approvalExecution', 'releasePublication', 'repositoryVisibilityChange',
    'productionDeploy', 'gatewayRestart', 'brokerRestart', 'workerRestart',
    'terminalAck', 'liveProviderSend', 'productionDbMutation', 'forcePush',
    'communityPost', 'automaticMerge', 'automaticApproval',
    'parentIssueClose', 'credentialMovement', 'secretDisclosure',
    'historicalOutboxReplay', 'releaseTagPublish',
    'closeoutIssueClose', 'closeoutPrMerge', 'manualTerminalBriefAck',
    'historicalOutboxAckReplay',
  ]) {
    if (!forbidden.has(flag)) failures.push(`forbiddenLiveFlags missing ${flag}`);
  }

  return failures;
}

/**
 * Evaluate a single scenario against the matrix and return the decision + gate results.
 */
function evaluateScenario(spec, scenario) {
  const given = scenario.given;
  const gateResults = {};
  const blockers = [];

  // G1: All lanes terminal
  if (given.parentRoundProgress >= given.parentRoundTotal) {
    const nonTerminal = (given.lanes || []).filter(
      (l) => l.laneState === 'queued' || l.laneState === 'claimed' || l.laneState === 'running'
    );
    gateResults.allLanesTerminal = nonTerminal.length === 0 ? 'PASS' : 'FAIL';
  } else {
    gateResults.allLanesTerminal = 'FAIL';
  }
  if (gateResults.allLanesTerminal === 'FAIL') {
    blockers.push({ gate: 'allLanesTerminal', reason: spec.gates.find(g => g.id === 'allLanesTerminal')?.failedWhenMissing });
  }

  // G2: Lane evidence completeness
  const missingEvidence = (given.lanes || []).filter((l) => l.terminalKind && !l.evidenceComplete);
  gateResults.laneEvidenceCompleteness = missingEvidence.length === 0 ? 'PASS' : 'FAIL';
  if (gateResults.laneEvidenceCompleteness === 'FAIL') {
    blockers.push({ gate: 'laneEvidenceCompleteness', reason: spec.gates.find(g => g.id === 'laneEvidenceCompleteness')?.failedWhenMissing });
  }

  // G3: Required metadata present
  gateResults.requiredMetadataPresent = given.metadataComplete ? 'PASS' : 'FAIL';
  if (gateResults.requiredMetadataPresent === 'FAIL') {
    blockers.push({ gate: 'requiredMetadataPresent', reason: spec.gates.find(g => g.id === 'requiredMetadataPresent')?.failedWhenMissing });
  }

  // G4: Evidence redaction
  const unredacted = (given.lanes || []).filter((l) => l.terminalKind && l.evidenceComplete && l.redacted === false);
  gateResults.evidenceRedaction = unredacted.length === 0 ? 'PASS' : 'BLOCKED';
  if (gateResults.evidenceRedaction === 'BLOCKED') {
    blockers.push({ gate: 'evidenceRedaction', reason: spec.gates.find(g => g.id === 'evidenceRedaction')?.blockedWhenMissing });
  }

  // G5: Runtime/bootstrap hygiene
  gateResults.runtimeBootstrapHygiene = given.bootstrapHygiene ? 'PASS' : 'BLOCKED';
  if (gateResults.runtimeBootstrapHygiene === 'BLOCKED') {
    const leakPaths = given.bootstrapLeakPaths || [];
    blockers.push({
      gate: 'runtimeBootstrapHygiene',
      reason: 'Runtime/bootstrap context files would enter branch diff, PR text, issue comment, or artifact evidence.',
      paths: leakPaths,
    });
  }

  // G6: No live action leak
  const liveActionLeaks = (given.lanes || []).filter(
    (l) => l.terminalKind && l.noLiveActionLeak === false
  );
  gateResults.noLiveActionLeak = liveActionLeaks.length === 0 ? 'PASS' : 'FAIL';
  if (gateResults.noLiveActionLeak === 'FAIL') {
    blockers.push({ gate: 'noLiveActionLeak', reason: spec.gates.find(g => g.id === 'noLiveActionLeak')?.failedWhenMissing });
  }

  // G7: GitHub permission check
  if (given.gitHub403) {
    gateResults.gitHubPermissionCheck = 'BLOCKED';
    blockers.push({
      gate: 'gitHubPermissionCheck',
      reason: given.gitHub403Summary || 'GitHub API returned 403',
      operation: given.gitHub403Operation,
    });
  } else {
    gateResults.gitHubPermissionCheck = 'PASS';
  }

  // G8: Idempotency check
  if (given.idempotencyConflict) {
    gateResults.idempotencyCheck = 'BLOCKED';
    blockers.push({ gate: 'idempotencyCheck', reason: 'Conflicting idempotency key: same key but different payload.' });
  } else if (given.idempotencyKeyExists && given.idempotencyKeyPayloadMatches) {
    gateResults.idempotencyCheck = 'PASS';
    // Duplicate suppressed is noted but does not change PASS
  } else {
    gateResults.idempotencyCheck = 'PASS';
  }

  // G9: brokerAlpha finalizer
  gateResults.seoseoFinalizer = given.evaluatingBroker === 'brokerAlpha' ? 'PASS' : 'FAIL';
  if (gateResults.seoseoFinalizer === 'FAIL') {
    blockers.push({ gate: 'seoseoFinalizer', reason: spec.gates.find(g => g.id === 'seoseoFinalizer')?.failedWhenMissing });
  }

  // G10: Cross-lane projection status
  const blockedProjections = (given.lanes || []).filter(
    (l) => l.terminalKind && l.projectionState === 'blocked'
  );
  const pendingProjections = (given.lanes || []).filter(
    (l) => l.terminalKind && l.projectionState === 'pending'
  );
  if (blockedProjections.length > 0) {
    gateResults.crossLaneProjectionStatus = 'BLOCKED';
    blockers.push({
      gate: 'crossLaneProjectionStatus',
      reason: 'One or more lane parent projections have state blocked.',
      blockedLaneIds: blockedProjections.map(l => l.laneId),
    });
  } else if (pendingProjections.length > 0) {
    gateResults.crossLaneProjectionStatus = 'FAIL';
    blockers.push({
      gate: 'crossLaneProjectionStatus',
      reason: 'One or more lane parent projections have state pending.',
      pendingLaneIds: pendingProjections.map(l => l.laneId),
    });
  } else {
    gateResults.crossLaneProjectionStatus = 'PASS';
  }

  // G11: Comment-only gate
  const closeoutMode = given.closeoutMode || 'dry-run';
  if (closeoutMode === 'comment_only') {
    if (!given.draftCommentBody) {
      gateResults.commentOnlyGate = 'FAIL';
      blockers.push({
        gate: 'commentOnlyGate',
        reason: 'comment_only mode requires a non-empty draft comment body.',
      });
    } else if (gateResults.gitHubPermissionCheck === 'BLOCKED') {
      gateResults.commentOnlyGate = 'BLOCKED';
      // permission failure already recorded in G7
    } else if (gateResults.idempotencyCheck === 'BLOCKED') {
      gateResults.commentOnlyGate = 'BLOCKED';
      // idempotency conflict already recorded in G8
    } else if (gateResults.idempotencyCheck === 'PASS' && given.idempotencyKeyExists && given.idempotencyKeyPayloadMatches) {
      // Duplicate suppression: comment gate passes but no new post
      gateResults.commentOnlyGate = 'PASS';
    } else {
      gateResults.commentOnlyGate = 'PASS';
    }
  } else {
    // Non-comment-only modes always pass the comment gate
    gateResults.commentOnlyGate = 'PASS';
  }

  // Determine overall decision
  const blockedGates = Object.entries(gateResults).filter(([, v]) => v === 'BLOCKED');
  const failedGates = Object.entries(gateResults).filter(([, v]) => v === 'FAIL');

  let decision;
  if (blockedGates.length > 0) {
    decision = 'BLOCKED';
  } else if (failedGates.length > 0) {
    decision = 'NO_GO';
  } else {
    decision = 'GO';
  }

  const isDuplicate = !!(given.idempotencyKeyExists && given.idempotencyKeyPayloadMatches);
  const isCommentOnly = closeoutMode === 'comment_only';

  // In comment_only mode, closeoutAllowed is always false (no issue close/merge)
  // But commentPosted may be true if gates pass
  const closeoutAllowed = decision === 'GO'
    && given.evaluatingBroker === 'brokerAlpha'
    && !given.gitHub403
    && !isDuplicate
    && !isCommentOnly;

  // In comment_only mode, commentPosted is true if GO and permission passes.
  // In full closeout mode, commentPosted is true for successful Go closeouts.
  const canPostComment = decision === 'GO'
    && !given.gitHub403
    && !isDuplicate;

  // In comment_only mode: commentPosted depends on draft body and permissions.
  // In full closeout mode: commentPosted is true when the Go closeout comment would be posted.
  // Use explicit given.commentPosted from fixture when available (e.g., 403 after comment post).
  let commentPosted;
  if (given.commentPosted !== undefined) {
    commentPosted = given.commentPosted;
  } else if (isCommentOnly) {
    commentPosted = canPostComment && given.draftCommentBody;
  } else {
    commentPosted = canPostComment && given.evaluatingBroker === 'brokerAlpha';
  }

  const issueClosed = isCommentOnly ? false : closeoutAllowed;

  return {
    decision,
    gateResults,
    commentPosted,
    issueClosed,
    blockers,
    closeoutAllowed,
    duplicateSuppressed: isDuplicate,
    conflictDetected: !!given.idempotencyConflict,
  };
}

/**
 * Verify a scenario result matches the expected outcome.
 */
function verifyScenarioResult(scenarioName, expected, actual) {
  const failures = [];

  if (expected.then.decision !== actual.decision) {
    failures.push(`decision mismatch: expected ${expected.then.decision}, got ${actual.decision}`);
  }

  if (expected.then.gateResults) {
    for (const [gateId, expectedStatus] of Object.entries(expected.then.gateResults)) {
      const actualStatus = actual.gateResults[gateId];
      if (actualStatus !== expectedStatus) {
        failures.push(`gate ${gateId} mismatch: expected ${expectedStatus}, got ${actualStatus}`);
      }
    }
  }

  if (expected.then.blockersPresent && actual.blockers.length === 0) {
    failures.push('expected blockers but none found');
  }
  if (expected.then.blockersPresent === false && actual.blockers.length > 0) {
    failures.push(`expected no blockers but found: ${JSON.stringify(actual.blockers)}`);
  }

  if (expected.then.duplicateSuppressed !== undefined) {
    if (actual.duplicateSuppressed !== expected.then.duplicateSuppressed) {
      failures.push(`duplicateSuppressed mismatch: expected ${expected.then.duplicateSuppressed}, got ${actual.duplicateSuppressed}`);
    }
  }

  if (expected.then.conflictDetected !== undefined) {
    if (actual.conflictDetected !== expected.then.conflictDetected) {
      failures.push(`conflictDetected mismatch: expected ${expected.then.conflictDetected}, got ${actual.conflictDetected}`);
    }
  }

  if (expected.then.closeoutAllowed !== undefined) {
    if (actual.closeoutAllowed !== expected.then.closeoutAllowed) {
      failures.push(`closeoutAllowed mismatch: expected ${expected.then.closeoutAllowed}, got ${actual.closeoutAllowed}`);
    }
  }

  if (expected.then.commentPosted !== undefined) {
    if (actual.commentPosted !== expected.then.commentPosted) {
      failures.push(`commentPosted mismatch: expected ${expected.then.commentPosted}, got ${actual.commentPosted}`);
    }
  }

  if (expected.then.issueClosed !== undefined) {
    if (actual.issueClosed !== expected.then.issueClosed) {
      failures.push(`issueClosed mismatch: expected ${expected.then.issueClosed}, got ${actual.issueClosed}`);
    }
  }

  // Safety flag verification
  for (const flag of ['liveProviderSend', 'terminalOutboxAckMutated', 'isApproval', 'isTerminalAck', 'isReadReceipt']) {
    if (expected.then[flag] !== undefined) {
      // These are always false in a no-live fixture
      if (expected.then[flag] !== false) {
        failures.push(`${flag} was expected to be false in no-live fixture`);
      }
    }
  }

  return failures;
}

try {
  const specPath = path.resolve(values.spec);
  const spec = readJson(specPath);
  const specFailures = validateSpec(spec);
  if (specFailures.length) {
    console.error(JSON.stringify({ ok: false, phase: 'spec', failures: specFailures }, null, 2));
    process.exit(1);
  }

  if (!values.fixture) {
    // Schema-only validation, no fixture provided
    console.log(JSON.stringify({
      ok: true,
      phase: 'spec',
      decision: spec.defaultDecision,
      decisionOutputs: spec.decisionOutputs,
      sourcePublicExecution: spec.sourcePublicExecution,
      gateCount: spec.gates.length,
      requiredGates: spec.goDecisionRequires,
    }, null, 2));
    process.exit(0);
  }

  const fixturePath = path.resolve(values.fixture);
  const fixture = readJson(fixturePath);

  // Validate fixture structure
  const fixtureFailures = [];
  if (!fixture.scenarios || !Array.isArray(fixture.scenarios) || fixture.scenarios.length === 0) {
    fixtureFailures.push('fixture.scenarios must be a non-empty array');
  }
  if (!fixture.parentRoundId) fixtureFailures.push('fixture.parentRoundId is required');
  if (!fixture.originBrokerId) fixtureFailures.push('fixture.originBrokerId is required');
  if (!fixture.parentBrokerId) fixtureFailures.push('fixture.parentBrokerId is required');

  if (fixtureFailures.length) {
    console.error(JSON.stringify({ ok: false, phase: 'fixture', failures: fixtureFailures }, null, 2));
    process.exit(1);
  }

  const results = [];
  let totalFailures = 0;
  let totalScenarios = 0;

  for (const scenario of fixture.scenarios) {
    totalScenarios++;
    const actual = evaluateScenario(spec, scenario);
    const failures = verifyScenarioResult(scenario.name, scenario, actual);

    results.push({
      scenario: scenario.name,
      passed: failures.length === 0,
      expectedDecision: scenario.then.decision,
      actualDecision: actual.decision,
      gateResults: actual.gateResults,
      blockers: actual.blockers,
      failures,
    });

    if (failures.length > 0) {
      totalFailures++;
    }
  }

  const report = {
    ok: totalFailures === 0,
    phase: 'validation',
    spec: specPath,
    fixture: fixturePath,
    totalScenarios,
    passedScenarios: totalScenarios - totalFailures,
    failedScenarios: totalFailures,
    results,
    safetyConfirmations: fixture.safetyConfirmations || {},
    liveProviderSend: false,
    terminalOutboxAckMutated: false,
    isApproval: false,
    isTerminalAck: false,
    isReadReceipt: false,
    decision: totalFailures === 0 ? spec.defaultDecision : 'BLOCKED',
    sourcePublicExecution: spec.sourcePublicExecution,
  };

  if (values.format === 'markdown') {
    const lines = [
      '# Parent-Round Closeout Go/No-Go Matrix Validation Report',
      '',
      `**${report.ok ? '✅ All scenarios passed' : '❌ Some scenarios failed'}**`,
      '',
      `Spec: ${report.spec}`,
      `Fixture: ${report.fixture}`,
      `Total scenarios: ${report.totalScenarios}`,
      `Passed: ${report.passedScenarios}`,
      `Failed: ${report.failedScenarios}`,
      '',
      '## Scenario Results',
      '',
      '| Scenario | Expected | Actual | Passed |',
      '|----------|----------|--------|--------|',
    ];

    for (const r of results) {
      lines.push(`| ${r.scenario} | ${r.expectedDecision} | ${r.actualDecision} | ${r.passed ? '✅' : '❌'} |`);
      if (r.failures.length > 0) {
        lines.push('');
        for (const f of r.failures) {
          lines.push(`- ${f}`);
        }
        lines.push('');
      }
    }

    lines.push(
      '',
      '## Safety',
      '',
      `- Synthetic fixture only: ${report.safetyConfirmations.syntheticFixtureOnly !== false}`,
      `- No production deploy or restart: ${report.safetyConfirmations.noProductionDeployOrRestart !== false}`,
      `- No production DB mutation: ${report.safetyConfirmations.noProductionDatabaseMutation !== false}`,
      `- No live provider send: ${report.liveProviderSend === false}`,
      `- No terminal-outbox ACK mutation: ${report.terminalOutboxAckMutated === false}`,
      `- Default decision: ${report.decision}`,
      `- Source-public execution: ${report.sourcePublicExecution}`,
      '',
      'This is a **validation-only run**. No live actions, no closeout execution.',
      '',
      `Generated: ${new Date().toISOString()}`,
    );

    console.log(lines.join('\n'));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  process.exit(report.ok ? 0 : 1);
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exit(1);
}
