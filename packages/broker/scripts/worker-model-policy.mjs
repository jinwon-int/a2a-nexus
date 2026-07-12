// Source-only worker model policy for A2A handler and advisory-sidecar guardrails.
// This module is intentionally side-effect free: it does not call providers,
// start sidecars, dispatch tasks, mutate broker state, or grant approvals.

export const ALLOWED_WORKER_MODELS = Object.freeze([
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "deepseek-v4-pro",
  // Current native Hermes fleet baseline models (#766).
  "openai-codex/gpt-5.6-sol",
  "gpt-5.6-sol",
  "openai-codex/gpt-5.5",
  "gpt-5.5",
  "grok-4.20",
  // M3 fleet workers run minimax-m3 via the custom:minimax provider (#673).
  "minimax-m3",
]);

export const DEFAULT_WORKER_MODEL = "openai-codex/gpt-5.5";

export const VALID_WORKER_THINKING_LEVELS = Object.freeze([
  "off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max",
]);

export const DEFAULT_WORKER_THINKING = "low";

export const HERMES_UNSUPPORTED_WORKER_MODELS = Object.freeze([
  "deepseek/deepseek-v4-flash",
  "deepseek-v4-flash",
]);

export const ADVISORY_SIDECAR_ROUTING_POLICY = Object.freeze({
  kind: "a2a.advisory-sidecar-routing-policy.v1",
  activationLabels: Object.freeze([
    "advisory-sidecar",
    "sidecar:advisory",
    "sidecar-candidate",
  ]),
  requiredCapabilities: Object.freeze([
    "advisory-sidecar",
    "source-analysis",
  ]),
  advisoryOnly: true,
  routingInfluencePermitted: false,
  defaultRoute: "default_worker",
  allowedRoute: "default_worker",
  advisoryCandidateRoute: "advisory_sidecar",
  blockedRoute: "finalizer_review",
  bypasses: Object.freeze({
    allowlist: false,
    capabilityChecks: false,
    approvalGates: false,
    finalizer: false,
  }),
});

const ALLOWED_MODEL_SET = new Set(ALLOWED_WORKER_MODELS);
const VALID_THINKING_SET = new Set(VALID_WORKER_THINKING_LEVELS);
const HERMES_UNSUPPORTED_MODEL_SET = new Set(HERMES_UNSUPPORTED_WORKER_MODELS);

export function isAllowedWorkerModel(model) {
  return ALLOWED_MODEL_SET.has(canonicalizeWorkerModel(model));
}

export function isValidWorkerThinkingLevel(thinking) {
  return VALID_THINKING_SET.has(safeText(thinking, ""));
}

export function resolveWorkerModelInputs({ payloadModel = "", envModel = "" } = {}) {
  const payload = safeText(payloadModel, "");
  const env = safeText(envModel, "");
  const canonicalPayload = canonicalizeWorkerModel(payload);
  const canonicalEnv = canonicalizeWorkerModel(env);
  if (payload && ALLOWED_MODEL_SET.has(payload)) {
    return { model: payload, fromPayload: true };
  }
  if (payload && ALLOWED_MODEL_SET.has(canonicalPayload)) {
    return { model: canonicalPayload, fromPayload: true };
  }
  if (payload) {
    return { model: null, error: `workerModel "${payload}" is not in the allowlist: [${ALLOWED_WORKER_MODELS.join(", ")}]` };
  }
  if (env && ALLOWED_MODEL_SET.has(env)) {
    return { model: env, fromPayload: false };
  }
  if (env && ALLOWED_MODEL_SET.has(canonicalEnv)) {
    return { model: canonicalEnv, fromPayload: false };
  }
  return { model: DEFAULT_WORKER_MODEL, fromPayload: false };
}

export function resolveWorkerThinkingInput(thinking) {
  const payloadThinking = safeText(thinking, "");
  if (payloadThinking && isValidWorkerThinkingLevel(payloadThinking)) {
    return { thinking: payloadThinking, fromPayload: true };
  }
  return { thinking: DEFAULT_WORKER_THINKING, fromPayload: false };
}

export function canonicalizeWorkerModel(model) {
  const value = safeText(model, "");
  if (value === "deepseek-v4-flash") return "deepseek/deepseek-v4-flash";
  if (value === "deepseek-v4-pro") return "deepseek/deepseek-v4-pro";
  if (value === "gpt-5.6-sol") return "openai-codex/gpt-5.6-sol";
  if (value === "gpt-5.5") return "openai-codex/gpt-5.5";
  if (value === "custom:minimax/minimax-m3") return "minimax-m3";
  return value;
}

export function isWorkerModelSupportedByPatchProfile(profile, model) {
  const normalizedProfile = safeText(profile, "").toLowerCase().replace(/_/g, "-");
  const canonicalModel = canonicalizeWorkerModel(model);
  if (normalizedProfile === "hermes" && HERMES_UNSUPPORTED_MODEL_SET.has(canonicalModel)) {
    return {
      supported: false,
      failureCategory: "unsupported_hermes_model",
      profile: normalizedProfile,
      requestedModel: safeText(model, ""),
      canonicalModel,
      supportedAction: "Use a Hermes-supported model such as openai-codex/gpt-5.6-sol or route this task to a non-Hermes patch profile.",
    };
  }
  return {
    supported: true,
    profile: normalizedProfile,
    requestedModel: safeText(model, ""),
    canonicalModel,
  };
}

export function advisorySidecarWorkerModelPolicySnapshot() {
  return Object.freeze({
    advisoryOnly: true,
    defaultWorkerModel: DEFAULT_WORKER_MODEL,
    allowedWorkerModels: ALLOWED_WORKER_MODELS,
    validThinkingLevels: VALID_WORKER_THINKING_LEVELS,
    hermesUnsupportedWorkerModels: HERMES_UNSUPPORTED_WORKER_MODELS,
    routingPolicy: ADVISORY_SIDECAR_ROUTING_POLICY,
    sidecarRecommendationBypassesAllowlist: false,
    sidecarRecommendationBypassesCapabilityChecks: false,
    sidecarRecommendationBypassesApprovalGates: false,
    sidecarRecommendationBypassesFinalizer: false,
    startsSidecarProcess: false,
    sendsProviderRequests: false,
    mutatesBrokerState: false,
    dispatchesTasks: false,
    routingInfluencePermitted: false,
  });
}

export function resolveAdvisorySidecarRoutingPolicy({
  taskLabels = [],
  workerModel = "",
  workerThinking = "",
  patchProfile = "",
  workerCapabilities = [],
  requiresApproval = false,
} = {}) {
  const labels = normalizeStringSet(taskLabels);
  const capabilities = normalizeStringSet(workerCapabilities);
  const labelMatched = ADVISORY_SIDECAR_ROUTING_POLICY.activationLabels.find((label) => labels.has(label)) ?? null;
  const modelResolution = resolveWorkerModelInputs({ payloadModel: workerModel });
  const selectedModel = modelResolution.model ?? safeText(workerModel, "");
  const thinkingResolution = resolveWorkerThinkingInput(workerThinking);
  const reasons = [];

  if (!labelMatched) {
    return buildAdvisoryRoutingDecision({
      status: "fallback",
      route: ADVISORY_SIDECAR_ROUTING_POLICY.defaultRoute,
      selectedModel: DEFAULT_WORKER_MODEL,
      selectedThinking: thinkingResolution.thinking,
      reasons: ["no_advisory_route_label"],
      labelMatched,
      modelAllowed: true,
      capabilityChecksPassed: false,
      approvalGatePassed: !requiresApproval,
    });
  }

  if (modelResolution.error) {
    reasons.push("worker_model_not_allowed");
  }

  const profileSupport = isWorkerModelSupportedByPatchProfile(patchProfile, selectedModel);
  if (!profileSupport.supported) {
    reasons.push("worker_model_not_supported_by_profile");
  }

  const missingCapabilities = ADVISORY_SIDECAR_ROUTING_POLICY.requiredCapabilities.filter(
    (capability) => !capabilities.has(capability),
  );
  for (const capability of missingCapabilities) {
    reasons.push(`missing_worker_capability:${capability}`);
  }

  if (requiresApproval) {
    reasons.push("approval_gate_required");
  }

  return buildAdvisoryRoutingDecision({
    status: reasons.length === 0 ? "allowed" : "blocked",
    route: reasons.length === 0
      ? ADVISORY_SIDECAR_ROUTING_POLICY.defaultRoute
      : ADVISORY_SIDECAR_ROUTING_POLICY.blockedRoute,
    selectedModel,
    selectedThinking: thinkingResolution.thinking,
    reasons,
    labelMatched,
    modelAllowed: !modelResolution.error,
    capabilityChecksPassed: missingCapabilities.length === 0,
    approvalGatePassed: !requiresApproval,
  });
}

function buildAdvisoryRoutingDecision({
  status,
  route,
  selectedModel,
  selectedThinking,
  reasons,
  labelMatched,
  modelAllowed,
  capabilityChecksPassed,
  approvalGatePassed,
}) {
  return {
    status,
    route,
    advisoryOnly: ADVISORY_SIDECAR_ROUTING_POLICY.advisoryOnly,
    selectedModel,
    selectedThinking,
    reasons,
    evidence: {
      labelMatched,
      modelAllowed,
      capabilityChecksPassed,
      approvalGatePassed,
      finalizerRequired: true,
      routingInfluencePermitted: ADVISORY_SIDECAR_ROUTING_POLICY.routingInfluencePermitted,
      advisoryCandidateRoute: ADVISORY_SIDECAR_ROUTING_POLICY.advisoryCandidateRoute,
      operationalRoutingChanged: false,
    },
    bypasses: ADVISORY_SIDECAR_ROUTING_POLICY.bypasses,
  };
}

export function resolveAdvisorySidecarFallbackDecision(input = {}) {
  const options = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const {
    enabled = false,
    available = false,
    timedOut = false,
    response = null,
  } = options;
  const reasons = [];

  if (!enabled) reasons.push("sidecar_disabled");
  if (enabled && !available) reasons.push("sidecar_unavailable");
  if (timedOut) reasons.push("sidecar_timeout");

  const responseRecord = response && typeof response === "object" && !Array.isArray(response)
    ? response
    : null;
  if (enabled && available && !timedOut) {
    const bypasses = responseRecord && Object.hasOwn(responseRecord, "bypasses") ? responseRecord.bypasses : null;
    if (bypasses && typeof bypasses === "object" && !Array.isArray(bypasses)) {
      for (const gate of ["allowlist", "capabilityChecks", "approvalGates", "finalizer"]) {
        if (Object.hasOwn(bypasses, gate) && bypasses[gate] === true) reasons.push(`sidecar_bypass_recommended:${gate}`);
      }
    }
    if (!isValidAdvisorySidecarResponse(responseRecord)) {
      reasons.push("sidecar_schema_mismatch");
    }
  }

  return {
    status: reasons.length === 0 ? "accepted_advisory" : "fallback",
    route: ADVISORY_SIDECAR_ROUTING_POLICY.defaultRoute,
    advisoryOnly: true,
    finalizerRequired: true,
    reasons,
    startsSidecarProcess: false,
    sendsProviderRequests: false,
    mutatesBrokerState: false,
    bypasses: ADVISORY_SIDECAR_ROUTING_POLICY.bypasses,
  };
}

function isValidAdvisorySidecarResponse(response) {
  if (!response) return false;
  if (!Object.hasOwn(response, "schemaVersion") || response.schemaVersion !== "a2a.advisory-sidecar.response.v1") return false;
  if (!Object.hasOwn(response, "recommendation") || response.recommendation !== "continue_default") return false;
  if (!Object.hasOwn(response, "bypasses") || !response.bypasses || typeof response.bypasses !== "object" || Array.isArray(response.bypasses)) return false;
  for (const gate of ["allowlist", "capabilityChecks", "approvalGates", "finalizer"]) {
    if (!Object.hasOwn(response.bypasses, gate) || response.bypasses[gate] !== false) return false;
  }
  return true;
}

function normalizeStringSet(values) {
  if (!Array.isArray(values)) {
    return new Set();
  }
  return new Set(values.map((value) => safeText(value, "")).filter(Boolean));
}

function safeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
