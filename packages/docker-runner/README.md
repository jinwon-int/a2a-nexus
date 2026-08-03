# A2A Docker Runner

[![CI](https://github.com/jinwon-int/a2a-docker-runner/actions/workflows/ci.yml/badge.svg)](https://github.com/jinwon-int/a2a-docker-runner/actions/workflows/ci.yml)

Docker/Podman task runner for A2A workers.

## Repository role in the A2A layout

`a2a-docker-runner` is the isolated execution engine for A2A worker tasks.

It owns:

- one-container-per-task Docker/Podman execution
- GitHub repository checkout, patch command execution, commit/push/PR creation, and artifact collection
- generic coding-agent command injection through safe `commandScript` / `commandJson` paths
- artifact manifests plus PR/Block/Done evidence used by the broker contract
- read-only secret/config mounts for coding-agent credentials and GitHub auth

It does **not** own task routing, worker lifecycle, stale recovery, or agent gateway methods. Those live in [`jinwon-int/a2a-broker`](https://github.com/jinwon-int/a2a-broker) and [`jinwon-int/plugin-a2a`](https://github.com/jinwon-int/plugin-a2a).

Current production baseline as of 2026-04-30:

- deployed on `workerGamma`, `workerBeta`, `workerEpsilon`, `workerAlpha`
- all generic GitHub patch tasks route Docker-first via the broker worker handler
- the coding-agent command is configured externally by worker environment, not embedded in this repo
## Why

A2A workers currently execute delegated work in the host OpenClaw workspace. After many tasks, repos, build artifacts, logs, and session files can mix together and make local OpenClaw unhealthy. This runner keeps task execution isolated:

```text
A2A Broker → Host A2A Worker → A2A Docker Runner → one task container
```

The broker stays unchanged. The host worker still claims tasks and reports results over the existing HTTP broker endpoint and edge-secret contract. The broker may be hosted by Docker Compose, systemd, or another supervisor; this runner does not require or manage the broker process. The runner is only the execution engine used by the worker for file-heavy jobs.

## Agent profile guards

When `A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw` is used, the runner mounts the host OpenClaw config directory read-only and copies only the minimal auth/model files into the container. It also refuses dangerous session-store states before starting embedded OpenClaw:

- `sessions.json` parsed as `{}` is treated as damaged host continuity and blocks the run.
- `*.jsonl.bak-*` buildup is reported as `warning=openclaw_session_store_guard` when count/bytes exceed thresholds.
- Writable extra mounts that target or source host OpenClaw runtime paths are rejected; only scratch paths may be mounted read-write.
- The generated GitHub patch pipeline re-runs the ignored-file-aware bootstrap guard immediately before `git add`/push/PR creation and artifact evidence capture, so agent-created `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**` files fail closed before they can enter a branch or evidence bundle.

Tunables:

- `A2A_OPENCLAW_SESSION_BACKUP_WARN_COUNT` (default `50`)
- `A2A_OPENCLAW_SESSION_BACKUP_WARN_BYTES` (default `134217728`, 128 MiB)

The runner intentionally does **not** repair host sessions itself. A damaged session registry should be recovered by the operator/OpenClaw host guard first, then the A2A task can be retried.

When `A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=hermes` is used, the runner mounts
the host Hermes profile read-only and copies only the minimal files needed by the
disposable container (`config.yaml`, `.env`, `auth.json`, `honcho.json`, and
`skills/`). It does not copy Hermes sessions, logs, caches, or state databases.
The generated script runs `hermes chat --query ... --quiet --yolo` and blocks
runtime context leaks such as `.openclaw/`, `.hermes/`, `memory/`, or workspace
bootstrap files from entering PR branches or evidence.

### Contained subagent opt-in

The Codex patch profile defaults to **no subagent fanout**. This keeps the normal
worker path single-owner and avoids surprising context, output, or credential
spread. For broad or context-heavy A2A work, a trusted Codex worker host may opt
in to bounded helper use inside the same task container with the shared
contained-subagent controls (existing OpenClaw/Hermes behavior is unchanged):

```bash
export A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED=1
export A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX=2
export A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_OUTPUT_BYTES=12000
export A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_REASONS=context_heavy,broad_source_inspection,validation_split
export A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES=explorer,implementer,verifier
```

Rules for this mode:

- only first-class profiles with a wired fanout path can enable contained
  subagents; the Codex path is explicit opt-in;
- helper work must stay inside the checked-out repo and disposable container
  workspace;
- helper output is evidence only, bounded by
  `A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_OUTPUT_BYTES`, and must be redacted;
- one final worker answer still owns the PR/Done/Block evidence, while broker
  merge/closeout/runtime decisions stay with the finalizer;
- if the task needs more fanout than the cap or must cross the Docker boundary,
  produce Block evidence instead of unbounded subagent spawning.

Use contained subagents for broad source inspection, context-overflow retry, or
validation split work. Use model escalation instead when the work is still one
coherent lane and only needs stronger reasoning. The two mechanisms should not
be combined casually; explicit task metadata should justify the extra fanout.

For the Codex profile, the runner creates task-scoped custom agents under the
disposable `CODEX_HOME`: `a2a_explorer` and `a2a_researcher` use
`gpt-5.6-luna` with `max` reasoning, while `a2a_implementer` stays on
`gpt-5.6-sol`/`high` and `a2a_verifier` stays on
`gpt-5.6-sol`/`xhigh`. The parent/finalizer continues to use
`A2A_CODEX_MODEL` and `A2A_CODEX_REASONING_EFFORT`; enabling helpers never
changes the parent model. The role allowlist controls which custom profiles are
materialized, and disabling the flag simply installs no role profiles. The runner
passes no scalar `agents.*` override: codex 0.144.1 reads `agents` as a table of
role names, so `agents.enabled=<bool>` is rejected as an `AgentRoleToml` type error
and codex refuses to start.
The Codex thread setting caps concurrently open helpers; the broker/task budget
still governs total spawns. Read-only role declarations are defense in depth
inside the parent container permission boundary, not separate containers.

## MVP Scope

Phase 1 focuses on GitHub/PR-producing tasks:

- create one clean work directory per task
- start one container per task
- clone one or more target repos inside the container
- run bounded commands with CPU/RAM/timeout limits
- return structured stdout/stderr/artifacts/PR URL
- clean containers automatically; keep task artifacts for audit/TTL cleanup

## Credential and egress boundary

Public safe-default runner config treats task commands as untrusted:

- `A2A_DOCKER_RUNNER_NETWORK` defaults to `none` unless an operator selects a reviewed network.
- `A2A_DOCKER_RUNNER_GITHUB_TOKEN_FILE` is rejected unless `A2A_DOCKER_RUNNER_TRUSTED_OPERATOR=1`.
- `buildRunArgs` defensively avoids mounting `/run/secrets/gh-hosts.yml` and filters `GH_TOKEN`/`GITHUB_TOKEN`-style credential env vars for untrusted task commands.

Trusted GitHub PR/comment/push lanes must opt into `A2A_DOCKER_RUNNER_TRUSTED_OPERATOR=1` and should use short-lived, repo/branch-scoped credentials where possible. Log redaction is still required, but it is not treated as an exfiltration control.

Phase 2 can add generic analyze/backfill task support.

## CLI

```bash
npm install
npm run build
node dist/cli.js doctor
node dist/cli.js install
node dist/cli.js cleanup --ttl 24h --dry-run
node dist/cli.js run examples/task.canonical.json
node dist/cli.js run examples/task.github.json
node dist/cli.js run examples/task.github-evidence.json
node dist/cli.js run examples/task.github-propose-patch.json
node dist/cli.js run examples/task.openclaw-plugin-a2a.json
```

### Public quickstart safety

Public/demo setups should start from the least-privilege path:

- Use a GitHub token limited to the target repository and required PR/comment scopes; do not reuse an operator's broad personal token.
- Keep tokens and agent auth in environment variables or read-only secret mounts. Do not put token values in task payloads, examples, prompts, artifacts, or GitHub comments.
- Leave `A2A_DOCKER_RUNNER_TRUSTED_OPERATOR` unset for public/default workers. In this mode, pre-deploy validation rejects host networking, privilege-escalation opt-outs, and added Linux capabilities before a task container starts.
- Treat `A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw` or `hermes`, host agent config mounts, and any host-network Docker/Podman mode as operator-only trusted-worker features. Internal workers that intentionally need those features must set `A2A_DOCKER_RUNNER_TRUSTED_OPERATOR=1` explicitly.
- Writable extra mounts that target/source protected OpenClaw or Hermes runtime/session paths remain blocked in both public-safe and trusted-operator modes.
- Use neutral placeholder paths in docs and fixtures, for example `/secure/operator/openclaw-config`, instead of real workstation or server home directories.

See [`docs/safe-default-threat-model.md`](docs/safe-default-threat-model.md) for the code-enforced public safe-default vs trusted-operator boundary.

## Canonical A2A Task Format

The full `github-propose-patch` mode task accepts:

```json
{
  "id": "canonical-github-propose-patch",
  "intent": "propose_patch",
  "mode": "github-propose-patch",
  "repo": "jinwon-int/a2a-docker-runner",
  "baseBranch": "main",
  "commands": ["..."],
  "issueUrl": "https://github.com/jinwon-int/a2a-docker-runner/issues/1",
  "reportLanguage": "ko",
  "requestedBy": "workerEpsilon",
  "timeoutMs": 300000
}
```

See `examples/task.canonical.json` for a complete example.

## PR-producing executor path (github-propose-patch)

When `mode` is `github-propose-patch` (or `propose_patch`) and no explicit
`commands` are provided, the runner generates a default PR-producing pipeline
that writes the `prompt` to `/work/artifacts/prompt.md` and executes a
configurable coding agent via the `A2A_PATCH_COMMAND` escape hatch.

Example task (see `examples/task.github-propose-patch.json`):

```json
{
  "id": "patch-readme-example",
  "intent": "propose_patch",
  "mode": "github-propose-patch",
  "repo": "jinwon-int/a2a-docker-runner",
  "baseBranch": "main",
  "prompt": "Add a section to README.md.",
  "issueUrl": "https://github.com/jinwon-int/a2a-docker-runner/issues/10",
  "reportLanguage": "ko",
  "requestedBy": "workerEpsilon",
  "timeoutMs": 600000
}
```

The runner will clone the repo, create a branch, run the coding agent,
commit changes, push, and open a PR. Result evidence includes
`github.prUrl`, `github.blockCommentUrl`, or `github.doneCommentUrl`
depending on the outcome.

## PR-less validation lanes (allowNoChanges / readOnlyValidation)

Some A2A tasks produce zero code changes and must still output clean
Done or Block evidence.  The runner supports two task-level flags for
this pattern, collectively referred to as **PR-less validation lanes**.

### allowNoChanges

When `allowNoChanges: true` is set, the default pipeline allows the
no-code-change outcome instead of failing closed.  The pipeline emits
`status=no_changes_allowed`, the runner sets `result.ok=true`, and
`collectGitHubEvidence` posts a Done comment on the issue — without
creating a PR.

Use this for:

- **Evidence-only readiness checks** that inspect a repository and
  confirm no patch is warranted.
- **Preflight validation** that must succeed (exit 0) regardless of
  whether code was changed.
- **Liveness / health lanes** that verify the runner and agent
  integration are reachable.

Example task:

```json
{
  "id": "readiness-validation",
  "intent": "propose_patch",
  "mode": "github-propose-patch",
  "repo": "jinwon-int/a2a-docker-runner",
  "allowNoChanges": true,
  "issueUrl": "https://github.com/jinwon-int/a2a-docker-runner/issues/237",
  "requestedBy": "workerAlpha",
  "timeoutMs": 600000
}
```

### readOnlyValidation

`readOnlyValidation` extends `allowNoChanges` with a hard guard: if the
coding agent produces any repository changes (staged or unstaged,
tracked or untracked), the pipeline exits 4 **before** commit, push,
or PR creation.  The runner posts a Block comment listing the offending
files.

Use this for:

- **Validation lanes** that must never create patches, only inspect and
  report.
- **Operator-protected stability rounds** where worker-initiated
  changes are not allowed.
- **Libero / read-only roles** that produce evidence without mutation.

When `readOnlyValidation` is set:

- `allowNoChanges` is implied and auto-set.
- The no-change path (no changes produced) emits
  `status=no_changes_allowed` and posts Done evidence — same as
  `allowNoChanges` alone.
- The change path (any file difference on the branch) exits 4 and
  posts Block evidence.
- No PR is ever created.

Example task:

```json
{
  "id": "read-only-stability-round",
  "intent": "propose_patch",
  "mode": "github-propose-patch",
  "repo": "jinwon-int/a2a-docker-runner",
  "readOnlyValidation": true,
  "issueUrl": "https://github.com/jinwon-int/a2a-docker-runner/issues/237",
  "requestedBy": "workerAlpha",
  "timeoutMs": 600000
}
```

### Evidence outcomes

The `github.outcome` in the runner result distinguishes no-change
outcomes from standard PR/Done/Block:

| Outcome | Condition |
|---|---|
| `succeeded_no_changes_with_done_evidence` | `allowNoChanges` + no changes + Done comment posted |
| `blocked_no_changes_with_evidence` | `allowNoChanges` + blocked + Block comment posted |
| `block` | `readOnlyValidation` + changes detected (exit 4) + Block comment posted |

Release-gate validation is skipped for
`succeeded_no_changes_with_done_evidence` and
`blocked_no_changes_with_evidence` outcomes — PR-level fields are not
required when the evidence lane terminated without producing a pull
request.

Dashboard/read-model consumers should preserve these PR-less outcomes
instead of flattening them into generic `done` / `block` states.  A
valid no-diff validation Done result is not a runner failure and should
carry an empty risk list, while a PR-less Block result should say that
validation was blocked and point operators at the Block evidence.  Missing
PR/Done/Block evidence remains a separate fail-closed condition.

## OpenClaw plugin A2A development preset

The first-class A2A development path is to keep the runner stateless and clone `openclaw-plugin-a2a` for each job:

```json
{
  "id": "issue-76-plugin-run",
  "intent": "propose_patch",
  "preset": "openclaw-plugin-a2a-dev",
  "timeoutMs": 3600000
}
```

The preset expands to:

- checkout `https://github.com/jinwon-int/openclaw-plugin-a2a.git` into `/work/openclaw-plugin-a2a`
- run `cd /work/openclaw-plugin-a2a && npm ci`
- run `cd /work/openclaw-plugin-a2a && npm test`
- write command logs and task metadata under `/work/artifacts`

For integration jobs, pass explicit repos and commands instead:

```json
{
  "id": "plugin-core-integration",
  "intent": "propose_patch",
  "repos": [
    { "name": "plugin", "url": "jinwon-int/openclaw-plugin-a2a", "path": "plugin", "primary": true },
    { "name": "openclaw", "url": "jinwon-int/openclaw", "path": "openclaw" }
  ],
  "commands": [
    "cd /work/plugin && npm ci",
    "cd /work/plugin && npm test"
  ]
}
```

This keeps `a2a-docker-runner` as the disposable execution sandbox while `openclaw-plugin-a2a` remains the main development repo.

## Operator terminal evidence contract

The worker-facing integration returns a compact `terminalEvidence` object for broker
push/SSE/webhook delivery. Broker/workers must treat this as notification data
only; operator Telegram and main-session delivery stay owned by
brokerAlpha/OpenClaw `plugin-notifier`, not by this runner.

The event is intentionally small and secret-free:

- `eventId` / `dedupeKey`: stable idempotency keys for broker replay and plugin retry dedupe
- `status`: `succeeded`, `failed`, `cancelled`, or `blocked`
- `evidenceKind`: canonical receipt vocabulary: `PR`, `Done`, `Block`, `BudgetLimited`, `TimedOut`, or `MissingEvidence`
- `repo` and `issue`: repository plus canonical issue URL/reference
- `prUrl`, `doneUrl`, or `blockUrl`: the chosen completion evidence URL
- `alert.title`, `alert.body`, `alert.url`: compact preformatted notification text for adapters such as OpenClaw plugin-notifier
- `terminalBrief`: optional parent-round aggregation context for concise titles, including `parentRoundId`, `parentBroker`, `originBroker`, `brokerOfRecord`, `ownership: "parent-broker-only"`, and known `progress.sequence/total`; these fields preserve routing metadata without being appended to the operator title
- `testSummary.label`: one-line runner outcome with exit, timeout, artifact count
- `runnerBuild`: optional bounded build metadata (`version`, `source`, `revision`, `builtAt`, `image`)
- `reason`: short human-facing Done/Block/failure reason
- Budget-limited runs are never reported as Done. If `artifactManifest.status` or
  `resultSummary.status` is `budget_limited`, broker/plugin summaries must show a
  blocked/needs-continuation outcome and include a safe next action instead of
  auto-continuing.

It must not include raw stdout/stderr, host work directories, secrets, or oversized
command output. Detailed logs remain in runner artifacts and bounded
`runnerRaw` debugging fields. Adapters should use `dedupeKey` as the durable
notification id and may render `alert` directly without re-parsing logs.

For broker operator-task-report summaries, the integration exposes
`buildOperatorTaskReportEvidence(handlerResult)`. That projection keeps only the
canonical task id, worker, repo/issue, evidence kind, PR/Done/Block URL, tests,
risks, runner build metadata, and summary. It intentionally omits `runnerRaw`,
stdout/stderr excerpts, host paths, Telegram message ids, and any provider-send
receipt. Per-worker live Telegram/message delivery remains out of scope for this
repo; the runner produces compact evidence, while brokerAlpha/OpenClaw broker/plugin
surfaces decide if and when an operator-visible notification is sent and ACKed.

### Artifact budget/continuation contract

Modern artifacts may include sanitized budget, receipt trace, and continuation evidence in
`artifacts/manifest.json` and the bounded `resultSummary` copy:

```json
{
  "status": "done|blocked|failed|budget_limited",
  "budget": {
    "limitKind": "time|token|attempt|command|safety",
    "limit": "60m task timeout budget",
    "used": "60m",
    "reason": "Stopped before completing validation within the bounded task budget."
  },
  "receiptTrace": {
    "schemaVersion": "a2a.runner.receipt-trace.v1",
    "outboxId": "terminal-outbox-133",
    "dedupeKey": "task-133:succeeded",
    "channel": "telegram",
    "status": "stale",
    "attemptCount": 2,
    "reason": "terminal notification pending operator-visible receipt"
  },
  "continuation": {
    "recommended": true,
    "nextPrompt": "Continue from artifacts/summary.txt; finish validation after approval.",
    "requiresApproval": true
  }
}
```

Rules:

- `budget_limited` means constrained/unfinished, not success. It must not be
  mapped to Done even if older output also contains a `doneCommentUrl`.
- `continuation.requiresApproval` must be `true`; the runner and broker must not
  start unbounded or automatic continuation loops.
- `nextPrompt` is a recommendation only. Keep it bounded, artifact-referenced,
  and secret-free; never include tokens, private env values, raw host paths, or
  oversized logs.
- `receiptTrace` is additive and bounded. It may preserve safe correlation IDs,
  receipt status/evidence vocabulary, attempts, and a short redacted reason for
  pending/stale/failed/confirmed receipt-gap reports; it must never include raw
  prompts, raw command output, notifier message bodies, tokens, or private paths.
- Provider/send states such as `accepted` or `provider_sent` are not receipt
  confirmation. Broker/plugin closeout should only treat `operator_visible`,
  `operator_confirmed`, `provider_delivery_receipt`, or `receipt_confirmed` as
  confirmed receipt evidence.
- A safe next action is: review the artifacts and budget reason, then approve one
  bounded follow-up task if continuation is still appropriate.

A synthetic CI fixture for this shape lives at
[`examples/runner-budget-limited-fixture.json`](examples/runner-budget-limited-fixture.json).

A CI-safe Telegram receipt smoke is available for the terminal notification ACK
contract:

```bash
npm run smoke:telegram-terminal-ack
```

The smoke uses synthetic runner output and synthetic Telegram receipt metadata.
It first proves provider send success alone leaves the terminal cursor incomplete,
then confirms ACK only after an operator-visible Telegram receipt is present. It
performs no live Telegram, broker, or GitHub writes.

For all-worker rollout evidence, merge the per-worker receipt-smoke reports into
a sanitized JSON file and run the fail-closed guard against the merge commit:

```bash
npm run rollout:receipt-evidence -- \
  --input artifacts/rollout-receipt-evidence.json \
  --expected-commit 123df9b19e2c600e826273f5b16117039aa44b6f
```

The merged evidence must contain exactly the active workers being rolled out
(`workerGamma`, `workerEpsilon`, `workerBeta`, `workerAlpha`). For each worker the guard requires the
runner artifact version and revision, a passing focused test result, an
operator-visible terminal receipt smoke result, proof that provider-send-only ACK
would not advance the cursor, and proof that there is no stale terminal-receipt
backlog. Missing workers, mismatched commits, stale backlog, or provider-send-only
ACK evidence exit non-zero. Keep the input synthetic/sanitized: no tokens, private
host paths, raw logs, or live Telegram ACKs.

A compact no-live proof bundle fixture is available at
[`examples/rollout-receipt-evidence.no-live.json`](examples/rollout-receipt-evidence.no-live.json).
It is intentionally synthetic and exercises the guard without production deploys,
Gateway restarts, live Telegram sends, DB mutations, or real terminal-outbox ACKs.

For public-demo readiness, run the fixture safety audit:

```bash
npm run smoke:public-demo-safety
```

The audit validates the published no-live artifact/operator fixtures as JSON and
fails closed on secret-shaped values, private home paths, live Telegram targets,
production deploy flags, Gateway restart flags, DB mutation flags, or terminal
outbox ACK shortcuts. It is a local/synthetic smoke only; it does not call the
broker, GitHub, Telegram, OpenClaw Gateway, or Docker.

## Worker operations

`doctor` prints JSON status for worker readiness checks:

- `docker` and `podman` availability
- configured task-root access and permissions
- optional GitHub hosts secret readability and intended `:ro` container mount
- configured base-image presence or pull readiness
- `githubPatch` readiness for generic `github-propose-patch` execution; the
  OpenClaw profile path includes a no-secret container probe for the `openclaw`
  CLI, `/run/secrets/openclaw-dir` profile mount, and explicit compaction model
  provider readiness
- `runnerRevision` deployed-revision drift status for the runner checkout/package

`runnerRevision.detail.summary` is a compact operator line suitable for broker/plugin surfaces. It reports the deployed package version, local runner SHA, upstream GitHub `main` SHA when available, branch, and dirty-worktree state without echoing remotes, tokens, secret files, or host-specific paths. For exact revision proof, the JSON detail also includes full 40-character `localFullSha` and `upstreamMainFullSha` fields when they are inspectable. A clean current checkout returns `status: "ok"`; stale, dirty, non-main, or upstream-unavailable source checkouts return `status: "warn"` so rollout operators can review drift without blocking unrelated readiness checks.

Examples:

```text
PASS runner=v0.1.0 local=ff4c244a38a7 upstreamMain=ff4c244a38a7 branch=main dirty=no
WARN runner=v0.1.0 local=160bd95af6b4 upstreamMain=ff4c244a38a7 branch=main dirty=no
WARN runner=v0.1.0 local=ff4c244a38a7 upstreamMain=ff4c244a38a7 branch=feature/drift dirty=yes
```

To check the four deployed workers from an operator shell, run the doctor in each runner checkout and print only the compact line:

```bash
for host in workerGamma workerEpsilon workerBeta workerAlpha; do
  printf '%s ' "$host"
  ssh "$host" 'cd /opt/a2a-docker-runner && node dist/cli.js doctor | jq -r .runnerRevision.detail.summary'
done
```

`githubPatch.status` is `ok` when `commandScript` or valid `commandJson` is configured and `fail` when no patch command is configured or a legacy `commandTemplate` eval path is present. When `A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw` generates the command script, `doctor` first runs a bounded container probe against the configured image and read-only profile mount; the status is `ok` only when the container can resolve `openclaw`, print a version, see `/run/secrets/openclaw-dir`, and confirm that any explicit `agents.defaults.compaction.model` provider exists in the mounted `models.providers` map. A failed `githubPatch` check means Docker-first generic GitHub patch tasks are not ready and should produce Block evidence instead of Done/no-op success.

`install` (alias: `setup`) is safe to rerun. It creates the task root with private permissions when missing and validates the optional secret file without touching live services.

`smoke` runs a tiny operator-facing container fixture through the configured Docker/Podman boundary. It exercises stdout, stderr, artifact capture, `gh` bootstrap/version evidence, timeout wiring, and engine-side cleanup (`--rm`) without touching live worker services. The default smoke bound is capped at 120s so stock `node:22-bookworm-slim` images have enough room for GitHub CLI apt bootstrap without inheriting the full task timeout:

```bash
A2A_DOCKER_RUNNER_ENGINE=docker A2A_DOCKER_RUNNER_IMAGE=node:22-bookworm-slim node dist/cli.js smoke
A2A_DOCKER_RUNNER_ENGINE=podman A2A_DOCKER_RUNNER_IMAGE=node:22-bookworm-slim node dist/cli.js smoke
```

The command returns JSON. Missing engine, missing image, and permission/daemon failures are reported in `result.error` with actionable remediation text. Secret-like values in stdout/stderr diagnostics are redacted before they are returned.

`cleanup` removes task working directories older than a TTL. Always use `--dry-run` first on real workers:

```bash
A2A_DOCKER_RUNNER_ROOT=/var/lib/openclaw-a2a/tasks node dist/cli.js cleanup --ttl 2d --dry-run
A2A_DOCKER_RUNNER_ROOT=/var/lib/openclaw-a2a/tasks node dist/cli.js cleanup --ttl 2d
```

## Chaos E2E release gate

Run the CI-safe gate before release prep:

```bash
npm run chaos:e2e
```

It prints and writes machine-readable JSON evidence for broker restart, worker kill, stale requeue, duplicate-delivery tolerance, and network interruption/reconnect scenarios. For staging/live-like validation, run `scripts/chaos-e2e-gate.mjs --real` with the command hooks documented in `docs/release-rollout-checklist.md`.

## Release candidate approval gate

The `.github/workflows/release-gate.yml` workflow defaults to `dry_run=true`.
Dry-run mode runs validation and records release-candidate evidence without
creating a tag. Setting `dry_run=false` moves tag creation into a separate
`tag` job attached to the GitHub `release` environment, which must be configured
with required reviewers before the path is considered approved.

This workflow does not push tags, create GitHub Releases, publish npm packages
or images, deploy services, send provider messages, ACK terminal records, mutate
databases, change credentials, or rewrite history. Each of those actions remains
a separate explicit operator-approved operation.

## Environment

See `.env.example`.

Important defaults:

- task root: `/var/lib/openclaw-a2a/tasks`
- image: `node:22-bookworm-slim`
- engine: auto-detect `docker` then `podman`

GitHub patch containers need a `gh` version with `gh pr update-branch` support.
The runner checks that capability at container startup. If `gh` is missing or too
old, it installs/updates GitHub CLI from the official `cli.github.com` apt
repository instead of relying on the older Debian package. For faster cold starts,
operators may still set `A2A_DOCKER_RUNNER_IMAGE` to a prebuilt image that already
contains current `git`, `gh`, `curl`, `gnupg`, and `ca-certificates`.

Build metadata injection:

- `A2A_DOCKER_RUNNER_BUILD_VERSION`
- `A2A_DOCKER_RUNNER_BUILD_SOURCE`
- `A2A_DOCKER_RUNNER_BUILD_REVISION`
- `A2A_DOCKER_RUNNER_BUILD_BUILT_AT`
- `A2A_DOCKER_RUNNER_BUILD_IMAGE` (falls back to `A2A_DOCKER_RUNNER_IMAGE`)

These values are injected into task containers as `A2A_RUNNER_BUILD_*`, recorded in
`run.json` / `artifacts/summary.txt`, and propagated through `resultSummary.runnerBuild`,
GitHub Done/Block comments, and terminal evidence. Keep them public and compact: the
loader bounds values, collapses newlines, and drops obvious tokens or host-specific
absolute paths instead of forwarding them.

### Patch command config

For `github-propose-patch` / `propose_patch` mode tasks **without** explicit
`commands`, the runner generates a default PR-producing pipeline. The pipeline:

1. Writes `prompt` to `/work/artifacts/prompt.md`.
2. Creates a branch, invokes the coding agent, commits changes, pushes, and
   opens a PR via `gh pr create`.

Step 2 can be configured from host environment. Prefer the safe host-side
Hermes/OpenClaw/Codex paths for new rollouts. The legacy template eval path is blocked
for GitHub patch execution, and Claude-in-Docker references are rejected even if
an old opt-in variable is present. This keeps plugin preset patch tasks from
falling back to a blocked Claude-in-Docker command and falsely succeeding.

Precedence is `commandScript > commandJson > commandProfile > commandTemplate`:

| Host env | Runner config | Container path/variable | Notes |
|---|---|---|---|
| `A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT` | `commandScript` | `/work/patch-command.sh` | Recommended. Script content is written to a file and executed without `eval`. |
| `A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON` | `commandJson` | `/work/patch-command.sh` | JSON `{ "argv": [...], "env": {...} }` is converted into a quoted argv script. |
| `A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=hermes` | generated `commandScript` | `/work/patch-command.sh` | Operator-only trusted-worker profile. Mounts `A2A_DOCKER_RUNNER_HERMES_CONFIG_DIR` (or `/root/.hermes`) read-only at `/run/secrets/hermes-dir`, then runs `hermes chat --query ... --quiet --yolo` in the checked-out repo. Explicit `A2A_HERMES_MODEL` / legacy `A2A_OPENCLAW_MODEL` overrides still win. When `A2A_DOCKER_RUNNER_MODEL_SOURCE=native`, the runner reads the copied Hermes profile `.env` / `config.yaml` for the model and fails closed if no safe model is found. |
| `A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw` | generated `commandScript` | `/work/patch-command.sh` | Legacy operator-only trusted-worker profile. Mounts `A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR` (or the profile default when unset) read-only at `/run/secrets/openclaw-dir`, then runs `openclaw agent` in the checked-out repo. Explicit `A2A_OPENCLAW_MODEL` overrides still win. Default legacy behavior remains `openai-codex/gpt-5.5` so OAuth-backed Codex auth is used instead of same-name OpenAI API-key models. When `A2A_DOCKER_RUNNER_MODEL_SOURCE=native`, the runner reads the copied OpenClaw profile agent/default model and fails closed if no safe model is found. Do not present this profile or host-network mode as a public sandbox default. |
| `A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=claude-code` (`cccb`) | generated `commandScript` | `/work/patch-command.sh` | Operator-only trusted-worker profile. Mounts `A2A_DOCKER_RUNNER_CLAUDE_CONFIG_DIR` (or `/root/.claude`) read-only at `/run/secrets/claude-dir`, then runs the bundled `claude-a2a-patch-bridge.mjs` through the `claude` CLI. The normal non-fanout implementation mode is agentic; deterministic single-shot and fanout modes are explicit alternatives. Use the `a2a-docker-runner-cccb:<runner-sha>` image; credentials are mounted at runtime only and are not baked into image layers. |
| `A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=codex` | generated `commandScript` | `/work/patch-command.sh` | Operator-only trusted-worker profile. The host source at `A2A_DOCKER_RUNNER_CODEX_CONFIG_DIR` (default `/var/lib/a2a-runner/codex-dir`) is copied to a task-scoped host temp directory, and only that clone is mounted read-write at `/run/secrets/codex-dir`. After `codex exec --ephemeral --json`, the host runner validates that only refreshable token fields/`last_refresh` changed and atomically writes back `auth.json` with the original owner and mode. `config.toml` and generated custom-agent files are discarded. The parent uses `gpt-5.6-sol`, reasoning `high`, approval `never`, and `danger-full-access` inside the external container boundary. Optional contained fanout keeps the parent unchanged, routes explorer/researcher to `gpt-5.6-luna`/`max`, and keeps implementer/verifier on Sol. Use `a2a-docker-runner-codex:<runner-sha>`; credentials are never baked into image layers or runner artifacts. |
| `A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE` | `commandTemplate` | `/work/patch-command.sh` | Legacy eval path; rejected for GitHub patch execution. |

#### Claude turn-budget resolution and recovery

The Claude bridge is the canonical owner of max-turn defaults. The Docker
runner exports a turn-budget variable only when the operator supplied a valid
positive integer; it never writes a second default into the generated command.
`doctor.githubPatch.detail.turnBudgets` projects the active mode, all expected
effective values, whether each value is a canonical default or explicit
override, and fanout cap application before a task is claimed. It contains
variable names and numeric values only, never raw environment contents or
node-private paths.

Mode selection is: fanout when
`A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED=1`; otherwise an explicit
`A2A_DOCKER_RUNNER_CLAUDE_CODE_PATCH_MODE` or
`A2A_CLAUDE_CODE_PATCH_MODE` of `single-shot` selects the deterministic
diff/apply helper; absent an explicit alternative, the normal implementation
lane is agentic. The budget resolution order is mode-specific:

| Mode | Resolution order | Canonical default |
|---|---|---:|
| Analysis | `A2A_CLAUDE_CODE_ANALYSIS_MAX_TURNS`, legacy shared `A2A_CLAUDE_CODE_MAX_TURNS`, default | 10 |
| Agentic patch | `A2A_CLAUDE_CODE_MAX_TURNS`, default | 40 |
| Deterministic single-shot diff/apply | `A2A_CLAUDE_CODE_DETERMINISTIC_MAX_TURNS`, backward-compatible `A2A_CLAUDE_CODE_PATCH_MAX_TURNS`, default | 6 per Claude invocation |
| Fanout patch | `A2A_CLAUDE_CODE_FANOUT_MAX_TURNS`, default, hard cap | 40, capped at 200 |

Each completed Claude invocation writes secret-free
`artifacts/claude-turn-budget.json` telemetry with the mode, effective value,
source, and outcome. `turnsUsed` is present only when the Claude CLI result
envelope supplies a trustworthy non-negative integer; the bridge never derives
it from prose.

A max-turn stop remains a failed `budget_limited` task with
`terminalReason=max_turns`; it is never recovered as success from a partial PR
URL. When safe tracked changes exist, the bridge may retain the fixed
`artifacts/claude-max-turn-checkpoint.{json,diff,status}` set. The checkpoint
contains exact base/head metadata and tracked Git diff/status only. It excludes
untracked files, binary diffs, `.env` files, bootstrap/runtime context files,
unsafe paths, secret-shaped content, and oversized payloads. Its default total
bound is 512 KiB with a 1 MiB hard ceiling. Checkpoint creation performs no
stage, commit, push, PR, or evidence-gate action.

A retry must consume a checkpoint deliberately: locate the retained task run,
verify the manifest ID and exact base/head commits, inspect the changed-path
allowlist and passed secret scan, then run `git apply --check` against a fresh
checkout of that exact base before applying the diff. Do not feed checkpoints
automatically into a new task or treat their presence as PR/Done/Block evidence.

For the OpenClaw profile, prefer a runner image that already contains the
`openclaw` CLI, or an explicitly approved trusted read-only CLI/package mount.
The generated profile fails fast when the CLI is missing instead of relying on
per-task package-manager mutation. Missing CLI evidence records
`error=openclaw_cli_missing`, `openclaw_install_fallback=disabled`, and
`failure_category=openclaw_cli_unavailable`; operators should fix the runner
image or mount. `doctor.githubPatch` now reports this before task fan-out by
probing the configured container image/mount. A temporary compatibility escape hatch exists via
`A2A_OPENCLAW_ALLOW_NPM_INSTALL_FALLBACK=1`, which restores the old
`npm install -g openclaw` attempt and records `error=openclaw_install_failed`
if that explicit fallback fails; this escape hatch reports `githubPatch.status: "warn"`
until the CLI is provisioned in the image or mount.

For the Hermes profile, use a runner image that contains Hermes Agent and `gh`.
This repository provides a Dockerfile for the operator-built image:

```bash
docker build -f docker/hermes-runner.Dockerfile \
  -t a2a-docker-runner-hermes:<runner-sha> .
```

Then point worker env at the Hermes profile:

```bash
export A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=hermes
export A2A_DOCKER_RUNNER_EXPECTED_PATCH_COMMAND_PROFILE=hermes
export A2A_DOCKER_RUNNER_HERMES_CONFIG_DIR=/root/.hermes
export A2A_DOCKER_RUNNER_IMAGE=a2a-docker-runner-hermes:<runner-sha>
# Optional: follow the mounted native Hermes profile model instead of pinning here.
# export A2A_DOCKER_RUNNER_MODEL_SOURCE=native
export A2A_HERMES_MODEL=openai-codex/gpt-5.5
export A2A_HERMES_TIMEOUT_SEC=3600
# Optional: enable bounded same-container helper fanout for broad A2A tasks.
export A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED=1
export A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX=2
```

For the Claude Code cccb profile, use a runner image that contains the Claude
Code CLI, `gh`, `gitleaks`, and the A2A patch bridge:

```bash
docker build -f docker/claude-code-runner.Dockerfile \
  --build-arg A2A_NEXUS_REF=<runner-sha-or-tag> \
  -t a2a-docker-runner-cccb:<runner-sha> .
```

Then point worker env at a minimal Claude config directory. Do not bake Claude
OAuth/config files into the image:

```bash
export A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=cccb
export A2A_DOCKER_RUNNER_EXPECTED_PATCH_COMMAND_PROFILE=claude-code
export A2A_DOCKER_RUNNER_CLAUDE_CONFIG_DIR=/secure/operator/claude-config
export A2A_DOCKER_RUNNER_IMAGE=a2a-docker-runner-cccb:<runner-sha>
export A2A_CLAUDE_MODEL=sonnet
export A2A_CLAUDE_TIMEOUT_SEC=3600
```

For the Codex profile, build the pinned Codex CLI image and mount a minimal
node-local auth directory. Do not mount the whole host session/history tree:

```bash
docker build -f docker/codex-runner.Dockerfile \
  -t a2a-docker-runner-codex:<runner-sha> .

install -d -m 0700 /var/lib/a2a-runner/codex-dir
install -m 0600 /root/.codex/auth.json /var/lib/a2a-runner/codex-dir/auth.json
install -m 0600 /root/.codex/config.toml /var/lib/a2a-runner/codex-dir/config.toml

export A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=codex
export A2A_DOCKER_RUNNER_EXPECTED_PATCH_COMMAND_PROFILE=codex
export A2A_DOCKER_RUNNER_CODEX_CONFIG_DIR=/var/lib/a2a-runner/codex-dir
export A2A_DOCKER_RUNNER_IMAGE=a2a-docker-runner-codex:<runner-sha>
export A2A_DOCKER_RUNNER_USER=root
export A2A_DOCKER_RUNNER_CAP_DROP=ALL
export A2A_CODEX_MODEL=gpt-5.6-sol
export A2A_CODEX_REASONING_EFFORT=high
export A2A_CODEX_TIMEOUT_SEC=3600
# Optional bounded Codex custom-agent fanout; remains off when unset.
export A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED=1
export A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX=2
export A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES=explorer,verifier
```

The persistent directory is never mounted directly into the task container.
The runner creates a private per-task clone, mounts that clone read-write for
Codex token rotation, validates the resulting credential schema, and
atomically replaces only the persistent `auth.json`. A changed account,
API-key/auth mode, token schema, or `config.toml` is rejected or discarded.
This preserves rotating refresh tokens without granting the coding agent a
write path to the host credential directory.

For fixed-role workers, set `A2A_DOCKER_RUNNER_EXPECTED_PATCH_COMMAND_PROFILE`
with the node's intended harness. For example, Hermes nodes should set it to
`hermes`; if the service env later drifts back to `openclaw` or unset, runner
config validation fails before task execution. Known runner image families are
also checked against the selected profile, so `a2a-docker-runner-hermes:*` cannot
be paired with the `openclaw` profile and `a2a-docker-runner-openclaw:*` cannot
be paired with the `hermes` profile; `a2a-docker-runner-cccb:*` and
`a2a-docker-runner-claude-code:*` must use the `claude-code` profile, and
`a2a-docker-runner-codex:*` must use the `codex` profile.

Examples:

```bash
export A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT='#!/usr/bin/env bash
codex exec --full-auto "$(cat /work/artifacts/prompt.md)"'

export A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON='{"argv":["codex","exec","--full-auto","example prompt"],"env":{"SAFE":"value"}}'

# Trusted-worker/operator example when standardising A2A Docker patch execution on OpenClaw.
# Use a minimal read-only auth directory, not a full workstation OpenClaw home.
export A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw
export A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR=/secure/operator/openclaw-config
# Optional: follow the mounted native OpenClaw agent/default model instead of pinning here.
# export A2A_DOCKER_RUNNER_MODEL_SOURCE=native
export A2A_OPENCLAW_MODEL=openai-codex/gpt-5.5
export A2A_OPENCLAW_THINKING=medium
export A2A_OPENCLAW_TIMEOUT_SEC=3600
# Optional: enable bounded same-container helper fanout for broad A2A tasks.
export A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED=1
export A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX=2

# Legacy ad-hoc Claude-in-Docker commands are rejected for GitHub patch tasks.
# Use the first-class claude-code/cccb profile when Claude Code is intended.
```

When no patch command config is set, `doctor` reports `githubPatch.status: "fail"`. The generated patch pipeline now emits `error=no_patch_command_configured` and exits non-zero before any no-op PR flow can be reported as success. GitHub evidence collection treats the diagnostic as Block evidence rather than Done evidence.

After creating a PR, the default pipeline calls
`a2a-gh-pr-update-branch "$PR_URL" "$baseBranch"`. That helper first uses
`gh pr update-branch`; if GitHub CLI/API update fails, it falls back to
`git fetch origin <base>`, `git merge --no-edit origin/<base>`, and
`git push origin <head>`. Output is captured in
`/work/artifacts/pr-update-branch-output.txt`, and failures are recorded as a
warning instead of deleting or duplicating the newly created PR.

If a patch command or extra mount references Claude CLI, Claude credentials, or
Claude-specific artifacts outside the first-class `claude-code`/`cccb` profile,
config loading fails. This prevents accidental production fallback to
Claude-in-Docker while allowing the explicit trusted-worker cccb path.

A safe Docker-first worker rollout from plugin-only routing to all-GitHub routing should therefore be:

```bash
# 1. Configure one of the safe command paths on the trusted worker host.
# OpenClaw profile use is operator-only; mount a minimal read-only auth directory.
export A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw
export A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR=/secure/operator/openclaw-config
# Optional: follow the mounted native OpenClaw agent/default model instead of pinning here.
# export A2A_DOCKER_RUNNER_MODEL_SOURCE=native
export A2A_OPENCLAW_MODEL=openai-codex/gpt-5.5
export A2A_OPENCLAW_THINKING=medium
export A2A_OPENCLAW_TIMEOUT_SEC=3600

# 2. Verify readiness before enabling all GitHub tasks.
node dist/cli.js doctor | jq .githubPatch

# 3. Only after githubPatch.status is "ok", route all GitHub patch tasks via Docker.
export A2A_DOCKER_RUNNER_ALL_GITHUB=1
```

**Variables/files available inside the container:**

| Variable/File | Source |
|---|---|
| `/work/patch-command.sh` | `A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT` or generated from `A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON` |
| `A2A_PATCH_COMMAND_JSON` | `A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON` host env |
| `A2A_PATCH_COMMAND` | `A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE` host env |
| `/usr/local/bin/a2a-gh-pr-update-branch` | Helper that wraps `gh pr update-branch` with a git merge/push fallback |
| `/work/artifacts/prompt.md` | Task `prompt` field |
| `/work/artifacts/task.json` | Public-safe normalised task payload with secret-like fields and token patterns redacted |
| `/work/artifacts/manifest.json` | Versioned A2A Artifact/Part manifest; see [`docs/artifact-manifest.md`](docs/artifact-manifest.md) |

**Explicit commands override**: when `commands` are provided in the task
payload they are used as-is; the default pipeline is not injected.

## Release checklist

Operator release and worker rollout notes live in [`docs/release-rollout-checklist.md`](docs/release-rollout-checklist.md). Keep feature tasks PR-only: do not tag, publish, restart services, or deploy workers from issue branches.

The checklist covers:

- GitHub Actions Node runtime deprecation guardrails
- package `bin` verification for `a2a-docker-runner`
- active rollout targets: `workerGamma`, `workerEpsilon`, `workerBeta`, `workerAlpha`
- explicit exclusion of legacy `workerDelta` / VPS2 workers
- one-target-at-a-time rollout and rollback steps

## Security model

Do not mount a full host OpenClaw home into task containers. Mount only the minimum required secrets, preferably read-only, and prefer per-task or least-privilege GitHub credentials. Public examples must use placeholders instead of real local auth-file paths and must never place token values in payloads.

## Integration target

Initial integration point:

```text
/opt/openclaw-a2a-worker/handlers/openclaw-a2a-task-handler.mjs
```

For `propose_patch` / `github-propose-patch` mode, the handler should call:

```bash
a2a-docker-runner run /path/to/task.json
```

and convert the runner result into the normal A2A worker completion payload.

## Related docs

- [LICENSE](LICENSE) — MIT
- [SECURITY.md](SECURITY.md) — vulnerability reporting and security model
- [CONTRIBUTING.md](CONTRIBUTING.md) — development, gates, branching, PR process
- [docs/design.md](docs/design.md) — component architecture and task lifecycle
- [docs/integration.md](docs/integration.md) — handler integration and rollout
- [docs/release-rollout-checklist.md](docs/release-rollout-checklist.md) — operator release and worker rollout
- [docs/artifact-manifest.md](docs/artifact-manifest.md) — artifact manifest contract and evidence parts

## Compatibility matrix

| Component | Min version / expected | Notes |
|---|---|---|
| Node.js | >= 22 | Required runtime; CI uses Node 22 |
| Docker Engine | 20.10+ | Primary container runtime (`--rm`, `--memory`, `--cpus`) |
| Podman | 4.0+ | Alternative container runtime; `--replace` for cleanup |
| GitHub CLI (`gh`) | 2.40+ | Required for `gh pr update-branch`; auto-installed from cli.github.com |
| TypeScript | 5.8+ | Build toolchain (dev dependency) |
| Ubuntu / Debian | 22.04+ (bookworm) | Base container image (`node:22-bookworm-slim`) |
| GitHub Actions | `ubuntu-latest` | CI runner |

## Known limitations

- **Single-repo PRIMARY PATCH**: The `github-propose-patch` mode operates on one
  primary repository per task. Multi-repo PR orchestration must be split into
  separate tasks or implemented explicitly via `repos` and `commands`.
- **No built-in coding agent**: The runner does not embed a coding agent. Patch
  command configuration (`commandScript`, `commandJson`, or `commandProfile`)
  must be provided by the operator.
- **Operator-only trusted-worker features**: The `openclaw` command profile,
  host-network Docker/Podman mode, and host OpenClaw config mounts are
  operator-only features and should not be presented as public/sandbox defaults.
- **Cleanup is TTL-based**: Container and work-directory cleanup is driven by a
  configurable TTL via `a2a-docker-runner cleanup`. There is no automatic per-task
  cleanup at task completion time; the operator should schedule cleanup or run it
  after task bursts.
- **No persistent worker state**: The runner is stateless between tasks. Task
  history and retry state live in the broker, not in the runner.
- **Budget-limited is not Done**: Tasks that hit CPU/RAM/time budgets are reported
  as `budget_limited` or `failed`, not `done`. Continuation requires explicit
  operator approval.
- **No live Telegram/notifier send**: The runner produces compact terminal evidence
  for the broker; actual notification delivery is owned by the broker/plugin-notifier,
  not by this runner.
