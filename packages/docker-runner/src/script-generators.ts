// Container bash-script generators extracted from runner.ts. These build the
// in-container script (base tools, GitHub auth, repo checkout, bootstrap leak
// guards, command execution) plus the shellQuote / jsonArgvToScript helpers.
// Pure string builders over a normalized task; no runner state.
import { createHash } from "node:crypto";
import type { NormalizedRunnerTask } from "./types.js";

export function buildContainerScript(task: NormalizedRunnerTask): string {
  return `#!/usr/bin/env bash
set -euo pipefail
restore_work_ownership() {
  local owner group
  owner="$(stat -c '%u' /work 2>/dev/null || true)"
  group="$(stat -c '%g' /work 2>/dev/null || true)"
  if [ -n "$owner" ] && [ -n "$group" ]; then
    chown -R "$owner:$group" /work 2>/dev/null || true
  fi
}
trap restore_work_ownership EXIT
mkdir -p /work/artifacts
printf 'A2A Docker Runner task %s\n' ${shellQuote(task.id)} | tee /work/artifacts/summary.txt
printf 'intent=%s\n' ${shellQuote(task.intent)} | tee -a /work/artifacts/summary.txt
printf 'preset=%s\n' ${shellQuote(task.preset ?? "")} | tee -a /work/artifacts/summary.txt
if [ -n "\${A2A_RUNNER_BUILD_VERSION:-}" ]; then printf 'runner.version=%s\n' "$A2A_RUNNER_BUILD_VERSION" | tee -a /work/artifacts/summary.txt; fi
if [ -n "\${A2A_RUNNER_BUILD_REVISION:-}" ]; then printf 'runner.revision=%s\n' "$A2A_RUNNER_BUILD_REVISION" | tee -a /work/artifacts/summary.txt; fi
if [ -n "\${A2A_RUNNER_BUILD_SOURCE:-}" ]; then printf 'runner.source=%s\n' "$A2A_RUNNER_BUILD_SOURCE" | tee -a /work/artifacts/summary.txt; fi
if [ -n "\${A2A_RUNNER_BUILD_BUILT_AT:-}" ]; then printf 'runner.builtAt=%s\n' "$A2A_RUNNER_BUILD_BUILT_AT" | tee -a /work/artifacts/summary.txt; fi
if [ -n "\${A2A_RUNNER_BUILD_IMAGE:-}" ]; then printf 'runner.image=%s\n' "$A2A_RUNNER_BUILD_IMAGE" | tee -a /work/artifacts/summary.txt; fi
${installBaseToolsScript()}
${installGhUpdateBranchFallbackScript()}
${githubAuthScript()}
${checkoutReposScript(task)}
${bootstrapGuardScript(task)}
redact_task_artifact() {
  sed -E \
    -e 's#gh[pousr]_[A-Za-z0-9_]{20,}#<redacted-github-token>#g' \
    -e 's#github_pat_[A-Za-z0-9_]{20,}#<redacted-github-token>#g' \
    -e 's#/root/\\.openclaw(/[^[:space:]",}]+)?#<openclaw-dir>#g' \
    -e 's#/root/\\.(hermes|claude|codex|piri|config)(/[^[:space:]",}]+)?#<private-dir>#g' \
    -e 's#/var/folders/[^[:space:]",}]+#<private-dir>#g' \
    -e 's#/(home|Users)/[^[:space:]",}]+#<private-dir>#g' \
    -e 's#/tmp/openclaw-agent-workspace(/[^[:space:]",}]+)?#<openclaw-workspace>#g' \
    -e 's#xai-[A-Za-z0-9_-]{40,}#<redacted-api-key>#g' \
    -e 's#sm_[A-Za-z0-9_-]{40,}#<redacted-api-key>#g' \
    -e 's#sk-[A-Za-z0-9_-]{32,}#<redacted-api-key>#g' \
    -e 's#x-access-token:[^@[:space:]]+@github\.com#x-access-token:<redacted>@github.com#g' \
    -e 's#(oauth_token:[[:space:]]*)[^[:space:]]+#\\1<redacted>#Ig' \
    -e 's#(Authorization:[[:space:]]*(Bearer|token)[[:space:]]+)[^[:space:]]+#\\1<redacted>#Ig' \
    -e 's#(gh auth login --with-token[[:space:]]+)[^[:space:]]+#\\1<redacted>#g' \
    -e 's#((token|password|secret|api[_-]?key)=)[^[:space:]",}]+#\\1<redacted>#Ig' \
    -e 's#("[^"]*(GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|A2A_TOKEN|[Tt][Oo][Kk][Ee][Nn]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy])[^"]*"[[:space:]]*:[[:space:]]*")[^"]*"#\\1<redacted>"#g' \
    /work/task.json > /work/artifacts/task.json
}
# In-place redaction for command output log files.
# Reuses the same sed patterns to prevent secret leakage in artifacts.
redact_artifact_file() {
  local _a2a_f="$1"
  [ -f "$_a2a_f" ] || return 0
  sed -E \
    -e 's#gh[pousr]_[A-Za-z0-9_]{20,}#<redacted-github-token>#g' \
    -e 's#github_pat_[A-Za-z0-9_]{20,}#<redacted-github-token>#g' \
    -e 's#/root/\\.openclaw(/[^[:space:]",}]+)?#<openclaw-dir>#g' \
    -e 's#/root/\\.(hermes|claude|codex|piri|config)(/[^[:space:]",}]+)?#<private-dir>#g' \
    -e 's#/var/folders/[^[:space:]",}]+#<private-dir>#g' \
    -e 's#/(home|Users)/[^[:space:]",}]+#<private-dir>#g' \
    -e 's#/tmp/openclaw-agent-workspace(/[^[:space:]",}]+)?#<openclaw-workspace>#g' \
    -e 's#xai-[A-Za-z0-9_-]{40,}#<redacted-api-key>#g' \
    -e 's#sm_[A-Za-z0-9_-]{40,}#<redacted-api-key>#g' \
    -e 's#sk-[A-Za-z0-9_-]{32,}#<redacted-api-key>#g' \
    -e 's#x-access-token:[^@[:space:]]+@github\.com#x-access-token:<redacted>@github.com#g' \
    -e 's#(oauth_token:[[:space:]]*)[^[:space:]]+#\\1<redacted>#Ig' \
    -e 's#(Authorization:[[:space:]]*(Bearer|token)[[:space:]]+)[^[:space:]]+#\\1<redacted>#Ig' \
    -e 's#(gh auth login --with-token[[:space:]]+)[^[:space:]]+#\\1<redacted>#g' \
    -e 's#((token|password|secret|api[_-]?key)=)[^[:space:]",}]+#\\1<redacted>#Ig' \
    -e 's#("[^"]*(GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|A2A_TOKEN|[Tt][Oo][Kk][Ee][Nn]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Aa][Pp][Ii][_-]?[Kk][Ee][Yy])[^"]*"[[:space:]]*:[[:space:]]*")[^"]*"#\\1<redacted>"#g' \
    "$_a2a_f" > "\${_a2a_f}.a2a-redacted" && mv "\${_a2a_f}.a2a-redacted" "$_a2a_f"
}
redact_command_artifacts() {
  for _a2a_log in \
    /work/artifacts/command-*.log \
    /work/artifacts/patch-command.log \
    /work/artifacts/patch-command.stderr.log \
    /work/artifacts/openclaw-output.txt \
    /work/artifacts/hermes-output.txt \
    /work/artifacts/pr-output.txt; do
    [ -f "$_a2a_log" ] && redact_artifact_file "$_a2a_log" || true
  done
}
# Redaction also runs from the EXIT trap so command output logs are scrubbed even
# when a command fails and \`set -e\` aborts before the eager pass below (BUG-06):
# the collected on-disk evidence bundle must never retain unredacted secrets. The
# earlier \`trap restore_work_ownership EXIT\` covered the window before these
# redaction helpers were defined; from here on the exit path does both.
on_container_exit() {
  [ -f /work/task.json ] && redact_task_artifact || true
  redact_command_artifacts
  restore_work_ownership
}
trap on_container_exit EXIT
redact_task_artifact
${runCommandsScript(task)}
# Eager post-command redaction (the EXIT trap repeats this so a mid-command
# failure cannot leave logs unredacted).
redact_command_artifacts
${bootstrapPostGuardScript(task)}
printf 'status=completed\n' | tee -a /work/artifacts/summary.txt
`;
}

function installBaseToolsScript(): string {
  return `if ! command -v git >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then
    printf 'error=missing_git_and_apt_get_unavailable\n' >&2
    exit 2
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update >/dev/null
  apt-get install -y git ca-certificates >/dev/null
fi

if ! command -v gh >/dev/null 2>&1 || ! gh pr update-branch --help >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then
    printf 'error=missing_or_unsupported_gh_and_apt_get_unavailable\n' >&2
    exit 2
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update >/dev/null
  apt-get install -y git ca-certificates curl gnupg >/dev/null
  mkdir -p -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/github-cli.list
  apt-get update >/dev/null
  apt-get install -y gh >/dev/null
fi
printf 'github_cli=%s\n' "$(gh --version | head -n 1)" | tee -a /work/artifacts/summary.txt
`;
}

function installGhUpdateBranchFallbackScript(): string {
  return `mkdir -p /work/.a2a-bin
cat > /work/.a2a-bin/a2a-gh-pr-update-branch <<'A2A_GH_UPDATE_BRANCH_EOF'
#!/usr/bin/env bash
set -euo pipefail
selector="\${1:-}"
base_override="\${2:-}"

args=()
if [ -n "$selector" ]; then
  args+=("$selector")
fi

if gh pr update-branch "\${args[@]}"; then
  exit 0
fi

printf 'warning=gh_pr_update_branch_failed_using_git_fallback\n' >&2

view_args=()
if [ -n "$selector" ]; then
  view_args+=("$selector")
fi

head_ref="$(gh pr view "\${view_args[@]}" --json headRefName --jq .headRefName 2>/dev/null || true)"
base_ref="$base_override"
if [ -z "$base_ref" ]; then
  base_ref="$(gh pr view "\${view_args[@]}" --json baseRefName --jq .baseRefName 2>/dev/null || true)"
fi
if [ -z "$head_ref" ]; then
  head_ref="$(git rev-parse --abbrev-ref HEAD)"
fi
if [ -z "$base_ref" ]; then
  base_ref="main"
fi

git fetch origin "$base_ref"
current_ref="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_ref" != "$head_ref" ]; then
  git fetch origin "$head_ref"
  git checkout -B "$head_ref" "origin/$head_ref"
fi
git merge --no-edit "origin/$base_ref"
git push origin "$head_ref"
A2A_GH_UPDATE_BRANCH_EOF
chmod 755 /work/.a2a-bin/a2a-gh-pr-update-branch
export PATH="/work/.a2a-bin:$PATH"
`;
}

function githubAuthScript(): string {
  return `if [ -r /run/secrets/gh-hosts.yml ]; then
  token=$(sed -n 's/^[[:space:]]*oauth_token:[[:space:]]*//p' /run/secrets/gh-hosts.yml | head -n 1)
  if [ -n "$token" ]; then
    mkdir -p /work/.a2a-bin
    cat > /work/.a2a-bin/git-askpass <<'ASKPASS'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' "x-access-token" ;;
  *Password*) sed -n 's/^[[:space:]]*oauth_token:[[:space:]]*//p' /run/secrets/gh-hosts.yml | head -n 1 ;;
  *) printf '\n' ;;
esac
ASKPASS
    chmod 700 /work/.a2a-bin/git-askpass
    mkdir -p /work/.config/gh
    cp /run/secrets/gh-hosts.yml /work/.config/gh/hosts.yml
    chmod 600 /work/.config/gh/hosts.yml
    export GH_CONFIG_DIR=/work/.config/gh
    export GH_TOKEN="$token"
    export GIT_ASKPASS=/work/.a2a-bin/git-askpass
    export GIT_TERMINAL_PROMPT=0
    printf 'github_auth=hosts.yml\\n' | tee -a /work/artifacts/summary.txt
  fi
fi
`;
}

function checkoutReposScript(task: NormalizedRunnerTask): string {
  if (!task.repos.length) return "";
  return task.repos.map((repo) => {
    return `printf 'checkout %s %s -> %s\n' ${shellQuote(repo.name ?? repo.url)} ${shellQuote(repo.branch ?? "main")} ${shellQuote(repo.path ?? "repo")} | tee -a /work/artifacts/summary.txt
git clone --depth=1 --branch ${shellQuote(repo.branch ?? "main")} ${shellQuote(repo.url)} ${shellQuote(`/work/${repo.path ?? "repo"}`)}
`;
  }).join("\n");
}

const FAMILY_WIKI_READONLY_AUDIT_MODE = "family-wiki-readonly-audit";
const FAMILY_WIKI_REPO_SLUG = "jinwon-int/seoyoon-family-wiki";

function parseGitHubRepoSlug(repoUrl: string): string | undefined {
  const match = repoUrl.match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/);
  return match?.[1];
}

function buildBootstrapAllowedTrackedRepoEntries(task: NormalizedRunnerTask): string[] {
  if (task.mode !== FAMILY_WIKI_READONLY_AUDIT_MODE) return [];
  return task.repos
    .filter((repo) => parseGitHubRepoSlug(repo.url) === FAMILY_WIKI_REPO_SLUG)
    .map((repo) => `/work/${repo.path ?? "repo"}:AGENTS.md`);
}

/**
 * Pre-command bootstrap guard that fails closed if OpenClaw runtime/bootstrap
 * context files would be included in any checked-out repository branch.
 *
 * Parent: a2a-broker#446
 */
function bootstrapGuardScript(task: NormalizedRunnerTask): string {
  if (!task.repos.length) return "";

  const repoPaths = task.repos.map((repo) => shellQuote(`/work/${repo.path ?? "repo"}`));
  const repoList = repoPaths.join(" ");
  const allowedTrackedRepoEntries = buildBootstrapAllowedTrackedRepoEntries(task);

  return `# Pre-PR bootstrap guard: fail closed if OpenClaw bootstrap files would
# enter the checked-out repository branch.  These files are runtime/persona
# context, not repository artifacts.
# Parent: a2a-broker#446
BOOTSTRAP_BANNED="AGENTS.md BOOTSTRAP.md HEARTBEAT.md IDENTITY.md MEMORY.md SOUL.md TOOLS.md USER.md"
BOOTSTRAP_BANNED_DIRS=".openclaw memory"
BOOTSTRAP_ALLOWED_TRACKED_REPO_ENTRIES=${shellQuote(allowedTrackedRepoEntries.join(" "))}
is_allowed_tracked_bootstrap_path() {
  repo_dir="$1"
  path="$2"
  for allowed in $BOOTSTRAP_ALLOWED_TRACKED_REPO_ENTRIES; do
    allowed_repo="\${allowed%%:*}"
    allowed_path="\${allowed#*:}"
    [ "$repo_dir" = "$allowed_repo" ] || continue
    [ "$path" = "$allowed_path" ] || continue
    if [ -n "$(git -C "$repo_dir" ls-files -- "$path")" ] && [ -z "$(git -C "$repo_dir" status --porcelain -- "$path")" ]; then
      return 0
    fi
  done
  return 1
}
find_bootstrap_leaks() {
  repo_dir="$1"
  (
    cd "$repo_dir"
    for name in $BOOTSTRAP_BANNED; do
      if [ -e "$name" ]; then
        printf '%s\\n' "$name"
      fi
    done
    for name in $BOOTSTRAP_BANNED_DIRS; do
      if [ -d "$name" ]; then
        found=0
        while IFS= read -r path; do
          found=1
          printf '%s\\n' "\${path#./}"
        done < <(find "$name" -mindepth 1 -print | sort)
        if [ "$found" -eq 0 ]; then
          printf '%s\\n' "$name"
        fi
      fi
    done
  )
}
filter_branch_bootstrap_leaks() {
  repo_dir="$1"
  if ! git -C "$repo_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    cat
    return
  fi
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if is_allowed_tracked_bootstrap_path "$repo_dir" "$path"; then
      continue
    fi
    if [ -n "$(git -C "$repo_dir" ls-files -- "$path")" ] || [ -n "$(git -C "$repo_dir" status --porcelain -- "$path")" ]; then
      printf '%s\\n' "$path"
    fi
  done
}
for repo_dir in ${repoList}; do
  bootstrap_leaks_pre="$(find_bootstrap_leaks "$repo_dir" | filter_branch_bootstrap_leaks "$repo_dir")"
  if [ -n "$bootstrap_leaks_pre" ]; then
    printf 'error=pre_pr_bootstrap_guard_blocked\\n' | tee -a /work/artifacts/summary.txt
    printf 'PR blocked: OpenClaw bootstrap context files found in repository checkout.\\n' | tee /work/artifacts/patch-command.log
    printf 'Parent: a2a-broker#446\\n' | tee -a /work/artifacts/patch-command.log
    repo_label="\${repo_dir#/work/}"
    printf 'Repository checkout: %s\\n' "$repo_label" | tee -a /work/artifacts/patch-command.log
    printf 'Files detected (repo-relative):\\n' | tee -a /work/artifacts/patch-command.log
    printf '%s\\n' "$bootstrap_leaks_pre" | tee -a /work/artifacts/patch-command.log
    printf 'bootstrap_guard=blocked\\n' >> /work/artifacts/summary.txt
    printf 'guard_schema=a2a.runner.pre-pr-bootstrap-guard.v1\\n' >> /work/artifacts/summary.txt
    exit 4
  fi
done
printf 'bootstrap_guard=ok\\n' | tee -a /work/artifacts/summary.txt
`;
}

/**
 * Post-command bootstrap guard: verify no bootstrap files leaked into the
 * repository checkout during patch execution.
 *
 * Like the pre-check this runs after the patch command and checks every
 * configured checkout path for tracked, staged, or unignored bootstrap paths.
 */
function bootstrapPostGuardScript(task: NormalizedRunnerTask): string {
  const repoPaths = task.repos.length
    ? task.repos.map((repo) => shellQuote(`/work/${repo.path ?? "repo"}`))
    : ["/work/repo", "/work/*/repo"];
  const repoList = repoPaths.join(" ");
  const allowedTrackedRepoEntries = buildBootstrapAllowedTrackedRepoEntries(task);

  return `# Post-PR bootstrap guard: check for leaked workspace files after patch commands.
# These are prompt/runtime context files, never repository artifacts.
# Parent: a2a-broker#446
BOOTSTRAP_BANNED="AGENTS.md BOOTSTRAP.md HEARTBEAT.md IDENTITY.md MEMORY.md SOUL.md TOOLS.md USER.md"
BOOTSTRAP_BANNED_DIRS=".openclaw memory"
BOOTSTRAP_ALLOWED_TRACKED_REPO_ENTRIES=${shellQuote(allowedTrackedRepoEntries.join(" "))}
if ! command -v is_allowed_tracked_bootstrap_path >/dev/null 2>&1; then
  is_allowed_tracked_bootstrap_path() {
    repo_dir="$1"
    path="$2"
    for allowed in $BOOTSTRAP_ALLOWED_TRACKED_REPO_ENTRIES; do
      allowed_repo="\${allowed%%:*}"
      allowed_path="\${allowed#*:}"
      [ "$repo_dir" = "$allowed_repo" ] || continue
      [ "$path" = "$allowed_path" ] || continue
      if [ -n "$(git -C "$repo_dir" ls-files -- "$path")" ] && [ -z "$(git -C "$repo_dir" status --porcelain -- "$path")" ]; then
        return 0
      fi
    done
    return 1
  }
fi
if ! command -v find_bootstrap_leaks >/dev/null 2>&1; then
  find_bootstrap_leaks() {
    repo_dir="$1"
    (
      cd "$repo_dir"
      for name in $BOOTSTRAP_BANNED; do
        if [ -e "$name" ]; then
          printf '%s\\n' "$name"
        fi
      done
      for name in $BOOTSTRAP_BANNED_DIRS; do
        if [ -d "$name" ]; then
          found=0
          while IFS= read -r path; do
            found=1
            printf '%s\\n' "\${path#./}"
          done < <(find "$name" -mindepth 1 -print | sort)
          if [ "$found" -eq 0 ]; then
            printf '%s\\n' "$name"
          fi
        fi
      done
    )
  }
fi
if ! command -v filter_branch_bootstrap_leaks >/dev/null 2>&1; then
  filter_branch_bootstrap_leaks() {
    repo_dir="$1"
    if ! git -C "$repo_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      cat
      return
    fi
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      if is_allowed_tracked_bootstrap_path "$repo_dir" "$path"; then
        continue
      fi
      if [ -n "$(git -C "$repo_dir" ls-files -- "$path")" ] || [ -n "$(git -C "$repo_dir" status --porcelain -- "$path")" ]; then
        printf '%s\\n' "$path"
      fi
    done
  }
fi
for repo_dir in ${repoList}; do
  if [ -d "$repo_dir/.git" ]; then
    bootstrap_leaks_post="$(find_bootstrap_leaks "$repo_dir" | filter_branch_bootstrap_leaks "$repo_dir")"
    if [ -n "$bootstrap_leaks_post" ]; then
      printf 'error=post_pr_bootstrap_guard_leak\\n' | tee -a /work/artifacts/summary.txt
      printf 'PR blocked: OpenClaw bootstrap context files leaked into repository during patch execution.\\n' | tee -a /work/artifacts/patch-command.log
      printf 'Parent: a2a-broker#446\\n' | tee -a /work/artifacts/patch-command.log
      repo_label="\${repo_dir#/work/}"
      printf 'Repository checkout: %s\\n' "$repo_label" | tee -a /work/artifacts/patch-command.log
      printf 'Files detected (repo-relative):\\n' | tee -a /work/artifacts/patch-command.log
      printf '%s\\n' "$bootstrap_leaks_post" | tee -a /work/artifacts/patch-command.log
      exit 4
    fi
  fi
done
`;
}

function runCommandsScript(task: NormalizedRunnerTask): string {
  if (!task.commands.length) {
    return "printf 'commands=none\\n' | tee -a /work/artifacts/summary.txt\n";
  }

  const commands = task.commands.map((command, index) => {
    const digest = createHash("sha256").update(command, "utf8").digest("hex");
    const bytes = Buffer.byteLength(command, "utf8");
    return `printf 'command[%s].sha256=%s\n' ${shellQuote(String(index))} ${shellQuote(digest)} | tee -a /work/artifacts/summary.txt
printf 'command[%s].bytes=%s\n' ${shellQuote(String(index))} ${shellQuote(String(bytes))} | tee -a /work/artifacts/summary.txt
(${command}) 2>&1 | tee /work/artifacts/command-${index}.log
`;
  }).join("\n");

  return `printf 'commands=%s\n' ${shellQuote(String(task.commands.length))} | tee -a /work/artifacts/summary.txt
${commands}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Convert a JSON argv/env config into a safe bash script.
 *
 * Input:  {"argv":["codex","exec","--full-auto","..."],"env":{"KEY":"val"}}
 * Output: A self-contained bash script that executes argv safely,
 *         with optional env vars set, and never calls eval.
 */
export function jsonArgvToScript(json: string): string {
  let parsed: { argv?: unknown; env?: unknown };
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `#!/usr/bin/env bash
set -euo pipefail
printf 'error=json_parse_failed: %s\\n' >&2 ${shellQuote(msg)}
exit 2
`;
  }

  if (!Array.isArray(parsed.argv) || parsed.argv.length === 0 || !parsed.argv.every((a): a is string => typeof a === "string")) {
    return `#!/usr/bin/env bash
set -euo pipefail
printf 'error=invalid_json_argv: argv must be a non-empty array of strings\\n' >&2
exit 2
`;
  }

  const envLines: string[] = [];
  if (parsed.env && typeof parsed.env === "object" && !Array.isArray(parsed.env)) {
    for (const [key, value] of Object.entries(parsed.env as Record<string, unknown>)) {
      if (typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        envLines.push(`export ${key}=${shellQuote(value)}`);
      }
    }
  }

  const argvQuoted = parsed.argv.map((a: string) => shellQuote(a)).join(" ");

  return `#!/usr/bin/env bash
set -euo pipefail
${envLines.join("\n")}
${envLines.length ? "\n" : ""}exec ${argvQuoted}
`;
}
