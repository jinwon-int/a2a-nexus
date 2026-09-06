#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export OPENCLAW_DISABLE_BUNDLED_PLUGINS=__A2A_PROFILE_disableBundledPlugins__
export A2A_OPENCLAW_ALLOW_NPM_INSTALL_FALLBACK=__A2A_PROFILE_allowNpmInstallFallback__
export A2A_DOCKER_RUNNER_MODEL_SOURCE=__A2A_PROFILE_modelSource__
A2A_OPENCLAW_DEFAULT_MODEL=__A2A_PROFILE_defaultModel__
if [ -n "${A2A_OPENCLAW_MODEL:-}" ]; then
  export A2A_OPENCLAW_MODEL
elif [ "${A2A_DOCKER_RUNNER_MODEL_SOURCE}" != "native" ]; then
  export A2A_OPENCLAW_MODEL="$A2A_OPENCLAW_DEFAULT_MODEL"
fi
if [ -z "${A2A_OPENCLAW_THINKING:-}" ]; then
  export A2A_OPENCLAW_THINKING=__A2A_PROFILE_defaultThinking__
else
  export A2A_OPENCLAW_THINKING
fi
if [ -z "${A2A_OPENCLAW_TIMEOUT_SEC:-}" ]; then
  export A2A_OPENCLAW_TIMEOUT_SEC=__A2A_PROFILE_defaultTimeout__
else
  export A2A_OPENCLAW_TIMEOUT_SEC
fi

if [ ! -d /run/secrets/openclaw-dir ]; then
  printf 'error=openclaw_config_mount_missing\n' | tee -a /work/artifacts/summary.txt
  printf 'Set A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw and mount an OpenClaw config dir via A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR or A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON.\n' | tee /work/artifacts/patch-command.log
  exit 2
fi

if ! command -v openclaw >/dev/null 2>&1; then
  if [ "${A2A_OPENCLAW_ALLOW_NPM_INSTALL_FALLBACK:-0}" = "1" ]; then
    printf 'notice=openclaw_cli_missing_install_attempted\n' | tee -a /work/artifacts/summary.txt
    if npm install -g openclaw >/work/artifacts/openclaw-install.log 2>&1; then
      printf 'openclaw_cli=installed_via_npm\n' | tee -a /work/artifacts/summary.txt
    else
      install_exit=$?
      printf 'error=openclaw_install_failed\n' | tee -a /work/artifacts/summary.txt
      printf 'failure_category=openclaw_cli_unavailable\n' | tee -a /work/artifacts/summary.txt
      printf 'openclaw_install_exit=%s\n' "$install_exit" | tee -a /work/artifacts/summary.txt
      {
        printf 'Embedded OpenClaw CLI is missing from the runner image and explicit npm install fallback failed.\n'
        printf 'See artifacts/openclaw-install.log for npm output.\n'
        printf 'Use a runner image with OpenClaw preinstalled or an approved trusted read-only OpenClaw CLI/package mount.\n'
      } | tee /work/artifacts/patch-command.log
      exit 2
    fi
  else
    printf 'error=openclaw_cli_missing\n' | tee -a /work/artifacts/summary.txt
    printf 'failure_category=openclaw_cli_unavailable\n' | tee -a /work/artifacts/summary.txt
    printf 'openclaw_install_fallback=disabled\n' | tee -a /work/artifacts/summary.txt
    {
      printf 'Embedded OpenClaw CLI is missing from the runner image and per-task npm install fallback is disabled.\n'
      printf 'Use a runner image with OpenClaw preinstalled or an approved trusted read-only OpenClaw CLI/package mount.\n'
      printf 'Set A2A_OPENCLAW_ALLOW_NPM_INSTALL_FALLBACK=1 only as an explicit compatibility escape hatch.\n'
    } | tee /work/artifacts/patch-command.log
    exit 2
  fi
fi
printf 'openclaw_cli=%s\n' "$(openclaw --version | head -n 1)" | tee -a /work/artifacts/summary.txt

rm -rf /root/.openclaw
mkdir -p /root/.openclaw/agents/__A2A_PROFILE_agent__/agent

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
copy_file_if_exists /run/secrets/openclaw-dir/agents/__A2A_PROFILE_agent__/agent/auth-profiles.json /root/.openclaw/agents/__A2A_PROFILE_agent__/agent/auth-profiles.json
copy_file_if_exists /run/secrets/openclaw-dir/agents/__A2A_PROFILE_agent__/agent/auth-state.json /root/.openclaw/agents/__A2A_PROFILE_agent__/agent/auth-state.json
copy_file_if_exists /run/secrets/openclaw-dir/agents/__A2A_PROFILE_agent__/agent/models.json /root/.openclaw/agents/__A2A_PROFILE_agent__/agent/models.json

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
if [ -z "${A2A_OPENCLAW_MODEL:-}" ] && [ "${A2A_DOCKER_RUNNER_MODEL_SOURCE}" = "native" ]; then
  native_model="$(resolve_openclaw_native_model || true)"
  if [ -z "$native_model" ]; then
    printf 'error=openclaw_native_model_unresolved\n' | tee -a /work/artifacts/summary.txt
    printf 'OpenClaw native model source requested, but no safe model was found in mounted OpenClaw profile config. Set A2A_OPENCLAW_MODEL explicitly or disable native model source.\n' | tee /work/artifacts/patch-command.log
    exit 2
  fi
  export A2A_OPENCLAW_MODEL="$native_model"
  printf 'model_source=native profile=openclaw\n' | tee -a /work/artifacts/summary.txt
else
  printf 'model_source=%s profile=openclaw\n' "${A2A_DOCKER_RUNNER_MODEL_SOURCE}" | tee -a /work/artifacts/summary.txt
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

fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
A2A_SANITIZE_OPENCLAW_CONFIG
fi

# The outer runner shell authenticates gh/git from /run/secrets/gh-hosts.yml and
# exports GH_TOKEN, but embedded OpenClaw tool executions may not inherit that
# shell environment. The gh-issues skill resolves its token from OpenClaw config
# when GH_TOKEN is unavailable, so mirror the ephemeral task token into the
# copied in-container config. This copy lives only inside the disposable runner
# container and is never written to artifacts.
if [ -n "${GH_TOKEN:-}" ] && [ -f /root/.openclaw/openclaw.json ]; then
  export GITHUB_TOKEN="${GITHUB_TOKEN:-$GH_TOKEN}"
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
  fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
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

const backups = walk(root).filter((file) => /.jsonl.bak-[^/]+$/.test(file));
let backupBytes = 0;
for (const file of backups) {
  try { backupBytes += fs.statSync(file).size; } catch {}
}
if (backups.length >= maxBackupCount || backupBytes >= maxBackupBytes) {
  warnings.push("session backup buildup: count=" + backups.length + " bytes=" + backupBytes);
}

for (const warning of warnings) {
  fs.appendFileSync("/work/artifacts/summary.txt", "warning=openclaw_session_store_guard " + warning + "\n");
}
if (errors.length) {
  fs.appendFileSync("/work/artifacts/summary.txt", "error=openclaw_session_store_guard " + errors.join("; ") + "\n");
  fs.writeFileSync("/work/artifacts/patch-command.log", "OpenClaw host session store guard blocked embedded execution. " + errors.join("; ") + "\nRepair/reseed host sessions before retrying; the runner will not mutate host session state.\n");
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
fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
A2A_SET_OPENCLAW_WORKSPACE
fi

printf 'openclaw_config_bytes=%s
' "$(du -sb /root/.openclaw | awk '{print $1}')" | tee -a /work/artifacts/summary.txt
printf 'openclaw_workspace=%s
' "$OPENCLAW_WORKSPACE_DIR" | tee -a /work/artifacts/summary.txt
__A2A_PROFILE_subagentSummary__

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
__A2A_PROFILE_subagentInstruction__
A2A_OPENCLAW_PROMPT_EOF

printf '\n--- A2A assignment ---\n' >> /work/artifacts/openclaw-prompt.md
cat /work/artifacts/prompt.md >> /work/artifacts/openclaw-prompt.md

OPENCLAW_ASSIGNMENT_PROMPT="$(cat /work/artifacts/openclaw-prompt.md)"
set +e
openclaw agent \
  --local \
  --agent __A2A_PROFILE_agent__ \
  --model "$A2A_OPENCLAW_MODEL" \
  --message "$OPENCLAW_ASSIGNMENT_PROMPT" \
  --thinking "$A2A_OPENCLAW_THINKING" \
  --timeout "$A2A_OPENCLAW_TIMEOUT_SEC" \
  --json \
  2>&1 | tee /work/artifacts/openclaw-output.txt
OPENCLAW_EXIT="${PIPESTATUS[0]}"
set -e
printf 'openclaw_exit_code=%s
' "$OPENCLAW_EXIT" | tee -a /work/artifacts/summary.txt
if [ "$OPENCLAW_EXIT" -ne 0 ]; then
  if { [ "${A2A_RUNNER_ALLOW_NO_CHANGES:-0}" = "1" ] || [ "${A2A_RUNNER_READ_ONLY_VALIDATION:-0}" = "1" ]; } \
    && grep -Eiq '(^|[[:space:]*_#-])(Done evidence|Done comment|Done[[:space:]]*[^[:alnum:]]|##[[:space:]]*Done|Block evidence|Block comment|Block[[:space:]]*[^[:alnum:]]|##[[:space:]]*Block)' /work/artifacts/openclaw-output.txt; then
    printf 'notice=openclaw_nonzero_allowed_for_evidence_only_lane exit=%s
' "$OPENCLAW_EXIT" | tee -a /work/artifacts/summary.txt
  else
    printf 'error=openclaw_agent_failed
' | tee -a /work/artifacts/summary.txt
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
        printf '%s
' "$name"
      fi
    done
    for name in $BOOTSTRAP_BANNED_DIRS; do
      if [ -d "$name" ]; then
        found=0
        while IFS= read -r path; do
          found=1
          printf '%s
' "${path#./}"
        done < <(find "$name" -mindepth 1 -print | sort)
        if [ "$found" -eq 0 ]; then
          printf '%s
' "$name"
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
      printf 'notice=scrubbed_ignored_openclaw_bootstrap %s
' "$leak" | tee -a /work/artifacts/summary.txt
    else
      unsafe_bootstrap_leaks="${unsafe_bootstrap_leaks}${leak}
"
    fi
  done <<A2A_BOOTSTRAP_LEAKS
$bootstrap_leaks
A2A_BOOTSTRAP_LEAKS
  if [ -n "$unsafe_bootstrap_leaks" ]; then
    printf 'error=openclaw_workspace_bootstrap_leak
' | tee -a /work/artifacts/summary.txt
    printf 'OpenClaw workspace bootstrap artifacts appeared in the checkout and were not safe to scrub; refusing to produce a PR with runtime context files.
' | tee /work/artifacts/patch-command.log
    printf 'Files detected (repo-relative):
' | tee -a /work/artifacts/patch-command.log
    printf '%s
' "$unsafe_bootstrap_leaks" | tee -a /work/artifacts/patch-command.log
    printf '%s
' "$unsafe_bootstrap_leaks" | sed '/^$/d; s#^#bootstrap_leak=#' >> /work/artifacts/summary.txt
    exit 4
  fi
fi

if [ -z "$(git status --porcelain)" ]; then
  if [ "${A2A_RUNNER_ALLOW_NO_CHANGES:-0}" = "1" ] || [ "${A2A_RUNNER_READ_ONLY_VALIDATION:-0}" = "1" ]; then
    printf 'openclaw_no_changes=allowed\n' | tee -a /work/artifacts/summary.txt
    printf 'OpenClaw produced no repository changes; task-level evidence-only/no-change mode allows runner closeout.\n' | tee -a /work/artifacts/patch-command.log
    exit 0
  fi
  printf 'error=openclaw_completed_without_changes\n' | tee -a /work/artifacts/summary.txt
  printf 'OpenClaw produced no repository changes; refusing false Done.\n' | tee -a /work/artifacts/patch-command.log
  exit 2
fi
