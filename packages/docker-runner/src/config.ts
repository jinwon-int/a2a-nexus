import { existsSync, readFileSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import type {
  RunnerBuildMetadata,
  RunnerCommandProfile,
  RunnerConfig,
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
    network: env.A2A_DOCKER_RUNNER_NETWORK || (trustedOperator && (profile === "openclaw" || profile === "hermes" || profile === "claude-code" || profile === "codex") ? "bridge" : "none"),
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
      errors.push("contained subagents require A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw or hermes");
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

  if (writable && (protectedSource || protectedTarget || protectedHermesSource || protectedHermesTarget || protectedClaudeSource || protectedClaudeTarget || protectedCodexSource || protectedCodexTarget)) {
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

function loadPatchCommandConfig(
  env: NodeJS.ProcessEnv,
): Pick<RunnerConfig, "commandScript" | "commandJson" | "commandTemplate" | "commandProfile" | "openclawProfile" | "hermesProfile" | "claudeCodeProfile" | "codexProfile"> {
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
  const enabled = containedSubagentsEnabledByDefault(env.A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED, effectiveProfile)
    || (effectiveProfile === "claude-code" && env.A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED === "1");
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
  return undefined;
}

export function buildCodexPatchCommandScript(env: NodeJS.ProcessEnv): string {
  const defaultModel = shellSingleQuote(env.A2A_CODEX_MODEL || "gpt-5.6-sol");
  const defaultReasoning = shellSingleQuote(env.A2A_CODEX_REASONING_EFFORT || "high");
  const defaultTimeout = shellSingleQuote(env.A2A_CODEX_TIMEOUT_SEC || DEFAULT_CODEX_TIMEOUT_SEC);
  return `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
A2A_CODEX_DEFAULT_MODEL=${defaultModel}
A2A_CODEX_DEFAULT_REASONING_EFFORT=${defaultReasoning}
A2A_CODEX_DEFAULT_TIMEOUT_SEC=${defaultTimeout}
A2A_CODEX_TIMEOUT_SEC="\${A2A_CODEX_TIMEOUT_SEC:-$A2A_CODEX_DEFAULT_TIMEOUT_SEC}"
A2A_CODEX_MODEL="\${A2A_CODEX_MODEL:-$A2A_CODEX_DEFAULT_MODEL}"
A2A_CODEX_MODEL="\${A2A_CODEX_MODEL#openai-codex/}"
A2A_CODEX_REASONING_EFFORT="\${A2A_CODEX_REASONING_EFFORT:-$A2A_CODEX_DEFAULT_REASONING_EFFORT}"
export A2A_CODEX_MODEL A2A_CODEX_REASONING_EFFORT A2A_CODEX_TIMEOUT_SEC
if [ ! -d /run/secrets/codex-dir ] || [ ! -f /run/secrets/codex-dir/auth.json ]; then
  printf 'error=codex_config_mount_missing\n' | tee -a /work/artifacts/summary.txt
  printf 'Mount a minimal Codex config directory containing auth.json at /run/secrets/codex-dir.\n' | tee /work/artifacts/patch-command.log
  exit 2
fi
if ! command -v codex >/dev/null 2>&1; then
  printf 'error=codex_cli_missing\n' | tee -a /work/artifacts/summary.txt
  printf 'failure_category=codex_cli_unavailable\n' | tee -a /work/artifacts/summary.txt
  printf 'Use an a2a-docker-runner-codex image with Codex CLI preinstalled.\n' | tee /work/artifacts/patch-command.log
  exit 2
fi
rm -rf /tmp/codex-home
install -d -m 0700 /tmp/codex-home
install -m 0600 /run/secrets/codex-dir/auth.json /tmp/codex-home/auth.json
if [ -f /run/secrets/codex-dir/config.toml ]; then
  install -m 0600 /run/secrets/codex-dir/config.toml /tmp/codex-home/config.toml
fi
export CODEX_HOME=/tmp/codex-home
printf 'codex_cli=%s\n' "$(codex --version 2>/dev/null | head -n 1 || printf unknown)" | tee -a /work/artifacts/summary.txt
printf 'model=%s reasoning=%s profile=codex\n' "$A2A_CODEX_MODEL" "$A2A_CODEX_REASONING_EFFORT" | tee -a /work/artifacts/summary.txt
timeout "$A2A_CODEX_TIMEOUT_SEC" codex exec \
  --skip-git-repo-check \
  --ephemeral \
  --json \
  --model "$A2A_CODEX_MODEL" \
  --sandbox danger-full-access \
  -c 'approval_policy="never"' \
  -c "model_reasoning_effort=\"$A2A_CODEX_REASONING_EFFORT\"" \
  -C "$PWD" \
  - < /work/artifacts/prompt.md
`;
}

export function buildClaudeCodePatchCommandScript(env: NodeJS.ProcessEnv): string {
  const defaultModel = shellSingleQuote(env.A2A_CLAUDE_MODEL || env.A2A_OPENCLAW_MODEL || "sonnet");
  const defaultTimeout = shellSingleQuote(env.A2A_CLAUDE_TIMEOUT_SEC || env.A2A_OPENCLAW_TIMEOUT_SEC || DEFAULT_CLAUDE_CODE_TIMEOUT_SEC);
  const bridgePath = shellSingleQuote(env.A2A_CLAUDE_PATCH_BRIDGE || "/opt/a2a-broker/scripts/claude-a2a-patch-bridge.mjs");
  // Phase-2 WS1: opt-in fanout mode. Default (flag unset/!=1) stays single-shot,
  // so behavior is unchanged; rollback = unset A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED.
  const patchMode = env.A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED === "1" ? "fanout" : "single-shot";
  return `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
A2A_CLAUDE_DEFAULT_MODEL=${defaultModel}
if [ -n "\${A2A_CLAUDE_MODEL:-}" ]; then
  export A2A_CLAUDE_MODEL
elif [ -n "\${A2A_OPENCLAW_MODEL:-}" ]; then
  export A2A_CLAUDE_MODEL="$A2A_OPENCLAW_MODEL"
else
  export A2A_CLAUDE_MODEL="$A2A_CLAUDE_DEFAULT_MODEL"
fi
if [ -z "\${A2A_CLAUDE_TIMEOUT_SEC:-}" ]; then
  export A2A_CLAUDE_TIMEOUT_SEC=${defaultTimeout}
else
  export A2A_CLAUDE_TIMEOUT_SEC
fi
if [ ! -d /run/secrets/claude-dir ]; then
  printf 'error=claude_config_mount_missing\\n' | tee -a /work/artifacts/summary.txt
  printf 'Set A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=claude-code and mount a Claude config dir via A2A_DOCKER_RUNNER_CLAUDE_CONFIG_DIR or A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON.\\n' | tee /work/artifacts/patch-command.log
  exit 2
fi
if ! command -v claude >/dev/null 2>&1; then
  printf 'error=claude_cli_missing\\n' | tee -a /work/artifacts/summary.txt
  printf 'failure_category=claude_cli_unavailable\\n' | tee -a /work/artifacts/summary.txt
  printf 'Embedded Claude Code CLI is missing from the runner image. Use a cccb runner image with Claude Code preinstalled.\\n' | tee /work/artifacts/patch-command.log
  exit 2
fi
A2A_CLAUDE_PATCH_BRIDGE=${bridgePath}
if [ ! -f "$A2A_CLAUDE_PATCH_BRIDGE" ]; then
  printf 'error=claude_patch_bridge_missing\\n' | tee -a /work/artifacts/summary.txt
  printf 'Claude Code patch bridge is missing from the runner image: %s\\n' "$A2A_CLAUDE_PATCH_BRIDGE" | tee /work/artifacts/patch-command.log
  exit 2
fi
export HOME=/tmp/claude-home
export CLAUDE_CONFIG_DIR="$HOME/.claude"
rm -rf "$HOME"
install -d -m 0700 "$CLAUDE_CONFIG_DIR"
if [ -d /run/secrets/claude-dir ]; then
  cp -a /run/secrets/claude-dir/. "$CLAUDE_CONFIG_DIR/" 2>/dev/null || true
fi
chmod -R u+rwX "$CLAUDE_CONFIG_DIR"
export A2A_CLAUDE_CODE_PATCH_MODE=${patchMode}
export A2A_CLAUDE_CODE_MAX_OUTPUT_BYTES="\${A2A_CLAUDE_CODE_MAX_OUTPUT_BYTES:-16777216}"
printf 'claude_cli=%s\\n' "$(claude --version 2>/dev/null | head -n 1 || printf unknown)" | tee -a /work/artifacts/summary.txt
printf 'model_source=env profile=claude-code\\n' | tee -a /work/artifacts/summary.txt
printf 'claude_config_bytes=%s\\n' "$(du -sb "$CLAUDE_CONFIG_DIR" | awk '{print $1}')" | tee -a /work/artifacts/summary.txt
TASK_REPO="$(node -e 'const fs=require("node:fs"); const task=JSON.parse(fs.readFileSync("/work/artifacts/task.json", "utf8")); process.stdout.write(String(task.repo || ""));')"
TASK_ISSUE="$(node -e 'const fs=require("node:fs"); const task=JSON.parse(fs.readFileSync("/work/artifacts/task.json", "utf8")); process.stdout.write(String(task.issue || ""));')"
TASK_ISSUE_URL="$(node -e 'const fs=require("node:fs"); const task=JSON.parse(fs.readFileSync("/work/artifacts/task.json", "utf8")); process.stdout.write(String(task.issueUrl || ""));')"
ASSIGNMENT="$(printf 'GitHub development assignment\\nRepository: %s\\nIssue: %s\\nIssue URL: %s\\n\\n%s' "$TASK_REPO" "$TASK_ISSUE" "$TASK_ISSUE_URL" "$(cat /work/artifacts/prompt.md)")"
exec node "$A2A_CLAUDE_PATCH_BRIDGE" agent --json --message "$ASSIGNMENT"
`;
}

function buildHermesPatchCommandScript(env: NodeJS.ProcessEnv): string {
  const explicitModel = env.A2A_HERMES_MODEL || env.A2A_OPENCLAW_MODEL;
  const defaultModel = shellSingleQuote(explicitModel || "openai-codex/gpt-5.5");
  const modelSource = shellSingleQuote(normalizeRunnerModelSource(env.A2A_DOCKER_RUNNER_MODEL_SOURCE));
  const defaultTimeout = shellSingleQuote(env.A2A_HERMES_TIMEOUT_SEC || env.A2A_OPENCLAW_TIMEOUT_SEC || DEFAULT_HERMES_TIMEOUT_SEC);
  const subagents = loadContainedSubagentsConfig(env, "hermes");
  const subagentInstruction = buildContainedSubagentPrompt("Hermes", subagents);
  const subagentSummary = buildContainedSubagentSummaryShell(subagents);
  return `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export A2A_DOCKER_RUNNER_MODEL_SOURCE=${modelSource}
A2A_HERMES_DEFAULT_MODEL=${defaultModel}
if [ -n "\${A2A_HERMES_MODEL:-}" ]; then
  export A2A_HERMES_MODEL
elif [ -n "\${A2A_OPENCLAW_MODEL:-}" ]; then
  # Backward-compatible bridge for task-level workerModel overrides. The
  # normalizer mirrors workerModel to A2A_HERMES_MODEL, but older task payloads
  # and hand-authored runner env may still only carry A2A_OPENCLAW_MODEL. Honor
  # that before falling back to the host-generated legacy default (#860).
  export A2A_HERMES_MODEL="$A2A_OPENCLAW_MODEL"
elif [ "\${A2A_DOCKER_RUNNER_MODEL_SOURCE}" != "native" ]; then
  export A2A_HERMES_MODEL="$A2A_HERMES_DEFAULT_MODEL"
fi
if [ -z "\${A2A_HERMES_TIMEOUT_SEC:-}" ]; then
  export A2A_HERMES_TIMEOUT_SEC=${defaultTimeout}
else
  export A2A_HERMES_TIMEOUT_SEC
fi

if [ ! -d /run/secrets/hermes-dir ]; then
  printf 'error=hermes_config_mount_missing\\n' | tee -a /work/artifacts/summary.txt
  printf 'Set A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=hermes and mount a Hermes config dir via A2A_DOCKER_RUNNER_HERMES_CONFIG_DIR or A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON.\\n' | tee /work/artifacts/patch-command.log
  exit 2
fi

if ! command -v hermes >/dev/null 2>&1; then
  printf 'error=hermes_cli_missing\\n' | tee -a /work/artifacts/summary.txt
  printf 'failure_category=hermes_cli_unavailable\\n' | tee -a /work/artifacts/summary.txt
  printf 'Embedded Hermes CLI is missing from the runner image. Use a runner image with Hermes Agent preinstalled.\\n' | tee /work/artifacts/patch-command.log
  exit 2
fi
printf 'hermes_cli=%s\\n' "$(hermes --version | head -n 1)" | tee -a /work/artifacts/summary.txt

export HOME=/work
export HERMES_HOME=/work/.hermes
rm -rf "$HERMES_HOME"
mkdir -p "$HERMES_HOME"

copy_file_if_exists() {
  src="$1"
  dst="$2"
  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp -p "$src" "$dst"
  fi
}

copy_dir_if_exists() {
  src="$1"
  dst="$2"
  if [ -d "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
  fi
}

# Copy only the files Hermes needs for this disposable container. Avoid broad
# session/log/cache copies and keep the mounted host profile read-only.
copy_file_if_exists /run/secrets/hermes-dir/config.yaml "$HERMES_HOME/config.yaml"
copy_file_if_exists /run/secrets/hermes-dir/.env "$HERMES_HOME/.env"
copy_file_if_exists /run/secrets/hermes-dir/auth.json "$HERMES_HOME/auth.json"
copy_file_if_exists /run/secrets/hermes-dir/honcho.json "$HERMES_HOME/honcho.json"
copy_dir_if_exists /run/secrets/hermes-dir/skills "$HERMES_HOME/skills"

resolve_hermes_native_model() {
  node <<'A2A_RESOLVE_HERMES_NATIVE_MODEL'
const fs = require("node:fs");
const candidates = [];
function stripMatchingQuotes(value) {
  if (value.length >= 2) {
    const first = value.charCodeAt(0);
    const last = value.charCodeAt(value.length - 1);
    if ((first === 39 && last === 39) || (first === 34 && last === 34)) {
      return value.slice(1, -1);
    }
  }
  return value;
}
function add(value) {
  if (typeof value !== "string") return;
  const compact = stripMatchingQuotes(value.trim());
  if (compact) candidates.push(compact);
}
function hasSecretAssignmentMarker(value) {
  const lower = value.toLowerCase();
  let compact = "";
  for (const ch of lower) {
    if (ch !== " " && ch !== String.fromCharCode(9)) compact += ch;
  }
  return compact.includes("token=") || compact.includes("token:")
    || compact.includes("secret=") || compact.includes("secret:")
    || compact.includes("password=") || compact.includes("password:")
    || compact.includes("apikey=") || compact.includes("apikey:")
    || compact.includes("api_key=") || compact.includes("api_key:")
    || compact.includes("api-key=") || compact.includes("api-key:");
}
function safeCandidate(value) {
  const compact = typeof value === "string" ? value.trim() : "";
  if (!compact) return false;
  if (compact.includes(String.fromCharCode(10)) || compact.includes(String.fromCharCode(13))) return false;
  if (hasSecretAssignmentMarker(compact)) return false;
  const canonical = compact === "deepseek-v4-flash" ? "deepseek/deepseek-v4-flash" : compact;
  if (canonical === "deepseek/deepseek-v4-flash") return false;
  return true;
}
try {
  const envText = fs.readFileSync(process.env.HERMES_HOME + "/.env", "utf8");
  for (const rawLine of envText.split(String.fromCharCode(10))) {
    const trimmed = rawLine.replace(String.fromCharCode(13), "").trim();
    const line = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const name = line.slice(0, eq).trim();
    if (!["A2A_HERMES_MODEL", "HERMES_MODEL", "MODEL"].includes(name)) continue;
    add(line.slice(eq + 1));
  }
} catch {}
try {
  const yaml = fs.readFileSync(process.env.HERMES_HOME + "/config.yaml", "utf8");
  let provider = "";
  let model = "";
  for (const rawLine of yaml.split(String.fromCharCode(10))) {
    const noComment = rawLine.split("#", 1)[0].trim();
    const colon = noComment.indexOf(":");
    if (colon < 0) continue;
    const key = noComment.slice(0, colon).trim();
    const value = stripMatchingQuotes(noComment.slice(colon + 1).trim());
    if (key === "model" && !model) model = value;
    if (key === "provider" && !provider) provider = value;
  }
  if (model && provider && !model.includes("/") && !["openai", "anthropic", "google", "xai", "minimax", "deepseek"].includes(model.toLowerCase())) add(provider + "/" + model);
  add(model);
} catch {}
const selected = candidates.find(safeCandidate);
if (selected) process.stdout.write(selected);
A2A_RESOLVE_HERMES_NATIVE_MODEL
}
if [ -z "\${A2A_HERMES_MODEL:-}" ] && [ "\${A2A_DOCKER_RUNNER_MODEL_SOURCE}" = "native" ]; then
  native_model="$(resolve_hermes_native_model || true)"
  if [ -z "$native_model" ]; then
    printf 'error=hermes_native_model_unresolved\\n' | tee -a /work/artifacts/summary.txt
    printf 'Hermes native model source requested, but no safe model was found in mounted Hermes profile config/.env. Set A2A_HERMES_MODEL explicitly or disable native model source.\\n' | tee /work/artifacts/patch-command.log
    exit 2
  fi
  export A2A_HERMES_MODEL="$native_model"
  printf 'model_source=native profile=hermes\\n' | tee -a /work/artifacts/summary.txt
else
  printf 'model_source=%s profile=hermes\\n' "\${A2A_DOCKER_RUNNER_MODEL_SOURCE}" | tee -a /work/artifacts/summary.txt
fi

chmod -R u+rwX "$HERMES_HOME"
export HERMES_ACCEPT_HOOKS=1
export HERMES_SOURCE=a2a-docker-runner
export HERMES_WORKSPACE_DIR=/work/hermes-agent-workspace
mkdir -p "$HERMES_WORKSPACE_DIR"
printf 'hermes_config_bytes=%s\n' "$(du -sb "$HERMES_HOME" | awk '{print $1}')" | tee -a /work/artifacts/summary.txt
printf 'hermes_workspace=%s\n' "$HERMES_WORKSPACE_DIR" | tee -a /work/artifacts/summary.txt
${subagentSummary}

A2A_LIFECYCLE_GUARD_BIN=/work/a2a-lifecycle-guard-bin
mkdir -p "$A2A_LIFECYCLE_GUARD_BIN"
cat > "$A2A_LIFECYCLE_GUARD_BIN/git" <<'A2A_GIT_LIFECYCLE_GUARD'
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
A2A_GIT_LIFECYCLE_GUARD
cat > "$A2A_LIFECYCLE_GUARD_BIN/gh" <<'A2A_GH_LIFECYCLE_GUARD'
#!/usr/bin/env bash
case "\${1:-} \${2:-}" in
  "pr create"|"pr merge"|"issue close"|"issue comment")
    printf "error=a2a_runner_contract_violation command=gh_\${1:-}_\${2:-}\n" >&2
    exit 90
    ;;
esac
exec /usr/bin/gh "$@"
A2A_GH_LIFECYCLE_GUARD
chmod 755 "$A2A_LIFECYCLE_GUARD_BIN/git" "$A2A_LIFECYCLE_GUARD_BIN/gh"
export PATH="$A2A_LIFECYCLE_GUARD_BIN:$PATH"
printf 'lifecycle_guard=enabled profile=hermes\n' | tee -a /work/artifacts/summary.txt

cat > /work/artifacts/hermes-prompt.md <<'A2A_HERMES_PROMPT_EOF'
You are running inside the A2A Docker Runner on a checked-out GitHub repository.

The repository is checked out at /work/repo (or /work/<repo-name> for named checkouts).
Your only job is to edit files in the repository checkout.

Use /work/artifacts/prompt.md as the assignment. Complete a minimal, safe patch in the repository only.

Rules:
- Use Hermes tools available inside this container.
- Edit files only. Do not manage the GitHub or git lifecycle yourself.
- Do not create or switch branches.
- Do not run git add, git commit, git push, git reset, git merge, git rebase, or git tag.
- Do not run gh pr create, gh pr merge, gh issue comment, or gh issue close.
- The runner posts Start/PR/Done/Block evidence and creates the PR after you exit.
- Do not write secrets, host-specific private paths, raw session dumps, or Hermes runtime files into the repository.
- Prefer small focused changes and tests.
- If the assignment is unsafe or impossible, explain why and exit non-zero without changing files.
- If no safe code/doc change is needed, exit non-zero so the runner posts Block evidence instead of a false Done.
${subagentInstruction}
A2A_HERMES_PROMPT_EOF

printf '\\n--- A2A assignment ---\\n' >> /work/artifacts/hermes-prompt.md
cat /work/artifacts/prompt.md >> /work/artifacts/hermes-prompt.md

HERMES_ASSIGNMENT_PROMPT="$(cat /work/artifacts/hermes-prompt.md)"
set +e
timeout "$A2A_HERMES_TIMEOUT_SEC" hermes chat \\
  --query "$HERMES_ASSIGNMENT_PROMPT" \\
  --model "$A2A_HERMES_MODEL" \\
  --quiet \\
  --yolo \\
  --source a2a-docker-runner \\
  2>&1 | tee /work/artifacts/hermes-output.txt
HERMES_EXIT="\${PIPESTATUS[0]}"
set -e
printf 'hermes_exit_code=%s\n' "$HERMES_EXIT" | tee -a /work/artifacts/summary.txt
A2A_RUNNER_BASE_BRANCH="\${A2A_RUNNER_BASE_BRANCH:-main}"
hermes_changes_visible_to_runner() {
  if [ -n "$(git status --porcelain)" ]; then
    return 0
  fi
  if git rev-parse --verify "origin/$A2A_RUNNER_BASE_BRANCH" >/dev/null 2>&1 \
    && ! git diff --quiet "origin/$A2A_RUNNER_BASE_BRANCH...HEAD"; then
    printf 'notice=hermes_committed_changes_detected base=%s\n' "$A2A_RUNNER_BASE_BRANCH" | tee -a /work/artifacts/summary.txt
    return 0
  fi
  return 1
}
if [ "$HERMES_EXIT" -ne 0 ]; then
  if { [ "\${A2A_RUNNER_ALLOW_NO_CHANGES:-0}" = "1" ] || [ "\${A2A_RUNNER_READ_ONLY_VALIDATION:-0}" = "1" ]; } \
    && grep -Eiq '(^|[[:space:]*_#-])(Done evidence|Done comment|Done[[:space:]]*[^[:alnum:]]|##[[:space:]]*Done|Block evidence|Block comment|Block[[:space:]]*[^[:alnum:]]|##[[:space:]]*Block)' /work/artifacts/hermes-output.txt; then
    printf 'notice=hermes_nonzero_allowed_for_evidence_only_lane exit=%s\n' "$HERMES_EXIT" | tee -a /work/artifacts/summary.txt
  elif hermes_changes_visible_to_runner; then
    printf 'notice=hermes_nonzero_with_visible_changes exit=%s changes=present\n' "$HERMES_EXIT" | tee -a /work/artifacts/summary.txt
  else
    printf 'error=hermes_agent_failed\n' | tee -a /work/artifacts/summary.txt
    exit "$HERMES_EXIT"
  fi
fi

BOOTSTRAP_BANNED="AGENTS.md BOOTSTRAP.md HEARTBEAT.md IDENTITY.md MEMORY.md SOUL.md TOOLS.md USER.md"
BOOTSTRAP_BANNED_DIRS=".openclaw .hermes memory"
find_bootstrap_leaks() {
  repo_dir="$1"
  (
    cd "$repo_dir"
    for name in $BOOTSTRAP_BANNED; do
      if [ -e "$name" ]; then
        printf '%s\n' "$name"
      fi
    done
    for name in $BOOTSTRAP_BANNED_DIRS; do
      if [ -d "$name" ]; then
        found=0
        while IFS= read -r path; do
          found=1
          printf '%s\n' "\${path#./}"
        done < <(find "$name" -mindepth 1 -print | sort)
        if [ "$found" -eq 0 ]; then
          printf '%s\n' "$name"
        fi
      fi
    done
  )
}
bootstrap_leaks="$(find_bootstrap_leaks . 2>/dev/null || true)"
if [ -n "$bootstrap_leaks" ]; then
  unsafe_bootstrap_leaks=""
  while IFS= read -r leak; do
    [ -n "$leak" ] || continue
    if [ -e "$leak" ] && [ -z "$(git ls-files -- "$leak")" ] && git check-ignore -q -- "$leak"; then
      rm -rf -- "$leak"
      printf 'notice=scrubbed_ignored_agent_bootstrap %s\n' "$leak" | tee -a /work/artifacts/summary.txt
    else
      unsafe_bootstrap_leaks="\${unsafe_bootstrap_leaks}\${leak}
"
    fi
  done <<A2A_BOOTSTRAP_LEAKS
$bootstrap_leaks
A2A_BOOTSTRAP_LEAKS
  if [ -n "$unsafe_bootstrap_leaks" ]; then
    printf 'error=agent_workspace_bootstrap_leak\n' | tee -a /work/artifacts/summary.txt
    printf 'Agent workspace bootstrap artifacts appeared in the checkout and were not safe to scrub; refusing to produce a PR with runtime context files.\n' | tee /work/artifacts/patch-command.log
    printf 'Files detected (repo-relative):\n' | tee -a /work/artifacts/patch-command.log
    printf '%s\n' "$unsafe_bootstrap_leaks" | tee -a /work/artifacts/patch-command.log
    printf '%s\n' "$unsafe_bootstrap_leaks" | sed '/^$/d; s#^#bootstrap_leak=#' >> /work/artifacts/summary.txt
    exit 4
  fi
fi

A2A_RUNNER_BASE_BRANCH="\${A2A_RUNNER_BASE_BRANCH:-main}"
hermes_changes_visible_to_runner() {
  if [ -n "$(git status --porcelain)" ]; then
    return 0
  fi
  if git rev-parse --verify "origin/$A2A_RUNNER_BASE_BRANCH" >/dev/null 2>&1 \
    && ! git diff --quiet "origin/$A2A_RUNNER_BASE_BRANCH...HEAD"; then
    printf 'notice=hermes_committed_changes_detected base=%s\n' "$A2A_RUNNER_BASE_BRANCH" | tee -a /work/artifacts/summary.txt
    return 0
  fi
  return 1
}

if ! hermes_changes_visible_to_runner; then
  if [ "\${A2A_RUNNER_ALLOW_NO_CHANGES:-0}" = "1" ] || [ "\${A2A_RUNNER_READ_ONLY_VALIDATION:-0}" = "1" ]; then
    printf 'hermes_no_changes=allowed\\n' | tee -a /work/artifacts/summary.txt
    printf 'Hermes produced no repository changes; task-level evidence-only/no-change mode allows runner closeout.\\n' | tee -a /work/artifacts/patch-command.log
    exit 0
  fi
  printf 'error=hermes_completed_without_changes\\n' | tee -a /work/artifacts/summary.txt
  printf 'Hermes produced no repository changes; refusing false Done.\\n' | tee -a /work/artifacts/patch-command.log
  exit 2
fi
`;
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
  return `#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export OPENCLAW_DISABLE_BUNDLED_PLUGINS=${disableBundledPlugins}
export A2A_OPENCLAW_ALLOW_NPM_INSTALL_FALLBACK=${allowNpmInstallFallback}
export A2A_DOCKER_RUNNER_MODEL_SOURCE=${modelSource}
A2A_OPENCLAW_DEFAULT_MODEL=${defaultModel}
if [ -n "\${A2A_OPENCLAW_MODEL:-}" ]; then
  export A2A_OPENCLAW_MODEL
elif [ "\${A2A_DOCKER_RUNNER_MODEL_SOURCE}" != "native" ]; then
  export A2A_OPENCLAW_MODEL="$A2A_OPENCLAW_DEFAULT_MODEL"
fi
if [ -z "\${A2A_OPENCLAW_THINKING:-}" ]; then
  export A2A_OPENCLAW_THINKING=${defaultThinking}
else
  export A2A_OPENCLAW_THINKING
fi
if [ -z "\${A2A_OPENCLAW_TIMEOUT_SEC:-}" ]; then
  export A2A_OPENCLAW_TIMEOUT_SEC=${defaultTimeout}
else
  export A2A_OPENCLAW_TIMEOUT_SEC
fi

if [ ! -d /run/secrets/openclaw-dir ]; then
  printf 'error=openclaw_config_mount_missing\\n' | tee -a /work/artifacts/summary.txt
  printf 'Set A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw and mount an OpenClaw config dir via A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR or A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON.\\n' | tee /work/artifacts/patch-command.log
  exit 2
fi

if ! command -v openclaw >/dev/null 2>&1; then
  if [ "\${A2A_OPENCLAW_ALLOW_NPM_INSTALL_FALLBACK:-0}" = "1" ]; then
    printf 'notice=openclaw_cli_missing_install_attempted\\n' | tee -a /work/artifacts/summary.txt
    if npm install -g openclaw >/work/artifacts/openclaw-install.log 2>&1; then
      printf 'openclaw_cli=installed_via_npm\\n' | tee -a /work/artifacts/summary.txt
    else
      install_exit=$?
      printf 'error=openclaw_install_failed\\n' | tee -a /work/artifacts/summary.txt
      printf 'failure_category=openclaw_cli_unavailable\\n' | tee -a /work/artifacts/summary.txt
      printf 'openclaw_install_exit=%s\\n' "$install_exit" | tee -a /work/artifacts/summary.txt
      {
        printf 'Embedded OpenClaw CLI is missing from the runner image and explicit npm install fallback failed.\\n'
        printf 'See artifacts/openclaw-install.log for npm output.\\n'
        printf 'Use a runner image with OpenClaw preinstalled or an approved trusted read-only OpenClaw CLI/package mount.\\n'
      } | tee /work/artifacts/patch-command.log
      exit 2
    fi
  else
    printf 'error=openclaw_cli_missing\\n' | tee -a /work/artifacts/summary.txt
    printf 'failure_category=openclaw_cli_unavailable\\n' | tee -a /work/artifacts/summary.txt
    printf 'openclaw_install_fallback=disabled\\n' | tee -a /work/artifacts/summary.txt
    {
      printf 'Embedded OpenClaw CLI is missing from the runner image and per-task npm install fallback is disabled.\\n'
      printf 'Use a runner image with OpenClaw preinstalled or an approved trusted read-only OpenClaw CLI/package mount.\\n'
      printf 'Set A2A_OPENCLAW_ALLOW_NPM_INSTALL_FALLBACK=1 only as an explicit compatibility escape hatch.\\n'
    } | tee /work/artifacts/patch-command.log
    exit 2
  fi
fi
printf 'openclaw_cli=%s\\n' "$(openclaw --version | head -n 1)" | tee -a /work/artifacts/summary.txt

rm -rf /root/.openclaw
mkdir -p /root/.openclaw/agents/${agent}/agent

# Copy only the authentication/configuration files needed by the embedded
# OpenClaw process.  Worker hosts can have multi-GB workspaces, caches,
# plugin runtimes, archives, and session logs under ~/.openclaw; a broad copy
# makes Docker patch execution look stuck before the agent even starts.
copy_file_if_exists() {
  src="$1"
  dst="$2"
  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp -p "$src" "$dst"
  fi
}

copy_dir_if_exists() {
  src="$1"
  dst="$2"
  if [ -d "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp -a "$src" "$dst"
  fi
}

copy_file_if_exists /run/secrets/openclaw-dir/openclaw.json /root/.openclaw/openclaw.json
copy_file_if_exists /run/secrets/openclaw-dir/node.json /root/.openclaw/node.json
copy_dir_if_exists /run/secrets/openclaw-dir/credentials /root/.openclaw/credentials
copy_file_if_exists /run/secrets/openclaw-dir/agents/${agent}/agent/auth-profiles.json /root/.openclaw/agents/${agent}/agent/auth-profiles.json
copy_file_if_exists /run/secrets/openclaw-dir/agents/${agent}/agent/auth-state.json /root/.openclaw/agents/${agent}/agent/auth-state.json
copy_file_if_exists /run/secrets/openclaw-dir/agents/${agent}/agent/models.json /root/.openclaw/agents/${agent}/agent/models.json

resolve_openclaw_native_model() {
  node <<'A2A_RESOLVE_OPENCLAW_NATIVE_MODEL'
const fs = require("node:fs");
const configPath = "/root/.openclaw/openclaw.json";
function hasSecretAssignmentMarker(value) {
  const lower = value.toLowerCase();
  let compact = "";
  for (const ch of lower) {
    if (ch !== " " && ch !== String.fromCharCode(9)) compact += ch;
  }
  return compact.includes("token=") || compact.includes("token:")
    || compact.includes("secret=") || compact.includes("secret:")
    || compact.includes("password=") || compact.includes("password:")
    || compact.includes("apikey=") || compact.includes("apikey:")
    || compact.includes("api_key=") || compact.includes("api_key:")
    || compact.includes("api-key=") || compact.includes("api-key:");
}
function clean(value) {
  if (typeof value !== "string") return "";
  const compact = value.trim();
  if (!compact) return "";
  if (compact.includes(String.fromCharCode(10)) || compact.includes(String.fromCharCode(13))) return "";
  if (hasSecretAssignmentMarker(compact)) return "";
  return compact;
}
function modelFrom(entry) {
  return clean(entry?.model?.primary) || clean(entry?.models?.primary) || clean(entry?.model) || "";
}
try {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const agentId = process.env.A2A_OPENCLAW_AGENT_ID || "main";
  const list = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  const active = list.find((entry) => entry && typeof entry === "object" && (entry.id === agentId || entry.name === agentId));
  const selected = modelFrom(active) || modelFrom(config?.agents?.defaults) || modelFrom(config?.defaults);
  if (selected) process.stdout.write(selected);
} catch {}
A2A_RESOLVE_OPENCLAW_NATIVE_MODEL
}
if [ -z "\${A2A_OPENCLAW_MODEL:-}" ] && [ "\${A2A_DOCKER_RUNNER_MODEL_SOURCE}" = "native" ]; then
  native_model="$(resolve_openclaw_native_model || true)"
  if [ -z "$native_model" ]; then
    printf 'error=openclaw_native_model_unresolved\\n' | tee -a /work/artifacts/summary.txt
    printf 'OpenClaw native model source requested, but no safe model was found in mounted OpenClaw profile config. Set A2A_OPENCLAW_MODEL explicitly or disable native model source.\\n' | tee /work/artifacts/patch-command.log
    exit 2
  fi
  export A2A_OPENCLAW_MODEL="$native_model"
  printf 'model_source=native profile=openclaw\\n' | tee -a /work/artifacts/summary.txt
else
  printf 'model_source=%s profile=openclaw\\n' "\${A2A_DOCKER_RUNNER_MODEL_SOURCE}" | tee -a /work/artifacts/summary.txt
fi

if [ -f /root/.openclaw/openclaw.json ]; then
  node <<'A2A_SANITIZE_OPENCLAW_CONFIG'
const fs = require("node:fs");
const path = "/root/.openclaw/openclaw.json";
const config = JSON.parse(fs.readFileSync(path, "utf8"));

// The host gateway config can reference runtime-only plugins, channel targets,
// and API-key providers that are not present inside the short-lived Docker
// patch container. Keep the model/auth information needed by openclaw agent,
// but drop gateway/plugin/channel wiring so config validation does not fail
// before the OAuth-backed agent can start.
delete config.plugins;
delete config.channels;
delete config.gateway;
delete config.cron;
delete config.bindings;
delete config.hooks;
delete config.surfaces;

const selectedModel = process.env.A2A_OPENCLAW_MODEL || "openai-codex/gpt-5.5";
const selectedProvider = selectedModel.includes("/") ? selectedModel.split("/")[0] : "";
const providers = config.models?.providers;
if (providers && typeof providers === "object") {
  const preservedProviders = {};
  for (const providerId of ["openai-codex", selectedProvider]) {
    if (providerId && providers[providerId]) preservedProviders[providerId] = providers[providerId];
  }
  if (Object.keys(preservedProviders).length > 0) {
    config.models.providers = preservedProviders;
  }
}

const defaults = config.agents?.defaults;
if (defaults && typeof defaults === "object") {
  delete defaults.heartbeat;
  delete defaults.silentReply;
  delete defaults.silentReplyRewrite;
  if (defaults.agentRuntime && typeof defaults.agentRuntime === "object") {
    delete defaults.agentRuntime.fallback;
  }
  if (defaults.model && typeof defaults.model === "object") {
    defaults.model.primary = selectedModel;
    defaults.model.fallbacks = [];
  }
  delete defaults.models;
}

const agentList = config.agents?.list;
if (Array.isArray(agentList)) {
  for (const entry of agentList) {
    if (!entry || typeof entry !== "object") continue;
    delete entry.heartbeat;
    delete entry.silentReply;
    delete entry.silentReplyRewrite;
    if (entry.agentRuntime && typeof entry.agentRuntime === "object") {
      delete entry.agentRuntime.fallback;
    }
    delete entry.models;
    if (entry.model && typeof entry.model === "object") {
      entry.model.primary = selectedModel;
      entry.model.fallbacks = [];
    }
  }
}

fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\\n");
A2A_SANITIZE_OPENCLAW_CONFIG
fi

# The outer runner shell authenticates gh/git from /run/secrets/gh-hosts.yml and
# exports GH_TOKEN, but embedded OpenClaw tool executions may not inherit that
# shell environment. The gh-issues skill resolves its token from OpenClaw config
# when GH_TOKEN is unavailable, so mirror the ephemeral task token into the
# copied in-container config. This copy lives only inside the disposable runner
# container and is never written to artifacts.
if [ -n "\${GH_TOKEN:-}" ] && [ -f /root/.openclaw/openclaw.json ]; then
  export GITHUB_TOKEN="\${GITHUB_TOKEN:-$GH_TOKEN}"
  node <<'A2A_INJECT_GITHUB_TOKEN_FOR_OPENCLAW'
const fs = require("node:fs");
const path = "/root/.openclaw/openclaw.json";
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (token) {
  const config = JSON.parse(fs.readFileSync(path, "utf8"));
  config.skills ||= {};
  config.skills.entries ||= {};
  config.skills.entries["gh-issues"] ||= {};
  config.skills.entries["gh-issues"].apiKey = token;
  fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\\n");
}
A2A_INJECT_GITHUB_TOKEN_FOR_OPENCLAW
fi

# Refuse to run if the mounted host OpenClaw session store already looks
# damaged or dangerously backed up. The mount is intentionally read-only, so
# the runner reports/blocks instead of attempting host-side recovery.
node <<'A2A_GUARD_OPENCLAW_SESSION_STORE'
const fs = require("node:fs");
const path = require("node:path");
const root = "/run/secrets/openclaw-dir";
const activeAgentId = process.env.A2A_OPENCLAW_AGENT_ID || "main";
const maxBackupCount = Number(process.env.A2A_OPENCLAW_SESSION_BACKUP_WARN_COUNT || "50");
const maxBackupBytes = Number(process.env.A2A_OPENCLAW_SESSION_BACKUP_WARN_BYTES || String(128 * 1024 * 1024));
const errors = [];
const warnings = [];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return undefined; }
}

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

for (const file of walk(root)) {
  if (!file.endsWith("sessions.json")) continue;
  const parsed = readJson(file);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0) {
    const rel = file.replace(root + "/", "");
    const activeAgentStore = rel === "agents/" + activeAgentId + "/sessions/sessions.json";
    if (activeAgentStore) {
      errors.push("empty active-agent sessions registry: " + file.replace(root, "<openclaw-dir>"));
    } else {
      warnings.push("empty non-active-agent sessions registry ignored: " + file.replace(root, "<openclaw-dir>"));
    }
  }
}

const backups = walk(root).filter((file) => /\.jsonl\.bak-[^/]+$/.test(file));
let backupBytes = 0;
for (const file of backups) {
  try { backupBytes += fs.statSync(file).size; } catch {}
}
if (backups.length >= maxBackupCount || backupBytes >= maxBackupBytes) {
  warnings.push("session backup buildup: count=" + backups.length + " bytes=" + backupBytes);
}

for (const warning of warnings) {
  fs.appendFileSync("/work/artifacts/summary.txt", "warning=openclaw_session_store_guard " + warning + "\\n");
}
if (errors.length) {
  fs.appendFileSync("/work/artifacts/summary.txt", "error=openclaw_session_store_guard " + errors.join("; ") + "\\n");
  fs.writeFileSync("/work/artifacts/patch-command.log", "OpenClaw host session store guard blocked embedded execution. " + errors.join("; ") + "\\nRepair/reseed host sessions before retrying; the runner will not mutate host session state.\\n");
  process.exit(3);
}
A2A_GUARD_OPENCLAW_SESSION_STORE

chmod -R u+rwX /root/.openclaw

# Point embedded OpenClaw at a separate temp workspace directory so
# identity/bootstrap files (AGENTS.md, SOUL.md, etc.) created during
# OpenClaw initialization do not pollute the checked-out repository.
# OpenClaw tools can still access and modify files anywhere in the
# container filesystem; the workspace dir only holds agent runtime
# state, not the repo checkout.
# Ref: a2a-docker-runner#209 regression — agents created bootstrap
# files in /work/repo, causing pre-PR guard false-block with exit 4.
export OPENCLAW_WORKSPACE_DIR="/tmp/openclaw-agent-workspace"
mkdir -p "$OPENCLAW_WORKSPACE_DIR"

# Point the disposable in-container config at the temp workspace so
# OpenClaw does not fall back to cwd (/work/repo) or the host/default
# agent workspace. Config workspace and OPENCLAW_WORKSPACE_DIR must
# agree, otherwise the agent may reset cwd-derived workspace state.
if [ -f /root/.openclaw/openclaw.json ]; then
  node <<'A2A_SET_OPENCLAW_WORKSPACE'
const fs = require("node:fs");
const path = "/root/.openclaw/openclaw.json";
const workspace = process.env.OPENCLAW_WORKSPACE_DIR || process.cwd();
const agentId = process.env.A2A_OPENCLAW_AGENT_ID || "main";
const config = JSON.parse(fs.readFileSync(path, "utf8"));
config.agents ||= {};
config.agents.defaults ||= {};
config.agents.defaults.workspace = workspace;
if (Array.isArray(config.agents.list)) {
  for (const entry of config.agents.list) {
    if (!entry || typeof entry !== "object") continue;
    if (!entry.id || entry.id === agentId) entry.workspace = workspace;
  }
}
fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\\n");
A2A_SET_OPENCLAW_WORKSPACE
fi

printf 'openclaw_config_bytes=%s\n' "$(du -sb /root/.openclaw | awk '{print $1}')" | tee -a /work/artifacts/summary.txt
printf 'openclaw_workspace=%s\n' "$OPENCLAW_WORKSPACE_DIR" | tee -a /work/artifacts/summary.txt
${subagentSummary}

cat > /work/artifacts/openclaw-prompt.md <<'A2A_OPENCLAW_PROMPT_EOF'
You are running inside the A2A Docker Runner on a checked-out GitHub repository.

The repository is checked out at /work/repo (or /work/<repo-name> for named checkouts).
Your OpenClaw workspace is a separate temp directory for agent state only.
Make all code changes in the repository checkout, not your workspace.

Use /work/artifacts/prompt.md as the assignment. Complete a minimal, safe patch in the repository only.

Rules:
- Use OpenClaw tools available inside this container.
- Do not run git commit, git push, or gh pr create; the runner will do that after you exit.
- Do not write secrets, host-specific private paths, or raw session dumps.
- Prefer small focused changes and tests.
- If the assignment is unsafe or impossible, explain why and exit non-zero without changing files.
- If no safe code/doc change is needed, exit non-zero so the runner posts Block evidence instead of a false Done.
${subagentInstruction}
A2A_OPENCLAW_PROMPT_EOF

printf '\\n--- A2A assignment ---\\n' >> /work/artifacts/openclaw-prompt.md
cat /work/artifacts/prompt.md >> /work/artifacts/openclaw-prompt.md

OPENCLAW_ASSIGNMENT_PROMPT="$(cat /work/artifacts/openclaw-prompt.md)"
set +e
openclaw agent \\
  --local \\
  --agent ${agent} \\
  --model "$A2A_OPENCLAW_MODEL" \\
  --message "$OPENCLAW_ASSIGNMENT_PROMPT" \\
  --thinking "$A2A_OPENCLAW_THINKING" \\
  --timeout "$A2A_OPENCLAW_TIMEOUT_SEC" \\
  --json \\
  2>&1 | tee /work/artifacts/openclaw-output.txt
OPENCLAW_EXIT="\${PIPESTATUS[0]}"
set -e
printf 'openclaw_exit_code=%s\n' "$OPENCLAW_EXIT" | tee -a /work/artifacts/summary.txt
if [ "$OPENCLAW_EXIT" -ne 0 ]; then
  if { [ "\${A2A_RUNNER_ALLOW_NO_CHANGES:-0}" = "1" ] || [ "\${A2A_RUNNER_READ_ONLY_VALIDATION:-0}" = "1" ]; } \\
    && grep -Eiq '(^|[[:space:]*_#-])(Done evidence|Done comment|Done[[:space:]]*[^[:alnum:]]|##[[:space:]]*Done|Block evidence|Block comment|Block[[:space:]]*[^[:alnum:]]|##[[:space:]]*Block)' /work/artifacts/openclaw-output.txt; then
    printf 'notice=openclaw_nonzero_allowed_for_evidence_only_lane exit=%s\n' "$OPENCLAW_EXIT" | tee -a /work/artifacts/summary.txt
  else
    printf 'error=openclaw_agent_failed\n' | tee -a /work/artifacts/summary.txt
    exit "$OPENCLAW_EXIT"
  fi
fi

# Fail closed if the embedded agent left its workspace bootstrap/persona files
# in the checkout. These files are prompt/runtime context, not repository
# artifacts, and must never be swept into PRs by broad git-add behavior. Use
# the same ignored-file-aware scanner shape as the runner pre/post guard rather
# than git status, because workspace files may be covered by .gitignore.
BOOTSTRAP_BANNED="AGENTS.md BOOTSTRAP.md HEARTBEAT.md IDENTITY.md MEMORY.md SOUL.md TOOLS.md USER.md"
BOOTSTRAP_BANNED_DIRS=".openclaw memory"
find_bootstrap_leaks() {
  repo_dir="$1"
  (
    cd "$repo_dir"
    for name in $BOOTSTRAP_BANNED; do
      if [ -e "$name" ]; then
        printf '%s\n' "$name"
      fi
    done
    for name in $BOOTSTRAP_BANNED_DIRS; do
      if [ -d "$name" ]; then
        found=0
        while IFS= read -r path; do
          found=1
          printf '%s\n' "\${path#./}"
        done < <(find "$name" -mindepth 1 -print | sort)
        if [ "$found" -eq 0 ]; then
          printf '%s\n' "$name"
        fi
      fi
    done
  )
}
bootstrap_leaks="$(find_bootstrap_leaks . 2>/dev/null || true)"
if [ -n "$bootstrap_leaks" ]; then
  unsafe_bootstrap_leaks=""
  while IFS= read -r leak; do
    [ -n "$leak" ] || continue
    if [ -e "$leak" ] && [ -z "$(git ls-files -- "$leak")" ] && git check-ignore -q -- "$leak"; then
      rm -rf -- "$leak"
      printf 'notice=scrubbed_ignored_openclaw_bootstrap %s\n' "$leak" | tee -a /work/artifacts/summary.txt
    else
      unsafe_bootstrap_leaks="\${unsafe_bootstrap_leaks}\${leak}
"
    fi
  done <<A2A_BOOTSTRAP_LEAKS
$bootstrap_leaks
A2A_BOOTSTRAP_LEAKS
  if [ -n "$unsafe_bootstrap_leaks" ]; then
    printf 'error=openclaw_workspace_bootstrap_leak\n' | tee -a /work/artifacts/summary.txt
    printf 'OpenClaw workspace bootstrap artifacts appeared in the checkout and were not safe to scrub; refusing to produce a PR with runtime context files.\n' | tee /work/artifacts/patch-command.log
    printf 'Files detected (repo-relative):\n' | tee -a /work/artifacts/patch-command.log
    printf '%s\n' "$unsafe_bootstrap_leaks" | tee -a /work/artifacts/patch-command.log
    printf '%s\n' "$unsafe_bootstrap_leaks" | sed '/^$/d; s#^#bootstrap_leak=#' >> /work/artifacts/summary.txt
    exit 4
  fi
fi

if [ -z "$(git status --porcelain)" ]; then
  if [ "\${A2A_RUNNER_ALLOW_NO_CHANGES:-0}" = "1" ] || [ "\${A2A_RUNNER_READ_ONLY_VALIDATION:-0}" = "1" ]; then
    printf 'openclaw_no_changes=allowed\\n' | tee -a /work/artifacts/summary.txt
    printf 'OpenClaw produced no repository changes; task-level evidence-only/no-change mode allows runner closeout.\\n' | tee -a /work/artifacts/patch-command.log
    exit 0
  fi
  printf 'error=openclaw_completed_without_changes\\n' | tee -a /work/artifacts/summary.txt
  printf 'OpenClaw produced no repository changes; refusing false Done.\\n' | tee -a /work/artifacts/patch-command.log
  exit 2
fi
`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildContainedSubagentPrompt(label: "OpenClaw" | "Hermes", config: RunnerContainedSubagentsConfig): string {
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
