import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  buildTerminalBriefSidecarDefaultOnExecutionWindowRequestDraft,
  extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftFinalLiveExecution,
  extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftOptions,
  type TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftPacket,
} from "./terminal-brief-sidecar-default-on-execution-window-request-draft.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceRequestDraft,
  renderTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceMarkdown,
} from "./terminal-brief-sidecar-default-on-execution-window-approval-evidence-ingestor.js";

const NOW = "2026-05-19T10:40:00.000Z";

function requestDraft(): TerminalBriefSidecarDefaultOnExecutionWindowRequestDraftPacket {
  const input = JSON.parse(readFileSync(
    join(process.cwd(), "fixtures/terminal-brief/sidecar-default-on-execution-window-request-draft.no-live.json"),
    "utf8",
  )) as Record<string, unknown>;
  return buildTerminalBriefSidecarDefaultOnExecutionWindowRequestDraft(
    extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftFinalLiveExecution(input),
    extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftOptions(input),
  );
}

test("execution window approval evidence accepts visible receipt plus matching approval reply", () => {
  const request = requestDraft();
  const packet = buildTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestor(
    request,
    [
      {
        kind: "current_session_visible",
        evidenceId: "telegram-current-session-visible:fixture-796",
        executionWindowReference: request.executionWindowRequestDraft.executionWindowReference,
      },
      {
        kind: "approval_grant",
        evidenceId: "operator-reply:fresh-window-approval",
        approvalReference: request.executionWindowRequestDraft.executionWindowReference,
        requestedAction: request.executionWindowRequestDraft.requestedAction,
        operatorTarget: request.executionWindowRequestDraft.operatorTarget,
        replyText: "fresh operator execution window 승인",
      },
    ],
    { now: NOW },
  );

  assert.equal(packet.kind, "a2a-broker.terminal-brief-sidecar-default-on-execution-window-approval-evidence-ingestor.packet");
  assert.equal(packet.state, "accepted");
  assert.equal(packet.sourceOnlyNoLive, true);
  assert.equal(packet.receiptEvidenceAccepted, true);
  assert.equal(packet.approvalEvidenceAccepted, true);
  assert.equal(packet.classification.providerAcceptedIsVisibilityProof, false);
  assert.equal(packet.classification.approvalGrantEvidenceExecutesGrant, false);
  assert.deepEqual(packet.classification.acceptedReceiptKinds, ["current_session_visible"]);
  assert.equal(packet.readiness.executionWindowApprovalEvidenceAccepted, true);
  assert.equal(packet.readiness.executionWindowRequestDispatchPermitted, false);
  assert.equal(packet.readiness.approvalGrantPermitted, false);
  assert.equal(packet.readiness.approvalGrantExecutionPermitted, false);
  assert.equal(packet.readiness.checkpointCreationPermitted, false);
  assert.equal(packet.readiness.rollbackExecutionPermitted, false);
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.defaultOnPermitted, false);
  assert.equal(packet.readiness.sidecarRestartPermitted, false);
  assert.equal(packet.readiness.providerSendPermitted, false);
  assert.equal(packet.readiness.terminalAckPermitted, false);
  assert.equal(packet.readiness.dbMutationPermitted, false);
  assert.equal(packet.readiness.taskFlowMutationPermitted, false);
  assert.equal(packet.readiness.startExecutorDispatchPermitted, false);
  assert.equal(packet.readiness.executorInvocationPermitted, false);
  assert.equal(packet.readiness.executionPermitted, false);
  assert.equal(packet.readiness.processSpawnPermitted, false);
  assert.equal(packet.integrationContract.grantsApproval, false);
  assert.equal(packet.integrationContract.createsCheckpoint, false);
  assert.equal(packet.integrationContract.writesConfig, false);
  assert.equal(packet.integrationContract.enablesDefaultOn, false);
  assert.equal(packet.integrationContract.executesAction, false);
  assert.equal(packet.semantics.approvalEvidenceDoesNotGrantApproval, true);
  assert.equal(packet.semantics.approvalEvidenceDoesNotWriteConfig, true);
  assert.equal(packet.semantics.approvalEvidenceDoesNotEnableDefaultOn, true);
});

test("execution window approval evidence rejects provider accepted as visibility proof", () => {
  const request = requestDraft();
  const packet = buildTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestor(
    request,
    [
      { kind: "provider_accepted", evidenceId: "telegram-provider-accepted:fixture-796" },
      {
        kind: "approval_grant",
        evidenceId: "operator-reply:fresh-window-approval",
        approvalReference: request.executionWindowRequestDraft.executionWindowReference,
        replyText: "fresh operator execution window 승인",
      },
    ],
    { now: NOW },
  );

  assert.equal(packet.state, "insufficient");
  assert.equal(packet.receiptEvidenceAccepted, false);
  assert.equal(packet.approvalEvidenceAccepted, false);
  assert.equal(packet.classification.providerAcceptedIsVisibilityProof, false);
  assert.equal(packet.readiness.missingEvidence.includes("operator_visible_receipt_evidence"), true);
  assert.equal(packet.readiness.defaultOnPermitted, false);
});

test("execution window approval evidence blocks unsafe request draft drift", () => {
  const unsafe = requestDraft();
  unsafe.readiness.configWritePermitted = true as never;
  unsafe.integrationContract.createsCheckpoint = true as never;
  const packet = buildTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestor(
    unsafe,
    [
      { kind: "manual_operator_confirmation", evidenceId: "manual-visible" },
      { kind: "approval_grant", evidenceId: "grant", replyText: "fresh operator execution window 승인" },
    ],
    { now: NOW },
  );

  assert.equal(packet.state, "blocked");
  assert.equal(packet.blockers.some((blocker) => blocker.includes("config write")), true);
  assert.equal(packet.blockers.some((blocker) => blocker.includes("creates checkpoint")), true);
  assert.equal(packet.readiness.configWritePermitted, false);
  assert.equal(packet.readiness.checkpointCreationPermitted, false);
});

test("execution window approval evidence extractors and markdown preserve no-live boundary", () => {
  const input = {
    executionWindowRequestDraftPacket: requestDraft(),
    executionWindowApprovalEvidence: {
      records: [
        { kind: "manual_operator_confirmation", evidenceId: "manual-visible" },
        { kind: "approval_grant", evidenceId: "grant", replyText: "fresh operator execution window 승인" },
      ],
    },
    executionWindowApprovalEvidenceIngestor: { now: NOW },
  };

  assert.equal(extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceRequestDraft(input).state, "execution_window_request_draft_ready");
  assert.equal(extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidence(input).length, 2);
  assert.deepEqual(extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions(input), { now: NOW });

  const packet = buildTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestor(
    extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceRequestDraft(input),
    extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidence(input),
    extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions(input),
  );
  const markdown = renderTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceMarkdown(packet);

  assert.match(markdown, /Accepted: Terminal Brief default-on execution window approval evidence/);
  assert.match(markdown, /providerAcceptedIsVisibilityProof=false/);
  assert.match(markdown, /checkpointCreationPermitted=false/);
  assert.match(markdown, /does not send requests, grant or execute approval/);
});
