import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { A2A_BROKER_ADAPTER_PLUGIN_ID } from "./plugin-id.js";
import { createA2AGatewayHandlers } from "./src/gateway-handlers.js";
import { createA2AMonitoringHandlers } from "./src/gateway-monitoring-handlers.js";
import { createA2ASessionsSendHook } from "./src/sessions-send-hook.js";

export {
  buildTeamAssignmentRequests,
  normalizeTeamAssignment,
  validateTeamAssignmentInput,
  TeamAssignmentErrorCodes,
  TeamAssignmentModes,
} from "./src/team-assignment-normalizer.js";
export type {
  TeamAssignmentMode,
  TeamAssignmentInput,
  TeamAssignmentResult,
  TeamAssignmentRequester,
  TeamAssignmentConstraints,
  TeamAssignmentValidation,
  TeamAssignmentValidationError,
  TeamAssignmentErrorCode,
  TeamAssignmentBuildResult,
} from "./src/team-assignment-normalizer.js";

export { rehearseSourcePublicApproval } from "./src/source-public-approval-rehearsal.js";
export type {
  SourcePublicDecision,
  SourcePublicGateName,
  SourcePublicGateResult,
  SourcePublicApprovalPacket,
  SourcePublicEvidenceBundle,
  SourcePublicTerminalBrief,
  SourcePublicApprovalRehearsalReport,
  SourcePublicApprovalRehearsalInput,
  SourcePublicApprovalRehearsalOptions,
} from "./src/source-public-approval-rehearsal.js";

export {
  buildSourcePublicExecutionPlan,
  simulateSourcePublicExecution,
  validateExecutionPlan,
  projectExecutionStatus,
} from "./src/source-public-execution-orchestrator.js";
export type {
  ExecutionStepKind,
  ExecutionPlanStep,
  ExecutionPreflightResult,
  ExecutionPreflightCheck,
  ScannerHistoryBinding,
  RollbackAbortRunbook,
  IdempotencyGuard,
  ExecutionMode,
  SourcePublicExecutionPlan,
  ExecutionSafetyInvariants,
  ExecutionProjectedOutcome,
  ExecutionPlanInput,
  ExecutionPlanOptions,
  ExecutionStatusLevel,
  ExecutionStatusProjection,
} from "./src/source-public-execution-orchestrator.js";

export { projectPluginGoNoGo } from "./src/plugin-go-no-go-projection.js";
export type {
  PluginGoNoGo,
  PluginGoNoGoReasonCategory,
  RequiredOperatorAction,
  PluginGoNoGoProjection,
  PluginHealthSummary,
  SafetyConfirmation,
  PluginGoNoGoProjectionInput,
  PluginGoNoGoProjectionOptions,
} from "./src/plugin-go-no-go-projection.js";

export {
  projectCleanupDryRunPlan,
  resolveCleanupReceiptGate,
  isCleanupReceiptTerminal,
  projectCleanupGateStatus,
  projectCleanupAuditEntry,
  buildCleanupRollbackSummary,
} from "./src/cleanup-dry-run-projection.js";
export type {
  CleanupRiskClass,
  CleanupCandidateProjection,
  CleanupCandidateDiscoveryProjection,
  CleanupReceiptStatus,
  CleanupReceiptGateVerdict,
  CleanupPlanStep,
  CleanupDryRunPlanProjection,
  CleanupGateStatusProjection,
  CleanupAuditEntry,
  CleanupDryRunProjectionInput,
  CleanupDryRunProjectionOptions,
} from "./src/cleanup-dry-run-projection.js";

// ── Cleanup-candidate summary contract (#401) ─────────────────────

export { buildCleanupCandidateSummary, A2A_CLEANUP_CANDIDATE_SUMMARY_SCHEMA } from "./src/cleanup-candidate-summary-contract.js";
export type {
  TerminalOutboxBacklogStatus,
  CompactWarning,
  BoundedCount,
  StaleWorkerResidueCounts,
  SummaryContractValidation,
  CleanupCandidateSummaryContract,
  CleanupCandidateSummaryInput,
  CleanupActionType,
  ApprovalMode,
} from "./src/cleanup-candidate-summary-contract.js";

export {
  createA2ATerminalBriefSidecar,
  createCommandNotificationHandler,
  createFileTerminalBriefSidecarCursorStore,
  createMemoryTerminalBriefSidecarCursorStore,
  normalizeA2ATerminalBriefSidecarConfig,
} from "./src/terminal-brief-sidecar.js";
export type {
  A2ATerminalBriefSidecar,
  A2ATerminalBriefSidecarConfig,
  A2ATerminalBriefSidecarCursorSnapshot,
  A2ATerminalBriefSidecarCursorStore,
  A2ATerminalBriefSidecarDeliveryMode,
  A2ATerminalBriefSidecarDeps,
  A2ATerminalBriefSidecarStatus,
} from "./src/terminal-brief-sidecar.js";

export {
  normalizeTerminalBriefConfirmationSource,
  normalizeTerminalBriefDeliveryReceiptDecision,
} from "./src/terminal-brief-delivery-contract.js";
export type {
  A2ATerminalBriefDeliveryAdapterConfirmationSource,
  A2ATerminalBriefDeliveryAdapterEnvelope,
  A2ATerminalBriefDeliveryAdapterReceiptDecision,
} from "./src/terminal-brief-delivery-contract.js";

// ── Operator closeout-trigger metadata contract (#399) ─────────────

export {
  A2A_OPERATOR_CLOSEOUT_TRIGGER_SCHEMA,
  A2A_CLOSEOUT_TITLE_RULE,
  evaluateA2AOperatorCloseoutCandidate,
  extractA2AOperatorCloseoutTriggerMetadata,
} from "./src/operator-closeout-trigger.js";
export type {
  A2ACloseoutCandidateState,
  A2AOperatorCloseoutTriggerMetadata,
  A2AOperatorCloseoutTriggerContext,
  A2ACloseoutCandidateInput,
  A2ACloseoutObservation,
  A2ACloseoutCandidateEvaluation,
} from "./src/operator-closeout-trigger.js";

type SessionsSendHookApi = OpenClawPluginApi & {
  supportsTypedHook?: (hookName: string) => boolean;
  supportedTypedHooks?: Iterable<string>;
  on: (
    hookName: "sessions_send",
    handler: ReturnType<typeof createA2ASessionsSendHook>,
    opts?: { priority?: number },
  ) => void;
};

type GatewayLifecycleHookApi = OpenClawPluginApi & {
  logger?: {
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
  on?: (
    hookName: "gateway_start" | "gateway_stop",
    handler: () => void | Promise<void>,
    opts?: { priority?: number; timeoutMs?: number },
  ) => void;
};

function registerSessionsSendHook(
  api: OpenClawPluginApi,
  hook: ReturnType<typeof createA2ASessionsSendHook>,
): boolean {
  // `sessions_send` is a proposed OpenClaw integration seam used by this plugin.
  // Current OpenClaw releases reject unknown typed hooks with a Gateway warning,
  // so only register it when the host explicitly advertises support. The A2A
  // gateway methods and Terminal Brief bridge do not depend on this hook.
  const hookApi = api as SessionsSendHookApi;
  if (hookApi.supportsTypedHook?.("sessions_send") !== true) {
    const supported = hookApi.supportedTypedHooks;
    if (!supported || !Array.from(supported).includes("sessions_send")) {
      return false;
    }
  }
  hookApi.on("sessions_send", hook);
  return true;
}

type OperatorBridgeStartLog = {
  level: "info" | "warn";
  message: string;
};

function summarizeOperatorBridgeStart(state: unknown): OperatorBridgeStartLog {
  const root = isRecord(state) ? state : {};
  const bridge = isRecord(root.bridge) ? root.bridge : {};
  const operator = isRecord(root.operator) ? root.operator : {};
  const terminalOutbox = isRecord(operator.terminalOutbox) ? operator.terminalOutbox : {};
  const poller = isRecord(terminalOutbox.poller) ? terminalOutbox.poller : undefined;
  const lastFailure = isRecord(bridge.lastFailure) ? bridge.lastFailure : undefined;
  if (root.enabled === false) {
    return {
      level: "warn",
      message: `a2a terminal outbox poller skipped: ${readLogString(bridge.note) ?? "operator events disabled"}`,
    };
  }
  if (lastFailure) {
    return {
      level: "warn",
      message: `a2a terminal outbox poller unavailable: ${readLogString(lastFailure.message) ?? "broker client unavailable"}`,
    };
  }
  if (poller?.status === "skipped") {
    return {
      level: "warn",
      message: `a2a terminal outbox poller skipped: ${readLogString(poller.reason) ?? "unknown reason"}`,
    };
  }
  if (poller?.status === "started") {
    return {
      level: "info",
      message: `a2a terminal outbox poller started: ${readLogString(poller.reason) ?? "ready"}`,
    };
  }
  return {
    level: "info",
    message: "a2a operator event bridge started; terminal outbox poller state pending first status sample",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readLogString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export default definePluginEntry({
  id: A2A_BROKER_ADAPTER_PLUGIN_ID,
  name: "A2A Broker Adapter",
  description: "Standalone A2A broker gateway method registration and broker routing",
  reload: {
    // Gateway handlers and the operator-event bridge are created from the
    // plugin config captured at registration time. Treat plugin config edits as
    // restart-required so Terminal Brief cursor/allowlist changes cannot appear
    // hot-reloaded while a running poller still uses stale values.
    restartPrefixes: [`plugins.entries.${A2A_BROKER_ADAPTER_PLUGIN_ID}.config`],
  },
  register(api: OpenClawPluginApi) {
    const handlers = createA2AGatewayHandlers(api.config);
    const monitoringHandlers = createA2AMonitoringHandlers(api.config, { runtime: api.runtime });
    const sessionsSendHook = createA2ASessionsSendHook(api.config, api.runtime);

    // Config migration: preserve explicit activation for existing A2A config.
    // Environments that already set broker config should keep working after
    // core a2a.task.* ownership moves behind the plugin gate.
    api.registerConfigMigration((config) => {
      const entry = config.plugins?.entries?.[A2A_BROKER_ADAPTER_PLUGIN_ID];
      if (!entry?.config || entry.enabled === false) {
        return null;
      }

      const allow = config.plugins?.allow;
      const shouldEnable = entry.enabled !== true;
      const shouldAllowlist = Array.isArray(allow) && !allow.includes(A2A_BROKER_ADAPTER_PLUGIN_ID);
      if (!shouldEnable && !shouldAllowlist) {
        return null;
      }

      const migrated = structuredClone(config);
      const plugins = { ...migrated.plugins };
      const entries = { ...plugins.entries };
      entries[A2A_BROKER_ADAPTER_PLUGIN_ID] = {
        ...entries[A2A_BROKER_ADAPTER_PLUGIN_ID],
        enabled: true,
      };
      plugins.entries = entries;
      if (shouldAllowlist) {
        plugins.allow = [...allow, A2A_BROKER_ADAPTER_PLUGIN_ID];
      }
      migrated.plugins = plugins;

      const changes: string[] = [];
      if (shouldEnable) {
        changes.push("a2a-broker-adapter: auto-enabled (existing config detected)");
      }
      if (shouldAllowlist) {
        changes.push("a2a-broker-adapter: added to plugins.allow (existing config detected)");
      }
      return {
        config: migrated,
        changes,
      };
    });

    registerSessionsSendHook(api, sessionsSendHook);

    const lifecycleApi = api as GatewayLifecycleHookApi;
    if (typeof lifecycleApi.on === "function") {
      lifecycleApi.on("gateway_start", () => {
        // Start broker operator monitoring with Gateway-owned runtime state. This
        // keeps Terminal Brief auto-drain off non-Gateway plugin-registration paths
        // while still starting automatically after a Gateway restart.
        const state = monitoringHandlers.startOperatorEventBridge();
        const log = summarizeOperatorBridgeStart(state);
        lifecycleApi.logger?.[log.level]?.(log.message);
      });
      lifecycleApi.on("gateway_stop", () => {
        monitoringHandlers.shutdownOperatorEventBridge();
        lifecycleApi.logger?.info?.("a2a operator event bridge stopped");
      });
    }

    // Gateway method registration (ownership from core)
    // Scopes match the original core classification:
    //   a2a.task.status          -> operator.read
    //   a2a.task.request         -> operator.write
    //   a2a.task.update          -> operator.write
    //   a2a.task.cancel          -> operator.write
    //   a2a.task.approve         -> operator.approvals
    //   a2a.task.reject_approval -> operator.approvals
    api.registerGatewayMethod("a2a.task.request", handlers.handleA2ATaskRequest, {
      scope: "operator.write",
    });
    api.registerGatewayMethod("a2a.task.update", handlers.handleA2ATaskUpdate, {
      scope: "operator.write",
    });
    api.registerGatewayMethod("a2a.task.cancel", handlers.handleA2ATaskCancel, {
      scope: "operator.write",
    });
    api.registerGatewayMethod("a2a.task.approve", handlers.handleA2ATaskApprove, {
      scope: "operator.approvals",
    });
    api.registerGatewayMethod("a2a.task.reject_approval", handlers.handleA2ATaskRejectApproval, {
      scope: "operator.approvals",
    });
    api.registerGatewayMethod("a2a.task.status", handlers.handleA2ATaskStatus, {
      scope: "operator.read",
    });

    // Peer status gateway method (read-only)
    api.registerGatewayMethod("a2a.peer.status", handlers.handleA2APeerStatus, {
      scope: "operator.read",
    });

    // Monitoring gateway methods (operator.read scope)
    api.registerGatewayMethod("a2a.alerts.list", monitoringHandlers.handleA2AAlertsList, {
      scope: "operator.read",
    });
    api.registerGatewayMethod("a2a.monitor.status", monitoringHandlers.handleA2AMonitorStatus, {
      scope: "operator.read",
    });
  },
});
