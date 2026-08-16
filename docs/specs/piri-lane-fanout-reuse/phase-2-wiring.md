# Phase-2 wiring design: piri lane sub-agent fanout (decider reuse)

Concrete wiring design turning the Phase-1 mapping (`phase-1-mapping.md` §6)
into implementable changes. Mirrors the structure of the claude-code
`docs/specs/cc-worker-container-fanout/phase-2-wiring.md` (its WS1–WS5), with
every claude-specific mechanism replaced by its named piri equivalent or an
explicitly designed gap-closure. Status: **Phase 2 code complete — WS1–WS5
all implemented (code+tests, 2026-08-15/16); Phase 3 (shadow → canary →
widen) remains, per-step operator approval per #1798.** Fanout stays
opt-in and default-off everywhere; every live spawn / deploy / restart /
canary step remains operator-approved per the #1798 decision packet.

## Where each concern lives (unchanged split)

Same as the claude lane: the Phase-1 deciders stay broker-side TypeScript;
the container stays a thin executor. The pipeline:

1. **Before dispatch (broker, `createExternalWorkerHandler` →
   `buildDynamicSubagentRuntime`):** budget-counter → spawn-gate-decision →
   context-brief; inject the authorized budget/roles and the brief. The
   container never re-derives these.
2. **In the container (piri parent + subagent extension):** honor the
   injected budget, spawn roster helpers via the `subagent` tool, return one
   final answer embedding `subagentReport`.
3. **After return (broker, `finalizeSubagentEvidence` in
   `src/workers/subagent-evidence.ts`):** redaction-gate →
   evidence-assembly → terminal evidence. Lane-agnostic today and unchanged.

## Workstreams

### WS1 — mirrored opt-in flag + rollback (**implemented**, 2026-08-15)

- New env `A2A_DOCKER_RUNNER_PIRI_FANOUT_ENABLED` (default `0`), mirroring
  `A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED` exactly.
- `loadContainedSubagentsConfig` (`packages/docker-runner/src/config.ts`)
  gains one clause: `|| (effectiveProfile === "piri" &&
  env.A2A_DOCKER_RUNNER_PIRI_FANOUT_ENABLED === "1")`. Roles default stays the
  non-hermes `["explorer","implementer","verifier"]`; all clamps
  (max 1–4, output 1024–60000) identical.
- **Broker flag resolution:** `worker.ts` currently keys `fanoutEnabled` on
  the claude flag only. Introduce `resolveActiveFanoutFlagKey(env)` returning
  `"claude-code" | "piri" | undefined` (claude flag wins if both are set —
  it cannot happen in practice because the runner emits exactly one), and
  thread the key into `buildDynamicSubagentRuntime` as `fanoutFlagKey` so the
  authorized env emits `A2A_DOCKER_RUNNER_PIRI_FANOUT_ENABLED=1` (and the
  closed env emits `=0`) on the piri lane. No decider semantics change.
- **Rollback** = set the flag to `0`/unset ⇒ the current plain
  `piri -p` script path byte-for-byte; single flag, no second switch.

### WS2 — executor: hardened subagent extension (**implemented**, 2026-08-15)

- Forked into the repo at
  `packages/docker-runner/docker/piri-fanout-extension/` (`index.js` tool +
  `agents.js` user-scope discovery + dependency-free `policy.js`), baked
  into the image at `/opt/a2a-runner/piri-fanout-extension/` by
  `piri-runner.Dockerfile`. **No piri ref bump needed:** the pinned
  `v0.83.0-piri.1` already ships the example this forks, and the fork is
  self-contained (piri's extension loader provides the
  `@earendil-works/*`/`typebox` modules to extensions regardless of path).
- Hardening as designed (all named by Phase-1 §4):
  1. **Env inputs:** read `A2A_CONTAINED_SUBAGENTS_MAX / ROLES /
     OUTPUT_BYTES / REASONS`; refuse (`exit 3`-style error result, no spawn)
     when `A2A_CONTAINED_SUBAGENTS_ENABLED != 1` or the env is absent.
  2. **Clamp-down:** `MAX_PARALLEL_TASKS`, `MAX_CONCURRENCY`, and
     `PER_TASK_OUTPUT_CAP` clamp to the injected budget (≤4 parallel, ≤
     injected output bytes) — the example's constants become convenience
     upper bounds only, never expansions.
  3. **Child turn bound (gap 3):** piri has no `--max-turns`; the chosen
     mechanism is a **per-child `timeout` wrapper** in the extension (default
     a fraction of the lane `A2A_PIRI_TIMEOUT_SEC`, e.g. ⌈timeout/(n+1)⌉,
     configurable via `A2A_PIRI_FANOUT_CHILD_TIMEOUT_SEC`, hard-capped at the
     parent timeout), layered on the existing abort propagation
     (SIGTERM→5 s→SIGKILL). The roster `tools:` scoping and the parent
     `timeout` remain defense-in-depth.
  4. **Scope pinning (gap 5):** the tool config pins `agentScope: "user"`
     and rejects any prompt-selected `project`/`both`;
     `agents.js` additionally deletes the project-scope discovery walk, so
     project-local `.piri/agents` can never load.
- The extension spawns children with `--mode json -p --no-session` and
  inherited env (no `env` override), so the injected
  `A2A_CONTAINED_SUBAGENTS_*` keys and the guarded `PATH` reach every child.
- Unit coverage: `packages/docker-runner/src/piri-fanout-extension.test.ts`
  (env-input refusal, clamp-down incl. never-expansion, child-timeout math
  incl. override/cap, scope pinning, inherited-env spawn contract, Dockerfile
  bake). The example's TUI renderers/prompts/sample agents were dropped
  (headless lane; roster is host-side per WS3).

### WS3 — tool allowlist + roster (**implemented**, 2026-08-16)

- `buildPiriPatchCommandScript` gains the fanout branch (selected only when
  the WS1 flag is `1`, emitted at script build time): the patch-lane arm sets
  `PIRI_FANOUT_ARGS=(-e /opt/a2a-runner/piri-fanout-extension -t
  subagent,read,grep,find,ls,edit,write,bash)` (superset for the finalizer
  parent; per-child narrowing comes from the roster frontmatter `tools:`) and
  the invocation expands it inline beside the progress/schema args. Flag off
  ⇒ the emitted script is byte-identical to the non-fanout one. A flag-on
  image missing the baked extension fails closed with
  `error=piri_fanout_extension_missing` (exit 2). Roster: the four files
  remain a host-side artifact per the normative mapping
  (`docs/specs/cc-worker-subagent-roster/spec.md`) — they travel via the
  existing config copy
  (`cp -a /run/secrets/piri-dir /work/piri-home/.piri`) — no new mount, no
  secret surface change.

### WS4 — prompt + brief + mode (**implemented**, 2026-08-16)

- The flag-on patch-lane `piri-prompt.md` appends the shared advertising
  text (`buildContainedSubagentPrompt("Piri", …)`: budget/roles/reasons/
  output-bytes) plus the brief pointer — helpers read
  `/work/artifacts/context-brief.md` first when present. The budget is also
  echoed into `summary.txt` (`piri_fanout=enabled`,
  `contained_subagents_*`) for the evidence stream.
- The runner's existing contained-subagent env injection
  (`runner.ts` L813–823) and `materializeSubagentContextBrief` are
  lane-independent and activate automatically once WS1 enables the config
  for the piri profile — verified unchanged.
- Read-only tasks keep the read-only prompt head and set
  `PIRI_FANOUT_ARGS=()` — fanout is not available for them in Phase 2
  (keeps the first slice small; widen later only with operator approval).

### WS5 — evidence return (gap 4: generalize the extractor) (**implemented**, 2026-08-16)

- **Decision:** generalize `extractStructuredSubagentReport`
  (`packages/docker-runner/src/runner.ts`) to accept **either** the existing
  claude envelope (`{"payloads":[{"text":…}]}`) **or** a bare final-answer
  JSON object carrying `subagentReport` (the piri `-p` stdout shape). The
  envelope path is unchanged (claude lane untouched); the bare path is
  additive. A stdout wrapper script is rejected — it would add a parsing
  layer between the schema validator and the runner for no benefit.
- `docker/piri-analysis-output.schema.json` gains an **optional**
  `subagentReport` block (same shape the claude final answer carries:
  `count` + bounded `entries[]` with role/id/writeSet/status/output).
  `additionalProperties: false` makes this an explicit schema change; it is
  additive because the field is optional and the broker's
  `finalizeSubagentEvidence` already fails closed on absent reports in
  fanout mode. The broker-side `a2a-task-handler.mjs` already accepted a
  direct top-level `subagentReport` (`extractRunnerSubagentReport`) — the
  runner extractor was the only missing half, now closed.
- Broker-side binding, redaction, and assembly run unchanged
  (`subagent-evidence.ts`): count/roles/ids/write-sets vs the trusted plan;
  raw entries stripped; `A2A_WORKER_SUBAGENT_REDACTION_MODE` default
  `redact` / trusted `reject` unchanged.

## Flag & rollback summary

- `A2A_DOCKER_RUNNER_PIRI_FANOUT_ENABLED=0` (default) ⇒ the current plain
  `piri -p` script, byte-for-byte; contained sub-agents stay off for piri.
- `=1` ⇒ fanout branch (WS2–WS5) with all broker ceilings enforced.
- One flag flips back. The 0-subagent Escape Hatch stays always-valid.

## Test plan (from Phase-1 mapping §5)

- **Reuse oracle, unchanged:** all `worker-subagent-*` suites in
  `packages/attestation` and `packages/broker/src/core` keep passing without
  modification; `worker.test.ts` dynamic-runtime cases gain additive piri
  flag-key cases (never a fork).
- **New:** config.test piri fanout-mode emission (flag 0 ⇒ no fanout branch;
  1 ⇒ `-e`/`-t`/advertising present; read-only head preserved);
  engine-contract piri-profile contained-subagent env + brief expectations;
  runner-manifest bare-JSON extractor variant; extension unit tests for
  env-input refusal, clamp-down, child timeout, scope pinning (**WS2 part
  landed** with `src/piri-fanout-extension.test.ts`); config.test piri
  fanout-mode emission — flag 0 ⇒ no fanout branch (byte-identical script),
  1 ⇒ `-e`/`-t`/advertising/budget-echo present, read-only head preserved,
  injected budget follows through (**WS3/WS4 part landed** in
  `config.test.ts`); runner-manifest bare-JSON extractor variant
  (**WS5 part landed**: bare-shape extraction + missing-report absence +
  budget-refusal parity + envelope-path unchanged coverage).

## Non-goals

- No live spawn, deploy, restart, or canary in Phase 2 — those are Phase 3,
  per-step operator approval (shadow → canary → widen), per #1798.
- No decider changes; no new role vocabulary; no default-on anywhere.
- No change to the claude-code lane or its bridge.
- No roster authoring inside this repo — host-side artifact per WS3.

## Human approval required for

Production deploy, Gateway/broker/worker/service restart, live canary or
provider send, **live sub-agent spawn (crosses the source-only boundary)**,
DB mutation/prune/migration/replay, manual Terminal Brief ACK/replay,
release/tag, secret rotation/movement, force push/history rewrite. Phase 2
implementation PRs are code+tests only and remain inside the normal
PR-first flow; nothing here pre-approves the steps above.
