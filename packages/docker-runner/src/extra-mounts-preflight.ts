/**
 * Docker-runner extra-mounts preflight (a2a-nexus#775).
 *
 * The Hermes / OpenClaw patch profiles require a specific config-directory mount
 * (`/run/secrets/hermes-dir`, `/run/secrets/openclaw-dir`). When
 * `A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON` is set but omits the required profile
 * mount (or is otherwise malformed), `loadConfig` throws. In the live path this
 * throw happened *after* the worker had already claimed the A2A task, so the
 * lane was consumed and ended as `handler_exit_nonzero` with no PR/Done/Block
 * evidence URL for the operator/finalizer.
 *
 * This module turns that deterministic, config-only failure into a structured
 * outcome a worker readiness gate can evaluate *before* claim, so it can refuse
 * readiness (or emit Block evidence) instead of burning a lane mid-run.
 *
 * It is a pure function: it does not spawn containers, perform network calls,
 * mutate state, or read secret values. It only inspects runner env vars and the
 * (already secret-free) mount source/target paths, reusing the same validation
 * semantics as `loadConfig` via `loadExtraMounts`.
 */

import {
  ExtraMountsConfigError,
  loadExtraMounts,
  normalizePatchCommandProfile,
} from "./config.js";

/** Patch-command profile relevant to mount selection. */
export type ExtraMountsProfile = "openclaw" | "hermes" | "claude-code" | "codex" | "piri" | "none";

/**
 * Preflight failure classification.
 *
 * - `ok`: mounts (if any) are valid for the active profile.
 * - `hermes_profile_mount_missing` / `openclaw_profile_mount_missing`: an
 *   explicit `A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON` was provided but omits the
 *   required profile config mount.
 * - `profile_mount_source_conflict`: the profile mount points at a source that
 *   conflicts with the configured profile config dir.
 * - `forbidden_writable_runtime_mount`: a writable mount targets a protected
 *   agent runtime/session path.
 * - `extra_mounts_json_invalid` / `extra_mounts_entry_invalid`: the JSON is not
 *   parseable / not an array / an entry is malformed.
 */
export type ExtraMountsPreflightCategory =
  | "ok"
  | "hermes_profile_mount_missing"
  | "openclaw_profile_mount_missing"
  | "claude_code_profile_mount_missing"
  | "codex_profile_mount_missing"
  | "piri_profile_mount_missing"
  | "profile_mount_source_conflict"
  | "forbidden_writable_runtime_mount"
  | "extra_mounts_json_invalid"
  | "extra_mounts_entry_invalid";

/** Structured preflight outcome. */
export interface ExtraMountsPreflightOutcome {
  /** Whether the worker may safely claim a task with this mount configuration. */
  ok: boolean;
  /** The active patch-command profile derived from env. */
  profile: ExtraMountsProfile;
  /** Failure classification for evidence (`ok` when ready). */
  failureCategory: ExtraMountsPreflightCategory;
  /**
   * Bounded, secret-free reason suitable for a worker Block comment. Empty when
   * `ok` is true.
   */
  blockReason: string;
  /** Bounded summary string suitable for artifact manifests. */
  summary: string;
}

const MAX_REASON_LENGTH = 400;

/**
 * Classify the worker's docker-runner extra-mount configuration before a task is
 * claimed. Pure: reads only env vars, never spawns or mutates anything.
 */
export function evaluateExtraMountsPreflight(
  env: NodeJS.ProcessEnv = process.env,
): ExtraMountsPreflightOutcome {
  const profile = normalizePatchCommandProfile(env.A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE) ?? "none";

  try {
    loadExtraMounts(env);
  } catch (error) {
    return buildFailure(profile, error);
  }

  return {
    ok: true,
    profile,
    failureCategory: "ok",
    blockReason: "",
    summary: `extra-mounts preflight: OK, profile=${profile}`,
  };
}

function buildFailure(
  profile: ExtraMountsProfile,
  error: unknown,
): ExtraMountsPreflightOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const failureCategory = classify(profile, error);
  const blockReason = boundReason(message);
  return {
    ok: false,
    profile,
    failureCategory,
    blockReason,
    summary: `extra-mounts preflight: BLOCK, profile=${profile}, category=${failureCategory}`,
  };
}

function classify(
  profile: ExtraMountsProfile,
  error: unknown,
): ExtraMountsPreflightCategory {
  if (error instanceof ExtraMountsConfigError) {
    switch (error.code) {
      case "profile_mount_missing":
        if (profile === "openclaw") return "openclaw_profile_mount_missing";
        if (profile === "claude-code") return "claude_code_profile_mount_missing";
        if (profile === "codex") return "codex_profile_mount_missing";
        if (profile === "piri") return "piri_profile_mount_missing";
        return "hermes_profile_mount_missing";
      case "profile_mount_source_conflict":
        return "profile_mount_source_conflict";
      case "forbidden_writable_runtime_mount":
        return "forbidden_writable_runtime_mount";
      case "extra_mounts_entry_invalid":
        return "extra_mounts_entry_invalid";
      case "extra_mounts_json_invalid":
      default:
        return "extra_mounts_json_invalid";
    }
  }
  // Any non-typed error is treated as an invalid extra-mounts configuration so
  // the worker fails closed rather than claiming a task it cannot execute.
  return "extra_mounts_json_invalid";
}

function boundReason(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return "unknown extra-mounts configuration error";
  return normalized.length <= MAX_REASON_LENGTH
    ? normalized
    : normalized.slice(0, MAX_REASON_LENGTH);
}
