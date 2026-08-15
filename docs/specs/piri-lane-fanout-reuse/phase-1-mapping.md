# Phase 1 — decider reuse mapping (claude-code fanout → piri lane)

Spec: `spec.md` (this directory). Date: 2026-08-15. Evidence base: nexus HEAD
`1d97ed1` (read-only) and the deployed piri distribution `v0.83.0-piri.1`
checkout, continuing the Phase-0 evidence (`phase-0-findings.md`). No runtime
change is authorized by this document; it only maps.

## Reuse principle

The Phase-1 deciders are broker-side TypeScript and harness-agnostic by
design. A lane only ever carries three things: (a) the per-task authorization
env the broker computes, (b) the executor mechanism that spawns helpers, and
(c) the evidence-return channel. Phase 1 maps (a)–(c) for the piri lane and
names every claude-specific coupling; Phase 2 (wiring) stays gated as written
in `spec.md`.

## 1. Decider reuse mapping

| Decider | Location (nexus HEAD) | Lane coupling today | Piri-lane path | Verdict |
|---|---|---|---|---|
| Budget counter | `packages/attestation/src/worker-subagent-budget-counter.ts` | none (broker-side) | unchanged | **reused as-is** |
| Spawn gate decision | `packages/attestation/src/worker-subagent-spawn-gate-decision.ts` | none (broker-side) | unchanged | **reused as-is** |
| Orchestration policy | `packages/attestation/src/worker-subagent-orchestration-policy.ts` | none (broker-side) | unchanged | **reused as-is** |
| Dynamic runtime (packets → shrink-only authorization) | `packages/broker/src/workers/subagent-runtime.ts` (`buildDynamicSubagentRuntime`) | `fanoutEnabled` is keyed on `A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED` and the authorized env re-emits that same key | piri needs a mirrored `A2A_DOCKER_RUNNER_PIRI_FANOUT_ENABLED` (same default 0, same single-flag rollback) and the flag key parametrized per lane — additive, broker-side only | **Phase-2 mirror** (no decider semantics change) |
| Context brief | `packages/broker/src/core/worker-subagent-context-brief.ts` + runner `materializeSubagentContextBrief` (`packages/docker-runner/src/runner.ts`) | none — transport is lane-independent: full-redaction-checked brief written to `/work/artifacts/context-brief.md` + `A2A_SUBAGENT_CONTEXT_BRIEF` env | the piri script already shares `/work/artifacts`; the fanout prompt points helpers at the same file | **reused as-is** |
| Redaction gate | `packages/attestation/src/worker-subagent-redaction-gate.ts` | none (broker-side, after return) | unchanged; `A2A_WORKER_SUBAGENT_REDACTION_MODE` (`redact` default / `reject`) unchanged | **reused as-is** |
| Evidence assembly | `packages/attestation/src/worker-subagent-evidence-assembly.ts` | none (broker-side, after return) | unchanged | **reused as-is** |

Broker-side binding of the returned report (count/roles/ids/write sets vs the
trusted plan, raw-entry stripping before completion/provenance signing in
`finalizeSubagentEvidence`) is likewise lane-agnostic: it validates whatever
report the runner extracted, regardless of which lane produced it.

## 2. Claude-specific mechanisms → piri equivalents (no hand-waving)

Anchors: nexus = `packages/…` at HEAD `1d97ed1`; piri = the distribution
checkout at `v0.83.0-piri.1` (`packages/coding-agent` 0.83.0).

| # | Claude-code mechanism | Piri equivalent | Status |
|---|---|---|---|
| 1 | Opt-in flag `A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED` (config.ts `loadContainedSubagentsConfig`; bridge mode selection) | new mirror `A2A_DOCKER_RUNNER_PIRI_FANOUT_ENABLED`, default `0`, single-flag rollback to the current plain `-p` script | **Phase-2 mirror** |
| 2 | Executor: Claude Code built-in `Task` tool (bridge adds it via `--allowedTools`) | `subagent` tool from the official example extension (in-image, unwired — Phase-0 §5); loaded per-run with `-e <extension-path>` | **exists; Phase-2 wiring** |
| 3 | Tool allowlist `--allowedTools "Task Read Grep Glob Bash Edit Write"` | `piri -e <ext> -t subagent,read,grep,find,ls,edit,write,bash` — `-t/--tools` allowlists built-in, extension, and custom tools in print mode (usage.md "Tool Options") | **direct equivalent** |
| 4 | Roster `~/.claude/agents/a2a-*.md` copied to `/root/.claude` in-container | user-scope roster at `$HOME/.piri/agent/agents/*.md`, traveling via the existing config copy (`cp -a /run/secrets/piri-dir /work/piri-home/.piri; export HOME=/work/piri-home`) — the same four files from the normative roster mapping (`docs/specs/cc-worker-subagent-roster/spec.md`): `a2a-explorer` / `a2a-researcher` / `a2a-implementer` / `a2a-verifier`, authored with piri frontmatter (`name`, `description`, `tools`, `model`) | **equivalent; roster authoring is host work** (Phase-0 gap 2) |
| 5 | Sub-agent model from roster md `model:` frontmatter, resolved by the Claude Code harness (D3) | same `model:` frontmatter, resolved **by the extension itself**: `index.ts` passes `--model agent.model` to each spawned child — source-verified, stronger evidence than the claude lane's doc-level verification | **direct equivalent** (model values must match the lane's model contract, e.g. the `A2A_PIRI_MODEL` pattern) |
| 6 | Env passthrough: runner injects `A2A_CONTAINED_SUBAGENTS_ENABLED/MAX/ROLES/OUTPUT_BYTES/REASONS` (runner.ts `-e` args) + claude bridge `SAFE_CHILD_ENV_KEYS` allowlist for the child | the injected env reaches the `pi` parent, and the extension spawns children with inherited process env (no `env` override in its `spawn` call) — no harness-layer allowlist needed; Phase 2 must keep the injected key set identical (no new keys) | **equivalent** |
| 7 | Turn bound: `A2A_CLAUDE_CODE_FANOUT_MAX_TURNS` (default 40, hard cap 200; `--max-turns`) | **none exists**: piri has no `--max-turns` flag or turn-limit setting (checked the usage.md option tables, settings/json/extensions docs, and the CLI source). Available bounds today: roster `tools:` scoping, `PER_TASK_OUTPUT_CAP`, the parent-level `timeout "$A2A_PIRI_TIMEOUT_SEC"`, and abort propagation (the extension kills each child SIGTERM→5 s→SIGKILL) | **gap — see §4.3** |
| 8 | Output byte bounds broker-side: `A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_OUTPUT_BYTES` (default 12000, clamp 1024–60000) | same broker-side clamp reused; the example's constants (`MAX_PARALLEL_TASKS=8`, `MAX_CONCURRENCY=4`, `PER_TASK_OUTPUT_CAP=50KB`) are convenience bounds that must clamp **down** to the injected budget — alignment noted in Phase 0 (concurrency 4 == hard cap 4 incl. the worker; 50KB inside 1–60KB) | **gap — see §4.1** |
| 9 | Spawn prompt `buildFanoutSubagentPrompt` advertising budget/roles/reasons/outputBytes + the brief path | same advertising text appended to the lane-composed `piri-prompt.md` (the script already concatenates a header + assignment; `--append-system-prompt` is also available for the parent) | **Phase-2 composition** |
| 10 | Evidence return: bridge final answer JSON carries `subagentReport`, emitted as the envelope `{"payloads":[{"text":"<json>"}]}` that `extractStructuredSubagentReport` (runner.ts) parses | piri `-p` stdout is the **bare** schema-validated final answer (no envelope) — shape mismatch | **gap — see §4.4** |
| 11 | `--output-schema` composition (Phase-0 gap 4): helpers' output vs the final-answer schema | children run `--mode json -p --no-session` with no schema; the parent keeps the lane `--output-schema` (baked `/etc/a2a-runner/piri-analysis-output.schema.json`) and must embed the report in its final JSON — composable as designed; the schema re-prompt loop is already bounded (attempts 3, `PI_OUTPUT_SCHEMA_ATTEMPTS` cap 10) | **composable; schema needs the optional `subagentReport` block in Phase 2** |
| 12 | Lane lifecycle guard | already present on the piri lane: git/gh guard scripts on `PATH`; spawned children inherit the same `PATH` | **already satisfied** |

## 3. Budget / ceiling parity (reuse, not fork)

- Authorized budget 0–3 with hard cap 4 including the worker — broker-side, unchanged.
- Output bytes 1KB–60KB broker clamp — unchanged; the extension cap must clamp down to the injected value (Phase 2).
- Brief ≤64KB with a full-redaction requirement at materialization — unchanged.
- Fanout default-off with single-flag rollback — mirrored flag, default `0`.
- Escape Hatch (0 always valid) and `mandatoryProductionSpawn` staying false — unchanged.

## 4. Named gaps carried into Phase 2

1. **(Phase-0 gap 1) Example-grade executor.** The example extension reads no
   env; its bounds are hardcoded constants. Phase 2 must harden it (or a lane
   fork) to take budget/roles/output-bytes from the injected
   `A2A_CONTAINED_SUBAGENTS_*` env and clamp to the broker-authorized budget.
2. **(Phase-0 gap 2) Roster authoring.** The four roster md files do not exist
   on any host. They are authored from the normative roster mapping into the
   piri config dir (`<piri-config>/agents/`) and travel with the existing
   config mount; the repo carries only the mapping.
3. **(Phase-0 gap 3) Child turn bound.** No CLI-level turn limit exists
   (§2.7). Phase 2 must add an explicit bound before any canary — candidate
   mechanisms: a per-child `timeout` wrapper in the hardened extension,
   roster `tools:` scoping, and the existing parent `timeout` + abort
   propagation. The chosen mechanism must be bounded and testable.
4. **(new) Evidence-return shape.** `extractStructuredSubagentReport` expects
   the claude envelope; piri stdout is bare JSON (§2.10). Phase 2 must either
   generalize the extractor to accept a bare final-answer JSON or have the
   piri script wrap stdout into the envelope — one of the two, named up front.
5. **(new) Scope pinning.** The `subagent` tool takes an `agentScope` param
   that can load repo-controlled `.pi/agents/*.md` (project scope). The
   default is user scope; the Phase-2 fanout prompt must pin user scope and
   never pass `agentScope: "project"|"both"`, preserving the claude lane's
   host-controlled-roster security property.

## 5. Test / fixture inventory

**Lane-agnostic — must keep passing unchanged (the reuse oracle):**

- `packages/attestation/src/worker-subagent-budget-counter.test.ts`
- `packages/attestation/src/worker-subagent-spawn-gate-decision.test.ts`
- `packages/attestation/src/worker-subagent-orchestration-policy.test.ts`
- `packages/attestation/src/worker-subagent-redaction-gate.test.ts`
- `packages/attestation/src/worker-subagent-evidence-assembly.test.ts`
- `packages/broker/src/core/worker-subagent-context-brief.test.ts`
- `packages/broker/src/core/worker-subagent-planner-handoff.test.ts`
- `packages/broker/src/core/worker-subagent-spawn-authorization-request.test.ts`
- `packages/broker/src/core/orchestration-intelligence-worker-subagent-spawn-bridge.test.ts`
- broker `worker.test.ts` dynamic-runtime / finalize tests — the logic is
  lane-agnostic; only the env **key name** is claude-coupled, so Phase 2
  parametrization updates these suites additively (new cases for the piri
  flag), never by forking them.
- docker-runner context-brief materialization expectations
  (`engine-contract.test.ts`: `/work/artifacts/context-brief.md`,
  `A2A_SUBAGENT_CONTEXT_BRIEF`) — lane-independent.

**Claude-lane-specific — piri variants needed in Phase 2 (additive):**

- `packages/docker-runner/src/config.test.ts` claude fanout-mode / flag /
  turn-budget projections → piri script fanout tests (mode emission only when
  the piri flag is 1, `-e`/`-t` args, prompt advertising).
- `packages/docker-runner/src/engine-contract.test.ts` claude-specific
  `A2A_CONTAINED_SUBAGENTS_*` expectations → piri-profile equivalents.
- `packages/docker-runner/src/runner-manifest.test.ts` envelope-shaped
  `subagentReport` extraction → bare-JSON variant (or tests for the
  generalized extractor chosen in §4.4).
- `packages/broker/scripts/claude-a2a-patch-bridge*.test.mjs` (fanout path,
  `SAFE_CHILD_ENV_KEYS`, fanout prompt, max-turns) → piri equivalents live in
  command-script tests plus new tests for the hardened lane extension
  (§4.1/§4.3/§4.5).

## 6. Phase-2 wiring checklist (preview — not authorized by this document)

Mirror flag (default 0) → contained-subagents gating for the piri profile →
script fanout branch (`-e`, `-t`, prompt advertising, brief pointer) → roster
md deployment via the config mount → hardened extension (env inputs, clamps,
child bound, scope pinning) → optional `subagentReport` block in the baked
output schema + extractor generalization → tests per §5 → Phase 3
shadow/canary exactly as the #1798 decision packet requires. Live spawn,
deploy, restart, and canary remain operator-approved steps.
