# Contained-subagent conductor contract

Each node instance — the broker worker process and the agent harness inside a
Docker task container — acts as the **orchestra conductor** for its own task:

- **Simple work is executed directly.** Trivial/small tasks, sensitive or
  urgent tasks, and high-coupling tasks get a budget of 0 and the node does
  the work itself.
- **Heavy work may fan out to at most 4 subagents** (hard cap), chosen by the
  worker-subagent orchestration policy: an explorer, up to two scoped
  implementers with **disjoint write sets**, and a verifier. Subagents are
  evidence-only helpers; exactly **one finalizer** (the conductor) owns the
  final result.

## How the budget reaches the node

### Broker worker (external handlers)

`createExternalWorkerHandler` injects a per-task directive into the handler
process env (opt out with `WORKER_SUBAGENT_DIRECTIVE_DISABLED=1`):

| Env | Meaning |
| --- | --- |
| `A2A_SUBAGENT_CONDUCTOR=1` | This process is the conductor for the task. |
| `A2A_SUBAGENT_MAX` | Budget for this task (0–4) from the orchestration policy. |
| `A2A_SUBAGENT_ROLES` | Comma list of recommended roles. |
| `A2A_SUBAGENT_PLAN` | JSON plan: `parallelismHint`, `recommendedSubagents`, `oneFinalizerRequired`, `writeSetIsolationRequired`. |

The budget derives from the task profile: an explicit
`task.payload.subagentProfile` (`size`, `coupling`, `hasIndependentSubtasks`,
`writeSets`, …) wins; otherwise patch-shaped intents default to medium
independent work and everything else to small direct work. Host pressure
(`WORKER_SUBAGENT_CAP`, resource gates) only ever lowers the budget.

### Docker task containers

When `A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED=1`, `buildRunArgs`
advertises the budget to the in-container harness:

| Env | Source |
| --- | --- |
| `A2A_CONTAINED_SUBAGENTS_ENABLED=1` | opt-in flag |
| `A2A_CONTAINED_SUBAGENTS_MAX` | `A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX` (1–4) |
| `A2A_CONTAINED_SUBAGENTS_ROLES` | configured helper roles |
| `A2A_CONTAINED_SUBAGENTS_OUTPUT_BYTES` | per-helper evidence budget |
| `A2A_CONTAINED_SUBAGENTS_REASONS` | dispatch reasons that justify fanout |

Fanout stays **opt-in**: with the flag off (default) no
`A2A_CONTAINED_SUBAGENTS_*` env is injected and the harness must not spawn
helpers.

The `codex` profile consumes this opt-in by generating only the custom-agent
profiles allowed by `A2A_CONTAINED_SUBAGENTS_ROLES` in its task-scoped,
disposable `CODEX_HOME`. Its tier mapping is intentionally asymmetric:

| Codex realization | Model | Reasoning | Boundary |
| --- | --- | --- | --- |
| `a2a_explorer`, `a2a_researcher` | `gpt-5.6-luna` | `max` | declared read-only, evidence-only |
| `a2a_implementer` | `gpt-5.6-sol` | `high` | one assigned disjoint write set |
| `a2a_verifier` | `gpt-5.6-sol` | `xhigh` | clean-slate, declared read-only verification |

The parent Codex process still uses `A2A_CODEX_MODEL` and
`A2A_CODEX_REASONING_EFFORT` and remains the single finalizer. With the opt-in
off, the runner installs no custom profiles and passes no `agents.*` override
(codex 0.144.1 rejects scalar `agents.*` keys); no custom profiles
are generated.

The concurrent-open thread ceiling is expressed through the installed role
profiles rather than a scalar `agents.max_concurrent_threads_per_session`
override, which codex 0.144.1 also rejects as an `AgentRoleToml` type error; the
task prompt and broker gate still own the total spawn budget. Per-agent `sandbox_mode` is defense in depth, not a separate container:
the parent `codex exec` permission override can be inherited by children. The
Docker boundary, lifecycle-command guard, role instructions, disjoint write-set
rule, and single finalizer therefore remain the operative safety controls.

> **The `claude-code` runner image is single-shot by design.** It runs the
> deterministic patch/analysis bridge (`claude-a2a-patch-bridge.mjs`,
> `A2A_CLAUDE_CODE_PATCH_MODE=single-shot`) with **no `Task`/Agent tool** and
> does **not** consume `A2A_CONTAINED_SUBAGENTS_*` — so it never spawns helpers,
> even with the flag on. Contained fanout here applies to the OpenClaw, Hermes,
> and explicitly opted-in Codex in-container harnesses. Sub-agent fanout for Claude Code is realized in the
> host / native CC-harness lane — see the *Execution lanes (applicability)*
> section of `packages/broker/docs/worker-subagent-orchestration-policy.md`.

## Invariants

1. Hard cap 4 — config validation rejects higher values everywhere.
2. One finalizer; subagents are evidence-only and never own terminal results.
3. Write-set isolation between implementer lanes.
4. The directive only ever shrinks under host pressure; it never forces a
   spawn (`mandatoryProductionSpawn: false` in the policy packet).
