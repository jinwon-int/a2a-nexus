// Terminal-brief sidecar gate route table, extracted from server.ts. Each
// POST /terminal-brief/sidecar/<name> endpoint role-gates the requester, reads the
// JSON body, projects it into a report via these pure extract*/build* helpers, and
// the server returns it no-store. Collected here so the ~37 routes and their ~120
// projection imports live outside the request handler; server.ts keeps just the
// dispatcher that looks a suffix up in TERMINAL_BRIEF_SIDECAR_ROUTES.
import { BrokerError } from "./core/broker-error.js";
import {
  buildTerminalBriefSidecarDryRunGate,
  extractTerminalBriefSidecarDryRunGateFinalizerStatus,
  extractTerminalBriefSidecarDryRunGateRehearsal,
  extractTerminalBriefSidecarDryRunOperatingEvidence,
} from "./core/terminal-brief-sidecar-dry-run-gate.js";
import {
  buildTerminalBriefSidecarActivationApproval,
  extractTerminalBriefSidecarActivationApprovalGate,
  extractTerminalBriefSidecarActivationApprovalOptions,
} from "./core/terminal-brief-sidecar-activation-approval.js";
import {
  buildTerminalBriefSidecarActivationReceiptIngestor,
  extractTerminalBriefSidecarActivationApprovalPacket,
  extractTerminalBriefSidecarActivationReceiptEvidence,
} from "./core/terminal-brief-sidecar-activation-receipt-ingestor.js";
import {
  buildTerminalBriefSidecarStartExecutorGate,
  extractTerminalBriefSidecarStartExecutorGateOptions,
  extractTerminalBriefSidecarStartExecutorGateReceipt,
} from "./core/terminal-brief-sidecar-start-executor-gate.js";
import {
  buildTerminalBriefSidecarExecutorInvocationRehearsal,
  extractTerminalBriefSidecarExecutorInvocationRehearsalGate,
  extractTerminalBriefSidecarExecutorInvocationRehearsalOptions,
} from "./core/terminal-brief-sidecar-executor-invocation-rehearsal.js";
import {
  buildTerminalBriefSidecarRuntimePreflightApproval,
  extractTerminalBriefSidecarRuntimePreflightApprovalOptions,
  extractTerminalBriefSidecarRuntimePreflightApprovalRehearsal,
} from "./core/terminal-brief-sidecar-runtime-preflight-approval.js";
import {
  buildTerminalBriefSidecarAdapterHandoffApproval,
  extractTerminalBriefSidecarAdapterHandoffApprovalOptions,
  extractTerminalBriefSidecarAdapterHandoffApprovalPacket,
} from "./core/terminal-brief-sidecar-adapter-handoff-approval.js";
import {
  buildTerminalBriefSidecarOperatorReviewTable,
  extractTerminalBriefSidecarOperatorReviewTableHandoff,
  extractTerminalBriefSidecarOperatorReviewTableOptions,
} from "./core/terminal-brief-sidecar-operator-review-table.js";
import {
  buildTerminalBriefSidecarReviewDecisionIngestor,
  extractTerminalBriefSidecarReviewDecisionEvidence,
  extractTerminalBriefSidecarReviewDecisionIngestorOptions,
  extractTerminalBriefSidecarReviewDecisionIngestorTable,
} from "./core/terminal-brief-sidecar-review-decision-ingestor.js";
import {
  buildTerminalBriefSidecarApprovalGrantProposal,
  extractTerminalBriefSidecarApprovalGrantProposalOptions,
  extractTerminalBriefSidecarApprovalGrantProposalReviewDecision,
} from "./core/terminal-brief-sidecar-approval-grant-proposal.js";
import {
  buildTerminalBriefSidecarApprovalGrantEvidenceIngestor,
  extractTerminalBriefSidecarApprovalGrantEvidence,
  extractTerminalBriefSidecarApprovalGrantEvidenceIngestorOptions,
  extractTerminalBriefSidecarApprovalGrantEvidenceIngestorProposal,
} from "./core/terminal-brief-sidecar-approval-grant-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarExecutionGateFinalReview,
  extractTerminalBriefSidecarExecutionGateFinalReviewGrantEvidence,
  extractTerminalBriefSidecarExecutionGateFinalReviewOptions,
} from "./core/terminal-brief-sidecar-execution-gate-final-review.js";
import {
  buildTerminalBriefSidecarExecutorDispatchRequestDraft,
  extractTerminalBriefSidecarExecutorDispatchRequestDraftFinalReview,
  extractTerminalBriefSidecarExecutorDispatchRequestDraftOptions,
} from "./core/terminal-brief-sidecar-executor-dispatch-request-draft.js";
import {
  buildTerminalBriefSidecarDispatcherPreflightSeal,
  extractTerminalBriefSidecarDispatcherPreflightSealDraft,
  extractTerminalBriefSidecarDispatcherPreflightSealOptions,
  extractTerminalBriefSidecarDispatcherRuntimeEvidence,
} from "./core/terminal-brief-sidecar-dispatcher-preflight-seal.js";
import {
  buildTerminalBriefSidecarDispatcherApprovalHandoff,
  extractTerminalBriefSidecarDispatcherApprovalHandoffOptions,
  extractTerminalBriefSidecarDispatcherApprovalHandoffSeal,
} from "./core/terminal-brief-sidecar-dispatcher-approval-handoff.js";
import {
  buildTerminalBriefSidecarDefaultOnCandidateFinalGate,
  extractTerminalBriefSidecarDefaultOnCandidateFinalGateObservation,
  extractTerminalBriefSidecarDefaultOnCandidateFinalGateOptions,
} from "./core/terminal-brief-sidecar-default-on-candidate-final-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnApprovalRequest,
  extractTerminalBriefSidecarDefaultOnApprovalRequestFinalGate,
  extractTerminalBriefSidecarDefaultOnApprovalRequestOptions,
} from "./core/terminal-brief-sidecar-default-on-approval-request.js";
import {
  buildTerminalBriefSidecarDefaultOnApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnApprovalRequestPacket,
} from "./core/terminal-brief-sidecar-default-on-approval-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnEnablementGate,
  extractTerminalBriefSidecarDefaultOnEnablementGateApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnEnablementGateOptions,
} from "./core/terminal-brief-sidecar-default-on-enablement-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeMutationPlan,
  extractTerminalBriefSidecarDefaultOnRuntimeMutationPlanEnablementGate,
  extractTerminalBriefSidecarDefaultOnRuntimeMutationPlanOptions,
} from "./core/terminal-brief-sidecar-default-on-runtime-mutation-plan.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionRollbackEnvelope,
  extractTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeOptions,
  extractTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePlan,
} from "./core/terminal-brief-sidecar-default-on-execution-rollback-envelope.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionApprovalRequest,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestEnvelope,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestOptions,
} from "./core/terminal-brief-sidecar-default-on-execution-approval-request.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket,
} from "./core/terminal-brief-sidecar-default-on-execution-approval-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateEvidence,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateOptions,
} from "./core/terminal-brief-sidecar-default-on-runtime-execution-final-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftFinalGate,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions,
} from "./core/terminal-brief-sidecar-default-on-runtime-execution-request-draft.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket,
} from "./core/terminal-brief-sidecar-default-on-runtime-execution-approval-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnRuntimeExecutorGate,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateEvidence,
  extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateOptions,
} from "./core/terminal-brief-sidecar-default-on-runtime-executor-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnFinalLiveExecution,
  extractTerminalBriefSidecarDefaultOnFinalLiveExecutionGate,
  extractTerminalBriefSidecarDefaultOnFinalLiveExecutionOptions,
} from "./core/terminal-brief-sidecar-default-on-final-live-execution.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionWindowRequestDraft,
  extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftFinalLiveExecution,
  extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftOptions,
} from "./core/terminal-brief-sidecar-default-on-execution-window-request-draft.js";
import {
  buildTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceRequestDraft,
} from "./core/terminal-brief-sidecar-default-on-execution-window-approval-evidence-ingestor.js";
import {
  buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate,
  extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateEvidence,
  extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions,
} from "./core/terminal-brief-sidecar-default-on-final-runtime-mutation-executor-gate.js";
import {
  buildTerminalBriefSidecarDefaultOnLiveExecutor,
  extractTerminalBriefSidecarDefaultOnLiveExecutorGate,
  extractTerminalBriefSidecarDefaultOnLiveExecutorOptions,
} from "./core/terminal-brief-sidecar-default-on-live-executor.js";
import {
  buildTerminalBriefSidecarDryRunStartCanaryPlan,
  extractTerminalBriefSidecarDryRunStartCanaryPlanOptions,
  extractTerminalBriefSidecarDryRunStartCanaryPlanRehearsal,
} from "./core/terminal-brief-sidecar-dry-run-start-canary-plan.js";
import {
  buildTerminalBriefSidecarPreflightEvidenceCollector,
  extractTerminalBriefSidecarPreflightEvidence,
  extractTerminalBriefSidecarPreflightEvidenceCollectorCanaryPlan,
  extractTerminalBriefSidecarPreflightEvidenceCollectorOptions,
} from "./core/terminal-brief-sidecar-preflight-evidence-collector.js";
import {
  buildTerminalBriefSidecarPreflightChainReview,
  extractTerminalBriefSidecarPreflightChainReviewCollector,
  extractTerminalBriefSidecarPreflightChainReviewOptions,
} from "./core/terminal-brief-sidecar-preflight-chain-review.js";
import {
  buildTerminalBriefSidecarDryRunStartApprovalRequest,
  extractTerminalBriefSidecarDryRunStartApprovalRequestChainReview,
  extractTerminalBriefSidecarDryRunStartApprovalRequestOptions,
} from "./core/terminal-brief-sidecar-dry-run-start-approval-request.js";
import {
  buildTerminalBriefSidecarDryRunStartApprovalReceiptIngestor,
  extractTerminalBriefSidecarDryRunStartApprovalReceiptEvidence,
  extractTerminalBriefSidecarDryRunStartApprovalReceiptIngestorOptions,
  extractTerminalBriefSidecarDryRunStartApprovalRequestPacket,
} from "./core/terminal-brief-sidecar-dry-run-start-approval-receipt-ingestor.js";

export interface TerminalBriefSidecarRoute {
  scope: string;
  project: (body: Record<string, unknown> | null) => unknown;
}

// Terminal-brief sidecar gate endpoints. Every POST /terminal-brief/sidecar/<name>
// follows the same shape: role-gate the requester, read the JSON body, project it
// into a report, and return it no-store. Only the input extraction and report
// builder differ per route, so the 37 near-identical handlers collapse into this
// table plus the single dispatcher in the request handler.
export const TERMINAL_BRIEF_SIDECAR_ROUTES = new Map<string, TerminalBriefSidecarRoute>([
  ["dry-run-gate", {
    scope: "terminal_brief.sidecar_dry_run_gate.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let sidecarRehearsal;
      try {
        sidecarRehearsal = extractTerminalBriefSidecarDryRunGateRehearsal(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar dry-run gate input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDryRunGate(
        sidecarRehearsal,
        extractTerminalBriefSidecarDryRunGateFinalizerStatus(body),
        extractTerminalBriefSidecarDryRunOperatingEvidence(body),
      );
      return report;
    },
  }],
  ["activation-approval", {
    scope: "terminal_brief.sidecar_activation_approval.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let dryRunGate;
      try {
        dryRunGate = extractTerminalBriefSidecarActivationApprovalGate(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar activation approval input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarActivationApproval(
        dryRunGate,
        extractTerminalBriefSidecarActivationApprovalOptions(body),
      );
      return report;
    },
  }],
  ["activation-receipt", {
    scope: "terminal_brief.sidecar_activation_receipt.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let activationApproval;
      try {
        activationApproval = extractTerminalBriefSidecarActivationApprovalPacket(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar activation receipt input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarActivationReceiptIngestor(
        activationApproval,
        extractTerminalBriefSidecarActivationReceiptEvidence(body),
      );
      return report;
    },
  }],
  ["start-executor-gate", {
    scope: "terminal_brief.sidecar_start_executor_gate.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let activationReceipt;
      try {
        activationReceipt = extractTerminalBriefSidecarStartExecutorGateReceipt(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar start executor gate input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarStartExecutorGate(
        activationReceipt,
        extractTerminalBriefSidecarStartExecutorGateOptions(body),
      );
      return report;
    },
  }],
  ["executor-invocation-rehearsal", {
    scope: "terminal_brief.sidecar_executor_invocation_rehearsal.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let startExecutorGate;
      try {
        startExecutorGate = extractTerminalBriefSidecarExecutorInvocationRehearsalGate(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar executor invocation rehearsal input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarExecutorInvocationRehearsal(
        startExecutorGate,
        extractTerminalBriefSidecarExecutorInvocationRehearsalOptions(body),
      );
      return report;
    },
  }],
  ["runtime-preflight-approval", {
    scope: "terminal_brief.sidecar_runtime_preflight_approval.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let executorInvocationRehearsal;
      try {
        executorInvocationRehearsal = extractTerminalBriefSidecarRuntimePreflightApprovalRehearsal(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar runtime preflight approval input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarRuntimePreflightApproval(
        executorInvocationRehearsal,
        extractTerminalBriefSidecarRuntimePreflightApprovalOptions(body),
      );
      return report;
    },
  }],
  ["adapter-handoff-approval", {
    scope: "terminal_brief.sidecar_adapter_handoff_approval.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let runtimePreflightApproval;
      try {
        runtimePreflightApproval = extractTerminalBriefSidecarAdapterHandoffApprovalPacket(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar adapter handoff approval input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarAdapterHandoffApproval(
        runtimePreflightApproval,
        extractTerminalBriefSidecarAdapterHandoffApprovalOptions(body),
      );
      return report;
    },
  }],
  ["operator-review-table", {
    scope: "terminal_brief.sidecar_operator_review_table.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let adapterHandoff;
      try {
        adapterHandoff = extractTerminalBriefSidecarOperatorReviewTableHandoff(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar operator review table input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarOperatorReviewTable(
        adapterHandoff,
        extractTerminalBriefSidecarOperatorReviewTableOptions(body),
      );
      return report;
    },
  }],
  ["review-decision", {
    scope: "terminal_brief.sidecar_review_decision.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let reviewTable;
      try {
        reviewTable = extractTerminalBriefSidecarReviewDecisionIngestorTable(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar review decision input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarReviewDecisionIngestor(
        reviewTable,
        extractTerminalBriefSidecarReviewDecisionEvidence(body),
        extractTerminalBriefSidecarReviewDecisionIngestorOptions(body),
      );
      return report;
    },
  }],
  ["approval-grant-proposal", {
    scope: "terminal_brief.sidecar_approval_grant_proposal.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let reviewDecision;
      try {
        reviewDecision = extractTerminalBriefSidecarApprovalGrantProposalReviewDecision(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar approval grant proposal input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarApprovalGrantProposal(
        reviewDecision,
        extractTerminalBriefSidecarApprovalGrantProposalOptions(body),
      );
      return report;
    },
  }],
  ["approval-grant-evidence", {
    scope: "terminal_brief.sidecar_approval_grant_evidence.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let proposal;
      try {
        proposal = extractTerminalBriefSidecarApprovalGrantEvidenceIngestorProposal(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar approval grant evidence input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarApprovalGrantEvidenceIngestor(
        proposal,
        extractTerminalBriefSidecarApprovalGrantEvidence(body),
        extractTerminalBriefSidecarApprovalGrantEvidenceIngestorOptions(body),
      );
      return report;
    },
  }],
  ["execution-gate-final-review", {
    scope: "terminal_brief.sidecar_execution_gate_final_review.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let grantEvidence;
      try {
        grantEvidence = extractTerminalBriefSidecarExecutionGateFinalReviewGrantEvidence(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar execution gate final review input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarExecutionGateFinalReview(
        grantEvidence,
        extractTerminalBriefSidecarExecutionGateFinalReviewOptions(body),
      );
      return report;
    },
  }],
  ["executor-dispatch-request-draft", {
    scope: "terminal_brief.sidecar_executor_dispatch_request_draft.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let finalReview;
      try {
        finalReview = extractTerminalBriefSidecarExecutorDispatchRequestDraftFinalReview(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar executor dispatch request draft input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarExecutorDispatchRequestDraft(
        finalReview,
        extractTerminalBriefSidecarExecutorDispatchRequestDraftOptions(body),
      );
      return report;
    },
  }],
  ["dispatcher-preflight-seal", {
    scope: "terminal_brief.sidecar_dispatcher_preflight_seal.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let dispatchDraft;
      try {
        dispatchDraft = extractTerminalBriefSidecarDispatcherPreflightSealDraft(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar dispatcher preflight seal input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDispatcherPreflightSeal(
        dispatchDraft,
        extractTerminalBriefSidecarDispatcherRuntimeEvidence(body),
        extractTerminalBriefSidecarDispatcherPreflightSealOptions(body),
      );
      return report;
    },
  }],
  ["dispatcher-approval-handoff", {
    scope: "terminal_brief.sidecar_dispatcher_approval_handoff.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let preflightSeal;
      try {
        preflightSeal = extractTerminalBriefSidecarDispatcherApprovalHandoffSeal(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar dispatcher approval handoff input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDispatcherApprovalHandoff(
        preflightSeal,
        extractTerminalBriefSidecarDispatcherApprovalHandoffOptions(body),
      );
      return report;
    },
  }],
  ["dry-run-start-canary-plan", {
    scope: "terminal_brief.sidecar_dry_run_start_canary_plan.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let executorInvocationRehearsal;
      try {
        executorInvocationRehearsal = extractTerminalBriefSidecarDryRunStartCanaryPlanRehearsal(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar dry-run start canary plan input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDryRunStartCanaryPlan(
        executorInvocationRehearsal,
        extractTerminalBriefSidecarDryRunStartCanaryPlanOptions(body),
      );
      return report;
    },
  }],
  ["default-on-candidate-final-gate", {
    scope: "terminal_brief.sidecar_default_on_candidate_final_gate.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let observation;
      try {
        observation = extractTerminalBriefSidecarDefaultOnCandidateFinalGateObservation(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on candidate final gate input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnCandidateFinalGate(
        observation,
        extractTerminalBriefSidecarDefaultOnCandidateFinalGateOptions(body),
      );
      return report;
    },
  }],
  ["default-on-approval-request", {
    scope: "terminal_brief.sidecar_default_on_approval_request.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let finalGate;
      try {
        finalGate = extractTerminalBriefSidecarDefaultOnApprovalRequestFinalGate(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on approval request input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnApprovalRequest(
        finalGate,
        extractTerminalBriefSidecarDefaultOnApprovalRequestOptions(body),
      );
      return report;
    },
  }],
  ["default-on-approval-evidence", {
    scope: "terminal_brief.sidecar_default_on_approval_evidence.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let approvalRequest;
      try {
        approvalRequest = extractTerminalBriefSidecarDefaultOnApprovalRequestPacket(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on approval evidence input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnApprovalEvidenceIngestor(
        approvalRequest,
        extractTerminalBriefSidecarDefaultOnApprovalEvidence(body),
        extractTerminalBriefSidecarDefaultOnApprovalEvidenceIngestorOptions(body),
      );
      return report;
    },
  }],
  ["default-on-enablement-gate", {
    scope: "terminal_brief.sidecar_default_on_enablement_gate.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let approvalEvidence;
      try {
        approvalEvidence = extractTerminalBriefSidecarDefaultOnEnablementGateApprovalEvidence(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on enablement gate input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnEnablementGate(
        approvalEvidence,
        extractTerminalBriefSidecarDefaultOnEnablementGateOptions(body),
      );
      return report;
    },
  }],
  ["default-on-runtime-mutation-plan", {
    scope: "terminal_brief.sidecar_default_on_runtime_mutation_plan.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let enablementGate;
      try {
        enablementGate = extractTerminalBriefSidecarDefaultOnRuntimeMutationPlanEnablementGate(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on runtime mutation plan input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnRuntimeMutationPlan(
        enablementGate,
        extractTerminalBriefSidecarDefaultOnRuntimeMutationPlanOptions(body),
      );
      return report;
    },
  }],
  ["default-on-execution-rollback-envelope", {
    scope: "terminal_brief.sidecar_default_on_execution_rollback_envelope.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let plan;
      try {
        plan = extractTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopePlan(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on execution rollback envelope input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnExecutionRollbackEnvelope(
        plan,
        extractTerminalBriefSidecarDefaultOnExecutionRollbackEnvelopeOptions(body),
      );
      return report;
    },
  }],
  ["default-on-execution-approval-request", {
    scope: "terminal_brief.sidecar_default_on_execution_approval_request.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let envelope;
      try {
        envelope = extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestEnvelope(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on execution approval request input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnExecutionApprovalRequest(
        envelope,
        extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestOptions(body),
      );
      return report;
    },
  }],
  ["default-on-execution-approval-evidence", {
    scope: "terminal_brief.sidecar_default_on_execution_approval_evidence.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let approvalRequest;
      try {
        approvalRequest = extractTerminalBriefSidecarDefaultOnExecutionApprovalRequestPacket(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on execution approval evidence input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestor(
        approvalRequest,
        extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidence(body),
        extractTerminalBriefSidecarDefaultOnExecutionApprovalEvidenceIngestorOptions(body),
      );
      return report;
    },
  }],
  ["default-on-runtime-execution-final-gate", {
    scope: "terminal_brief.sidecar_default_on_runtime_execution_final_gate.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let evidence;
      try {
        evidence = extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateEvidence(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on runtime execution final gate input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGate(
        evidence,
        extractTerminalBriefSidecarDefaultOnRuntimeExecutionFinalGateOptions(body),
      );
      return report;
    },
  }],
  ["default-on-runtime-execution-request-draft", {
    scope: "terminal_brief.sidecar_default_on_runtime_execution_request_draft.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let finalGate;
      try {
        finalGate = extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftFinalGate(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on runtime execution request draft input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraft(
        finalGate,
        extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftOptions(body),
      );
      return report;
    },
  }],
  ["default-on-runtime-execution-approval-evidence", {
    scope: "terminal_brief.sidecar_default_on_runtime_execution_approval_evidence.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let requestDraft;
      try {
        requestDraft = extractTerminalBriefSidecarDefaultOnRuntimeExecutionRequestDraftPacket(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on runtime execution approval evidence input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestor(
        requestDraft,
        extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidence(body),
        extractTerminalBriefSidecarDefaultOnRuntimeExecutionApprovalEvidenceIngestorOptions(body),
      );
      return report;
    },
  }],
  ["default-on-runtime-executor-gate", {
    scope: "terminal_brief.sidecar_default_on_runtime_executor_gate.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let evidence;
      try {
        evidence = extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateEvidence(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on runtime executor gate input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnRuntimeExecutorGate(
        evidence,
        extractTerminalBriefSidecarDefaultOnRuntimeExecutorGateOptions(body),
      );
      return report;
    },
  }],
  ["default-on-final-live-execution", {
    scope: "terminal_brief.sidecar_default_on_final_live_execution.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let gate;
      try {
        gate = extractTerminalBriefSidecarDefaultOnFinalLiveExecutionGate(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on final live execution input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnFinalLiveExecution(
        gate,
        extractTerminalBriefSidecarDefaultOnFinalLiveExecutionOptions(body),
      );
      return report;
    },
  }],
  ["default-on-execution-window-request-draft", {
    scope: "terminal_brief.sidecar_default_on_execution_window_request_draft.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let finalLiveExecution;
      try {
        finalLiveExecution = extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftFinalLiveExecution(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on execution window request draft input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnExecutionWindowRequestDraft(
        finalLiveExecution,
        extractTerminalBriefSidecarDefaultOnExecutionWindowRequestDraftOptions(body),
      );
      return report;
    },
  }],
  ["default-on-execution-window-approval-evidence", {
    scope: "terminal_brief.sidecar_default_on_execution_window_approval_evidence.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let requestDraft;
      try {
        requestDraft = extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceRequestDraft(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on execution window approval evidence input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestor(
        requestDraft,
        extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidence(body),
        extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions(body),
      );
      return report;
    },
  }],
  ["default-on-final-runtime-mutation-executor-gate", {
    scope: "terminal_brief.sidecar_default_on_final_runtime_mutation_executor_gate.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let evidence;
      try {
        evidence = extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateEvidence(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on final runtime mutation executor gate input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate(
        evidence,
        extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions(body),
      );
      return report;
    },
  }],
  ["default-on-live-executor", {
    scope: "terminal_brief.sidecar_default_on_live_executor.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let gate;
      try {
        gate = extractTerminalBriefSidecarDefaultOnLiveExecutorGate(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar default-on live executor input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDefaultOnLiveExecutor(
        gate,
        extractTerminalBriefSidecarDefaultOnLiveExecutorOptions(body),
      );
      return report;
    },
  }],
  ["preflight-evidence-collector", {
    scope: "terminal_brief.sidecar_preflight_evidence_collector.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let dryRunStartCanaryPlan;
      try {
        dryRunStartCanaryPlan = extractTerminalBriefSidecarPreflightEvidenceCollectorCanaryPlan(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar preflight evidence collector input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarPreflightEvidenceCollector(
        dryRunStartCanaryPlan,
        extractTerminalBriefSidecarPreflightEvidence(body),
        extractTerminalBriefSidecarPreflightEvidenceCollectorOptions(body),
      );
      return report;
    },
  }],
  ["preflight-chain-review", {
    scope: "terminal_brief.sidecar_preflight_chain_review.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let preflightCollector;
      try {
        preflightCollector = extractTerminalBriefSidecarPreflightChainReviewCollector(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar preflight chain review input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarPreflightChainReview(
        preflightCollector,
        extractTerminalBriefSidecarPreflightChainReviewOptions(body),
      );
      return report;
    },
  }],
  ["dry-run-start-approval-request", {
    scope: "terminal_brief.sidecar_dry_run_start_approval_request.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let chainReview;
      try {
        chainReview = extractTerminalBriefSidecarDryRunStartApprovalRequestChainReview(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar dry-run start approval request input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDryRunStartApprovalRequest(
        chainReview,
        extractTerminalBriefSidecarDryRunStartApprovalRequestOptions(body),
      );
      return report;
    },
  }],
  ["dry-run-start-approval-receipt", {
    scope: "terminal_brief.sidecar_dry_run_start_approval_receipt.read",
    project: (body: Record<string, unknown> | null): unknown => {
      let approvalRequest;
      try {
        approvalRequest = extractTerminalBriefSidecarDryRunStartApprovalRequestPacket(body);
      } catch (error) {
        const message = error instanceof Error ? error.message : "invalid sidecar dry-run start approval receipt input";
        throw new BrokerError("bad_request", message);
      }
      const report = buildTerminalBriefSidecarDryRunStartApprovalReceiptIngestor(
        approvalRequest,
        extractTerminalBriefSidecarDryRunStartApprovalReceiptEvidence(body),
        extractTerminalBriefSidecarDryRunStartApprovalReceiptIngestorOptions(body),
      );
      return report;
    },
  }],
]);
