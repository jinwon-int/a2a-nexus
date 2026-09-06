#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
A2A_CODEX_DEFAULT_MODEL=__A2A_PROFILE_defaultModel__
A2A_CODEX_DEFAULT_REASONING_EFFORT=__A2A_PROFILE_defaultReasoning__
A2A_CODEX_DEFAULT_TIMEOUT_SEC=__A2A_PROFILE_defaultTimeout__
A2A_CODEX_TIMEOUT_SEC="${A2A_CODEX_TIMEOUT_SEC:-$A2A_CODEX_DEFAULT_TIMEOUT_SEC}"
A2A_CODEX_MODEL="${A2A_CODEX_MODEL:-$A2A_CODEX_DEFAULT_MODEL}"
A2A_CODEX_MODEL="${A2A_CODEX_MODEL#openai-codex/}"
A2A_CODEX_REASONING_EFFORT="${A2A_CODEX_REASONING_EFFORT:-$A2A_CODEX_DEFAULT_REASONING_EFFORT}"
export A2A_CODEX_MODEL A2A_CODEX_REASONING_EFFORT A2A_CODEX_TIMEOUT_SEC
if [ ! -d /run/secrets/codex-dir ] || [ ! -f /run/secrets/codex-dir/auth.json ]; then
  printf 'error=codex_config_mount_missing
' | tee -a /work/artifacts/summary.txt
  printf 'Mount a minimal Codex config directory containing auth.json at /run/secrets/codex-dir.
' | tee /work/artifacts/patch-command.log
  exit 2
fi
if [ ! -w /run/secrets/codex-dir/auth.json ]; then
  printf 'error=codex_config_mount_not_writable
' | tee -a /work/artifacts/summary.txt
  printf 'failure_category=codex_credential_writeback_unavailable
' | tee -a /work/artifacts/summary.txt
  printf 'The runner must provide a task-scoped writable credential clone for refresh write-back.
' | tee /work/artifacts/patch-command.log
  exit 2
fi
if ! command -v codex >/dev/null 2>&1; then
  printf 'error=codex_cli_missing
' | tee -a /work/artifacts/summary.txt
  printf 'failure_category=codex_cli_unavailable
' | tee -a /work/artifacts/summary.txt
  printf 'Use an a2a-docker-runner-codex image with Codex CLI preinstalled.
' | tee /work/artifacts/patch-command.log
  exit 2
fi
export CODEX_HOME=/run/secrets/codex-dir
__A2A_PROFILE_subagentProfileInstall__
printf 'codex_cli=%s
' "$(codex --version 2>/dev/null | head -n 1 || printf unknown)" | tee -a /work/artifacts/summary.txt
printf 'model=%s reasoning=%s profile=codex
' "$A2A_CODEX_MODEL" "$A2A_CODEX_REASONING_EFFORT" | tee -a /work/artifacts/summary.txt
__A2A_PROFILE_subagentSummary__
__A2A_PROFILE_subagentModelSummary__

A2A_LIFECYCLE_GUARD_BIN=/work/a2a-codex-lifecycle-guard-bin
mkdir -p "$A2A_LIFECYCLE_GUARD_BIN"
cat > "$A2A_LIFECYCLE_GUARD_BIN/git" <<'A2A_CODEX_GIT_LIFECYCLE_GUARD'
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
A2A_CODEX_GIT_LIFECYCLE_GUARD
cat > "$A2A_LIFECYCLE_GUARD_BIN/gh" <<'A2A_CODEX_GH_LIFECYCLE_GUARD'
#!/usr/bin/env bash
case "${1:-} ${2:-}" in
  "pr create"|"pr merge"|"issue close"|"issue comment")
    printf "error=a2a_runner_contract_violation command=gh_${1:-}_${2:-}
" >&2
    exit 90
    ;;
esac
exec /usr/bin/gh "$@"
A2A_CODEX_GH_LIFECYCLE_GUARD
chmod 755 "$A2A_LIFECYCLE_GUARD_BIN/git" "$A2A_LIFECYCLE_GUARD_BIN/gh"
export PATH="$A2A_LIFECYCLE_GUARD_BIN:$PATH"
printf 'lifecycle_guard=enabled profile=codex
' | tee -a /work/artifacts/summary.txt

cat > /work/artifacts/codex-prompt.md <<'A2A_CODEX_PROMPT_EOF'
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
__A2A_PROFILE_subagentInstruction__
__A2A_PROFILE_subagentRosterInstruction__

The assignment follows:
A2A_CODEX_PROMPT_EOF
cat /work/artifacts/prompt.md >> /work/artifacts/codex-prompt.md
timeout "$A2A_CODEX_TIMEOUT_SEC" codex exec \
  --skip-git-repo-check \
  --ephemeral \
  --json \
  --model "$A2A_CODEX_MODEL" \
  --sandbox danger-full-access \
  -c 'approval_policy="never"' \
  -c "model_reasoning_effort="$A2A_CODEX_REASONING_EFFORT"" \
  -C "$PWD" \
  - < /work/artifacts/codex-prompt.md
