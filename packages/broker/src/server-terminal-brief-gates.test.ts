import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
        brokerOfRecordId: "seoseo",
        owner: "seoseo",
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
        brokerOfRecordId: "seoseo",
        owner: "seoseo",
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
        brokerOfRecordId: "seoseo",
        owner: "seoseo",
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
        brokerOfRecordId: "seoseo",
        owner: "seoseo",
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
          adapter: "gongyung",
          target: "hermes://gongyung/approval",
          channel: "operator",
          requestedBy: "seoseo",
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-approval-dispatch-adapter.packet");
    assert.equal(body.state, "dispatch_draft_ready");
    assert.equal(body.adapter.type, "gongyung");
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
    assert.equal(body.integrationContract.gongyungAdapterCompatible, true);
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
        id: "gongyung",
        type: "gongyung",
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
        target: "hermes://gongyung/approval",
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
        reason: "dispatch transcript draft only for gongyung; no provider send exists",
      },
      blockers: [],
      nextActions: [],
      integrationContract: {
        transport: "json",
        adapterInterfaceVersion: 1,
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
        gongyungAdapterCompatible: true,
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
        id: "gongyung",
        type: "gongyung",
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
        target: "hermes://gongyung/approval",
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

test("POST /terminal-brief/sidecar/dry-run-gate returns no-live sidecar operating gate", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const sidecarRehearsal = {
      kind: "a2a-broker.terminal-brief-sidecar-integration-rehearsal",
      version: 1,
      generatedAt: "2026-05-18T23:30:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-712",
      decision: "candidate",
      sidecar: {
        spoolRecords: 3,
        finalCountSignalsFromSpool: 3,
        receiptDecisions: 1,
        terminalReceiptStatuses: ["produced"],
        providerSendAttempted: false,
        terminalAckAttempted: false,
        dryRunOnly: true,
        unsafeSpoolRecords: [],
      },
      finalCountCandidate: {
        decision: "candidate",
        idempotencyKey: "tb-final-count:fixture-712",
      },
      blockers: [],
    };
    const finalizerApprovalStatus = {
      kind: "a2a-broker.terminal-brief-finalizer-approval-status.packet",
      version: 1,
      generatedAt: "2026-05-18T23:30:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-712",
      state: "ready_for_finalizer_review",
      idempotencyKey: "tb-finalizer-approval-status:fixture-712",
      defaultOnReadiness: {
        sourceCriteriaMet: true,
        defaultOnPermitted: false,
        missingEvidence: [],
      },
      blockers: [],
    };

    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/dry-run-gate",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          sidecarRehearsal,
          finalizerApprovalStatus,
          operatingEvidence: {
            observedAt: new Date().toISOString(),
            cursorPersisted: true,
            boundedPolling: true,
            pollIntervalMs: 15000,
            maxBatch: 20,
            gatewayReady: true,
            eventLoopDegraded: false,
            queueBacklog: 0,
            dryRunOnly: true,
            operatorEventsCrossBrokersEnabled: false,
            supervisedSidecar: true,
          },
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-dry-run-gate.packet");
    assert.equal(body.state, "ready_for_operator_approval");
    assert.equal(body.table.requiredRowsReady, 5);
    assert.equal(body.readiness.sourceCriteriaMet, true);
    assert.equal(body.readiness.alwaysOnDryRunCandidate, true);
    assert.equal(body.readiness.alwaysOnDryRunStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.liveActivationPermitted, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.integrationContract.enablesDefaultOn, false);
    assert.equal(body.semantics.performsRuntimeRestartOrDeploy, false);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/activation-approval returns no-live approval request draft", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const sidecarDryRunGate = {
      kind: "a2a-broker.terminal-brief-sidecar-dry-run-gate.packet",
      version: 1,
      generatedAt: "2026-05-18T14:00:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-714",
      state: "ready_for_operator_approval",
      dryRunOnly: true,
      sourceOnlyNoLive: true,
      idempotencyKey: "tb-sidecar-dry-run-gate:fixture-714",
      source: {
        sidecarDecision: "candidate",
        sidecarSpoolRecords: 3,
        sidecarReceiptDecisions: 1,
        sidecarDryRunOnly: true,
        providerSendAttempted: false,
        terminalAckAttempted: false,
        finalCountDecision: "candidate",
        finalizerStatus: "ready_for_finalizer_review",
        finalizerStatusIdempotencyKey: "tb-finalizer-approval-status:fixture-714",
      },
      operatingEvidence: {
        observedAt: "2026-05-18T14:00:00.000Z",
        stale: false,
        cursorPersisted: true,
        boundedPolling: true,
        pollIntervalMs: 15000,
        maxBatch: 20,
        gatewayReady: true,
        eventLoopDegraded: false,
        queueBacklog: 0,
        dryRunOnly: true,
        operatorEventsCrossBrokersEnabled: false,
        supervisedSidecar: true,
      },
      table: {
        rows: [],
        requiredRowsReady: 5,
        requiredRows: 5,
        readyRows: 5,
        totalRows: 6,
      },
      readiness: {
        sourceCriteriaMet: true,
        alwaysOnDryRunCandidate: true,
        alwaysOnDryRunStartPermitted: false,
        defaultOnPermitted: false,
        liveActivationPermitted: false,
        missingEvidence: [],
        blockers: [],
        nextAction: "request explicit operator approval for dry-run sidecar supervision/canary",
      },
      blockers: [],
      nextActions: [],
      approvalSensitiveActionsExcluded: [],
      integrationContract: {
        transport: "json",
        gateVersion: 1,
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
        gongyungAdapterCompatible: true,
        consumesSidecarIntegrationRehearsal: true,
        consumesFinalizerApprovalStatus: true,
        grantsApproval: false,
        startsSidecar: false,
        enablesDefaultOn: false,
        executesAction: false,
      },
      semantics: {
        operatingGateOnly: true,
        sourceOnlyNoLive: true,
        gateDoesNotMutateState: true,
        sidecarDryRunCandidateDoesNotStartSidecar: true,
        providerAcceptedIsVisibilityProof: false,
        terminalAckEligibleDoesNotPermitAck: true,
        approvalGrantEvidenceDoesNotGrantApproval: true,
        defaultOnNotEnabledByThisPacket: true,
        executionNotPermitted: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
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
      server.baseUrl + "/terminal-brief/sidecar/activation-approval",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          sidecarDryRunGate,
          activationApproval: {
            requestedBy: "broker-finalizer",
            operatorTarget: "operator-a",
            approvalWindowMinutes: 30,
          },
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-activation-approval.packet");
    assert.equal(body.state, "approval_request_draft_ready");
    assert.equal(body.requestDraft.status, "draft_not_sent");
    assert.equal(body.requestDraft.dispatchPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.requestDraftIsNotSend, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/activation-receipt returns no-live activation receipt evidence", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const sidecarActivationApproval = {
      kind: "a2a-broker.terminal-brief-sidecar-activation-approval.packet",
      version: 1,
      generatedAt: "2026-05-18T15:00:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-716",
      state: "approval_request_draft_ready",
      dryRunOnly: true,
      sourceOnlyNoLive: true,
      idempotencyKey: "tb-sidecar-activation-approval:fixture-716",
      source: {
        gateState: "ready_for_operator_approval",
        gateIdempotencyKey: "tb-sidecar-dry-run-gate:fixture-716",
        sourceCriteriaMet: true,
        alwaysOnDryRunCandidate: true,
        requiredRowsReady: 5,
        requiredRows: 5,
        sidecarDecision: "candidate",
        finalizerStatus: "ready_for_finalizer_review",
      },
      requestDraft: {
        status: "draft_not_sent",
        requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
        requestedBy: "broker-finalizer",
        operatorTarget: "operator-a",
        approvalExpiresAt: "2026-05-18T15:30:00.000Z",
        dispatchRequired: true,
        dispatchPermitted: false,
        transcriptDraft: "Request: approve supervised Terminal Brief sidecar dry-run start.",
      },
      activationPlan: {
        supervisedDryRunOnly: true,
        cursorPersisted: true,
        boundedPolling: true,
        pollIntervalMs: 15000,
        maxBatch: 20,
        gatewayReady: true,
        eventLoopDegraded: false,
        queueBacklog: 0,
        abortQueueBacklog: 1000,
        abortConditions: [],
        rollbackInstructions: [],
      },
      readiness: {
        approvalRequestDraftReady: true,
        sidecarStartPermitted: false,
        defaultOnPermitted: false,
        liveActivationPermitted: false,
        approvalGrantPermitted: false,
        providerSendPermitted: false,
        terminalAckPermitted: false,
        executionPermitted: false,
        missingEvidence: [],
        blockers: [],
        nextAction: "dispatch this draft through the selected harness adapter and ingest explicit operator approval evidence before any sidecar start",
      },
      blockers: [],
      nextActions: [],
      approvalSensitiveActionsExcluded: [],
      integrationContract: {
        transport: "json",
        approvalPacketVersion: 1,
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
        gongyungAdapterCompatible: true,
        consumesSidecarDryRunGate: true,
        producesApprovalRequestDraft: true,
        sendsApprovalRequest: false,
        grantsApproval: false,
        startsSidecar: false,
        enablesDefaultOn: false,
        executesAction: false,
      },
      semantics: {
        approvalRequestDraftOnly: true,
        sourceOnlyNoLive: true,
        requestDraftIsNotSend: true,
        approvalRequestIsNotApprovalGrant: true,
        sidecarStartRequiresSeparateApprovedExecutor: true,
        defaultOnNotEnabledByThisPacket: true,
        providerAcceptedIsVisibilityProof: false,
        terminalAckEligibleDoesNotPermitAck: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
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
      server.baseUrl + "/terminal-brief/sidecar/activation-receipt",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          sidecarActivationApproval,
          activationReceiptEvidence: [
            { kind: "current_session_visible", observedAt: new Date().toISOString() },
            {
              kind: "approval_grant",
              observedAt: new Date().toISOString(),
              approvedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
              approvedTarget: "round-716",
              operatorId: "operator-a",
            },
          ],
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-activation-receipt-ingestor.packet");
    assert.equal(body.state, "accepted");
    assert.equal(body.receiptEvidenceAccepted, true);
    assert.equal(body.approvalEvidenceAccepted, true);
    assert.equal(body.classification.providerAcceptedIsVisibilityProof, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.receiptIngestorOnly, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/start-executor-gate returns no-live start executor gate", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const sidecarActivationReceipt = {
      kind: "a2a-broker.terminal-brief-sidecar-activation-receipt-ingestor.packet",
      version: 1,
      generatedAt: "2026-05-18T16:00:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-718",
      state: "accepted",
      dryRunOnly: true,
      sourceOnlyNoLive: true,
      receiptEvidenceAccepted: true,
      approvalEvidenceAccepted: true,
      idempotencyKey: "tb-sidecar-activation-receipt:fixture-718",
      source: {
        activationApprovalState: "approval_request_draft_ready",
        activationApprovalIdempotencyKey: "tb-sidecar-activation-approval:fixture-718",
        requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
        requestedBy: "broker-finalizer",
        operatorTarget: "operator-a",
        dispatchRequired: true,
        dispatchPermitted: false,
      },
      evidence: {
        received: 3,
        acceptedKinds: ["current_session_visible", "approval_grant"],
        staleKinds: [],
        conflictingKinds: [],
        rejectedKinds: [],
        records: [],
      },
      classification: {
        providerAccepted: true,
        currentSessionVisible: true,
        manualOperatorConfirmed: false,
        approvalGrantAccepted: true,
        receiptProofAccepted: true,
        rejected: false,
        expired: false,
        stale: false,
        terminalAckEligible: true,
        providerAcceptedIsVisibilityProof: false,
        reason: "visibility/manual receipt evidence and matching approval grant evidence accepted as no-live evidence only",
      },
      readiness: {
        sourceCriteriaMet: true,
        approvalEvidenceAccepted: true,
        sidecarStartPermitted: false,
        defaultOnPermitted: false,
        liveActivationPermitted: false,
        approvalGrantPermitted: false,
        providerSendPermitted: false,
        terminalAckPermitted: false,
        executionPermitted: false,
        blockers: [],
        nextAction: "feed accepted no-live approval evidence into the supervised dry-run start executor gate",
      },
      blockers: [],
      nextActions: [],
      approvalSensitiveActionsExcluded: [],
      integrationContract: {
        transport: "json",
        evidenceSchemaVersion: 1,
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
        gongyungAdapterCompatible: true,
        consumesActivationApprovalPacket: true,
        providerAcceptedIsVisibilityProof: false,
        terminalAckRequiresVisibilityProof: true,
        grantsApproval: false,
        startsSidecar: false,
        enablesDefaultOn: false,
        executesAction: false,
      },
      semantics: {
        receiptIngestorOnly: true,
        sourceOnlyNoLive: true,
        evidenceDoesNotMutateState: true,
        providerAcceptedIsVisibilityProof: false,
        terminalAckEligibleDoesNotPermitAck: true,
        approvalGrantEvidenceDoesNotGrantApproval: true,
        sidecarStartRequiresSeparateApprovedExecutor: true,
        defaultOnNotEnabledByThisPacket: true,
        executionNotPermitted: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
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
      server.baseUrl + "/terminal-brief/sidecar/start-executor-gate",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          sidecarActivationReceipt,
          startExecutorGate: {
            requestedExecutor: "dry-run-executor",
            commandName: "terminal-brief-sidecar",
            commandArgs: ["--dry-run"],
            envKeys: ["EDGE_SECRET"],
          },
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-start-executor-gate.packet");
    assert.equal(body.state, "ready_for_start_executor_review");
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.startPlan.commandShape.commandExecutionPermitted, false);
    assert.equal(body.startPlan.commandShape.secretsIncluded, false);
    assert.equal(body.integrationContract.dispatchesStartExecutor, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.commandShapeIsMetadataOnly, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/executor-invocation-rehearsal returns no-live invocation rehearsal", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const startExecutorGate = {
      kind: "a2a-broker.terminal-brief-sidecar-start-executor-gate.packet",
      version: 1,
      generatedAt: "2026-05-18T18:00:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-720",
      state: "ready_for_start_executor_review",
      dryRunOnly: true,
      sourceOnlyNoLive: true,
      idempotencyKey: "tb-sidecar-start-executor-gate:fixture-720",
      source: {
        receiptState: "accepted",
        receiptIdempotencyKey: "tb-sidecar-activation-receipt:fixture-720",
        receiptEvidenceAccepted: true,
        approvalEvidenceAccepted: true,
        terminalAckEligible: true,
        requestedAction: "approve_supervised_terminal_brief_sidecar_dry_run_start",
        operatorTarget: "operator-a",
      },
      startPlan: {
        supervisedDryRunOnly: true,
        requestedExecutor: "gongyung-sidecar-dry-run-executor",
        operatorApprovalReference: "operator-visible-approval-720",
        dryRunReason: "sidecar-gongyung-spool-dry-run",
        commandShape: {
          kind: "metadata_only",
          commandName: "terminal-brief-sidecar",
          commandArgs: ["--dry-run", "--poll-ms", "15000"],
          envKeys: ["EDGE_SECRET"],
          commandExecutionPermitted: false,
          secretsIncluded: false,
        },
        abortConditions: ["Gateway readiness is false"],
        rollbackInstructions: ["do not start the sidecar from this gate packet"],
      },
      readiness: {
        sourceCriteriaMet: true,
        startExecutorReviewReady: true,
        startExecutorDispatchPermitted: false,
        sidecarStartPermitted: false,
        defaultOnPermitted: false,
        liveActivationPermitted: false,
        approvalGrantPermitted: false,
        providerSendPermitted: false,
        terminalAckPermitted: false,
        executionPermitted: false,
        missingEvidence: [],
        blockers: [],
        nextAction: "request explicit operator approval for a separate supervised dry-run start executor invocation",
      },
      blockers: [],
      nextActions: [],
      approvalSensitiveActionsExcluded: [],
      integrationContract: {
        transport: "json",
        gateVersion: 1,
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
        gongyungAdapterCompatible: true,
        consumesActivationReceiptIngestorPacket: true,
        dispatchesStartExecutor: false,
        grantsApproval: false,
        startsSidecar: false,
        enablesDefaultOn: false,
        executesAction: false,
      },
      semantics: {
        startExecutorGateOnly: true,
        sourceOnlyNoLive: true,
        gateDoesNotMutateState: true,
        commandShapeIsMetadataOnly: true,
        providerAcceptedIsVisibilityProof: false,
        terminalAckEligibleDoesNotPermitAck: true,
        approvalGrantEvidenceDoesNotGrantApproval: true,
        sidecarStartRequiresSeparateApprovedExecutor: true,
        defaultOnNotEnabledByThisPacket: true,
        executionNotPermitted: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
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
      server.baseUrl + "/terminal-brief/sidecar/executor-invocation-rehearsal",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          startExecutorGate,
          executorInvocationRehearsal: {
            adapterName: "gongyung",
            executorRuntime: "metadata-only",
            supervisor: "terminal-brief-sidecar-worker",
          },
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-executor-invocation-rehearsal.packet");
    assert.equal(body.state, "ready_for_executor_invocation_rehearsal");
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.invocationPlan.commandShape.commandExecutionPermitted, false);
    assert.equal(body.invocationPlan.commandShape.processSpawnPermitted, false);
    assert.equal(body.invocationPlan.commandShape.secretsIncluded, false);
    assert.equal(body.invocationPlan.adapterContract.version, 1);
    assert.equal(body.invocationPlan.adapterContract.transport, "json-stdin-stdout");
    assert.equal(body.invocationPlan.adapterContract.input.envKeysOnly, true);
    assert.equal(body.invocationPlan.adapterContract.output.mustReportAbortEvidence, true);
    assert.equal(body.invocationPlan.adapterContract.output.providerAcceptedIsReceiptProof, false);
    assert.equal(body.invocationPlan.adapterContract.output.terminalAckPermitted, false);
    assert.equal(body.readiness.adapterContractReady, true);
    assert.equal(body.integrationContract.adapterContractVersion, 1);
    assert.equal(body.integrationContract.requiresAbortEvidence, true);
    assert.equal(body.integrationContract.invokesExecutor, false);
    assert.equal(body.integrationContract.spawnsProcess, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.executorInvocationRehearsalOnly, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/runtime-preflight-approval returns source-only approval packet", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const fixture = JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-runtime-preflight-approval.no-live.json", "utf8"));
    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/runtime-preflight-approval",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(fixture),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-runtime-preflight-approval.packet");
    assert.equal(body.state, "approval_packet_ready");
    assert.equal(body.source.adapterContractReady, true);
    assert.equal(body.runtimePreflight.adapterContract.version, 1);
    assert.equal(body.runtimePreflight.adapterContract.output.providerAcceptedIsReceiptProof, false);
    assert.equal(body.runtimePreflight.adapterContract.output.terminalAckPermitted, false);
    assert.equal(body.readiness.approvalRequestDispatchPermitted, false);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.integrationContract.invokesExecutor, false);
    assert.equal(body.integrationContract.spawnsProcess, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.runtimePreflightApprovalPacketOnly, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/adapter-handoff-approval returns source-only handoff packet", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const fixture = JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-adapter-handoff-approval.no-live.json", "utf8"));
    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/adapter-handoff-approval",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          runtimePreflightApprovalPacket: fixture,
          adapterHandoffApproval: {
            adapterId: "gongyung-approval-renderer",
            deliveryTargetClass: "manual-operator-channel",
            handoffReference: "handoff-741",
          },
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-adapter-handoff-approval.packet");
    assert.equal(body.state, "handoff_packet_ready");
    assert.equal(body.source.runtimePreflightApprovalReady, true);
    assert.equal(body.source.adapterContractReady, true);
    assert.equal(body.adapterHandoff.draftOnly, true);
    assert.equal(body.adapterHandoff.adapterId, "gongyung-approval-renderer");
    assert.equal(body.adapterHandoff.dispatchPermitted, false);
    assert.equal(body.adapterHandoff.providerSendPermitted, false);
    assert.equal(body.adapterHandoff.approvalGrantPermitted, false);
    assert.equal(body.adapterHandoff.terminalAckPermitted, false);
    assert.equal(body.adapterHandoff.executionPermitted, false);
    assert.equal(body.readiness.approvalRequestDispatchPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.integrationContract.rendersApprovalRequestDraft, true);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.integrationContract.invokesExecutor, false);
    assert.equal(body.integrationContract.spawnsProcess, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.adapterHandoffPacketOnly, true);
    assert.equal(body.semantics.handoffDoesNotSendApprovalRequest, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/operator-review-table returns source-only review table", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const fixture = JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-operator-review-table.no-live.json", "utf8"));
    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/operator-review-table",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          adapterHandoffApprovalPacket: fixture,
          operatorReviewTable: {
            reviewOwner: "seoseo",
            reviewReference: "operator-review-743",
          },
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-operator-review-table.packet");
    assert.equal(body.state, "review_table_ready");
    assert.equal(body.source.adapterHandoffReady, true);
    assert.equal(body.operatorReview.tableOnly, true);
    assert.equal(body.operatorReview.rows.length, 8);
    assert.equal(body.operatorReview.readyRowCount, 8);
    assert.equal(body.operatorReview.dispatchPermitted, false);
    assert.equal(body.operatorReview.providerSendPermitted, false);
    assert.equal(body.operatorReview.approvalGrantPermitted, false);
    assert.equal(body.operatorReview.terminalAckPermitted, false);
    assert.equal(body.operatorReview.executionPermitted, false);
    assert.equal(body.readiness.approvalRequestDispatchPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.integrationContract.rendersOperatorReviewTable, true);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.integrationContract.invokesExecutor, false);
    assert.equal(body.integrationContract.spawnsProcess, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.operatorReviewTableOnly, true);
    assert.equal(body.semantics.reviewDoesNotSendApprovalRequest, true);
    assert.equal(body.semantics.reviewDoesNotGrantApproval, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/review-decision returns source-only decision evidence", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const fixture = JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-review-decision-ingestor.no-live.json", "utf8"));
    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/review-decision",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(fixture),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-review-decision-ingestor.packet");
    assert.equal(body.state, "approved_evidence");
    assert.equal(body.decisionEvidence.acceptedApprovalEvidence, true);
    assert.equal(body.readiness.reviewDecisionEvidenceAccepted, true);
    assert.equal(body.readiness.approvalRequestDispatchPermitted, false);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.readiness.dbMutationPermitted, false);
    assert.equal(body.integrationContract.classifiesOperatorDecisionEvidence, true);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.invokesExecutor, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.reviewDecisionIngestorOnly, true);
    assert.equal(body.semantics.acceptedDecisionEvidenceDoesNotGrantApproval, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/approval-grant-proposal returns source-only grant proposal", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const fixture = JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-approval-grant-proposal.no-live.json", "utf8"));
    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/approval-grant-proposal",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(fixture),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-approval-grant-proposal.packet");
    assert.equal(body.state, "ready_for_grant_proposal_review");
    assert.equal(body.readiness.grantProposalReady, true);
    assert.equal(body.grantProposal.proposalOnly, true);
    assert.equal(body.grantProposal.grantWouldRemainSeparateAction, true);
    assert.equal(body.readiness.approvalRequestDispatchPermitted, false);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.approvalGrantExecutionPermitted, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.integrationContract.preparesGrantProposal, true);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.executesApprovalGrant, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.proposalDoesNotGrantApproval, true);
    assert.equal(body.semantics.approvalGrantRequiresSeparateOperatorAction, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/approval-grant-evidence returns source-only grant evidence", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const fixture = JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-approval-grant-evidence-ingestor.no-live.json", "utf8"));
    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/approval-grant-evidence",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(fixture),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-approval-grant-evidence-ingestor.packet");
    assert.equal(body.state, "grant_evidence_accepted");
    assert.equal(body.grantEvidence.acceptedGrantEvidence, true);
    assert.equal(body.readiness.grantEvidenceAccepted, true);
    assert.equal(body.readiness.approvalRequestDispatchPermitted, false);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.approvalGrantExecutionPermitted, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.integrationContract.classifiesGrantEvidence, true);
    assert.equal(body.integrationContract.grantsApproval, false);
    assert.equal(body.integrationContract.executesApprovalGrant, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.acceptedGrantEvidenceDoesNotExecuteGrant, true);
    assert.equal(body.semantics.acceptedGrantEvidenceDoesNotAuthorizeRuntime, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/execution-gate-final-review returns source-only final review", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const fixture = JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-execution-gate-final-review.no-live.json", "utf8"));
    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/execution-gate-final-review",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(fixture),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-execution-gate-final-review.packet");
    assert.equal(body.state, "ready_for_execution_gate_final_review");
    assert.equal(body.readiness.finalReviewReady, true);
    assert.equal(body.finalReview.reviewOnly, true);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.integrationContract.rendersExecutionGateFinalReview, true);
    assert.equal(body.integrationContract.dispatchesStartExecutor, false);
    assert.equal(body.integrationContract.invokesExecutor, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.reviewDoesNotDispatchExecutor, true);
    assert.equal(body.semantics.acceptedGrantEvidenceDoesNotAuthorizeRuntime, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/executor-dispatch-request-draft returns source-only dispatch draft", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const fixture = JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-executor-dispatch-request-draft.no-live.json", "utf8"));
    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/executor-dispatch-request-draft",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(fixture),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-executor-dispatch-request-draft.packet");
    assert.equal(body.state, "dispatch_request_draft_ready");
    assert.equal(body.readiness.dispatchRequestDraftReady, true);
    assert.equal(body.dispatchRequestDraft.draftOnly, true);
    assert.equal(body.dispatchRequestDraft.commandMetadata.secretValuesIncluded, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.integrationContract.rendersExecutorDispatchRequestDraft, true);
    assert.equal(body.integrationContract.dispatchesStartExecutor, false);
    assert.equal(body.integrationContract.invokesExecutor, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.draftDoesNotDispatchExecutor, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/dispatcher-preflight-seal returns source-only preflight seal", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const fixture = JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-dispatcher-preflight-seal.no-live.json", "utf8"));
    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/dispatcher-preflight-seal",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(fixture),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-dispatcher-preflight-seal.packet");
    assert.equal(body.state, "dispatcher_preflight_seal_ready");
    assert.equal(body.readiness.dispatcherPreflightSealReady, true);
    assert.equal(body.runtimeEvidence.suppliedOnly, true);
    assert.equal(body.sealedEnvelope.sealOnly, true);
    assert.equal(body.sealedEnvelope.integrityVerified, true);
    assert.equal(body.sealedEnvelope.secretValuesIncluded, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.integrationContract.collectsLiveEvidence, false);
    assert.equal(body.integrationContract.dispatchesStartExecutor, false);
    assert.equal(body.semantics.sealDoesNotDispatchExecutor, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/dispatcher-approval-handoff returns source-only approval handoff", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const fixture = JSON.parse(readFileSync("fixtures/terminal-brief/sidecar-dispatcher-approval-handoff.no-live.json", "utf8"));
    const res = await fetch(
      server.baseUrl + "/terminal-brief/sidecar/dispatcher-approval-handoff",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify(fixture),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-dispatcher-approval-handoff.packet");
    assert.equal(body.state, "dispatcher_approval_handoff_ready");
    assert.equal(body.readiness.dispatcherApprovalHandoffReady, true);
    assert.equal(body.approvalHandoffDraft.draftOnly, true);
    assert.equal(body.approvalHandoffDraft.dispatchPermitted, false);
    assert.equal(body.approvalHandoffDraft.approvalGrantPermitted, false);
    assert.equal(body.approvalHandoffDraft.approvalGrantExecutionPermitted, false);
    assert.equal(body.approvalHandoffDraft.startExecutorDispatchPermitted, false);
    assert.equal(body.approvalHandoffDraft.executorInvocationPermitted, false);
    assert.equal(body.approvalHandoffDraft.processSpawnPermitted, false);
    assert.equal(body.approvalHandoffDraft.sidecarStartPermitted, false);
    assert.equal(body.approvalHandoffDraft.defaultOnPermitted, false);
    assert.equal(body.approvalHandoffDraft.providerSendPermitted, false);
    assert.equal(body.approvalHandoffDraft.terminalAckPermitted, false);
    assert.equal(body.approvalHandoffDraft.executionPermitted, false);
    assert.equal(body.approvalHandoffDraft.dbMutationPermitted, false);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.integrationContract.dispatchesStartExecutor, false);
    assert.equal(body.integrationContract.invokesExecutor, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.handoffDoesNotSendApprovalRequest, true);
    assert.equal(body.semantics.handoffDoesNotDispatchExecutor, true);
  } finally {
    await server.close();
  }
});

test("POST /terminal-brief/sidecar/dry-run-start-canary-plan returns draft-only no-live canary plan", async () => {
  const server = await startTestServer({ edgeSecret: "test-edge-secret" });
  try {
    const executorInvocationRehearsal = {
      kind: "a2a-broker.terminal-brief-sidecar-executor-invocation-rehearsal.packet",
      version: 1,
      generatedAt: "2026-05-18T20:00:00.000Z",
      mode: "read-only/no-live",
      parentRoundId: "round-724",
      state: "ready_for_executor_invocation_rehearsal",
      dryRunOnly: true,
      sourceOnlyNoLive: true,
      idempotencyKey: "tb-sidecar-executor-invocation-rehearsal:fixture-724",
      source: {
        startExecutorGateState: "ready_for_start_executor_review",
        startExecutorGateIdempotencyKey: "tb-sidecar-start-executor-gate:fixture-724",
        startExecutorReviewReady: true,
        requestedExecutor: "gongyung-sidecar-dry-run-executor",
        operatorApprovalReference: "operator-visible-approval-724",
        commandShapeKind: "metadata_only",
      },
      invocationPlan: {
        rehearsalOnly: true,
        supervisedDryRunOnly: true,
        executorName: "gongyung-sidecar-dry-run-executor",
        adapterName: "gongyung",
        executorRuntime: "metadata-only",
        supervisor: "terminal-brief-sidecar-worker",
        commandShape: {
          kind: "metadata_only",
          commandName: "terminal-brief-sidecar",
          commandArgs: ["--dry-run", "--poll-ms", "15000"],
          envKeys: ["EDGE_SECRET"],
          inheritedFromStartGate: true,
          commandExecutionPermitted: false,
          processSpawnPermitted: false,
          secretsIncluded: false,
        },
        preflightChecks: ["source start executor gate is ready_for_start_executor_review"],
        abortConditions: ["Gateway readiness is false"],
        rollbackInstructions: ["discard this rehearsal packet if source gate evidence changes"],
        expectedEvidence: ["operator-reviewed metadata-only invocation plan"],
      },
      readiness: {
        sourceCriteriaMet: true,
        executorInvocationRehearsalReady: true,
        startExecutorDispatchPermitted: false,
        executorInvocationPermitted: false,
        processSpawnPermitted: false,
        sidecarStartPermitted: false,
        defaultOnPermitted: false,
        liveActivationPermitted: false,
        approvalGrantPermitted: false,
        providerSendPermitted: false,
        terminalAckPermitted: false,
        executionPermitted: false,
        missingEvidence: [],
        blockers: [],
        nextAction: "review the metadata-only invocation rehearsal",
      },
      blockers: [],
      nextActions: [],
      approvalSensitiveActionsExcluded: [],
      integrationContract: {
        transport: "json",
        rehearsalVersion: 1,
        harnessNeutral: true,
        openclawMessageSendRequired: false,
        hermesAdapterCompatible: true,
        gongyungAdapterCompatible: true,
        consumesStartExecutorGatePacket: true,
        dispatchesStartExecutor: false,
        invokesExecutor: false,
        spawnsProcess: false,
        startsSidecar: false,
        enablesDefaultOn: false,
        executesAction: false,
      },
      semantics: {
        executorInvocationRehearsalOnly: true,
        sourceOnlyNoLive: true,
        rehearsalDoesNotMutateState: true,
        commandShapeIsMetadataOnly: true,
        commandShapeDoesNotContainSecretValues: true,
        startExecutorGateDoesNotPermitInvocation: true,
        providerAcceptedIsVisibilityProof: false,
        terminalAckEligibleDoesNotPermitAck: true,
        sidecarStartRequiresSeparateApprovedExecutor: true,
        defaultOnNotEnabledByThisPacket: true,
        executionNotPermitted: true,
        processSpawnNotPermitted: true,
        routeIsReadOnly: true,
        brokerFinalizerRequired: true,
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
      server.baseUrl + "/terminal-brief/sidecar/dry-run-start-canary-plan",
      {
        method: "POST",
        headers: jsonHeaders({
          "x-a2a-edge-secret": "test-edge-secret",
          "x-a2a-requester-id": "operator-a",
          "x-a2a-requester-role": "operator",
        }),
        body: JSON.stringify({
          executorInvocationRehearsal,
          dryRunStartCanaryPlan: {
            operatorTarget: "operator-a",
            canaryWindowMinutes: 30,
            monitorIntervalSeconds: 60,
            maxQueueBacklog: 1000,
          },
        }),
      },
    );

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.equal(body.kind, "a2a-broker.terminal-brief-sidecar-dry-run-start-canary-plan.packet");
    assert.equal(body.state, "ready_for_dry_run_start_approval_request");
    assert.equal(body.approvalRequestDraft.dispatchPermitted, false);
    assert.equal(body.approvalRequestDraft.sendsApprovalRequest, false);
    assert.equal(body.readiness.approvalRequestDispatchPermitted, false);
    assert.equal(body.readiness.approvalGrantPermitted, false);
    assert.equal(body.readiness.startExecutorDispatchPermitted, false);
    assert.equal(body.readiness.executorInvocationPermitted, false);
    assert.equal(body.readiness.processSpawnPermitted, false);
    assert.equal(body.readiness.sidecarStartPermitted, false);
    assert.equal(body.readiness.defaultOnPermitted, false);
    assert.equal(body.readiness.providerSendPermitted, false);
    assert.equal(body.readiness.terminalAckPermitted, false);
    assert.equal(body.readiness.executionPermitted, false);
    assert.equal(body.integrationContract.sendsApprovalRequest, false);
    assert.equal(body.integrationContract.invokesExecutor, false);
    assert.equal(body.integrationContract.startsSidecar, false);
    assert.equal(body.semantics.dryRunStartCanaryPlanOnly, true);
  } finally {
    await server.close();
  }
});

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
            kind: "seoseo.terminal-brief-sidecar-bounded-dry-run-observation",
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
        observationKind: "seoseo.terminal-brief-sidecar-bounded-dry-run-observation",
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
