#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export A2A_DOCKER_RUNNER_MODEL_SOURCE='native'
A2A_HERMES_DEFAULT_MODEL='openai-codex/gpt-5.5'
if [ -n "${A2A_HERMES_MODEL:-}" ]; then
  export A2A_HERMES_MODEL
elif [ -n "${A2A_OPENCLAW_MODEL:-}" ]; then
  # Backward-compatible bridge for task-level workerModel overrides. The
  # normalizer mirrors workerModel to A2A_HERMES_MODEL, but older task payloads
  # and hand-authored runner env may still only carry A2A_OPENCLAW_MODEL. Honor
  # that before falling back to the host-generated legacy default (#860).
  export A2A_HERMES_MODEL="$A2A_OPENCLAW_MODEL"
elif [ "${A2A_DOCKER_RUNNER_MODEL_SOURCE}" != "native" ]; then
  export A2A_HERMES_MODEL="$A2A_HERMES_DEFAULT_MODEL"
fi
if [ -z "${A2A_HERMES_TIMEOUT_SEC:-}" ]; then
  export A2A_HERMES_TIMEOUT_SEC='3900'
else
  export A2A_HERMES_TIMEOUT_SEC
fi

if [ ! -d /run/secrets/hermes-dir ]; then
  printf 'error=hermes_config_mount_missing\n' | tee -a /work/artifacts/summary.txt
  printf 'Set A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=hermes and mount a Hermes config dir via A2A_DOCKER_RUNNER_HERMES_CONFIG_DIR or A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON.\n' | tee /work/artifacts/patch-command.log
  exit 2
fi

if ! command -v hermes >/dev/null 2>&1; then
  printf 'error=hermes_cli_missing\n' | tee -a /work/artifacts/summary.txt
  printf 'failure_category=hermes_cli_unavailable\n' | tee -a /work/artifacts/summary.txt
  printf 'Embedded Hermes CLI is missing from the runner image. Use a runner image with Hermes Agent preinstalled.\n' | tee /work/artifacts/patch-command.log
  exit 2
fi
printf 'hermes_cli=%s\n' "$(hermes --version | head -n 1)" | tee -a /work/artifacts/summary.txt

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
if [ -z "${A2A_HERMES_MODEL:-}" ] && [ "${A2A_DOCKER_RUNNER_MODEL_SOURCE}" = "native" ]; then
  native_model="$(resolve_hermes_native_model || true)"
  if [ -z "$native_model" ]; then
    printf 'error=hermes_native_model_unresolved\n' | tee -a /work/artifacts/summary.txt
    printf 'Hermes native model source requested, but no safe model was found in mounted Hermes profile config/.env. Set A2A_HERMES_MODEL explicitly or disable native model source.\n' | tee /work/artifacts/patch-command.log
    exit 2
  fi
  export A2A_HERMES_MODEL="$native_model"
  printf 'model_source=native profile=hermes\n' | tee -a /work/artifacts/summary.txt
else
  printf 'model_source=%s profile=hermes\n' "${A2A_DOCKER_RUNNER_MODEL_SOURCE}" | tee -a /work/artifacts/summary.txt
fi

chmod -R u+rwX "$HERMES_HOME"
export HERMES_ACCEPT_HOOKS=1
export HERMES_SOURCE=a2a-docker-runner
export HERMES_WORKSPACE_DIR=/work/hermes-agent-workspace
mkdir -p "$HERMES_WORKSPACE_DIR"
printf 'hermes_config_bytes=%s
' "$(du -sb "$HERMES_HOME" | awk '{print $1}')" | tee -a /work/artifacts/summary.txt
printf 'hermes_workspace=%s
' "$HERMES_WORKSPACE_DIR" | tee -a /work/artifacts/summary.txt
printf 'contained_subagents=disabled\n' | tee -a /work/artifacts/summary.txt
printf 'contained_subagents_max=0\n' | tee -a /work/artifacts/summary.txt
printf 'contained_subagents_output_bytes=12000\n' | tee -a /work/artifacts/summary.txt
printf 'contained_subagents_reasons=context_heavy,broad_source_inspection,validation_split\n' | tee -a /work/artifacts/summary.txt
printf 'contained_subagents_roles=explorer,verifier\n' | tee -a /work/artifacts/summary.txt

A2A_LIFECYCLE_GUARD_BIN=/work/a2a-lifecycle-guard-bin
mkdir -p "$A2A_LIFECYCLE_GUARD_BIN"
cat > "$A2A_LIFECYCLE_GUARD_BIN/git" <<'A2A_GIT_LIFECYCLE_GUARD'
#!/usr/bin/env bash
case "${1:-}" in
  add|commit|push|checkout|switch|reset|merge|rebase|tag)
    printf "error=a2a_runner_contract_violation command=git_${1:-}
" >&2
    exit 90
    ;;
  branch)
    case "${2:-}" in
      ""|--show-current|-v|-vv|--list)
        ;;
      *)
        printf "error=a2a_runner_contract_violation command=git_branch_mutation
" >&2
        exit 90
        ;;
    esac
    ;;
esac
exec /usr/bin/git "$@"
A2A_GIT_LIFECYCLE_GUARD
cat > "$A2A_LIFECYCLE_GUARD_BIN/gh" <<'A2A_GH_LIFECYCLE_GUARD'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "pr create"|"pr merge"|"issue close"|"issue comment")
    printf "error=a2a_runner_contract_violation command=gh_${1:-}_${2:-}
" >&2
    exit 90
    ;;
esac
exec /usr/bin/gh "$@"
A2A_GH_LIFECYCLE_GUARD
chmod 755 "$A2A_LIFECYCLE_GUARD_BIN/git" "$A2A_LIFECYCLE_GUARD_BIN/gh"
export PATH="$A2A_LIFECYCLE_GUARD_BIN:$PATH"
printf 'lifecycle_guard=enabled profile=hermes
' | tee -a /work/artifacts/summary.txt

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

Contained subagents:
- Do not spawn Hermes subagents for this task. This runner keeps subagent fanout disabled unless the host explicitly opts in.
- If the assignment appears too broad for one contained agent turn, produce Block evidence explaining the split you need.
A2A_HERMES_PROMPT_EOF

printf '\n--- A2A assignment ---\n' >> /work/artifacts/hermes-prompt.md
cat /work/artifacts/prompt.md >> /work/artifacts/hermes-prompt.md

HERMES_ASSIGNMENT_PROMPT="$(cat /work/artifacts/hermes-prompt.md)"
set +e
timeout "$A2A_HERMES_TIMEOUT_SEC" hermes chat \
  --query "$HERMES_ASSIGNMENT_PROMPT" \
  --model "$A2A_HERMES_MODEL" \
  --quiet \
  --yolo \
  --source a2a-docker-runner \
  2>&1 | tee /work/artifacts/hermes-output.txt
HERMES_EXIT="${PIPESTATUS[0]}"
set -e
printf 'hermes_exit_code=%s
' "$HERMES_EXIT" | tee -a /work/artifacts/summary.txt
A2A_RUNNER_BASE_BRANCH="${A2A_RUNNER_BASE_BRANCH:-main}"
hermes_changes_visible_to_runner() {
  if [ -n "$(git status --porcelain)" ]; then
    return 0
  fi
  if git rev-parse --verify "origin/$A2A_RUNNER_BASE_BRANCH" >/dev/null 2>&1     && ! git diff --quiet "origin/$A2A_RUNNER_BASE_BRANCH...HEAD"; then
    printf 'notice=hermes_committed_changes_detected base=%s
' "$A2A_RUNNER_BASE_BRANCH" | tee -a /work/artifacts/summary.txt
    return 0
  fi
  return 1
}
if [ "$HERMES_EXIT" -ne 0 ]; then
  if { [ "${A2A_RUNNER_ALLOW_NO_CHANGES:-0}" = "1" ] || [ "${A2A_RUNNER_READ_ONLY_VALIDATION:-0}" = "1" ]; }     && grep -Eiq '(^|[[:space:]*_#-])(Done evidence|Done comment|Done[[:space:]]*[^[:alnum:]]|##[[:space:]]*Done|Block evidence|Block comment|Block[[:space:]]*[^[:alnum:]]|##[[:space:]]*Block)' /work/artifacts/hermes-output.txt; then
    printf 'notice=hermes_nonzero_allowed_for_evidence_only_lane exit=%s
' "$HERMES_EXIT" | tee -a /work/artifacts/summary.txt
  elif hermes_changes_visible_to_runner; then
    printf 'notice=hermes_nonzero_with_visible_changes exit=%s changes=present
' "$HERMES_EXIT" | tee -a /work/artifacts/summary.txt
  else
    printf 'error=hermes_agent_failed
' | tee -a /work/artifacts/summary.txt
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
      printf 'notice=scrubbed_ignored_agent_bootstrap %s
' "$leak" | tee -a /work/artifacts/summary.txt
    else
      unsafe_bootstrap_leaks="${unsafe_bootstrap_leaks}${leak}
"
    fi
  done <<A2A_BOOTSTRAP_LEAKS
$bootstrap_leaks
A2A_BOOTSTRAP_LEAKS
  if [ -n "$unsafe_bootstrap_leaks" ]; then
    printf 'error=agent_workspace_bootstrap_leak
' | tee -a /work/artifacts/summary.txt
    printf 'Agent workspace bootstrap artifacts appeared in the checkout and were not safe to scrub; refusing to produce a PR with runtime context files.
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

A2A_RUNNER_BASE_BRANCH="${A2A_RUNNER_BASE_BRANCH:-main}"
hermes_changes_visible_to_runner() {
  if [ -n "$(git status --porcelain)" ]; then
    return 0
  fi
  if git rev-parse --verify "origin/$A2A_RUNNER_BASE_BRANCH" >/dev/null 2>&1     && ! git diff --quiet "origin/$A2A_RUNNER_BASE_BRANCH...HEAD"; then
    printf 'notice=hermes_committed_changes_detected base=%s
' "$A2A_RUNNER_BASE_BRANCH" | tee -a /work/artifacts/summary.txt
    return 0
  fi
  return 1
}

if ! hermes_changes_visible_to_runner; then
  if [ "${A2A_RUNNER_ALLOW_NO_CHANGES:-0}" = "1" ] || [ "${A2A_RUNNER_READ_ONLY_VALIDATION:-0}" = "1" ]; then
    printf 'hermes_no_changes=allowed\n' | tee -a /work/artifacts/summary.txt
    printf 'Hermes produced no repository changes; task-level evidence-only/no-change mode allows runner closeout.\n' | tee -a /work/artifacts/patch-command.log
    exit 0
  fi
  printf 'error=hermes_completed_without_changes\n' | tee -a /work/artifacts/summary.txt
  printf 'Hermes produced no repository changes; refusing false Done.\n' | tee -a /work/artifacts/patch-command.log
  exit 2
fi
