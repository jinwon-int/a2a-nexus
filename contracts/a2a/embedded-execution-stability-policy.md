# Embedded Execution Stability Policy (v0)

> **v0 Freeze:** Embedded execution stability gates, container isolation invariants, config domain
> sanitization requirements, workspace hygiene deny patterns, session store guard preconditions,
> and post-completion fail-closed checks are frozen as the Contract v0 embedded execution stability
> baseline. Changes to gate criteria or safety assertions require a v0→v1 plan.

This contract defines the stability policy for A2A Docker Runner **embedded execution** — the mode in
which the runner starts an OpenClaw (or Codex) agent as a sub-process inside the container to perform
a repository patch task, rather than executing a static shell script or command template.

The contract encodes acceptance criteria for container isolation, config domain scoping, workspace
hygiene, session store preconditions, and post-completion fail-closed checks. It is a policy-only
document: it defines what safe evidence looks like at the contract level without prescribing
implementation details or implying production mutation.

Parent issue: [a2a-broker#838](https://github.com/jinwon-int/a2a-broker/issues/838)
Origin worker: Team1/nosuk
Target package: [`packages/docker-runner/`](../../packages/docker-runner/)
Sources: [`src/config.ts`](../../packages/docker-runner/src/config.ts) (`buildOpenClawPatchCommandScript`)

---

## 1. Container isolation gate (E1)

Embedded execution runs inside a short-lived container (Docker or Podman). The container provides
process, filesystem, and network isolation boundaries.

### E1.1 Process isolation

| Invariant | Required evidence | Fail-closed condition |
| --------- | ---------------- | --------------------- |
| Single-process agent | The embedded OpenClaw/Codex agent process runs as PID 1 inside the container namespace | Agent runs as a child of a process outside the container |
| Container engine only | Execution uses `docker run --rm` or `podman run --rm`; no host-side agent launch | Agent is launched via a direct host exec path |
| Config copy is file-scoped | Only authentication/config files are copied into the container, not entire workspace trees | Broad `cp -a` of the full `~/.openclaw` tree without per-file scoping |

### E1.2 Filesystem isolation

| Invariant | Required evidence | Fail-closed condition |
| --------- | ---------------- | --------------------- |
| Explicit mount paths | All host paths mounted into the container are declared via explicit `extraMounts` or runner-internal mount construction | Implicit host path access via bind propagation or unix socket sharing |
| OpenClaw config is read-only | The mounted host OpenClaw config directory (`A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR`) is mounted `:ro` | Config directory is writable inside the container |
| Workdir is the checkout | The container workdir (`/work`) is the checked-out repository, not the host workspace | Workdir points to the host `~/.openclaw/workspace` or a non-repo path |

### E1.3 Network isolation

| Invariant | Required evidence | Fail-closed condition |
| --------- | ---------------- | --------------------- |
| No-live by default | Network mode defaults to `bridge`; `host` mode requires explicit `PATCH_COMMAND_PROFILE=openclaw` | Default configuration permits host-network access without documented profile override |
| No live provider send | Embedded agent is configured with no live Telegram, Signal, or provider notification channel | Agent config contains live channel wiring or provider targets that could trigger sends |
| Provider API calls are task-scoped | The agent's only external API calls are to the model provider (e.g., OpenAI Codex) for the current task | Agent performs unprompted external API calls not scoped to the current task |

### E1.4 Safety confirmations

- Container isolation is provided by the Docker/Podman engine, not by custom sandboxing.
- Filesystem isolation relies on explicit mount declarations and read-only flag enforcement.
- Network isolation defaults to no-live; host-network mode is an explicitly chosen profile.
- Embedded execution does not change repository visibility, deploy services, or restart Gateways.

---

## 2. Config domain gate (E2)

The OpenClaw host config can contain channel wiring, plugin definitions, cron schedules, and
provider API keys that are not safe to expose inside a short-lived runner container. The config
must be sanitized before the embedded agent starts.

### E2.1 Config sanitization

| Requirement | Pass condition | Fail-closed condition |
| ----------- | -------------- | --------------------- |
| Host gateway/plugin/channel/cron stripped | `plugins`, `channels`, `gateway`, `cron`, `bindings`, `hooks` are deleted from the config before the agent starts | Any of these sections remains in the sanitized config |
| Only openai-codex provider kept | Model providers are pruned to `openai-codex` only; all other providers are removed | A non-openai-codex provider remains that could route to a different API |
| Heartbeat defaults removed | `agents.defaults.heartbeat` and per-agent `heartbeat` are deleted | Heartbeat configuration could trigger unprompted periodic work |
| Agent runtime fallback removed | `agents.defaults.agentRuntime.fallback` and per-agent `agentRuntime.fallback` are deleted | Fallback model could trigger unprompted API calls |
| Model fallbacks cleared | `model.fallbacks` is set to an empty array | Fallback model list could trigger unprompted retries |

### E2.2 Credential scoping

| Requirement | Pass condition | Fail-closed condition |
| ----------- | -------------- | --------------------- |
| Only auth files copied | Only `openclaw.json`, `node.json`, `credentials/*`, `auth-profiles.json`, `auth-state.json`, `models.json` are copied from the host config | Worker workspace, caches, plugin runtimes, archives, or session logs are copied |
| GH token is ephemeral task token | Only the ephemeral `GH_TOKEN` or `GITHUB_TOKEN` set by the task payload is injected into the agent config; no permanent host token is used | A permanent host token from the host config is used instead of the task-scoped token |
| Token lives only in container memory | The injected token exists only in the disposable container's config file and is never written to artifacts | Token appears in summary.txt, patch-command.log, or any artifact file |

### E2.3 Safety confirmations

- Config sanitization is applied before any agent execution; a sanitization failure prevents the agent from starting.
- Credential scoping is file-level: no broad directory copies that could capture workspace archives or session stores.
- The injected GH token is ephemeral and scoped to the task; it is never committed to the repository.
- Config sanitization is implemented as an inline Node.js script, not a separate tool with external dependencies.

---

## 3. Workspace hygiene gate (E3)

The embedded agent workspace must be the checked-out repository, not the host OpenClaw workspace.
Bootstrap and persona files from the host workspace must never enter the repository checkout or
artifact evidence.

### E3.1 Workspace alignment

| Requirement | Pass condition | Fail-closed condition |
| ----------- | -------------- | --------------------- |
| `OPENCLAW_WORKSPACE_DIR` equals checkout | `OPENCLAW_WORKSPACE_DIR` is set to `$PWD` (the repository checkout root) | `OPENCLAW_WORKSPACE_DIR` points to the host agent workspace or is unset |
| In-container config workspace matches | The disposable in-container `openclaw.json` has `agents.defaults.workspace` and the active agent's `workspace` set to the checkout path | Config workspace entry is missing, stale, or points to a non-checkout path |
| Host workspace is never deleted | The runner never deletes or recreates `/root/.openclaw/workspace` as a sandbox alignment mechanism | Runner deletes or recreates the host workspace path |

### E3.2 Bootstrap file deny list

The following paths must never appear as tracked, staged, or committed files in the repository
checkout after embedded execution. These are runtime bootstrap/persona files, not repository
content.

| Deny path | Rationale |
| --------- | --------- |
| `AGENTS.md` | Agent workspace persona definition |
| `SOUL.md` | Agent personality and behavior configuration |
| `USER.md` | Operator identity and preference context |
| `TOOLS.md` | Agent tool configuration and local notes |
| `HEARTBEAT.md` | Agent heartbeat task configuration |
| `IDENTITY.md` | Agent identity metadata |
| `.openclaw/**` | OpenClaw runtime config, sessions, credentials |

### E3.3 Pre-execution hygiene

| Requirement | Pass condition | Fail-closed condition |
| ----------- | -------------- | --------------------- |
| Workspace config points to checkout | Before the agent starts, the in-container config is verified to point `workspace` at the checkout | Config workspace entry does not point to the checkout path |
| Host workspace path is not swept | Before agent start, the summary records `openclaw_workspace=$PWD` | Workspace path in summary is a host path or the default agent workspace |

### E3.4 Post-execution hygiene

| Requirement | Pass condition | Fail-closed condition |
| ----------- | -------------- | --------------------- |
| Bootstrap leak detection | After agent completion, `git status --porcelain` is checked for any deny path files; if found, the runner exits 4 with error detail | Deny path files are present and the runner does not detect them |
| Leak summary recording | If bootstrap leaks are detected, each leak path is recorded in summary.txt with `bootstrap_leak=` prefix | Leaks are detected but not recorded in summary evidence |

### E3.5 Safety confirmations

- The denied bootstrap paths are untracked in the repository `.gitignore` and must never enter any branch.
- Pre-execution hygiene records the workspace path before agent startup for audit traceability.
- Post-execution hygiene is the last check before the runner considers the task complete.
- Workspace alignment is explicit: the host workspace is never deleted, recreated, or overwritten.

---

## 4. Session store guard gate (E4)

The host OpenClaw session store mounted into the container must be read-only. The guard detects
damaged or dangerously backed-up session state before allowing embedded execution.

### E4.1 Read-only mount enforcement

| Invariant | Required evidence | Fail-closed condition |
| --------- | ---------------- | --------------------- |
| Session store is mounted read-only | The `extraMount` for the OpenClaw config directory has `readOnly: true` (explicit or by default) | Session store mount is writable |
| No container-side session mutation | The container never writes to the mounted config directory | Container writes to any path under the mounted config directory |
| Session state guard runs first | The session store guard is evaluated before the agent starts | Agent starts without session store guard evaluation |

### E4.2 Empty session detection

| Invariant | Required evidence | Fail-closed condition |
| --------- | ---------------- | --------------------- |
| Active-agent sessions registry is non-empty | The sessions registry for the active agent (`sessions.json`) must have entries | Active-agent sessions registry is empty (`{}`) — execution is blocked |
| Non-active-agent empty registries are warnings | Empty session registries for non-active agents produce a warning, not a block | Empty non-active-agent session registries silently ignored or block execution |
| Warning is recorded in summary | Empty non-active-agent registries are recorded in `summary.txt` with `warning=` prefix | Warnings are suppressed and not recorded |

### E4.3 Backup buildup detection

| Invariant | Required evidence | Fail-closed condition |
| --------- | ---------------- | --------------------- |
| Session backup count is bounded | Total `.jsonl.bak-*` files in the session store must be below a documented threshold (default: 50) | Backup count at or above the threshold produces a warning |
| Session backup bytes are bounded | Total backup file bytes must be below a documented threshold (default: 128 MB) | Backup bytes at or above the threshold produces a warning |
| Backup warnings are recorded | Buildup warnings include `count=`, `bytes=` and are recorded in `summary.txt` with `warning=` prefix | Buildup warnings are suppressed |

### E4.4 Safety confirmations

- The session store guard is purely diagnostic: it reads state, never writes or mutates it.
- Empty active-agent sessions stop execution completely — the runner does not attempt to reseed or recover.
- Backup buildup warnings are informational only; they do not block execution.
- The session store guard is evaluated before any agent config copy or agent startup.

---

## 5. Post-completion fail-closed gate (E5)

After the embedded agent completes, the runner performs a series of fail-closed checks before
producing evidence.

### E5.1 Bootstrap leak — fail closed

| Failure mode | Exit code | Evidence |
| ------------ | --------- | -------- |
| Bootstrap file detected in checkout | 4 | `error=openclaw_workspace_bootstrap_leak` in summary.txt; each leak path recorded as `bootstrap_leak=` |
| Multiple leak paths | 4 | All leak paths enumerated in summary.txt; the patch-command.log describes the violation |
| Leak in untracked-only state | 4 | Only untracked files matching deny paths cause exit 4; staged/committed leaks fail similarly |

### E5.2 No-change — fail closed

| Failure mode | Exit code | Evidence |
| ------------ | --------- | -------- |
| No repository changes after agent | 2 | `error=openclaw_completed_without_changes` in summary.txt; patch-command.log refuses to produce a false Done |
| Agent produced evidence but no repo diff | 2 | Agent may have produced logs or side effects, but the checkout has no file changes — blocking is correct |

### E5.3 Config mount missing — fail closed

| Failure mode | Exit code | Evidence |
| ------------ | --------- | -------- |
| OpenClaw config dir not mounted | 2 | `error=openclaw_config_mount_missing` in summary.txt; patch-command.log describes the mount requirement |
| Config dir exists but is empty | 2 | Same as missing — `openclaw.json` must be present |

### E5.4 Safety confirmations

- Post-completion fail-closed checks are the last gates before the runner considers a task complete.
- No exit code 0 is returned unless both (a) the agent produced repository changes and (b) no bootstrap files leaked.
- The runner does not automatically retry after fail-closed exit; remediation is operator action.
- Evidence files (summary.txt, patch-command.log) are written *before* the fail-closed exit so the runner can capture them.

---

## 6. Aggregate decisions

The aggregate stability decision for embedded execution in A2A Docker Runner:

| Gate | Component | Aggregate decision |
| ---- | --------- | ----------------- |
| E1 | Container isolation | `PASS / Active` — container engine handles process/filesystem/network isolation; no-live default is enforced |
| E2 | Config domain | `PASS / Active` — host config is sanitized before agent start; only auth files and openai-codex provider are preserved |
| E3 | Workspace hygiene | `PASS / Active` — workspace is aligned to the checkout; deny paths are checked pre- and post-execution |
| E4 | Session store guard | `PASS / Active` — read-only mount enforced; empty sessions and backup buildup are detected |
| E5 | Post-completion fail-closed | `PASS / Active` — bootstrap leaks, no-changes, and missing config all produce non-zero exit codes with evidence |

**Aggregate gate decision: `PASS / Active`.** Embedded execution stability policy is specified and
implemented in the Docker runner source. New embedded execution modes or additional coding agent
profiles must re-evaluate all gates before deployment.

---

## 7. Safety confirmations

This contract confirms all of the following:

- No production deploy or Gateway/broker/worker restart is implied by embedded execution.
- No live provider/Telegram/notification send occurs through embedded execution.
- No terminal-outbox ACK mutation is performed by embedded execution.
- No production database mutation, prune, migration, or WAL operation is implied.
- No secret rotation or secret value disclosure occurs through embedded execution.
- No raw session dump or host-private path appears in evidence.
- No repository visibility change is performed by embedded execution.
- No force-push or history rewrite occurs through embedded execution.
- No automatic merge or release publication is performed by embedded execution.
- `isApproval: false`, `isTerminalAck: false`, `isReadReceipt: false` on all evidence.

## 8. Validation commands

```bash
# Unit tests for embedded execution script generation and guards
npm -w packages/docker-runner run test

# Conformance checks for all contract fixtures including this policy
node test/conformance/check-contract-fixtures.mjs
```

## 9. Related

- [R20 Stability Gate](./r20-stability-gate.md) — hot-table persistence, queue/outbox hygiene,
  no-live canary boundary, stale PR reconciliation
- [Terminal Result Semantics](./terminal-semantics.md) — ACK boundary and receipt levels
- [Task Lifecycle](./task-lifecycle.md) — state transitions and terminal states
- [Docker Runner Config](../../packages/docker-runner/src/config.ts) — implementation of embedded
  execution script (`buildOpenClawPatchCommandScript`)
- [Engine Contract Tests](../../packages/docker-runner/src/engine-contract.test.ts) — metacharacter
  safety, script generation, redaction
- [Artifact Manifest Schema](../../packages/docker-runner/docs/artifact-manifest.schema.json) —
  manifest schema with evidence hints, receipt trace, and continuation
- [Fixtures](../../fixtures/contract/embedded-execution-stability-policy.json) — machine-readable
  fixture
