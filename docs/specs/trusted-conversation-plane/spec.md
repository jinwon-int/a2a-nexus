# Feature Spec: Trusted Conversation Plane — `a2a.conversation-envelope.v1` contract (C1)

Parent: #1814 (P1 epic). Status: **Frozen (2026-08-17, independently reviewed and merged as #1861).** This document is the C1 deliverable of the #1814 spec-first track: the envelope contract, state machine, ownership rules, idempotency semantics, budget enforcement points, exchange/context compatibility, and the threat model. It intentionally contains **no runtime changes**. The child tracks are split as #1862 (C2), #1863 (C3), #1864 (C4), #1865 (C5), #1866 (C6); changes to frozen field/state/ownership semantics now require a v1→v2 plan (same discipline as the handoff v0 freeze).

## Problem

The broker already stores conversations — `startBrokerExchange`/`addBrokerExchangeMessage` persist a root message plus a thread with parent linkage, actor authorization (`assertExchangeMessageActor`), and an audit event per message — and A2A 1.0 `SendMessage` already projects `contextId`/`exchangeId` continuation with `input-required` resume (`packages/broker/src/a2a/json-rpc.ts`). What does not exist is a **trustable conversation primitive** that the three logical paths of #1814 (Broker↔Worker, Worker↔Worker, Broker↔Broker) share:

- `maxTurns` is stored on the exchange (`broker-exchange.ts`, default 8) but never enforced as a turn/cost limit.
- Exchange messages have no envelope-level idempotency key, no delivery state, and no per-conversation sequence authority — restart-safe ordering is only implicit in storage order.
- Worker runtime has no standard inbox-subscribe/consume/reply loop; task results are not projected as conversation replies.
- Cross-broker messaging is task-handoff and terminal-evidence centric (`contracts/a2a/broker-handoff-protocol.md` v0 freeze; the Terminal Brief relay in `cross-broker-terminal-brief-receiver.ts`). There is no bounded multi-turn message relay, shared sequence, delivery receipt, branching, or resync contract.
- Without a frozen envelope contract, each of C2–C6 would improvise its own semantics and the plane would not converge.

C1 therefore freezes the **envelope and its invariants** before any loop, relay, or bridge code exists.

## User / operator stories

- As a broker maintainer, I want one frozen envelope so worker inboxes (C2), task↔conversation bridging (C3), and cross-broker relay (C4/C5) cannot drift apart.
- As a reviewer, I want idempotency, ordering, ownership, and termination rules stated normatively so each child track has a pass/fail oracle.
- As an operator, I want turn/TTL/byte/fanout budgets defined at the contract level so no child track can ship an unbounded conversation loop.
- As a security reviewer, I want the threat model attached to the contract itself, so mitigations are checkable per child track rather than retrofitted.

## Scope

### In scope (C1 only)

- The `a2a.conversation-envelope.v1` field contract with normative rules (identifier minting, sequencing, parent/thread, identity, bounds).
- The delivery state machine (`accepted → persisted → delivered → processed`, terminals `expired|refused|failed`) and what each transition proves — and explicitly does **not** prove.
- Ownership: `homeBrokerId` as the single durable sequence authority; per-actor read/write authorization.
- Idempotency and replay convergence rules.
- Budget enforcement points (`maxTurns`, TTL, message/conversation bytes, fanout, rate/cost) and where each is checked.
- Signature/receipt semantics: worker signature, broker acceptance receipt/countersign.
- Compatibility and migration mapping against `exchange/context`, A2A 1.0 `SendMessage`, the handoff peer scopes, and the Terminal Brief relay cursor/idempotency semantics.
- The threat model with per-threat mitigations and the child track responsible for each.
- The C2–C6 child-track entry/exit criteria.

### Out of scope

- Any runtime implementation (that is C2+ work).
- Chat UI, personas, long-term memory, human messenger delivery.
- Worker-to-worker direct sockets or credential sharing.
- Full broker DB replication.
- Production deploy, peer credential provisioning/rotation, service restart, or live canary.
- Treating provider-send success or polling exposure as `processed`.

## The envelope contract v1

### Envelope

```json
{
  "schemaVersion": "a2a.conversation-envelope.v1",
  "conversationId": "conv-...",
  "messageId": "msg-...",
  "parentMessageId": "msg-...",
  "sequence": 12,
  "kind": "question|reply|clarification|challenge|proposal|decision|ack|control",
  "sender": { "kind": "worker|broker|operator", "id": "...", "homeBrokerId": "..." },
  "recipients": [{ "kind": "worker|broker", "id": "...", "homeBrokerId": "..." }],
  "taskId": "optional-task-id",
  "referenceTaskIds": [],
  "idempotencyKey": "...",
  "createdAt": "...",
  "expiresAt": "...",
  "content": { "text": "bounded text or artifact reference" },
  "contentDigest": "sha256:...",
  "hopTrace": [],
  "provenance": {}
}
```

### Field rules (normative)

| Field | Rule |
| --- | --- |
| `schemaVersion` | MUST be exactly `a2a.conversation-envelope.v1`. Unknown major versions MUST be refused before any state change. |
| `conversationId` | Minted exactly once by the conversation's home broker. Non-empty, stable across restarts, immutable for the conversation's lifetime. |
| `messageId` | Minted by the sender, unique within the conversation. `(conversationId, messageId)` is the storage key; collisions MUST fail closed as a conflict. |
| `parentMessageId` | MUST reference an existing message in the same conversation. Absent only on the root. Threads/branches are parent links — not separate conversations. |
| `sequence` | Assigned by the home broker at accept time (monotonic, gap-free per conversation). Senders MUST NOT self-assign; a client-supplied `sequence` is advisory only and MUST be overwritten or refused. Restart MUST preserve already-assigned sequences. |
| `kind` | Closed enum. `control` is the only kind allowed to change conversation-level state (e.g. suspend/resume/close); content of `control` is broker-validated, never free-form execution. |
| `sender` | `.kind` ∈ {worker, broker, operator}; `.id` is the worker/broker/operator id; `.homeBrokerId` MUST be the broker that owns that actor's lifecycle. A worker actor is only valid if the home broker currently has that worker registered — no cross-registration. |
| `recipients` | Non-empty. Each recipient carries its own `homeBrokerId`. For cross-broker recipients, `homeBrokerId` ≠ the sending broker identifies a relay requirement (C4). Recipients whose `homeBrokerId` is unknown/untrusted MUST be refused, not silently dropped. |
| `taskId` / `referenceTaskIds` | MUST reference tasks the home broker (or the relayed-to broker) knows. `taskId` presence is what distinguishes a task turn from a pure message turn — mixing them silently is forbidden. |
| `idempotencyKey` | Client-minted, unique per logical send. See idempotency rules below. |
| `createdAt` | Sender clock, ISO-8601. Advisory for ordering (sequence is authoritative); used for freshness windows. |
| `expiresAt` | Optional TTL bound. Once passed, the message may no longer transition to `delivered`/`processed`; it terminates as `expired`. |
| `content` | Bounded text or an artifact reference (digest + broker-known path). Raw session dumps, private host paths, and credentials are rejected by the redaction/size gate before persistence. |
| `contentDigest` | `sha256:` hex digest computed by the home broker over the canonical content at accept time; a sender-supplied digest that mismatches is refused. |
| `hopTrace` | Append-only relay record (`{ brokerId, at, action }` entries). Cross-broker hops only (C4). A broker MUST append its hop before relaying; cycles in `hopTrace` terminate the relay as `failed`. |
| `provenance` | Bounded metadata (schema version of the producing surface, request id). MUST NOT carry message bodies or secrets. |

### Delivery state machine

```text
                 ┌──────────┐
   submit ─────▶ │ accepted │  envelope validated; ownership+policy ok; sequence assigned
                 └────┬─────┘
                      ▼
                 ┌──────────┐
                 │persisted │  durable inbox/outbox record exists (restart-safe)
                 └────┬─────┘
                      ▼
                 ┌──────────┐
   target inbox ─▶│delivered │  exposed to the target actor's inbox
                 └────┬─────┘
                      ▼
                 ┌──────────┐
   target posted ─▶│processed│  actor consumed it and linked a reply/result
                 └──────────┘

   terminals: expired | refused | failed
```

- `accepted` — the receiving broker validated the envelope, actor authorization, budgets, and assigned the sequence. It proves **acceptance**, not visibility.
- `persisted` — the durable record exists. After a broker restart, envelopes MUST NOT regress below their last persisted state.
- `delivered` — the target's inbox exposes the message. Polling exposure is exactly `delivered` — never `processed`.
- `processed` — the target actor consumed the message and produced a linked artifact (reply message, task result, or explicit `ack`). Provider-send success is NOT `processed`.
- `expired` — TTL passed before `processed`; cleanup may drop the body but MUST keep the digest+status for audit.
- `refused` — policy/authorization/redaction rejection at accept time (no sequence is consumed for refused envelopes... see Idempotency for the replay rule).
- `failed` — retry budget exhausted, relay failure, cycle detection, or revoked peer. Terminal; requires a NEW message (new `messageId`/`idempotencyKey`) to retry — reusing the key is a replay and converges to the recorded terminal.

Transitions are forward-only. A message that reached `persisted` can move to `expired|failed` but never back to `accepted`.

### Ownership and authorization

1. Exactly one `homeBrokerId` per conversation: it owns the sequence authority, the durable thread, and the terminal decision for the conversation's lifecycle. This mirrors the handoff contract's `brokerOfRecord` invariant (destination-owns-task); here the **home** broker owns the conversation even when a task is later executed elsewhere.
2. Read access: the sender, the recipients, and the home broker (plus privileged operator audit projections). A third worker that is not requester/target/assigned is refused read AND write — extending `assertExchangeMessageActor`'s requester/target/hub/operator rule to the envelope plane.
3. Write access: posting to a conversation requires being an existing participant (sender of a prior message in it, or a recipient of the latest turn), or an operator. Workers of another broker never post directly to a foreign conversation — their writes enter via the relay (C4/C5).
4. Workers are never cross-registered: `Worker A (broker-alpha)` appears to `broker-beta` only as `{ kind: "worker", id, homeBrokerId: "broker-alpha" }` inside an envelope, never as a locally-registered worker of broker-beta.

### Idempotency and replay

- `(homeBrokerId, idempotencyKey)` is the dedupe key.
- Same key + same `contentDigest` → **converge**: return the recorded message/terminal state; no new sequence, no duplicate delivery.
- Same key + different digest → **conflict**: refuse with a distinguishable error; never overwrite.
- Refused envelopes are recorded `(key, digest, refused)` so a client cannot launder a refusal by re-sending the same key with mutated content.
- Relay duplication (C4): at-least-once transport may redeliver an envelope; the receiving broker's idempotency table MUST collapse the redelivery before it reaches the target inbox — mirroring the Terminal Brief receiver's cursor/blocked semantics (`cross-broker-terminal-brief-receiver.ts`), but keyed on the conversation idempotency key rather than the outbox event id.
- Sender proofs for cross-broker submits follow the existing binding (`cross-broker-sender-proof.ts`): `{ brokerId, bodyHash, issuedAt, nonce }`, freshness-windowed, per-sender nonce replay cache. The envelope body hash MUST bind `conversationId`, `messageId`, `idempotencyKey`, and `contentDigest`.

### Budgets and enforcement points

| Budget | Default | Enforced at |
| --- | --- | --- |
| `maxTurns` per conversation | inherited from exchange default (8) unless set | accept time AND reply time — a message that would exceed the turn budget is refused; the conversation terminates `failed` with `control` close-out (the existing stored-but-unenforced `maxTurns` becomes live) |
| Message bytes (`content.text`) | bounded (aligned to existing message bounds) | accept time, before persistence |
| Conversation bytes (cumulative) | bounded, digest-only once exceeded | accept time |
| TTL (`expiresAt`) | optional, capped | accept time + lazily on every read/deliver attempt |
| Fanout (recipients per message) | small fixed bound | accept time |
| Rate / cost | per-sender windowed quota | accept time |

All refusals are explicit states, never silent drops. Cycle detection (A→B→A reply chains with no new content digest) terminates as `failed` — an automatic loop may never outlive its turn/TTL/cost budget.

### Signature and receipt semantics

- Worker-originated messages carry the worker's signature over the canonical envelope (C2 defines the signing key/source; the contract fixes that the signature binds `messageId`, `sequence`, `contentDigest`).
- Broker acceptance is a **broker receipt/countersign** over the accepted envelope (digest + sequence + state). Downstream consumers verify the countersign rather than re-trusting the sender.
- Audit log stores by default: actor ids, `conversationId`, `messageId`, `contentDigest`, state transitions, bounded summary. Bodies are NOT written to audit. This matches the existing per-message audit shape (`exchange.message.added`) with the digest replacing free-text notes.

## Compatibility and migration

- `exchange/context` stays as-is and remains the request-scoped surface. A conversation **wraps** an exchange: `conversationId` maps 1:1 to a new conversation whose root references `exchangeId` in `provenance`; no existing API changes, nothing breaks.
- A2A 1.0 `SendMessage`/`SendStreamingMessage` keep working unchanged. When a `contextId` continuation would enter a conversation-enabled lane, the envelope is an additive projection layer — the JSON-RPC response shape does not change.
- Handoff peer scopes are NOT reused: `handoff:create|status|evidence|comment` stay task-scoped. The relay track (C4) proposes separate minimal scopes `conversation:send`, `conversation:read`, `conversation:relay` — each fail-closed if absent, consistent with the v0 handoff freeze requiring a v0→v1 plan for scope changes.
- Terminal Brief relay semantics (cursor freeze on `blocked`, at-least-once with idempotent apply) are the reference model for relay retries; the conversation relay MUST NOT pin a lane cursor to an unrelated event (same lesson as the brief receiver's MUST-NOT-pin rule).

## Threat model (C1)

| # | Threat | Mitigation (normative) | Track |
| --- | --- | --- | --- |
| T1 | Spoofed sender (worker A impersonates worker B) | home-broker-issued identity + worker signature binding; recipients verify countersign | C2 |
| T2 | Replay of an accepted message | `(homeBrokerId, idempotencyKey)` dedupe; same-digest converges, different-digest conflicts | C2/C4 |
| T3 | Client-forged sequence | sequence assigned only by home broker; client value advisory-only | C2 |
| T4 | Prompt injection / secret/PII in content | redaction + size gate before `persisted`; digest-only audit | C2 |
| T5 | Infinite auto-reply loop | maxTurns/TTL/cost enforcement + cycle detection terminate `failed` | C2/C3 |
| T6 | Third-worker read/write | participant-only authorization (requester/target/assigned/operator) | C2 |
| T7 | Cross-broker trust abuse (peer relays as anyone) | sender proof binds `{brokerId, bodyHash, issuedAt, nonce}`; revoked peers fail closed; unknown recipient brokers refused | C4 |
| T8 | Relay duplication creates duplicate tasks/messages | idempotency collapse at receiving broker before inbox exposure | C4/C5 |
| T9 | Sequence gap / cursor loss after broker restart | durable sequence + cursor persistence; gap = fail-closed `blocked` until resync, never skip-ahead | C4 |
| T10 | Oversized payload / memory exhaustion | accept-time byte bounds on message and conversation totals | C2 |
| T11 | Metadata leak via audit | audit carries digest + bounded summary + actors only | C2–C5 |
| T12 | Wrong origin/destination relay | `homeBrokerId` mismatch refused; hopTrace cycle detection | C4/C5 |

Each child track MUST restate the threats it owns as tests before its implementation PR is reviewable.

## Success criteria (C1)

- [ ] Every envelope field has a normative rule with a pass/fail oracle (this table).
- [ ] The state machine's transitions and their non-proofs (polling ≠ processed; provider-send ≠ processed) are stated.
- [ ] Ownership: exactly one home broker with durable sequence authority; participant-only access; no worker cross-registration.
- [ ] Idempotency convergence/conflict rules are deterministic across restarts.
- [ ] Budgets (maxTurns, TTL, bytes, fanout, rate/cost) each have an enforcement point; no silent drops.
- [ ] Signature/receipt semantics bind the fields that matter and keep bodies out of audit.
- [ ] Compatibility: exchange/context and A2A 1.0 unchanged; handoff scopes untouched; relay scopes proposed separately.
- [ ] Every threat T1–T12 maps to a mitigation and an owning child track.
- [ ] C2–C6 entry/exit criteria are explicit enough to become child issues verbatim.

## Safety and approval boundaries

### Secrets and private data

- No credentials named, moved, or logged. Content gates (redaction/size) are contract requirements; their implementation arrives with C2.
- Audit surfaces are digest-first by contract.

### Human approval required for

- [ ] production deploy
- [ ] Gateway/broker/worker/service restart
- [ ] live canary/provider send
- [ ] DB mutation/prune/migration/replay
- [ ] manual Terminal Brief ACK/replay
- [ ] release/tag
- [ ] secret rotation/movement
- [ ] force push/history rewrite
- [x] none of the above — C1 is documentation only.

### Broker foreground liveness

- None. Documentation-only change; no runtime paths touched.

## Verification design

- C1's oracle is review: each normative rule above must be checkable by inspection (fields, states, ownership, budgets, threats).
- Child tracks turn each owned rule into tests: C2 (inbox/reply loop + T1–T6, T10, T11), C3 (task↔conversation bridge + T5), C4 (relay + T7–T9), C5 (cross-broker worker↔worker + T8, T12), C6 (two real brokers + two workers E2E: ordering, retry, replay, auth refusal, broker restart).
- The C6 E2E must run on a real two-broker compose (the current demo compose's missing second broker is a known gap and is C6's first deliverable, not a blocker for this contract).

## Child tracks (to be split from #1814 after freeze)

| Track | Scope | Entry criteria | Exit criteria |
| --- | --- | --- | --- |
| C2 | Same-broker Broker↔Worker and Worker↔Worker inbox/reply loop | this spec frozen | ≥3 round-trips live; T1–T6, T10, T11 as tests; participant-only auth proven |
| C3 | task↔conversation bridge; clarification/checkpoint; task result → bounded reply | C2 exit | `input-required` resume is idempotent; result projection bounded; maxTurns live |
| C4 | Broker↔Broker signed relay, inbox/outbox, cursor, resync | this spec frozen + peer scope proposal accepted | at-least-once redelivery collapses; gap/revoked-peer fail closed; no cursor mis-pinning |
| C5 | Cross-broker Worker↔Worker routing | C4 exit | A→brokerA→brokerB→B question + reverse reply converge to one lineage; no cross-registration |
| C6 | Real two-broker + two-worker E2E, observability, runbook | C2–C5 exit | ordering/retry/replay/auth-refusal/broker-restart reproducible; AgentCard advertises exact support |

## Non-goals (restated)

- No chat UI, persona, or memory product.
- No unbounded autonomous agent debate.
- No direct worker-to-worker networking.
- No full broker DB / raw conversation replication.
- No provider-delivery-as-ACK semantics.
- No production deploy/restart/canary/credential work inside this spec.
