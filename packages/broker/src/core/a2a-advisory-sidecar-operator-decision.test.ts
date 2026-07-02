import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DISABLED_ADVISORY_SIDECAR_RECOMMENDATION,
} from "./a2a-advisory-sidecar-contract.js";
import {
  ADVISORY_SIDECAR_DEFAULT_OFF_BOUNDARY,
} from "./a2a-advisory-sidecar-resolver.js";
import {
  buildAdvisorySidecarOperatorDecisionIdempotencyKey,
  createAdvisorySidecarOperatorDecisionPacket,
} from "./a2a-advisory-sidecar-operator-decision.js";

const NOW = "2026-06-16T04:10:00.000Z";

test("advisory sidecar operator decision packet stays default-off and source-only (#794)", () => {
  const packet = createAdvisorySidecarOperatorDecisionPacket({
    now: NOW,
    decisionOwner: "brokeralpha",
    decisionReference: "issue-794",
    parentRoundId: "a2a-open-cleanup-20260616T040301Z-795",
  });

  assert.equal(packet.kind, "a2a-broker.advisory-sidecar-operator-decision.packet");
  assert.equal(packet.version, 1);
  assert.equal(packet.generatedAt, NOW);
  assert.equal(packet.state, "default_off_operator_decision_ready");
  assert.equal(packet.sourceOnlyNoLive, true);
  assert.equal(packet.advisoryOnly, true);
  assert.equal(packet.defaultOffOnlyExecutableState, true);
  assert.equal(packet.decision.decisionOwner, "brokeralpha");
  assert.equal(packet.decision.decisionReference, "issue-794");
  assert.equal(packet.decision.parentRoundId, "a2a-open-cleanup-20260616T040301Z-795");
  assert.deepEqual(packet.decision.recommendation, DEFAULT_DISABLED_ADVISORY_SIDECAR_RECOMMENDATION);
  assert.deepEqual(packet.decision.boundary, ADVISORY_SIDECAR_DEFAULT_OFF_BOUNDARY);
});

test("advisory sidecar operator decision packet excludes all approval-sensitive execution paths (#794)", () => {
  const packet = createAdvisorySidecarOperatorDecisionPacket({ now: NOW });

  assert.equal(packet.readiness.operatorDecisionPacketReady, true);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.readiness.sidecarStartPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.dispatchPermitted, false);
  assert.equal(packet.readiness.routingChangePermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.readiness.deployRestartPermitted, false);
  assert.equal(packet.readiness.releaseTagPermitted, false);
  assert.equal(packet.readiness.secretMovementPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);

  assert.equal(packet.integrationContract.startsSidecarProcess, false);
  assert.equal(packet.integrationContract.sendsProviderRequests, false);
  assert.equal(packet.integrationContract.mutatesBrokerState, false);
  assert.equal(packet.integrationContract.mutatesDatabase, false);
  assert.equal(packet.integrationContract.dispatchesTasks, false);
  assert.equal(packet.integrationContract.changesRouting, false);
  assert.equal(packet.integrationContract.grantsApproval, false);
  assert.equal(packet.integrationContract.executesAction, false);

  assert.equal(packet.semantics.packetDoesNotGrantApproval, true);
  assert.equal(packet.semantics.packetDoesNotStartSidecar, true);
  assert.equal(packet.semantics.packetDoesNotSendProviders, true);
  assert.equal(packet.semantics.packetDoesNotMutateDb, true);
  assert.equal(packet.semantics.packetDoesNotDispatchOrRoute, true);
  assert.equal(packet.semantics.packetDoesNotDeployRestartReleaseOrMoveSecrets, true);
  assert.equal(packet.semantics.separateFreshApprovalRequiredForLiveActions, true);
  assert.equal(packet.semantics.finalizerRemainsAuthoritative, true);
});

test("advisory sidecar operator decision packet records guardrail and issue references (#794, #837)", () => {
  const packet = createAdvisorySidecarOperatorDecisionPacket({ now: NOW });

  assert.deepEqual(packet.decision.parentIssueRefs, ["#764", "#785", "#789", "#794", "#837"]);
  assert.deepEqual(packet.decision.guardrailRefs, [
    "a2a-advisory-sidecar-contract",
    "a2a-advisory-sidecar-resolver",
  ]);
  assert.equal(packet.approvalSensitiveActionsExcluded.includes("sidecar process startup"), true);
  assert.equal(packet.approvalSensitiveActionsExcluded.includes("provider or Hermes send/canary"), true);
  assert.equal(packet.approvalSensitiveActionsExcluded.includes("task dispatch or routing influence"), true);
  assert.equal(packet.approvalSensitiveActionsExcluded.includes("broker state or database mutation"), true);
  assert.equal(packet.approvalSensitiveActionsExcluded.includes("secret or credential movement"), true);
});

test("advisory sidecar activation approval packet enumerates required evidence and gates without granting approval (#837)", () => {
  const packet = createAdvisorySidecarOperatorDecisionPacket({ now: NOW, decisionOwner: "brokeralpha" });

  assert.equal(packet.activationReadiness.defaultEnabled, false);
  assert.deepEqual(packet.activationReadiness.requiredEvidenceBeforeStart, [
    "operator_approval_record",
    "finalizer_go_decision",
    "default_off_resolver_evidence",
    "sidecar_process_preflight",
    "provider_send_preflight",
    "routing_influence_preflight",
    "db_mutation_preflight",
    "dispatch_influence_preflight",
    "rollback_abort_plan",
  ]);
  assert.deepEqual(packet.activationReadiness.safeTelemetryFields, [
    "packet.kind",
    "packet.version",
    "packet.generatedAt",
    "packet.state",
    "readiness.*Permitted",
    "activationReadiness.requiredEvidenceBeforeStart",
    "activationReadiness.approvalGates.*.requiresFreshApproval",
    "activationReadiness.rollbackAbortCriteria",
  ]);

  for (const gateName of [
    "sidecarProcessStart",
    "providerSend",
    "routingInfluence",
    "dbMutation",
    "dispatchInfluence",
    "deployRestart",
    "releaseTag",
    "secretMovement",
    "manualAckReplay",
  ] as const) {
    const gate = packet.activationReadiness.approvalGates[gateName];
    assert.equal(gate.requiresFreshApproval, true, gateName);
    assert.equal(gate.grantedByThisPacket, false, gateName);
    assert.equal(gate.finalizerRequired, true, gateName);
  }

  assert.deepEqual(packet.activationReadiness.rollbackAbortCriteria, [
    "missing_or_stale_operator_approval",
    "non_green_preflight_or_ci",
    "provider_send_attempt_before_approval",
    "routing_or_dispatch_influence_before_approval",
    "db_mutation_or_state_change_before_approval",
    "secret_or_release_action_before_approval",
  ]);
  assert.equal(packet.activationReadiness.finalizer.owner, "brokeralpha");
  assert.equal(packet.activationReadiness.finalizer.nonBypassable, true);
  assert.equal(packet.activationReadiness.finalizer.workerEvidenceAdvisoryOnly, true);
  assert.equal(packet.activationReadiness.packetGrantsApproval, false);
});

test("advisory sidecar operator decision packet is deeply immutable (#794)", () => {
  const packet = createAdvisorySidecarOperatorDecisionPacket({ now: NOW });

  assert.equal(Object.isFrozen(packet), true);
  assert.equal(Object.isFrozen(packet.decision), true);
  assert.equal(Object.isFrozen(packet.decision.recommendation), true);
  assert.equal(Object.isFrozen(packet.decision.boundary), true);
  assert.equal(Object.isFrozen(packet.readiness), true);
  assert.equal(Object.isFrozen(packet.approvalSensitiveActionsExcluded), true);
  assert.equal(Object.isFrozen(packet.integrationContract), true);
  assert.equal(Object.isFrozen(packet.semantics), true);
});

test("advisory sidecar operator decision idempotency key is deterministic (#794)", () => {
  assert.equal(
    buildAdvisorySidecarOperatorDecisionIdempotencyKey(
      "brokeralpha",
      "issue-794",
      NOW,
      "default_off_operator_decision_ready",
    ),
    "advisory-sidecar-operator-decision:default_off_operator_decision_ready:brokeralpha:issue-794:2026-06-16T04:10:00.000Z",
  );
});
