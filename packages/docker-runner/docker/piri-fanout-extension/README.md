# piri-fanout-extension (A2A lane fork)

Hardened fork of the piri example `subagent` extension
(`packages/coding-agent/examples/extensions/subagent/` in
[jinwon-int/piri](https://github.com/jinwon-int/piri) `v0.83.0-piri.1`),
materialized per
`docs/specs/piri-lane-fanout-reuse/phase-2-wiring.md` **WS2** (#1836).

Baked into the piri runner image at `/opt/a2a-runner/piri-fanout-extension`
(`packages/docker-runner/docker/piri-runner.Dockerfile`). The piri lane
command script loads it with `-e /opt/a2a-runner/piri-fanout-extension` only
in fanout mode (`A2A_DOCKER_RUNNER_PIRI_FANOUT_ENABLED=1`, Phase-2 WS1/WS3);
with the flag off, nothing here is loaded and the plain `piri -p` path is
byte-for-byte unchanged.

## Hardening deltas vs the example (Phase-1 §4 gaps 1, 3, 5)

| Gap | Delta |
|---|---|
| 1 — env inputs | `policy.js#parseSubagentBudget` requires `A2A_CONTAINED_SUBAGENTS_ENABLED=1` plus `MAX`/`ROLES`/`OUTPUT_BYTES`/`REASONS`; otherwise the tool returns an `error=a2a_piri_fanout_refused` result and spawns nothing. |
| 1 — clamp-down | `MAX_PARALLEL_TASKS` / `MAX_CONCURRENCY` / `PER_TASK_OUTPUT_CAP` clamp **down** to the injected budget (concurrency hard-capped at 4); the example's constants are convenience upper bounds only, never expansions. |
| 3 — child turn bound | No `--max-turns` exists in piri, so each child gets a wall-clock timeout (default `ceil(A2A_PIRI_TIMEOUT_SEC / (childCount + 1))`, override `A2A_PIRI_FANOUT_CHILD_TIMEOUT_SEC`, hard-capped at the parent timeout) enforced with the same SIGTERM → 5 s → SIGKILL ladder as aborts; a timed-out child records exit code 124 + `stopReason: "timeout"`. |
| 5 — scope pinning | `agentScope` is pinned to `"user"`; a prompt-supplied `"project"`/`"both"` is refused up front, and `agents.js` deletes the project-scope discovery walk entirely — repo-controlled `.piri/agents/` can never load. |

Children are spawned with `--mode json -p --no-session` and **inherited env**
(no `env` override), so the injected `A2A_CONTAINED_SUBAGENTS_*` keys and the
guarded `PATH` reach every child unchanged.

## Files

- `index.js` — the tool (entry point; imports piri-provided modules)
- `agents.js` — user-scope-only roster discovery (host roster under
  `<piri-config>/agent/agents/`; the roster md files themselves are a
  host-side artifact per WS3, not part of this repo)
- `policy.js` — pure budget clamps and child-timeout math (dependency-free;
  unit-tested by `packages/docker-runner/src/piri-fanout-extension.test.ts`)

The example's TUI renderers, workflow prompts, and sample agents were dropped:
this lane runs headless (`-p --mode json`) and the roster is host-controlled.
