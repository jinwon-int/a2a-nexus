import { existsSync, readFileSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import type {
  RunnerBuildMetadata,
  RunnerCommandProfile,
  RunnerConfig,
  RunnerClaudePatchMode,
  RunnerClaudeTurnBudgetProjection,
  RunnerClaudeTurnBudgetValue,
  RunnerContainedSubagentReason,
  RunnerContainedSubagentRole,
  RunnerContainedSubagentsConfig,
  RunnerEngine,
  RunnerExtraMount,
} from "./types.js";
import {
  DEFAULT_EGRESS_MAX_BYTES,
  DEFAULT_EGRESS_TIMEOUT_MS,
  GITHUB_EGRESS_ALLOWED_HOSTS,
  isDeniedInternalHostname,
  isDeniedInternalIp,
} from "./egress-allowlist-proxy.js";
import { DEFAULT_FAILURE_LOG_KEEP, DEFAULT_FAILURE_LOG_MAX_BYTES } from "./failure-output-log.js";
import { renderProfileScript } from "./profile-scripts.js";

/**
 * Stable classification codes for extra-mount / profile-mount configuration
 * errors. They let a pre-claim worker readiness preflight (see
 * `extra-mounts-preflight.ts`) turn an otherwise-thrown config error into
 * structured Block evidence instead of letting the task be claimed and then
 * fail mid-run as `handler_exit_nonzero` (a2a-nexus#775).
 */
export type ExtraMountsConfigErrorCode =
  | "extra_mounts_json_invalid"
  | "extra_mounts_entry_invalid"
  | "profile_mount_missing"
  | "profile_mount_source_conflict"
  | "forbidden_writable_runtime_mount";

/**
 * Configuration error for `A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON` / profile mount
 * selection. Extends `Error` and keeps the exact same human message, so callers
 * that match on `error.message` are unaffected, while preflight code can branch
 * deterministically on `error.code`.
 */
export class ExtraMountsConfigError extends Error {
  readonly code: ExtraMountsConfigErrorCode;
  constructor(code: ExtraMountsConfigErrorCode, message: string) {
    super(message);
    this.name = "ExtraMountsConfigError";
    this.code = code;
  }
}

const DEFAULT_ROOT = "/var/lib/openclaw-a2a/tasks";
const DEFAULT_IMAGE = "node:22-bookworm-slim";
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_OPENCLAW_TIMEOUT_SEC = "3600";
const DEFAULT_HERMES_TIMEOUT_SEC = "3600";
const DEFAULT_CLAUDE_CODE_TIMEOUT_SEC = "3600";
const DEFAULT_CODEX_TIMEOUT_SEC = "3600";
const DEFAULT_CODEX_CONFIG_DIR = "/var/lib/a2a-runner/codex-dir";
const DEFAULT_PIRI_CONFIG_DIR = "/var/lib/a2a-runner/piri-dir";
/** Host-side bounded memory snapshot dir for the piri lane (#1797 item 3a). */
const DEFAULT_PIRI_MEMORY_DIR = "/var/lib/a2a-runner/piri-memory";
const DEFAULT_PIRI_MODEL = "kimi-coding/k3";
const DEFAULT_PIRI_THINKING = "high";
const DEFAULT_PIRI_TIMEOUT_SEC = "3600";
/** Baked into piri-runner images; the command script uses it unless overridden. */
const DEFAULT_PIRI_OUTPUT_SCHEMA = "/etc/a2a-runner/piri-analysis-output.schema.json";
export const DEFAULT_SERVICE_ENV_FILE = "/etc/default/openclaw-a2a-worker";

export function loadEnvFile(path: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\(["\\$])/g, "$1");
      }
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    parsed[key] = value;
  }
  return parsed;
}

export function mergeRunnerEnvFile(
  env: NodeJS.ProcessEnv = process.env,
  envFilePath = env.A2A_DOCKER_RUNNER_ENV_FILE || DEFAULT_SERVICE_ENV_FILE,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  if (envFilePath && existsSync(envFilePath)) {
    Object.assign(merged, loadEnvFile(envFilePath));
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

export async function loadConfig(env = process.env): Promise<RunnerConfig> {
  const engine = normalizeEngine(env.A2A_DOCKER_RUNNER_ENGINE) ?? (isTruthy(env.A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT) ? "docker" : detectEngine());
  const githubTokenFile = env.A2A_DOCKER_RUNNER_GITHUB_TOKEN_FILE;
  if (githubTokenFile && existsSync(githubTokenFile)) {
    await access(githubTokenFile, constants.R_OK);
  }

  const profile = normalizePatchCommandProfile(env.A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE);
  const patchCommand = loadPatchCommandConfig(env);
  const extraMounts = loadExtraMounts(env);
  validatePatchExecutorPolicy(patchCommand, extraMounts, profile);

  const image = env.A2A_DOCKER_RUNNER_IMAGE || DEFAULT_IMAGE;
  const trustedOperator = isTruthy(env.A2A_DOCKER_RUNNER_TRUSTED_OPERATOR);
  const expectedProfile = normalizePatchCommandProfile(env.A2A_DOCKER_RUNNER_EXPECTED_PATCH_COMMAND_PROFILE);
  validatePatchCommandProfileSelection({ profile, expectedProfile, image });

  const config: RunnerConfig = {
    rootDir: env.A2A_DOCKER_RUNNER_ROOT || DEFAULT_ROOT,
    engine,
    image,
    buildMetadata: loadBuildMetadata(env, image),
    githubTokenFile,
    defaultTimeoutMs: Number(env.A2A_DOCKER_RUNNER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    memory: env.A2A_DOCKER_RUNNER_MEMORY || "2g",
    cpus: env.A2A_DOCKER_RUNNER_CPUS || "2",
    network: env.A2A_DOCKER_RUNNER_NETWORK || (trustedOperator && (profile === "openclaw" || profile === "hermes" || profile === "claude-code" || profile === "codex" || profile === "piri") ? "bridge" : "none"),
    readOnlyRootFilesystem: normalizeDefaultTrue(env.A2A_DOCKER_RUNNER_READ_ONLY_ROOTFS, trustedOperator),
    user: normalizeContainerUser(env.A2A_DOCKER_RUNNER_USER, trustedOperator),
    trustedOperator,
    pidsLimit: env.A2A_DOCKER_RUNNER_PIDS_LIMIT || "512",
    noNewPrivileges: !isTruthy(env.A2A_DOCKER_RUNNER_ALLOW_PRIVILEGE_ESCALATION),
    capDrop: parseCommaList(env.A2A_DOCKER_RUNNER_CAP_DROP),
    capAdd: parseCommaList(env.A2A_DOCKER_RUNNER_CAP_ADD),
    extraMounts,
    containedSubagents: loadContainedSubagentsConfig(env, patchCommand.commandProfile, profile),
    proofSigningKeyFile: (env.A2A_DOCKER_RUNNER_PROOF_SIGNING_KEY_FILE || "").trim() || undefined,
    proofSigningKid: (env.A2A_DOCKER_RUNNER_PROOF_SIGNING_KID || "").trim() || undefined,
    egressAllowlistHosts: parseCommaList(env.A2A_DOCKER_RUNNER_EGRESS_ALLOWLIST_HOSTS),
    egressMaxBytes: parseOptionalPositiveInteger(env.A2A_DOCKER_RUNNER_EGRESS_MAX_BYTES, DEFAULT_EGRESS_MAX_BYTES, "A2A_DOCKER_RUNNER_EGRESS_MAX_BYTES"),
    egressTimeoutMs: parseOptionalPositiveInteger(env.A2A_DOCKER_RUNNER_EGRESS_TIMEOUT_MS, DEFAULT_EGRESS_TIMEOUT_MS, "A2A_DOCKER_RUNNER_EGRESS_TIMEOUT_MS"),
    failureLogMaxBytes: parseOptionalPositiveInteger(env.A2A_DOCKER_RUNNER_FAILURE_LOG_MAX_BYTES, DEFAULT_FAILURE_LOG_MAX_BYTES, "A2A_DOCKER_RUNNER_FAILURE_LOG_MAX_BYTES") ?? DEFAULT_FAILURE_LOG_MAX_BYTES,
    failureLogKeep: parseOptionalPositiveInteger(env.A2A_DOCKER_RUNNER_FAILURE_LOG_KEEP, DEFAULT_FAILURE_LOG_KEEP, "A2A_DOCKER_RUNNER_FAILURE_LOG_KEEP") ?? DEFAULT_FAILURE_LOG_KEEP,
    ...patchCommand,
  };

  validateRunnerConfig(config);

  return config;
}

/**
 * Pre-deploy config validation: fail-fast on schema/config mismatch before the
 * runner starts executing tasks. Catches operator misconfiguration early so a
 * bad deploy never reaches Gateway restart or container launch.
 *
 * Parent: a2a-plane#249
 */
export function validateRunnerConfig(config: RunnerConfig): void {
  const errors: string[] = [];

  if (!config.image || typeof config.image !== "string" || !config.image.trim()) {
    errors.push("image must be a non-empty string");
  }

  if (!config.rootDir || !config.rootDir.startsWith("/")) {
    errors.push("rootDir must be a non-empty absolute path starting with /");
  }

  if (config.network && !/^(bridge|host|none)$/.test(config.network)) {
    errors.push(`unsupported network mode: ${JSON.stringify(config.network)} (expected bridge, host, or none)`);
  }

  validateEgressAllowlistConfig(config, errors);

  if (config.memory && !/^\d+[bkmgtpe]?$/i.test(config.memory)) {
    errors.push(`invalid memory limit: ${JSON.stringify(config.memory)} (expected format like "2g" or "512m")`);
  }

  if (config.pidsLimit && (!/^\d+$/.test(config.pidsLimit) || Number(config.pidsLimit) <= 0)) {
    errors.push(`invalid pids limit: ${JSON.stringify(config.pidsLimit)} (expected a positive integer)`);
  }

  if (config.cpus && !/^\d+(\.\d+)?$/.test(config.cpus)) {
    errors.push(`invalid cpus: ${JSON.stringify(config.cpus)} (expected format like "2" or "1.5")`);
  }

  if (!config.trustedOperator) {
    if (config.network === "host") {
      errors.push("public safe-default policy rejects host network; set A2A_DOCKER_RUNNER_TRUSTED_OPERATOR=1 for trusted-operator lanes");
    }
    if (config.noNewPrivileges === false) {
      errors.push("public safe-default policy requires no-new-privileges; set A2A_DOCKER_RUNNER_TRUSTED_OPERATOR=1 for privilege-escalation lanes");
    }
    if ((config.capAdd ?? []).length > 0) {
      errors.push("public safe-default policy rejects added capabilities; set A2A_DOCKER_RUNNER_TRUSTED_OPERATOR=1 for capability-add lanes");
    }
    if (config.githubTokenFile) {
      errors.push("public safe-default policy rejects GitHub token file exposure; set A2A_DOCKER_RUNNER_TRUSTED_OPERATOR=1 for trusted GitHub side-effect lanes");
    }
  }

  if (!Number.isFinite(config.defaultTimeoutMs) || config.defaultTimeoutMs <= 0) {
    errors.push(`invalid defaultTimeoutMs: ${config.defaultTimeoutMs} (expected positive number)`);
  }

  if (config.containedSubagents) {
    if (!Number.isInteger(config.containedSubagents.maxCount) || config.containedSubagents.maxCount < 0 || config.containedSubagents.maxCount > 4) {
      errors.push(`invalid containedSubagents.maxCount: ${config.containedSubagents.maxCount} (expected integer 0..4)`);
    }
    if (!Number.isInteger(config.containedSubagents.outputBytes) || config.containedSubagents.outputBytes < 1024 || config.containedSubagents.outputBytes > 60000) {
      errors.push(`invalid containedSubagents.outputBytes: ${config.containedSubagents.outputBytes} (expected integer 1024..60000)`);
    }
    if (config.containedSubagents.enabled && !config.commandProfile) {
      errors.push("contained subagents require a first-class A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE");
    }
  }

  if (errors.length > 0) {
    throw new Error(`runner pre-deploy config validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }
}

function loadBuildMetadata(env: NodeJS.ProcessEnv, runtimeImage: string): RunnerBuildMetadata | undefined {
  const metadata = Object.fromEntries(Object.entries({
    version: safeMetadataValue(env.A2A_DOCKER_RUNNER_BUILD_VERSION),
    source: safeMetadataValue(env.A2A_DOCKER_RUNNER_BUILD_SOURCE),
    revision: safeMetadataValue(env.A2A_DOCKER_RUNNER_BUILD_REVISION),
    builtAt: safeMetadataValue(env.A2A_DOCKER_RUNNER_BUILD_BUILT_AT),
    image: safeMetadataValue(env.A2A_DOCKER_RUNNER_BUILD_IMAGE || runtimeImage),
  }).filter(([, value]) => value)) as RunnerBuildMetadata;
  return Object.values(metadata).some(Boolean) ? metadata : undefined;
}

const BUILD_METADATA_LIMIT = 200;

function safeMetadataValue(value?: string): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  if (looksSensitiveOrHostSpecific(compact)) return undefined;
  return compact.length <= BUILD_METADATA_LIMIT ? compact : compact.slice(0, BUILD_METADATA_LIMIT);
}

function looksSensitiveOrHostSpecific(value: string): boolean {
  if (/gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{32,}/i.test(value)) return true;
  if (/(token|password|secret|api[_-]?key)\s*[:=]/i.test(value)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s]+@/i.test(value)) return true;
  if (/^\/(?:home|root|Users|var|opt|srv|tmp)\b/.test(value)) return true;
  return false;
}

export function loadExtraMounts(env: NodeJS.ProcessEnv): RunnerExtraMount[] | undefined {
  const raw = env.A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON;
  if (!raw) {
    const profile = normalizePatchCommandProfile(env.A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE);
    if (profile === "openclaw") {
      return [{
        source: env.A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR || "/root/.openclaw",
        target: "/run/secrets/openclaw-dir",
        readOnly: true,
      }];
    }
    if (profile === "hermes") {
      return [{
        source: env.A2A_DOCKER_RUNNER_HERMES_CONFIG_DIR || "/root/.hermes",
        target: "/run/secrets/hermes-dir",
        readOnly: true,
      }];
    }
    if (profile === "claude-code") {
      return [{
        source: env.A2A_DOCKER_RUNNER_CLAUDE_CONFIG_DIR || "/root/.claude",
        target: "/run/secrets/claude-dir",
        readOnly: true,
      }];
    }
    if (profile === "codex") {
      return [{
        source: env.A2A_DOCKER_RUNNER_CODEX_CONFIG_DIR || DEFAULT_CODEX_CONFIG_DIR,
        target: "/run/secrets/codex-dir",
        readOnly: true,
      }];
    }
    if (profile === "piri") {
      const mounts: RunnerExtraMount[] = [{
        source: env.A2A_DOCKER_RUNNER_PIRI_CONFIG_DIR || DEFAULT_PIRI_CONFIG_DIR,
        target: "/run/secrets/piri-dir",
        readOnly: true,
      }];
      // #1797 item 3a follow-up: optional host-produced bounded memory snapshot,
      // mounted read-only only when the lane opted in. The host dir must exist
      // (producer installed) or docker fails the container start fail-closed.
      if (env.A2A_DOCKER_RUNNER_PIRI_MEMORY_ENABLED === "1") {
        mounts.push({
          source: env.A2A_DOCKER_RUNNER_PIRI_MEMORY_DIR || DEFAULT_PIRI_MEMORY_DIR,
          target: "/run/secrets/piri-memory",
          readOnly: true,
        });
      }
      return mounts;
    }
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ExtraMountsConfigError("extra_mounts_json_invalid", `invalid A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: ${msg}`);
  }

  if (!Array.isArray(parsed)) {
    throw new ExtraMountsConfigError("extra_mounts_json_invalid", "invalid A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: expected an array");
  }

  const mounts = parsed.map((entry, index): RunnerExtraMount => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ExtraMountsConfigError("extra_mounts_entry_invalid", `invalid extra mount at index ${index}: expected object`);
    }

    const record = entry as Record<string, unknown>;
    const source = record.source;
    const target = record.target;
    const readOnly = record.readOnly;
    if (typeof source !== "string" || !source.startsWith("/")) {
      throw new ExtraMountsConfigError("extra_mounts_entry_invalid", `invalid extra mount at index ${index}: source must be an absolute path`);
    }
    if (typeof target !== "string" || !target.startsWith("/")) {
      throw new ExtraMountsConfigError("extra_mounts_entry_invalid", `invalid extra mount at index ${index}: target must be an absolute path`);
    }
    if (readOnly !== undefined && typeof readOnly !== "boolean") {
      throw new ExtraMountsConfigError("extra_mounts_entry_invalid", `invalid extra mount at index ${index}: readOnly must be boolean`);
    }
    const mount = { source, target, readOnly };
    validateOpenClawRuntimeMount(mount, index);
    return mount;
  });

  validateProfileMountSelection(mounts, env);
  return mounts;
}

function validateProfileMountSelection(mounts: RunnerExtraMount[], env: NodeJS.ProcessEnv): void {
  const profile = normalizePatchCommandProfile(env.A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE);
  if (profile === "openclaw") {
    validateNamedProfileMountSelection(
      mounts,
      "/run/secrets/openclaw-dir",
      env.A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR,
      "openclaw",
      "OpenClaw",
    );
    return;
  }
  if (profile === "hermes") {
    validateNamedProfileMountSelection(
      mounts,
      "/run/secrets/hermes-dir",
      env.A2A_DOCKER_RUNNER_HERMES_CONFIG_DIR,
      "hermes",
      "Hermes",
    );
    return;
  }
  if (profile === "claude-code") {
    validateNamedProfileMountSelection(
      mounts,
      "/run/secrets/claude-dir",
      env.A2A_DOCKER_RUNNER_CLAUDE_CONFIG_DIR,
      "claude-code",
      "Claude Code",
    );
    return;
  }
  if (profile === "codex") {
    validateNamedProfileMountSelection(
      mounts,
      "/run/secrets/codex-dir",
      env.A2A_DOCKER_RUNNER_CODEX_CONFIG_DIR,
      "codex",
      "Codex",
    );
    return;
  }
  if (profile === "piri") {
    validateNamedProfileMountSelection(
      mounts,
      "/run/secrets/piri-dir",
      env.A2A_DOCKER_RUNNER_PIRI_CONFIG_DIR,
      "piri",
      "Piri",
    );
  }
}

function validateNamedProfileMountSelection(
  mounts: RunnerExtraMount[],
  target: string,
  expectedSource: string | undefined,
  profile: string,
  label: string,
): void {
  const profileMounts = mounts.filter((mount) => normalizeAbsolutePathForPolicy(mount.target) === target);
  if (profileMounts.length === 0) {
    throw new ExtraMountsConfigError(
      "profile_mount_missing",
      `invalid A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: ${profile} patch profile requires a ${target} mount; ` +
      `omit A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON or include the ${label} config mount explicitly`,
    );
  }

  if (!expectedSource) return;

  const normalizedExpected = normalizeAbsolutePathForPolicy(expectedSource);
  const conflicts = profileMounts.filter((mount) => normalizeAbsolutePathForPolicy(mount.source) !== normalizedExpected);
  if (conflicts.length === 0) return;

  throw new ExtraMountsConfigError(
    "profile_mount_source_conflict",
    `invalid A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: ${target} source conflicts with ` +
    `the configured ${label} profile directory; mount the configured ${label} profile directory or omit the duplicate mount`,
  );
}

function validateOpenClawRuntimeMount(mount: RunnerExtraMount, index: number): void {
  const source = normalizeAbsolutePathForPolicy(mount.source);
  const target = normalizeAbsolutePathForPolicy(mount.target);
  const writable = mount.readOnly === false;
  const protectedSource = isProtectedOpenClawRuntimePath(source);
  const protectedTarget = isProtectedOpenClawRuntimePath(target);
  const protectedHermesSource = isProtectedHermesRuntimePath(source);
  const protectedHermesTarget = isProtectedHermesRuntimePath(target);
  const protectedClaudeSource = isProtectedClaudeRuntimePath(source);
  const protectedClaudeTarget = isProtectedClaudeRuntimePath(target);
  const protectedCodexSource = isProtectedCodexRuntimePath(source);
  const protectedCodexTarget = isProtectedCodexRuntimePath(target);
  const protectedPiriSource = isProtectedPiriRuntimePath(source);
  const protectedPiriTarget = isProtectedPiriRuntimePath(target);

  if (writable && (protectedSource || protectedTarget || protectedHermesSource || protectedHermesTarget || protectedClaudeSource || protectedClaudeTarget || protectedCodexSource || protectedCodexTarget || protectedPiriSource || protectedPiriTarget)) {
    throw new ExtraMountsConfigError(
      "forbidden_writable_runtime_mount",
      `invalid extra mount at index ${index}: writable agent runtime/session paths are forbidden; ` +
      "mount only scratch paths read-write and keep host ~/.openclaw / ~/.hermes / ~/.claude / ~/.codex sessions read-only",
    );
  }
}

function normalizeAbsolutePathForPolicy(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  }
}

function isProtectedOpenClawRuntimePath(value: string): boolean {
  const normalized = value.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  return [
    /^\/root\/\.openclaw(?:\/|$)/,
    /^\/home\/[^/]+\/\.openclaw(?:\/|$)/,
    /^\/run\/secrets\/openclaw-dir(?:\/|$)/,
  ].some((pattern) => pattern.test(normalized));
}

function isProtectedHermesRuntimePath(value: string): boolean {
  const normalized = value.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  return [
    /^\/root\/\.hermes(?:\/|$)/,
    /^\/home\/[^/]+\/\.hermes(?:\/|$)/,
    /^\/run\/secrets\/hermes-dir(?:\/|$)/,
  ].some((pattern) => pattern.test(normalized));
}

function isProtectedClaudeRuntimePath(value: string): boolean {
  const normalized = value.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  return [
    /^\/root\/\.claude(?:\/|$)/,
    /^\/home\/[^/]+\/\.claude(?:\/|$)/,
    /^\/run\/secrets\/claude-dir(?:\/|$)/,
  ].some((pattern) => pattern.test(normalized));
}

function isProtectedCodexRuntimePath(value: string): boolean {
  const normalized = value.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  return [
    /^\/root\/\.codex(?:\/|$)/,
    /^\/home\/[^/]+\/\.codex(?:\/|$)/,
    /^\/run\/secrets\/codex-dir(?:\/|$)/,
  ].some((pattern) => pattern.test(normalized));
}

function isProtectedPiriRuntimePath(value: string): boolean {
  const normalized = value.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  return [
    /^\/root\/\.piri(?:\/|$)/,
    /^\/home\/[^/]+\/\.piri(?:\/|$)/,
    /^\/run\/secrets\/piri-dir(?:\/|$)/,
  ].some((pattern) => pattern.test(normalized));
}

function loadPatchCommandConfig(
  env: NodeJS.ProcessEnv,
): Pick<RunnerConfig, "commandScript" | "commandJson" | "commandTemplate" | "commandProfile" | "openclawProfile" | "hermesProfile" | "claudeCodeProfile" | "codexProfile" | "piriProfile"> {
  const commandScript = env.A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT || undefined;
  if (commandScript) return { commandScript };

  const commandJson = env.A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON || undefined;
  if (commandJson) return { commandJson };

  const profile = normalizePatchCommandProfile(env.A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE);
  if (profile === "openclaw") {
    return {
      commandProfile: "openclaw",
      commandScript: buildOpenClawPatchCommandScript(env),
      openclawProfile: {
        allowNpmInstallFallback: env.A2A_OPENCLAW_ALLOW_NPM_INSTALL_FALLBACK === "1",
      },
    };
  }
  if (profile === "hermes") {
    return {
      commandProfile: "hermes",
      commandScript: buildHermesPatchCommandScript(env),
      hermesProfile: {
        configDir: env.A2A_DOCKER_RUNNER_HERMES_CONFIG_DIR || "/root/.hermes",
      },
    };
  }
  if (profile === "claude-code") {
    return {
      commandProfile: "claude-code",
      commandScript: buildClaudeCodePatchCommandScript(env),
      claudeCodeProfile: {
        configDir: env.A2A_DOCKER_RUNNER_CLAUDE_CONFIG_DIR || "/root/.claude",
        turnBudgets: projectClaudeCodeTurnBudgets(env),
      },
    };
  }
  if (profile === "codex") {
    return {
      commandProfile: "codex",
      commandScript: buildCodexPatchCommandScript(env),
      codexProfile: {
        configDir: env.A2A_DOCKER_RUNNER_CODEX_CONFIG_DIR || DEFAULT_CODEX_CONFIG_DIR,
      },
    };
  }
  if (profile === "piri") {
    return {
      commandProfile: "piri",
      commandScript: buildPiriPatchCommandScript(env),
      piriProfile: {
        configDir: env.A2A_DOCKER_RUNNER_PIRI_CONFIG_DIR || DEFAULT_PIRI_CONFIG_DIR,
      },
    };
  }

  return { commandTemplate: env.A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE || undefined };
}

export function loadContainedSubagentsConfig(
  env: NodeJS.ProcessEnv,
  effectiveProfile: RunnerCommandProfile | undefined,
  selectedProfile: RunnerCommandProfile | undefined = effectiveProfile,
): RunnerContainedSubagentsConfig {
  // Phase-2 WS4: the claude-code fanout flag also enables contained sub-agents for
  // the claude-code lane, so runner.ts injects A2A_CONTAINED_SUBAGENTS_* for the
  // bridge's fanout path. Default (flag off / other profiles) is unchanged.
  // piri reuse WS1 (#1836): the piri lane mirrors the same opt-in with its own
  // flag; cross-lane flags never enable another lane's contained sub-agents.
  const enabled = containedSubagentsEnabledByDefault(env.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED, effectiveProfile)
    || (effectiveProfile === "claude-code" && env.A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED === "1")
    || (effectiveProfile === "piri" && env.A2A_DOCKER_RUNNER_PIRI_FANOUT_ENABLED === "1");
  const maxCount = enabled
    ? parseBoundedInteger(env.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX, 3, 1, 4, "A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX")
    : 0;
  const outputBytes = parseBoundedInteger(
    env.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_OUTPUT_BYTES,
    12000,
    1024,
    60000,
    "A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_OUTPUT_BYTES",
  );
  const reasons = parseEnumList<RunnerContainedSubagentReason>(
    env.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_REASONS,
    ["context_heavy", "broad_source_inspection", "context_overflow_retry", "validation_split"],
    ["context_heavy", "broad_source_inspection", "validation_split"],
    "A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_REASONS",
  );
  const roles = parseEnumList<RunnerContainedSubagentRole>(
    env.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES,
    ["explorer", "implementer", "verifier"],
    (effectiveProfile ?? selectedProfile) === "hermes" ? ["explorer", "verifier"] : ["explorer", "implementer", "verifier"],
    "A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES",
  );

  return { enabled, maxCount, outputBytes, reasons, roles };
}

function containedSubagentsEnabledByDefault(value: string | undefined, profile: RunnerCommandProfile | undefined): boolean {
  if (value !== undefined && value.trim() !== "") {
    if (/^(0|false|no|off)$/i.test(value.trim())) return false;
    return /^(1|true|yes|on)$/i.test(value.trim());
  }
  return profile === "openclaw" || profile === "hermes";
}

function isTruthy(value?: string): boolean {
  if (!value) return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function isFalsy(value?: string): boolean {
  if (!value) return false;
  return /^(0|false|no|off)$/i.test(value.trim());
}

function normalizeDefaultTrue(value: string | undefined, enabledByDefault: boolean): boolean {
  if (value !== undefined && value.trim() !== "") return !isFalsy(value);
  return enabledByDefault;
}

function normalizeContainerUser(value: string | undefined, trustedOperator: boolean): string | undefined {
  if (value !== undefined && value.trim() !== "") {
    const trimmed = value.trim();
    if (/^(0|root)$/i.test(trimmed)) return undefined;
    return trimmed;
  }
  return trustedOperator ? "1000:1000" : undefined;
}

function parseCommaList(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseOptionalPositiveInteger(value: string | undefined, fallback: number, label: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed || fallback;
}

function validateEgressAllowlistConfig(config: RunnerConfig, errors: string[]): void {
  const hosts = config.egressAllowlistHosts ?? [];
  const seen = new Set<string>();
  for (const rawHost of hosts) {
    const host = rawHost.trim().replace(/\.$/, "").toLowerCase();
    if (!host) continue;
    if (host !== rawHost) {
      errors.push(`egress allowlist host must be lowercase canonical hostname: ${JSON.stringify(rawHost)}`);
    }
    if (seen.has(host)) {
      errors.push(`duplicate egress allowlist host: ${host}`);
    }
    seen.add(host);
    if (host.includes(":") && !/^\[[0-9a-f:.]+\]$/i.test(host)) {
      errors.push(`egress allowlist host must not include a port: ${JSON.stringify(rawHost)}`);
    }
    const ipHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    if (isDeniedInternalHostname(host) || isDeniedInternalIp(ipHost)) {
      errors.push(`egress allowlist rejects internal host/IP: ${JSON.stringify(rawHost)}`);
    }
    if (!(GITHUB_EGRESS_ALLOWED_HOSTS as readonly string[]).includes(host)) {
      errors.push(`egress allowlist host is outside the supported GitHub retrieval hosts: ${JSON.stringify(rawHost)}`);
    }
  }
  if (config.egressMaxBytes !== undefined && (!Number.isSafeInteger(config.egressMaxBytes) || config.egressMaxBytes <= 0)) {
    errors.push(`invalid egressMaxBytes: ${config.egressMaxBytes} (expected positive integer)`);
  }
  if (config.egressTimeoutMs !== undefined && (!Number.isSafeInteger(config.egressTimeoutMs) || config.egressTimeoutMs <= 0)) {
    errors.push(`invalid egressTimeoutMs: ${config.egressTimeoutMs} (expected positive integer)`);
  }
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (!value) return fallback;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseEnumList<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: readonly T[],
  label: string,
): T[] {
  if (!value) return [...fallback];
  const allowedSet = new Set<string>(allowed);
  const parsed = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (parsed.length === 0) return [...fallback];
  const invalid = parsed.filter((entry) => !allowedSet.has(entry));
  if (invalid.length > 0) {
    throw new Error(`${label} contains unsupported values: ${invalid.join(", ")}`);
  }
  return Array.from(new Set(parsed)) as T[];
}

export function normalizePatchCommandProfile(value?: string): RunnerCommandProfile | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "openclaw") return "openclaw";
  if (normalized === "hermes") return "hermes";
  if (normalized === "claude-code" || normalized === "claude" || normalized === "cccb") return "claude-code";
  if (normalized === "codex") return "codex";
  if (normalized === "piri" || normalized === "pi" || normalized === "piri-cli") return "piri";
  throw new Error(`unsupported A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: ${value}`);
}

function normalizeRunnerModelSource(value?: string): "legacy" | "native" {
  if (!value) return "legacy";
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized || normalized === "legacy" || normalized === "runner" || normalized === "docker") return "legacy";
  if (normalized === "native" || normalized === "native-profile") return "native";
  throw new Error(`unsupported A2A_DOCKER_RUNNER_MODEL_SOURCE: ${value}`);
}

function validatePatchCommandProfileSelection(options: {
  profile: RunnerCommandProfile | undefined;
  expectedProfile: RunnerCommandProfile | undefined;
  image: string;
}): void {
  const { profile, expectedProfile, image } = options;
  if (expectedProfile && profile !== expectedProfile) {
    throw new Error(
      `runner patch profile mismatch: A2A_DOCKER_RUNNER_EXPECTED_PATCH_COMMAND_PROFILE=${expectedProfile} ` +
      `requires A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=${expectedProfile}; got ${profile ?? "unset"}`,
    );
  }

  const imageFamily = inferRunnerImageProfileFamily(image);
  if (!imageFamily || !profile || imageFamily === profile) return;

  throw new Error(
    `runner image/profile mismatch: A2A_DOCKER_RUNNER_IMAGE=${image} looks like a ${imageFamily} runner image, ` +
    `but A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=${profile}`,
  );
}

function inferRunnerImageProfileFamily(image: string): RunnerCommandProfile | undefined {
  const normalized = image.trim().toLowerCase();
  if (!normalized) return undefined;
  if (/(^|[/:])a2a-docker-runner-hermes(?=[:@/]|$)/.test(normalized)) return "hermes";
  if (/(^|[/:])a2a-docker-runner-openclaw(?=[:@/]|$)/.test(normalized)) return "openclaw";
  if (/(^|[/:])a2a-docker-runner-(?:cccb|claude-code)(?=[:@/]|$)/.test(normalized)) return "claude-code";
  if (/(^|[/:])a2a-docker-runner-codex(?=[:@/]|$)/.test(normalized)) return "codex";
  if (/(^|[/:])a2a-docker-runner-piri(?=[:@/]|$)/.test(normalized)) return "piri";
  return undefined;
}

interface CodexSubagentProfileSpec {
  fileName: string;
  role: RunnerContainedSubagentRole;
  contents: string;
}

const CODEX_SUBAGENT_PROFILE_SPECS: readonly CodexSubagentProfileSpec[] = [
  {
    fileName: "a2a-explorer.toml",
    role: "explorer",
    contents: `name = "a2a_explorer"
description = "A2A explorer for bounded code, issue, log, and test-surface investigation. Returns evidence only and never edits or finalizes."
model = "gpt-5.6-luna"
model_reasoning_effort = "max"
sandbox_mode = "read-only"
developer_instructions = """
Act as the A2A explorer role. Inspect only the specific seam assigned by the parent.
Do not edit or create repository files. Do not manage git, GitHub, releases, deployment,
credentials, or runtime state. Return concise evidence with exact file and symbol references,
open questions, and a recommendation. Redact secrets, private paths, and raw session data.
You are evidence-only; the parent worker is the single finalizer.
"""`,
  },
  {
    fileName: "a2a-researcher.toml",
    role: "explorer",
    contents: `name = "a2a_researcher"
description = "A2A explorer variant for narrow external documentation and API research with citations. Returns evidence only and never edits or finalizes."
model = "gpt-5.6-luna"
model_reasoning_effort = "max"
sandbox_mode = "read-only"
developer_instructions = """
Act as the A2A research variant of the explorer role. Answer one narrow external research
question using only the web or documentation tools available in the parent session. Cite the
sources you actually consulted. Do not edit repository files or manage git, GitHub, releases,
deployment, credentials, or runtime state. Redact secrets and private data. You are
evidence-only; the parent worker is the single finalizer.
"""`,
  },
  {
    fileName: "a2a-implementer.toml",
    role: "implementer",
    contents: `name = "a2a_implementer"
description = "A2A implementer for one explicitly assigned disjoint write set. Returns a patch and test evidence but never finalizes."
model = "gpt-5.6-sol"
model_reasoning_effort = "high"
sandbox_mode = "workspace-write"
developer_instructions = """
Act as the A2A implementer role. Edit only the explicit disjoint write set assigned by the
parent. Stop and report if the change needs any file outside that boundary or would overlap
another implementer. Run focused tests for your lane. Do not manage git, GitHub, releases,
deployment, credentials, or runtime state. Return changed paths, a concise diff summary,
tests and results, and remaining risks. You are evidence-only; the parent worker finalizes.
"""`,
  },
  {
    fileName: "a2a-verifier.toml",
    role: "verifier",
    contents: `name = "a2a_verifier"
description = "A2A clean-slate verifier for correctness, regression, test, and evidence risks. Never edits or finalizes."
model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"
sandbox_mode = "read-only"
developer_instructions = """
Act as the A2A verifier role from clean-slate inputs: the original assignment, exact diff or
head, and repository access. Independently derive the failure mode and checks. Do not edit
files or manage git, GitHub, releases, deployment, credentials, or runtime state. Return PASS
or a bounded fix list with exact source references and test evidence. Redact secrets and
private data. You are evidence-only; the parent worker is the single finalizer.
"""`,
  },
];

// Opt-in node policy: keep every contained helper on the configured worker model.
// Validate before interpolation into both TOML and generated shell text.
function codexSubagentOverride(env: NodeJS.ProcessEnv): { model: string; effort: string } | undefined {
  if (env.A2A_CODEX_SUBAGENTS_INHERIT_MODEL !== "1") return undefined;
  const model = (env.A2A_CODEX_MODEL || "gpt-5.6-sol").replace(/^openai-codex\//, "");
  const effort = env.A2A_CODEX_REASONING_EFFORT || "high";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(model)) {
    throw new Error("invalid A2A_CODEX_MODEL for contained subagent inheritance");
  }
  if (!["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(effort)) {
    throw new Error("invalid A2A_CODEX_REASONING_EFFORT for contained subagent inheritance");
  }
  return { model, effort };
}

function buildCodexSubagentProfileInstallShell(config: RunnerContainedSubagentsConfig, override?: { model: string; effort: string }): string {
  if (!config.enabled) return "";
  const allowedRoles = new Set(config.roles);
  const profiles = CODEX_SUBAGENT_PROFILE_SPECS.filter((profile) => allowedRoles.has(profile.role));
  return [
    'install -d -m 0700 "$CODEX_HOME/agents"',
    ...profiles.flatMap((profile) => [
      `cat > "$CODEX_HOME/agents/${profile.fileName}" <<'A2A_CODEX_AGENT_PROFILE_EOF'`,
      override ? profile.contents.replace(/^model = .*$/m, `model = "${override.model}"`).replace(/^model_reasoning_effort = .*$/m, `model_reasoning_effort = "${override.effort}"`) : profile.contents,
      "A2A_CODEX_AGENT_PROFILE_EOF",
      `chmod 0600 "$CODEX_HOME/agents/${profile.fileName}"`,
    ]),
  ].join("\n");
}

// codex 0.144.1 부터 `agents` 는 **역할 이름 → AgentRoleToml 의 테이블**이다.
// 스칼라 키(`agents.enabled`, `agents.max_concurrent_threads_per_session`)를 주면
// codex 는 그것을 "그 이름을 가진 역할"로 읽고 타입 오류로 기동 자체를 거부한다:
//
//   Error loading config.toml: invalid type: boolean `false`,
//     expected struct AgentRoleToml in `agents`
//
// 러너 이미지 codex 0.144.1 에서 실측 재현했다 — disabled(`=false`) 와
// enabled(`=true`) 경로가 **둘 다** 죽는다. 키를 생략하면 정상 파싱된다.
// subagent 활성화는 `$CODEX_HOME/agents/` 에 설치하는 역할 프로파일이 이미
// 담당하므로(buildCodexSubagentProfileInstallShell), 이 스칼라 오버라이드는
// 기능적으로도 불필요하다. 비활성일 때는 프로파일을 설치하지 않는 것으로 족하다.
function buildCodexSubagentRosterPrompt(config: RunnerContainedSubagentsConfig, override?: { model: string; effort: string }): string {
  if (!config.enabled) return "";
  const lines = [
    "- Use only the custom A2A agent profiles installed for the allowed helper roles.",
  ];
  if (config.roles.includes("explorer")) {
    lines.push("- Use a2a_explorer for repository inspection and a2a_researcher only for narrow external documentation research. Both use GPT-5.6 Luna with max reasoning and remain read-only evidence helpers.");
  }
  if (config.roles.includes("implementer")) {
    lines.push("- Use a2a_implementer only after assigning one explicit disjoint write set. It stays on GPT-5.6 Sol with high reasoning.");
  }
  if (config.roles.includes("verifier")) {
    lines.push("- Use a2a_verifier from clean-slate inputs for an independent check. It stays on GPT-5.6 Sol with xhigh reasoning.");
  }
  lines.push("- The parent Codex worker keeps its configured model and remains the only finalizer; subagents never own the terminal result or GitHub lifecycle.");
  const text = lines.join("\n");
  return override ? text.replace(/GPT-5\.6 (?:Luna|Sol) with (?:max|high|xhigh) reasoning/g, `${override.model} with ${override.effort} reasoning`) : text;
}

function buildCodexSubagentModelSummaryShell(config: RunnerContainedSubagentsConfig, override?: { model: string; effort: string }): string {
  if (!config.enabled) return "";
  const lines: string[] = [];
  if (config.roles.includes("explorer")) {
    lines.push("printf 'contained_subagents_explorer_model=gpt-5.6-luna reasoning=max\\n' | tee -a /work/artifacts/summary.txt");
  }
  if (config.roles.includes("implementer")) {
    lines.push("printf 'contained_subagents_implementer_model=gpt-5.6-sol reasoning=high\\n' | tee -a /work/artifacts/summary.txt");
  }
  if (config.roles.includes("verifier")) {
    lines.push("printf 'contained_subagents_verifier_model=gpt-5.6-sol reasoning=xhigh\\n' | tee -a /work/artifacts/summary.txt");
  }
  const text = lines.join("\n");
  return override ? text.replace(/model=gpt-5\.6-(?:luna|sol) reasoning=(?:max|high|xhigh)/g, `model=${override.model} reasoning=${override.effort}`) : text;
}

export function buildCodexPatchCommandScript(env: NodeJS.ProcessEnv): string {
  const defaultModel = shellSingleQuote(env.A2A_CODEX_MODEL || "gpt-5.6-sol");
  const defaultReasoning = shellSingleQuote(env.A2A_CODEX_REASONING_EFFORT || "high");
  const defaultTimeout = shellSingleQuote(env.A2A_CODEX_TIMEOUT_SEC || DEFAULT_CODEX_TIMEOUT_SEC);
  const subagents = loadContainedSubagentsConfig(env, "codex");
  const subagentInstruction = buildContainedSubagentPrompt("Codex", subagents);
  const subagentModelOverride = codexSubagentOverride(env);
  const subagentRosterInstruction = buildCodexSubagentRosterPrompt(subagents, subagentModelOverride);
  const subagentProfileInstall = buildCodexSubagentProfileInstallShell(subagents, subagentModelOverride);
  // #1729 note: codex 0.144.1 rejects scalar agents.* CLI overrides, so none
  // are emitted. They must also never re-enter the exec template inline — an
  // empty interpolation line breaks the shell line-continuation chain and
  // detaches the prompt redirect from `codex exec` (#1731 canary evidence).
  const subagentSummary = buildContainedSubagentSummaryShell(subagents);
  const subagentModelSummary = buildCodexSubagentModelSummaryShell(subagents, subagentModelOverride);
  return renderProfileScript("codex", {
    defaultModel,
    defaultReasoning,
    defaultTimeout,
    subagentProfileInstall,
    subagentSummary,
    subagentModelSummary,
    subagentInstruction,
    subagentRosterInstruction,
  });
}

/**
 * Piri patch-command script (a2a-nexus#1745 Phase 0).
 *
 * Piri is the fleet-owned, modifiable harness, so the output contract lives
 * inside it instead of in an outer patch bridge: when the task provides
 * A2A_PIRI_OUTPUT_SCHEMA, the CLI validates the final answer against the
 * schema and re-prompts on violation (piri --output-schema), and nothing
 * contract-breaking reaches the runner.
 */
export function buildPiriPatchCommandScript(env: NodeJS.ProcessEnv): string {
  const defaultModel = shellSingleQuote(env.A2A_PIRI_MODEL || DEFAULT_PIRI_MODEL);
  const defaultThinking = shellSingleQuote(env.A2A_PIRI_THINKING || DEFAULT_PIRI_THINKING);
  const defaultTimeout = shellSingleQuote(env.A2A_PIRI_TIMEOUT_SEC || DEFAULT_PIRI_TIMEOUT_SEC);
  const defaultOutputSchema = shellSingleQuote(DEFAULT_PIRI_OUTPUT_SCHEMA);
  // piri fanout WS3/WS4 (#1836): the WS1 flag selects a fanout branch — load
  // the baked hardened subagent extension (-e) with a finalizer-superset tool
  // list (-t) and advertise the broker-authorized budget plus the brief
  // pointer in the composed prompt. Flag off (default) emits none of this;
  // the plain `piri -p` script stays byte-for-byte. Read-only tasks keep the
  // read-only head regardless of the flag (fanout is patch-lane only in
  // Phase 2).
  const piriFanoutEnabled = env.A2A_DOCKER_RUNNER_PIRI_FANOUT_ENABLED === "1";
  // piri memory injection (#1797 item 3a): opt-in flag loads the baked memory
  // extension (-e) on both the read-only and patch lanes and surfaces the
  // bounded snapshot contract to the evidence stream. Flag off (default)
  // emits none of this; the plain `piri -p` script stays byte-for-byte.
  const piriMemoryEnabled = env.A2A_DOCKER_RUNNER_PIRI_MEMORY_ENABLED === "1";
  const fanoutSubagents = piriFanoutEnabled ? loadContainedSubagentsConfig(env, "piri") : undefined;
  const fanoutPromptLines = fanoutSubagents?.enabled
    ? `${buildContainedSubagentPrompt("Piri", fanoutSubagents)}\n- Read the shared context brief at /work/artifacts/context-brief.md before spawning helpers (when present); helpers consume it instead of re-deriving task context.`
    : "";
  const fanoutSummaryLines = fanoutSubagents?.enabled
    ? `printf 'piri_fanout=enabled\\n' | tee -a /work/artifacts/summary.txt\n${buildContainedSubagentSummaryShell(fanoutSubagents)}`
    : "";
  return `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
A2A_PIRI_DEFAULT_MODEL=${defaultModel}
A2A_PIRI_DEFAULT_THINKING=${defaultThinking}
A2A_PIRI_DEFAULT_TIMEOUT_SEC=${defaultTimeout}
A2A_PIRI_TIMEOUT_SEC="\${A2A_PIRI_TIMEOUT_SEC:-$A2A_PIRI_DEFAULT_TIMEOUT_SEC}"
A2A_PIRI_MODEL="\${A2A_PIRI_MODEL:-$A2A_PIRI_DEFAULT_MODEL}"
A2A_PIRI_THINKING="\${A2A_PIRI_THINKING:-$A2A_PIRI_DEFAULT_THINKING}"
export A2A_PIRI_MODEL A2A_PIRI_THINKING A2A_PIRI_TIMEOUT_SEC
if [ ! -d /run/secrets/piri-dir ] || [ ! -f /run/secrets/piri-dir/agent/auth.json ]; then
  printf 'error=piri_config_mount_missing\n' | tee -a /work/artifacts/summary.txt
  printf 'Mount a minimal Piri config directory containing agent/auth.json at /run/secrets/piri-dir.\n' | tee /work/artifacts/patch-command.log
  exit 2
fi
if ! command -v piri >/dev/null 2>&1; then
  printf 'error=piri_cli_missing\n' | tee -a /work/artifacts/summary.txt
  printf 'failure_category=piri_cli_unavailable\n' | tee -a /work/artifacts/summary.txt
  printf 'Use an a2a-docker-runner-piri image with the Piri CLI preinstalled.\n' | tee /work/artifacts/patch-command.log
  exit 2
fi
# The mount is read-only while piri writes session/state beside its config, so
# run against a container-local copy and keep the host credential dir intact.
mkdir -p /work/piri-home
cp -a /run/secrets/piri-dir /work/piri-home/.piri
export HOME=/work/piri-home

A2A_LIFECYCLE_GUARD_BIN=/work/a2a-piri-lifecycle-guard-bin
mkdir -p "$A2A_LIFECYCLE_GUARD_BIN"
cat > "$A2A_LIFECYCLE_GUARD_BIN/git" <<'A2A_PIRI_GIT_LIFECYCLE_GUARD'
#!/usr/bin/env bash
case "\${1:-}" in
  add|commit|push|checkout|switch|reset|merge|rebase|tag)
    printf "error=a2a_runner_contract_violation command=git_\${1:-}\n" >&2
    exit 90
    ;;
  branch)
    case "\${2:-}" in
      ""|--show-current|-v|-vv|--list)
        ;;
      *)
        printf "error=a2a_runner_contract_violation command=git_branch_mutation\n" >&2
        exit 90
        ;;
    esac
    ;;
esac
exec /usr/bin/git "$@"
A2A_PIRI_GIT_LIFECYCLE_GUARD
cat > "$A2A_LIFECYCLE_GUARD_BIN/gh" <<'A2A_PIRI_GH_LIFECYCLE_GUARD'
#!/usr/bin/env bash
case "\${1:-} \${2:-}" in
  "pr create"|"pr merge"|"issue close"|"issue comment")
    printf "error=a2a_runner_contract_violation command=gh_\${1:-}_\${2:-}\n" >&2
    exit 90
    ;;
esac
exec /usr/bin/gh "$@"
A2A_PIRI_GH_LIFECYCLE_GUARD
chmod 755 "$A2A_LIFECYCLE_GUARD_BIN/git" "$A2A_LIFECYCLE_GUARD_BIN/gh"
export PATH="$A2A_LIFECYCLE_GUARD_BIN:$PATH"
printf 'lifecycle_guard=enabled profile=piri\n' | tee -a /work/artifacts/summary.txt
${piriFanoutEnabled ? `
# piri fanout WS3 (#1836): fail closed when the flag is on but the image does
# not carry the hardened subagent extension the fanout branch loads.
if [ ! -d /opt/a2a-runner/piri-fanout-extension ]; then
  printf 'error=piri_fanout_extension_missing\n' | tee -a /work/artifacts/summary.txt
  printf 'A2A_DOCKER_RUNNER_PIRI_FANOUT_ENABLED=1 requires an image with the hardened subagent extension baked at /opt/a2a-runner/piri-fanout-extension.\n' | tee /work/artifacts/patch-command.log
  exit 2
fi
${fanoutSummaryLines}
` : ""}
${piriMemoryEnabled ? `
# piri memory injection (#1797 item 3a): fail closed when the flag is on but
# the image does not carry the baked memory extension.
if [ ! -d /opt/a2a-runner/piri-memory-extension ]; then
  printf 'error=piri_memory_extension_missing\n' | tee -a /work/artifacts/summary.txt
  printf 'A2A_DOCKER_RUNNER_PIRI_MEMORY_ENABLED=1 requires an image with the memory extension baked at /opt/a2a-runner/piri-memory-extension.\n' | tee /work/artifacts/patch-command.log
  exit 2
fi
A2A_PIRI_MEMORY_MAX_BYTES="\${A2A_PIRI_MEMORY_MAX_BYTES:-32768}"
if [ -z "\${A2A_PIRI_MEMORY_FILE:-}" ]; then
  if [ -f /run/secrets/piri-memory/MEMORY.md ]; then
    A2A_PIRI_MEMORY_FILE=/run/secrets/piri-memory/MEMORY.md
  else
    A2A_PIRI_MEMORY_FILE=/work/memory.md
  fi
fi
export A2A_PIRI_MEMORY_FILE A2A_PIRI_MEMORY_MAX_BYTES
if [ -f "$A2A_PIRI_MEMORY_FILE" ]; then
  printf 'memory_snapshot=present path=%s bytes=%s\n' "$A2A_PIRI_MEMORY_FILE" "$(wc -c < "$A2A_PIRI_MEMORY_FILE" | tr -d ' ')" | tee -a /work/artifacts/summary.txt
else
  printf 'memory_snapshot=absent path=%s\n' "$A2A_PIRI_MEMORY_FILE" | tee -a /work/artifacts/summary.txt
fi
PIRI_MEMORY_ARGS=(-e /opt/a2a-runner/piri-memory-extension)
` : ""}
printf 'piri_cli=%s\n' "$(piri --version 2>/dev/null | head -n 1 || printf unknown)" | tee -a /work/artifacts/summary.txt
printf 'model=%s thinking=%s profile=piri\n' "$A2A_PIRI_MODEL" "$A2A_PIRI_THINKING" | tee -a /work/artifacts/summary.txt

A2A_PIRI_TASK_MODE="$(jq -r '.mode // ""' /work/task.json 2>/dev/null || true)"
A2A_PIRI_READ_ONLY="$(jq -r 'if .readOnlyValidation == true then "1" else "" end' /work/task.json 2>/dev/null || true)"
if [ -n "$A2A_PIRI_READ_ONLY" ] || printf '%s' "$A2A_PIRI_TASK_MODE" | grep -q 'read-only'; then
  printf 'task_mode=%s read_only=1\n' "$A2A_PIRI_TASK_MODE" | tee -a /work/artifacts/summary.txt
  cat > /work/artifacts/piri-prompt.md <<'A2A_PIRI_RO_PROMPT_EOF'
You are running inside the A2A Docker Runner on a checked-out GitHub repository.

This is a READ-ONLY validation/analysis task. Your only job is to inspect the
repository and answer the assignment. The outer runner owns the git and GitHub
lifecycle after you exit.

Hard rules:
- Do NOT create, modify, or delete any file in the repository checkout or
  anywhere outside /work/artifacts. Findings travel only in your final answer.
- Do not create or switch branches.
- Do not run git add, git commit, git push, git reset, git merge, git rebase, or git tag.
- Do not run gh pr create, gh pr merge, gh issue comment, or gh issue close.
- Cite exact files/symbols as evidence. If the evidence is insufficient, say so
  with status=blocked instead of guessing.
- Your final answer must be the JSON value only; the runner schema-validates it.

The assignment follows:
A2A_PIRI_RO_PROMPT_EOF
${piriFanoutEnabled ? `# Read-only validation tasks keep the read-only head; fanout is not
# available for them in Phase 2 (keeps the first slice small).
PIRI_FANOUT_ARGS=()
` : ""}else
cat > /work/artifacts/piri-prompt.md <<'A2A_PIRI_PROMPT_EOF'
You are running inside the A2A Docker Runner on a checked-out GitHub repository.

Your only job is to edit files in the repository checkout. The outer runner owns
the git and GitHub lifecycle after you exit.

Rules:
- Edit files only. Do not manage the GitHub or git lifecycle yourself.
- Do not create or switch branches.
- Do not run git add, git commit, git push, git reset, git merge, git rebase, or git tag.
- Do not run gh pr create, gh pr merge, gh issue comment, or gh issue close.
- The runner posts Start/PR/Done/Block evidence and creates or reuses the PR after you exit.
- Prefer small focused changes and tests.

Final answer contract:
- After your edits, your final answer must be the JSON value only — no prose,
  no markdown fences. The runner schema-validates it (piri --output-schema).
- Required shape: {"status": "done"|"blocked", "summary": string,
  "findings": string[], "risks": string[], "recommendations": string[],
  "evidenceRefs": string[]}. Summarize what you changed in 'summary' and list
  the files you edited in 'evidenceRefs'.
${fanoutPromptLines ? `${fanoutPromptLines}
` : ""}
The assignment follows:
A2A_PIRI_PROMPT_EOF
${piriFanoutEnabled ? `# piri fanout WS3 (#1836): finalizer-superset tool list; per-child narrowing
# comes from the roster frontmatter tools: (host-side artifact per WS3).
PIRI_FANOUT_ARGS=(-e /opt/a2a-runner/piri-fanout-extension -t subagent,read,grep,find,ls,edit,write,bash)
` : ""}fi
cat /work/artifacts/prompt.md >> /work/artifacts/piri-prompt.md

PIRI_SCHEMA_ARGS=()
A2A_PIRI_DEFAULT_OUTPUT_SCHEMA=${defaultOutputSchema}
A2A_PIRI_OUTPUT_SCHEMA="\${A2A_PIRI_OUTPUT_SCHEMA:-$A2A_PIRI_DEFAULT_OUTPUT_SCHEMA}"
case "$A2A_PIRI_OUTPUT_SCHEMA" in
  off|none|disabled)
    # Explicit opt-out for canary/ab comparisons against unlocked output.
    printf 'output_schema=disabled\n' | tee -a /work/artifacts/summary.txt
    ;;
  "")
    printf 'output_schema=absent\n' | tee -a /work/artifacts/summary.txt
    ;;
  *)
    if [ ! -f "$A2A_PIRI_OUTPUT_SCHEMA" ]; then
      if [ "$A2A_PIRI_OUTPUT_SCHEMA" = "$A2A_PIRI_DEFAULT_OUTPUT_SCHEMA" ]; then
        # Older image without the baked schema: keep running, but make the
        # missing contract visible in the evidence stream.
        printf 'output_schema=missing_default path=%s\n' "$A2A_PIRI_OUTPUT_SCHEMA" | tee -a /work/artifacts/summary.txt
      else
        printf 'error=piri_output_schema_missing path=%s\n' "$A2A_PIRI_OUTPUT_SCHEMA" | tee -a /work/artifacts/summary.txt
        exit 2
      fi
    else
      PIRI_SCHEMA_ARGS=(--output-schema "$A2A_PIRI_OUTPUT_SCHEMA")
      printf 'output_schema=%s\n' "$A2A_PIRI_OUTPUT_SCHEMA" | tee -a /work/artifacts/summary.txt
    fi
    ;;
esac

PIRI_PROGRESS_ARGS=()
A2A_PIRI_PROGRESS_FILE="\${A2A_PIRI_PROGRESS_FILE:-/work/artifacts/piri-progress.jsonl}"
if [ -n "$A2A_PIRI_PROGRESS_FILE" ]; then
  # Feature-detect: older piri builds treat unknown --flags as extension flags
  # and would swallow the value as an extra prompt message.
  if piri --help 2>/dev/null | grep -q -- '--progress-file'; then
    PIRI_PROGRESS_ARGS=(--progress-file "$A2A_PIRI_PROGRESS_FILE")
    printf 'progress_file=%s\n' "$A2A_PIRI_PROGRESS_FILE" | tee -a /work/artifacts/summary.txt
  else
    printf 'progress_file=unsupported_upgrade_piri\n' | tee -a /work/artifacts/summary.txt
  fi
fi

timeout "$A2A_PIRI_TIMEOUT_SEC" piri -p "$(cat /work/artifacts/piri-prompt.md)" \
  --model "$A2A_PIRI_MODEL" \
  --thinking "$A2A_PIRI_THINKING" \
  --approve \
  --no-session \
${piriMemoryEnabled ? `  \${PIRI_MEMORY_ARGS[@]+"\${PIRI_MEMORY_ARGS[@]}"} \
` : ""}  ${piriFanoutEnabled ? `  \${PIRI_FANOUT_ARGS[@]+"\${PIRI_FANOUT_ARGS[@]}"}   ` : ""}\${PIRI_PROGRESS_ARGS[@]+\"\${PIRI_PROGRESS_ARGS[@]}\"} \
  \${PIRI_SCHEMA_ARGS[@]+\"\${PIRI_SCHEMA_ARGS[@]}\"}
`;
}

const CLAUDE_TURN_BUDGET_DEFAULTS = {
  analysis: 10,
  agenticPatch: 40,
  deterministicSingleShot: 6,
  fanoutPatch: 40,
} as const;
const CLAUDE_FANOUT_MAX_TURNS_HARD_CAP = 200;
const CLAUDE_TURN_BUDGET_ENV_KEYS = [
  "A2A_CLAUDE_CODE_ANALYSIS_MAX_TURNS",
  "A2A_CLAUDE_CODE_MAX_TURNS",
  "A2A_CLAUDE_CODE_DETERMINISTIC_MAX_TURNS",
  "A2A_CLAUDE_CODE_PATCH_MAX_TURNS",
  "A2A_CLAUDE_CODE_FANOUT_MAX_TURNS",
] as const;

function explicitClaudeTurnBudget(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): { value: number; key: string } | undefined {
  for (const key of keys) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (Number.isInteger(value) && value > 0) return { value, key };
  }
  return undefined;
}

function projectedClaudeTurnBudget(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
  canonicalDefault: number,
  hardCap?: number,
): RunnerClaudeTurnBudgetValue {
  const explicit = explicitClaudeTurnBudget(env, keys);
  const requested = explicit?.value ?? canonicalDefault;
  const effectiveMaxTurns = hardCap ? Math.min(requested, hardCap) : requested;
  return {
    effectiveMaxTurns,
    source: explicit ? "explicit_override" : "canonical_default",
    ...(explicit ? { overrideKey: explicit.key } : {}),
    ...(hardCap ? { hardCap, hardCapApplied: requested > hardCap } : {}),
  };
}

function resolveClaudePatchMode(env: NodeJS.ProcessEnv): RunnerClaudePatchMode {
  if (env.A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED === "1") return "fanout";
  const requested = (
    env.A2A_DOCKER_RUNNER_CLAUDE_CODE_PATCH_MODE
    || env.A2A_CLAUDE_CODE_PATCH_MODE
    || ""
  ).trim().toLowerCase().replace(/_/g, "-");
  if (requested === "single-shot" || requested === "deterministic-single-shot") {
    return "deterministic-single-shot";
  }
  if (requested === "agentic" || requested === "agentic-patch") return "agentic";
  return "agentic";
}

/**
 * Secret-free doctor projection of the bridge-owned policy.
 *
 * These values do not inject defaults into the container. They make the
 * expected effective values visible before claim, including explicit numeric
 * overrides and the fanout hard cap.
 */
export function projectClaudeCodeTurnBudgets(env: NodeJS.ProcessEnv): RunnerClaudeTurnBudgetProjection {
  return {
    schemaVersion: "a2a.runner.claude-turn-budget-projection.v1",
    activePatchMode: resolveClaudePatchMode(env),
    resolutionOrder: [
      "mode_specific_explicit_override",
      "backward_compatible_mode_alias",
      "canonical_bridge_default",
      "fanout_hard_cap",
    ],
    analysis: projectedClaudeTurnBudget(
      env,
      ["A2A_CLAUDE_CODE_ANALYSIS_MAX_TURNS", "A2A_CLAUDE_CODE_MAX_TURNS"],
      CLAUDE_TURN_BUDGET_DEFAULTS.analysis,
    ),
    agenticPatch: projectedClaudeTurnBudget(
      env,
      ["A2A_CLAUDE_CODE_MAX_TURNS"],
      CLAUDE_TURN_BUDGET_DEFAULTS.agenticPatch,
    ),
    deterministicSingleShot: projectedClaudeTurnBudget(
      env,
      ["A2A_CLAUDE_CODE_DETERMINISTIC_MAX_TURNS", "A2A_CLAUDE_CODE_PATCH_MAX_TURNS"],
      CLAUDE_TURN_BUDGET_DEFAULTS.deterministicSingleShot,
    ),
    fanoutPatch: projectedClaudeTurnBudget(
      env,
      ["A2A_CLAUDE_CODE_FANOUT_MAX_TURNS"],
      CLAUDE_TURN_BUDGET_DEFAULTS.fanoutPatch,
      CLAUDE_FANOUT_MAX_TURNS_HARD_CAP,
    ),
  };
}

function explicitClaudeTurnBudgetExports(env: NodeJS.ProcessEnv): string {
  return CLAUDE_TURN_BUDGET_ENV_KEYS
    .flatMap((key) => {
      const raw = env[key]?.trim();
      const value = raw ? Number(raw) : Number.NaN;
      return Number.isInteger(value) && value > 0
        ? [`export ${key}=${shellSingleQuote(String(value))}`]
        : [];
    })
    .join("\n");
}

export function buildClaudeCodePatchCommandScript(env: NodeJS.ProcessEnv): string {
  const defaultModel = shellSingleQuote(env.A2A_CLAUDE_MODEL || env.A2A_OPENCLAW_MODEL || "sonnet");
  const defaultTimeout = shellSingleQuote(env.A2A_CLAUDE_TIMEOUT_SEC || env.A2A_OPENCLAW_TIMEOUT_SEC || DEFAULT_CLAUDE_CODE_TIMEOUT_SEC);
  const codeTimeout = shellSingleQuote(
    env.A2A_CLAUDE_CODE_TIMEOUT_SEC
      || env.A2A_CLAUDE_TIMEOUT_SEC
      || env.A2A_OPENCLAW_TIMEOUT_SEC
      || DEFAULT_CLAUDE_CODE_TIMEOUT_SEC,
  );
  const bridgePath = shellSingleQuote(env.A2A_CLAUDE_PATCH_BRIDGE || "/opt/a2a-broker/scripts/claude-a2a-patch-bridge.mjs");
  // Agentic is the normal implementation lane. Fanout remains opt-in and the
  // deterministic diff/apply helper remains available through an explicit mode.
  const projectedBudgets = projectClaudeCodeTurnBudgets(env);
  const patchMode = projectedBudgets.activePatchMode === "fanout"
    ? "fanout"
    : projectedBudgets.activePatchMode === "agentic"
      ? "agentic"
      : "single-shot";
  const turnBudgetExports = explicitClaudeTurnBudgetExports(env);
  return renderProfileScript("claude-code", {
    defaultModel,
    defaultTimeout,
    codeTimeout,
    bridgePath,
    patchMode,
    turnBudgetExports,
  });
}

function buildHermesPatchCommandScript(env: NodeJS.ProcessEnv): string {
  const explicitModel = env.A2A_HERMES_MODEL || env.A2A_OPENCLAW_MODEL;
  const defaultModel = shellSingleQuote(explicitModel || "openai-codex/gpt-5.5");
  const modelSource = shellSingleQuote(normalizeRunnerModelSource(env.A2A_DOCKER_RUNNER_MODEL_SOURCE));
  const defaultTimeout = shellSingleQuote(env.A2A_HERMES_TIMEOUT_SEC || env.A2A_OPENCLAW_TIMEOUT_SEC || DEFAULT_HERMES_TIMEOUT_SEC);
  const subagents = loadContainedSubagentsConfig(env, "hermes");
  const subagentInstruction = buildContainedSubagentPrompt("Hermes", subagents);
  const subagentSummary = buildContainedSubagentSummaryShell(subagents);
  return renderProfileScript("hermes", {
    modelSource,
    defaultModel,
    defaultTimeout,
    subagentSummary,
    subagentInstruction,
  });
}

function buildOpenClawPatchCommandScript(env: NodeJS.ProcessEnv): string {
  const agent = shellSingleQuote(env.A2A_OPENCLAW_AGENT_ID || "main");
  const defaultModel = shellSingleQuote(env.A2A_OPENCLAW_MODEL || "openai-codex/gpt-5.5");
  const modelSource = shellSingleQuote(normalizeRunnerModelSource(env.A2A_DOCKER_RUNNER_MODEL_SOURCE));
  const defaultThinking = shellSingleQuote(env.A2A_OPENCLAW_THINKING || "medium");
  const defaultTimeout = shellSingleQuote(env.A2A_OPENCLAW_TIMEOUT_SEC || DEFAULT_OPENCLAW_TIMEOUT_SEC);
  const disableBundledPlugins = shellSingleQuote(env.A2A_OPENCLAW_DISABLE_BUNDLED_PLUGINS || "0");
  const allowNpmInstallFallback = shellSingleQuote(env.A2A_OPENCLAW_ALLOW_NPM_INSTALL_FALLBACK || "0");
  const subagents = loadContainedSubagentsConfig(env, "openclaw");
  const subagentInstruction = buildContainedSubagentPrompt("OpenClaw", subagents);
  const subagentSummary = buildContainedSubagentSummaryShell(subagents);
  return renderProfileScript("openclaw", {
    disableBundledPlugins,
    allowNpmInstallFallback,
    modelSource,
    defaultModel,
    defaultThinking,
    defaultTimeout,
    agent,
    subagentSummary,
    subagentInstruction,
  });
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildContainedSubagentPrompt(
  label: "OpenClaw" | "Hermes" | "Codex" | "Piri",
  config: RunnerContainedSubagentsConfig,
): string {
  if (!config.enabled) {
    return [
      "",
      "Contained subagents:",
      `- Do not spawn ${label} subagents for this task. This runner keeps subagent fanout disabled unless the host explicitly opts in.`,
      "- If the assignment appears too broad for one contained agent turn, produce Block evidence explaining the split you need.",
    ].join("\n");
  }

  return [
    "",
    "Contained subagents:",
    `- You may spawn up to ${config.maxCount} ${label} subagent(s) inside this same Docker task boundary when the assignment matches these reasons: ${config.reasons.join(", ")}.`,
    `- Allowed helper roles: ${config.roles.join(", ")}.`,
    "- Keep all helper work inside the checked-out repository and the disposable in-container workspace; do not access or mutate host profile mounts.",
    "- Subagents are evidence helpers only. Return one final worker answer and let the runner/broker/finalizer own PR, Done, Block, merge, closeout, and runtime decisions.",
    `- Bound each helper evidence summary to ${config.outputBytes} bytes or less, redact secrets/private paths/session data, and do not include raw transcripts in repository files or comments.`,
    "- If a needed split would exceed the cap or cross the Docker boundary, stop and produce Block evidence instead of unbounded fanout.",
  ].join("\n");
}

function buildContainedSubagentSummaryShell(config: RunnerContainedSubagentsConfig): string {
  const enabled = config.enabled ? "enabled" : "disabled";
  return [
    `printf 'contained_subagents=${enabled}\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'contained_subagents_max=${config.maxCount}\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'contained_subagents_output_bytes=${config.outputBytes}\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'contained_subagents_reasons=${config.reasons.join(",")}\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'contained_subagents_roles=${config.roles.join(",")}\\n' | tee -a /work/artifacts/summary.txt`,
  ].join("\n");
}

function validatePatchExecutorPolicy(
  patchCommand: Pick<RunnerConfig, "commandScript" | "commandJson" | "commandTemplate">,
  extraMounts?: RunnerExtraMount[],
  profile?: RunnerCommandProfile,
): void {
  if (patchCommand.commandTemplate) {
    throw new Error(
      "A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE is disabled for GitHub patch execution; " +
      "use commandScript or commandJson with an OpenClaw, Hermes, Claude Code, or Codex executor",
    );
  }

  const executablePatchCommands = {
    commandScript: patchCommand.commandScript,
    commandJson: patchCommand.commandJson,
    commandTemplate: patchCommand.commandTemplate,
  };

  for (const [key, value] of Object.entries(executablePatchCommands)) {
    if (!value) continue;
    if (referencesClaudeExecutor(value) && profile !== "claude-code") {
      throw new Error(
        `${key} references Claude-in-Docker, which requires A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=claude-code; ` +
        "use OpenClaw, Hermes, Claude Code, or Codex via commandScript or commandJson",
      );
    }
    if (!referencesAllowedPatchExecutor(value, profile)) {
      throw new Error(
        `${key} must invoke an allowed Docker patch executor: OpenClaw, Hermes, Claude Code, or Codex`,
      );
    }
  }

  for (const mount of extraMounts ?? []) {
    if (profile !== "claude-code" && (referencesClaudeMount(mount.source) || referencesClaudeMount(mount.target))) {
      throw new Error(
        "extraMounts reference Claude credentials, which require A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=claude-code; " +
        "mount only the active profile credentials or scratch paths",
      );
    }
    if (profile !== "codex" && (referencesCodexMount(mount.source) || referencesCodexMount(mount.target))) {
      throw new Error(
        "extraMounts reference Codex credentials, which require A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=codex; " +
        "mount only the active profile credentials or scratch paths",
      );
    }
  }
}


function referencesClaudeExecutor(value: string): boolean {
  return [
    /@anthropic-ai\/claude-code/i,
    /(^|[\s;|&"'`])claude([\s;|&"'`-]|$)/i,
    /\.claude(?:\.json|\/|$)/i,
    /claude-(?:install|output|prompt)\.log|claude-prompt\.md/i,
  ].some((pattern) => pattern.test(value));
}

function referencesClaudeMount(value: string): boolean {
  return /(^|\/)\.claude(?:\.json|\/|$)/i.test(value) || /(^|\/)claude(?:\.json|-dir)?$/i.test(value);
}

function referencesCodexMount(value: string): boolean {
  return /(^|\/)\.codex(?:\/|$)/i.test(value) || /(^|\/)codex-dir$/i.test(value);
}

function referencesAllowedPatchExecutor(value: string, profile?: RunnerCommandProfile): boolean {
  return referencesOpenClawExecutor(value)
    || referencesHermesExecutor(value)
    || referencesCodexExecutor(value)
    || referencesPiriExecutor(value)
    || (profile === "claude-code" && referencesClaudeExecutor(value));
}

function referencesOpenClawExecutor(value: string): boolean {
  return [
    /(^|[\s;|&"'`/])openclaw([\s;|&"'`-]|$)/i,
    /node_modules\/openclaw\//i,
    /npm\s+(?:install|i)\s+(?:-g\s+)?openclaw/i,
  ].some((pattern) => pattern.test(value));
}

function referencesHermesExecutor(value: string): boolean {
  return [
    /(^|[\s;|&"'`/])hermes([\s;|&"'`-]|$)/i,
    /hermes-agent/i,
    /NousResearch\/hermes-agent/i,
  ].some((pattern) => pattern.test(value));
}

function referencesCodexExecutor(value: string): boolean {
  return [
    /(^|[\s;|&"'`/])codex([\s;|&"'`-]|$)/i,
    /@openai\/codex/i,
    /openai-codex/i,
  ].some((pattern) => pattern.test(value));
}

function referencesPiriExecutor(value: string): boolean {
  return [
    /(^|[\s;|&"'`/])piri([\s;|&"'`-]|$)/i,
    /jinwon-int\/piri/i,
  ].some((pattern) => pattern.test(value));
}

function normalizeEngine(value?: string): RunnerEngine | undefined {
  if (value === "docker" || value === "podman") return value;
  if (!value) return undefined;
  throw new Error(`unsupported container engine: ${value}`);
}

function detectEngine(): RunnerEngine {
  for (const engine of ["docker", "podman"] as const) {
    const result = spawnSync(engine, ["--version"], { stdio: "ignore" });
    if (result.status === 0) return engine;
  }
  throw new Error("neither docker nor podman is available");
}
