# Plan: Shared-State and HA Contract

> **Status:** proposed staged plan; documentation only. Every source/runtime
> phase after Phase 0 requires a separately reviewed change. Every live action
> requires explicit operator authorization. Refs #1504.

## Phase 0 — Spec packet (this phase)

- Add `spec.md`, `clarify.md`, `analyze.md`, `plan.md`, `tasks.md`, and
  `checklist.md`.
- Link the contract from the directly affected public limitation and broker
  durability documents.
- Run documentation/link/readiness, external-secret, and diff checks.
- Do not add runtime code, tests, schema, migrations, deployment config, or
  generated evidence.

Exit gate: packet is reviewable. Merge or local check success is not packet
approval and does not authorize Phase 1.

## Phase 1 — Versioned contract types and deterministic harness

- Add exact V1 types/schemas, enum reason codes, fake clock, deterministic
  scheduler/barrier, and backend-neutral conformance harness.
- Add an in-memory model used only as an oracle, not a supported runtime
  adapter.
- Pin idempotency namespaces, outbox stream taxonomy, time tolerance, and
  secret-safe health schema.
- Keep every runtime call site detached and default behavior unchanged.

Exit gate: source-only contract fixtures and negative parsing tests pass.

## Phase 2 — SQLite single-writer adapter, local only

- Implement V1 against a temporary SQLite database with one exclusive owner.
- Use one transaction for each specified atomic boundary.
- Persist clock floor, topology/fencing epoch, lease fences, replay/rate state,
  idempotency outcomes, outbox sequences/ACKs, and projection checkpoints.
- Reuse the optional FIFO worker writer only after direct-mode conformance;
  reads remain bounded and consistency-declared.
- Run the full deterministic concurrent/failure suite locally.

Exit gate: both inline and worker-writer SQLite modes pass the same V1 suite.
No production schema or broker path is changed.

## Phase 3 — Startup/readiness guard, source-only integration

- Add the planned grade configuration and expected-process declaration.
- Add exclusive fenced ownership for single-process grades.
- Add `/readyz`, secret-safe `stateContract` health, lost-fence monitoring, and
  non-serving middleware.
- Default legacy deployments to `single-process` with
  `gradeDefaulted=true`.
- Make `shared-state-ha` fail startup because no approved shared adapter
  exists.

Exit gate: local child-process tests prove two singleton brokers cannot both
serve and lost ownership drains/fails readiness.

## Phase 4 — Broker primitive integration behind `off`

- Integrate one primitive at a time behind a default-`off` configuration:
  replay, rate limit, leases/claims, idempotency, outbox, then graph source and
  projection.
- Preserve existing current path as authority.
- Make adapter errors visible but non-authoritative in local shadow fixtures.
- Do not attach a production migration or enable flag by default.

Exit gate: legacy path and adapter path produce equivalent local decisions;
injected differences block promotion.

## Phase 5 — Local/offline migration rehearsal

- Export a copied local fixture from the legacy schema.
- Import into V1 storage all task/claim attempts, idempotency outcomes,
  retained outbox rows/ACK state, and graph source/checkpoint state.
- Replay a deterministic trace for replay/rate continuity when legacy state
  is available; where current volatile state cannot be exported, record the
  maximum safety window and require a non-serving drain across that window.
- Compare canonical redacted digests and per-domain counts.
- Rehearse forward cutover, crash at every boundary, and rollback.

Exit gate: zero unexplained semantic divergence and a restorable pre-cutover
copy. This is still local and source-only.

## Phase 6 — Separately authorized SQLite live shadow

This phase is not authorized by this packet.

Preconditions:

- packet approval and Phases 1–5 merged with CI evidence;
- exact production revision/config/backend identified without publishing
  secrets;
- backup/restore rehearsal and rollback owner recorded;
- maintenance and maximum security-window plan approved;
- topology proves exactly one serving process; and
- no OpenClaw runtime/bootstrap context enters evidence.

Validation boundary:

- legacy storage remains the only source of truth;
- adapter shadow uses a separate namespace/schema and cannot drive
  authorization, claim, ACK, send, finalization, or response decisions;
- live read comparison returns legacy results only;
- security decision shadowing uses sanitized decision traces or a
  non-consuming shadow namespace so one request is never consumed twice;
- every mismatch is classified; semantic mismatch, lag past the bound, lost
  event, fence regression, or order regression blocks cutover.

Exit gate: an operator-approved evidence window completes with zero
unexplained divergence and bounded zero lag at quiescence.

## Phase 7 — Separately authorized SQLite cutover

Cutover gates:

1. exact commit and config are approved;
2. singleton ownership/readiness tests pass on the target environment;
3. backup and restore have fresh evidence;
4. shadow divergence is zero and replication/checkpoint lag is zero;
5. unexpired security state is imported, or serving is stopped for the maximum
   replay/rate window;
6. idempotency outcomes, active fences, outbox IDs/sequences/ACKs, and graph
   checkpoint compare exactly;
7. rollback representation compatibility is proven;
8. no unacknowledged provider effect is treated as ACK; and
9. an operator authorizes this one cutover, deploy/restart, and traffic action.

Cutover sequence:

1. stop admission and drain known writes;
2. record redacted high-water marks and take the approved backup;
3. apply the final delta transaction;
4. atomically select the V1 SQLite adapter as authority;
5. start exactly one fenced owner;
6. require `/readyz` and health continuity before restoring traffic; and
7. keep legacy storage read-only until the rollback window closes.

Any failed gate aborts without traffic restoration.

## Phase 8 — Future shared-backend candidate, source-only

- Select a backend only in a separate design decision.
- Map every V1 atomicity/consistency/expiry/fencing guarantee to a native
  primitive.
- Run the same conformance suite with a local emulator/test instance where
  possible and a deterministic partition wrapper.
- Keep `shared-state-ha` unavailable and runtime integration detached.

Exit gate: candidate conformance evidence only. It is not provisioning or HA
approval.

## Phase 9 — Future shared-backend shadow/dual-read

This future live phase requires separate authorization.

- Existing SQLite V1 remains canonical.
- Canonical transactions append a durable migration journal/outbox.
- A replicator applies events idempotently to the shared candidate.
- Dual reads compare results, but SQLite responses remain authoritative.
- Replay/rate shadow decisions use isolated namespaces or deterministic trace
  replay; they cannot weaken the live decision.
- Claim/lease shadow never grants ownership.
- Outbox shadow never sends, ACKs, or prunes.
- Graph shadow returns no finalization judgment.

Cutover is blocked by any unexplained mismatch, nonzero lag at quiescence,
clock/fence regression, idempotency conflict, order difference, incomplete
projection, or failed partition test.

## Phase 10 — Future `shared-state-ha` cutover

Required gates:

- candidate passed all V1 tests and independent review;
- at least two local/conformance processes prove cluster-wide semantics;
- startup refuses nonconforming/mixed adapter versions;
- partition, failover, restart, clock, and stale-fence evidence is green;
- migration journal is caught up and frozen high-water marks match;
- rollback invariants remain satisfiable;
- capacity/security/privacy review is approved; and
- exact provisioning, deployment, replica increase, traffic cutover, and
  rollback actions receive operator authorization.

Only then may `shared-state-ha` become a serviceable configured/effective
grade.

## Rollback plan

### Rollback triggers

- any semantic shadow mismatch;
- lost or duplicated domain/outbox effect;
- outbox order or ACK-state regression;
- idempotency outcome change;
- replay/rate security window reset outside the approved drain;
- lease fence decrease or dual authoritative claim;
- graph checkpoint advance without a complete batch;
- unsafe clock movement, adapter/version mismatch, partition ambiguity, or
  ownership conflict; or
- readiness becomes false after cutover.

### Rollback invariants

- Stop new admission before changing authority.
- Never run old and new authorities as concurrent primaries.
- Preserve unexpired replay records and rate-limit cost, or remain non-serving
  through the maximum outstanding window.
- Preserve every idempotency key/fingerprint/outcome.
- Preserve or monotonically increase every lease fencing token.
- Preserve stable outbox IDs, stream sequences, receipt/ACK state, and
  unacknowledged replayability. Rollback MUST NOT send, ACK, or prune.
- Preserve immutable claim-graph source facts and restore an exact complete
  projection checkpoint; do not hide a false projection by deleting source.
- Keep post-cutover writes in a forward journal until the old adapter can
  represent them.
- If any invariant cannot be met, remain stopped/not-ready on the new
  authority and escalate; data-losing rollback is forbidden.

### Rollback sequence

1. remove traffic and drain/fence the active writer;
2. resolve ambiguous idempotent writes and record redacted high-water marks;
3. verify the rollback target can represent all committed state;
4. apply the inverse migration/final delta transaction;
5. start exactly one owner on the prior authority;
6. verify fences, security windows, outbox/checkpoints, and readiness; and
7. restore traffic only under the rollback authorization.

## Exact separately authorized live actions

The following are separate, explicit actions. Approval of one does not approve
another:

- read or copy a production database for migration evidence;
- create or restore a production backup/snapshot;
- execute production DDL/schema migration or data backfill;
- enable a production shadow namespace, trace mirror, dual read, dual write,
  migration journal, or replicator;
- provision/configure credentials, network access, or capacity for any shared
  backend;
- change the production adapter, deployment grade, expected replica count,
  singleton ownership settings, or security continuity policy;
- deploy or restart a broker/Gateway/worker;
- pause, drain, resume, or cut over live traffic;
- add/remove/scale broker replicas or enable failover;
- execute rollback or copy post-cutover data back;
- replay, acknowledge, or prune any terminal-outbox/security/idempotency data;
- perform a live canary or provider send;
- change GitHub settings/rulesets/secrets or any other credential;
- publish a release/tag/package, force push, merge, or close the issue.

## Plan status

- [x] Phase 0 documentation drafted.
- [ ] Packet approved.
- [ ] Phases 1–5 runtime/source work implemented or tested.
- [ ] Any production shadow, migration, cutover, rollback, deploy, restart, or
  rollout authorized or complete.
- [ ] Future shared backend selected, implemented, provisioned, or promoted.
