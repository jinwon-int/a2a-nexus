# Feature Spec: Claude Code container-lane sub-agent fanout

Status: **planning / not yet implemented.** Tracks the "option A" direction from #1531 (the divergence itself is documented in `packages/broker/docs/worker-subagent-orchestration-policy.md` → *Execution lanes (applicability)*).

## Problem

The worker sub-agent model is fully specified as policy (`packages/broker/docs/worker-subagent-orchestration-policy.md`) and roster (`docs/specs/cc-worker-subagent-roster/spec.md`), and is realized in the **host / native CC-harness lane** (roster in `~/.claude/agents/`, `a2a-claim`). But the **containerized `claude-code` runner lane** — the image the broker dispatches to in production — does **not** wire fanout:

- the runner forces `A2A_CLAUDE_CODE_PATCH_MODE=single-shot` and runs a deterministic bridge (`packages/broker/scripts/claude-a2a-patch-bridge.mjs`);
- the worker's tool budget has **no `Task`/Agent tool** (patch: `Read Grep Glob`; analysis: read-only, Bash/Edit/Write/Web disallowed);
- the mounted `~/.claude/agents/` roster is **inert** (never invoked);
- `A2A_CONTAINED_SUBAGENTS_*` is stripped before the claude child (`SAFE_CHILD_ENV_KEYS`) and default-off for claude-code.

This is policy-compliant today (`mandatoryProductionSpawn: false`, Escape Hatch), but the roster/policy investment is not realized in the production lane. This spec defines **how** to realize adaptive fanout in the container lane **without regressing determinism, cost, or safety** — behind guardrails and off by default.

## Goals

- Adaptive sub-agent fanout (explorer/researcher/implementer/verifier) available to the containerized `claude-code` worker, selected by the existing 0–3 budget / hard-cap-4 policy.
- Single-shot remains the **default**; fanout is opt-in and adaptive (0 is always valid).
- All existing invariants preserved: Single-Finalizer Rule, Write-Set Rule, redaction-mandatory + byte-bounded per sub-agent, host-pressure-only shrink.

## Non-goals

- Forcing spawns (`mandatoryProductionSpawn` stays `false`).
- Changing broker dispatch/admission semantics.
- Enabling fanout without the Phase-1 guardrails below.
- Host/native-lane behavior (already realized; unchanged).

## Model policy

- **Sub-agents = Sonnet-5 grade**; the worker/finalizer stays on the **parent model** (e.g. Opus).
- Rationale: Sonnet-5 neutralizes the weak-model regressions (implementer quality, verifier judgment, redaction reliability, prompt-injection resistance) so it is acceptable for **all** roles, while still capturing the Opus→Sonnet cost delta on the fan-out leaves. The expensive finalizer leg (owns correctness + the signed artifact) stays on the parent model.
- Requires the runner to **map `model_tier` → a concrete model** (today `model_tier` is advisory and inherits the parent unless the runner maps it).

## Invariants (non-negotiable)

1. Single-Finalizer Rule — exactly one finalizer owns merge/closeout/approval; sub-agents are evidence-only.
2. Write-Set Rule — implementer sub-agents require disjoint file/module ownership; overlap ⇒ one implementer + a verifier.
3. Redaction-mandatory + byte-bounded output per sub-agent; only the finalizer assembles terminal evidence.
4. Adaptive budget 0–3, hard cap 4, host-pressure-only shrink; zero-subagent Escape Hatch always valid.
5. Single-shot stays the **default** path; fanout is a distinct opt-in mode with a one-flag rollback.

## What model choice does / does not solve (scoping honesty)

- **Cost** — Sonnet-5 sub-agents largely mitigate the per-token cost of the leaf work, but do **not** remove: token-**volume** amplification (N× repo reads), the expensive finalizer leg, or the absence of an enforcement ceiling (`maxSubagentBudget` is deferred in `broker-policy.md`).
- **Determinism** — **unchanged by model tier.** Concurrency non-determinism, host-state-dependent spawn topology, and evidence-bundle byte-reproducibility (JCS/JWS signing) remain the hardest problem and are addressed in Phase 1.
- **Safety** — model tier keeps redaction/injection strong, but the structural items (widened tool surface for implementer/researcher, N injection surfaces, code-enforced single-finalizer) remain and are addressed in Phase 1.

## Shared context brief (cost optimization)

The dominant fanout cost driver is **token-volume amplification**: N sub-agents each re-read the repo/issue context. A **shared context brief** amortizes this — the finalizer (or a first explorer pass) explores **once** and produces one curated, redacted brief; each sub-agent then **reads the brief instead of re-exploring**. This turns *N explorations* into *1 exploration + N cheap brief-reads*, a large saving when the raw context is much larger than the brief. It is complementary to the Sonnet-5 model choice, not a replacement.

Scope and caveats (correctness-critical):

- **Cuts input re-reading, not reasoning.** Each sub-agent still reasons/generates (irreducible); the brief removes only the redundant context-gathering. Net win for N ≥ 2; for N = 1 / trivial tasks the brief is overhead (the 0-budget Escape Hatch still applies).
- **Staleness — the brief is not a write-time source of truth.** An implementer must **read the live file immediately before editing**; the brief is shared understanding + pointers, not a snapshot to edit from. Parallel implementers editing off a stale brief risk corruption.
- **Lossy compression.** The brief is a finalizer summary; it must carry precise **`file:line` pointers** so a sub-agent can cheaply fetch the exact thing it needs, with fallback to reading source — otherwise omissions cause quality loss or a re-exploration that erases the saving.
- **Redaction-mandatory.** The brief is shared across agents and becomes evidence, so every free-text field is programmatically redacted and byte-bounded — this **composes with the redaction gate** (Phase-1) and establishes its mechanism.
- **Determinism synergy.** The brief is content-addressed (JCS digest) and recordable, aiding the reproducibility controls.

Realized as the source-only `a2a-broker.worker-subagent-context-brief.packet` (finalizer builds; sub-agents consume). Phase-2 wiring injects the brief into each sub-agent instead of a blank repo exploration.

## Phased plan

### Phase 0 — Prerequisites (DONE)
- [x] #1532 / #1534 — the claude-code image must load at all (install `finalizer-tool-policy.mjs`; real load check).
- [x] #1535 — import-guard `main()` so the image build check catches any missing sibling generally.
- [x] Ratify model policy: sub-agents = Sonnet-5 grade; finalizer = parent.

### Phase 1 — Guardrails first (build the ceilings before flipping the switch)
- [ ] **Cost/token counter** — implement the deferred `maxSubagentBudget` counter source (per-task + broker-aggregate) so there is a real enforcement ceiling. No fanout without a cap.
- [ ] **Runtime spawn gate** — promote the existing source-only packets (self-assessment → planner → handoff → spawn-authorization-request) into an actual runtime authorization gate.
- [ ] **Redaction gate** — enforce redaction + byte-bounds on each sub-agent output programmatically (post-process), not only via prompt.
- [ ] **Determinism controls** — deterministic evidence assembly (stable ordering + canonicalization before signing); record the execution graph (roles spawned, budget, host snapshot) in the evidence bundle for replay.

### Phase 2 — Wire the claude-code lane (new mode; single-shot stays default)

> Concrete wiring design (anchors, per-workstream changes, data flow, flag/rollback, open decisions): [`phase-2-wiring.md`](./phase-2-wiring.md). Tracked in epic #1543.

- [ ] **Tier→model mapping** in the runner: `low-cost` → concrete Sonnet-5 id for sub-agents; finalizer keeps parent.
- [ ] Add **`Task`/Agent tool** to allowedTools for a NEW fanout mode (distinct from `single-shot`; leave the default path untouched).
- [ ] **Expose the roster** — make the mounted `~/.claude/agents/` discoverable to the session (or `--agents` / bake).
- [ ] **Stop stripping** `A2A_CONTAINED_SUBAGENTS_*` for claude-code (allowlist) or pass the budget via a dedicated channel.
- [ ] **Inject the spawn-instructing prompt** for the claude-code script (adapt `buildContainedSubagentPrompt`, currently OpenClaw/Hermes-only).
- [ ] **Raise `--max-turns`** for the fanout mode (single-shot's 6 is insufficient to orchestrate).

### Phase 3 — Rollout (staged, evidence-backed, reversible)
- [ ] **Shadow / dry-run** on a canary lane; compare evidence quality, cost, latency, determinism (re-run diff), verifier-reject rate — do not use fanout output for terminal decisions yet.
- [ ] **Canary** on one worker/lane for a bounded task class (large / independent / low-coupling) with the cost counter enforcing a hard ceiling.
- [ ] **Observability** — sub-agent count, token cost/task, wall-clock, rework/verifier-reject rate, redaction violations, determinism diff.
- [ ] **Expand** by task class; keep the 0-subagent Escape Hatch always valid.
- [ ] **Rollback** — a single flag forces `single-shot` (the current default).

## Go / no-go gate (all must hold before Phase-3 canary)

#1532/#1534/#1535 merged (done) · cost counter live with a hard ceiling · redaction gate enforced · runtime spawn gate wired · Sonnet-5 tier mapping done · single-shot remains default · rollback flag present.

## Success criteria

- [ ] Container `claude-code` worker can spawn the roster adaptively (0–3, cap 4) in a distinct fanout mode, with single-shot still the default.
- [ ] Sub-agents run at Sonnet-5 grade via runner tier mapping; finalizer stays on the parent model.
- [ ] Every invariant above holds and is enforced by code (not only prompt): single-finalizer, disjoint write-sets, redaction/byte-bounds, host-pressure shrink.
- [ ] A hard cost ceiling is enforced; exceeding it blocks further spawns.
- [ ] Evidence bundles are reproducible/replayable (execution graph recorded; deterministic assembly).
- [ ] One-flag rollback to single-shot is verified.

## References

- Decision: #1531 (option B documented in the policy's *Execution lanes* section; option A direction in the issue comment).
- Policy: `packages/broker/docs/worker-subagent-orchestration-policy.md`.
- Roster: `docs/specs/cc-worker-subagent-roster/spec.md`.
- Conductor contract: `packages/docker-runner/docs/contained-subagent-conductor.md`.
- Phase-0: #1532, #1534, #1535.
