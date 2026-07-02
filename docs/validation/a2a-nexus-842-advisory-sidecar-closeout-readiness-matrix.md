# A2A Nexus #842 advisory sidecar closeout readiness matrix

analysisStatus: complete-source-only
Issue: #842 — Define advisory sidecar umbrella closeout readiness matrix
Parent umbrella: #764 — Add optional broker advisory AI/Hermes sidecar without replacing A2A finalizers
A2A cleanup parent: #840
A2A round: `a2a-open-issues-20260617T231814Z-840`

## Purpose

This packet is the source-only/no-live closeout decision surface for the #764 advisory sidecar umbrella. It converts the remaining operator-facing ambiguity into an explicit GO/NO-GO matrix, without starting a sidecar, changing routing, sending providers, mutating state, or approving live execution.

The matrix is intentionally conservative: it can make #842 closeable after this PR merges, but #764 remains open until a future operator approval explicitly chooses whether to activate, reject, or defer any advisory-sidecar live path.

## Evidence inputs

| Input | Status | Notes |
|---|---|---|
| #831 boundary cross-check | `MERGED` / source evidence available | Confirms advisory metadata remains non-operational and routing influence is not permitted. |
| #840 A2A cleanup round | `CLOSED` | workerAlpha + workerGamma both classified #764 as not closeable without a matrix/decision surface. |
| #842 child issue | `OPEN` before this PR | This child exists to record the exact closeout/readiness decision surface. |

## Closeout readiness matrix

| Gate | Current state | Closeout meaning | Required before #764 closure or live action |
|---|---|---|---|
| technical source readiness | `GO_CANDIDATE` | Source has enough advisory-only contracts and regression evidence to present a decision surface. | Keep source tests green; do not reinterpret advisory metadata as runtime action. |
| approval boundary | `NO-GO / Waiting` | No operator approval has been granted by this matrix. | Separate approval must name the action, owner, rollback, target SHA, and evidence. |
| live sidecar execution | `NO-GO / Forbidden here` | This matrix must not start, supervise, or configure a sidecar process. | Future operator approval plus dedicated executor gate. |
| provider and hermes sends | `NO-GO / Forbidden here` | This matrix must not send provider/Hermes messages or canaries. | Separate approval and provider-send evidence packet. |
| routing influence | `NO-GO / Forbidden here` | This matrix must not change routing, dispatch selection, or worker assignment. | Separate routing influence gate; advisory metadata must remain non-operational. |
| broker state and database mutation | `NO-GO / Forbidden here` | This matrix must not mutate broker state, database rows, DB rows, replay queues, or historical records. | Separate DB/replay approval and rollback plan. |
| deploy restart release and secrets | `NO-GO / Forbidden here` | This matrix must not deploy, restart, tag, release, rotate, copy, or reveal secrets. | Separate deploy/restart/release/secret approval. |
| terminal brief ack and replay | `NO-GO / Forbidden here` | This matrix must not ACK terminal rows, replay outbox, or emit operator notifications. | Separate Terminal Brief ACK/replay approval and idempotency evidence. |
| rollback and owner | `WAITING` | Rollback owner for future live action is not assigned by this matrix. | Future approval must name rollback owner and exact rollback command/evidence. |

## Finalizer decision for #842

#842 is closeable after this PR merges because the child scope is limited to defining the matrix above and proving it with a source-only test. #764 remains open as the umbrella for any future operator approval, live activation, rejection, or deferral decision.

## Required next action after #842 closes

1. Leave #764 open.
2. If the operator wants advisory sidecar live activation, open a fresh approval issue/PR that names:
   - requested live action,
   - target SHA,
   - owner and rollback owner,
   - exact deploy/restart/release/provider-send/DB/replay/ACK scope,
   - safety evidence and rollback evidence.
3. If the operator wants to reject or defer the sidecar path, record that as a separate #764 finalizer decision.

## Non-actions

This packet does not authorize and did not perform any of the following:

- start, configure, supervise, or restart an advisory sidecar;
- send provider/Hermes traffic, canaries, Telegram notifications, or Terminal Brief ACKs;
- change routing, worker assignment, dispatch selection, or finalizer authority;
- mutate broker state, database rows, replay queues, audit rows, or terminal outbox records;
- deploy, restart, release, tag, rotate/copy/reveal secrets, or perform crossBroker actions.
