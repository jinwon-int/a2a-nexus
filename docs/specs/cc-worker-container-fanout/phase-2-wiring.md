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
- **Mechanism = the roster agent md `model:` frontmatter (host harness), not a runner env** (see resolved decision D3). Claude Code resolves a sub-agent's model from its agent md `model:` field; the current roster md carries a custom `model_tier: low-cost` that Claude Code ignores. Set `model: sonnet` (alias → the node's Sonnet-5-grade) on each `~/.claude/agents/a2a-*.md`. The parent/finalizer keeps `A2A_CLAUDE_MODEL` (e.g. opus). An `A2A_CONTAINED_SUBAGENTS_MODEL` env would be inert for model selection.
- This makes WS2 a **host-harness (ccc-node) roster change**, not a nexus runner change; nexus's role is only to mount that harness (already does).
- **Acceptance:** in fanout mode, sub-agents run at Sonnet-5-grade (from the md `model:`), finalizer at the parent model. Confirm the deployed Claude Code CLI version honors the `model:` frontmatter field.

### WS3 — Task tool + roster exposure
- Bridge fanout path builds the claude call with `--allowedTools "Task Read Grep Glob Bash Edit Write"` (adds `Task`). Single-shot/agentic tool sets unchanged.
- Roster: the mounted `~/.claude/agents/` is copied to `/root/.claude` in-container (`config.ts` L274-279 / 716-721) and auto-discovered by Claude Code — confirm the `a2a-explorer/researcher/implementer/verifier` md files are present in the mounted host config; add `--agents`/bake only if discovery needs it.
- **Acceptance:** fanout worker can spawn the roster; single-shot still has no `Task`.

### WS4 — spawn prompt + un-strip env + raise max-turns
- Add `A2A_CONTAINED_SUBAGENTS_ENABLED/MAX/ROLES/OUTPUT_BYTES/REASONS` to bridge `SAFE_CHILD_ENV_KEYS` (L130) so they reach the claude child. (Sub-agent **model** is set via the roster md `model:`, per D3 — not an env var.)
- Extend `containedSubagentsEnabledByDefault` (L513-518) to include `claude-code` **when the WS1 flag is on**; `runner.ts` L581 then injects the env.
- Spawn prompt: generalize `buildContainedSubagentPrompt` label to include `"Claude Code"` and have the bridge fanout path add it via `--append-system-prompt` (built from the injected budget/roles/reasons/outputBytes).
- Raise fanout `--max-turns` (configurable env, default e.g. 40) vs single-shot's 6.
- **Acceptance:** fanout worker receives budget+roles+instruction and orchestrates within the raised turn budget.

### WS5 — runtime consumption of the Phase-1 packets
- **Broker handler (before dispatch):** compute `budget-counter` → `spawn-gate-decision`; if `refused` (or `spawnBudgetCeiling === 0`), keep fanout disabled / budget 0 for this task (**this is the "cost counter live with a hard ceiling" enforcement the source-only counter deferred**). Build `context-brief`; inject brief as a `/work/artifacts/context-brief.md` file (per D1) + the authorized `A2A_CONTAINED_SUBAGENTS_MAX/ROLES`.
- **Broker handler (after return):** run each sub-agent evidence through `redaction-gate` (reject mode ⇒ drop leaking output), then `evidence-assembly` for the canonical, ordered, digest-anchored bundle → terminal evidence.
- **Acceptance:** a `refused` verdict blocks the spawn at runtime; a secret in output is masked/excluded before evidence; the terminal bundle is the assembled canonical one.

## Flag & rollback summary

- `A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED=0` (default) ⇒ single-shot, unchanged behavior.
- `=1` ⇒ fanout path (WS1-5). One flag flips back to single-shot (rollback). The 0-subagent Escape Hatch is always valid regardless of flag.

## Resolved decisions

Resolved against current code (anchors below). Confirmed each with a grep/read of nexus HEAD.

**D1 — Brief transport → a mounted `/work/artifacts/` file (not env).** The container already reads its assignment from a file: `ASSIGNMENT="$(cat /work/artifacts/prompt.md)"` (config.ts claude-code script), and the script writes `summary.txt` there. The broker writes the brief the same way — e.g. `/work/artifacts/context-brief.md` (or `.json`) — and the fanout prompt points sub-agents at it. Env vars are bounded and unsuitable for a full brief.

**D2 — Gate/brief computed broker-side at the sub-agent-directive assembly in `worker.ts`.** `worker.ts:829-831` already builds the directive (`A2A_SUBAGENT_MAX` / `A2A_SUBAGENT_ROLES` / `A2A_SUBAGENT_PLAN` from `packet.decision`), reached via `createExternalWorkerHandler` (`worker.ts:950`, which reads `A2A_SUBAGENT_MAX` at :974). The budget-counter → spawn-gate-decision → context-brief compute here; a `refused` / `spawnBudgetCeiling === 0` verdict sets the injected max to 0. So the hook is the `worker.ts` directive assembly *driven by* `createExternalWorkerHandler` — the same place, confirmed. Redaction-gate + evidence-assembly run here on return.

**D3 — Sub-agent model = the roster md `model:` frontmatter (host harness), not a runner env.** Claude Code resolves a sub-agent's model from its agent md `model:` field (an alias `sonnet`/`opus`/`haiku`, a full model id, or `inherit`) — it does **not** read an arbitrary `A2A_CONTAINED_SUBAGENTS_MODEL`. The current roster md carries a custom `model_tier: low-cost` that Claude Code ignores. So WS2 = add `model: sonnet` to each `~/.claude/agents/a2a-*.md` in the ccc-node harness; finalizer stays on the parent via `A2A_CLAUDE_MODEL`. (Confirm the deployed CLI version honors `model:` — the fleet runs mixed CLI versions.)

**D4 — max-turns → a new env-configurable var with a hard ceiling.** max-turns is already env-driven: `positiveInteger(env.A2A_CLAUDE_CODE_PATCH_MAX_TURNS, 6)` (single-shot) and `A2A_CLAUDE_CODE_MAX_TURNS, 40` (agentic) in the bridge. Add `A2A_CLAUDE_CODE_FANOUT_MAX_TURNS` (default 40, matching the agentic path), clamped to a hard ceiling, for the fanout path.

> Note: `claude-api` skill covers the Anthropic API/SDK, not the Claude Code CLI sub-agent frontmatter — D3's `model:` behavior is Claude Code product behavior and should be verified against the deployed CLI version.

## Non-goals (Phase-2)

- No Phase-3 canary here (that follows once the go/no-go gate holds).
- `single-shot` stays the default; fanout never becomes mandatory (`mandatoryProductionSpawn` stays false).
- No new broker dispatch/admission semantics beyond consuming the existing packets.
