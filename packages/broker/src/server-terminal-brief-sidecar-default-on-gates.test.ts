import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, jsonHeaders } from "./server-test-helpers.js";

test("POST /terminal-brief/sidecar/default-on-candidate-final-gate returns source-only default-on candidate review", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-candidate-final-gate",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          observationPacket: {
            kind: "brokeralpha.terminal-brief-sidecar-bounded-dry-run-observation",
            generatedAt: "2026-05-19T03:31:05.000Z",
            operatorInstructionReference: "telegram:1000000001:53345",
            windowSeconds: 300,
            state: "bounded_dry_run_observation_passed",
            blockers: [],
            summary: {
              processCount: 1,
              nRestarts: "0",
              spoolBefore: 2,
              spoolAfter: 2,
              spoolDelta: 0,
              cursorBefore: "178 1779161103",
              cursorAfter: "178 1779161403",
              brokerOk: true,
              gatewayReady: true,
              gatewayEventLoopDegraded: false,
            },
            safety: {
              dryRunOnly: true,
              spoolOnly: true,
              liveProviderSendPermitted: false,
              terminalAckPermitted: false,
              dbMutationPermitted: false,
              defaultOnPermitted: false,
              processSpawnPerformed: false,
              sidecarRestartPerformed: false,
            },
          },
          defaultOnCandidateFinalGate: {
            now: "2026-05-19T03:32:00.000Z",
            reviewOwner: "broker-finalizer",
            minObservationSeconds: 300,
          },
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-candidate-final-gate.packet");
    assert.equal(body.state, "ready_for_default_on_candidate_review");
    assert.equal(body.readiness.finalGateReady, true);
    assert.equal(body.candidateGate.defaultOnCandidate, true);
    assert.equal(body.candidateGate.defaultOnEnabled, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.integrationContract.sendsProvider, false);
    assert.equal(body.integrationContract.performsTerminalAck, false);
    assert.equal(body.semantics.candidateDoesNotEnableDefaultOn, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/default-on-approval-request returns source-only approval request draft", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const finalGatePacket = {
      kind: "a2a-broker.terminal-brief-sidecar-default-on-candidate-final-gate.packet",
      version: 1,
      generatedAt: "2026-05-19T03:32:00.000Z",
      mode: "terminal-brief-default-on-candidate-source-only",
      state: "ready_for_default_on_candidate_review",
      dryRunOnly: true,
      sourceOnlyNoLive: true,
      idempotencyKey: "tb-sidecar-default-on-candidate-final-gate:fixture",
      source: {
        observationKind: "brokeralpha.terminal-brief-sidecar-bounded-dry-run-observation",
        observationState: "bounded_dry_run_observation_passed",
        observationGeneratedAt: "2026-05-19T03:31:05.000Z",
        operatorInstructionReference: "telegram:1000000001:53345",
        windowSeconds: 300,
        minObservationSeconds: 300,
      },
      candidateGate: {
        reviewOnly: true,
        defaultOnCandidate: true,
        defaultOnEnabled: false,
        reviewOwner: "broker-finalizer",
        gateReference: "tb-sidecar-default-on-candidate:fixture",
        checklist: [],
        abortConditions: [],
        rollbackChecklist: [],
      },
      readiness: {
        sourceCriteriaMet: true,
        finalGateReady: true,
        defaultOnPermitted: false,
        liveActivationPermitted: false,
        providerSendPermitted: false,
        terminalAckPermitted: false,
        executionPermitted: false,
        dbMutationPermitted: false,
        processSpawnPermitted: false,
        sidecarStartPermitted: false,
        missingEvidence: [],
        blockers: [],
        nextAction: "review the default-on candidate gate",
      },
      blockers: [],
      nextActions: [],
      approvalSensitiveActionsExcluded: [],
      integrationContract: {
        transport: "json",
        defaultOnCandidateFinalGateVersion: 1,
        consumesBoundedDryRunObservationPacket: true,
        rendersDefaultOnCandidateFinalGate: true,
        enablesDefaultOn: false,
        sendsProvider: false,
        performsTerminalAck: false,
        mutatesDb: false,
        spawnsProcess: false,
        restartsSidecar: false,
        executesAction: false,
      },
      semantics: {
        finalGateReviewOnly: true,
        sourceOnlyNoLive: true,
        candidateDoesNotEnableDefaultOn: true,
        observationDoesNotAuthorizeLiveSend: true,
        terminalAckEligibleDoesNotPermitAck: true,
        providerAcceptedIsVisibilityProof: false,
        executionNotPermitted: true,
        processSpawnNotPermitted: true,
        sidecarStartNotPermitted: true,
        defaultOnNotEnabledByThisPacket: true,
        performsProviderSend: false,
        performsTerminalAck: false,
        performsRuntimeRestartOrDeploy: false,
        performsDbMutation: false,
        performsHistoricalReplay: false,
        performsReleaseOrPublish: false,
        movesSecretsOrCredentials: false,
      },
    };
    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-approval-request",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          finalGatePacket,
          defaultOnApprovalRequest: {
            now: "2026-05-19T03:56:00.000Z",
            operatorTarget: "operator-a",
            operatorChannel: "telegram:1000000001",
          },
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-approval-request.packet");
    assert.equal(body.state, "approval_request_draft_ready");
    assert.equal(body.approvalRequestDraft.status, "draft_not_sent");
    assert.equal(body.approvalRequestDraft.requiredReply, "default-on 승인");
    assert.equal(body.readiness.approvalRequestDraftReady, true);
    assert.equal(body.readiness.approvalRequestDispatchPermitted, false);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.integrationContract.sendsProvider, false);
    assert.equal(body.integrationContract.mutatesDb, false);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/preflight-evidence-collector returns source-only supplied evidence packet", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-preflight-evidence-collector.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/preflight-evidence-collector",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-preflight-evidence-collector.packet");
    assert.equal(body.state, "ready_for_supervised_dry_run_preflight_review");
    assert.equal(body.readiness.preflightReviewReady, true);
    assert.equal(body.readiness.approvalRequestDispatchPermitted, false);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.integrationContract.openclawMessageSendRequired, false);
    assert.equal(body.integrationContract.collectsLiveEvidence, false);
    assert.equal(body.integrationContract.probesGateway, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.suppliedEvidenceOnly, true);
    assert.equal(body.semantics.performsProviderSend, false);
    assert.equal(body.semantics.performsTerminalAck, false);
    assert.equal(body.semantics.performsRuntimeRestartOrDeploy, false);
    assert.equal(body.semantics.performsDbMutation, false);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/preflight-chain-review returns final no-live chain packet", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-preflight-chain-review.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/preflight-chain-review",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-preflight-chain-review.packet");
    assert.equal(body.state, "ready_for_supervised_dry_run_chain_review");
    assert.equal(body.readiness.chainReviewReady, true);
    assert.equal(body.readiness.approvalRequestDispatchPermitted, false);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.integrationContract.openclawMessageSendRequired, false);
    assert.equal(body.integrationContract.probesGateway, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.preflightChainReviewOnly, true);
    assert.equal(body.semantics.dryRunStartRequiresSeparateApproval, true);
    assert.equal(body.semantics.performsProviderSend, false);
    assert.equal(body.semantics.performsTerminalAck, false);
    assert.equal(body.semantics.performsRuntimeRestartOrDeploy, false);
    assert.equal(body.semantics.performsDbMutation, false);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/dry-run-start-approval-request returns source-only approval draft", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-dry-run-start-approval-request.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/dry-run-start-approval-request",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-dry-run-start-approval-request.packet");
    assert.equal(body.state, "approval_request_draft_ready");
    assert.equal(body.readiness.approvalRequestDraftReady, true);
    assert.equal(body.approvalRequestDraft.status, "draft_not_sent");
    assert.equal(body.approvalRequestDraft.dispatchPermitted, false);
    assert.equal(body.approvalRequestDraft.approvalGrantPermitted, false);
    assert.equal(body.approvalRequestDraft.executionPermitted, false);
    assert.equal(body.readiness.approvalRequestDispatchPermitted, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.integrationContract.openclawMessageSendRequired, false);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.supervisedDryRunBoundary.separateOperatorApprovalRequired, true);
    assert.equal(body.semantics.requestDraftIsNotSend, true);
    assert.equal(body.semantics.performsProviderSend, false);
    assert.equal(body.semantics.performsTerminalAck, false);
    assert.equal(body.semantics.performsRuntimeRestartOrDeploy, false);
    assert.equal(body.semantics.performsDbMutation, false);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/dry-run-start-approval-receipt returns source-only receipt evidence", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-dry-run-start-approval-receipt-ingestor.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/dry-run-start-approval-receipt",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-dry-run-start-approval-receipt-ingestor.packet");
    assert.equal(body.state, "accepted");
    assert.equal(body.receiptEvidenceAccepted, true);
    assert.equal(body.approvalEvidenceAccepted, true);
    assert.equal(body.classification.providerAccepted, true);
    assert.equal(body.classification.providerAcceptedIsVisibilityProof, false);
    assert.equal(body.classification.terminalAckEligible, true);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.integrationContract.openclawMessageSendRequired, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.approvalGrantEvidenceDoesNotGrantApproval, true);
    assert.equal(body.semantics.performsTerminalAck, false);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/default-on-approval-evidence returns source-only evidence packet", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-approval-evidence-ingestor.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-approval-evidence",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-approval-evidence-ingestor.packet");
    assert.equal(body.state, "accepted");
    assert.equal(body.receiptEvidenceAccepted, true);
    assert.equal(body.approvalEvidenceAccepted, true);
    assert.equal(body.classification.providerAccepted, true);
    assert.equal(body.classification.providerAcceptedIsVisibilityProof, false);
    assert.equal(body.classification.terminalAckEligible, true);
    assert.equal(body.readiness.approvalRequestDispatchPermitted, false);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.integrationContract.openclawMessageSendRequired, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.semantics.approvalGrantEvidenceDoesNotGrantApproval, true);
    assert.equal(body.semantics.defaultOnApprovalEvidenceDoesNotEnableDefaultOn, true);
    assert.equal(body.semantics.performsTerminalAck, false);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/default-on-enablement-gate returns source-only gate packet", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-enablement-gate.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-enablement-gate",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-enablement-gate.packet");
    assert.equal(body.state, "ready_for_default_on_enablement_review");
    assert.equal(body.readiness.enablementGateReady, true);
    assert.equal(body.source.receiptEvidenceAccepted, true);
    assert.equal(body.source.approvalEvidenceAccepted, true);
    assert.equal(body.source.providerAcceptedIsVisibilityProof, false);
    assert.equal(body.readiness.approvalRequestDispatchPermitted, false);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.integrationContract.approvalGrantEvidenceExecutesGrant, false);
    assert.equal(body.semantics.gateDoesNotEnableDefaultOn, true);
    assert.equal(body.semantics.performsTerminalAck, false);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/default-on-runtime-mutation-plan returns source-only plan packet", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-runtime-mutation-plan.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-runtime-mutation-plan",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-runtime-mutation-plan.packet");
    assert.equal(body.state, "ready_for_runtime_mutation_review");
    assert.equal(body.sourceOnlyNoLive, true);
    assert.equal(body.readiness.runtimeMutationPlanReady, true);
    assert.equal(body.runtimeMutationPlan.planOnly, true);
    assert.equal(body.runtimeMutationPlan.configChange.applied, false);
    assert.equal(body.runtimeMutationPlan.executionEnvelope.executable, false);
    assert.equal(body.source.providerAcceptedIsVisibilityProof, false);
    assert.equal(body.source.approvalGrantEvidenceExecutesGrant, false);
    assert.equal(body.readiness.runtimeMutationPermitted, false);
    assert.equal(body.readiness.configWritePermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.liveActivationPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.readiness.taskFlowMutationPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.sidecarRestartPermitted, false);
    assert.equal(body.integrationContract.writesConfig, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.semantics.planDoesNotWriteConfig, true);
    assert.equal(body.semantics.planDoesNotEnableDefaultOn, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/default-on-execution-rollback-envelope returns source-only envelope packet", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-execution-rollback-envelope.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-execution-rollback-envelope",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-execution-rollback-envelope.packet");
    assert.equal(body.state, "ready_for_execution_approval_review");
    assert.equal(body.sourceOnlyNoLive, true);
    assert.equal(body.readiness.executionEnvelopeReady, true);
    assert.equal(body.executionRollbackEnvelope.envelopeOnly, true);
    assert.equal(body.source.configChangeApplied, false);
    assert.equal(body.source.executionEnvelopeExecutable, false);
    assert.equal(body.executionRollbackEnvelope.executionPlan.commandExecutable, false);
    assert.equal(body.executionRollbackEnvelope.executionPlan.envValuesIncluded, false);
    assert.equal(body.executionRollbackEnvelope.executionPlan.secretValuesIncluded, false);
    assert.equal(body.executionRollbackEnvelope.rollbackPlan.rollbackExecutable, false);
    assert.equal(body.readiness.executionApprovalRequestPermitted, false);
    assert.equal(body.readiness.runtimeMutationPermitted, false);
    assert.equal(body.readiness.configWritePermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.readiness.taskFlowMutationPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.sidecarRestartPermitted, false);
    assert.equal(body.readiness.brokerRestartPermitted, false);
    assert.equal(body.integrationContract.writesConfig, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.semantics.envelopeDoesNotExecute, true);
    assert.equal(body.semantics.envelopeDoesNotWriteConfig, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/default-on-execution-approval-request returns source-only draft packet", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-execution-approval-request.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-execution-approval-request",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-execution-approval-request.packet");
    assert.equal(body.state, "execution_approval_request_draft_ready");
    assert.equal(body.sourceOnlyNoLive, true);
    assert.equal(body.readiness.executionApprovalRequestDraftReady, true);
    assert.equal(body.approvalRequestDraft.status, "draft_not_sent");
    assert.equal(body.approvalRequestDraft.dispatchPermitted, false);
    assert.equal(body.approvalRequestDraft.approvalGrantPermitted, false);
    assert.equal(body.approvalRequestDraft.configWritePermitted, false);
    assert.equal(body.approvalRequestDraft.defaultOnPermitted, false);
    assert.equal(body.approvalRequestDraft.sidecarRestartPermitted, false);
    assert.equal(body.approvalRequestDraft.providerSendPermitted, false);
    assert.equal(body.approvalRequestDraft.terminalAckPermitted, false);
    assert.equal(body.approvalRequestDraft.dbMutationPermitted, false);
    assert.equal(body.approvalRequestDraft.taskFlowMutationPermitted, false);
    assert.equal(body.approvalRequestDraft.executionPermitted, false);
    assert.equal(body.approvalRequestDraft.processSpawnPermitted, false);
    assert.equal(body.readiness.executionApprovalRequestDispatchPermitted, false);
    assert.equal(body.readiness.runtimeMutationPermitted, false);
    assert.equal(body.readiness.configWritePermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.sidecarRestartPermitted, false);
    assert.equal(body.readiness.brokerRestartPermitted, false);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.writesConfig, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.integrationContract.restartsSidecar, false);
    assert.equal(body.integrationContract.executesAction, false);
    assert.equal(body.semantics.requestDraftIsNotSend, true);
    assert.equal(body.semantics.requestDoesNotExecuteEnvelope, true);
    assert.equal(body.semantics.requestDoesNotWriteConfig, true);
    assert.equal(body.semantics.requestDoesNotEnableDefaultOn, true);
    assert.equal(body.semantics.requestDoesNotRestartSidecar, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/default-on-execution-approval-evidence returns no-live accepted evidence packet", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-execution-approval-request.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const requestRes = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-execution-approval-request",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          ...input,
          defaultOnExecutionApprovalRequest: {
            now: "2026-05-19T06:45:00.000Z",
            operatorTarget: "terminal-brief-default-on",
            operatorChannel: "telegram-direct",
          },
        }),
      },
    );

    assert.equal(requestRes.status, 200);
    const requestPacket = await requestRes.json();
    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-execution-approval-evidence",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          defaultOnExecutionApprovalRequestPacket: requestPacket,
          evidence: [
            {
              kind: "manual_operator_confirmation",
              observedAt: "2026-05-19T06:45:00.000Z",
              target: "terminal-brief-default-on",
              operatorId: "operator-a",
              source: "telegram-direct",
              note: "default-on execution 승인",
            },
            {
              kind: "approval_grant",
              observedAt: "2026-05-19T06:45:00.000Z",
              approvedAction: "approve_terminal_brief_default_on_execution",
              approvedTarget: "terminal-brief-default-on",
              operatorId: "operator-a",
              source: "telegram-direct",
              note: "default-on execution 승인",
            },
          ],
          executionApprovalEvidenceIngestor: { now: "2026-05-19T06:45:00.000Z" },
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-execution-approval-evidence-ingestor.packet");
    assert.equal(body.state, "accepted");
    assert.equal(body.sourceOnlyNoLive, true);
    assert.equal(body.receiptEvidenceAccepted, true);
    assert.equal(body.approvalEvidenceAccepted, true);
    assert.equal(body.classification.providerAcceptedIsVisibilityProof, false);
    assert.equal(body.classification.approvalGrantEvidenceExecutesGrant, false);
    assert.equal(body.readiness.executionApprovalRequestDispatchPermitted, false);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.runtimeMutationPermitted, false);
    assert.equal(body.readiness.configWritePermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.sidecarRestartPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.readiness.taskFlowMutationPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.brokerRestartPermitted, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.writesConfig, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.integrationContract.restartsSidecar, false);
    assert.equal(body.integrationContract.executesAction, false);
    assert.equal(body.semantics.evidenceIngestorOnly, true);
    assert.equal(body.semantics.executionApprovalEvidenceDoesNotWriteConfig, true);
    assert.equal(body.semantics.executionApprovalEvidenceDoesNotEnableDefaultOn, true);
    assert.equal(body.semantics.executionApprovalEvidenceDoesNotRestartSidecar, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/default-on-runtime-execution-final-gate returns source-only final gate", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-runtime-execution-final-gate.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-runtime-execution-final-gate",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-final-gate.packet");
    assert.equal(body.state, "ready_for_runtime_execution_final_review");
    assert.equal(body.sourceOnlyNoLive, true);
    assert.equal(body.finalGate.gateReady, true);
    assert.equal(body.source.receiptEvidenceAccepted, true);
    assert.equal(body.source.approvalEvidenceAccepted, true);
    assert.equal(body.readiness.runtimeExecutionFinalGateReady, true);
    assert.equal(body.readiness.runtimeMutationPermitted, false);
    assert.equal(body.readiness.configWritePermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.sidecarRestartPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.readiness.taskFlowMutationPermitted, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.brokerRestartPermitted, false);
    assert.equal(body.readiness.gatewayRestartPermitted, false);
    assert.equal(body.integrationContract.writesConfig, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.integrationContract.restartsSidecar, false);
    assert.equal(body.integrationContract.dispatchesStartExecutor, false);
    assert.equal(body.integrationContract.invokesExecutor, false);
    assert.equal(body.integrationContract.executesAction, false);
    assert.equal(body.semantics.runtimeExecutionFinalGateOnly, true);
    assert.equal(body.semantics.acceptedEvidenceDoesNotAuthorizeRuntime, true);
    assert.equal(body.semantics.finalGateDoesNotWriteConfig, true);
    assert.equal(body.semantics.finalGateDoesNotEnableDefaultOn, true);
    assert.equal(body.semantics.finalGateDoesNotRestartSidecar, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/default-on-runtime-execution-request-draft returns source-only request draft", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-runtime-execution-request-draft.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-runtime-execution-request-draft",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-request-draft.packet");
    assert.equal(body.state, "runtime_execution_request_draft_ready");
    assert.equal(body.sourceOnlyNoLive, true);
    assert.equal(body.source.runtimeExecutionFinalGateReady, true);
    assert.equal(body.source.gateReady, true);
    assert.equal(body.executionRequestDraft.status, "draft_not_sent");
    assert.equal(body.executionRequestDraft.dispatchPermitted, false);
    assert.equal(body.executionRequestDraft.requiredReply, "execute default-on runtime mutation 승인");
    assert.equal(body.readiness.runtimeExecutionRequestDraftReady, true);
    assert.equal(body.readiness.runtimeExecutionRequestDispatchPermitted, false);
    assert.equal(body.readiness.runtimeMutationPermitted, false);
    assert.equal(body.readiness.configWritePermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.sidecarRestartPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.readiness.taskFlowMutationPermitted, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.brokerRestartPermitted, false);
    assert.equal(body.readiness.gatewayRestartPermitted, false);
    assert.equal(body.integrationContract.sendsExecutionRequest, false);
    assert.equal(body.integrationContract.writesConfig, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.integrationContract.dispatchesStartExecutor, false);
    assert.equal(body.integrationContract.invokesExecutor, false);
    assert.equal(body.integrationContract.executesAction, false);
    assert.equal(body.semantics.runtimeExecutionRequestDraftOnly, true);
    assert.equal(body.semantics.requestDoesNotExecuteRuntimeMutation, true);
    assert.equal(body.semantics.requestDoesNotWriteConfig, true);
    assert.equal(body.semantics.requestDoesNotEnableDefaultOn, true);
    assert.equal(body.semantics.requestDoesNotRestartSidecar, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/default-on-runtime-execution-approval-evidence returns source-only accepted evidence", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-runtime-execution-approval-evidence-ingestor.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-runtime-execution-approval-evidence",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-runtime-execution-approval-evidence-ingestor.packet");
    assert.equal(body.state, "accepted");
    assert.equal(body.sourceOnlyNoLive, true);
    assert.equal(body.receiptEvidenceAccepted, true);
    assert.equal(body.approvalEvidenceAccepted, true);
    assert.equal(body.source.requestedAction, "execute_terminal_brief_default_on_runtime_mutation");
    assert.equal(body.classification.providerAcceptedIsVisibilityProof, false);
    assert.equal(body.classification.approvalGrantEvidenceExecutesGrant, false);
    assert.equal(body.readiness.runtimeExecutionRequestDispatchPermitted, false);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.approvalGrantExecutionPermitted, false);
    assert.equal(body.readiness.runtimeMutationPermitted, false);
    assert.equal(body.readiness.configWritePermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.sidecarRestartPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.readiness.taskFlowMutationPermitted, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.brokerRestartPermitted, false);
    assert.equal(body.readiness.gatewayRestartPermitted, false);
    assert.equal(body.integrationContract.sendsExecutionRequest, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.executesApprovalGrant, false);
    assert.equal(body.integrationContract.writesConfig, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.integrationContract.dispatchesStartExecutor, false);
    assert.equal(body.integrationContract.invokesExecutor, false);
    assert.equal(body.integrationContract.executesAction, false);
    assert.equal(body.semantics.runtimeExecutionApprovalEvidenceIngestorOnly, true);
    assert.equal(body.semantics.runtimeExecutionApprovalEvidenceDoesNotWriteConfig, true);
    assert.equal(body.semantics.runtimeExecutionApprovalEvidenceDoesNotEnableDefaultOn, true);
    assert.equal(body.semantics.runtimeExecutionApprovalEvidenceDoesNotRestartSidecar, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/default-on-runtime-executor-gate returns source-only executor gate", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-runtime-executor-gate.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-runtime-executor-gate",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-runtime-executor-gate.packet");
    assert.equal(body.state, "ready_for_runtime_executor_review");
    assert.equal(body.sourceOnlyNoLive, true);
    assert.equal(body.executorGate.gateReady, true);
    assert.equal(body.source.requestedAction, "execute_terminal_brief_default_on_runtime_mutation");
    assert.equal(body.source.configKey, "TERMINAL_BRIEF_SIDECAR_DEFAULT_ON");
    assert.equal(body.readiness.runtimeExecutorGateReady, true);
    assert.equal(body.readiness.runtimeMutationPermitted, false);
    assert.equal(body.readiness.configWritePermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.sidecarRestartPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.readiness.taskFlowMutationPermitted, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.brokerRestartPermitted, false);
    assert.equal(body.readiness.gatewayRestartPermitted, false);
    assert.equal(body.integrationContract.writesConfig, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.integrationContract.dispatchesStartExecutor, false);
    assert.equal(body.integrationContract.invokesExecutor, false);
    assert.equal(body.integrationContract.executesAction, false);
    assert.equal(body.semantics.executorGateDoesNotWriteConfig, true);
    assert.equal(body.semantics.executorGateDoesNotEnableDefaultOn, true);
    assert.equal(body.semantics.executorGateDoesNotRestartSidecar, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/default-on-final-live-execution returns source-only final execution packet", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-final-live-execution.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-final-live-execution",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-final-live-execution.packet");
    assert.equal(body.state, "ready_for_final_live_execution_review");
    assert.equal(body.sourceOnlyNoLive, true);
    assert.equal(body.finalLiveExecution.reviewOnly, true);
    assert.equal(body.finalLiveExecution.checkpoint.required, true);
    assert.equal(body.finalLiveExecution.checkpoint.createsCheckpointInThisPacket, false);
    assert.equal(body.finalLiveExecution.executionPlan.executesInThisPacket, false);
    assert.equal(body.readiness.finalLiveExecutionReviewReady, true);
    assert.equal(body.readiness.runtimeMutationPermitted, false);
    assert.equal(body.readiness.configWritePermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.sidecarRestartPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.readiness.taskFlowMutationPermitted, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.brokerRestartPermitted, false);
    assert.equal(body.readiness.gatewayRestartPermitted, false);
    assert.equal(body.readiness.checkpointCreationPermitted, false);
    assert.equal(body.readiness.rollbackExecutionPermitted, false);
    assert.equal(body.integrationContract.writesConfig, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.integrationContract.createsCheckpoint, false);
    assert.equal(body.integrationContract.executesRollback, false);
    assert.equal(body.integrationContract.executesAction, false);
    assert.equal(body.semantics.packetDoesNotWriteConfig, true);
    assert.equal(body.semantics.packetDoesNotCreateCheckpoint, true);
    assert.equal(body.semantics.packetDoesNotExecuteRollback, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/default-on-execution-window-request-draft returns source-only request draft", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-execution-window-request-draft.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-execution-window-request-draft",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-execution-window-request-draft.packet");
    assert.equal(body.state, "execution_window_request_draft_ready");
    assert.equal(body.sourceOnlyNoLive, true);
    assert.equal(body.executionWindowRequestDraft.status, "draft_not_sent");
    assert.equal(body.executionWindowRequestDraft.requiredReply, "fresh operator execution window 승인");
    assert.equal(body.readiness.executionWindowRequestDraftReady, true);
    assert.equal(body.readiness.executionWindowRequestDispatchPermitted, false);
    assert.equal(body.readiness.checkpointCreationPermitted, false);
    assert.equal(body.readiness.rollbackExecutionPermitted, false);
    assert.equal(body.readiness.runtimeMutationPermitted, false);
    assert.equal(body.readiness.configWritePermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.sidecarRestartPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.readiness.taskFlowMutationPermitted, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.integrationContract.sendsExecutionWindowRequest, false);
    assert.equal(body.integrationContract.createsCheckpoint, false);
    assert.equal(body.integrationContract.writesConfig, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.integrationContract.restartsSidecar, false);
    assert.equal(body.integrationContract.executesAction, false);
    assert.equal(body.semantics.requestDoesNotCreateCheckpoint, true);
    assert.equal(body.semantics.requestDoesNotWriteConfig, true);
    assert.equal(body.semantics.requestDoesNotEnableDefaultOn, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/default-on-execution-window-approval-evidence returns source-only evidence classification", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-execution-window-approval-evidence-ingestor.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-execution-window-approval-evidence",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-execution-window-approval-evidence-ingestor.packet");
    assert.equal(body.state, "accepted");
    assert.equal(body.sourceOnlyNoLive, true);
    assert.equal(body.receiptEvidenceAccepted, true);
    assert.equal(body.approvalEvidenceAccepted, true);
    assert.equal(body.classification.providerAcceptedIsVisibilityProof, false);
    assert.equal(body.classification.approvalGrantEvidenceExecutesGrant, false);
    assert.equal(body.readiness.executionWindowApprovalEvidenceAccepted, true);
    assert.equal(body.readiness.executionWindowRequestDispatchPermitted, false);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.approvalGrantExecutionPermitted, false);
    assert.equal(body.readiness.checkpointCreationPermitted, false);
    assert.equal(body.readiness.rollbackExecutionPermitted, false);
    assert.equal(body.readiness.runtimeMutationPermitted, false);
    assert.equal(body.readiness.configWritePermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.sidecarRestartPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.readiness.taskFlowMutationPermitted, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.executesApprovalGrant, false);
    assert.equal(body.integrationContract.createsCheckpoint, false);
    assert.equal(body.integrationContract.writesConfig, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.integrationContract.executesAction, false);
    assert.equal(body.semantics.approvalEvidenceDoesNotGrantApproval, true);
    assert.equal(body.semantics.approvalEvidenceDoesNotWriteConfig, true);
    assert.equal(body.semantics.defaultOnNotEnabledByThisPacket, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/default-on-final-runtime-mutation-executor-gate returns source-only final gate", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-execution-window-approval-evidence-ingestor.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-final-runtime-mutation-executor-gate",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-final-runtime-mutation-executor-gate.packet");
    assert.equal(body.state, "ready_for_final_runtime_mutation_executor_review");
    assert.equal(body.sourceOnlyNoLive, true);
    assert.equal(body.source.receiptEvidenceAccepted, true);
    assert.equal(body.source.approvalEvidenceAccepted, true);
    assert.equal(body.source.executionWindowApprovalEvidenceAccepted, true);
    assert.equal(body.finalRuntimeMutationExecutorGate.gateReady, true);
    assert.equal(body.finalRuntimeMutationExecutorGate.reviewOnly, true);
    assert.equal(body.readiness.finalRuntimeMutationExecutorGateReady, true);
    assert.equal(body.readiness.executionWindowRequestDispatchPermitted, false);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.approvalGrantExecutionPermitted, false);
    assert.equal(body.readiness.checkpointCreationPermitted, false);
    assert.equal(body.readiness.rollbackExecutionPermitted, false);
    assert.equal(body.readiness.runtimeMutationPermitted, false);
    assert.equal(body.readiness.configWritePermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.sidecarRestartPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.readiness.taskFlowMutationPermitted, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.integrationContract.createsCheckpoint, false);
    assert.equal(body.integrationContract.executesRollback, false);
    assert.equal(body.integrationContract.writesConfig, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.integrationContract.executesAction, false);
    assert.equal(body.semantics.gateDoesNotCreateCheckpoint, true);
    assert.equal(body.semantics.gateDoesNotWriteConfig, true);
    assert.equal(body.semantics.defaultOnNotEnabledByThisPacket, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/default-on-live-executor returns fail-closed live executor packet", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const input = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-execution-window-approval-evidence-ingestor.no-live.json"),
      "utf8",
    )) as Record<string, unknown>;

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/default-on-live-executor",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(input),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-default-on-live-executor.packet");
    assert.equal(body.state, "awaiting_final_live_execution_approval");
    assert.equal(body.sourceOnlyNoLive, true);
    assert.equal(body.source.finalRuntimeMutationExecutorGateReady, true);
    assert.equal(body.liveExecutor.liveExecutorAvailable, true);
    assert.equal(body.liveExecutor.failClosed, true);
    assert.equal(body.liveExecutor.finalLiveExecutionApprovalRequired, true);
    assert.equal(body.liveExecutor.finalLiveExecutionApprovalAccepted, false);
    assert.equal(body.liveExecutor.executionArmed, false);
    assert.equal(body.liveExecutor.executionPerformed, false);
    assert.equal(body.liveExecutor.operations.every((operation: Record<string, unknown>) => operation.permitted === false), true);
    assert.equal(body.liveExecutor.operations.every((operation: Record<string, unknown>) => operation.performed === false), true);
    assert.equal(body.readiness.liveExecutorReviewReady, true);
    assert.equal(body.readiness.finalLiveExecutionApprovalAccepted, false);
    assert.equal(body.readiness.checkpointCreationPermitted, false);
    assert.equal(body.readiness.rollbackExecutionPermitted, false);
    assert.equal(body.readiness.runtimeMutationPermitted, false);
    assert.equal(body.readiness.configWritePermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.sidecarRestartPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.readiness.taskFlowMutationPermitted, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.integrationContract.createsCheckpoint, false);
    assert.equal(body.integrationContract.executesRollback, false);
    assert.equal(body.integrationContract.writesConfig, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.integrationContract.dispatchesStartExecutor, false);
    assert.equal(body.integrationContract.invokesExecutor, false);
    assert.equal(body.integrationContract.spawnsProcess, false);
    assert.equal(body.integrationContract.executesAction, false);
    assert.equal(body.semantics.liveExecutorDoesNotExecuteWithoutFinalApproval, true);
    assert.equal(body.semantics.finalApprovalStillRequired, true);
    assert.equal(body.semantics.defaultOnNotEnabledByThisPacket, true);
  } finally {
    await server.close();
  }
});
