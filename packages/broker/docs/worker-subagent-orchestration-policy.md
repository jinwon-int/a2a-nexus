# A2A worker subagent orchestration policy

This source-only policy describes when an A2A worker should use subagents for parallel exploration, implementation, or verification.

It does not change production worker runtime behavior, force subagent spawning, mutate broker dispatch semantics, create TaskFlow records, mutate DB state, deploy/restart services, or move secrets.

## Policy

Subagent count is adaptive, not fixed.

| Task and host state | Recommended subagents |
|---|---:|
| trivial, urgent, sensitive, or tightly coupled | 0 |
| small task with useful side review | 1 |
| medium task with separable exploration/verification | 2 |
| large independent task with healthy host capacity | 3 |

Workers must reduce or disable subagent spawning when CPU, memory, IO, event-loop, Gateway, worker cap, or broker/fleet cap conditions are constrained.

## Roles

- explorer: bounded code, issue, and log investigation.
- implementer: scoped code changes in an assigned disjoint write set.
- verifier: tests, CI, risk, and evidence review.

## Finalizer Rule

Exactly one worker or broker finalizer owns merge, closeout, approval, and runtime decisions.

Subagents submit evidence packets only.

## Write-Set Rule

Implementation subagents require disjoint file or module ownership. If write sets overlap, use one implementer and a verifier instead of multiple implementers.

## Escape Hatch

Direct execution with zero subagents is always allowed when the task is too small, too risky, too coupled, urgent, sensitive, or the host lacks capacity.

## Execution lanes (applicability)

This policy is realized differently per worker execution lane. Every lane is policy-conformant: the Escape Hatch (zero subagents is always allowed) and `mandatoryProductionSpawn: false` make direct, single-agent execution valid everywhere. Sub-agent fanout is a **host/native-lane capability**; the containerized `claude-code` lane is **single-shot by design**.

- **Host / native CC-harness lane** — a Claude Code worker running on a node (roster in the worker's CC harness, per `docs/specs/cc-worker-subagent-roster/spec.md`) selects and spawns the `explorer` / `implementer` / `verifier` roster adaptively (0–3, hard cap 4) when it claims a task. This is where sub-agent fanout is actually realized.
- **Containerized `claude-code` runner lane** — the image the broker dispatches to (`packages/docker-runner/docker/claude-code-runner.Dockerfile`) runs a deliberately single-shot bridge (`packages/broker/scripts/claude-a2a-patch-bridge.mjs`, forced via `A2A_CLAUDE_CODE_PATCH_MODE=single-shot`). It executes with a bounded file-tool budget (`Read Grep Glob`, or analysis mode) and **no `Task`/Agent tool**, so it does **not** spawn the roster. The host `~/.claude/agents/` roster may be mounted into the container but stays inert. This is intentional: the single-shot lane keeps execution deterministic, resource-bounded, and structurally single-finalizer.
- **Contained-subagent conductor (OpenClaw / Hermes in-container harness)** — the only in-container lane that consumes the `A2A_CONTAINED_SUBAGENTS_*` budget (see `packages/docker-runner/docs/contained-subagent-conductor.md`); default-off / opt-in. The `claude-code` runner does **not** consume this env even when the flag is set.

Realizing fanout in the container `claude-code` lane would require new wiring (a `Task`/Agent tool in the allowed set, roster exposure to the session, and a spawn-instructing prompt) and is out of scope until separately decided.

## Read-only Planner Route

`POST /workers/subagent-orchestration/plan` accepts a supplied task profile and host capacity snapshot, then returns the same source-only policy packet.

The route is a planner/classifier only. It does not inspect live host state, spawn subagents, dispatch broker work, claim tasks, invoke executors, create TaskFlow records, mutate DB state, deploy/restart services, send providers, ACK/replay terminal rows, publish releases, or move secrets.

## Worker Self-Assessment Packet

`a2a-broker.worker-self-assessment-capacity.packet` standardizes the supplied worker/host capacity snapshot before a planner route call.

The packet can include task profile, CPU load, memory usage, IO pressure, event-loop degradation, Gateway pressure, active subagent count, worker cap, broker active subagent count, and broker cap. When all required fields are present, `plannerInput` is ready to submit to `POST /workers/subagent-orchestration/plan`.

The self-assessment packet does not probe the live host or Gateway, call the planner route, spawn subagents, dispatch broker work, claim tasks, invoke executors, create TaskFlow records, mutate DB state, deploy/restart services, send providers, ACK/replay terminal rows, publish releases, or move secrets.

## Planner Handoff Packet

`a2a-broker.worker-subagent-planner-handoff.packet` bundles a worker self-assessment packet and a planner policy packet for finalizer review.

The handoff validates worker/task alignment, planner input alignment, source-only boundaries, finalizer requirement, evidence-only helper semantics, write-set isolation, and the direct-execution escape hatch. It is the review artifact before any future runtime gate.

The handoff does not probe live host or Gateway state, call the planner route, spawn subagents, dispatch broker work, claim tasks, invoke executors, create TaskFlow records, mutate DB state, deploy/restart services, send providers, ACK/replay terminal rows, publish releases, or move secrets.

## Spawn Authorization Request Draft

`a2a-broker.worker-subagent-spawn-authorization-request.packet` consumes a planner handoff packet and renders a finalizer-reviewable authorization request draft.

The draft lists requested roles, default role purposes, write-set isolation constraints, capacity constraints, required evidence, and the single-finalizer rule. It is not an authorization grant and is not a runtime spawn gate.

The request draft does not spawn subagents, dispatch broker work, claim tasks, invoke executors, create TaskFlow records, mutate DB state, deploy/restart services, send providers, ACK/replay terminal rows, publish releases, or move secrets.

CLI:

`npm run worker_subagent_spawn_authorization_request -- --input fixtures/worker-subagent-orchestration/spawn-authorization-request-ready.json --json`

Example input:

```json
{
  "task": {
    "taskId": "task-large-independent",
    "size": "large",
    "coupling": "low",
    "hasIndependentSubtasks": true,
    "writeSets": ["src/core/planner.ts", "docs/planner.md", "test/planner.test.ts"]
  },
  "host": {
    "workerId": "workergamma",
    "cpuLoadPct": 42,
    "memoryUsedPct": 55,
    "ioPressure": "low",
    "eventLoopDegraded": false,
    "gatewayPressure": "low",
    "activeSubagents": 0,
    "workerSubagentCap": 3,
    "brokerActiveSubagents": 4,
    "brokerSubagentCap": 12
  }
}
```

## Spawn Gate Decision

`a2a-broker.worker-subagent-spawn-gate-decision.packet` consumes a spawn-authorization-request packet and (optionally) a `worker-subagent-budget-counter.packet`, together with a concrete requested spawn, and emits a **binding `authorized` / `refused` verdict**. Unlike the authorization-request draft (which "is not a runtime spawn gate"), this packet IS the deterministic gate decision.

It refuses when the authorization draft is not ready, the single-finalizer rule is not asserted, the token/cost budget is exhausted (`spawnBudgetCeiling === 0`), the requested count exceeds the effective ceiling (`clampParallelism(plannerParallelismHint)`, hard cap 4, shrunk to 0 by an exhausted budget), or implementer write sets overlap (`hasOverlappingWriteSets`). A missing budget counter is a non-blocking `review` (the count budget still governs); zero requested sub-agents is always authorized (Escape Hatch).

The packet DECIDES only. It produces `producesBindingVerdict: true` but `enforcesSpawn: false` with all boundaries false — it does not itself spawn, dispatch, claim, invoke executors, mutate state, deploy/restart, send providers, ACK/replay, publish, or move secrets. A Phase-2 runtime consults the verdict before an actual spawn.

CLI:

`npm run worker_subagent_spawn_gate_decision -- --input fixtures/worker-subagent-orchestration/spawn-gate-decision-authorized.json --json`
