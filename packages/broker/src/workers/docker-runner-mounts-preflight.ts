/**
 * Docker-runner extra-mounts readiness preflight (#1601 churn-relief slice).
 *
 * Extracted verbatim from worker.ts (the file was 2,948 lines and a top-churn
 * hotspot); the validation logic, error messages, and env names are unchanged.
 * Pure functions + env in, throws out — no broker runtime state.
 */

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBooleanEnv(value: string | undefined, fallback = false): boolean {
  const normalized = optionalTrimmed(value)?.toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export interface DockerRunnerExtraMountForPreflight {
  source: string;
  target: string;
  readOnly?: boolean;
}

export function parseDockerRunnerExtraMount(entry: unknown, index: number): DockerRunnerExtraMountForPreflight {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`docker runner extra-mounts readiness preflight failed: invalid extra mount at index ${index}: expected object`);
  }
  const record = entry as Record<string, unknown>;
  const source = record.source;
  const target = record.target;
  const readOnly = record.readOnly;
  if (typeof source !== "string" || !source.startsWith("/")) {
    throw new Error(`docker runner extra-mounts readiness preflight failed: invalid extra mount at index ${index}: source must be an absolute path`);
  }
  if (typeof target !== "string" || !target.startsWith("/")) {
    throw new Error(`docker runner extra-mounts readiness preflight failed: invalid extra mount at index ${index}: target must be an absolute path`);
  }
  if (readOnly !== undefined && typeof readOnly !== "boolean") {
    throw new Error(`docker runner extra-mounts readiness preflight failed: invalid extra mount at index ${index}: readOnly must be boolean`);
  }
  return { source, target, readOnly };
}

export function validateDockerRunnerProfileMount(
  mounts: DockerRunnerExtraMountForPreflight[],
  target: string,
  expectedSource: string | undefined,
  profile: string,
  label: string,
): void {
  const matching = mounts.filter((mount) => normalizeDockerRunnerMountPath(mount.target) === target);
  if (matching.length === 0) {
    throw new Error(
      `docker runner extra-mounts readiness preflight failed: invalid A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: ${profile} patch profile requires a ${target} mount; ` +
        `omit A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON or include the ${label} config mount explicitly`,
    );
  }
  if (!expectedSource) {
    return;
  }
  const normalizedExpected = normalizeDockerRunnerMountPath(expectedSource);
  const conflicts = matching.filter((mount) => normalizeDockerRunnerMountPath(mount.source) !== normalizedExpected);
  if (conflicts.length > 0) {
    throw new Error(
      `docker runner extra-mounts readiness preflight failed: invalid A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: ${target} source conflicts with ` +
        `the configured ${label} profile directory; mount the configured ${label} profile directory or omit the duplicate mount`,
    );
  }
}

export function normalizeDockerRunnerPatchProfile(value: unknown): "openclaw" | "hermes" | "claude-code" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "openclaw") return "openclaw";
  if (normalized === "hermes") return "hermes";
  if (normalized === "claude-code" || normalized === "claude" || normalized === "cccb") return "claude-code";
  return undefined;
}

export function normalizeDockerRunnerMountPath(value: string): string {
  return value.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

export function isProtectedDockerRunnerMountPath(value: string): boolean {
  const normalized = normalizeDockerRunnerMountPath(value);
  return [
    /^\/root\/\.openclaw(?:\/|$)/,
    /^\/home\/[^/]+\/\.openclaw(?:\/|$)/,
    /^\/run\/secrets\/openclaw-dir(?:\/|$)/,
    /^\/root\/\.hermes(?:\/|$)/,
    /^\/home\/[^/]+\/\.hermes(?:\/|$)/,
    /^\/run\/secrets\/hermes-dir(?:\/|$)/,
    /^\/root\/\.claude(?:\/|$)/,
    /^\/home\/[^/]+\/\.claude(?:\/|$)/,
    /^\/run\/secrets\/claude-dir(?:\/|$)/,
  ].some((pattern) => pattern.test(normalized));
}

export function validateDockerRunnerExtraMountsReadiness(env: NodeJS.ProcessEnv): void {
  if (parseBooleanEnv(env.A2A_DOCKER_RUNNER_EXTRA_MOUNTS_PREFLIGHT_DISABLED, false)) {
    return;
  }

  const raw = optionalTrimmed(env.A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON);
  if (!raw) {
    return;
  }

  const profile = normalizeDockerRunnerPatchProfile(env.A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `docker runner extra-mounts readiness preflight failed: invalid A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("docker runner extra-mounts readiness preflight failed: invalid A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: expected an array");
  }

  const mounts = parsed.map((entry, index) => parseDockerRunnerExtraMount(entry, index));
  for (const [index, mount] of mounts.entries()) {
    if (mount.readOnly === false && (isProtectedDockerRunnerMountPath(mount.source) || isProtectedDockerRunnerMountPath(mount.target))) {
      throw new Error(
        `docker runner extra-mounts readiness preflight failed: invalid extra mount at index ${index}: writable agent runtime/session paths are forbidden; mount only scratch paths read-write and keep host ~/.openclaw / ~/.hermes sessions read-only`,
      );
    }
  }

  if (profile === "hermes") {
    validateDockerRunnerProfileMount(mounts, "/run/secrets/hermes-dir", env.A2A_DOCKER_RUNNER_HERMES_CONFIG_DIR, "hermes", "Hermes");
  } else if (profile === "openclaw") {
    validateDockerRunnerProfileMount(mounts, "/run/secrets/openclaw-dir", env.A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR, "openclaw", "OpenClaw");
  } else if (profile === "claude-code") {
    validateDockerRunnerProfileMount(mounts, "/run/secrets/claude-dir", env.A2A_DOCKER_RUNNER_CLAUDE_CONFIG_DIR, "claude-code", "Claude Code");
  }
}
