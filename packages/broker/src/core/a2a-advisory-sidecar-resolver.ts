import {
  DEFAULT_DISABLED_ADVISORY_SIDECAR_RECOMMENDATION,
  resolveAdvisorySidecarRecommendation,
  type AdvisorySidecarRecommendation,
  type AdvisorySidecarResolution,
  type AdvisorySidecarStatus,
} from "./a2a-advisory-sidecar-contract.js";

/**
 * Default-off adapter boundary for the optional advisory sidecar (#789).
 *
 * This module deliberately does not start a sidecar process, send provider
 * requests, mutate broker/DB state, dispatch tasks, or change routing. It only
 * maps caller-supplied configuration + already-available raw output into the
 * pure #785 recommendation contract. The recommendation remains advisory-only;
 * finalizer authority, deterministic routing, worker capability checks, model
 * allowlists, approval gates, and secret redaction are enforced elsewhere.
 */
export interface AdvisorySidecarResolverInput {
  /** Explicit feature flag. Missing/false is disabled. */
  enabled?: boolean;
  /** Optional deployment/config readiness. Missing is treated as unconfigured. */
  configured?: boolean;
  /** Caller-observed sidecar state. Ignored unless enabled + configured. */
  status?: AdvisorySidecarStatus;
  /** Caller-supplied untrusted sidecar output. Never inspected while default-off. */
  rawOutput?: unknown;
}

export interface AdvisorySidecarResolverBoundary {
  readonly startsSidecarProcess: false;
  readonly sendsProviderRequests: false;
  readonly mutatesBrokerState: false;
  readonly mutatesDatabase: false;
  readonly dispatchesTasks: false;
  readonly changesRouting: false;
  readonly bypassesFinalizer: false;
  readonly bypassesWorkerCapabilityChecks: false;
  readonly bypassesModelAllowlists: false;
  readonly bypassesApprovalGates: false;
  readonly bypassesSecretRedaction: false;
}

export const ADVISORY_SIDECAR_DEFAULT_OFF_BOUNDARY: AdvisorySidecarResolverBoundary = Object.freeze({
  startsSidecarProcess: false,
  sendsProviderRequests: false,
  mutatesBrokerState: false,
  mutatesDatabase: false,
  dispatchesTasks: false,
  changesRouting: false,
  bypassesFinalizer: false,
  bypassesWorkerCapabilityChecks: false,
  bypassesModelAllowlists: false,
  bypassesApprovalGates: false,
  bypassesSecretRedaction: false,
});

export interface AdvisorySidecarResolverOutput extends AdvisorySidecarResolution {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly effectiveStatus: AdvisorySidecarStatus;
  readonly boundary: AdvisorySidecarResolverBoundary;
  readonly advisoryOnly: true;
}

export function resolveDefaultOffAdvisorySidecarRecommendation(
  input: AdvisorySidecarResolverInput = {},
): AdvisorySidecarResolverOutput {
  const enabled = input.enabled === true;
  const configured = input.configured === true;
  const effectiveStatus: AdvisorySidecarStatus = enabled && configured
    ? input.status ?? "enabled"
    : "disabled";

  const resolution = resolveAdvisorySidecarRecommendation(
    effectiveStatus,
    effectiveStatus === "enabled" ? input.rawOutput : undefined,
  );

  return Object.freeze({
    ...resolution,
    enabled,
    configured,
    effectiveStatus,
    boundary: ADVISORY_SIDECAR_DEFAULT_OFF_BOUNDARY,
    advisoryOnly: true,
  });
}

export function defaultDisabledAdvisorySidecarRecommendation(): AdvisorySidecarRecommendation {
  return DEFAULT_DISABLED_ADVISORY_SIDECAR_RECOMMENDATION;
}
