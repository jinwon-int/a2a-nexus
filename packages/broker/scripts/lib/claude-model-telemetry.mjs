// Shared output contract for Claude Code bridge model provenance.
//
// The invocation record is derived from the argv actually passed to the Claude
// process that produced the successful output. This keeps telemetry separate
// from model selection: callers continue to build argv with their existing
// policy, then hand the resulting argv to this module for truthful reporting.

export const CLAUDE_MODEL_TELEMETRY_CONTRACT = Object.freeze({
  bridgeAdapter: "claude_code",
  explicitMode: "cli_argument",
  inheritedMode: "metadata_only",
  fields: Object.freeze([
    "bridgeAdapter",
    "requestedModel",
    "requestedThinking",
    "actualRuntimeModel",
    "modelInheritanceMode",
    "claudeModelArgumentApplied",
    "modelInheritanceNote",
  ]),
});

function safeText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function lastOptionValue(args, option) {
  if (!Array.isArray(args)) return "";
  let value = "";
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === option) value = safeText(args[i + 1]).trim();
  }
  return value;
}

export function claudeInvocationModelTelemetry(args) {
  return Object.freeze({
    modelArgument: lastOptionValue(args, "--model"),
    effortArgument: lastOptionValue(args, "--effort"),
  });
}

export function attachClaudeModelTelemetry(
  response,
  {
    bridgeContractVersion,
    flags = {},
    env = process.env,
    invocation,
  },
) {
  const requestedModel = safeText(flags.model).trim();
  const requestedThinking = safeText(flags.thinking).trim();
  const appliedModel = safeText(invocation?.modelArgument).trim();
  const appliedEffort = safeText(invocation?.effortArgument).trim();
  const declaredRuntimeModel = safeText(
    env.A2A_CLAUDE_CODE_RUNTIME_MODEL || env.CLAUDE_CODE_MODEL || env.ANTHROPIC_MODEL,
  ).trim();
  const modelArgumentApplied = Boolean(appliedModel);
  const declaredMatchesApplied = !declaredRuntimeModel || !appliedModel
    ? undefined
    : declaredRuntimeModel === appliedModel;

  return {
    ...response,
    bridgeAdapter: CLAUDE_MODEL_TELEMETRY_CONTRACT.bridgeAdapter,
    bridgeContractVersion,
    requestedModel: requestedModel || undefined,
    requestedThinking: requestedThinking || undefined,
    // An explicit --model is the only model fact this bridge can establish from
    // its own invocation. Declarations that never reach the child are retained
    // only for the compatibility comparison below, never promoted to "actual".
    actualRuntimeModel: appliedModel || undefined,
    appliedModel: appliedModel || undefined,
    appliedEffort: appliedEffort || undefined,
    declaredRuntimeModelMatchesApplied: declaredMatchesApplied,
    modelInheritanceMode: modelArgumentApplied
      ? CLAUDE_MODEL_TELEMETRY_CONTRACT.explicitMode
      : CLAUDE_MODEL_TELEMETRY_CONTRACT.inheritedMode,
    claudeModelArgumentApplied: modelArgumentApplied,
    modelInheritanceNote: modelArgumentApplied
      ? `Claude Code bridge passed an explicit --model argument to the output-producing invocation (${appliedModel}); actualRuntimeModel reports that CLI model selector.`
      : "Claude Code bridge did not pass --model to the output-producing invocation; the requested model is metadata only and the actual runtime model is unknown.",
  };
}
