# Feature Spec: reuse the fanout decider stack on the piri patch lane

Parent: #1798 (alternative path), #1601. Status: **Phase 2 in progress (2026-08-15) — WS1 (mirrored opt-in flag) and WS2 (hardened executor extension, baked into the piri runner image) implemented code+tests; wiring design in [`phase-2-wiring.md`](phase-2-wiring.md) (Phase 1: [`phase-1-mapping.md`](phase-1-mapping.md); Phase 0: [`phase-0-findings.md`](phase-0-findings.md)); WS3–WS5 remain spec-only; implementation stays default-off and gated, Phase 3 canary needs operator approval per step.**

## Problem

The #1798 field verification (2026-08-15) concluded that the claude-code fanout lane is structurally unreachable: the fleet standardized `PATCH_COMMAND_PROFILE=piri` (#1802) and the claude lane is dormant with credentials removed. Meanwhile the entire Phase-1 fanout asset stack — budget counter, spawn-gate decision, context brief, redaction gate, deterministic evidence assembly — is **broker-side and harness-agnostic by design** (`phase-2-wiring.md`: "the deciders are broker-side TypeScript; the container runs the bridge executor"). Those deciders currently have exactly one consumer: a lane nothing can reach.

The piri lane is the only live, fleet-standard patch lane (4/4 nodes, #1802). If fanout-style multi-agent delegation has value, the cheapest credible path is to reuse the broker-side decider stack on the piri lane — not to revive the claude lane against an operator-standardized decision.

What is missing is the piri-side executor mechanism (the Claude Code `Task`-tool + roster equivalent) and an honest assessment of whether piri's runtime can express it.

## User / operator stories

- As an operator, I want the broker-side fanout deciders to have a live consumer so their tests and contracts track reality instead of dead code.
- As a fleet maintainer, I want fanout on the lane the fleet actually runs (piri), rather than reopening the claude lane decision.
- As a reviewer, I want the piri-side mechanism investigation to precede any wiring spec, so we do not assume a Claude-Code-shaped mechanism exists in a different harness.

## Scope

### In scope

- **Phase 0 — capability investigation (read-only).** Determine what delegation/sub-agent mechanism the deployed piri runner actually exposes: does the piri CLI support spawned sub-agents, parallel tool/task delegation, or a skills/extensions mechanism that can be driven deterministically from a patch prompt? Evidence: piri docs, runner image inspection, and a no-live probe. Fail-closed: if no mechanism exists, this spec stops at the conclusion.
- **Phase 1 — decider reuse mapping.** Map each Phase-1 decider (budget counter, spawn gate, context brief, redaction gate, evidence assembly) to the piri lane path with the claude-specific bits named explicitly (roster frontmatter, `Task` tool allowlist, `A2A_CONTAINED_SUBAGENTS_*` env passthrough) and their piri equivalents or gaps.
- **Phase 2 — wiring spec** (only if Phase 0 finds a mechanism): opt-in flag mirroring `A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED`, default off; single-flag rollback; budget ceilings identical to the existing stack (0–3 + hard cap 4; output byte bounds 1KB–60KB).
- **Phase 3 — shadow/canary plan** consistent with the #1798 decision packet (shadow → canary → widen, operator approval per step).

### Out of scope

- Reopening the claude-code lane decision (#1798 keeps its NO-GO until an operator says otherwise).
- Changing any decider semantics; this spec reuses them as-is.
- Turning fanout on by default anywhere.
- Production deploy/restart/canary/live spawn unless explicitly approved (a live spawn crosses the source-only boundary).
- DB mutation/prune/migration/replay; secret movement (the piri lane credential contract stays as-is).

## Success criteria

- [x] Phase 0 conclusion recorded with evidence: either "no delegation mechanism exists in the deployed piri runtime; fanout reuse is not viable" (spec closes) or a named mechanism with a concrete invocation example. — **Recorded 2026-08-15 in [`phase-0-findings.md`](phase-0-findings.md): the mechanism exists** (official `subagent` example extension; `piri -e <ext> -t subagent,... -p` invocation shape; roster md with `model:` frontmatter as the WS2 equivalent), unwired in the deployed image.
- [x] If viable: decider-reuse mapping table names every claude-specific mechanism and its piri equivalent or explicit gap — no hand-waving. — **Done 2026-08-15: [`phase-1-mapping.md`](phase-1-mapping.md) §1 maps all seven deciders; §2 names all twelve claude-specific couplings with anchors; §4 carries the five named gaps.**
- [x] Any proposed wiring keeps fanout default-off with single-flag rollback and identical budget/output ceilings. — **Checked 2026-08-15 with [`phase-2-wiring.md`](phase-2-wiring.md): mirrored flag default 0 with byte-for-byte rollback to the plain `piri -p` script; ceilings reused verbatim (0–3 + hard cap 4, 1KB–60KB output clamp, ≤64KB brief, example-constant clamp-down).**
- [x] The broker-side decider tests keep passing unchanged (reuse, not fork). — **Verified 2026-08-15 at `1d97ed1`: attestation decider suites 39/39, broker core subagent suites 28/28, `worker.test.ts` 51/51 — all green, zero modifications.**
- [x] The spec records which existing tests/fixtures would need a piri-lane variant and which are lane-agnostic already. — **Done 2026-08-15: mapping §5 inventories both classes (lane-agnostic reuse oracle vs additive piri variants).**

## Safety and approval boundaries

### Secrets and private data

- The piri lane credential contract is out of scope; no credential files are named, moved, or logged. Sub-agent output redaction stays mandatory and byte-bounded (redaction gate is reused, not reimplemented).

### Human approval required for

- [ ] production deploy
- [ ] Gateway/broker/worker/service restart
- [ ] live canary/provider send
- [ ] live sub-agent spawn (crosses source-only boundary)
- [ ] DB mutation/prune/migration/replay
- [ ] manual Terminal Brief ACK/replay
- [ ] release/tag
- [ ] secret rotation/movement
- [ ] force push/history rewrite
- [x] none of the above — Phases 0–2 are documentation and read-only inspection only.

### Broker foreground liveness

- No operator-session impact. Investigation is detached (docs, image inspection, no-live probes).

## Verification design

- Phase 0 oracle: piri official documentation + deployed runner image inspection + at most one no-live probe (e.g. `--help` output), recorded verbatim in the spec. Independent of the implementation lane because it precedes it.
- Decider-reuse oracle: the existing `worker-subagent-*` test suites pass unchanged; any piri-lane variant tests are additive, not replacements.
