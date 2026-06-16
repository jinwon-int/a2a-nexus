import {
  ADVISORY_SIDECAR_DEFAULT_OFF_BOUNDARY,
  defaultDisabledAdvisorySidecarRecommendation,
  type AdvisorySidecarResolverBoundary,
} from "./a2a-advisory-sidecar-resolver.js";
import type { AdvisorySidecarRecommendation } from "./a2a-advisory-sidecar-contract.js";

export type AdvisorySidecarOperatorDecisionState = "default_off_operator_decision_ready";

export interface AdvisorySidecarOperatorDecisionOptions {
  now?: string;
  decisionOwner?: string;
  decisionReference?: string;
  parentRoundId?: string;
}

export interface AdvisorySidecarOperatorDecisionPacket {
  readonly kind: "a2a-broker.advisory-sidecar-operator-decision.packet";
  readonly version: 1;
  readonly generatedAt: string;
  readonly state: AdvisorySidecarOperatorDecisionState;
  readonly sourceOnlyNoLive: true;
  readonly advisoryOnly: true;
  readonly defaultOffOnlyExecutableState: true;
  readonly idempotencyKey: string;
  readonly decision: {
    readonly decisionOwner: string;
    readonly decisionReference: string;
    readonly parentRoundId?: string;
    readonly recommendation: AdvisorySidecarRecommendation;
    readonly boundary: AdvisorySidecarResolverBoundary;
    readonly parentIssueRefs: readonly ["#764", "#785", "#789", "#794", "#837"];
    readonly guardrailRefs: readonly [
      "a2a-advisory-sidecar-contract",
      "a2a-advisory-sidecar-resolver",
    ];
  };
  readonly readiness: {
    readonly operatorDecisionPacketReady: true;
    readonly processSpawnPermitted: false;
    readonly sidecarStartPermitted: false;
    readonly providerSendPermitted: false;
    readonly dispatchPermitted: false;
    readonly routingChangePermitted: false;
    readonly dbMutationPermitted: false;
    readonly deployRestartPermitted: false;
    readonly releaseTagPermitted: false;
    readonly secretMovementPermitted: false;
    readonly approvalGrantPermitted: false;
    readonly executionPermitted: false;
    readonly nextAction: string;
  };
  readonly activationReadiness: AdvisorySidecarActivationReadiness;
  readonly approvalSensitiveActionsExcluded: readonly string[];
  readonly integrationContract: {
    readonly transport: "json";
    readonly harnessNeutral: true;
    readonly operatorDecisionPacketVersion: 1;
    readonly consumesDefaultOffResolver: true;
    readonly startsSidecarProcess: false;
    readonly sendsProviderRequests: false;
    readonly mutatesBrokerState: false;
    readonly mutatesDatabase: false;
    readonly dispatchesTasks: false;
    readonly changesRouting: false;
    readonly grantsApproval: false;
    readonly executesAction: false;
  };
  readonly semantics: {
    readonly packetDoesNotGrantApproval: true;
    readonly packetDoesNotStartSidecar: true;
    readonly packetDoesNotSendProviders: true;
    readonly packetDoesNotMutateDb: true;
    readonly packetDoesNotDispatchOrRoute: true;
    readonly packetDoesNotDeployRestartReleaseOrMoveSecrets: true;
    readonly separateFreshApprovalRequiredForLiveActions: true;
    readonly finalizerRemainsAuthoritative: true;
  };
}

export interface AdvisorySidecarActivationReadiness {
  readonly defaultEnabled: false;
  readonly packetGrantsApproval: false;
  readonly requiredEvidenceBeforeStart: readonly string[];
  readonly approvalGates: Record<
    | "sidecarProcessStart"
    | "providerSend"
    | "routingInfluence"
    | "dbMutation"
    | "dispatchInfluence"
    | "deployRestart"
    | "releaseTag"
    | "secretMovement"
    | "manualAckReplay",
    {
      readonly requiresFreshApproval: true;
      readonly grantedByThisPacket: false;
      readonly finalizerRequired: true;
    }
  >;
  readonly rollbackAbortCriteria: readonly string[];
  readonly safeTelemetryFields: readonly string[];
  readonly finalizer: {
    readonly owner: string;
    readonly nonBypassable: true;
    readonly workerEvidenceAdvisoryOnly: true;
  };
}

const PARENT_ISSUE_REFS = ["#764", "#785", "#789", "#794", "#837"] as const;
const GUARDRAIL_REFS = [
  "a2a-advisory-sidecar-contract",
  "a2a-advisory-sidecar-resolver",
] as const;

export function createAdvisorySidecarOperatorDecisionPacket(
  options: AdvisorySidecarOperatorDecisionOptions = {},
): AdvisorySidecarOperatorDecisionPacket {
  const generatedAt = options.now ?? new Date().toISOString();
  const decisionOwner = options.decisionOwner ?? "broker-finalizer";
  const decisionReference = options.decisionReference ?? "advisory-sidecar-default-off-operator-decision";
  const state: AdvisorySidecarOperatorDecisionState = "default_off_operator_decision_ready";

  return deepFreeze({
    kind: "a2a-broker.advisory-sidecar-operator-decision.packet",
    version: 1,
    generatedAt,
    state,
    sourceOnlyNoLive: true,
    advisoryOnly: true,
    defaultOffOnlyExecutableState: true,
    idempotencyKey: buildAdvisorySidecarOperatorDecisionIdempotencyKey(
      decisionOwner,
      decisionReference,
      generatedAt,
      state,
    ),
    decision: {
      decisionOwner,
      decisionReference,
      parentRoundId: options.parentRoundId,
      recommendation: defaultDisabledAdvisorySidecarRecommendation(),
      boundary: ADVISORY_SIDECAR_DEFAULT_OFF_BOUNDARY,
      parentIssueRefs: PARENT_ISSUE_REFS,
      guardrailRefs: GUARDRAIL_REFS,
    },
    readiness: {
      operatorDecisionPacketReady: true,
      processSpawnPermitted: false,
      sidecarStartPermitted: false,
      providerSendPermitted: false,
      dispatchPermitted: false,
      routingChangePermitted: false,
      dbMutationPermitted: false,
      deployRestartPermitted: false,
      releaseTagPermitted: false,
      secretMovementPermitted: false,
      approvalGrantPermitted: false,
      executionPermitted: false,
      nextAction: "record operator-visible default-off decision evidence before proposing any separately approved live action",
    },
    activationReadiness: buildActivationReadiness(decisionOwner),
    approvalSensitiveActionsExcluded: [
      "sidecar process startup",
      "provider or Hermes send/canary",
      "task dispatch or routing influence",
      "broker state or database mutation",
      "deploy, restart, release, or tag publication",
      "secret or credential movement",
      "approval grant or live enablement",
    ],
    integrationContract: {
      transport: "json",
      harnessNeutral: true,
      operatorDecisionPacketVersion: 1,
      consumesDefaultOffResolver: true,
      startsSidecarProcess: false,
      sendsProviderRequests: false,
      mutatesBrokerState: false,
      mutatesDatabase: false,
      dispatchesTasks: false,
      changesRouting: false,
      grantsApproval: false,
      executesAction: false,
    },
    semantics: {
      packetDoesNotGrantApproval: true,
      packetDoesNotStartSidecar: true,
      packetDoesNotSendProviders: true,
      packetDoesNotMutateDb: true,
      packetDoesNotDispatchOrRoute: true,
      packetDoesNotDeployRestartReleaseOrMoveSecrets: true,
      separateFreshApprovalRequiredForLiveActions: true,
      finalizerRemainsAuthoritative: true,
    },
  });
}

function buildActivationReadiness(decisionOwner: string): AdvisorySidecarActivationReadiness {
  const gate = Object.freeze({
    requiresFreshApproval: true,
    grantedByThisPacket: false,
    finalizerRequired: true,
  } as const);

  return deepFreeze({
    defaultEnabled: false,
    packetGrantsApproval: false,
    requiredEvidenceBeforeStart: [
      "operator_approval_record",
      "finalizer_go_decision",
      "default_off_resolver_evidence",
      "sidecar_process_preflight",
      "provider_send_preflight",
      "routing_influence_preflight",
      "db_mutation_preflight",
      "dispatch_influence_preflight",
      "rollback_abort_plan",
    ],
    approvalGates: {
      sidecarProcessStart: gate,
      providerSend: gate,
      routingInfluence: gate,
      dbMutation: gate,
      dispatchInfluence: gate,
      deployRestart: gate,
      releaseTag: gate,
      secretMovement: gate,
      manualAckReplay: gate,
    },
    rollbackAbortCriteria: [
      "missing_or_stale_operator_approval",
      "non_green_preflight_or_ci",
      "provider_send_attempt_before_approval",
      "routing_or_dispatch_influence_before_approval",
      "db_mutation_or_state_change_before_approval",
      "secret_or_release_action_before_approval",
    ],
    safeTelemetryFields: [
      "packet.kind",
      "packet.version",
      "packet.generatedAt",
      "packet.state",
      "readiness.*Permitted",
      "activationReadiness.requiredEvidenceBeforeStart",
      "activationReadiness.approvalGates.*.requiresFreshApproval",
      "activationReadiness.rollbackAbortCriteria",
    ],
    finalizer: {
      owner: decisionOwner,
      nonBypassable: true,
      workerEvidenceAdvisoryOnly: true,
    },
  });
}

export function buildAdvisorySidecarOperatorDecisionIdempotencyKey(
  decisionOwner: string,
  decisionReference: string,
  generatedAt: string,
  state: AdvisorySidecarOperatorDecisionState,
): string {
  return ["advisory-sidecar-operator-decision", state, decisionOwner, decisionReference, generatedAt]
    .join(":");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) {
      deepFreeze(item as T);
    }
  }
  return value;
}
