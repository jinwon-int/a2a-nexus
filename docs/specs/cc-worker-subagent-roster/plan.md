# Implementation Plan: Claude Code worker sub-agent roster

## Linked spec

- Spec: `docs/specs/cc-worker-subagent-roster/spec.md`
- Issue: #955

## Size classification

- [ ] Small
- [x] Medium
- [ ] Large

Reason: Adds a normative role→agent mapping plus worker-side reference definitions. No broker dispatch, runtime, secret, or deploy changes; doc + worker-harness config only.

## Affected repos/components

- `a2a-plane`: none.
- `a2a-broker`: `packages/broker/docs/worker-subagent-orchestration-policy.md` — optional additive cross-reference to the roster (Roles section).
- `a2a-docker-runner`: none (conductor cap/roles already defined; roster reuses them).
- `openclaw-plugin-a2a`: none.
- worker/node config: the CC worker harness ships `a2a-explorer` / `a2a-implementer` / `a2a-verifier` agent definitions (out of this repo).
- Wiki/runbooks: node CC page records the roster + adaptive-selection procedure.
- other: `docs/specs/cc-worker-subagent-roster/` (this spec/plan).

## Broker / worker / finalizer roles

- Broker of record / finalizer: the claiming CC worker is the single finalizer/conductor; it owns terminal evidence/PR.
- Workers: any CC-harness A2A worker (reference node: a Team1 worker).
- Libero/validator: the `a2a-verifier` roster agent (evidence-only).
- Human approval owner: `@jinon86` (CODEOWNERS) for the spec PR; no approval-sensitive runtime actions.

## Execution lane

- [ ] Direct small change
- [x] Isolated subagent
- [ ] Broker-owned TaskFlow
- [ ] TaskFlow + A2A evidence workers
- [ ] Other:

Why this lane is safe: doc/spec authorship plus worker-harness config. The roster only governs in-worker decomposition after a task is claimed; it cannot deploy, restart, move secrets, or change broker dispatch. Fanout stays bounded by the existing hard cap 4 and host-pressure-only shrink.

## Data/control flow

1. Worker claims a task and reads `task.payload.subagentProfile` (or derives size/coupling).
2. Worker consults the adaptive budget table (0 / 1 / 2 / 3, hard cap 4) and host capacity; host pressure only lowers the budget.
3. Worker spawns from the roster: at most one `a2a-explorer`, up to two `a2a-implementer` lanes with **disjoint write sets**, one `a2a-verifier`.
4. Sub-agents return bounded, redacted, evidence-only output. The worker (finalizer) composes the single terminal evidence packet / PR.
5. No cross-broker, Terminal Brief, or approval boundary is crossed by the roster itself.

## Tests and validation

- Unit tests: none (doc-only).
- Contract/conformance tests: existing per-spec conformance tests are unaffected (they target their own dirs).
- Build/lint/typecheck: n/a for docs.
- Dry-run/doctor checks: `npm run scan:public-readiness`, `npm run scan:external-secrets` must stay clean.
- CI checks: repo CI on the PR.
- Live canary, if separately approved: none.

## Rollout plan

- Source PR order: (1) this spec PR in a2a-nexus; (2) separately, the worker-harness PR that adds the three `.claude/agents/*.md` definitions.
- Merge/rehearsal order: spec merged first (direction agreed), then the harness definitions reference it.
- Deployment gate, if separately approved: none.
- Communication/Terminal Brief expectations: none beyond normal PR review.

## Rollback plan

- Revert path: revert the spec PR; revert the worker-harness PR independently.
- Config rollback: remove the agent definitions from the worker harness (they are additive; absence falls back to ad-hoc decomposition).
- State cleanup: none at runtime.
- Approval required before cleanup: none.

## Closeout evidence

- Finalizer decision: recorded on the PR by the claiming worker.
- Evidence links: spec PR, issue #955, worker-harness PR.
- Tests/checks: public-readiness + external-secrets scans clean.
- Approval-sensitive actions not performed: deploy, restart, canary, DB, ACK, release, secret movement, force push — none performed.
- Wiki/runbook update: node CC page records the roster and selection procedure.
