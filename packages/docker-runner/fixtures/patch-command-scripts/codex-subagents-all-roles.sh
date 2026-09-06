#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
A2A_CODEX_DEFAULT_MODEL='gpt-5.6-luna'
A2A_CODEX_DEFAULT_REASONING_EFFORT='max'
A2A_CODEX_DEFAULT_TIMEOUT_SEC='5400'
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
install -d -m 0700 "$CODEX_HOME/agents"
cat > "$CODEX_HOME/agents/a2a-explorer.toml" <<'A2A_CODEX_AGENT_PROFILE_EOF'
name = "a2a_explorer"
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
"""
A2A_CODEX_AGENT_PROFILE_EOF
chmod 0600 "$CODEX_HOME/agents/a2a-explorer.toml"
cat > "$CODEX_HOME/agents/a2a-researcher.toml" <<'A2A_CODEX_AGENT_PROFILE_EOF'
name = "a2a_researcher"
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
"""
A2A_CODEX_AGENT_PROFILE_EOF
chmod 0600 "$CODEX_HOME/agents/a2a-researcher.toml"
cat > "$CODEX_HOME/agents/a2a-implementer.toml" <<'A2A_CODEX_AGENT_PROFILE_EOF'
name = "a2a_implementer"
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
"""
A2A_CODEX_AGENT_PROFILE_EOF
chmod 0600 "$CODEX_HOME/agents/a2a-implementer.toml"
cat > "$CODEX_HOME/agents/a2a-verifier.toml" <<'A2A_CODEX_AGENT_PROFILE_EOF'
name = "a2a_verifier"
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
"""
A2A_CODEX_AGENT_PROFILE_EOF
chmod 0600 "$CODEX_HOME/agents/a2a-verifier.toml"
printf 'codex_cli=%s
' "$(codex --version 2>/dev/null | head -n 1 || printf unknown)" | tee -a /work/artifacts/summary.txt
printf 'model=%s reasoning=%s profile=codex
' "$A2A_CODEX_MODEL" "$A2A_CODEX_REASONING_EFFORT" | tee -a /work/artifacts/summary.txt
printf 'contained_subagents=enabled\n' | tee -a /work/artifacts/summary.txt
printf 'contained_subagents_max=4\n' | tee -a /work/artifacts/summary.txt
printf 'contained_subagents_output_bytes=20000\n' | tee -a /work/artifacts/summary.txt
printf 'contained_subagents_reasons=context_heavy,context_overflow_retry\n' | tee -a /work/artifacts/summary.txt
printf 'contained_subagents_roles=explorer,implementer,verifier\n' | tee -a /work/artifacts/summary.txt
printf 'contained_subagents_explorer_model=gpt-5.6-luna reasoning=max\n' | tee -a /work/artifacts/summary.txt
printf 'contained_subagents_implementer_model=gpt-5.6-sol reasoning=high\n' | tee -a /work/artifacts/summary.txt
printf 'contained_subagents_verifier_model=gpt-5.6-sol reasoning=xhigh\n' | tee -a /work/artifacts/summary.txt

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

Contained subagents:
- You may spawn up to 4 Codex subagent(s) inside this same Docker task boundary when the assignment matches these reasons: context_heavy, context_overflow_retry.
- Allowed helper roles: explorer, implementer, verifier.
- Keep all helper work inside the checked-out repository and the disposable in-container workspace; do not access or mutate host profile mounts.
- Subagents are evidence helpers only. Return one final worker answer and let the runner/broker/finalizer own PR, Done, Block, merge, closeout, and runtime decisions.
- Bound each helper evidence summary to 20000 bytes or less, redact secrets/private paths/session data, and do not include raw transcripts in repository files or comments.
- If a needed split would exceed the cap or cross the Docker boundary, stop and produce Block evidence instead of unbounded fanout.
- Use only the custom A2A agent profiles installed for the allowed helper roles.
- Use a2a_explorer for repository inspection and a2a_researcher only for narrow external documentation research. Both use GPT-5.6 Luna with max reasoning and remain read-only evidence helpers.
- Use a2a_implementer only after assigning one explicit disjoint write set. It stays on GPT-5.6 Sol with high reasoning.
- Use a2a_verifier from clean-slate inputs for an independent check. It stays on GPT-5.6 Sol with xhigh reasoning.
- The parent Codex worker keeps its configured model and remains the only finalizer; subagents never own the terminal result or GitHub lifecycle.

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
