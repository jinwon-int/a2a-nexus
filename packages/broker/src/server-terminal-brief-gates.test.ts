import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, jsonHeaders } from "./server-test-helpers.js";

test("POST /terminal-brief/closeout/gate returns approval-gated dry-run plan", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const workflow = {
      kind: "a2a-broker.terminal-brief-finalizer-workflow.packet",
      version: 1,
      generatedAt: "2026-05-18T15:00:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-700",
      decision: "ready",
      currentStep: "finalizer_review",
      idempotencyKey: "tb-finalizer-workflow:fixture",
      finalizer: {
        brokerOfRecordId: "brokeralpha",
        owner: "brokeralpha",
        required: true,
        singleFinalizerRequired: true,
      },
      source: {
        handoffDecision: "ready",
        handoffIdempotencyKey: "tb-finalizer-handoff:fixture",
        evidenceUrls: 1,
        receiptGaps: 1,
        blockers: 0,
      },
      workflow: {
        closeoutComment: {
          mode: "draft-only",
          title: "Draft: Terminal Brief closeout ready - round-700",
          body: "Draft closeout body. This was not posted automatically.",
          postPermitted: false,
        },
        taskflowSeed: {
          createRecords: false,
          currentStep: "finalizer_review",
          stateJson: { source: "terminal-brief-finalizer-workflow" },
          waitJson: { kind: "broker_finalizer_review" },
        },
      },
      checklist: [],
      reviewItems: ["single broker finalizer must review"],
      blockers: [],
      nextActions: [],
      approvalSensitiveActionsExcluded: [
        "GitHub PR merge, issue close, or comment post",
        "live provider/Hermes/Telegram/OpenClaw send",
        "terminal ACK/replay",
      ],
      semantics: {
        workflowPacketIsNotFinalAction: true,
        commentIsDraftOnly: true,
        taskflowSeedCreatesNoRecords: true,
        brokerFinalizerRequired: true,
        singleFinalizerRequired: true,
        providerOrProducedReceiptIsTerminalAck: false,
        performsGitHubMutation: false,
        performsProviderSend: false,
        performsTerminalAck: false,
        performsRuntimeRestartOrDeploy: false,
        performsDbMutation: false,
      },
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/closeout/gate?issueUrl=https://github.com/jinwon-int/a2a-broker/issues/700&prUrl=https://github.com/jinwon-int/a2a-broker/pull/701",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({ workflowPacket: workflow }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-closeout-gate.packet");
    assert.equal(body.decision, "ready_for_approval");
    assert.equal(body.gateState, "approval_required");
    assert.equal(body.executePermitted, false);
    assert.equal(body.integrationContract.openclawMessageSendRequired, false);
    assert.equal(body.semantics.performsGitHubMutation, false);
    assert.equal(body.actions.every((action: Record<string, unknown>) => action.executePermitted === false), true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/closeout/approval-request returns draft-only approval request", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const gate = {
      kind: "a2a-broker.terminal-brief-closeout-gate.packet",
      version: 1,
      generatedAt: "2026-05-18T16:00:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-702",
      decision: "ready_for_approval",
      gateState: "approval_required",
      dryRunOnly: true,
      executePermitted: false,
      idempotencyKey: "tb-closeout-gate:fixture-702",
      finalizer: {
        brokerOfRecordId: "brokeralpha",
        owner: "brokeralpha",
        required: true,
        singleFinalizerRequired: true,
      },
      source: {
        workflowDecision: "ready",
        workflowStep: "finalizer_review",
        workflowIdempotencyKey: "tb-finalizer-workflow:fixture-702",
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/702",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/703",
        blockers: 0,
        reviewItems: 1,
      },
      draftCloseout: {
        title: "Draft: Terminal Brief closeout ready - round-702",
        body: "Draft closeout body. This was not posted automatically.",
        postPermitted: false,
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/702",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/703",
      },
      actions: [
        {
          action: "post_closeout_comment",
          status: "proposed",
          requiresApproval: true,
          executePermitted: false,
          target: "https://github.com/jinwon-int/a2a-broker/issues/702",
          reason: "draft closeout comment is ready but posting is a separate approved mutation",
        },
        {
          action: "merge_pull_request",
          status: "proposed",
          requiresApproval: true,
          executePermitted: false,
          target: "https://github.com/jinwon-int/a2a-broker/pull/703",
          reason: "merge is only a proposed follow-up after finalizer approval",
        },
        {
          action: "live_provider_send",
          status: "forbidden",
          requiresApproval: true,
          executePermitted: false,
          reason: "live sends must stay outside the source-only gate",
        },
      ],
      approvalChecklist: [],
      blockers: [],
      nextActions: [],
      integrationContract: {
        transport: "json",
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
      },
      semantics: {
        closeoutGateIsNotFinalAction: true,
        dryRunOnly: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
        singleFinalizerRequired: true,
        approvalRequiredBeforeGitHubMutation: true,
        approvalRequiredBeforeLiveAction: true,
        providerOrProducedReceiptIsTerminalAck: false,
        performsGitHubMutation: false,
        performsProviderSend: false,
        performsTerminalAck: false,
        performsRuntimeRestartOrDeploy: false,
        performsDbMutation: false,
        createsTaskFlowRecords: false,
        performsReleaseOrPublish: false,
        movesSecretsOrCredentials: false,
      },
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/closeout/approval-request",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({ gatePacket: gate }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-approval-request.packet");
    assert.equal(body.decision, "request_ready");
    assert.equal(body.requestDispatchPermitted, false);
    assert.equal(body.approvalGrantPermitted, false);
    assert.equal(body.executionPermitted, false);
    assert.equal(body.request.sendPermitted, false);
    assert.equal(body.request.presentationPlan.sendPermitted, false);
    assert.equal(body.request.presentationPlan.buttonsEnabled, false);
    assert.equal(body.integrationContract.openclawMessageSendRequired, false);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.request.requestedActions.every((action: Record<string, unknown>) => action.executePermitted === false), true);
    assert.equal(body.request.nonRequestableActions.find((action: Record<string, unknown>) => action.action === "live_provider_send")?.status, "forbidden");
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/closeout/approval-executor returns no-live execute-blocked shell", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const approvalRequest = {
      kind: "a2a-broker.terminal-brief-approval-request.packet",
      version: 1,
      generatedAt: "2026-05-18T20:20:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-704",
      decision: "request_ready",
      dryRunOnly: true,
      requestDispatchPermitted: false,
      approvalGrantPermitted: false,
      executionPermitted: false,
      idempotencyKey: "tb-approval-request:fixture-704",
      finalizer: {
        brokerOfRecordId: "brokeralpha",
        owner: "brokeralpha",
        required: true,
        singleFinalizerRequired: true,
      },
      source: {
        closeoutGateDecision: "ready_for_approval",
        closeoutGateState: "approval_required",
        closeoutGateIdempotencyKey: "tb-closeout-gate:fixture-704",
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/704",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/705",
        proposedActions: 2,
        blockedActions: 0,
        forbiddenActions: 1,
      },
      request: {
        mode: "draft-only",
        title: "Draft approval request: Terminal Brief closeout - round-704",
        body: "Draft approval request body. This was not sent automatically.",
        sendPermitted: false,
        requestedActions: [
          {
            action: "post_closeout_comment",
            status: "requested",
            sourceGateStatus: "proposed",
            requiresApproval: true,
            executePermitted: false,
            target: "https://github.com/jinwon-int/a2a-broker/issues/704",
            reason: "draft closeout comment is ready but posting is a separate approved mutation",
          },
          {
            action: "merge_pull_request",
            status: "requested",
            sourceGateStatus: "proposed",
            requiresApproval: true,
            executePermitted: false,
            target: "https://github.com/jinwon-int/a2a-broker/pull/705",
            reason: "merge is only a proposed follow-up after finalizer approval",
          },
        ],
        nonRequestableActions: [
          {
            action: "live_provider_send",
            status: "forbidden",
            requiresApproval: true,
            executePermitted: false,
            reason: "live sends must stay outside the source-only gate",
          },
        ],
        presentationPlan: {
          kind: "approval_buttons",
          sendPermitted: false,
          buttonsEnabled: false,
          buttons: [],
        },
        cliPlan: {
          mode: "plan-only",
          command: "terminal_brief_approval_request --input closeout-gate.json --json",
          executePermitted: false,
          requiredHumanApproval: true,
        },
      },
      blockers: [],
      nextActions: [],
      integrationContract: {
        transport: "json",
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
        sendsApprovalRequest: false,
      },
      semantics: {
        approvalRequestPlannerOnly: true,
        requestNotSent: true,
        approvalNotGranted: true,
        executionNotPermitted: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
        singleFinalizerRequired: true,
        idempotentRequestDraft: true,
        replayRequiresSameIdempotencyKey: true,
        performsGitHubMutation: false,
        performsProviderSend: false,
        performsTerminalAck: false,
        performsRuntimeRestartOrDeploy: false,
        performsDbMutation: false,
        createsTaskFlowRecords: false,
        performsHistoricalReplay: false,
        performsReleaseOrPublish: false,
        movesSecretsOrCredentials: false,
      },
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/closeout/approval-executor",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          approvalRequest,
          selectedAction: "merge_pull_request",
          attemptExecute: true,
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-approval-executor.packet");
    assert.equal(body.state, "execute_blocked");
    assert.equal(body.dispatchPermitted, false);
    assert.equal(body.approvalGrantPermitted, false);
    assert.equal(body.executionPermitted, false);
    assert.equal(body.dispatch.requestDispatched, false);
    assert.equal(body.approval.realApprovalGranted, false);
    assert.equal(body.approval.simulatedApprovalOnly, true);
    assert.equal(body.execution.state, "execute_blocked");
    assert.equal(body.execution.executed, false);
    assert.equal(body.integrationContract.openclawMessageSendRequired, false);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.executesAction, false);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/closeout/approval-dispatch returns no-live adapter transcript", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const approvalExecutor = {
      kind: "a2a-broker.terminal-brief-approval-executor.packet",
      version: 1,
      generatedAt: "2026-05-18T21:00:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-706",
      state: "dispatch_pending",
      dryRunOnly: true,
      dispatchPermitted: false,
      approvalGrantPermitted: false,
      executionPermitted: false,
      idempotencyKey: "tb-approval-executor:fixture-706",
      finalizer: {
        brokerOfRecordId: "brokeralpha",
        owner: "brokeralpha",
        required: true,
        singleFinalizerRequired: true,
      },
      source: {
        approvalRequestDecision: "request_ready",
        approvalRequestIdempotencyKey: "tb-approval-request:fixture-706",
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/706",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/707",
        requestedActions: 2,
        nonRequestableActions: 1,
      },
      dispatch: {
        state: "dispatch_pending",
        transport: "none",
        requestDispatchPermitted: false,
        requestDispatched: false,
        requestSendPermitted: false,
        reason: "dispatch is intentionally held",
      },
      approval: {
        state: "none",
        realApprovalGranted: false,
        simulatedApprovalOnly: false,
        reason: "no approval selection was supplied",
      },
      execution: {
        state: "not_attempted",
        executePermitted: false,
        executed: false,
        reason: "execution was not attempted and remains forbidden",
      },
      blockers: [],
      nextActions: [],
      integrationContract: {
        transport: "json",
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
        sendsApprovalRequest: false,
        grantsApproval: false,
        executesAction: false,
      },
      semantics: {
        approvalExecutorShellOnly: true,
        dispatchNotPerformed: true,
        approvalNotReallyGranted: true,
        simulatedApprovalOnly: false,
        executionNotPermitted: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
        singleFinalizerRequired: true,
        performsGitHubMutation: false,
        performsProviderSend: false,
        performsTerminalAck: false,
        performsRuntimeRestartOrDeploy: false,
        performsDbMutation: false,
        createsTaskFlowRecords: false,
        performsHistoricalReplay: false,
        performsReleaseOrPublish: false,
        movesSecretsOrCredentials: false,
      },
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/closeout/approval-dispatch",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          approvalExecutor,
          adapter: "mobilealpha",
          target: "hermes://mobilealpha/approval",
          channel: "operator",
          requestedBy: "brokeralpha",
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-approval-dispatch-adapter.packet");
    assert.equal(body.state, "dispatch_draft_ready");
    assert.equal(body.adapter.type, "mobilealpha");
    assert.equal(body.adapter.requiresOpenClawMessageSend, false);
    assert.equal(body.dispatchPermitted, false);
    assert.equal(body.providerSendPermitted, false);
    assert.equal(body.approvalGrantPermitted, false);
    assert.equal(body.executionPermitted, false);
    assert.equal(body.transcript.sent, false);
    assert.equal(body.transcript.sendPermitted, false);
    assert.equal(body.receiptDraft.providerAccepted, false);
    assert.equal(body.receiptDraft.currentSessionVisible, false);
    assert.equal(body.receiptDraft.terminalAck, false);
    assert.equal(body.integrationContract.openclawMessageSendRequired, false);
    assert.equal(body.integrationContract.hermesAdapterCompatible, true);
    assert.equal(body.integrationContract.mobilealphaAdapterCompatible, true);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.executesAction, false);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/closeout/approval-receipt returns no-live receipt evidence classification", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const approvalDispatch = {
      kind: "a2a-broker.terminal-brief-approval-dispatch-adapter.packet",
      version: 1,
      generatedAt: "2026-05-18T21:30:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-708",
      state: "dispatch_draft_ready",
      dryRunOnly: true,
      dispatchPermitted: false,
      providerSendPermitted: false,
      approvalGrantPermitted: false,
      executionPermitted: false,
      terminalReceiptMutationPermitted: false,
      idempotencyKey: "tb-approval-dispatch:fixture-708",
      finalizer: {
        brokerOfRecordId: "broker-finalizer",
        owner: "broker-finalizer",
        required: true,
        singleFinalizerRequired: true,
      },
      adapter: {
        id: "mobilealpha",
        type: "mobilealpha",
        harnessNeutral: true,
        protocol: "json-transcript",
        requiresOpenClawMessageSend: false,
        supportsExternalHarnesses: true,
        liveSendPermitted: false,
      },
      source: {
        executorState: "dispatch_pending",
        executorIdempotencyKey: "tb-approval-executor:fixture-708",
        approvalRequestIdempotencyKey: "tb-approval-request:fixture-708",
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/708",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/710",
        selectedAction: "post_closeout_comment",
        selectedTarget: "https://github.com/jinwon-int/a2a-broker/issues/708",
        requestedActions: 2,
        nonRequestableActions: 1,
      },
      transcript: {
        mode: "draft-only",
        target: "hermes://mobilealpha/approval",
        channel: "operator",
        requestedBy: "broker-finalizer",
        title: "Draft approval dispatch: Terminal Brief closeout - round-708",
        body: "Terminal Brief approval adapter transcript (dry-run).",
        sendPermitted: false,
        sent: false,
      },
      receiptDraft: {
        mode: "draft-only",
        id: "tb-approval-dispatch-receipt:fixture-708",
        providerAccepted: false,
        currentSessionVisible: false,
        terminalAck: false,
        approvalGranted: false,
        actionExecuted: false,
        reason: "dispatch transcript draft only for mobilealpha; no provider send exists",
      },
      blockers: [],
      nextActions: [],
      integrationContract: {
        transport: "json",
        adapterInterfaceVersion: 1,
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
        mobilealphaAdapterCompatible: true,
        sendsApprovalRequest: false,
        producesLiveReceipt: false,
        grantsApproval: false,
        executesAction: false,
      },
      semantics: {
        adapterShellOnly: true,
        transcriptDraftOnly: true,
        dispatchNotPerformed: true,
        receiptIsDraftOnly: true,
        providerAcceptedIsVisibilityProof: false,
        approvalNotReallyGranted: true,
        executionNotPermitted: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
        singleFinalizerRequired: true,
        performsGitHubMutation: false,
        performsProviderSend: false,
        performsTerminalAck: false,
        performsRuntimeRestartOrDeploy: false,
        performsDbMutation: false,
        createsTaskFlowRecords: false,
        performsHistoricalReplay: false,
        performsReleaseOrPublish: false,
        movesSecretsOrCredentials: false,
      },
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/closeout/approval-receipt",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          approvalDispatch,
          receiptEvidence: [
            {
              kind: "current_session_visible",
              observedAt: new Date().toISOString(),
              receiptId: "receipt-visible-route",
              currentSessionId: "session-current",
            },
          ],
          maxAgeMs: 300000,
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-approval-receipt-ingestor.packet");
    assert.equal(body.state, "accepted");
    assert.equal(body.receiptEvidenceAccepted, true);
    assert.equal(body.classification.currentSessionVisible, true);
    assert.equal(body.classification.providerAcceptedIsVisibilityProof, false);
    assert.equal(body.classification.terminalAckEligible, true);
    assert.equal(body.terminalAckPermitted, false);
    assert.equal(body.terminalReceiptMutationPermitted, false);
    assert.equal(body.approvalGrantPermitted, false);
    assert.equal(body.executionPermitted, false);
    assert.equal(body.integrationContract.providerAcceptedIsVisibilityProof, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.executesAction, false);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/closeout/finalizer-approval-status returns no-live finalizer status table", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const approvalDispatch = {
      kind: "a2a-broker.terminal-brief-approval-dispatch-adapter.packet",
      version: 1,
      generatedAt: "2026-05-18T22:30:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-709",
      state: "dispatch_draft_ready",
      idempotencyKey: "tb-approval-dispatch:fixture-709",
      finalizer: {
        brokerOfRecordId: "broker-finalizer",
        owner: "broker-finalizer",
        required: true,
        singleFinalizerRequired: true,
      },
      adapter: {
        id: "mobilealpha",
        type: "mobilealpha",
      },
      source: {
        targetIssueUrl: "https://github.com/jinwon-int/a2a-broker/issues/709",
        targetPrUrl: "https://github.com/jinwon-int/a2a-broker/pull/711",
        selectedAction: "post_closeout_comment",
        selectedTarget: "https://github.com/jinwon-int/a2a-broker/issues/709",
        requestedActions: 2,
        nonRequestableActions: 1,
      },
      transcript: {
        target: "hermes://mobilealpha/approval",
        channel: "operator",
      },
      blockers: [],
    };
    const approvalReceipt = {
      kind: "a2a-broker.terminal-brief-approval-receipt-ingestor.packet",
      version: 1,
      generatedAt: "2026-05-18T22:30:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-709",
      state: "accepted",
      idempotencyKey: "tb-approval-receipt:fixture-709",
      receiptEvidenceAccepted: true,
      classification: {
        providerAccepted: false,
        currentSessionVisible: true,
        manualOperatorConfirmed: false,
        approvalGrantAccepted: true,
        terminalAckEligible: true,
      },
      blockers: [],
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/closeout/finalizer-approval-status",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          approvalDispatch,
          approvalReceipt,
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-finalizer-approval-status.packet");
    assert.equal(body.state, "ready_for_finalizer_review");
    assert.equal(body.table.requiredRowsReady, 3);
    assert.equal(body.approval.currentSessionVisible, true);
    assert.equal(body.approval.approvalGrantAccepted, true);
    assert.equal(body.approval.terminalAckPermitted, false);
    assert.equal(body.approval.approvalGrantPermitted, false);
    assert.equal(body.approval.executionPermitted, false);
    assert.equal(body.defaultOnReadiness.sourceCriteriaMet, true);
    assert.equal(body.defaultOnReadiness.defaultOnPermitted, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.executesAction, false);
  } finally {
    await server.close();
  }
});

// The 16 POST /terminal-brief/sidecar/<route> tests that followed were removed
// with those routes (#1665). The six closeout gate tests above cover the
// terminal-brief product surface, which stays.
