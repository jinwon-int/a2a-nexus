# Phase-2 wiring design: claude-code container-lane sub-agent fanout

Concrete wiring design for **Phase 2** of `spec.md` (epic #1543). Turns the Phase-2 checklist into implementable changes against current code. Status: **design; not yet implemented.** Everything stays opt-in and default-off; `single-shot` remains the default with a one-flag rollback.

## Where each concern lives (the key split)

The Phase-1 deciders are **broker-side TypeScript** (`packages/broker/src/core/worker-subagent-*.ts`); the container runs the **bridge executor** (`packages/broker/scripts/claude-a2a-patch-bridge.mjs`). So the wiring is a pipeline across that boundary:

1. **Before dispatch (broker handler / conductor):** build `worker-subagent-budget-counter` → `worker-subagent-spawn-gate-decision` (a `refused` verdict ⇒ do not enable fanout / budget 0) → `worker-subagent-context-brief`. Inject the brief + authorized budget/roles/model into the container.
2. **In the container (bridge, fanout mode):** honor the injected budget, spawn the roster via Claude Code's `Task` tool at Sonnet-5, orchestrate, return one worker answer.
3. **After return (broker):** run each sub-agent evidence through `worker-subagent-redaction-gate` → assemble via `worker-subagent-evidence-assembly` → terminal evidence.

The container never re-derives the gate/brief; it consumes what the broker computed and returns raw sub-agent evidence for broker-side redaction+assembly. This keeps the container a thin executor and the deciders in one place.

## Current wiring (anchors)

| Concern | Location | Current state |
|---|---|---|
| Patch mode | bridge `isSingleShotPatchMode` (L646-648), marker `single-shot` (L643) | only `single-shot` vs legacy agentic; **no `fanout` mode** |
| Mode forced | `config.ts` L723 `export A2A_CLAUDE_CODE_PATCH_MODE=single-shot` | claude-code always single-shot |
| Tools | bridge single-shot L997/1035 `--tools "Read Grep Glob"`; agentic L541 `--allowedTools "Bash Edit Write Read Glob Grep"` | **no `Task`** anywhere |
| max-turns | single-shot 6; agentic 40 (L541/996/1034) | single-shot too small to orchestrate |
| Child env allowlist | bridge `SAFE_CHILD_ENV_KEYS` (L130), filter L140 | `A2A_CONTAINED_SUBAGENTS_*` **stripped** |
| Contained default | `config.ts` `containedSubagentsEnabledByDefault` L513-518 | openclaw/hermes only (claude-code off) |
| Env injection | `runner.ts` L581-586 injects `A2A_CONTAINED_SUBAGENTS_*` when enabled | works once enabled |
| Spawn prompt | `config.ts` `buildContainedSubagentPrompt` L1543 (`"OpenClaw"|"Hermes"`) | not built for claude-code |
| Model | `config.ts` L680/687-692; bridge `resolveExplicitClaudeModel` | parent model only; `model_tier` advisory, unmapped |

## Workstream designs

### WS1 — opt-in fanout mode + rollback (do first)
- Add flag `A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED` (default `0`). In `config.ts` claude-code script (near L723), emit `A2A_CLAUDE_CODE_PATCH_MODE=fanout` **only when the flag is `1`**, else keep `single-shot`.
- In the bridge, add `FANOUT_PATCH_MARKER = "fanout"` + `isFanoutPatchMode(env)` beside `isSingleShotPatchMode`; `main()` selects: fanout (flag on) → new orchestration path; else the existing single-shot/agentic path unchanged.
- **Rollback** = set the flag to `0` (or unset) ⇒ `single-shot`. **Acceptance:** flag off ⇒ byte-identical to today; on ⇒ fanout path; toggling back restores single-shot.

### WS2 — tier → Sonnet-5 model mapping
- Add `A2A_CONTAINED_SUBAGENTS_MODEL` (default a Sonnet-5 id), injected by `runner.ts` alongside the other `A2A_CONTAINED_SUBAGENTS_*` (L581-586). The roster agent md carries `model_tier: low-cost` (advisory, "inherit-parent-unless-runner-maps"); the runner now maps it. Sub-agents run at this model; the parent/finalizer keeps `A2A_CLAUDE_MODEL`.
- **Acceptance:** in fanout mode, sub-agents = Sonnet-5, finalizer = parent, visible in the spawn command / evidence.

### WS3 — Task tool + roster exposure
- Bridge fanout path builds the claude call with `--allowedTools "Task Read Grep Glob Bash Edit Write"` (adds `Task`). Single-shot/agentic tool sets unchanged.
- Roster: the mounted `~/.claude/agents/` is copied to `/root/.claude` in-container (`config.ts` L274-279 / 716-721) and auto-discovered by Claude Code — confirm the `a2a-explorer/researcher/implementer/verifier` md files are present in the mounted host config; add `--agents`/bake only if discovery needs it.
- **Acceptance:** fanout worker can spawn the roster; single-shot still has no `Task`.

### WS4 — spawn prompt + un-strip env + raise max-turns
- Add `A2A_CONTAINED_SUBAGENTS_ENABLED/MAX/ROLES/OUTPUT_BYTES/REASONS` + `A2A_CONTAINED_SUBAGENTS_MODEL` to bridge `SAFE_CHILD_ENV_KEYS` (L130) so they reach the claude child.
- Extend `containedSubagentsEnabledByDefault` (L513-518) to include `claude-code` **when the WS1 flag is on**; `runner.ts` L581 then injects the env.
- Spawn prompt: generalize `buildContainedSubagentPrompt` label to include `"Claude Code"` and have the bridge fanout path add it via `--append-system-prompt` (built from the injected budget/roles/reasons/outputBytes).
- Raise fanout `--max-turns` (configurable env, default e.g. 40) vs single-shot's 6.
- **Acceptance:** fanout worker receives budget+roles+instruction and orchestrates within the raised turn budget.

### WS5 — runtime consumption of the Phase-1 packets
- **Broker handler (before dispatch):** compute `budget-counter` → `spawn-gate-decision`; if `refused` (or `spawnBudgetCeiling === 0`), keep fanout disabled / budget 0 for this task (**this is the "cost counter live with a hard ceiling" enforcement the source-only counter deferred**). Build `context-brief`; inject brief (file/env) + the authorized `A2A_CONTAINED_SUBAGENTS_MAX/ROLES`.
- **Broker handler (after return):** run each sub-agent evidence through `redaction-gate` (reject mode ⇒ drop leaking output), then `evidence-assembly` for the canonical, ordered, digest-anchored bundle → terminal evidence.
- **Acceptance:** a `refused` verdict blocks the spawn at runtime; a secret in output is masked/excluded before evidence; the terminal bundle is the assembled canonical one.

## Flag & rollback summary

- `A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED=0` (default) ⇒ single-shot, unchanged behavior.
- `=1` ⇒ fanout path (WS1-5). One flag flips back to single-shot (rollback). The 0-subagent Escape Hatch is always valid regardless of flag.

## Open decisions

1. **Brief transport into the container** — env var (bounded) vs a mounted file under the disposable workspace vs stdin. A file is cleanest for large briefs; env for small.
2. **Gate at broker vs in-container** — recommended broker-side (deciders live there); confirm the external-worker handler (`createExternalWorkerHandler`) is the right hook and not `worker.ts`.
3. **Sub-agent model injection mechanism** — `A2A_CONTAINED_SUBAGENTS_MODEL` env consumed by the spawn prompt, vs setting `model:` in the roster md (host harness), vs a Claude Code `--agents` model override. Prefer the env so the tier mapping is a runner concern, not baked into the host md.
4. **max-turns value** — fixed 40 vs env-configurable with a hard ceiling.

## Non-goals (Phase-2)

- No Phase-3 canary here (that follows once the go/no-go gate holds).
- `single-shot` stays the default; fanout never becomes mandatory (`mandatoryProductionSpawn` stays false).
- No new broker dispatch/admission semantics beyond consuming the existing packets.
