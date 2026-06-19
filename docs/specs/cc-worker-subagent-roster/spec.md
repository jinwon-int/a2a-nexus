# Feature Spec: Claude Code worker sub-agent roster

## Problem

The worker sub-agent model is fully specified as policy — `packages/broker/docs/worker-subagent-orchestration-policy.md` defines the roles (`explorer`, `implementer`, `verifier`) plus the single-finalizer rule and the adaptive 0–3 budget, and `packages/docker-runner/docs/contained-subagent-conductor.md` defines the conductor contract (hard cap 4, disjoint write sets, host-pressure-only shrink).

But a Claude Code (CC) based worker has no concrete, named sub-agent **definitions** to actually spawn. The role prompts, tool scoping, and selection rules live only in prose, so each CC worker improvises its decomposition. That risks drift from the Finalizer Rule, the Write-Set Rule, and the redaction / evidence-only output contract — exactly the invariants the policy exists to protect.

This spec defines a small, normative **roster**: a stable mapping from the policy roles to spawnable CC sub-agent definitions, so a CC worker selects and spawns policy-conformant sub-agents adaptively when it claims a task.

## User / operator stories

- As an operator, I want every CC worker to decompose work the same policy-conformant way, so evidence and review stay predictable across nodes.
- As a broker/finalizer, I want sub-agents to remain evidence-only with one finalizer owning the terminal result, regardless of which node ran them.
- As a worker, I want a ready roster (explorer/implementer/verifier) with correct tool scoping so I spawn the right help for the task size without re-deriving the rules each time.
- As a maintainer, I want the roster expressed against the existing policy vocabulary, not a parallel scheme, so there is one source of truth.

## Scope

### In scope

- A normative role→agent mapping documenting how the policy's `explorer` / `implementer` / `verifier` roles are realized as CC sub-agent definitions (role intent, tool scope, output contract).
- Selection guidance that reuses the existing adaptive budget table (0 / 1 / 2 / 3, hard cap 4) and the Escape Hatch.
- The invariants each roster agent must carry: Finalizer Rule, Write-Set Rule, redaction, bounded evidence-only output, host-pressure-only shrink.
- A reference example: budget table → roster selection for a small / medium / large task with redacted sample output.

### Out of scope

- Production deploy/restart/canary unless explicitly approved.
- DB mutation/prune/migration/replay unless explicitly approved.
- Manual Terminal Brief ACK/replay unless explicitly approved.
- Secret movement/output unless explicitly approved.
- Broker dispatch/admission changes; forcing sub-agent spawning (`mandatoryProductionSpawn` stays false).
- Docker-contained fanout defaults (stay off / opt-in).
- Shipping the concrete agent-definition files into this repo's runtime path — they live in the worker's CC harness; this repo carries only the normative mapping.

## Success criteria

- [ ] The mapping names exactly the three policy roles plus the worker-as-finalizer, with no new role vocabulary.
- [ ] Each roster agent's tool scope matches its role: explorer = read-only; implementer = read + write within a declared disjoint write set + build/test; verifier = read + run tests/CI, no write.
- [ ] Selection guidance references the existing 0–3 budget table and hard cap 4 verbatim, and states the Escape Hatch (0 is always valid).
- [ ] The doc restates Finalizer Rule and Write-Set Rule and the redaction / evidence-only / bounded-output contract.
- [ ] `npm run scan:public-readiness` and `npm run scan:external-secrets` stay clean for the added files.

## Safety and approval boundaries

### Secrets and private data

- Nearby classes: provider/Telegram IDs, host names/paths, OpenClaw runtime/bootstrap files, session dumps, credentials.
- Avoidance: the roster doc and example use only coarse, public-safe role labels and redacted (`<redacted>`) sample output. No node identities, endpoints, or secrets are committed. Sub-agent output is described as redaction-mandatory and byte-bounded.

### Human approval required for

- [ ] production deploy
- [ ] Gateway/broker/worker/service restart
- [ ] live canary/provider send
- [ ] DB mutation/prune/migration/replay
- [ ] manual Terminal Brief ACK/replay
- [ ] release/tag
- [ ] secret rotation/movement
- [ ] force push/history rewrite
- [x] none of the above

### Broker foreground liveness

- No broker foreground impact: this is a doc/spec change. At runtime the roster only governs how a worker that has already claimed a task decomposes it internally; the policy's host-pressure-only-shrink rule keeps fanout bounded and the hard cap is 4.

## Evidence contract

Each worker/finalizer must produce the relevant evidence packet:

- affected repos/files: `docs/specs/cc-worker-subagent-roster/spec.md`, `plan.md`; reference roster definitions live in the worker CC harness (out of this repo);
- PR/issue links: this spec PR and issue #955;
- tests/build/lint/checks run: `npm run scan:public-readiness`, `npm run scan:external-secrets` (doc-only; no runtime tests applicable);
- CI status and mergeability when relevant;
- risk notes: doc-only, no runtime behavior change;
- rollback/failure notes: revert the doc PR;
- final recommendation or blocker.

## Rollback / failure handling

- Failure indicator: scans flag a finding, or reviewers reject the mapping as diverging from the policy vocabulary.
- State to restore: none at runtime (doc-only); revert the PR to remove the spec dir.
- Safe cleanup without approval: delete `docs/specs/cc-worker-subagent-roster/` via a follow-up PR.
- Cleanup requiring fresh approval: none.

## Wiki/runbook follow-up

- Yes — reusable operating knowledge. Record the roster mapping and the worker's adaptive-selection procedure in the worker CC harness docs and the Family Wiki node CC page, cross-linking this spec and the policy/conductor sources.
