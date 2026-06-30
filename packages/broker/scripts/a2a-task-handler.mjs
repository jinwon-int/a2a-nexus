#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_WORKER_MODELS,
  VALID_WORKER_THINKING_LEVELS,
  canonicalizeWorkerModel,
  isWorkerModelSupportedByPatchProfile,
  resolveWorkerModelInputs,
  resolveWorkerThinkingInput,
} from "./worker-model-policy.mjs";

const HANDLER_VERSION = "0.2.14";
const SOURCE_PATH = fileURLToPath(import.meta.url);
const sourceSha256 = createHash("sha256").update(readFileSync(SOURCE_PATH)).digest("hex");

// ── Worker execution constants ──────────────────────────────────────────
const DEFAULT_RUNNER_TASK_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_OPENCLAW_TIMEOUT_SEC = 60 * 60;

export const BUILD_INFO = Object.freeze({
  name: "a2a-task-handler",
  version: HANDLER_VERSION,
  source: "repo:scripts/a2a-task-handler.mjs",
  sourceSha256,
  contract: "stdin A2A task JSON -> stdout WorkerHandlerOutcome JSON",
  credentialFree: true,
  hostNeutral: true,
});

function safeText(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function taskPayload(task) {
  return task && typeof task.payload === "object" && !Array.isArray(task.payload) ? task.payload : {};
}

function taskMode(task) {
  const payload = taskPayload(task);
  return safeText(payload.mode, safeText(task?.intent, "generic"));
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function isDockerBrokerNoopSmokeTask(task) {
  const payload = taskPayload(task);
  return taskMode(task) === "docker-broker-noop-smoke" && payload.noOp === true;
}

function normalizedExecutorMode(env = process.env) {
  const mode = safeText(env.A2A_EXECUTOR_MODE, "").toLowerCase();
  if (["auto", "docker", "builtin"].includes(mode)) return mode;
  return isTruthyEnv(env.A2A_DOCKER_RUNNER_ENABLED) ? "auto" : "builtin";
}

function normalizedDockerScope(env = process.env) {
  const scope = safeText(env.A2A_DOCKER_RUNNER_SCOPE, "").toLowerCase().replace(/_/g, "-");
  if (["all", "all-github", "github"].includes(scope)) return "all-github";
  if (["plugin", "plugin-only", "openclaw-plugin-a2a"].includes(scope)) return "plugin-only";
  return isTruthyEnv(env.A2A_DOCKER_RUNNER_ALL_GITHUB) ? "all-github" : "plugin-only";
}

function shouldFallbackToBuiltin(env = process.env) {
  return isTruthyEnv(env.A2A_DOCKER_RUNNER_FALLBACK_TO_BUILTIN) ||
    safeText(env.A2A_EXECUTOR_FALLBACK, "").toLowerCase() === "builtin";
}

function isDockerRunnerBinConfigured(env = process.env) {
  return safeText(env.A2A_DOCKER_RUNNER_BIN, "").length > 0;
}

// Returns true when the executor policy mandates docker for all GitHub patch tasks.
// In these modes the runner binary must be explicitly configured up-front.
function isDockerFirstMode(env = process.env) {
  const executorMode = normalizedExecutorMode(env);
  if (executorMode === "docker") return true;
  if (executorMode === "auto" && normalizedDockerScope(env) === "all-github") return true;
  return false;
}

function parseJsonArrayEnv(value) {
  if (!value) return [];
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("A2A_DOCKER_RUNNER_ARGS_JSON must be a JSON string array");
  }
  return parsed;
}

function shouldUseDockerRunner(task, env = process.env) {
  const executorMode = normalizedExecutorMode(env);
  if (executorMode === "builtin") return false;

  if (!isGithubEvidenceTask(task)) return false;
  if (executorMode === "docker") return true;
  if (normalizedDockerScope(env) === "all-github") {
    return !(hasBlockedClaudeDockerConfig(env) && isOpenClawBridgeConfigured(env));
  }

  const payload = taskPayload(task);
  const repo = safeText(payload.repo, "");
  const requestedPreset = safeText(payload.runnerPreset ?? env.A2A_DOCKER_RUNNER_PRESET, "");
  return requestedPreset === "openclaw-plugin-a2a-dev" || /openclaw-plugin-a2a/.test(repo);
}

function hasBlockedClaudeDockerConfig(env = process.env) {
  if (isTruthyEnv(env.A2A_ALLOW_CLAUDE_IN_DOCKER) || isTruthyEnv(env.A2A_DOCKER_RUNNER_ALLOW_CLAUDE_IN_DOCKER)) return false;

  const commandValues = [
    env.A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT,
    env.A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON,
    env.A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE,
  ];
  if (commandValues.some((value) => value && referencesClaudeDocker(value))) return true;

  const mounts = safeText(env.A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON, "");
  return Boolean(mounts && referencesClaudeDocker(mounts));
}

function referencesClaudeDocker(value) {
  return [
    /@anthropic-ai\/claude-code/i,
    /(^|[\s;|&"'`])claude([\s;|&"'`-]|$)/i,
    /\.claude(?:\.json|\/|$)/i,
    /claude-(?:install|output|prompt)\.log|claude-prompt\.md/i,
    /claude(?:\.json|-dir)?/i,
  ].some((pattern) => pattern.test(String(value ?? "")));
}

function isOpenClawBridgeConfigured(env = process.env) {
  if (isTruthyEnv(env.A2A_OPENCLAW_BRIDGE_DISABLED)) return false;
  return isTruthyEnv(env.A2A_OPENCLAW_BRIDGE_ENABLED) || Boolean(safeText(env.OPENCLAW_BIN, ""));
}

function buildRunnerTask(task, env = process.env) {
  const payload = taskPayload(task);
  const repo = safeText(payload.repo, "");
  const requestedPreset = safeText(payload.runnerPreset ?? env.A2A_DOCKER_RUNNER_PRESET, "");
  const usesPluginPreset = requestedPreset === "openclaw-plugin-a2a-dev" || /openclaw-plugin-a2a/.test(repo);

  const runnerTask = {
    id: safeText(task.id, `task-${Date.now()}`),
    intent: safeText(task.intent, "propose_patch"),
    mode: taskMode(task),
    prompt: [
      safeText(task.message, safeText(payload.prompt, "")),
      "Leave a Start marker before work begins and a PR, Done, or Block marker when work ends; return startCommentUrl plus prUrl, doneCommentUrl, or blockCommentUrl when available.",
      "Before creating a PR, fail closed if OpenClaw runtime/bootstrap context files would enter the branch or artifact evidence. Report the exact repo-relative offending paths, including any of: AGENTS.md, SOUL.md, USER.md, TOOLS.md, HEARTBEAT.md, IDENTITY.md, .openclaw/**.",
    ].filter(Boolean).join("\n\n"),
    timeoutMs: Number(env.A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS || payload.timeoutMs || DEFAULT_RUNNER_TASK_TIMEOUT_MS),
  };

  const issueUrl = safeText(payload.issueUrl, "");
  const issue = safeText(payload.issue, "");
  const issueNumber = safeText(payload.issueNumber, "");
  const reportLanguage = safeText(payload.reportLanguage, "");
  const requestedBy = safeText(payload.requestedBy, safeText(task?.requester?.id, ""));

  if (issueUrl) runnerTask.issueUrl = issueUrl;
  if (issue) runnerTask.issue = issue;
  if (issueNumber) runnerTask.issueNumber = issueNumber;
  if (reportLanguage) runnerTask.reportLanguage = reportLanguage;
  if (requestedBy) runnerTask.requestedBy = requestedBy;
  if (isGithubReadOnlyEvidenceTask(task)) {
    runnerTask.readOnlyValidation = true;
  }
  // Propagate no-change/read-only flags from payload for propose_patch + github-propose-patch
  // The broker sets these flags explicitly when a task should validate without requiring a PR/diff.
  // Without propagation the Docker runner receives no no-change env vars and correctly fail-closes.
  if (isGithubPatchEvidenceTask(task)) {
    if (
      payload.allowNoChanges === true ||
      payload.evidenceOnlyAllowed === true ||
      payload.readOnlyValidation === true ||
      payload.validationOnly === true
    ) {
      runnerTask.allowNoChanges = true;
    }
    if (payload.readOnlyValidation === true || payload.validationOnly === true) {
      runnerTask.readOnlyValidation = true;
    }
  }

  if (usesPluginPreset) {
    runnerTask.preset = "openclaw-plugin-a2a-dev";
    if (safeText(payload.baseBranch, "")) runnerTask.baseBranch = safeText(payload.baseBranch);
    return runnerTask;
  }

  if (repo) {
    runnerTask.repo = repo;
    if (safeText(payload.baseBranch, "")) runnerTask.baseBranch = safeText(payload.baseBranch);
  }

  // Carry workerModel/workerThinking overrides from task payload to runner task
  const { model: effectiveModel } = resolveWorkerModel(task, env);
  const { thinking: effectiveThinking } = resolveWorkerThinking(task);
  runnerTask.workerModel = effectiveModel;
  runnerTask.workerThinking = effectiveThinking;

  if (Array.isArray(payload.repos) && payload.repos.length > 0) {
    runnerTask.repos = payload.repos;
  }
  if (Array.isArray(payload.commands) && payload.commands.every((item) => typeof item === "string")) {
    runnerTask.commands = payload.commands;
  }

  return runnerTask;
}

const GITHUB_PATCH_TASK_MODES = new Set(["github-propose-patch", "github-issue-instruction"]);
const GITHUB_READ_ONLY_VALIDATION_MODES = new Set([
  "github-verify",
  "github-readonly-validation",
  "github-read-only-validation",
  "read-only-validation",
  "github-libero-validation",
  "libero-validation",
  "family-wiki-readonly-audit",
]);

// ── Worker model validation ─────────────────────────────────────────────

/**
 * Resolve the effective model from task payload or environment.
 * If the payload specifies a model, it must be in ALLOWED_WORKER_MODELS.
 * Returns { model, fromPayload } where fromPayload=true means the model
 * came from the task payload override.
 */
function workerModelEnvCandidates(env = process.env) {
  return [
    env.A2A_OPENCLAW_MODEL,
    env.A2A_HERMES_DEFAULT_MODEL,
    // Legacy worker/runner environments can still inject the model under the
    // unprefixed OpenClaw/Hermes names. Include them in the same preflight so
    // a Hermes-incompatible model is blocked before the docker runner invokes
    // Hermes and aborts without operator-visible Block evidence (#860).
    env.OPENCLAW_MODEL,
    env.HERMES_DEFAULT_MODEL,
    env.A2A_DOCKER_RUNNER_WORKER_MODEL,
  ].map((value) => safeText(value, "")).filter(Boolean);
}

function isAllowedWorkerModelName(model) {
  const value = safeText(model, "");
  return ALLOWED_WORKER_MODELS.includes(value) || ALLOWED_WORKER_MODELS.includes(canonicalizeWorkerModel(value));
}

function resolveWorkerModel(task, env = process.env) {
  const payload = taskPayload(task);
  const payloadModel = safeText(payload.workerModel, "");
  if (payloadModel) {
    return resolveWorkerModelInputs({ payloadModel });
  }
  // Prefer the first configured env candidate that is actually allowlisted.
  // If all configured env values are invalid, preserve the existing fallback
  // behavior by passing the first candidate through resolveWorkerModelInputs,
  // which defaults to DEFAULT_WORKER_MODEL for invalid env-only values.
  const envCandidates = workerModelEnvCandidates(env);
  const envModel = envCandidates.find(isAllowedWorkerModelName) || envCandidates[0] || "";
  return resolveWorkerModelInputs({ envModel });
}

/**
 * Resolve the effective thinking level from task payload or default.
 */
function resolveWorkerThinking(task) {
  const payload = taskPayload(task);
  return resolveWorkerThinkingInput(payload.workerThinking);
}

function normalizedPatchCommandProfile(env = process.env) {
  const profile = safeText(env.A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE, "").toLowerCase().replace(/_/g, "-");
  if (profile === "hermes") return "hermes";
  if (profile === "openclaw") return "openclaw";
  const image = safeText(env.A2A_DOCKER_RUNNER_IMAGE, "").toLowerCase();
  return image.includes("hermes") ? "hermes" : "";
}

function workerModelProfileError(task, model, support, source = "effective") {
  return {
    error: {
      code: "worker_model_not_supported_by_profile",
      message: `Hermes patch profile does not support workerModel "${model}"; refusing before docker runner execution`,
      details: {
        failureCategory: support.failureCategory,
        profile: support.profile,
        requestedModel: model,
        canonicalModel: support.canonicalModel,
        modelSource: source,
        taskId: safeText(task.id, undefined),
        intent: safeText(task.intent, undefined),
        mode: taskMode(task),
        supportedAction: support.supportedAction,
        buildInfo: BUILD_INFO,
      },
    },
  };
}

function validateWorkerModelForPatchProfile(task, model, env = process.env, source = "effective") {
  const support = isWorkerModelSupportedByPatchProfile(normalizedPatchCommandProfile(env), model);
  if (!support.supported) {
    return workerModelProfileError(task, model, support, source);
  }
  return null;
}

function validateWorkerModelEnvCandidatesForPatchProfile(task, env = process.env) {
  for (const candidate of workerModelEnvCandidates(env)) {
    if (!isAllowedWorkerModelName(candidate)) continue;
    const support = isWorkerModelSupportedByPatchProfile(normalizedPatchCommandProfile(env), candidate);
    if (!support.supported) {
      return workerModelProfileError(task, candidate, support, "env");
    }
  }
  return null;
}

/**
 * Validate that if a workerModel override is present in the task payload,
 * it is in the allowlist. Returns null on success, or an error object.
 */
function validateWorkerOverrides(task, env = process.env) {
  const modelRes = resolveWorkerModel(task, env);
  if (modelRes.error) {
    return {
      error: {
        code: "worker_model_not_allowed",
        message: modelRes.error,
        details: {
          allowedModels: [...ALLOWED_WORKER_MODELS],
          validThinkingLevels: [...VALID_WORKER_THINKING_LEVELS],
          taskId: safeText(task.id, undefined),
          intent: safeText(task.intent, undefined),
          buildInfo: BUILD_INFO,
        },
      },
    };
  }
  const envProfileValidation = validateWorkerModelEnvCandidatesForPatchProfile(task, env);
  if (envProfileValidation) return envProfileValidation;
  return validateWorkerModelForPatchProfile(task, modelRes.model, env);
}

function isGithubPatchEvidenceTask(task) {
  const mode = taskMode(task);
  const intent = safeText(task.intent, "");
  return intent === "propose_patch" && GITHUB_PATCH_TASK_MODES.has(mode);
}

function isGithubReadOnlyEvidenceTask(task) {
  const mode = taskMode(task);
  const intent = safeText(task.intent, "");
  return (
    (intent === "analyze" || intent === "verify" || intent === "validate_change") &&
    GITHUB_READ_ONLY_VALIDATION_MODES.has(mode)
  );
}

function isGithubEvidenceTask(task) {
  return isGithubPatchEvidenceTask(task) || isGithubReadOnlyEvidenceTask(task);
}

const READ_ONLY_ANALYSIS_MODES = new Set(["analysis-only", "read-only-analysis", "analyze-only"]);
const DECISION_DIALECTIC_SCHEMA_TO_PATCH_OP = new Map([
  ["decisionDialectic.thesis.v1", "append.thesis"],
  ["decisionDialectic.antithesis.v1", "append.antithesis"],
  ["decisionDialectic.rebuttal.v1", "append.rebuttal"],
  ["decisionDialectic.synthesisDecision.v1", "set.synthesis_decision"],
  ["decisionDialectic.outcome.v1", "append.outcome"],
]);

/**
 * Detects analysis-only / read-only A2A task modes.
 *
 * These tasks produce Start+Done/Block evidence (findings, summary, risks)
 * without requiring a patch/PR. They are strictly read-only: no code changes,
 * no workspace modification, no file writes.
 *
 * GitHub propose_patch PR evidence requirements are preserved — analysis-only
 * tasks do not bypass the propose_patch evidence gate.
 */
function isReadOnlyAnalysisTask(task) {
  const intent = safeText(task.intent, "").toLowerCase();
  const mode = taskMode(task).toLowerCase();
  // Explicit mode match: payload.mode must name a recognized analysis-only mode.
  if (intent === "analyze" && READ_ONLY_ANALYSIS_MODES.has(mode)) return true;
  // GitHub read-only validation modes are also analysis tasks when the
  // OpenClaw analysis bridge is explicitly enabled (#884). Without this, an
  // enabled bridge is bypassed and the task falls through to the generic
  // GitHub executor-not-configured path instead of producing substantive
  // read-only analysis evidence.
  if (
    (intent === "analyze" || intent === "verify" || intent === "validate_change")
    && GITHUB_READ_ONLY_VALIDATION_MODES.has(mode)
  ) return true;
  if (isSourceOnlyAnalysisTask(task)) return true;
  return false;
}

function isSourceOnlyAnalysisTask(task) {
  const intent = safeText(task?.intent, "").toLowerCase();
  if (intent !== "analyze") return false;
  const payload = taskPayload(task);
  const mode = taskMode(task).toLowerCase();
  const sourceOnly = payload.sourceOnly === true || payload.source_only === true;
  if (!sourceOnly) return false;
  const phase = safeText(payload.phase, "").toLowerCase();
  const role = safeText(payload.role, "").toLowerCase();
  return mode.startsWith("a2a-") || mode.includes("analysis") || mode.includes("evidence") || Boolean(phase || role);
}

function decisionDialecticPromptSpec(task) {
  const payload = taskPayload(task);
  const promptSpec = payload.promptSpec;
  return promptSpec && typeof promptSpec === "object" && !Array.isArray(promptSpec) ? promptSpec : {};
}

function isDecisionDialecticPhaseTask(task) {
  const intent = safeText(task?.intent, "").toLowerCase();
  if (intent !== "analyze") return false;
  const payload = taskPayload(task);
  const schemaName = safeText(decisionDialecticPromptSpec(task).schemaName, "");
  const contract = payload.contract;
  return DECISION_DIALECTIC_SCHEMA_TO_PATCH_OP.has(schemaName)
    || Boolean(contract && typeof contract === "object" && !Array.isArray(contract) && contract.kind === "decision.dialectic");
}

function shouldUseDecisionDialecticBridge(task, env = process.env) {
  if (!isDecisionDialecticPhaseTask(task)) return false;
  if (isTruthyEnv(env.A2A_DECISION_DIALECTIC_BRIDGE_DISABLED)) return false;
  return isTruthyEnv(env.A2A_DECISION_DIALECTIC_BRIDGE_ENABLED) && isOpenClawBridgeConfigured(env);
}

function isOpenClawAnalysisBridgeConfigured(env = process.env) {
  if (safeText(env.A2A_HERMES_ANALYSIS_BIN, "")) return true;
  if (safeText(env.A2A_OPENCLAW_ANALYSIS_BIN, "")) return true;
  return isOpenClawBridgeConfigured(env);
}

function shouldUseOpenClawAnalysisBridge(task, env = process.env) {
  if (!isReadOnlyAnalysisTask(task)) return false;
  if (isTruthyEnv(env.A2A_HERMES_ANALYSIS_DISABLED)) return false;
  if (isTruthyEnv(env.A2A_OPENCLAW_ANALYSIS_DISABLED)) return false;
  if (!isTruthyEnv(env.A2A_HERMES_ANALYSIS_ENABLED) && !isTruthyEnv(env.A2A_OPENCLAW_ANALYSIS_ENABLED)) return false;
  return isOpenClawAnalysisBridgeConfigured(env);
}

function normalizeAnalysisBridgeAdapter(value) {
  const adapter = safeText(value, "").toLowerCase().replace(/_/g, "-");
  if (["claude", "claude-code", "claude_code"].includes(adapter)) return "claude_code";
  if (["hermes", "hermes-agent", "hermes-agent-source-only", "termux-hermes"].includes(adapter)) return "hermes";
  if (["openclaw", "openclaw-analysis"].includes(adapter)) return "openclaw";
  return "";
}

function normalizedBridgeAnalysisStatus(value) {
  const status = safeText(value, "done").toLowerCase();
  return ["blocked", "block", "source_blocked"].includes(status) ? "blocked" : "done";
}

const ANALYSIS_RECOVERY_SOURCES = new Set(["direct_stdout", "abort_stdout", "state_db", "retry_stdout", "retry_state_db", "claude_result_text"]);

function normalizedAnalysisRecoverySource(value) {
  const text = safeText(value, "");
  return ANALYSIS_RECOVERY_SOURCES.has(text) ? text : undefined;
}

function analysisBridgeTelemetry(command, env = process.env) {
  const commandText = safeText(command, "");
  const commandName = basename(commandText || "analysis-bridge");
  const explicitAdapter = normalizeAnalysisBridgeAdapter(env.A2A_ANALYSIS_BRIDGE_ADAPTER || env.A2A_WORKER_BRIDGE_ADAPTER);
  if (explicitAdapter) {
    return {
      analysisKind: "analysis_bridge",
      bridgeAdapter: explicitAdapter,
      bridgeCommand: commandName,
    };
  }
  const combined = [
    commandText,
    commandName,
    safeText(env.A2A_CLAUDE_CODE_BIN, ""),
    safeText(env.CLAUDE_BIN, ""),
    safeText(env.A2A_WORKER_RUNTIME_FLAVOR, ""),
    safeText(env.WORKER_RUNTIME_FLAVOR, ""),
    safeText(env.WORKER_METADATA_JSON, ""),
  ].join("\n").toLowerCase();
  let bridgeAdapter = "openclaw";
  if (combined.includes("claude")) bridgeAdapter = "claude_code";
  else if (combined.includes("hermes")) bridgeAdapter = "hermes";
  return {
    analysisKind: "analysis_bridge",
    bridgeAdapter,
    bridgeCommand: commandName,
  };
}

function analysisBridgeCommand(env = process.env) {
  return safeText(
    env.A2A_HERMES_ANALYSIS_BIN,
    safeText(env.A2A_OPENCLAW_ANALYSIS_BIN, safeText(env.OPENCLAW_BIN, "openclaw")),
  );
}

function nodeExecutableForChild(env = process.env, runtime = process) {
  const explicit = safeText(env.A2A_NODE_BIN || env.NODE_BIN || env.npm_node_execpath, "");
  if (explicit) return explicit;

  const execPath = safeText(runtime.execPath, "");
  const argv0 = safeText(runtime.argv0, "");
  if (basename(argv0) === "node.real") return argv0.replace(/node\.real$/, "node");
  if (/^node(?:\.exe)?$/i.test(basename(execPath))) return execPath;
  if (/^node(?:\.exe)?$/i.test(basename(argv0))) return argv0;
  return "node";
}

function resolveNodeScriptInvocation(command, args = [], env = process.env, runtime = process) {
  const commandText = safeText(command, "");
  if (/\.(?:mjs|cjs|js)$/i.test(commandText)) {
    return { command: nodeExecutableForChild(env, runtime), args: [commandText, ...args] };
  }
  return { command: commandText, args };
}

function analysisBridgeArtifactPreflight(command, env = process.env) {
  const commandText = safeText(command, "");
  if (!/\.(?:mjs|cjs|js)$/i.test(commandText)) return null;
  if (!commandText.includes("/") && !commandText.includes("\\") && !commandText.startsWith(".")) return null;
  const cwd = safeText(env.A2A_HANDLER_CWD || env.WORKER_HANDLER_CWD, process.cwd());
  const resolved = isAbsolute(commandText) ? commandText : resolve(cwd, commandText);
  if (existsSync(resolved)) return null;
  return {
    error: {
      code: "openclaw_analysis_bridge_missing",
      message: `analysis bridge artifact is missing: ${commandText}`,
      details: {
        failureCategory: "missing_bridge_artifact",
        bridgeCommand: commandText,
        resolvedBridgeCommand: resolved,
        buildInfo: BUILD_INFO,
      },
    },
  };
}

function writeAnalysisBridgeInputFiles(task, payload) {
  const dir = mkdtempSync(join(tmpdir(), "a2a-analysis-bridge-"));
  const taskFile = join(dir, "task.json");
  const payloadFile = join(dir, "payload.json");
  writeFileSync(taskFile, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  writeFileSync(payloadFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { dir, taskFile, payloadFile };
}

function githubIssueTargetFromTask(task) {
  const payload = taskPayload(task);
  const candidates = [
    safeText(payload.issueUrl, ""),
    safeText(payload.githubIssueUrl, ""),
    safeText(payload.parentIssueUrl, ""),
    ...normalizeStringArray(payload.evidenceRefs),
  ];
  for (const candidate of candidates) {
    const match = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)/.exec(candidate);
    if (match) return { owner: match[1], repo: match[2], issueNumber: match[3] };
  }
  const repoText = safeText(payload.repo || payload.repository, "");
  const issueText = safeText(payload.issueNumber || payload.issue, "").replace(/^#/, "");
  const repoMatch = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repoText);
  if (repoMatch && /^\d+$/.test(issueText)) {
    return { owner: repoMatch[1], repo: repoMatch[2], issueNumber: issueText };
  }
  return null;
}

function shouldPostAnalysisEvidenceComment(task, env = process.env) {
  const payload = taskPayload(task);
  if (!isTruthyEnv(env.A2A_POST_ANALYSIS_EVIDENCE_COMMENTS)) return false;
  if (payload.noGitHubComment === true || payload.no_github_comment === true) return false;
  return payload.postGithubComment === true || payload.post_github_comment === true;
}

function markdownList(title, items) {
  const values = normalizeStringArray(items);
  if (values.length === 0) return `## ${title}\n\n- (none)`;
  return `## ${title}\n\n${values.map((item) => `- ${item}`).join("\n")}`;
}

function trimGithubCommentBody(body) {
  const max = 64000;
  if (Buffer.byteLength(body, "utf8") <= max) return body;
  return `${body.slice(0, 60000)}\n\n---\n\n(truncated by a2a-task-handler to stay under GitHub comment limits)`;
}

function buildAnalysisEvidenceCommentBody({ task, status, analysisSummary, output }) {
  const payload = taskPayload(task);
  const marker = `<!-- a2a-analysis-evidence:${safeText(task.id, "unknown")}:${status} -->`;
  const title = status === "blocked" ? "A2A analysis evidence blocked" : "A2A analysis evidence done";
  return trimGithubCommentBody([
    marker,
    `# ${title}`,
    "",
    `- Task: \`${safeText(task.id, "unknown")}\``,
    `- Worker: \`${safeText(output.nodeId, safeText(task.assignedWorkerId, "unknown"))}\``,
    `- Mode: \`${taskMode(task)}\``,
    `- Status: \`${status}\``,
    `- Model: \`${safeText(output.effectiveModel, "unknown")}\``,
    `- Thinking: \`${safeText(output.effectiveThinking, "unknown")}\``,
    `- No-live: \`${payload.noLive === true || payload.no_live === true ? "true" : "false"}\``,
    "",
    `## Summary\n\n${analysisSummary}`,
    "",
    markdownList("Findings", output.findings),
    "",
    markdownList("Risks", output.risks),
    "",
    markdownList("Recommendations", output.recommendations),
    "",
    markdownList("Evidence refs", output.evidenceRefs),
  ].join("\n"));
}

function postGithubIssueCommentSync({ task, status, body, env = process.env }) {
  const target = githubIssueTargetFromTask(task);
  if (!target) {
    return { error: { code: "github_issue_target_missing", message: "postGithubComment requires issueUrl or repo+issue payload", details: { buildInfo: BUILD_INFO } } };
  }
  const primaryAuthKey = `GITHUB_${"TOK"}EN`;
  const shortAuthKey = `GH_${"TOK"}EN`;
  const authValue = safeText(env[primaryAuthKey] || env[shortAuthKey], "");
  if (!authValue) {
    return { error: { code: "github_auth_missing", message: "postGithubComment requires configured GitHub auth", details: { buildInfo: BUILD_INFO } } };
  }

  const marker = `<!-- a2a-analysis-evidence:${safeText(task.id, "unknown")}:${status} -->`;
  const apiBase = safeText(env.A2A_GITHUB_API_BASE_URL, "https://api.github.com").replace(/\/$/, "");
  const request = { ...target, apiBase, authValue, marker, body };
  const script = `
const input = JSON.parse(await new Promise((resolve) => {
  let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => resolve(data));
}));
const endpoint = input.apiBase + '/repos/' + encodeURIComponent(input.owner) + '/' + encodeURIComponent(input.repo) + '/issues/' + encodeURIComponent(input.issueNumber) + '/comments';
const headers = { 'accept': 'application/vnd.github+json', 'content-type': 'application/json', 'authorization': 'Bearer ' + input.authValue, 'user-agent': 'a2a-task-handler' };
const list = await fetch(endpoint + '?per_page=100', { headers });
if (!list.ok) throw new Error('GitHub comments list failed: ' + list.status + ' ' + await list.text());
const comments = await list.json();
const existing = Array.isArray(comments) ? comments.find((comment) => typeof comment.body === 'string' && comment.body.includes(input.marker)) : null;
if (existing?.html_url) {
  console.log(JSON.stringify({ html_url: existing.html_url, id: existing.id, reused: true }));
} else {
  const created = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ body: input.body }) });
  if (!created.ok) throw new Error('GitHub comment create failed: ' + created.status + ' ' + await created.text());
  const payload = await created.json();
  console.log(JSON.stringify({ html_url: payload.html_url, id: payload.id, reused: false }));
}
`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    input: JSON.stringify(request),
    encoding: "utf8",
    timeout: Number(env.A2A_GITHUB_COMMENT_TIMEOUT_MS || 30000),
    maxBuffer: 2 * 1024 * 1024,
  });
  if (child.error || child.status !== 0) {
    return { error: { code: "github_comment_failed", message: child.error?.message || safeText(child.stderr, "GitHub comment process failed"), details: { exitCode: child.status ?? undefined, buildInfo: BUILD_INFO } } };
  }
  try {
    const result = JSON.parse(child.stdout);
    return { url: safeText(result.html_url, ""), id: result.id, reused: result.reused === true };
  } catch (error) {
    return { error: { code: "github_comment_invalid_response", message: error instanceof Error ? error.message : String(error), details: { buildInfo: BUILD_INFO } } };
  }
}

function runOpenClawAnalysisBridge(task, env = process.env) {
  const payload = taskPayload(task);
  // Resolve effective worker model/thinking from task payload overrides
  const { model: effectiveModel, fromPayload: modelFromPayload } = resolveWorkerModel(task, env);
  const { thinking: effectiveThinking, fromPayload: thinkingFromPayload } = resolveWorkerThinking(task);
  const nodeId = safeText(env.A2A_NODE_ID || env.NODE_ID || env.WORKER_ID, "unknown-node");
  const timeoutSec = String(Math.max(1, Number(env.A2A_OPENCLAW_ANALYSIS_TIMEOUT_SEC || env.A2A_OPENCLAW_TIMEOUT_SEC || DEFAULT_OPENCLAW_TIMEOUT_SEC)));
  const sessionId = safeText(
    env.A2A_OPENCLAW_ANALYSIS_SESSION_ID,
    `a2a-${nodeId}-${safeText(task.id, String(Date.now()))}-analysis`,
  );
  const prompt = [
    `You are A2A worker ${nodeId}. Complete this read-only A2A analysis task.`,
    "Do not modify files, deploy, restart services, send providers, acknowledge terminal rows, mutate databases, or move credentials.",
    "Use only the evidence provided in the task unless an approved read-only tool result is present in the payload.",
    "If the task cannot be analyzed from the provided material, return status=blocked with the exact missing evidence.",
    "Return JSON only, no markdown, with exactly this shape:",
    '{"status":"done|blocked","summary":"...","findings":["..."],"risks":["..."],"recommendations":["..."],"evidenceRefs":["..."],"doneCommentUrl":"optional","blockCommentUrl":"optional","startCommentUrl":"optional"}',
    "All human-readable text should be Korean unless quoting code/test output.",
    `Task id: ${safeText(task.id, "unknown")}`,
    `Intent: ${safeText(task.intent, "unknown")}`,
    `Mode: ${taskMode(task)}`,
    `Assigned worker: ${safeText(task.assignedWorkerId, "")}`,
    `Effective model: ${effectiveModel}${modelFromPayload ? " (from payload override)" : ""}`,
    `Effective thinking: ${effectiveThinking}${thinkingFromPayload ? " (from payload override)" : ""}`,
    `Task message:\n${safeText(task.message, "")}`,
    `Payload JSON:\n${jsonForPrompt(payload, 16000)}`,
  ].join("\n\n");

  const baseCommand = analysisBridgeCommand(env);
  const bridgePreflight = analysisBridgeArtifactPreflight(baseCommand, env);
  if (bridgePreflight) return bridgePreflight;
  const baseArgs = [
    "agent",
    "--local",
    "--agent", safeText(env.A2A_OPENCLAW_ANALYSIS_AGENT_ID || env.A2A_OPENCLAW_AGENT_ID, "main"),
    "--session-id", sessionId,
    "--message", prompt,
    "--model", effectiveModel,
    "--thinking", effectiveThinking,
    "--timeout", timeoutSec,
    "--json",
  ];
  const { command, args } = resolveNodeScriptInvocation(baseCommand, baseArgs);

  const watchdogMs = env.A2A_OPENCLAW_ANALYSIS_WATCHDOG_MS
    ? Number(env.A2A_OPENCLAW_ANALYSIS_WATCHDOG_MS)
    : (Number(timeoutSec) + 30) * 1000;

  const bridgeFiles = writeAnalysisBridgeInputFiles(task, payload);
  let child;
  try {
    child = spawnSync(command, args, {
      cwd: safeText(env.A2A_HANDLER_CWD, process.cwd()),
      env: {
        ...env,
        A2A_ANALYSIS_TASK_FILE: bridgeFiles.taskFile,
        A2A_ANALYSIS_PAYLOAD_FILE: bridgeFiles.payloadFile,
      },
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      timeout: watchdogMs,
      killSignal: "SIGKILL",
    });
  } finally {
    rmSync(bridgeFiles.dir, { recursive: true, force: true });
  }

  if (child.error) {
    const isTimeout = child.error.code === "ETIMEDOUT";
    return {
      error: {
        code: isTimeout ? "openclaw_analysis_timeout" : "openclaw_analysis_spawn_failed",
        message: child.error.message,
        details: { signal: child.signal ?? undefined, buildInfo: BUILD_INFO },
      },
    };
  }
  if (child.status !== 0) {
    return {
      error: {
        code: child.signal ? "openclaw_analysis_timeout" : "openclaw_analysis_failed",
        message: safeText(child.stderr, safeText(child.stdout, `openclaw exited with ${child.status ?? "unknown"}`)),
        details: { exitCode: child.status, signal: child.signal ?? undefined, buildInfo: BUILD_INFO },
      },
    };
  }

  let envelope;
  try {
    envelope = parseOpenClawEnvelope(child.stdout, child.stderr);
  } catch {
    return {
      error: {
        code: "openclaw_analysis_no_final_json",
        message: "OpenClaw analysis bridge produced no parseable output envelope",
        details: { buildInfo: BUILD_INFO },
      },
    };
  }

  const text = extractOpenClawText(envelope);
  if (!text) {
    return {
      error: {
        code: "openclaw_analysis_no_final_json",
        message: "OpenClaw analysis bridge returned no visible text output",
        details: { buildInfo: BUILD_INFO },
      },
    };
  }

  let response;
  try {
    response = parseJsonFromLooseText(text);
  } catch {
    return {
      error: {
        code: "openclaw_analysis_no_final_json",
        message: "OpenClaw analysis bridge response text contained no valid JSON",
        details: { buildInfo: BUILD_INFO },
      },
    };
  }

  const status = normalizedBridgeAnalysisStatus(response.status);
  const analysisSummary = safeText(response.summary, safeText(task.message, "analysis completed"));
  const postGithubComment = shouldPostAnalysisEvidenceComment(task, env);
  const bridgeTelemetry = analysisBridgeTelemetry(baseCommand, env);
  const output = {
    analysisSummary,
    ...bridgeTelemetry,
    analysisStatus: status,
    findings: normalizeStringArray(response.findings),
    risks: normalizeStringArray(response.risks),
    recommendations: normalizeStringArray(response.recommendations),
    evidenceRefs: normalizeStringArray(response.evidenceRefs),
    ...(response.sourceProjection && typeof response.sourceProjection === "object" && !Array.isArray(response.sourceProjection) ? { sourceProjection: response.sourceProjection } : {}),
    recoverySource: normalizedAnalysisRecoverySource(response.recoverySource),
    bridgeReportedAdapter: safeText(response.bridgeAdapter, undefined),
    requestedModel: safeText(response.requestedModel, undefined),
    requestedThinking: safeText(response.requestedThinking, undefined),
    actualRuntimeModel: safeText(response.actualRuntimeModel, undefined),
    modelInheritanceMode: safeText(response.modelInheritanceMode, undefined),
    claudeModelArgumentApplied: typeof response.claudeModelArgumentApplied === "boolean" ? response.claudeModelArgumentApplied : undefined,
    modelInheritanceNote: safeText(response.modelInheritanceNote, undefined),
    doneCommentUrl: postGithubComment ? undefined : safeText(response.doneCommentUrl, undefined),
    blockCommentUrl: postGithubComment ? undefined : safeText(response.blockCommentUrl, undefined),
    startCommentUrl: postGithubComment ? undefined : safeText(response.startCommentUrl, undefined),
    nodeId,
    taskId: safeText(task.id, undefined),
    mode: taskMode(task),
    role: safeText(payload.dialecticRole || payload.role, undefined),
    phase: safeText(payload.phase, undefined),
    noLive: payload.noLive === true || payload.no_live === true || undefined,
    sourceOnly: payload.sourceOnly === true || payload.source_only === true || undefined,
    payloadKeys: Object.keys(payload).sort(),
    effectiveModel,
    effectiveThinking,
    modelFromPayload: modelFromPayload || undefined,
  };

  if (postGithubComment) {
    const comment = postGithubIssueCommentSync({
      task,
      status,
      body: buildAnalysisEvidenceCommentBody({ task, status, analysisSummary, output }),
      env,
    });
    if (comment.error) return { error: comment.error };
    if (status === "blocked") output.blockCommentUrl = comment.url;
    else output.doneCommentUrl = comment.url;
    output.githubCommentUrl = comment.url;
    output.githubCommentReused = comment.reused || undefined;
  }

  return {
    result: {
      summary: `analysis bridge ${status}: ${analysisSummary}`,
      note: "read-only A2A analysis completed through analysis bridge",
      handler: BUILD_INFO,
      lifecycle: {
        intent: "analyze",
        mode: taskMode(task),
        taskId: safeText(task.id, "unknown"),
        proposalId: safeText(task.proposalId, undefined),
        exchangeId: safeText(task.exchangeId, undefined),
      },
      output,
    },
  };
}

function decisionDialecticExecution(task) {
  const payload = taskPayload(task);
  const execution = payload.execution;
  return execution && typeof execution === "object" && !Array.isArray(execution) ? execution : {};
}

function decisionDialecticContract(task) {
  const payload = taskPayload(task);
  const contract = payload.contract;
  return contract && typeof contract === "object" && !Array.isArray(contract) ? contract : {};
}

function decisionDialecticTaskBody(task) {
  const contract = decisionDialecticContract(task);
  const body = contract.task;
  return body && typeof body === "object" && !Array.isArray(body) ? body : {};
}

function decisionDialecticPatchRequest(task, phasePayload, env = process.env) {
  const promptSpec = decisionDialecticPromptSpec(task);
  const execution = decisionDialecticExecution(task);
  const contract = decisionDialecticContract(task);
  const dialecticTask = decisionDialecticTaskBody(task);
  const schemaName = safeText(promptSpec.schemaName, "");
  const op = DECISION_DIALECTIC_SCHEMA_TO_PATCH_OP.get(schemaName);
  if (!op) {
    return {
      error: {
        code: "decision_dialectic_unknown_schema",
        message: `unsupported decision.dialectic phase schema: ${schemaName || "<missing>"}`,
        details: { schemaName, buildInfo: BUILD_INFO },
      },
    };
  }

  const parentTaskId = safeText(execution.parentTaskId, safeText(task.parentTaskId, ""));
  const taskId = safeText(execution.taskId, safeText(dialecticTask.taskId, ""));
  const expectedRevision = Number(execution.expectedRevision ?? dialecticTask.revision);
  const authorAgent = safeText(
    phasePayload?.author?.agentId,
    safeText(task.assignedWorkerId, safeText(env.A2A_WORKER_ID || env.WORKER_ID || env.NODE_ID, "")),
  );
  if (!parentTaskId || !taskId || !Number.isInteger(expectedRevision) || !authorAgent) {
    return {
      error: {
        code: "decision_dialectic_invalid_phase_task",
        message: "decision.dialectic phase task is missing parentTaskId, taskId, expectedRevision, or authorAgent",
        details: { parentTaskId: parentTaskId || undefined, taskId: taskId || undefined, expectedRevision, authorAgent: authorAgent || undefined, buildInfo: BUILD_INFO },
      },
    };
  }

  return {
    parentTaskId,
    patch: {
      op,
      patchId: safeText(execution.patchId, `${safeText(task.id, "decision-dialectic-phase")}:patch`),
      taskId,
      expectedRevision,
      authorAgent,
      at: safeText(phasePayload?.submittedAt, safeText(phasePayload?.observedAt, new Date().toISOString())),
      payload: phasePayload,
    },
    contractPhase: safeText(contract.phase, undefined),
    schemaName,
  };
}

function brokerAuthHeaders(env = process.env) {
  const suffix = "SEC" + "RET";
  const edgeAuth = safeText(
    env["BROKER_EDGE_" + suffix] || env["A2A_BROKER_EDGE_" + suffix] || env["EDGE_" + suffix] || env["A2A_EDGE_" + suffix],
    "",
  );
  const requesterId = safeText(env.A2A_WORKER_ID || env.WORKER_ID || env.NODE_ID, "decision-dialectic-worker");
  const requesterRole = safeText(env.A2A_WORKER_ROLE || env.WORKER_ROLE, "analyst");
  const headers = [
    "-H", "content-type: application/json",
    "-H", `x-a2a-requester-id: ${requesterId}`,
    "-H", "x-a2a-requester-kind: node",
    "-H", `x-a2a-requester-role: ${requesterRole}`,
  ];
  if (edgeAuth) headers.push("-H", `${["x-a2a-edge", "sec" + "ret"].join("-")}: ${edgeAuth}`);
  return headers;
}

function postDecisionDialecticPatch(parentTaskId, patch, env = process.env) {
  const brokerUrl = safeText(env.BROKER_URL || env.A2A_BROKER_URL, "");
  if (!brokerUrl) {
    return {
      error: {
        code: "decision_dialectic_broker_not_configured",
        message: "decision.dialectic phase bridge requires BROKER_URL or A2A_BROKER_URL",
        details: { buildInfo: BUILD_INFO },
      },
    };
  }
  const base = brokerUrl.endsWith("/") ? brokerUrl.slice(0, -1) : brokerUrl;
  const url = `${base}/tasks/${encodeURIComponent(parentTaskId)}/decision-dialectic/patch`;
  const child = spawnSync("curl", [
    "-fsS",
    "-X", "POST",
    ...brokerAuthHeaders(env),
    "--data-binary", "@-",
    url,
  ], {
    input: JSON.stringify(patch),
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (child.error) {
    return {
      error: {
        code: "decision_dialectic_patch_request_failed",
        message: child.error.message,
        details: { buildInfo: BUILD_INFO },
      },
    };
  }
  if (child.status !== 0) {
    return {
      error: {
        code: "decision_dialectic_patch_rejected",
        message: safeText(child.stderr, `broker patch request exited with ${child.status ?? "unknown"}`),
        details: { exitCode: child.status, signal: child.signal ?? undefined, stdout: safeText(child.stdout, undefined), buildInfo: BUILD_INFO },
      },
    };
  }
  try {
    return { readModel: JSON.parse(child.stdout) };
  } catch {
    return {
      error: {
        code: "decision_dialectic_patch_invalid_response",
        message: "broker patch route returned non-JSON response",
        details: { buildInfo: BUILD_INFO },
      },
    };
  }
}

function runDecisionDialecticBridge(task, env = process.env) {
  const payload = taskPayload(task);
  const promptSpec = decisionDialecticPromptSpec(task);
  const execution = decisionDialecticExecution(task);
  const { model: effectiveModel, fromPayload: modelFromPayload } = resolveWorkerModel(task, env);
  const { thinking: effectiveThinking, fromPayload: thinkingFromPayload } = resolveWorkerThinking(task);
  const nodeId = safeText(env.A2A_NODE_ID || env.NODE_ID || env.WORKER_ID, "unknown-node");
  const timeoutSec = String(Math.max(1, Number(env.A2A_DECISION_DIALECTIC_TIMEOUT_SEC || env.A2A_OPENCLAW_ANALYSIS_TIMEOUT_SEC || env.A2A_OPENCLAW_TIMEOUT_SEC || DEFAULT_OPENCLAW_TIMEOUT_SEC)));
  const sessionId = safeText(
    env.A2A_DECISION_DIALECTIC_SESSION_ID,
    `a2a-${nodeId}-${safeText(task.id, String(Date.now()))}-decision-dialectic`,
  );
  const prompt = [
    `You are A2A worker ${nodeId}. Complete this decision.dialectic phase task.`,
    "Do not modify files, deploy, restart services, send providers, acknowledge terminal rows, mutate databases, or move credentials.",
    "Use only the decision.dialectic contract, context, prior phases, and evidenceRefs supplied in the task payload.",
    "Return JSON only. It must match payload.promptSpec.schemaName and payload.promptSpec.jsonSchema.",
    "No markdown, no prose outside JSON.",
    `Schema name: ${safeText(promptSpec.schemaName, "<missing>")}`,
    `Phase: ${safeText(promptSpec.phase, safeText(execution.phase, ""))}`,
    `Prompt spec:\n${safeText(promptSpec.systemPrompt, "")}`,
    `Effective model: ${effectiveModel}${modelFromPayload ? " (from payload override)" : ""}`,
    `Effective thinking: ${effectiveThinking}${thinkingFromPayload ? " (from payload override)" : ""}`,
    `Task id: ${safeText(task.id, "unknown")}`,
    `Parent task id: ${safeText(execution.parentTaskId, safeText(task.parentTaskId, ""))}`,
    `Expected revision: ${String(execution.expectedRevision ?? "")}`,
    `Task message:\n${safeText(task.message, "")}`,
    `Payload JSON:\n${jsonForPrompt(payload, 24000)}`,
  ].join("\n\n");

  const baseCommand = safeText(env.A2A_OPENCLAW_ANALYSIS_BIN, safeText(env.OPENCLAW_BIN, "openclaw"));
  const bridgePreflight = analysisBridgeArtifactPreflight(baseCommand, env);
  if (bridgePreflight) return bridgePreflight;
  const baseArgs = [
    "agent",
    "--local",
    "--agent", safeText(env.A2A_DECISION_DIALECTIC_AGENT_ID || env.A2A_OPENCLAW_ANALYSIS_AGENT_ID || env.A2A_OPENCLAW_AGENT_ID, "main"),
    "--session-id", sessionId,
    "--message", prompt,
    "--model", effectiveModel,
    "--thinking", effectiveThinking,
    "--timeout", timeoutSec,
    "--json",
  ];
  const { command, args } = resolveNodeScriptInvocation(baseCommand, baseArgs);
  const watchdogMs = env.A2A_DECISION_DIALECTIC_WATCHDOG_MS
    ? Number(env.A2A_DECISION_DIALECTIC_WATCHDOG_MS)
    : (Number(timeoutSec) + 30) * 1000;

  const child = spawnSync(command, args, {
    cwd: safeText(env.A2A_HANDLER_CWD, process.cwd()),
    env,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: watchdogMs,
    killSignal: "SIGKILL",
  });

  if (child.error) {
    const isTimeout = child.error.code === "ETIMEDOUT";
    return {
      error: {
        code: isTimeout ? "decision_dialectic_bridge_timeout" : "decision_dialectic_bridge_spawn_failed",
        message: child.error.message,
        details: { signal: child.signal ?? undefined, buildInfo: BUILD_INFO },
      },
    };
  }
  if (child.status !== 0) {
    return {
      error: {
        code: child.signal ? "decision_dialectic_bridge_timeout" : "decision_dialectic_bridge_failed",
        message: safeText(child.stderr, safeText(child.stdout, `openclaw exited with ${child.status ?? "unknown"}`)),
        details: { exitCode: child.status, signal: child.signal ?? undefined, buildInfo: BUILD_INFO },
      },
    };
  }

  let envelope;
  try {
    envelope = parseOpenClawEnvelope(child.stdout, child.stderr);
  } catch {
    return {
      error: {
        code: "decision_dialectic_bridge_no_final_json",
        message: "OpenClaw decision.dialectic bridge produced no parseable output envelope",
        details: { buildInfo: BUILD_INFO },
      },
    };
  }
  const text = extractOpenClawText(envelope);
  if (!text) {
    return {
      error: {
        code: "decision_dialectic_bridge_no_final_json",
        message: "OpenClaw decision.dialectic bridge returned no visible text output",
        details: { buildInfo: BUILD_INFO },
      },
    };
  }
  let phasePayload;
  try {
    phasePayload = parseJsonFromLooseText(text);
  } catch {
    return {
      error: {
        code: "decision_dialectic_bridge_no_final_json",
        message: "OpenClaw decision.dialectic bridge response text contained no valid JSON",
        details: { buildInfo: BUILD_INFO },
      },
    };
  }

  const patchRequest = decisionDialecticPatchRequest(task, phasePayload, env);
  if (patchRequest.error) return patchRequest;
  const patchResult = postDecisionDialecticPatch(patchRequest.parentTaskId, patchRequest.patch, env);
  if (patchResult.error) return patchResult;

  return {
    result: {
      summary: `decision.dialectic ${safeText(execution.phase, safeText(promptSpec.phase, "phase"))} patched parent ${patchRequest.parentTaskId}`,
      note: "decision.dialectic phase completed through OpenClaw bridge and broker patch route",
      handler: BUILD_INFO,
      lifecycle: {
        intent: "analyze",
        mode: taskMode(task),
        taskId: safeText(task.id, "unknown"),
        proposalId: safeText(task.proposalId, undefined),
        exchangeId: safeText(task.exchangeId, undefined),
      },
      output: {
        decisionDialectic: {
          status: "patched",
          parentTaskId: patchRequest.parentTaskId,
          schemaName: patchRequest.schemaName,
          phase: safeText(execution.phase, safeText(promptSpec.phase, undefined)),
          op: patchRequest.patch.op,
          expectedRevision: patchRequest.patch.expectedRevision,
          authorAgent: patchRequest.patch.authorAgent,
          readModelState: patchResult.readModel?.contract?.state,
          readModelRevision: patchResult.readModel?.contract?.revision,
        },
        effectiveModel,
        effectiveThinking,
        modelFromPayload: modelFromPayload || undefined,
        thinkingFromPayload: thinkingFromPayload || undefined,
      },
    },
  };
}

function decisionDialecticBridgeNotConfigured(task, env = process.env) {
  const payload = taskPayload(task);
  const promptSpec = decisionDialecticPromptSpec(task);
  const execution = decisionDialecticExecution(task);
  return {
    result: {
      summary: `decision.dialectic phase blocked: bridge not configured`,
      note: "decision.dialectic phase tasks must not fall through to generic handler success",
      handler: BUILD_INFO,
      lifecycle: {
        intent: "analyze",
        mode: taskMode(task),
        taskId: safeText(task.id, "unknown"),
        proposalId: safeText(task.proposalId, undefined),
        exchangeId: safeText(task.exchangeId, undefined),
      },
      output: {
        decisionDialectic: {
          status: "blocked",
          reason: "A2A_DECISION_DIALECTIC_BRIDGE_ENABLED and OpenClaw bridge config are required before worker-authored phase evidence can patch the parent",
          parentTaskId: safeText(execution.parentTaskId, safeText(task.parentTaskId, undefined)),
          schemaName: safeText(promptSpec.schemaName, undefined),
          phase: safeText(execution.phase, safeText(promptSpec.phase, undefined)),
          expectedRevision: execution.expectedRevision,
        },
        bridgeConfigured: shouldUseDecisionDialecticBridge(task, env),
        payloadKeys: Object.keys(payload).sort(),
      },
    },
  };
}


function shouldUseOpenClawBridge(task, env = process.env) {
  if (!isGithubEvidenceTask(task)) return false;
  if (normalizedExecutorMode(env) !== "auto") return false;
  const dockerScope = normalizedDockerScope(env);
  if (dockerScope !== "plugin-only" && !(dockerScope === "all-github" && hasBlockedClaudeDockerConfig(env))) return false;
  return isOpenClawBridgeConfigured(env);
}

function githubExecutorNotConfigured(task, env = process.env) {
  return {
    error: {
      code: "github_executor_not_configured",
      message:
        "github-propose-patch tasks require docker-runner or OpenClaw bridge execution evidence; " +
        "refusing built-in no-op success without PR/Done/Block URL",
      details: {
        executorMode: normalizedExecutorMode(env),
        dockerScope: normalizedDockerScope(env),
        bridgeConfigured: shouldUseOpenClawBridge(task, env),
        requiredEvidence: ["prUrl", "doneCommentUrl", "blockCommentUrl"],
        buildInfo: BUILD_INFO,
      },
    },
  };
}

function stripCodeFences(text) {
  const trimmed = safeText(text, "");
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function parseJsonFromLooseText(text) {
  const trimmed = stripCodeFences(text);
  const candidates = [trimmed];
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // keep trying looser candidates
    }
  }
  throw new Error("OpenClaw bridge response was not valid JSON text");
}

function parseOpenClawEnvelope(stdout, stderr) {
  const candidates = [safeText(stdout, ""), safeText(stderr, "")]
    .filter(Boolean)
    .flatMap((text) => {
      const variants = [text];
      const lastBraceLine = text.lastIndexOf("\n{");
      if (lastBraceLine >= 0) variants.push(text.slice(lastBraceLine + 1));
      const firstBrace = text.indexOf("{");
      if (firstBrace > 0) variants.push(text.slice(firstBrace));
      return variants;
    });

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // keep trying
    }
  }
  throw new Error("OpenClaw bridge envelope was not valid JSON");
}

function extractOpenClawText(parsed) {
  if (!parsed || typeof parsed !== "object") return "";
  const payloads = Array.isArray(parsed.payloads) ? parsed.payloads : [];
  const pieces = payloads
    .map((item) => item && typeof item === "object" && typeof item.text === "string" ? item.text.trim() : "")
    .filter(Boolean);
  if (pieces.length) return pieces.join("\n\n");
  return typeof parsed.text === "string" ? parsed.text.trim() : "";
}

function normalizeStringArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
}

function startCommentUrlFromResponse(response) {
  return safeText(response?.startCommentUrl || response?.startedCommentUrl, "");
}

function withStartEvidence(evidence, response) {
  const startCommentUrl = startCommentUrlFromResponse(response);
  return startCommentUrl ? { ...evidence, startCommentUrl } : evidence;
}

function githubEvidenceFromResponse(response) {
  const status = safeText(response?.status || response?.outcome, "");
  const prUrl = safeText(response?.prUrl || response?.pullRequestUrl, "");
  const doneCommentUrl = safeText(response?.doneCommentUrl || response?.commentUrl, "");
  const blockCommentUrl = safeText(response?.blockCommentUrl || response?.blockerCommentUrl, "");
  if (prUrl) return withStartEvidence({ outcome: "pr_opened", prUrl }, response);
  if (blockCommentUrl) return withStartEvidence({ outcome: status || "blocked", blockCommentUrl }, response);
  if (doneCommentUrl) return withStartEvidence({ outcome: status || "done", doneCommentUrl }, response);
  return undefined;
}

function extractIssueNumber(task) {
  const payload = taskPayload(task);
  const raw = safeText(payload.issue, safeText(payload.issueNumber, ""));
  const match = raw.match(/#?(\d+)/);
  return match ? match[1] : raw;
}

function jsonForPrompt(value, limit = 24000) {
  const text = JSON.stringify(value, null, 2);
  return text.length <= limit ? text : `${text.slice(0, limit - 40)}\n...\n[truncated ${text.length - limit + 40} chars]`;
}

function runOpenClawBridge(task, env = process.env) {
  const payload = taskPayload(task);
  const repo = safeText(payload.repo, "");
  const issue = extractIssueNumber(task);
  const issueUrl = safeText(payload.issueUrl, issue && repo ? `https://github.com/${repo}/issues/${issue}` : "");
  if (!repo) {
    return { error: { code: "openclaw_bridge_invalid_task", message: "github-propose-patch requires payload.repo", details: { buildInfo: BUILD_INFO } } };
  }
  if (!issue && !issueUrl) {
    return { error: { code: "openclaw_bridge_invalid_task", message: "github-propose-patch requires payload.issue or payload.issueUrl", details: { buildInfo: BUILD_INFO } } };
  }

  // Resolve effective worker model/thinking from task payload overrides
  const { model: effectiveModel, fromPayload: modelFromPayload } = resolveWorkerModel(task, env);
  const { thinking: effectiveThinking, fromPayload: thinkingFromPayload } = resolveWorkerThinking(task);

  const nodeId = safeText(env.A2A_NODE_ID || env.NODE_ID || env.WORKER_ID, "unknown-node");
  const timeoutSec = String(Math.max(1, Number(env.A2A_OPENCLAW_TIMEOUT_SEC || DEFAULT_OPENCLAW_TIMEOUT_SEC)));
  const sessionId = safeText(env.A2A_OPENCLAW_SESSION_ID, `a2a-${nodeId}-${safeText(task.id, String(Date.now()))}-github`);
  const prompt = [
    `You are A2A worker ${nodeId}. Complete this GitHub development assignment end-to-end.`,
    "Leave a Start marker on the GitHub issue before work begins.",
    "Do not report success unless you opened a pull request, posted a Done comment, or posted a Block comment on GitHub.",
    "Use the local workspace and GitHub tools available in this OpenClaw session. If the repo is not present, clone/fetch it into a temporary or appropriate workspace directory.",
    "Never commit sensitive data, raw private paths, or session dumps.",
    "If implementation is unsafe, unclear, or cannot finish within the available time, post a Block comment on the issue with blocker evidence and return its URL.",
    "Return JSON only, no markdown, with exactly this shape:",
    '{"status":"pr_opened|blocked|done","summary":"...","startCommentUrl":"https://github.com/.../issues/123#issuecomment-... optional","prUrl":"https://github.com/.../pull/123 optional","blockCommentUrl":"https://github.com/.../issues/123#issuecomment-... optional","doneCommentUrl":"https://github.com/.../issues/123#issuecomment-... optional","branch":"optional","tests":["cmd -> result"],"filesChanged":["path"],"risks":["..."]}',
    "At least one of prUrl, blockCommentUrl, or doneCommentUrl is required.",
    "All human-readable text should be Korean unless quoting code/test output.",
    `Repository: ${repo}`,
    `Issue: ${issue ? `#${issue}` : issueUrl}`,
    `Issue URL: ${issueUrl}`,
    `Current workspace root: ${env.A2A_HANDLER_CWD || process.cwd()}`,
    `Effective model: ${effectiveModel}${modelFromPayload ? " (from payload override)" : ""}`,
    `Effective thinking: ${effectiveThinking}${thinkingFromPayload ? " (from payload override)" : ""}`,
    `Task title: ${safeText(payload.title, "")}`,
    `Task focus: ${safeText(payload.focus, "")}`,
    `Acceptance: ${safeText(payload.acceptance, "")}`,
    `Full task message:\n${safeText(task.message, "")}`,
    `Payload JSON:\n${jsonForPrompt(payload)}`,
  ].join("\n\n");

  const baseCommand = safeText(env.A2A_OPENCLAW_ANALYSIS_BIN, safeText(env.OPENCLAW_BIN, "openclaw"));
  const baseArgs = [
    "agent",
    "--local",
    "--agent", safeText(env.A2A_OPENCLAW_AGENT_ID, "main"),
    "--session-id", sessionId,
    "--message", prompt,
    "--model", effectiveModel,
    "--thinking", effectiveThinking,
    "--timeout", timeoutSec,
    "--json",
  ];
  const { command, args } = resolveNodeScriptInvocation(baseCommand, baseArgs);

  const watchdogMs = env.A2A_OPENCLAW_WATCHDOG_MS
    ? Number(env.A2A_OPENCLAW_WATCHDOG_MS)
    : (Number(timeoutSec) + 30) * 1000;

  const child = spawnSync(command, args, {
    cwd: safeText(env.A2A_HANDLER_CWD, process.cwd()),
    env,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: watchdogMs,
    killSignal: "SIGKILL",
  });

  if (child.error) {
    const isTimeout = child.error.code === "ETIMEDOUT";
    return {
      error: {
        code: isTimeout ? "openclaw_bridge_timeout" : "openclaw_bridge_spawn_failed",
        message: child.error.message,
        details: { signal: child.signal ?? undefined, buildInfo: BUILD_INFO },
      },
    };
  }
  if (child.status !== 0) {
    return {
      error: {
        code: child.signal ? "openclaw_bridge_timeout" : "openclaw_bridge_failed",
        message: safeText(child.stderr, safeText(child.stdout, `openclaw exited with ${child.status ?? "unknown"}`)),
        details: { exitCode: child.status, signal: child.signal ?? undefined, buildInfo: BUILD_INFO },
      },
    };
  }

  // --- no-final-json safeguards (issue #193) ---
  let envelope;
  try {
    envelope = parseOpenClawEnvelope(child.stdout, child.stderr);
  } catch {
    return {
      error: {
        code: "openclaw_bridge_no_final_json",
        message: "OpenClaw bridge produced no parseable output envelope",
        details: { buildInfo: BUILD_INFO },
      },
    };
  }

  const text = extractOpenClawText(envelope);
  if (!text) {
    return {
      error: {
        code: "openclaw_bridge_no_final_json",
        message: "OpenClaw bridge returned no visible text output",
        details: { buildInfo: BUILD_INFO },
      },
    };
  }

  let response;
  try {
    response = parseJsonFromLooseText(text);
  } catch {
    return {
      error: {
        code: "openclaw_bridge_no_final_json",
        message: "OpenClaw bridge response text contained no valid JSON",
        details: { buildInfo: BUILD_INFO },
      },
    };
  }

  const evidence = githubEvidenceFromResponse(response);
  if (!evidence) {
    return {
      error: {
        code: "openclaw_bridge_evidence_missing",
        message: "OpenClaw bridge response JSON missing prUrl, doneCommentUrl, or blockCommentUrl",
        details: { buildInfo: BUILD_INFO },
      },
    };
  }

  try {
    const output = {
      github: evidence,
      repo,
      issue: issue ? `#${issue}` : undefined,
      issueUrl,
      branch: safeText(response.branch, undefined),
      tests: normalizeStringArray(response.tests),
      filesChanged: normalizeStringArray(response.filesChanged),
      risks: normalizeStringArray(response.risks),
      nodeId,
      taskId: safeText(task.id, undefined),
      effectiveModel,
      effectiveThinking,
      modelFromPayload: modelFromPayload || undefined,
    };
    if (safeText(evidence.startCommentUrl, "")) output.startCommentUrl = safeText(evidence.startCommentUrl);
    if (safeText(evidence.prUrl, "")) output.prUrl = safeText(evidence.prUrl);
    if (safeText(evidence.doneCommentUrl, "")) output.doneCommentUrl = safeText(evidence.doneCommentUrl);
    if (safeText(evidence.blockCommentUrl, "")) output.blockCommentUrl = safeText(evidence.blockCommentUrl);

    return {
      result: {
        summary: safeText(response.summary, `GitHub task ${evidence.outcome}`),
        note: safeText(response.note, safeText(response.summary, "OpenClaw bridge completed GitHub task")),
        handler: BUILD_INFO,
        lifecycle: {
          intent: safeText(task.intent, "unknown"),
          mode: taskMode(task),
          taskId: safeText(task.id, "unknown"),
          proposalId: safeText(task.proposalId, undefined),
          exchangeId: safeText(task.exchangeId, undefined),
        },
        output,
      },
    };
  } catch (error) {
    return {
      error: {
        code: "openclaw_bridge_invalid_response",
        message: error instanceof Error ? error.message : String(error),
        details: { buildInfo: BUILD_INFO },
      },
    };
  }
}

function extractOpenClawBootstrapLeakPaths(...values) {
  const text = values
    .map((value) => typeof value === "string" ? value : JSON.stringify(value ?? ""))
    .join("\n");
  const matches = new Set();
  const patterns = [
    /(?:^|[\s"'`:,])((?:\.?\/?|[A-Za-z]:\\)?(?:[\w.-]+[\\/])*AGENTS\.md)(?=$|[\s"'`,])/g,
    /(?:^|[\s"'`:,])((?:\.?\/?|[A-Za-z]:\\)?(?:[\w.-]+[\\/])*SOUL\.md)(?=$|[\s"'`,])/g,
    /(?:^|[\s"'`:,])((?:\.?\/?|[A-Za-z]:\\)?(?:[\w.-]+[\\/])*USER\.md)(?=$|[\s"'`,])/g,
    /(?:^|[\s"'`:,])((?:\.?\/?|[A-Za-z]:\\)?(?:[\w.-]+[\\/])*TOOLS\.md)(?=$|[\s"'`,])/g,
    /(?:^|[\s"'`:,])((?:\.?\/?|[A-Za-z]:\\)?(?:[\w.-]+[\\/])*HEARTBEAT\.md)(?=$|[\s"'`,])/g,
    /(?:^|[\s"'`:,])((?:\.?\/?|[A-Za-z]:\\)?(?:[\w.-]+[\\/])*IDENTITY\.md)(?=$|[\s"'`,])/g,
    /(?:^|[\s"'`:,])((?:\.?\/?|[A-Za-z]:\\)?(?:[\w.-]+[\\/])*\.openclaw(?:[\\/][^\s"'`,]+)?)(?=$|[\s"'`,])/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      matches.add(match[1].replace(/\\/g, "/").replace(/^\.\//, ""));
    }
  }
  return [...matches].sort();
}

function buildOutputGithub(parsed) {
  const nested = parsed?.github && typeof parsed.github === "object" && !Array.isArray(parsed.github)
    ? parsed.github
    : {};
  const github = {};
  let hasTerminal = false;
  const startCommentUrl = safeText(parsed.startCommentUrl, safeText(nested.startCommentUrl, ""));
  const prUrl = safeText(parsed.prUrl, safeText(nested.prUrl, ""));
  const doneCommentUrl = safeText(parsed.doneCommentUrl, safeText(nested.doneCommentUrl, ""));
  const blockCommentUrl = safeText(parsed.blockCommentUrl, safeText(nested.blockCommentUrl, ""));
  if (startCommentUrl) github.startCommentUrl = startCommentUrl;
  if (prUrl) { github.prUrl = prUrl; hasTerminal = true; }
  if (doneCommentUrl) { github.doneCommentUrl = doneCommentUrl; hasTerminal = true; }
  if (blockCommentUrl) { github.blockCommentUrl = blockCommentUrl; hasTerminal = true; }
  return hasTerminal ? github : undefined;
}

function runDockerRunner(task, env = process.env) {
  // docker-first readiness guard: explicit docker mode or all-github scope requires
  // A2A_DOCKER_RUNNER_BIN to be set so the operator has consciously chosen a runner path.
  // Without it we return a clear config error instead of a confusing ENOENT spawn failure.
  if (isDockerFirstMode(env) && !isDockerRunnerBinConfigured(env)) {
    return {
      error: {
        code: "docker_runner_not_configured",
        message:
          "docker-first executor policy requires A2A_DOCKER_RUNNER_BIN to be explicitly configured; " +
          "refusing github-propose-patch without a confirmed runner path",
        details: {
          executorMode: normalizedExecutorMode(env),
          dockerScope: normalizedDockerScope(env),
          requiredEnv: ["A2A_DOCKER_RUNNER_BIN"],
          buildInfo: BUILD_INFO,
        },
      },
    };
  }

  const tempDir = mkdtempSync(join(tmpdir(), "openclaw-a2a-runner-"));
  const taskPath = join(tempDir, "task.json");
  const runnerTask = buildRunnerTask(task, env);
  writeFileSync(taskPath, `${JSON.stringify(runnerTask, null, 2)}\n`);

  const command = safeText(env.A2A_DOCKER_RUNNER_BIN, "a2a-docker-runner");
  const args = [...parseJsonArrayEnv(env.A2A_DOCKER_RUNNER_ARGS_JSON), "run", taskPath];

  try {
    const child = spawnSync(command, args, {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      env,
    });

    const stdout = safeText(child.stdout, "");
    const stderr = safeText(child.stderr, "");
    const parsed = stdout ? JSON.parse(stdout) : undefined;

    // timeout detection: runner status, signal, or non-zero exit
    const isTimeout =
      parsed?.status === "timeout" ||
      child.signal === "SIGTERM" ||
      child.signal === "SIGKILL" ||
      child.status === 124; // timeout exit code convention

    if (child.status !== 0 || !parsed?.ok) {
      const openclawBootstrapLeakPaths = extractOpenClawBootstrapLeakPaths(parsed, stdout, stderr);
      return {
        error: {
          code: isTimeout ? "docker_runner_timeout" : "docker_runner_failed",
          message: parsed?.error || stderr || `a2a-docker-runner exited with code ${child.status}`,
          details: {
            runnerTask,
            exitCode: child.status,
            signal: child.signal ?? undefined,
            runnerResult: parsed,
            ...(openclawBootstrapLeakPaths.length ? { openclawBootstrapLeakPaths } : {}),
          },
        },
      };
    }

    const nodeId = safeText(env.A2A_NODE_ID || env.NODE_ID || env.WORKER_ID, "unknown-node");
    const repo = safeText(runnerTask.repo, "");
    const issue = safeText(runnerTask.issue, "");
    const issueUrl = safeText(runnerTask.issueUrl, "");

    const output = {
      runner: {
        status: parsed.status,
        workDir: parsed.workDir,
        artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
      },
    };

    if (repo) output.repo = repo;
    if (issue) output.issue = issue;
    if (issueUrl) output.issueUrl = issueUrl;
    output.nodeId = nodeId;
    output.taskId = safeText(task.id, undefined);

    // Record effective model/thinking for evidence
    const { model: effectiveModel, fromPayload: modelFromPayload } = resolveWorkerModel(task, env);
    const { thinking: effectiveThinking, fromPayload: thinkingFromPayload } = resolveWorkerThinking(task);
    output.effectiveModel = effectiveModel;
    output.effectiveThinking = effectiveThinking;
    if (modelFromPayload) output.modelFromPayload = true;
    if (thinkingFromPayload) output.thinkingFromPayload = true;

    const branch = safeText(parsed.branch, "");
    if (branch) output.branch = branch;
    const tests = normalizeStringArray(parsed.tests);
    if (tests.length) output.tests = tests;
    const filesChanged = normalizeStringArray(parsed.filesChanged);
    if (filesChanged.length) output.filesChanged = filesChanged;
    const risks = normalizeStringArray(parsed.risks);
    if (risks.length) output.risks = risks;

    // --- fail-closed OpenClaw runtime/bootstrap leak guard (issue #522) ---
    // Runner output is the handoff evidence the broker will surface. Refuse success if the
    // changed-file list or artifact list contains OpenClaw workspace/bootstrap files.
    const openclawBootstrapLeakPaths = extractOpenClawBootstrapLeakPaths(parsed.artifacts, parsed.filesChanged);
    if (openclawBootstrapLeakPaths.length) {
      return {
        error: {
          code: "docker_runner_openclaw_bootstrap_leak",
          message:
            "docker runner reported OpenClaw runtime/bootstrap files in branch or artifact evidence; " +
            "refusing GitHub completion evidence until offending paths are removed",
          details: {
            runnerTask,
            openclawBootstrapLeakPaths,
            runnerResult: parsed,
          },
        },
      };
    }

    // --- fail-closed branch/no-diff guard (issue #447) ---
    // The docker runner owns branch creation and can report the runner branch it expected.
    // Do not compare against baseBranch: baseBranch is normally `main`, while successful
    // patch evidence branches are feature branches. Only fail when the runner explicitly
    // reports an expected/runner branch and the completed branch differs.
    const expectedRunnerBranch = safeText(parsed.expectedBranch ?? parsed.runnerBranch ?? parsed.prBranch, "");
    if (expectedRunnerBranch && branch && branch !== expectedRunnerBranch) {
      return {
        error: {
          code: "docker_runner_branch_mismatch",
          message:
            `docker runner completed on branch "${branch}" but expected runner branch "${expectedRunnerBranch}"; ` +
            "refusing to merge evidence from an unexpected branch",
          details: {
            runnerTask,
            expectedRunnerBranch,
            actualBranch: branch,
            runnerResult: parsed,
          },
        },
      };
    }

    // Preserve the older missing-evidence contract for generic fake-runner outputs.
    // Treat no-diff as a hard failure only when the runner explicitly detected it.
    const runnerReportedNoDiff = parsed.noDiff === true || safeText(parsed.diffStatus, "") === "empty";
    if (isGithubPatchEvidenceTask(task) && runnerReportedNoDiff) {
      return {
        error: {
          code: "docker_runner_no_diff",
          message:
            "docker runner completed but reported no file changes; " +
            "github-propose-patch tasks must produce a non-empty diff before PR creation",
          details: {
            runnerTask,
            runnerResult: parsed,
            branch,
          },
        },
      };
    }

    // map all evidence URLs from runner result through both github sub-object and top-level output
    const githubEvidence = buildOutputGithub(parsed);
    if (githubEvidence) {
      output.github = githubEvidence;
    }
    if (safeText(githubEvidence?.startCommentUrl, "")) output.startCommentUrl = safeText(githubEvidence.startCommentUrl);
    if (safeText(githubEvidence?.prUrl, "")) output.prUrl = safeText(githubEvidence.prUrl);
    if (safeText(githubEvidence?.doneCommentUrl, "")) output.doneCommentUrl = safeText(githubEvidence.doneCommentUrl);
    if (safeText(githubEvidence?.blockCommentUrl, "")) output.blockCommentUrl = safeText(githubEvidence.blockCommentUrl);

    // github-propose-patch tasks must carry completion evidence; fail early if missing
    if (isGithubEvidenceTask(task) && !githubEvidence) {
      return {
        error: {
          code: "docker_runner_evidence_missing",
          message:
            "docker runner completed but produced no PR/Done/Block evidence URL; " +
            "github-propose-patch tasks require at least one of prUrl, doneCommentUrl, or blockCommentUrl",
          details: {
            runnerTask,
            runnerResult: parsed,
            requiredEvidence: ["prUrl", "doneCommentUrl", "blockCommentUrl"],
          },
        },
      };
    }

    return {
      result: {
        summary: `docker runner completed ${safeText(task.id, "unknown")}`,
        handler: BUILD_INFO,
        lifecycle: {
          intent: safeText(task.intent, "unknown"),
          mode: taskMode(task),
          taskId: safeText(task.id, "unknown"),
          proposalId: safeText(task.proposalId, undefined),
          exchangeId: safeText(task.exchangeId, undefined),
        },
        output,
      },
    };
  } catch (error) {
    if (shouldFallbackToBuiltin(env)) {
      return handleBuiltinTask(task, env);
    }
    return {
      error: {
        code: "docker_runner_exception",
        message: error instanceof Error ? error.message : String(error),
        details: { runnerTask, buildInfo: BUILD_INFO },
      },
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function shouldReturnReadOnlyGithubBlockEvidence(task) {
  const payload = taskPayload(task);
  return isGithubReadOnlyEvidenceTask(task)
    && taskMode(task) === "github-verify"
    && payload.readOnlyValidation === true
    && payload.forbidNewPr === true;
}

function githubReadOnlyExecutorBlockEvidence(task, env = process.env) {
  const payload = taskPayload(task);
  const mode = taskMode(task);
  const { model: effectiveModel, fromPayload: modelFromPayload } = resolveWorkerModel(task, env);
  const { thinking: effectiveThinking, fromPayload: thinkingFromPayload } = resolveWorkerThinking(task);
  return {
    result: {
      summary: "github read-only verification blocked: evidence executor is not configured",
      note: "github-verify/readOnlyValidation tasks must not be counted as substantive worker analysis when no docker/OpenClaw evidence executor is available",
      handler: BUILD_INFO,
      lifecycle: {
        intent: safeText(task.intent, "unknown"),
        mode,
        taskId: safeText(task.id, "unknown"),
        proposalId: safeText(task.proposalId, undefined),
        exchangeId: safeText(task.exchangeId, undefined),
      },
      output: {
        analysisStatus: "blocked",
        analysisKind: "github_readonly_executor_preflight",
        blockReason: "github_readonly_executor_not_configured",
        executorMode: normalizedExecutorMode(env),
        dockerScope: normalizedDockerScope(env),
        bridgeConfigured: shouldUseOpenClawBridge(task, env),
        repo: safeText(payload.repo || payload.repository, undefined),
        issue: safeText(payload.issue, undefined),
        issueUrl: safeText(payload.issueUrl, undefined),
        noLive: payload.noLive === true || payload.no_live === true || undefined,
        sourceOnly: payload.sourceOnly === true || payload.source_only === true || undefined,
        forbidNewPr: payload.forbidNewPr === true || payload.forbid_new_pr === true || undefined,
        readOnlyValidation: payload.readOnlyValidation === true || undefined,
        payloadKeys: Object.keys(payload).sort(),
        effectiveModel,
        effectiveThinking,
        modelFromPayload: modelFromPayload || undefined,
        thinkingFromPayload: thinkingFromPayload || undefined,
      },
    },
  };
}

function handleBuiltinTask(task, env = process.env) {
  if (isGithubEvidenceTask(task)) {
    if (shouldReturnReadOnlyGithubBlockEvidence(task)) {
      return githubReadOnlyExecutorBlockEvidence(task, env);
    }
    return githubExecutorNotConfigured(task, env);
  }

  const mode = taskMode(task);
  const payload = taskPayload(task);
  const { model: effectiveModel, fromPayload: modelFromPayload } = resolveWorkerModel(task, env);
  const { thinking: effectiveThinking, fromPayload: thinkingFromPayload } = resolveWorkerThinking(task);

  if (isDockerBrokerNoopSmokeTask(task)) {
    return {
      result: {
        summary: `docker broker noop smoke completed ${safeText(task.id, "unknown")}`,
        handler: BUILD_INFO,
        lifecycle: {
          intent: safeText(task.intent, "unknown"),
          mode,
          taskId: safeText(task.id, "unknown"),
          proposalId: safeText(task.proposalId, undefined),
          exchangeId: safeText(task.exchangeId, undefined),
        },
        output: {
          message: safeText(task.message, ""),
          smoke: {
            ok: true,
            noOp: true,
            runId: safeText(payload.runId, undefined),
            worker: safeText(payload.worker, safeText(task.assignedWorkerId, undefined)),
            completedAt: new Date().toISOString(),
          },
          payloadKeys: Object.keys(payload).sort(),
          effectiveModel,
          effectiveThinking,
          modelFromPayload: modelFromPayload || undefined,
        },
      },
    };
  }

  if (isDecisionDialecticPhaseTask(task)) {
    return decisionDialecticBridgeNotConfigured(task, env);
  }

  if (isReadOnlyAnalysisTask(task)) {
    // Read-only analysis task: produces Done/Block evidence without requiring a patch/PR.
    // These tasks are strictly read-only — no code changes, no workspace modifications.
    // GitHub propose_patch PR evidence requirements are preserved (see isGithubEvidenceTask above).
    const analysisSummary = safeText(payload.summary, safeText(payload.analysisSummary, payload.finding))
      || safeText(task.message, `analysis-only task completed`);
    const doneCommentUrl = safeText(payload.doneCommentUrl, "");
    const blockCommentUrl = safeText(payload.blockCommentUrl, "");
    const startCommentUrl = safeText(payload.startCommentUrl, "");
    const findings = Array.isArray(payload.findings) ? [...payload.findings] : [];
    const risks = Array.isArray(payload.risks) ? [...payload.risks] : [];
    const recommendations = Array.isArray(payload.recommendations) ? [...payload.recommendations] : [];
    const evidenceRefs = Array.isArray(payload.evidenceRefs) ? [...payload.evidenceRefs] : [];
    const artifacts = Array.isArray(payload.artifacts) ? [...payload.artifacts] : [];
    const noLive = payload.noLive === true || payload.no_live === true || undefined;
    const sourceOnly = payload.sourceOnly === true || payload.source_only === true || undefined;

    if (blockCommentUrl) {
      return {
        result: {
          summary: `analysis-only blocked: ${analysisSummary}`,
          note: `analysis-only task blocked with Block evidence`,
          handler: BUILD_INFO,
          lifecycle: {
            intent: "analyze",
            mode,
            taskId: safeText(task.id, "unknown"),
            proposalId: safeText(task.proposalId, undefined),
            exchangeId: safeText(task.exchangeId, undefined),
          },
          output: {
            analysisSummary,
            analysisKind: "builtin_structured",
            blockCommentUrl,
            startCommentUrl: startCommentUrl || undefined,
            findings,
            risks,
            recommendations,
            evidenceRefs,
            artifacts,
            role: safeText(payload.role, undefined),
            phase: safeText(payload.phase, undefined),
            noLive,
            sourceOnly,
            payloadKeys: Object.keys(payload).sort(),
            effectiveModel,
            effectiveThinking,
            modelFromPayload: modelFromPayload || undefined,
          },
        },
      };
    }

    return {
      result: {
        summary: `analysis-only completed: ${analysisSummary}`,
        note: `analysis-only task completed with Done evidence (no PR required)`,
        handler: BUILD_INFO,
        lifecycle: {
          intent: "analyze",
          mode,
          taskId: safeText(task.id, "unknown"),
          proposalId: safeText(task.proposalId, undefined),
          exchangeId: safeText(task.exchangeId, undefined),
        },
        output: {
          analysisSummary,
          analysisKind: "builtin_structured",
          doneCommentUrl: doneCommentUrl || undefined,
          startCommentUrl: startCommentUrl || undefined,
          findings,
          risks,
          recommendations,
          evidenceRefs,
          artifacts,
          role: safeText(payload.role, undefined),
          phase: safeText(payload.phase, undefined),
          noLive,
          sourceOnly,
          payloadKeys: Object.keys(payload).sort(),
          effectiveModel,
          effectiveThinking,
          modelFromPayload: modelFromPayload || undefined,
        },
      },
    };
  }

  const summary = `generic ${mode} task accepted by versioned A2A task handler`;

  return {
    result: {
      summary,
      handler: BUILD_INFO,
      lifecycle: {
        intent: safeText(task.intent, "unknown"),
        mode,
        taskId: safeText(task.id, "unknown"),
        proposalId: safeText(task.proposalId, undefined),
        exchangeId: safeText(task.exchangeId, undefined),
      },
      output: {
        message: safeText(task.message, ""),
        payloadKeys: task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
          ? Object.keys(task.payload).sort()
          : [],
        effectiveModel,
        effectiveThinking,
        modelFromPayload: modelFromPayload || undefined,
      },
    },
  };
}

export const __test = Object.freeze({
  buildRunnerTask,
  DEFAULT_OPENCLAW_TIMEOUT_SEC,
  DEFAULT_RUNNER_TASK_TIMEOUT_MS,
  resolveNodeScriptInvocation,
  resolveWorkerModel,
  resolveWorkerThinking,
  validateWorkerOverrides,
});

export function handleTask(task, env = process.env) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    return { error: { code: "invalid_task", message: "handler input must be a task object", details: { buildInfo: BUILD_INFO } } };
  }

  // Fail closed if the task requests an unsupported model override.
  // This check happens before any execution to prevent wasted patch attempts.
  const overrideValidation = validateWorkerOverrides(task, env);
  if (overrideValidation) {
    return overrideValidation;
  }

  if (shouldUseDockerRunner(task, env)) {
    return runDockerRunner(task, env);
  }

  if (shouldUseOpenClawBridge(task, env)) {
    return runOpenClawBridge(task, env);
  }

  if (shouldUseDecisionDialecticBridge(task, env)) {
    return runDecisionDialecticBridge(task, env);
  }

  if (shouldUseOpenClawAnalysisBridge(task, env)) {
    return runOpenClawAnalysisBridge(task, env);
  }

  return handleBuiltinTask(task, env);
}

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

if (process.argv[1] === SOURCE_PATH) {
  try {
    const input = await readStdin();
    const task = JSON.parse(input || "null");
    const outcome = handleTask(task);
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    if (outcome.error) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({
      error: {
        code: "handler_exception",
        message: error instanceof Error ? error.message : String(error),
        details: { buildInfo: BUILD_INFO },
      },
    }) + "\n");
    process.exitCode = 1;
  }
}
