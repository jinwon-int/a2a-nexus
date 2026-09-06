/**
 * Env matrix for the patch-command script golden fixtures (a2a-nexus#2049).
 *
 * Each case pins one `loadConfig(env)` input whose `commandScript` output is
 * captured byte-for-byte in `<name>.sh` next to this file. The goldens were
 * captured from the pre-extraction implementation (main @ 4999551), so the
 * regression test that replays this matrix proves the `profiles/*.sh`
 * extraction reproduces the previously embedded TypeScript templates exactly.
 *
 * The matrix must keep at least one case per extracted profile that exercises
 * every interpolation slot in that profile's template (both the "empty" and
 * "populated" branch of every conditional block substitution), otherwise a
 * placeholder could be dropped without any golden changing.
 *
 * Safety: pure env fixtures. No secrets, no live hosts, no credentials.
 */

/** @type {ReadonlyArray<{ name: string; env: Record<string, string> }>} */
export const PATCH_COMMAND_SCRIPT_GOLDEN_CASES = Object.freeze([
  {
    name: "codex-default",
    env: {
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "codex",
    },
  },
  {
    name: "codex-subagents-all-roles",
    env: {
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "codex",
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED: "1",
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX: "4",
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_OUTPUT_BYTES: "20000",
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_REASONS: "context_heavy,context_overflow_retry",
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES: "explorer,implementer,verifier",
      A2A_CODEX_MODEL: "gpt-5.6-luna",
      A2A_CODEX_REASONING_EFFORT: "max",
      A2A_CODEX_TIMEOUT_SEC: "5400",
    },
  },
  {
    name: "claude-code-default",
    env: {
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "claude-code",
    },
  },
  {
    name: "claude-code-fanout-budgets",
    env: {
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "claude-code",
      A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED: "1",
      A2A_CLAUDE_MODEL: "claude-opus-5",
      A2A_CLAUDE_TIMEOUT_SEC: "4200",
      A2A_CLAUDE_CODE_TIMEOUT_SEC: "4100",
      A2A_CLAUDE_PATCH_BRIDGE: "/opt/a2a-broker/scripts/claude-a2a-patch-bridge.mjs",
      A2A_CLAUDE_CODE_MAX_TURNS: "120",
    },
  },
  {
    name: "hermes-default",
    env: {
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    },
  },
  {
    name: "hermes-native-no-subagents",
    env: {
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
      A2A_DOCKER_RUNNER_MODEL_SOURCE: "native",
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED: "0",
      A2A_HERMES_TIMEOUT_SEC: "3900",
    },
  },
  {
    name: "openclaw-default",
    env: {
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    },
  },
  {
    name: "openclaw-npm-fallback-no-subagents",
    env: {
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED: "0",
      A2A_OPENCLAW_AGENT_ID: "worker-alpha",
      A2A_OPENCLAW_MODEL: "openai-codex/gpt-5.6-sol",
      A2A_OPENCLAW_THINKING: "high",
      A2A_OPENCLAW_TIMEOUT_SEC: "3600",
      A2A_OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      A2A_OPENCLAW_ALLOW_NPM_INSTALL_FALLBACK: "1",
      A2A_DOCKER_RUNNER_MODEL_SOURCE: "native",
    },
  },
]);
