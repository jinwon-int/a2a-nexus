import type { NormalizedRunnerTask, RunnerDiffHygieneScopeDriftEvidence, RunnerDiffHygieneScopeMode, RunnerRepo, RunnerTask } from "./types.js";

const GITHUB_REPO_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const FAMILY_WIKI_READONLY_AUDIT_MODE = "family-wiki-readonly-audit";
const FAMILY_WIKI_REPO_SLUG = "jinwon-int/seoyoon-family-wiki";
const READ_ONLY_VALIDATION_MODES = new Set([
  "github-verify",
  "github-read-only-validation",
  "read-only-validation",
  "github-libero-validation",
  "libero-validation",
  FAMILY_WIKI_READONLY_AUDIT_MODE,
]);
const PATCH_PROPOSAL_MODES = new Set(["github-propose-patch", "propose_patch"]);
const PIRI_MODEL_ALIASES = new Map([
  ["k3[1m]", "kimi-coding/k3"],
  ["glm-5.2[1m]", "zai/glm-5.2"],
]);

export function evaluateDeclaredScopeDrift(
  changedPaths: string[],
  declaredPaths: string[],
  mode: RunnerDiffHygieneScopeMode = "warn",
): RunnerDiffHygieneScopeDriftEvidence {
  if (mode !== "off" && mode !== "warn" && mode !== "block") {
    throw new Error("task.diffHygiene.scope.mode must be one of: off, warn, block");
  }
  const declared = normalizeScopePaths(declaredPaths);
  const outside = mode === "off" || declared.length === 0
    ? []
    : normalizeScopePaths(changedPaths).filter((path) => !declared.some((prefix) => isPathInDeclaredScope(path, prefix)));
  return {
    declared,
    outside,
    level: outside.length === 0 ? "ok" : mode === "block" ? "block" : "warn",
  };
}

function normalizeScopePaths(paths: string[]): string[] {
  return paths.map((path) => path.trim()).filter(Boolean);
}

function isPathInDeclaredScope(path: string, declaredPath: string): boolean {
  return declaredPath.endsWith("/")
    ? path.startsWith(declaredPath)
    : path === declaredPath || path.startsWith(`${declaredPath}/`);
}

export function normalizeTask(task: RunnerTask): NormalizedRunnerTask {
  const repos = normalizeRepos(task);
  const primaryRepo = repos.find((repo) => repo.primary) ?? repos[0];
  const familyWikiReadonlyAudit = task.mode === FAMILY_WIKI_READONLY_AUDIT_MODE;
  const readOnlyValidation = task.readOnlyValidation === true || READ_ONLY_VALIDATION_MODES.has(task.mode ?? "");
  const allowNoChanges = task.allowNoChanges === true || readOnlyValidation;
  const env = normalizeTaskEnv({ ...task, readOnlyValidation }, allowNoChanges, primaryRepo);
  const normalizedTask = {
    ...task,
    ...(familyWikiReadonlyAudit ? { commentOnly: false, forbidNewPr: true } : {}),
    ...(readOnlyValidation ? { readOnlyValidation: true } : {}),
    allowNoChanges,
    ...(env ? { env } : {}),
  };
  const commands = task.commands?.length ? task.commands : defaultCommands(normalizedTask, primaryRepo);

  return {
    ...normalizedTask,
    repos,
    commands,
  };
}

function normalizeTaskEnv(task: RunnerTask, allowNoChanges: boolean, primaryRepo: RunnerRepo | undefined): Record<string, string> | undefined {
  const env = { ...(task.env ?? {}) };
  const model = normalizeWorkerOverride(task.workerModel, "workerModel");
  const thinking = normalizeWorkerOverride(task.workerThinking, "workerThinking");
  const baseBranch = normalizeWorkerOverride(task.baseBranch ?? primaryRepo?.branch, "baseBranch");
  if (baseBranch) {
    env.A2A_RUNNER_BASE_BRANCH = baseBranch;
  }
  if (model) {
    env.A2A_OPENCLAW_MODEL = model;
    // The Hermes patch profile runs in the same Docker runner pipeline but
    // reads A2A_HERMES_MODEL. Mirror explicit per-task workerModel overrides
    // so task-level evidence dispatch cannot be shadowed by stale host runner
    // defaults such as legacy OPENCLAW_MODEL/deepseek-v4-flash (#860).
    env.A2A_HERMES_MODEL = model;
    env.A2A_CODEX_MODEL = model;
    // Piri resolves canonical provider/model ids. The fleet's [1m] aliases
    // describe the context variant but are not Piri catalog ids, so preserve
    // the task-level selection while translating only those known aliases.
    env.A2A_PIRI_MODEL = PIRI_MODEL_ALIASES.get(model) ?? model;
  }
  if (thinking) {
    env.A2A_OPENCLAW_THINKING = thinking;
    env.A2A_HERMES_THINKING = thinking;
    env.A2A_CODEX_REASONING_EFFORT = thinking;
    env.A2A_PIRI_THINKING = thinking;
  }
  if (allowNoChanges) env.A2A_RUNNER_ALLOW_NO_CHANGES = "1";
  if (task.readOnlyValidation === true) env.A2A_RUNNER_READ_ONLY_VALIDATION = "1";
  return Object.keys(env).length > 0 ? env : undefined;
}

function normalizeWorkerOverride(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`task.${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/[\0\r\n]/.test(trimmed)) throw new Error(`task.${field} must be a single-line value`);
  if (trimmed.length > 160) throw new Error(`task.${field} is too long`);
  return trimmed;
}

export function normalizeRepoUrl(url: string): string {
  if (GITHUB_REPO_SHORTHAND.test(url)) return `https://github.com/${url}.git`;
  // Shell-quoting does not stop git's own arg parser: a URL beginning with '-'
  // is consumed by `git clone` as an option (e.g. --upload-pack=...). Restrict
  // to http(s)/git/ssh/scp-like remotes so a task cannot smuggle clone flags or
  // a non-remote source through repo.url (BUG-22).
  if (!/^(?:https?|git|ssh):\/\//.test(url) && !/^[A-Za-z0-9_.-]+@[^\s:]+:/.test(url)) {
    throw new Error(`task.repos[].url must be an http(s), git, ssh, or scp-like remote (got: ${url})`);
  }
  return url;
}

export function defaultCheckoutPath(url: string): string {
  const withoutHash = url.split("#", 1)[0] ?? url;
  const last = withoutHash.replace(/\/$/, "").split("/").pop() || "repo";
  return last.replace(/\.git$/, "").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function normalizeRepos(task: RunnerTask): RunnerRepo[] {
  const repos = [...(task.repos ?? [])];

  if (task.repo && !repos.length) {
    repos.push({
      url: task.repo,
      branch: task.baseBranch,
      path: "repo",
      primary: true,
    });
  }

  if (task.preset === "openclaw-plugin-a2a-dev" && !repos.length) {
    repos.push({
      name: "openclaw-plugin-a2a",
      url: "jinwon-int/openclaw-plugin-a2a",
      branch: task.baseBranch ?? "main",
      path: "openclaw-plugin-a2a",
      primary: true,
    });
  }

  return repos.map((repo, index) => ({
    ...repo,
    name: repo.name ?? defaultCheckoutPath(repo.url),
    url: normalizeRepoUrl(repo.url),
    branch: repo.branch ?? task.baseBranch ?? "main",
    path: sanitizeRelativePath(repo.path ?? defaultCheckoutPath(repo.url)),
    primary: repo.primary ?? index === 0,
  }));
}

const GITHUB_RUNNER_EVIDENCE_MODES = new Set([
  "github-propose-patch",
  "propose_patch",
  "github-verify",
  "github-read-only-validation",
  "read-only-validation",
  "github-libero-validation",
  "libero-validation",
  FAMILY_WIKI_READONLY_AUDIT_MODE,
]);

export function isPatchMode(mode?: string): boolean {
  return mode ? GITHUB_RUNNER_EVIDENCE_MODES.has(mode) : false;
}

function defaultCommands(task: RunnerTask, primaryRepo?: RunnerRepo): string[] {
  // Patch mode always takes priority over preset so that
  // openclaw-plugin-a2a-dev tasks in github-propose-patch / propose_patch
  // mode produce a PR instead of running test-only commands.
  if (isPatchMode(task.mode) && task.commentOnly) {
    return buildDefaultCommentOnlyCommands(task);
  }

  if (isPatchMode(task.mode) && task.readOnlyValidation && primaryRepo) {
    if (PATCH_PROPOSAL_MODES.has(task.mode ?? "")) {
      return buildReadOnlyPatchProposalPreflightBlockCommands(task, primaryRepo);
    }
    return buildDefaultReadOnlyValidationCommands(task, primaryRepo);
  }

  if (isPatchMode(task.mode) && primaryRepo) {
    return buildDefaultPatchCommands(task, primaryRepo);
  }

  if (task.preset === "openclaw-plugin-a2a-dev") {
    const dir = primaryRepo?.path ?? "openclaw-plugin-a2a";
    return [
      `cd /work/${dir} && npm ci`,
      `cd /work/${dir} && npm test`,
    ];
  }

  if (primaryRepo) {
    return [buildToolchainDetectedCommandsForRepo(primaryRepo.path ?? "repo")];
  }

  return [];
}

function buildDefaultCommentOnlyCommands(task: RunnerTask): string[] {
  const safeTitle = (task.id || "a2a-closeout").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const existingPrUrl = task.existingPrUrl ?? buildExistingPrUrl(task);

  return [[
    shellWriteTextFile(task.prompt ?? `Comment-only closeout task ${task.id}`, "/work/artifacts/prompt.md"),
    `printf 'patch_mode=comment_only\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'new_pr_allowed=0\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'task=%s\\n' ${shellSingleQuote(safeTitle)} | tee -a /work/artifacts/summary.txt`,
    ...(existingPrUrl ? [`printf 'existing_pr=%s\\n' ${shellSingleQuote(existingPrUrl)} | tee -a /work/artifacts/summary.txt`] : []),
    `printf 'status=comment_only_done\\n' | tee -a /work/artifacts/summary.txt`,
  ].join("\n")];
}

// Stream separation (#1855 field chain root cause): patch-command stderr must
// NOT merge into container stdout. The `2>&1` merge used to pull the bridge's
// turn-budget diagnostic (`claude_turn_budget=…`, emitMaxTurnFailure JSON) and
// CLI noise onto the stdout envelope stream, so subagentReport extraction had
// to scan past them (#1857/#1858 runner-side mitigations). Keeping stderr on
// stderr also restores the runner's stderr-based fallbacks
// (extractClaudeTurnBudgetDiagnostic(completed.stderr), terminal_reason=max_turns)
// and preserves diagnostics in artifacts/patch-command.stderr.log for triage.
function buildPatchCommandBlock(): string {
  return [
    `# Patch command execution: safe script file (recommended).`,
    `if [ -x /work/patch-command.sh ]; then`,
    `  printf 'patch_mode=script\\n' | tee -a /work/artifacts/summary.txt`,
    `  /work/patch-command.sh 2> >(tee /work/artifacts/patch-command.stderr.log >&2) | tee /work/artifacts/patch-command.log`,
    `elif [ -n "\${A2A_PATCH_COMMAND_JSON:-}" ]; then`,
    `  printf 'patch_mode=json_argv_unconverted\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'error=json_argv_received_without_host_side_script_conversion\\n' >&2`,
    `  exit 2`,
    `elif [ -n "\${A2A_PATCH_COMMAND:-}" ]; then`,
    `  printf 'patch_mode=legacy_eval\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'warning=deprecated_eval_path_prefer_commandScript_or_commandJson\\n' | tee -a /work/artifacts/summary.txt`,
    `  eval "\${A2A_PATCH_COMMAND}" 2> >(tee /work/artifacts/patch-command.stderr.log >&2) | tee /work/artifacts/patch-command.log`,
    `else`,
    `  printf 'error=no_patch_command_configured\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'Set A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT or A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON to inject a host-side OpenClaw/Codex coding agent.\\n' | tee /work/artifacts/patch-command.log`,
    `  exit 2`,
    `fi`,
  ].join("\n");
}

function buildReadOnlyValidationGuardBlock(baseBranch: string): string {
  return [
    `# Read-only validation/libero lanes may inspect and test, but must not`,
    `# produce repository changes or create patch-lane PR evidence.`,
    `READONLY_CHANGED_PATHS="$( {`,
    `  git status --porcelain | sed -E 's/^...//'`,
    `  git diff --name-only "origin/${baseBranch}...HEAD"`,
    `} | sed '/^$/d' | sort -u )"`,
    `if [ -n "$READONLY_CHANGED_PATHS" ]; then`,
    `  printf 'error=read_only_validation_changed_repo\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'read_only_validation=blocked\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'Read-only validation task produced repository changes; refusing to create a PR.\\n' | tee -a /work/artifacts/patch-command.log`,
    `  printf 'Files detected (repo-relative):\\n' | tee -a /work/artifacts/patch-command.log`,
    `  printf '%s\\n' "$READONLY_CHANGED_PATHS" | tee -a /work/artifacts/patch-command.log`,
    `  printf '%s\\n' "$READONLY_CHANGED_PATHS" | sed '/^$/d; s#^#read_only_change=#' >> /work/artifacts/summary.txt`,
    `  exit 4`,
    `fi`,
    `printf 'read_only_validation=passed\\n' | tee -a /work/artifacts/summary.txt`,
  ].join("\n");
}

function buildReadOnlyPatchProposalPreflightBlockCommands(task: RunnerTask, primaryRepo: RunnerRepo): string[] {
  const repoPath = primaryRepo.path ?? "repo";
  const safeTitle = (task.id || "a2a-readonly-patch-proposal-block").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const writePrompt = [
    shellWriteTextFile(task.prompt ?? `Read-only patch/proposal conflict task ${task.id}`, "/work/artifacts/prompt.md"),
    `printf 'patch_mode=read_only_validation\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'new_pr_allowed=0\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'task=%s\\n' ${shellSingleQuote(safeTitle)} | tee -a /work/artifacts/summary.txt`,
    `printf 'prompt_bytes=%s\\n' "$(wc -c < /work/artifacts/prompt.md)" | tee -a /work/artifacts/summary.txt`,
  ].join("\n");

  const pipeline = [
    `set -euo pipefail`,
    `cd /work/${repoPath}`,
    `printf 'patch_mode=read_only_validation\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'new_pr_allowed=0\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'read_only_validation=blocked\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'error=read_only_validation_patch_mode_preflight_blocked\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'evidence_contract=blocked_patch_proposal_mode\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'model_execution=skipped_preflight\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'Read-only validation task selected a patch/proposal mode; refusing before model execution, branch creation, commit, push, or PR creation.\\n' | tee /work/artifacts/patch-command.log`,
    `exit 4`,
  ].join("\n");

  return [writePrompt, pipeline];
}

function buildDefaultReadOnlyValidationCommands(task: RunnerTask, primaryRepo: RunnerRepo): string[] {
  const repoPath = primaryRepo.path ?? "repo";
  const baseBranch = sanitizeGitRef(task.baseBranch ?? primaryRepo.branch ?? "main");
  const safeTitle = (task.id || "a2a-readonly-validation").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const writePrompt = [
    shellWriteTextFile(task.prompt ?? `Read-only validation task ${task.id}`, "/work/artifacts/prompt.md"),
    `printf 'patch_mode=read_only_validation\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'new_pr_allowed=0\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'task=%s\\n' ${shellSingleQuote(safeTitle)} | tee -a /work/artifacts/summary.txt`,
    `printf 'prompt_bytes=%s\\n' "$(wc -c < /work/artifacts/prompt.md)" | tee -a /work/artifacts/summary.txt`,
  ].join("\n");

  const pipeline = [
    `set -euo pipefail`,
    `cd /work/${repoPath}`,
    `printf 'patch_mode=read_only_validation\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'new_pr_allowed=0\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'read_only_validation=started\\n' | tee -a /work/artifacts/summary.txt`,
    buildPatchCommandBlock(),
    buildReadOnlyValidationGuardBlock(baseBranch),
    `printf 'status=no_changes_allowed\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'notice=no_code_changes_produced_evidence_only_lane\\n' | tee -a /work/artifacts/summary.txt`,
  ].join("\n");

  return [writePrompt, pipeline];
}

function buildDefaultPatchCommands(task: RunnerTask, primaryRepo: RunnerRepo): string[] {
  const repoPath = primaryRepo.path ?? "repo";
  const baseBranch = sanitizeGitRef(task.baseBranch ?? primaryRepo.branch ?? "main");
  const safeTitle = (task.id || "a2a-patch").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const issueCommentTarget = task.issueUrl ? shellSingleQuote(task.issueUrl) : "";
  const issueClosingRef = buildIssueClosingRef(task, primaryRepo);
  const prBody = buildPrBody(task, safeTitle, issueClosingRef);
  const bootstrapAllowedTrackedRepoEntries = buildBootstrapAllowedTrackedRepoEntries(task, primaryRepo);

  // Step 1: materialise prompt + task metadata as artifacts.
  const writePrompt = [
    shellWriteTextFile(task.prompt ?? `Auto-patch task ${task.id}`, "/work/artifacts/prompt.md"),
    `printf 'patch_mode=github-propose-patch\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'prompt_bytes=%s\\n' "$(wc -c < /work/artifacts/prompt.md)" | tee -a /work/artifacts/summary.txt`,
  ].join("\n");

  // Step 2: git config + branch + coding agent + commit + push + PR create.
  // Everything that shares shell variables lives in one command so BRANCH
  // and change detection work across the pipeline.
  //
  // Patch command execution contract (priority order):
  //   1. /work/patch-command.sh  →  safe script file (commandScript / commandJson)
  //   2. $A2A_PATCH_COMMAND_JSON  →  JSON argv/env (should be pre-converted; safety net)
  //   3. $A2A_PATCH_COMMAND       →  LEGACY eval (deprecated, kept for compatibility)
  // Stderr stays on stderr here too (see buildPatchCommandBlock): merging it
  // into stdout pollutes the envelope stream the broker parses (#1858).
  const patchCommandBlock = [
    `# Patch command execution: safe script file (recommended).`,
    `if [ -x /work/patch-command.sh ]; then`,
    `  printf 'patch_mode=script\\n' | tee -a /work/artifacts/summary.txt`,
    `  /work/patch-command.sh 2> >(tee /work/artifacts/patch-command.stderr.log >&2) | tee /work/artifacts/patch-command.log`,
    `elif [ -n "\${A2A_PATCH_COMMAND_JSON:-}" ]; then`,
    `  printf 'patch_mode=json_argv_unconverted\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'error=json_argv_received_without_host_side_script_conversion\\n' >&2`,
    `  exit 2`,
    `elif [ -n "\${A2A_PATCH_COMMAND:-}" ]; then`,
    `  printf 'patch_mode=legacy_eval\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'warning=deprecated_eval_path_prefer_commandScript_or_commandJson\\n' | tee -a /work/artifacts/summary.txt`,
    `  eval "\${A2A_PATCH_COMMAND}" 2> >(tee /work/artifacts/patch-command.stderr.log >&2) | tee /work/artifacts/patch-command.log`,
    `else`,
    `  printf 'error=no_patch_command_configured\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'Set A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT or A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON to inject a host-side OpenClaw/Codex coding agent.\\n' | tee /work/artifacts/patch-command.log`,
    `  exit 2`,
    `fi`,
  ].join("\n");

  const startCommentBlock = task.issueUrl ? [
    `printf 'Start\\n' > /work/artifacts/issue-start-comment.md`,
    `if ! command -v gh >/dev/null 2>&1; then`,
    `  printf 'error=gh_unavailable_start_comment_required\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'GitHub literal Start comment is required before patch execution, but gh is unavailable.\\n' | tee /work/artifacts/issue-start-comment-output.txt`,
    `  exit 2`,
    `fi`,
    `if ! gh issue comment ${issueCommentTarget} --body-file /work/artifacts/issue-start-comment.md 2>&1 | tee /work/artifacts/issue-start-comment-output.txt; then`,
    `  printf 'error=start_comment_failed\\n' | tee -a /work/artifacts/summary.txt`,
    `  exit 2`,
    `fi`,
    `START_COMMENT_URL="$(grep -Eo 'https://github.com/[^[:space:]]+/issues/[0-9]+#issuecomment-[0-9]+' /work/artifacts/issue-start-comment-output.txt | tail -n 1 || true)"`,
    `if [ -n "$START_COMMENT_URL" ]; then`,
    `  printf 'start_comment_url=%s\\n' "$START_COMMENT_URL" | tee -a /work/artifacts/summary.txt`,
    `fi`,
    `printf 'start_comment=posted\\n' | tee -a /work/artifacts/summary.txt`,
  ].join("\n") : "";

  const readOnlyValidationGuardBlock = task.readOnlyValidation ? [
    `# Read-only validation/libero lanes may inspect and test, but must not`,
    `# produce repository changes or create patch-lane PR evidence.`,
    `READONLY_CHANGED_PATHS="$( {`,
    `  git status --porcelain | sed -E 's/^...//'`,
    `  git diff --name-only "origin/${baseBranch}...HEAD"`,
    `} | sed '/^$/d' | sort -u )"`,
    `if [ -n "$READONLY_CHANGED_PATHS" ]; then`,
    `  printf 'error=read_only_validation_changed_repo\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'read_only_validation=blocked\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'Read-only validation task produced repository changes; refusing to create a PR.\\n' | tee -a /work/artifacts/patch-command.log`,
    `  printf 'Files detected (repo-relative):\\n' | tee -a /work/artifacts/patch-command.log`,
    `  printf '%s\\n' "$READONLY_CHANGED_PATHS" | tee -a /work/artifacts/patch-command.log`,
    `  printf '%s\\n' "$READONLY_CHANGED_PATHS" | sed '/^$/d; s#^#read_only_change=#' >> /work/artifacts/summary.txt`,
    `  exit 4`,
    `fi`,
    `printf 'read_only_validation=passed\\n' | tee -a /work/artifacts/summary.txt`,
  ].join("\n") : "";

  const prePrBootstrapGuardBlock = [
    `# Re-run the bootstrap guard immediately before git add/commit/push.`,
    `# The container-level post-guard is too late for PR safety because the`,
    `# default pipeline creates the branch before returning to run.sh.`,
    `: "\${BOOTSTRAP_BANNED:=AGENTS.md BOOTSTRAP.md HEARTBEAT.md IDENTITY.md MEMORY.md SOUL.md TOOLS.md USER.md}"`,
    `: "\${BOOTSTRAP_BANNED_DIRS:=.openclaw memory}"`,
    `BOOTSTRAP_ALLOWED_TRACKED_REPO_ENTRIES=${shellSingleQuote(bootstrapAllowedTrackedRepoEntries.join(" "))}`,
    `if ! command -v is_allowed_tracked_bootstrap_path >/dev/null 2>&1; then`,
    `  is_allowed_tracked_bootstrap_path() {`,
    `    repo_dir="$1"`,
    `    path="$2"`,
    `    for allowed in $BOOTSTRAP_ALLOWED_TRACKED_REPO_ENTRIES; do`,
    `      allowed_repo="\${allowed%%:*}"`,
    `      allowed_path="\${allowed#*:}"`,
    `      [ "$repo_dir" = "$allowed_repo" ] || continue`,
    `      [ "$path" = "$allowed_path" ] || continue`,
    `      if [ -n "$(git -C "$repo_dir" ls-files -- "$path")" ] && [ -z "$(git -C "$repo_dir" status --porcelain -- "$path")" ]; then`,
    `        return 0`,
    `      fi`,
    `    done`,
    `    return 1`,
    `  }`,
    `fi`,
    `if ! command -v find_bootstrap_leaks >/dev/null 2>&1; then`,
    `  find_bootstrap_leaks() {`,
    `    repo_dir="$1"`,
    `    (`,
    `      cd "$repo_dir"`,
    `      for name in $BOOTSTRAP_BANNED; do`,
    `        if [ -e "$name" ]; then printf '%s\\n' "$name"; fi`,
    `      done`,
    `      for name in $BOOTSTRAP_BANNED_DIRS; do`,
    `        if [ -d "$name" ]; then`,
    `          found=0`,
    `          while IFS= read -r path; do`,
    `            found=1`,
    `            printf '%s\\n' "\${path#./}"`,
    `          done < <(find "$name" -mindepth 1 -print | sort)`,
    `          if [ "$found" -eq 0 ]; then printf '%s\\n' "$name"; fi`,
    `        fi`,
    `      done`,
    `    )`,
    `  }`,
    `fi`,
    `if ! command -v filter_branch_bootstrap_leaks >/dev/null 2>&1; then`,
    `  filter_branch_bootstrap_leaks() {`,
    `    repo_dir="$1"`,
    `    if ! git -C "$repo_dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then`,
    `      cat`,
    `      return`,
    `    fi`,
    `    while IFS= read -r path; do`,
    `      [ -n "$path" ] || continue`,
    `      if is_allowed_tracked_bootstrap_path "$repo_dir" "$path"; then`,
    `        continue`,
    `      fi`,
    `      if [ -n "$(git -C "$repo_dir" ls-files -- "$path")" ] || [ -n "$(git -C "$repo_dir" status --porcelain -- "$path")" ]; then`,
    `        printf '%s\\n' "$path"`,
    `      fi`,
    `    done`,
    `  }`,
    `fi`,
    `BOOTSTRAP_LEAKS_BEFORE_PR="$(find_bootstrap_leaks "." | filter_branch_bootstrap_leaks "." || true)"`,
    `ARTIFACT_BOOTSTRAP_LEAKS_BEFORE_PR="$(`,
    `  cd /work/artifacts`,
    `  for name in $BOOTSTRAP_BANNED; do`,
    `    if [ -e "$name" ]; then printf 'artifacts/%s\\n' "$name"; fi`,
    `  done`,
    `  for name in $BOOTSTRAP_BANNED_DIRS; do`,
    `    if [ -d "$name" ]; then`,
    `      found=0`,
    `      while IFS= read -r path; do`,
    `        found=1`,
    `        printf 'artifacts/%s\\n' "\${path#./}"`,
    `      done < <(find "$name" -mindepth 1 -print | sort)`,
    `      if [ "$found" -eq 0 ]; then printf 'artifacts/%s\\n' "$name"; fi`,
    `    fi`,
    `  done`,
    `)"`,
    `BOOTSTRAP_BLOCK_PATHS="$(printf '%s\\n%s\\n' "$BOOTSTRAP_LEAKS_BEFORE_PR" "$ARTIFACT_BOOTSTRAP_LEAKS_BEFORE_PR" | sed '/^$/d')"`,
    `if [ -n "$BOOTSTRAP_BLOCK_PATHS" ]; then`,
    `  printf 'error=pre_pr_bootstrap_guard_blocked\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'PR blocked: OpenClaw bootstrap context files appeared before PR creation or artifact evidence capture.\\n' | tee /work/artifacts/patch-command.log`,
    `  printf 'Parent: a2a-broker#446\\n' | tee -a /work/artifacts/patch-command.log`,
    `  printf 'Files detected (repo-relative or artifact-relative):\\n' | tee -a /work/artifacts/patch-command.log`,
    `  printf '%s\\n' "$BOOTSTRAP_BLOCK_PATHS" | tee -a /work/artifacts/patch-command.log`,
    `  printf '%s\\n' "$BOOTSTRAP_BLOCK_PATHS" | sed '/^$/d; s#^#bootstrap_leak=#' >> /work/artifacts/summary.txt`,
    `  exit 4`,
    `fi`,
  ].join("\n");

  const issueCommentBlock = task.issueUrl ? [
    `  cat > /work/artifacts/issue-comment.md <<A2A_ISSUE_COMMENT_EOF`,
    `PR: $PR_URL`,
    ``,
    `A2A task: ${safeTitle}`,
    `A2A_ISSUE_COMMENT_EOF`,
    `  gh issue comment ${issueCommentTarget} --body-file /work/artifacts/issue-comment.md 2>&1 | tee /work/artifacts/issue-comment-output.txt || true`,
  ].join("\n") : "";

  const pipeline = [
    `set -euo pipefail`,
    `cd /work/${repoPath}`,
    `git config user.email "a2a-runner@openclaw.ai"`,
    `git config user.name "A2A Docker Runner"`,
    `BRANCH="a2a-patch-$(date +%Y%m%d-%H%M%S)-${safeTitle}"`,
    `git checkout -b "$BRANCH"`,
    `printf 'branch=%s\\n' "$BRANCH" | tee -a /work/artifacts/summary.txt`,
    ``,
    startCommentBlock,
    ``,
    buildPostPatchVerificationBaselineBlock(task),
    ``,
    patchCommandBlock,
    ``,
    buildDiffHygieneBlock(task, baseBranch),
    ``,
    buildPostPatchVerificationBlock(task),
    ``,
    `# A coding agent must not manage git branches itself, but some do.`,
    `# Normalize back to the runner-owned branch before commit/push so we`,
    `# never push the pre-agent empty branch and then fail with`,
    `# "No commits between main and <branch>".`,
    `CURRENT_BRANCH="$(git branch --show-current || true)"`,
    `if [ -n "$CURRENT_BRANCH" ] && [ "$CURRENT_BRANCH" != "$BRANCH" ]; then`,
    `  printf 'notice=agent_changed_branch from=%s to=%s\n' "$CURRENT_BRANCH" "$BRANCH" | tee -a /work/artifacts/summary.txt`,
    `  if git diff --quiet && git diff --cached --quiet; then`,
    `    git branch -f "$BRANCH" HEAD`,
    `    git checkout "$BRANCH"`,
    `  else`,
    `    git checkout "$BRANCH"`,
    `  fi`,
    `fi`,
    readOnlyValidationGuardBlock,
    prePrBootstrapGuardBlock,
    `EXISTING_PR_URL="$(grep -RhoE 'https://github.com/[^[:space:]]+/pull/[0-9]+' /work/artifacts 2>/dev/null | tail -n 1 || true)"`,
    `# Commit and create PR if changes exist or the agent already committed.`,
    `if [ -n "$(git status --porcelain)" ] || ! git diff --quiet "origin/${baseBranch}...HEAD"; then`,
    ...(task.forbidNewPr ? [
      `  printf 'error=new_pr_forbidden\\n' | tee -a /work/artifacts/summary.txt`,
      `  printf 'Task forbids creating a new PR; use an existing PR refresh path or comment-only closeout.\\n' | tee /work/artifacts/pr-output.txt`,
      `  exit 2`,
    ] : [
      `  if [ -n "$(git status --porcelain)" ]; then`,
      `    git add -A`,
      `    git commit -m "Auto-patch: ${safeTitle}"`,
      `  else`,
      `    printf 'notice=agent_already_committed_changes\n' | tee -a /work/artifacts/summary.txt`,
      `  fi`,
      `  git push origin HEAD:"$BRANCH"`,
      `  cat > /work/artifacts/pr-body.md <<'A2A_PR_BODY_EOF'`,
      prBody,
      `A2A_PR_BODY_EOF`,
      `  gh pr create --base "${baseBranch}" --head "$BRANCH" \\`,
      `    --title "Patch: ${safeTitle}" \\`,
      `    --body-file /work/artifacts/pr-body.md \\`,
      `    2>&1 | tee /work/artifacts/pr-output.txt || true`,
    ]),
    `  PR_URL="$(grep -Eo 'https://github.com/[^[:space:]]+/pull/[0-9]+' /work/artifacts/pr-output.txt | tail -n 1 || true)"`,
    `  if [ -z "$PR_URL" ] && [ -n "$EXISTING_PR_URL" ]; then`,
    `    PR_URL="$EXISTING_PR_URL"`,
    `    printf 'notice=using_existing_pr_url_from_artifacts\n' | tee -a /work/artifacts/summary.txt`,
    `  fi`,
    `  if [ -z "$PR_URL" ]; then`,
    `    printf 'error=pr_create_failed_or_missing_url\\n' | tee -a /work/artifacts/summary.txt`,
    `    exit 2`,
    `  fi`,
    `  printf 'pr_created=1\\n' | tee -a /work/artifacts/summary.txt`,
    `  if command -v a2a-gh-pr-update-branch >/dev/null 2>&1; then`,
    `    if a2a-gh-pr-update-branch "$PR_URL" "${baseBranch}" 2>&1 | tee /work/artifacts/pr-update-branch-output.txt; then`,
    `      printf 'pr_update_branch=ok\\n' | tee -a /work/artifacts/summary.txt`,
    `    else`,
    `      printf 'warning=pr_update_branch_failed\\n' | tee -a /work/artifacts/summary.txt`,
    `    fi`,
    `  fi`,
    issueCommentBlock,
    `else`,
    ...(task.allowNoChanges
      ? [
        `  printf 'status=no_changes_allowed\\n' | tee -a /work/artifacts/summary.txt`,
        `  printf 'notice=no_code_changes_produced_evidence_only_lane\\n' | tee -a /work/artifacts/summary.txt`,
      ]
      : [
        `  printf 'error=no_changes_after_patch_command\\n' | tee -a /work/artifacts/summary.txt`,
        `  exit 2`,
      ]),
    `fi`,
  ].join("\n");

  return [writePrompt, pipeline];
}

function buildDiffHygieneBlock(task: RunnerTask, baseBranch: string): string {
  const policy = task.diffHygiene;
  if (!policy) return "";
  const forbidden = policy.forbiddenPaths?.length ? policy.forbiddenPaths : ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md", "HEARTBEAT.md", "IDENTITY.md", ".openclaw/", "memory/"];
  const forbiddenList = forbidden.map(shellSingleQuote).join(" ");
  const allowLockfiles = policy.allowLockfileChanges === true;
  const blockWhitespaceOnly = policy.blockWhitespaceOnly !== false;
  const churnWarnRatio = policy.churnWarnRatio ?? 0.5;
  const churnBlockRatio = policy.churnBlockRatio ?? 0.9;
  const churnMinLines = policy.churnMinLines ?? 100;
  if (!(churnWarnRatio > 0 && churnWarnRatio <= 1) || !(churnBlockRatio > 0 && churnBlockRatio <= 1) || churnWarnRatio > churnBlockRatio) {
    throw new Error("task.diffHygiene churn ratios must satisfy 0 < churnWarnRatio <= churnBlockRatio <= 1");
  }
  if (!Number.isInteger(churnMinLines) || churnMinLines < 1) {
    throw new Error("task.diffHygiene.churnMinLines must be a positive integer");
  }
  const scopeMode = policy.scope?.mode ?? "warn";
  if (scopeMode !== "off" && scopeMode !== "warn" && scopeMode !== "block") {
    throw new Error("task.diffHygiene.scope.mode must be one of: off, warn, block");
  }
  const declaredScopePaths = task.declaredScope?.paths ?? [];
  if (task.declaredScope !== undefined && (
    !Array.isArray(declaredScopePaths)
    || declaredScopePaths.some((path) => typeof path !== "string" || path.trim().length === 0 || /[\0\r\n]/.test(path))
  )) {
    throw new Error("task.declaredScope.paths must be a non-empty string array when declaredScope is provided");
  }
  const normalizedDeclaredScopePaths = normalizeScopePaths(declaredScopePaths);
  const scopeEnabled = scopeMode !== "off" && normalizedDeclaredScopePaths.length > 0;
  const declaredScopeList = normalizedDeclaredScopePaths.map(shellSingleQuote).join(" ");
  return [
    `# Fail-closed diff hygiene gate (#1219).`,
    `CHANGED_PATHS="$( {`,
    `  git status --porcelain | sed -E 's/^...//'`,
    `  git diff --name-only "origin/${baseBranch}...HEAD"`,
    `} | sed '/^$/d' | sort -u )"`,
    `printf 'diff_hygiene=started\\n' | tee -a /work/artifacts/summary.txt`,
    `printf '%s\\n' "$CHANGED_PATHS" | sed '/^$/d; s#^#changed_path=#' >> /work/artifacts/summary.txt`,
    `BLOCKED_PATHS=""`,
    `for banned in ${forbiddenList}; do`,
    `  while IFS= read -r path; do`,
    `    [ -n "$path" ] || continue`,
    `    case "$banned" in`,
    `      */) case "$path" in "$banned"* ) BLOCKED_PATHS="\${BLOCKED_PATHS}\${BLOCKED_PATHS:+$'\\n'}$path" ;; esac ;;`,
    `      *) [ "$path" = "$banned" ] && BLOCKED_PATHS="\${BLOCKED_PATHS}\${BLOCKED_PATHS:+$'\\n'}$path" ;;`,
    `    esac`,
    `  done <<< "$CHANGED_PATHS"`,
    `done`,
    `LOCKFILE_CHANGES="$(printf '%s\\n' "$CHANGED_PATHS" | grep -E '(^|/)(package-lock\\.json|npm-shrinkwrap\\.json|pnpm-lock\\.yaml|yarn\\.lock)$' || true)"`,
    ...(allowLockfiles ? [] : [
      `if [ -n "$LOCKFILE_CHANGES" ]; then`,
      `  BLOCKED_PATHS="\${BLOCKED_PATHS}\${BLOCKED_PATHS:+$'\\n'}$LOCKFILE_CHANGES"`,
      `fi`,
    ]),
    `WHITESPACE_ONLY=0`,
    ...(blockWhitespaceOnly ? [
      `if [ -n "$CHANGED_PATHS" ] && ! git diff --quiet "origin/${baseBranch}...HEAD" && git diff -w --quiet "origin/${baseBranch}...HEAD"; then`,
      `  WHITESPACE_ONLY=1`,
      `fi`,
    ] : []),
    `# Two-stage reformat churn detection (#1225): whitespace-ignored diff delta.`,
    `TOTAL_CHURN="$(git diff --numstat "origin/${baseBranch}...HEAD" | awk '{a+=$1+$2} END{printf "%d", a+0}')"`,
    `NONWS_CHURN="$(git diff -w --numstat "origin/${baseBranch}...HEAD" | awk '{a+=$1+$2} END{printf "%d", a+0}')"`,
    `WS_CHURN=$((TOTAL_CHURN - NONWS_CHURN))`,
    `[ "$WS_CHURN" -lt 0 ] && WS_CHURN=0`,
    `CHURN_MIN_LINES=${churnMinLines}`,
    `CHURN_RATIO="$(awk -v w="$WS_CHURN" -v t="$TOTAL_CHURN" 'BEGIN{ if (t > 0) printf "%.4f", w/t; else printf "0.0000" }')"`,
    `CHURN_LEVEL="$(awk -v r="$CHURN_RATIO" -v w="$WS_CHURN" -v m="$CHURN_MIN_LINES" -v warn=${churnWarnRatio} -v block=${churnBlockRatio} 'BEGIN{ if (r >= block && w >= m) print "block"; else if (r >= warn && w > 0) print "warn"; else print "none" }')"`,
    `printf 'diff_hygiene_churn_level=%s\\n' "$CHURN_LEVEL" | tee -a /work/artifacts/summary.txt`,
    `printf 'diff_hygiene_churn_ratio=%s total=%s whitespace=%s\\n' "$CHURN_RATIO" "$TOTAL_CHURN" "$WS_CHURN" >> /work/artifacts/summary.txt`,
    `SCOPE_DRIFT_JSON=`,
    ...(scopeEnabled ? [
      `# Declared-scope drift detection (#1235): quality/spec boundary, not a forbidden-path substitute.`,
      `SCOPE_MODE=${shellSingleQuote(scopeMode)}`,
      `SCOPE_OUTSIDE=""`,
      `while IFS= read -r path; do`,
      `  [ -n "$path" ] || continue`,
      `  SCOPE_MATCH=0`,
      `  for declared in ${declaredScopeList}; do`,
      `    case "$declared" in`,
      `      */) case "$path" in "$declared"* ) SCOPE_MATCH=1 ;; esac ;;`,
      `      *) case "$path" in "$declared"|"$declared"/* ) SCOPE_MATCH=1 ;; esac ;;`,
      `    esac`,
      `    [ "$SCOPE_MATCH" = 1 ] && break`,
      `  done`,
      `  [ "$SCOPE_MATCH" = 1 ] || SCOPE_OUTSIDE="\${SCOPE_OUTSIDE}\${SCOPE_OUTSIDE:+$'\\n'}$path"`,
      `done <<< "$CHANGED_PATHS"`,
      `if [ -z "$SCOPE_OUTSIDE" ]; then`,
      `  SCOPE_LEVEL=ok`,
      `elif [ "$SCOPE_MODE" = block ]; then`,
      `  SCOPE_LEVEL=block`,
      `else`,
      `  SCOPE_LEVEL=warn`,
      `fi`,
      `printf 'diff_hygiene_scope_drift_level=%s\\n' "$SCOPE_LEVEL" | tee -a /work/artifacts/summary.txt`,
      `printf '%s\\n' "$SCOPE_OUTSIDE" | sed '/^$/d; s#^#diff_hygiene_scope_drift_outside=#' >> /work/artifacts/summary.txt`,
      `SCOPE_DECLARED_JSON="$(printf '%s\\n' ${shellSingleQuote(normalizedDeclaredScopePaths.join("\n"))} | node -e 'const fs=require("fs"); console.log(JSON.stringify(fs.readFileSync(0,"utf8").split(/\\r?\\n/).filter(Boolean)))')"`,
      `SCOPE_OUTSIDE_JSON="$(printf '%s\\n' "$SCOPE_OUTSIDE" | node -e 'const fs=require("fs"); console.log(JSON.stringify(fs.readFileSync(0,"utf8").split(/\\r?\\n/).filter(Boolean)))')"`,
      `SCOPE_DRIFT_JSON=",\"scopeDrift\":{\"declared\":$SCOPE_DECLARED_JSON,\"outside\":$SCOPE_OUTSIDE_JSON,\"level\":\"$SCOPE_LEVEL\"}"`,
    ] : [
      `SCOPE_LEVEL=ok`,
    ]),
    `CHANGED_PATHS_JSON="$(printf '%s\\n' "$CHANGED_PATHS" | node -e 'const fs=require("fs"); console.log(JSON.stringify(fs.readFileSync(0,"utf8").split(/\\r?\\n/).filter(Boolean)))')"`,
    `BLOCKED_PATHS_JSON="$(printf '%s\\n' "$BLOCKED_PATHS" | node -e 'const fs=require("fs"); console.log(JSON.stringify(fs.readFileSync(0,"utf8").split(/\\r?\\n/).filter(Boolean)))')"`,
    `LOCKFILE_CHANGES_JSON="$(printf '%s\\n' "$LOCKFILE_CHANGES" | node -e 'const fs=require("fs"); console.log(JSON.stringify(fs.readFileSync(0,"utf8").split(/\\r?\\n/).filter(Boolean)))')"`,
    `DIFF_HYGIENE_STATUS=passed`,
    `if [ -n "$BLOCKED_PATHS" ] || [ "$WHITESPACE_ONLY" = 1 ] || [ "$CHURN_LEVEL" = block ] || [ "$SCOPE_LEVEL" = block ]; then`,
    `  DIFF_HYGIENE_STATUS=blocked`,
    `fi`,
    `cat > /work/artifacts/diff-hygiene.json <<A2A_DIFF_HYGIENE_JSON`,
    `{"schemaVersion":"a2a.runner.diff-hygiene.v1","status":"$DIFF_HYGIENE_STATUS","changedPaths":$CHANGED_PATHS_JSON,"blockedPaths":$BLOCKED_PATHS_JSON,"lockfileChanges":$LOCKFILE_CHANGES_JSON,"whitespaceOnly":$([ "$WHITESPACE_ONLY" = 1 ] && printf true || printf false),"churn":{"totalLines":$TOTAL_CHURN,"whitespaceLines":$WS_CHURN,"ratio":$CHURN_RATIO,"level":"$CHURN_LEVEL"}$SCOPE_DRIFT_JSON}`,
    `A2A_DIFF_HYGIENE_JSON`,
    `if [ "$DIFF_HYGIENE_STATUS" = blocked ]; then`,
    `  printf 'diff_hygiene=blocked\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf '%s\\n' "$BLOCKED_PATHS" | sed '/^$/d; s#^#diff_hygiene_blocked_path=#' >> /work/artifacts/summary.txt`,
    `  [ "$WHITESPACE_ONLY" = 1 ] && printf 'diff_hygiene_whitespace_only=1\\n' >> /work/artifacts/summary.txt`,
    `  [ "$SCOPE_LEVEL" = block ] && printf 'diff_hygiene_scope_drift=blocked\\n' >> /work/artifacts/summary.txt`,
    `  exit 5`,
    `fi`,
    `printf 'diff_hygiene=passed\\n' | tee -a /work/artifacts/summary.txt`,
  ].join("\n");
}

function normalizePostPatchVerification(task: RunnerTask): { command: string[]; expectExitCode: number; timeoutMs: number; baseline: "off" | "record" | "require-red" } | undefined {
  const raw = task.postPatchVerification;
  if (!raw) return undefined;
  const command = raw.command ?? ["npm", "run", "check"];
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || part.length === 0 || /[\0\r\n]/.test(part))) {
    throw new Error("task.postPatchVerification.command must be a non-empty string array");
  }
  const expectExitCode = raw.expectExitCode ?? 0;
  if (!Number.isInteger(expectExitCode)) throw new Error("task.postPatchVerification.expectExitCode must be an integer");
  const timeoutMs = raw.timeoutMs ?? 300_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("task.postPatchVerification.timeoutMs must be positive");
  const baseline = raw.baseline ?? "record";
  if (baseline !== "off" && baseline !== "record" && baseline !== "require-red") {
    throw new Error("task.postPatchVerification.baseline must be one of: off, record, require-red");
  }
  return { command, expectExitCode, timeoutMs, baseline };
}

function buildPostPatchVerificationBaselineBlock(task: RunnerTask): string {
  const spec = normalizePostPatchVerification(task);
  if (!spec || spec.baseline === "off") return "";
  const command = spec.command.map(shellSingleQuote).join(" ");
  const commandJson = JSON.stringify(spec.command);
  const timeoutSeconds = Math.max(1, Math.ceil(spec.timeoutMs / 1000));
  const mode = spec.baseline;
  return [
    `# Pre-patch verification baseline (#1233): detect vacuous acceptance before the patch runs.`,
    `POST_PATCH_BASELINE_JSON=`,
    `printf 'post_patch_verification_baseline=started\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'post_patch_verification_baseline.mode=%s\\n' ${shellSingleQuote(mode)} | tee -a /work/artifacts/summary.txt`,
    `POST_PATCH_BASELINE_START_MS="$(node -e 'console.log(Date.now())')"`,
    `set +e`,
    `timeout ${timeoutSeconds}s ${command} > /work/artifacts/post-patch-verification-baseline.log 2>&1`,
    `POST_PATCH_BASELINE_RC=$?`,
    `set -e`,
    `POST_PATCH_BASELINE_END_MS="$(node -e 'console.log(Date.now())')"`,
    `POST_PATCH_BASELINE_DURATION_MS="$((POST_PATCH_BASELINE_END_MS - POST_PATCH_BASELINE_START_MS))"`,
    `POST_PATCH_BASELINE_SHA="$(sha256sum /work/artifacts/post-patch-verification-baseline.log | awk '{print $1}')"`,
    `if [ "$POST_PATCH_BASELINE_RC" -eq ${spec.expectExitCode} ]; then`,
    `  POST_PATCH_BASELINE_MET_EXPECTATION=true`,
    `else`,
    `  POST_PATCH_BASELINE_MET_EXPECTATION=false`,
    `fi`,
    `POST_PATCH_BASELINE_VERDICT=recorded`,
    `if [ ${shellSingleQuote(mode)} = 'require-red' ] && [ "$POST_PATCH_BASELINE_MET_EXPECTATION" = true ]; then`,
    `  POST_PATCH_BASELINE_VERDICT=vacuous`,
    `fi`,
    `printf 'post_patch_verification_baseline.exitCode=%s\\n' "$POST_PATCH_BASELINE_RC" >> /work/artifacts/summary.txt`,
    `printf 'post_patch_verification_baseline.metExpectation=%s\\n' "$POST_PATCH_BASELINE_MET_EXPECTATION" >> /work/artifacts/summary.txt`,
    `printf 'post_patch_verification_baseline.durationMs=%s\\n' "$POST_PATCH_BASELINE_DURATION_MS" >> /work/artifacts/summary.txt`,
    `printf 'post_patch_verification_baseline.logSha256=%s\\n' "$POST_PATCH_BASELINE_SHA" >> /work/artifacts/summary.txt`,
    `printf 'post_patch_verification_baseline.verdict=%s\\n' "$POST_PATCH_BASELINE_VERDICT" >> /work/artifacts/summary.txt`,
    `POST_PATCH_BASELINE_JSON=",\"baseline\":{\"mode\":\"${mode}\",\"exitCode\":$POST_PATCH_BASELINE_RC,\"metExpectation\":$POST_PATCH_BASELINE_MET_EXPECTATION,\"durationMs\":$POST_PATCH_BASELINE_DURATION_MS,\"logSha256\":\"$POST_PATCH_BASELINE_SHA\",\"logPath\":\"artifacts/post-patch-verification-baseline.log\",\"verdict\":\"$POST_PATCH_BASELINE_VERDICT\"}"`,
    `if [ "$POST_PATCH_BASELINE_VERDICT" = vacuous ]; then`,
    `  printf 'post_patch_verification_baseline=blocked_vacuous\\n' | tee -a /work/artifacts/summary.txt`,
    `  printf 'pre-patch verification already met expected exit code; require-red baseline blocks vacuous acceptance\\n' > /work/artifacts/post-patch-verification.log`,
    `  POST_PATCH_VERIFICATION_SHA="$(sha256sum /work/artifacts/post-patch-verification.log | awk '{print $1}')"`,
    `  cat > /work/artifacts/post-patch-verification.json <<A2A_POST_PATCH_VERIFICATION_JSON`,
    `{"schemaVersion":"a2a.runner.post-patch-verification.v1","command":${commandJson},"exitCode":$POST_PATCH_BASELINE_RC,"expectedExitCode":${spec.expectExitCode},"durationMs":$POST_PATCH_BASELINE_DURATION_MS,"logSha256":"$POST_PATCH_VERIFICATION_SHA","logPath":"artifacts/post-patch-verification.log","status":"failed"$POST_PATCH_BASELINE_JSON}`,
    `A2A_POST_PATCH_VERIFICATION_JSON`,
    `  exit 44`,
    `fi`,
    `printf 'post_patch_verification_baseline=recorded\\n' | tee -a /work/artifacts/summary.txt`,
  ].join("\n");
}

function buildPostPatchVerificationBlock(task: RunnerTask): string {
  const spec = normalizePostPatchVerification(task);
  if (!spec) return "";
  const command = spec.command.map(shellSingleQuote).join(" ");
  const commandJson = JSON.stringify(spec.command);
  const timeoutSeconds = Math.max(1, Math.ceil(spec.timeoutMs / 1000));
  return [
    `# Post-patch verification gate (#1219): run inside the task container before PR success.`,
    `printf 'post_patch_verification=started\\n' | tee -a /work/artifacts/summary.txt`,
    `POST_PATCH_VERIFICATION_START_MS="$(node -e 'console.log(Date.now())')"`,
    `set +e`,
    `timeout ${timeoutSeconds}s ${command} > /work/artifacts/post-patch-verification.log 2>&1`,
    `POST_PATCH_VERIFICATION_RC=$?`,
    `set -e`,
    `POST_PATCH_VERIFICATION_END_MS="$(node -e 'console.log(Date.now())')"`,
    `POST_PATCH_VERIFICATION_DURATION_MS="$((POST_PATCH_VERIFICATION_END_MS - POST_PATCH_VERIFICATION_START_MS))"`,
    `POST_PATCH_VERIFICATION_SHA="$(sha256sum /work/artifacts/post-patch-verification.log | awk '{print $1}')"`,
    `: "${"${POST_PATCH_BASELINE_JSON:=}"}"`,
    `printf 'post_patch_verification.command=%s\\n' ${shellSingleQuote(commandJson)} >> /work/artifacts/summary.txt`,
    `printf 'post_patch_verification.exitCode=%s\\n' "$POST_PATCH_VERIFICATION_RC" >> /work/artifacts/summary.txt`,
    `printf 'post_patch_verification.expectedExitCode=%s\\n' ${spec.expectExitCode} >> /work/artifacts/summary.txt`,
    `printf 'post_patch_verification.durationMs=%s\\n' "$POST_PATCH_VERIFICATION_DURATION_MS" >> /work/artifacts/summary.txt`,
    `printf 'post_patch_verification.logSha256=%s\\n' "$POST_PATCH_VERIFICATION_SHA" >> /work/artifacts/summary.txt`,
    `cat > /work/artifacts/post-patch-verification.json <<A2A_POST_PATCH_VERIFICATION_JSON`,
    `{"schemaVersion":"a2a.runner.post-patch-verification.v1","command":${commandJson},"exitCode":$POST_PATCH_VERIFICATION_RC,"expectedExitCode":${spec.expectExitCode},"durationMs":$POST_PATCH_VERIFICATION_DURATION_MS,"logSha256":"$POST_PATCH_VERIFICATION_SHA","logPath":"artifacts/post-patch-verification.log","status":"$([ "$POST_PATCH_VERIFICATION_RC" -eq ${spec.expectExitCode} ] && printf passed || printf failed)"${"$POST_PATCH_BASELINE_JSON"}}`,
    `A2A_POST_PATCH_VERIFICATION_JSON`,
    `if [ "$POST_PATCH_VERIFICATION_RC" -ne ${spec.expectExitCode} ]; then`,
    `  printf 'post_patch_verification=failed\\n' | tee -a /work/artifacts/summary.txt`,
    `  exit "$POST_PATCH_VERIFICATION_RC"`,
    `fi`,
    `printf 'post_patch_verification=passed\\n' | tee -a /work/artifacts/summary.txt`,
  ].join("\n");
}

function buildPrBody(task: RunnerTask, safeTitle: string, issueClosingRef?: string): string {
  const lines = [
    `Auto-generated patch for task \`${safeTitle}\`.`,
    ...(task.issueUrl ? [`Issue: ${singleLine(task.issueUrl)}`] : []),
    ...(task.parentRoundId ? [`Parent round ID: \`${singleLine(task.parentRoundId)}\``] : []),
    ...(task.parentRoundTotal && task.parentRoundOrder ? [`Round progress: ${task.parentRoundOrder}/${task.parentRoundTotal}`] : []),
    ...(task.brokerOfRecordId ? [`Broker of record: \`${singleLine(task.brokerOfRecordId)}\``] : []),
    ...(task.policyContext?.policyScope ? [`Policy scope: ${singleLine(task.policyContext.policyScope)}`] : []),
    ...(task.requestedBy ? [`Requested by: ${singleLine(task.requestedBy)}`] : []),
    ...(issueClosingRef ? ["", `Closes ${issueClosingRef}`] : []),
    "",
    "---",
    "See artifacts/prompt.md for full prompt.",
  ];
  return lines.join("\n");
}

function buildExistingPrUrl(task: RunnerTask): string | undefined {
  const repo = task.repo ?? task.repos?.find((candidate) => candidate.primary)?.url ?? task.repos?.[0]?.url;
  const repoSlug = repo ? parseGitHubRepoSlug(repo) : undefined;
  const rawNumber = task.existingPrNumber != null ? String(task.existingPrNumber) : undefined;
  const prNumber = rawNumber?.match(/#?(\d+)/)?.[1];
  if (!repoSlug || !prNumber) return undefined;
  return `https://github.com/${repoSlug}/pull/${prNumber}`;
}

function buildIssueClosingRef(task: RunnerTask, primaryRepo: RunnerRepo): string | undefined {
  const issue = parseGitHubIssueUrl(task.issueUrl);
  if (!issue) return undefined;
  const primaryRepoSlug = parseGitHubRepoSlug(primaryRepo.url);
  if (primaryRepoSlug && primaryRepoSlug.toLowerCase() === issue.repo.toLowerCase()) {
    return `#${issue.number}`;
  }
  return `${issue.repo}#${issue.number}`;
}

function parseGitHubIssueUrl(issueUrl?: string): { repo: string; number: string } | undefined {
  const match = issueUrl?.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/(\d+)(?:$|[/?#])/);
  return match ? { repo: match[1] ?? "", number: match[2] ?? "" } : undefined;
}

function parseGitHubRepoSlug(repoUrl: string): string | undefined {
  const normalized = normalizeRepoUrl(repoUrl);
  const match = normalized.match(/^https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/);
  return match?.[1];
}

function buildBootstrapAllowedTrackedRepoEntries(task: RunnerTask, primaryRepo: RunnerRepo): string[] {
  if (task.mode !== FAMILY_WIKI_READONLY_AUDIT_MODE) return [];
  if (parseGitHubRepoSlug(primaryRepo.url) !== FAMILY_WIKI_REPO_SLUG) return [];
  return [".:AGENTS.md"];
}

/**
 * Build toolchain-aware default commands for a repository path.
 *
 * Detects the project language and runs appropriate install/test commands.
 * Supports Node.js (package.json), Python (pyproject.toml, requirements.txt,
 * setup.py, setup.cfg), Go (go.mod), and Java (pom.xml, build.gradle,
 * build.gradle.kts).  Fails closed with a deterministic Block evidence marker
 * when the toolchain cannot be determined or the required runtime is
 * unavailable in the container.
 *
 * Parent: a2a-docker-runner#339
 * Parent: a2a-docker-runner#343
 */
export function buildToolchainDetectedCommandsForRepo(repoPath: string): string {
  const here = `/work/${repoPath}`;
  const lines = [
    `cd ${here}`,
    `# ── Auto-detect toolchain ───────────────────────────────────`,
    `# Check Node.js first (most common for this runner).`,
    `if [ -f package.json ]; then`,
    `  printf 'toolchain=nodejs\\n' | tee -a /work/artifacts/summary.txt`,
    `  npm ci 2>&1 || exit 1`,
    `  npm test 2>&1 || exit 1`,
    `  exit 0`,
    `fi`,
    ``,
    `# ── Python projects ─────────────────────────────────────────`,
    `# Accept python or python3; prefer python3.`,
    `PYTHON=""`,
    `if command -v python3 >/dev/null 2>&1; then`,
    `  PYTHON="python3"`,
    `elif command -v python >/dev/null 2>&1; then`,
    `  PYTHON="python"`,
    `fi`,
    ``,
    `# Detect Python project markers.`,
    `if [ -f pyproject.toml ] || [ -f requirements.txt ] || [ -f setup.py ] || [ -f setup.cfg ]; then`,
    `  if [ -z "$PYTHON" ]; then`,
    `    printf 'error=python_unavailable\\n' | tee -a /work/artifacts/summary.txt`,
    `    printf 'Python project detected but neither python3 nor python is available in the container.\\n' >&2`,
    `    exit 1`,
    `  fi`,
    `  printf 'toolchain=python\\n' | tee -a /work/artifacts/summary.txt`,
    ``,
    `  # Install dependencies.`,
    `  if [ -f requirements.txt ]; then`,
    `    "$PYTHON" -m pip install -r requirements.txt 2>&1 || exit 1`,
    `  elif [ -f setup.py ] || [ -f setup.cfg ]; then`,
    `    "$PYTHON" -m pip install -e . 2>&1 || exit 1`,
    `  elif [ -f pyproject.toml ]; then`,
    `    "$PYTHON" -m pip install -e . 2>&1 || exit 1`,
    `  fi`,
    ``,
    `  # Run tests.  Prefer pytest when installed; otherwise use unittest for conventional test files.`,
    `  if "$PYTHON" -c 'import pytest' >/dev/null 2>&1; then`,
    `    printf 'test_runner=pytest\\n' | tee -a /work/artifacts/summary.txt`,
    `    "$PYTHON" -m pytest 2>&1 || exit 1`,
    `  else`,
    `    TEST_FILE="$(find . -path './.git' -prune -o -type f \\( -name 'test_*.py' -o -name '*_test.py' \\) -print -quit)"`,
    `    if [ -n "$TEST_FILE" ]; then`,
    `      printf 'test_runner=unittest\\n' | tee -a /work/artifacts/summary.txt`,
    `      "$PYTHON" -m unittest discover 2>&1 || exit 1`,
    `    else`,
    `      printf 'warning=no_test_runner_found\\n' | tee -a /work/artifacts/summary.txt`,
    `    fi`,
    `  fi`,
    `  exit 0`,
    `fi`,
    ``,
    `# ── Go projects ──────────────────────────────────────────────`,
    `if [ -f go.mod ]; then`,
    `  if ! command -v go >/dev/null 2>&1; then`,
    `    printf 'error=go_unavailable\\n' | tee -a /work/artifacts/summary.txt`,
    `    printf 'Go project detected (go.mod) but go is not available in the container.\\n' >&2`,
    `    exit 1`,
    `  fi`,
    `  printf 'toolchain=go\\n' | tee -a /work/artifacts/summary.txt`,
    `  go test ./... 2>&1 || exit 1`,
    `  exit 0`,
    `fi`,
    ``,
    `# ── Java projects ────────────────────────────────────────────`,
    `# Maven (pom.xml)`,
    `if [ -f pom.xml ]; then`,
    `  if ! command -v mvn >/dev/null 2>&1; then`,
    `    printf 'error=maven_unavailable\\n' | tee -a /work/artifacts/summary.txt`,
    `    printf 'Java/Maven project detected (pom.xml) but mvn is not available in the container.\\n' >&2`,
    `    exit 1`,
    `  fi`,
    `  printf 'toolchain=java_maven\\n' | tee -a /work/artifacts/summary.txt`,
    `  mvn test -B 2>&1 || exit 1`,
    `  exit 0`,
    `fi`,
    ``,
    `# Gradle (build.gradle / build.gradle.kts)`,
    `if [ -f build.gradle ] || [ -f build.gradle.kts ]; then`,
    `  if [ -f gradlew ]; then`,
    `    GRADLE="./gradlew"`,
    `  elif command -v gradle >/dev/null 2>&1; then`,
    `    GRADLE="gradle"`,
    `  else`,
    `    printf 'error=gradle_unavailable\\n' | tee -a /work/artifacts/summary.txt`,
    `    printf 'Java/Gradle project detected but neither gradlew nor gradle is available in the container.\\n' >&2`,
    `    exit 1`,
    `  fi`,
    `  printf 'toolchain=java_gradle\\n' | tee -a /work/artifacts/summary.txt`,
    `  "$GRADLE" test 2>&1 || exit 1`,
    `  exit 0`,
    `fi`,
    ``,
    `# ── Unsupported toolchain ────────────────────────────────────`,
    `printf 'error=toolchain_unsupported\\n' | tee -a /work/artifacts/summary.txt`,
    `printf 'ERROR: Unsupported repository toolchain.\\n' >&2`,
    `printf 'No Node.js (package.json), Python (pyproject.toml, requirements.txt, setup.py, setup.cfg), Go (go.mod), or Java (pom.xml, build.gradle, build.gradle.kts) project files found.\\n' >&2`,
    `printf 'Block evidence: a2a-docker-runner#343\\n' >&2`,
    `printf 'To fix: add the missing project file, or specify explicit commands in the task configuration.\\n' >&2`,
    `exit 1`,
  ];
  return lines.join("\n");
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Emit a shell command that writes arbitrary text to a file without any
 * heredoc or quoting hazard. The text is base64-encoded on the host and
 * decoded in the container; the base64 alphabet ([A-Za-z0-9+/=]) is
 * shell-safe inside single quotes, so the payload cannot break out of the
 * surrounding command regardless of its contents (e.g. a line that matches a
 * heredoc delimiter, embedded quotes, `$(...)`, or backticks).
 */
function shellWriteTextFile(content: string, destPath: string): string {
  const encoded = Buffer.from(content, "utf8").toString("base64");
  return `printf '%s' '${encoded}' | base64 -d > ${destPath}`;
}

/**
 * Sanitize a repository checkout path. The result is interpolated UNQUOTED
 * into generated shell (e.g. `cd /work/<path>`), so it must contain no
 * shell-active characters and no parent-directory traversal. Each path
 * segment is reduced to a strict filename allowlist; empty and dot-only
 * segments (".", "..") are dropped.
 */
function sanitizeRelativePath(path: string): string {
  const segments = path
    .split("/")
    .map((segment) => segment.replace(/[^A-Za-z0-9_.-]/g, "_"))
    .filter((segment) => segment !== "" && !/^\.+$/.test(segment));
  const cleaned = segments.join("/");
  if (!cleaned) return "repo";
  return cleaned;
}

/**
 * Validate a git ref (branch) name for safe interpolation into shell. Branch
 * names flow into double-quoted shell strings (e.g. `git diff
 * "origin/<branch>...HEAD"`, `gh pr create --base "<branch>"`), where `$`,
 * backticks, `"`, and `\` are still active.
 *
 * Rather than partially sanitizing untrusted input into a Frankenstein branch
 * name, a ref is accepted only if it is already a legal git branch ref
 * (git-ref characters, no ".." sequence, no leading/trailing separator);
 * anything else falls back to the safe default "main". This guarantees the
 * result contains no shell-active characters.
 */
function sanitizeGitRef(ref: string): string {
  const trimmed = ref.trim();
  if (
    trimmed.length > 0 &&
    trimmed.length <= 255 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed) &&
    !trimmed.includes("..") &&
    !trimmed.endsWith("/") &&
    !trimmed.endsWith(".")
  ) {
    return trimmed;
  }
  return "main";
}
