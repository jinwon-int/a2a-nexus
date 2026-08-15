# Phase-2 wiring design: piri lane sub-agent fanout (decider reuse)

Concrete wiring design turning the Phase-1 mapping (`phase-1-mapping.md` §6)
into implementable changes. Mirrors the structure of the claude-code
`docs/specs/cc-worker-container-fanout/phase-2-wiring.md` (its WS1–WS5), with
every claude-specific mechanism replaced by its named piri equivalent or an
explicitly designed gap-closure. Status: **WS1 implemented (code+tests,
2026-08-15); WS2–WS5 remain spec-only.** Fanout stays
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

### WS2 — executor: hardened subagent extension (Phase-1 gap 1, 3, 5)

- Fork the official example extension
  (`packages/coding-agent/examples/extensions/subagent/`, present but unwired
  in the pinned image) into the docker-runner image at a stable path,
  e.g. `/opt/a2a-runner/piri-fanout-extension/`, and bump the image pin.
- Hardening requirements (all named by Phase-1 §4):
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
     and rejects any prompt-selected `project`/`both`; project-local
     `.piri/agents` can never load.
- The extension spawns children with `--mode json -p --no-session` and
  inherited env (no `env` override), so the injected
  `A2A_CONTAINED_SUBAGENTS_*` keys and the guarded `PATH` reach every child.

### WS3 — tool allowlist + roster

- Parent invocation gains `-e /opt/a2a-runner/piri-fanout-extension -t
  subagent,read,grep,find,ls,edit,write,bash` (superset for the finalizer
  parent; per-child narrowing comes from the roster frontmatter `tools:`).
- Roster: author the four files from the normative mapping
  (`docs/specs/cc-worker-subagent-roster/spec.md`) — `a2a-explorer`,
  `a2a-researcher`, `a2a-implementer`, `a2a-verifier` — with piri frontmatter
  (`name`, `description`, `tools`, `model`) into the host piri config dir
  `<piri-config>/agents/`. They travel via the existing config copy
  (`cp -a /run/secrets/piri-dir /work/piri-home/.piri`) — no new mount, no
  secret surface change. Explorer/researcher `tools:` are read-only;
  implementer adds `edit,write,bash` inside its declared write set;
  verifier adds `bash` for tests only. `model:` values must resolve in the
  lane model contract (the `A2A_PIRI_MODEL` pattern space).

### WS4 — prompt + brief + mode

- `buildPiriPatchCommandScript` gains a fanout branch (selected only when
  the WS1 flag is `1`): the composed `piri-prompt.md` appends the same
  advertising text as the claude lane (budget/roles/reasons/output-bytes,
  brief pointer) and points helpers at `/work/artifacts/context-brief.md`.
- The runner's existing contained-subagent env injection
  (`runner.ts` L812–823) and `materializeSubagentContextBrief` are
  lane-independent and activate automatically once WS1 enables the config
  for the piri profile — no change needed there.
- Read-only tasks keep the read-only prompt head; fanout is not available
  for them in Phase 2 (keeps the first slice small; widen later only with
  operator approval).

### WS5 — evidence return (gap 4: named choice = generalize the extractor)

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
  fanout mode.
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
  env-input refusal, clamp-down, child timeout, scope pinning.

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
