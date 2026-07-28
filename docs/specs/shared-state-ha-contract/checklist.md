# Checklist: Shared-State and HA Contract

> **Status:** closeout checklist. Only documentation items completed in this
> phase are checked. Runtime implementation, conformance tests, migration, and
> operations remain open. Refs #1504.

## A. Spec packet

- [x] `spec.md` defines normative language and documentation-only scope.
- [x] `clarify.md` resolves topology, time, consistency, expiry, privacy, and
  approval questions.
- [x] `analyze.md` reconciles the contract with pinned current source.
- [x] `plan.md` defines staged source, migration, cutover, and rollback gates.
- [x] `tasks.md` contains deterministic implementation/test work.
- [x] This checklist separates completed docs from future work.
- [ ] Required spec-first packet approval is recorded.

## B. Deployment truth

- [x] `single-process` is defined as supported alpha.
- [x] `single-writer-durable` is defined as one process/logical SQLite writer,
  with current volatile replay/rate caveat.
- [x] `multi-process-unsupported` is non-serving.
- [x] `shared-state-ha` is future/unavailable.
- [x] SQLite/WAL/worker thread is not described as clustering.
- [x] No future backend is claimed, selected, or provisioned.

## C. Primitive contract coverage

For every row below, source of truth, atomicity, consistency, TTL/expiry,
restart, partition, fail-closed, observability, and adapter lifecycle are
specified in `spec.md`.

- [x] Nonce/replay.
- [x] Rate limit.
- [x] Lease/task claim with fencing.
- [x] Idempotency.
- [x] Terminal-outbox ordering/ACK.
- [x] Claim-graph source/read-model/checkpoint/rollback.

## D. Adapter contract

- [x] Contract identifier is `a2a.shared-state.storage/v1`.
- [x] Metadata, capability, lifecycle, transaction, query, health, drain, and
  close surfaces are defined.
- [x] Atomicity, per-key linearizability, expiry, fencing, idempotency,
  outbox, and projection capabilities are mandatory.
- [x] A later SQLite single-writer and later shared implementation can satisfy
  the same observable semantics.
- [x] Current generic SQLite store is not labeled conforming.
- [ ] Machine-readable V1 types/schemas implemented.
- [ ] SQLite V1 adapter implemented.
- [ ] Shared V1 adapter implemented.

## E. Startup/readiness/health

- [x] Exact configured/effective grade behavior is defined.
- [x] Declaration plus fenced ownership detects unsupported topology.
- [x] Startup fails before traffic where possible.
- [x] Lost ownership makes all non-liveness routes non-serving.
- [x] `/livez`, planned `/readyz`, and `/health` meanings are separated.
- [x] Replay/rate reset risk and continuity signals are specified.
- [x] Secret/identity-bearing health data is forbidden, including digests.
- [ ] Startup grade/ownership code implemented.
- [ ] `/readyz` and non-serving middleware implemented.
- [ ] Runtime health signal implemented and leak-tested.

## F. Deterministic local tests

- [x] Claim/lease concurrency and stale-fence plan exists.
- [x] Idempotency same/different fingerprint and ambiguous-commit plan exists.
- [x] Per-stream outbox order/restart/ACK plan exists.
- [x] Restart and backward-clock plan exists.
- [x] Partition/unavailable/lost-fence injection plan exists.
- [x] Exact expiry-boundary plan exists.
- [x] Claim-graph query/incomplete/false-merge rollback plan exists.
- [x] Migration/cutover/rollback rehearsal plan exists.
- [x] Bounded local performance-characterization plan exists.
- [ ] Test harness implemented.
- [ ] Claim tests implemented/passing.
- [ ] Idempotency tests implemented/passing.
- [ ] Outbox tests implemented/passing.
- [ ] Restart/partition/expiry tests implemented/passing.
- [ ] Claim-graph/rollback tests implemented/passing.
- [ ] Performance thresholds measured/approved.

## G. Migration/cutover

- [x] Preconditions and canonical-authority boundary are explicit.
- [x] Shadow/dual-read or deterministic equivalent cannot drive live
  decisions.
- [x] Cross-backend shadow uses a durable journal/outbox, not best-effort
  dual writes.
- [x] SQLite and future HA cutover gates are explicit.
- [x] Unexportable volatile security state requires a non-serving safety
  window.
- [x] Exact separate live actions are enumerated.
- [ ] Local/offline migration rehearsal completed.
- [ ] Production backup/read authorized.
- [ ] Production migration/shadow authorized.
- [ ] Cutover gates satisfied and authorized.
- [ ] Any migration or cutover executed.

## H. Rollback

- [x] Rollback triggers are explicit.
- [x] Security windows, idempotency outcomes, fences, outbox order/ACK, and
  graph source/checkpoint invariants are preserved.
- [x] Unrepresentable rollback fails closed instead of losing data.
- [x] Rollback sequence keeps one authority and restores traffic last.
- [ ] Local failure-injection rollback rehearsal completed.
- [ ] Production rollback authorized or executed.

## I. Public truth and safety

- [x] `docs/known-limitations.md` links the contract while retaining current
  limitations.
- [x] `packages/broker/docs/persistence-durability.md` links the contract and
  states that SQLite is not multi-process/HA.
- [x] References use `Refs #1504`, not an issue-closing keyword.
- [x] No production migration, backend provision, cutover, deploy/restart,
  replay/ACK/prune, provider send, GitHub mutation, release/tag, force push,
  merge, or issue close is authorized.
- [x] Documentation/link/public-readiness checks recorded after edits.
- [x] `npm run scan:external-secrets` recorded after edits.
- [x] `git diff --check` recorded after edits.
- [x] Pre-PR OpenClaw runtime/bootstrap path guard is clean.

## J. Overall status

- [x] Documentation/specification drafted.
- [ ] Spec-first packet approved.
- [ ] Runtime implementation complete.
- [ ] Adapter conformance tests complete.
- [ ] Migration complete.
- [ ] Operational rollout complete.
- [ ] `shared-state-ha` supported.
