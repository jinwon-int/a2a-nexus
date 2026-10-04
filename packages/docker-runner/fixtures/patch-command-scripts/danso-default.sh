#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
# danso patch profile (a2a-nexus#2315). Same contract as the piri lane: danso
# edits files in the checkout, the outer runner pipeline owns git/GitHub.
A2A_DANSO_DEFAULT_MODEL='glm-5.3-flash'
A2A_DANSO_DEFAULT_EFFORT='high'
A2A_DANSO_DEFAULT_TIMEOUT_SEC='3600'
A2A_DANSO_DEFAULT_MAX_TURNS='128'
A2A_DANSO_DEFAULT_PROVIDER_TIMEOUT_SECONDS='300'
A2A_DANSO_DEFAULT_MAX_PROMPT_BYTES='65536'
A2A_DANSO_MODEL="${A2A_DANSO_MODEL:-$A2A_DANSO_DEFAULT_MODEL}"
A2A_DANSO_EFFORT="${A2A_DANSO_EFFORT:-$A2A_DANSO_DEFAULT_EFFORT}"
A2A_DANSO_PATCH_TIMEOUT_SEC="${A2A_DANSO_PATCH_TIMEOUT_SEC:-$A2A_DANSO_DEFAULT_TIMEOUT_SEC}"
A2A_DANSO_PATCH_MAX_TURNS="${A2A_DANSO_PATCH_MAX_TURNS:-$A2A_DANSO_DEFAULT_MAX_TURNS}"
A2A_DANSO_PROVIDER_TIMEOUT_SECONDS="${A2A_DANSO_PROVIDER_TIMEOUT_SECONDS:-$A2A_DANSO_DEFAULT_PROVIDER_TIMEOUT_SECONDS}"
A2A_DANSO_MAX_PROMPT_BYTES="${A2A_DANSO_MAX_PROMPT_BYTES:-$A2A_DANSO_DEFAULT_MAX_PROMPT_BYTES}"
# Fleet worker model ids carry the piri-style provider prefix
# (zai/glm-5.3-flash) or the [1m] context alias; danso takes the bare GLM id.
A2A_DANSO_MODEL="${A2A_DANSO_MODEL#zai/}"
A2A_DANSO_MODEL="${A2A_DANSO_MODEL%\[1m\]}"
case "$A2A_DANSO_MODEL" in
  glm-*)
    case "$A2A_DANSO_MODEL" in
      *[!A-Za-z0-9._-]*)
        printf 'error=danso_model_invalid\n' | tee -a /work/artifacts/summary.txt
        exit 2
        ;;
    esac
    ;;
  *)
    printf 'error=danso_model_unsupported model=%s\n' "$A2A_DANSO_MODEL" | tee -a /work/artifacts/summary.txt
    printf 'The danso patch lane runs the GLM provider only; set A2A_DANSO_MODEL to a glm-* model (for example glm-5.3-flash).\n' | tee /work/artifacts/patch-command.log
    exit 2
    ;;
esac
# Worker thinking levels map onto danso --reasoning-effort; adaptive keeps the
# provider default (no flag).
case "$A2A_DANSO_EFFORT" in
  off) A2A_DANSO_EFFORT=none ;;
  adaptive) A2A_DANSO_EFFORT= ;;
esac
DANSO_EFFORT_ARGS=()
case "$A2A_DANSO_EFFORT" in
  "") ;;
  none|minimal|low|medium|high|xhigh|max) DANSO_EFFORT_ARGS=(--reasoning-effort "$A2A_DANSO_EFFORT") ;;
  *)
    printf 'error=danso_effort_invalid\n' | tee -a /work/artifacts/summary.txt
    exit 2
    ;;
esac
# danso short mode accepts --timeout-seconds 1..3600 and --max-turns 1..128.
case "$A2A_DANSO_PATCH_TIMEOUT_SEC" in
  ""|0*|*[!0-9]*)
    printf 'error=danso_timeout_invalid\n' | tee -a /work/artifacts/summary.txt
    exit 2
    ;;
esac
if [ "$A2A_DANSO_PATCH_TIMEOUT_SEC" -lt 1 ] || [ "$A2A_DANSO_PATCH_TIMEOUT_SEC" -gt 3600 ]; then
  printf 'error=danso_timeout_invalid\n' | tee -a /work/artifacts/summary.txt
  exit 2
fi
case "$A2A_DANSO_PATCH_MAX_TURNS" in
  ""|0*|*[!0-9]*)
    printf 'error=danso_max_turns_invalid\n' | tee -a /work/artifacts/summary.txt
    exit 2
    ;;
esac
if [ "$A2A_DANSO_PATCH_MAX_TURNS" -lt 1 ] || [ "$A2A_DANSO_PATCH_MAX_TURNS" -gt 128 ]; then
  printf 'error=danso_max_turns_invalid\n' | tee -a /work/artifacts/summary.txt
  exit 2
fi
# danso requests are non-streaming, so one reasoning response must finish
# inside --provider-timeout-seconds (1..300; the #2295 analysis canary needed
# 300 at effort=high).
case "$A2A_DANSO_PROVIDER_TIMEOUT_SECONDS" in
  ""|0*|*[!0-9]*)
    printf 'error=danso_provider_timeout_invalid\n' | tee -a /work/artifacts/summary.txt
    exit 2
    ;;
esac
if [ "$A2A_DANSO_PROVIDER_TIMEOUT_SECONDS" -gt 300 ]; then
  printf 'error=danso_provider_timeout_invalid\n' | tee -a /work/artifacts/summary.txt
  exit 2
fi
case "$A2A_DANSO_MAX_PROMPT_BYTES" in
  ""|0*|*[!0-9]*)
    printf 'error=danso_max_prompt_bytes_invalid\n' | tee -a /work/artifacts/summary.txt
    exit 2
    ;;
esac
export A2A_DANSO_MODEL A2A_DANSO_EFFORT A2A_DANSO_PATCH_TIMEOUT_SEC A2A_DANSO_PATCH_MAX_TURNS A2A_DANSO_PROVIDER_TIMEOUT_SECONDS

if [ ! -d /run/secrets/danso-dir ] || [ ! -f /run/secrets/danso-dir/glm.env ]; then
  printf 'error=danso_config_mount_missing\n' | tee -a /work/artifacts/summary.txt
  printf 'Mount a minimal danso config directory containing glm.env at /run/secrets/danso-dir.\n' | tee /work/artifacts/patch-command.log
  exit 2
fi
if [ ! -r /run/secrets/danso-dir/glm.env ]; then
  printf 'error=danso_config_mount_unreadable\n' | tee -a /work/artifacts/summary.txt
  printf 'failure_category=danso_credential_unreadable\n' | tee -a /work/artifacts/summary.txt
  printf 'The container user cannot read /run/secrets/danso-dir/glm.env; align its owner/mode with A2A_DOCKER_RUNNER_USER (see runner doctor).\n' | tee /work/artifacts/patch-command.log
  exit 2
fi
if [ ! -f /work/artifacts/prompt.md ]; then
  printf 'error=danso_prompt_missing\n' | tee -a /work/artifacts/summary.txt
  exit 2
fi
# danso rejects any prompt over 65,536 bytes (exit 2, "prompt must be
# 1..65536 bytes") whether it arrives via argv, --prompt-file or stdin
# (jinwon-int/danso#207); --prompt-file only removes the 128 KiB argv limit.
# Check the size here so an oversized prompt fails before any danso run with
# a message that names the limit. A2A_DANSO_MAX_PROMPT_BYTES follows danso's
# cap if it changes.
A2A_DANSO_PROMPT_BYTES="$(wc -c < /work/artifacts/prompt.md | tr -d '[:space:]')"
printf 'danso_prompt_bytes=%s max=%s\n' "$A2A_DANSO_PROMPT_BYTES" "$A2A_DANSO_MAX_PROMPT_BYTES" | tee -a /work/artifacts/summary.txt
if [ "$A2A_DANSO_PROMPT_BYTES" -eq 0 ]; then
  printf 'error=danso_prompt_empty\n' | tee -a /work/artifacts/summary.txt
  printf 'failure_category=danso_prompt_invalid\n' | tee -a /work/artifacts/summary.txt
  printf '/work/artifacts/prompt.md is empty; danso requires a 1..%s byte prompt.\n' "$A2A_DANSO_MAX_PROMPT_BYTES" | tee /work/artifacts/patch-command.log
  exit 2
fi
if [ "$A2A_DANSO_PROMPT_BYTES" -gt "$A2A_DANSO_MAX_PROMPT_BYTES" ]; then
  printf 'error=danso_prompt_too_large bytes=%s max=%s\n' "$A2A_DANSO_PROMPT_BYTES" "$A2A_DANSO_MAX_PROMPT_BYTES" | tee -a /work/artifacts/summary.txt
  printf 'failure_category=danso_prompt_too_large\n' | tee -a /work/artifacts/summary.txt
  printf 'The task prompt is %s bytes; danso accepts at most %s bytes (A2A_DANSO_MAX_PROMPT_BYTES). Shorten the task message, or raise the limit only if the baked danso accepts larger prompts.\n' "$A2A_DANSO_PROMPT_BYTES" "$A2A_DANSO_MAX_PROMPT_BYTES" | tee /work/artifacts/patch-command.log
  exit 2
fi
if ! command -v danso >/dev/null 2>&1; then
  printf 'error=danso_cli_missing\n' | tee -a /work/artifacts/summary.txt
  printf 'failure_category=danso_cli_unavailable\n' | tee -a /work/artifacts/summary.txt
  printf 'Use an a2a-docker-runner-danso image with the danso CLI preinstalled.\n' | tee /work/artifacts/patch-command.log
  exit 2
fi
# Fail closed on a danso build that lacks a flag this lane depends on. In
# particular the prompt is only ever passed as --prompt-file
# (jinwon-int/danso#206): a prompt in argv dies with E2BIG above 128 KiB
# (a2a-nexus#2313), so there is deliberately no argv fallback.
A2A_DANSO_HELP="$(danso --help 2>/dev/null || true)"
for a2a_danso_flag in --prompt-file --system-context-file --tool-home --sandbox; do
  case "$A2A_DANSO_HELP" in
    *"$a2a_danso_flag"*) ;;
    *)
      printf 'error=danso_cli_flag_unsupported flag=%s\n' "$a2a_danso_flag" | tee -a /work/artifacts/summary.txt
      printf 'failure_category=danso_cli_upgrade_required\n' | tee -a /work/artifacts/summary.txt
      printf 'The danso CLI in this image does not support %s. Rebuild a2a-docker-runner-danso from a danso release that does (--prompt-file: jinwon-int/danso#206); the prompt is never passed through argv.\n' "$a2a_danso_flag" | tee /work/artifacts/patch-command.log
      exit 2
      ;;
  esac
done

# GLM credentials: read only the allowlisted keys from the mounted env file
# (never sourced, never printed). danso reads them from its own environment and
# clears the environment of every tool it runs, so tools never inherit them.
A2A_DANSO_CREDENTIAL_KEYS=""
while IFS= read -r a2a_danso_line || [ -n "$a2a_danso_line" ]; do
  a2a_danso_line="${a2a_danso_line%$'\r'}"
  a2a_danso_line="${a2a_danso_line#"${a2a_danso_line%%[![:space:]]*}"}"
  case "$a2a_danso_line" in
    ""|"#"*) continue ;;
  esac
  a2a_danso_line="${a2a_danso_line#export }"
  a2a_danso_key="${a2a_danso_line%%=*}"
  [ "$a2a_danso_key" != "$a2a_danso_line" ] || continue
  case "$a2a_danso_key" in
    ZAI_API_KEY|DANSO_GLM_BASE_URL|DANSO_GLM_ENDPOINT|DANSO_GLM_THINKING) ;;
    *) continue ;;
  esac
  a2a_danso_value="${a2a_danso_line#*=}"
  case "$a2a_danso_value" in
    \"*\") a2a_danso_value="${a2a_danso_value#\"}"; a2a_danso_value="${a2a_danso_value%\"}" ;;
    \'*\') a2a_danso_value="${a2a_danso_value#\'}"; a2a_danso_value="${a2a_danso_value%\'}" ;;
  esac
  export "$a2a_danso_key=$a2a_danso_value"
  A2A_DANSO_CREDENTIAL_KEYS="${A2A_DANSO_CREDENTIAL_KEYS:+$A2A_DANSO_CREDENTIAL_KEYS,}$a2a_danso_key"
done < /run/secrets/danso-dir/glm.env
unset a2a_danso_line a2a_danso_key a2a_danso_value
if [ -z "${ZAI_API_KEY:-}" ]; then
  printf 'error=danso_glm_credential_missing\n' | tee -a /work/artifacts/summary.txt
  printf 'failure_category=danso_credential_unavailable\n' | tee -a /work/artifacts/summary.txt
  printf '/run/secrets/danso-dir/glm.env does not define ZAI_API_KEY.\n' | tee /work/artifacts/patch-command.log
  exit 2
fi
printf 'danso_credential=glm.env keys=%s\n' "$A2A_DANSO_CREDENTIAL_KEYS" | tee -a /work/artifacts/summary.txt

# danso's own HOME and session journal live on the container /tmp (tmpfs under
# the read-only rootfs), never on the host-bound /work, and die with the
# container — the equivalent of piri --no-session.
export HOME=/tmp/danso-home
rm -rf "$HOME"
install -d -m 0700 "$HOME" "$HOME/sessions"
A2A_DANSO_SESSION="$HOME/sessions/patch.jsonl"

# danso rebuilds every tool's environment as HOME=<tool home> and
# PATH=<tool home>/.cargo/bin:/usr/local/bin:/usr/bin:/bin, so a PATH prefix on
# this script alone would not reach the model's bash tool. The guard shims are
# written to /work (the read-only-rootfs /tmp is noexec) and the tool home on
# /tmp links <tool home>/.cargo/bin to them, putting them first on the tool
# PATH. They are also prepended to this script's PATH, as in the piri lane.
A2A_LIFECYCLE_GUARD_BIN=/work/a2a-danso-lifecycle-guard-bin
mkdir -p "$A2A_LIFECYCLE_GUARD_BIN"
A2A_DANSO_TOOL_HOME=/tmp/danso-tool-home
rm -rf "$A2A_DANSO_TOOL_HOME"
install -d -m 0700 "$A2A_DANSO_TOOL_HOME" "$A2A_DANSO_TOOL_HOME/.cargo"
ln -s "$A2A_LIFECYCLE_GUARD_BIN" "$A2A_DANSO_TOOL_HOME/.cargo/bin"
cat > "$A2A_LIFECYCLE_GUARD_BIN/git" <<'A2A_DANSO_GIT_LIFECYCLE_GUARD'
#!/usr/bin/env bash
case "${1:-}" in
  add|commit|push|checkout|switch|reset|merge|rebase|tag)
    printf "error=a2a_runner_contract_violation command=git_${1:-}\n" >&2
    exit 90
    ;;
  branch)
    case "${2:-}" in
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
A2A_DANSO_GIT_LIFECYCLE_GUARD
cat > "$A2A_LIFECYCLE_GUARD_BIN/gh" <<'A2A_DANSO_GH_LIFECYCLE_GUARD'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "pr create"|"pr merge"|"issue close"|"issue comment")
    printf "error=a2a_runner_contract_violation command=gh_${1:-}_${2:-}\n" >&2
    exit 90
    ;;
esac
exec /usr/bin/gh "$@"
A2A_DANSO_GH_LIFECYCLE_GUARD
chmod 755 "$A2A_LIFECYCLE_GUARD_BIN/git" "$A2A_LIFECYCLE_GUARD_BIN/gh"
export PATH="$A2A_LIFECYCLE_GUARD_BIN:$PATH"
printf 'lifecycle_guard=enabled profile=danso\n' | tee -a /work/artifacts/summary.txt

printf 'danso_cli=%s\n' "$(danso --version 2>/dev/null | head -n 1 || printf unknown)" | tee -a /work/artifacts/summary.txt
printf 'model=%s effort=%s profile=danso provider=glm sandbox=host\n' "$A2A_DANSO_MODEL" "${A2A_DANSO_EFFORT:-provider_default}" | tee -a /work/artifacts/summary.txt
printf 'prompt_transport=file path=/work/artifacts/prompt.md\n' | tee -a /work/artifacts/summary.txt

# Lane rules travel as danso system context; the assignment itself is passed
# untouched as --prompt-file /work/artifacts/prompt.md.
A2A_DANSO_TASK_MODE="$(jq -r '.mode // ""' /work/task.json 2>/dev/null || true)"
A2A_DANSO_READ_ONLY="$(jq -r 'if .readOnlyValidation == true then "1" else "" end' /work/task.json 2>/dev/null || true)"
if [ -n "$A2A_DANSO_READ_ONLY" ] || printf '%s' "$A2A_DANSO_TASK_MODE" | grep -q 'read-only'; then
  printf 'task_mode=%s read_only=1\n' "$A2A_DANSO_TASK_MODE" | tee -a /work/artifacts/summary.txt
  cat > /work/artifacts/danso-system-context.md <<'A2A_DANSO_RO_CONTEXT_EOF'
You are running inside the A2A Docker Runner on a checked-out GitHub repository.
The user message is the assignment.

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
- Your final answer must be the JSON value only, no prose and no markdown fences:
  {"status": "done"|"blocked", "summary": string, "findings": string[],
  "risks": string[], "recommendations": string[], "evidenceRefs": string[]}.
A2A_DANSO_RO_CONTEXT_EOF
else
  cat > /work/artifacts/danso-system-context.md <<'A2A_DANSO_CONTEXT_EOF'
You are running inside the A2A Docker Runner on a checked-out GitHub repository.
The user message is the assignment.

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
  no markdown fences.
- Required shape: {"status": "done"|"blocked", "summary": string,
  "findings": string[], "risks": string[], "recommendations": string[],
  "evidenceRefs": string[]}. Summarize what you changed in 'summary' and list
  the files you edited in 'evidenceRefs'.
A2A_DANSO_CONTEXT_EOF
fi

# Liveness for the broker heartbeat (lastProgressAt): danso -p emits a
# body-free {"type":"danso_message_completed","version":1} frame per interim
# assistant message; only those exact lines are copied to the progress file.
A2A_DANSO_PROGRESS_FILE=/work/artifacts/danso-progress.jsonl
: > "$A2A_DANSO_PROGRESS_FILE"

# --sandbox host: the task container (cap-drop ALL, no-new-privileges,
# read-only rootfs, non-root user) is the isolation boundary, as for codex
# danger-full-access / hermes --yolo / piri --approve. bubblewrap would need
# user namespaces the hardened container does not grant.
set +e
timeout --kill-after=30 "$((A2A_DANSO_PATCH_TIMEOUT_SEC + 60))" danso \
  --prompt-file /work/artifacts/prompt.md \
  --system-context-file /work/artifacts/danso-system-context.md \
  --cwd "$PWD" \
  --session "$A2A_DANSO_SESSION" \
  --provider glm \
  --model "$A2A_DANSO_MODEL" \
  ${DANSO_EFFORT_ARGS[@]+"${DANSO_EFFORT_ARGS[@]}"} \
  --sandbox host \
  --tool-home "$A2A_DANSO_TOOL_HOME" \
  --trust-project \
  --max-turns "$A2A_DANSO_PATCH_MAX_TURNS" \
  --provider-timeout-seconds "$A2A_DANSO_PROVIDER_TIMEOUT_SECONDS" \
  --timeout-seconds "$A2A_DANSO_PATCH_TIMEOUT_SEC" \
  -p \
  | tee >(grep --line-buffered -Fx '{"type":"danso_message_completed","version":1}' >> "$A2A_DANSO_PROGRESS_FILE" || true)
A2A_DANSO_EXIT="${PIPESTATUS[0]}"
set -e

printf 'danso_exit=%s\n' "$A2A_DANSO_EXIT" | tee -a /work/artifacts/summary.txt
# danso process contract (docs/v0.md): 2 = invocation/config before provider
# dispatch, 3 = provider/run failure, 124 = whole-run wall timeout.
case "$A2A_DANSO_EXIT" in
  0) ;;
  2) printf 'failure_category=danso_invocation_invalid\n' | tee -a /work/artifacts/summary.txt ;;
  3) printf 'failure_category=danso_provider_failure\n' | tee -a /work/artifacts/summary.txt ;;
  124|137) printf 'failure_category=danso_timeout\n' | tee -a /work/artifacts/summary.txt ;;
  *) printf 'failure_category=danso_runtime_failure\n' | tee -a /work/artifacts/summary.txt ;;
esac
exit "$A2A_DANSO_EXIT"
