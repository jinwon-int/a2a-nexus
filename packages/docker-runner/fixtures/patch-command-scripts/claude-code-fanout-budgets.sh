#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
A2A_CLAUDE_DEFAULT_MODEL='claude-opus-5'
if [ -n "${A2A_CLAUDE_MODEL:-}" ]; then
  export A2A_CLAUDE_MODEL
elif [ -n "${A2A_OPENCLAW_MODEL:-}" ]; then
  export A2A_CLAUDE_MODEL="$A2A_OPENCLAW_MODEL"
else
  export A2A_CLAUDE_MODEL="$A2A_CLAUDE_DEFAULT_MODEL"
fi
if [ -z "${A2A_CLAUDE_TIMEOUT_SEC:-}" ]; then
  export A2A_CLAUDE_TIMEOUT_SEC='4200'
else
  export A2A_CLAUDE_TIMEOUT_SEC
fi
if [ -z "${A2A_CLAUDE_CODE_TIMEOUT_SEC:-}" ]; then
  export A2A_CLAUDE_CODE_TIMEOUT_SEC='4100'
else
  export A2A_CLAUDE_CODE_TIMEOUT_SEC
fi
if [ ! -d /run/secrets/claude-dir ]; then
  printf 'error=claude_config_mount_missing\n' | tee -a /work/artifacts/summary.txt
  printf 'Set A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=claude-code and mount a Claude config dir via A2A_DOCKER_RUNNER_CLAUDE_CONFIG_DIR or A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON.\n' | tee /work/artifacts/patch-command.log
  exit 2
fi
if ! command -v claude >/dev/null 2>&1; then
  printf 'error=claude_cli_missing\n' | tee -a /work/artifacts/summary.txt
  printf 'failure_category=claude_cli_unavailable\n' | tee -a /work/artifacts/summary.txt
  printf 'Embedded Claude Code CLI is missing from the runner image. Use a cccb runner image with Claude Code preinstalled.\n' | tee /work/artifacts/patch-command.log
  exit 2
fi
A2A_CLAUDE_PATCH_BRIDGE='/opt/a2a-broker/scripts/claude-a2a-patch-bridge.mjs'
if [ ! -f "$A2A_CLAUDE_PATCH_BRIDGE" ]; then
  printf 'error=claude_patch_bridge_missing\n' | tee -a /work/artifacts/summary.txt
  printf 'Claude Code patch bridge is missing from the runner image: %s\n' "$A2A_CLAUDE_PATCH_BRIDGE" | tee /work/artifacts/patch-command.log
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
export A2A_CLAUDE_CODE_PATCH_MODE=fanout
# #1855 runner context: the runner pipeline owns the checkout/branch and the
# deterministic post-steps (Auto-patch commit, push, gh pr create). The bridge
# works in the existing checkout and must not demand model-owned PR evidence.
export A2A_CLAUDE_PATCH_RUNNER_CONTEXT=1
export A2A_CLAUDE_CODE_MAX_TURNS='120'
export A2A_CLAUDE_CODE_MAX_OUTPUT_BYTES="${A2A_CLAUDE_CODE_MAX_OUTPUT_BYTES:-16777216}"
printf 'claude_cli=%s\n' "$(claude --version 2>/dev/null | head -n 1 || printf unknown)" | tee -a /work/artifacts/summary.txt
printf 'model_source=env profile=claude-code\n' | tee -a /work/artifacts/summary.txt
printf 'claude_config_bytes=%s\n' "$(du -sb "$CLAUDE_CONFIG_DIR" | awk '{print $1}')" | tee -a /work/artifacts/summary.txt
# One node invocation reads task.json once and emits all three NUL-terminated fields.
{ IFS= read -r -d '' TASK_REPO; IFS= read -r -d '' TASK_ISSUE; IFS= read -r -d '' TASK_ISSUE_URL; } < <(node -e 'const fs=require("node:fs"); const task=JSON.parse(fs.readFileSync("/work/artifacts/task.json", "utf8")); for (const field of [task.repo, task.issue, task.issueUrl]) process.stdout.write(String(field || "").replace(/\n+$/, "") + "\0");')
ASSIGNMENT="$(printf 'GitHub development assignment\nRepository: %s\nIssue: %s\nIssue URL: %s\n\n%s' "$TASK_REPO" "$TASK_ISSUE" "$TASK_ISSUE_URL" "$(cat /work/artifacts/prompt.md)")"
exec node "$A2A_CLAUDE_PATCH_BRIDGE" agent --json --message "$ASSIGNMENT"
