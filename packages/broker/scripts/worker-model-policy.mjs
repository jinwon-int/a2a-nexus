// Source-only worker model policy for A2A handler and advisory-sidecar guardrails.
// This module is intentionally side-effect free: it does not call providers,
// start sidecars, dispatch tasks, mutate broker state, or grant approvals.

export const ALLOWED_WORKER_MODELS = Object.freeze([
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "deepseek-v4-pro",
  // Current native Hermes fleet baseline models (#766).
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

const ALLOWED_MODEL_SET = new Set(ALLOWED_WORKER_MODELS);
const VALID_THINKING_SET = new Set(VALID_WORKER_THINKING_LEVELS);
const HERMES_UNSUPPORTED_MODEL_SET = new Set(HERMES_UNSUPPORTED_WORKER_MODELS);

export function isAllowedWorkerModel(model) {
  return ALLOWED_MODEL_SET.has(safeText(model, ""));
}

export function isValidWorkerThinkingLevel(thinking) {
  return VALID_THINKING_SET.has(safeText(thinking, ""));
}

export function resolveWorkerModelInputs({ payloadModel = "", envModel = "" } = {}) {
  const payload = safeText(payloadModel, "");
  const env = safeText(envModel, "");
  if (payload && isAllowedWorkerModel(payload)) {
    return { model: payload, fromPayload: true };
  }
  if (payload && !isAllowedWorkerModel(payload)) {
    return { model: null, error: `workerModel "${payload}" is not in the allowlist: [${ALLOWED_WORKER_MODELS.join(", ")}]` };
  }
  if (env && isAllowedWorkerModel(env)) {
    return { model: env, fromPayload: false };
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
  if (value === "gpt-5.5") return "openai-codex/gpt-5.5";
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
      supportedAction: "Use a Hermes-supported model such as openai-codex/gpt-5.5 or route this task to a non-Hermes patch profile.",
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
    sidecarRecommendationBypassesAllowlist: false,
    sidecarRecommendationBypassesCapabilityChecks: false,
    sidecarRecommendationBypassesApprovalGates: false,
    sidecarRecommendationBypassesFinalizer: false,
    startsSidecarProcess: false,
    sendsProviderRequests: false,
    mutatesBrokerState: false,
    dispatchesTasks: false,
  });
}

function safeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
