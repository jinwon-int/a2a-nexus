# R20 Stability Gate Contract (v0)

> **v0 Freeze (2026-05-15):** R20 stability gate acceptance criteria, bounded diagnostics,
> no-live canary boundary, hot-table persistence invariants, queue/outbox hygiene requirements,
> and stale R14 PR reconciliation policy are frozen as the Contract v0 stability gate baseline.
> Changes to gate criteria or safety assertions require a v0→v1 plan.

This contract defines the Plane-side stability gate for the R20 retry round. It encodes the acceptance
criteria for hot-table persistence hygiene, queue/outbox bounded diagnostics, no-live canary activation
boundaries, and stale R14 non-Terminal-Brief PR reconciliation. It is a policy-only document: it
defines what safe evidence looks like at the contract level without prescribing implementation details
or implying production mutation.

Parent round: [a2a-broker#636](https://github.com/jinwon-int/a2a-broker/issues/636)
Plane lane: a2a-plane#327 (a2a-plane#327, internal tracker private)
Origin coordinator: Gwakga
Receiving broker for this Team1 task: Seoseo
Snapshot: `2026-05-15T08:18Z`

This contract builds on the existing [terminal result semantics](./terminal-semantics.md),
[task lifecycle](./task-lifecycle.md), [cancellation & idempotency](./cancellation-idempotency.md),
and [release gate](../../docs/release-gate.md) contracts.

---

## 1. Hot-table persistence pressure gate (H1)

Hot-table mode refers to the broker's in-memory state management for active task tables,
audit traces, terminal outbox rows, and corresponding SQLite journal entries. High sustained
throughput with unbounded state growth produces full-snapshot pressure, heap/RSS growth, and
WAL journal buildup that may lead to OOM.

### H1.1 Bounded diagnostics

Before claiming R20 stability closure for hot-table persistence, the broker must produce
health/readiness output or diagnostics that report all of the following without secrets or
host-private paths:

| Diagnostic | Bound/safety condition | Fail-closed condition |
| ---------- | ---------------------- | --------------------- |
| Process memory (RSS/heap) | Reported in bounded numeric form; measurement interval is documented | Raw `/proc/*/status` or host-specific paths in evidence |
| Active task table count | Counted and bounded; growth rate or trend included | Unbounded table count without bound or diagnostic |
| Terminal outbox total/acked/unacked | Counted with separate total, acked, and unacked subcounts | Missing acked/unacked breakdown |
| Stale claimed/running work | Counted with age or staleness threshold | Stale items reported without threshold |
| SQLite WAL/checkpoint posture | WAL file size, checkpoint page count, or equivalent reported | WAL state omitted from diagnostics |
| Snapshot/serialize frequency | Snapshot count, interval, or equivalent reported | Snapshot frequency absent from evidence |

### H1.2 Memory-bound safety invariants

| Invariant | Required evidence | Fail-closed condition |
| --------- | ---------------- | --------------------- |
| No unbounded full-task materialization | Evidence that hot-table load uses lazy/paged access, incremental persistence, or another memory-bounded pattern | Full historical task/audit/outbox materialization on startup or each hot-row mutation |
| Startup heap bounded | Evidence that running with representative task/audit/outbox rows does not require proportional startup heap | Startup heap required proportional to total rows |
| WAL size bounded | Evidence that WAL checkpoint or journal mode keeps journal size bounded under sustained hot-table load | Journal/WAL grows without bound under load |
| No OOM regression | Load/soak evidence showing memory stays under a documented threshold for representative workloads | OOM or unbounded growth observed |

### H1.3 Safety confirmations

- Hot-table persistence diagnostics are read-only and require no production DB mutation.
- Diagnostics contain no secrets, raw session dumps, provider identifiers, or host-private paths.
- Memory-bound evidence is synthetic/observable; no production restart or WAL mutation is required.
- Deploy, restart, DB prune, WAL mutation, or backup/restore operation for hot-table work is `NO-GO / Waiting` without separate explicit operator approval.

---

## 2. Queue/outbox hygiene gate (Q1)

Terminal outbox and queue hygiene covers bounded processing, stale record handling, and
fail-closed behavior for any outbox state mutation.

### Q1.1 Bounded processing

| Requirement | Pass condition | Fail-closed condition |
| ----------- | -------------- | --------------------- |
| Outbox processing has a per-run item limit | Maximum items processed per cycle is documented and finite | Unbounded outbox processing cycle |
| Processing reports progress | Cycle reports processed count, skipped count, and remaining count | No progress reporting in processing output |
| Processing is dry-run safe | Dry-run mode reports what would be processed without mutation | Dry-run does not exist or mutates state |
| Processing has age-based staleness handling | Stale unacked items (age > documented threshold) are identified | Stale items processed or silently skipped without identification |
| Outbox mutation requires approval | Any mutation path (ack, prune, clean) requires explicit operator approval | Mutation proceeds without approval gate |

### Q1.2 Queue hygiene invariants

| Invariant | Required evidence | Fail-closed condition |
| --------- | ---------------- | --------------------- |
| No stale claimed/running work | Queue reports no tasks stuck in claimed or running for longer than the documented timeout | Stale tasks in claimed/running without detection |
| No unbounded backlog | Total queued items is bounded and processing throughput meets demand | Queue grows without bound with no diagnostic |
| Fail-closed mutation guard | Outbox mutation commands fail in dry-run mode unless approval is present | Dry-run mode silently permits mutation |
| Terminal ACK is not forged from accepted-send | Provider accepted-send evidence must never be promoted to terminal-outbox ACK | Code or documentation describes a path from `sendStatus: accepted` to terminal-outbox ACK |

### Q1.3 Safety confirmations

- Outbox/queue diagnostics are dry-run only and produce no side effects.
- Staleness handling reports only; actual mutation (ack, prune, or clean) requires separate operator approval.
- No terminal-outbox ACK mutation is performed by diagnostics or read-only processing.
- No live provider send is triggered by queue processing.
- No production DB mutation occurs through queue hygiene operations without explicit approval.

---

## 3. No-live canary boundary gate (C1)

Canary/receipt gates must remain strict. Provider accepted-send is not terminal ACK/read/visibility
evidence. No-live activation boundaries prevent accidental provider or Telegram sends during
stability validation.

### C1.1 No-live invariants

| Invariant | Required evidence | Fail-closed condition |
| --------- | ---------------- | --------------------- |
| Provider accepted-send is non-ACK | Evidence demonstrates or documents that `providerMessageId`, `providerAccepted`, `sendStatus: accepted`, and `sendStatus: sent` are accepted-send only | Any code/contract promotes these to terminal ACK |
| GitHub comment projection is non-ACK | GitHub evidence comments carry `isApproval: false`, `isTerminalAck: false`, `isReadReceipt: false` | Any evidence comment omits or falsifies these flags |
| Terminal Brief is non-ACK | Terminal Brief evidence is receipt level 2 (requester-visible) at most; it is never terminal ACK | Terminal Brief is described as terminal-outbox ACK or read receipt |
| Live provider send is blocked by default | Any live provider/Telegram/notification path is disabled by default and requires explicit allowlisting | Default configuration permits live sends |
| No-live mode for stability validation | Stability validation runs in no-live mode; evidence must not contain provider send success from live sends | Stability evidence includes live provider send data |

### C1.2 Canary activation preconditions

Before any live canary or notification activation, **all** of the following preconditions must
be met. These preconditions do not authorize activation — they are the evidence that an operator
needs to review before giving separate explicit approval.

| Precondition | Required evidence | Fail-closed condition |
| ------------ | ---------------- | --------------------- |
| One-shot allowlist | The live canary is disabled by default and requires an explicit allowlist entry for a fresh task/outbox id | No allowlist guard; approval covers multiple actions |
| Replay/idempotency protection | Evidence key deduplication and projection key idempotency prevent duplicate notifications | Same evidence key produces multiple sends or ACK mutations |
| Bounded receipt evidence | Post-send evidence captures bounded receipt (accepted-send only at notification time) and explicitly separates ACK | Post-send evidence claims terminal ACK or read receipt |
| Restoration evidence | Post-canary evidence proves no-live defaults were restored (notification disabled, allowlist removed) | No restoration step recorded; default remains allowlisted |
| Explicit operator approval | A separate operator comment names the exact canary scope, fresh task/outbox id, and one-shot allowlist entry | Approval comment is missing, covers multiple actions, or references stale/replayed ids |

### C1.3 Safety confirmations

- No-live mode is the default for stability validation runs.
- Evidence does not contain live provider send success, Telegram message IDs from live sends,
  or operator-visible/terminal ACK receipt proof from automated notification paths.
- Canary activation precondition checklist is an operator-review aid, not an operator approval.
- The aggregate decision for live activation remains `NO-GO / Waiting` unless all preconditions
  are met **and** a separate explicit operator approval exists for that exact activation.

---

## 4. Stale R14 PR reconciliation gate (R14)

Old R14 non-Terminal-Brief PRs that remain open need review against current main. This gate
applies to both Plane-side and broker-side R14 residual PRs. Within Plane scope, the gate
defines the reconciliation policy; actual broker-side PR reconciliation is a broker repo lane.

### R14.1 Reconciliation policy

| Action | Policy | Fail-closed condition |
| ------ | ------ | --------------------- |
| Merge | PR passes current-main validation (build, contract fixtures, release gate) and has no unresolved review comments | PR merged without validation |
| Supersede | PR is explicitly closed as superseded with a comment referencing the superseding PR or issue | PR closed as superseded without explanation or reference |
| Close | PR is intentionally abandoned; close with a comment explaining why it will not be pursued | PR closed without explanation |
| Keep open | PR is blocked on external dependency; leave open with a comment documenting the dependency | PR left open without comment or tracking issue |

### R14.2 Current-main validation

Before merging or superseding a stale R14 PR, validate against current main:

```bash
# In the target repository (plane or broker):
npm run check:layout
npm run test:conformance
npm run release-gate
```

If validation fails, the PR must not be merged until the failure is resolved or the PR is
superseded with evidence of the failure.

### R14.3 Plane-side stale PR inventory

Within the Plane repo scope, R14 non-Terminal-Brief PRs are reviewed as part of the R20 gate.
Any relevant PRs still open at the time of R20 gate execution must have a reconciliation
decision (merge, supersede, close, or keep-open-with-comment) recorded in the gate evidence.

For broker-side R14 PR reconciliation, the Plane gate records the policy; actual PR operations
are delegated to the broker lane and broker operator.

### R14.4 Safety confirmations

- PR reconciliation does not include force-push, history rewrite, or repository visibility change.
- PR close/supersede is done through standard GitHub PR operations only.
- Merged PRs must pass the full release gate before merge.
- No production deploy, restart, or live send is implied by PR reconciliation.

---

## 5. Aggregate decision

The aggregate stability gate decision for Plane-side R20 evidence:

| Component | Gate | Aggregate decision |
| --------- | ---- | ------------------ |
| Hot-table persistence diagnostics | H1 | `NO-GO / Waiting` — diagnostics and bounded invariants are defined; linked implementation evidence is pending |
| Queue/outbox hygiene | Q1 | `NO-GO / Waiting` — bounded processing and staleness handling are defined; linked implementation evidence is pending |
| No-live canary boundary | C1 | `NO-GO / Waiting` — no-live invariants and activation preconditions are defined; live activation requires separate operator approval |
| Stale R14 PR reconciliation | R14 | `NO-GO / Waiting` — reconciliation policy is defined; stale PR inventory status must be verified at gate execution time |

**Aggregate gate decision: `NO-GO / Waiting`.** Source docs may proceed, but live broker
rollout, hot-table persistence activation, queue/outbox mutation, canary send, terminal ACK,
or production state mutation remains blocked until every gate component below the aggregate
has linked evidence **and** a separate explicit operator approval for that exact action.

---

## 6. Safety gates

This contract confirms all of the following:

- No production deploy or Gateway/broker/worker restart.
- No live provider/Telegram/notification send.
- No terminal-outbox ACK mutation.
- No production database mutation, prune, migration, or WAL operation.
- No secret rotation or secret value disclosure.
- No raw session dump or host-private path in evidence.
- No repository visibility change.
- No force-push or history rewrite.
- No automatic merge or release publication.
- `isApproval: false`, `isTerminalAck: false`, `isReadReceipt: false` on all evidence.

## 7. Validation commands

```bash
node test/conformance/check-contract-fixtures.mjs
npm run check:layout
npm run release-gate
```

## 8. Related

- [Terminal Result Semantics](./terminal-semantics.md) — ACK boundary and receipt levels
- [Task Lifecycle](./task-lifecycle.md) — state transitions and terminal states
- [Cancellation & Idempotency](./cancellation-idempotency.md) — idempotency guarantees
- [Broker-to-broker Handoff Protocol](./broker-handoff-protocol.md) — cross-broker evidence
- [GitHub Evidence Projection](./github-evidence-projection.md) — non-ACK evidence comments
- [Release Gate](../../docs/release-gate.md) — root release validation
- [Fixtures](../../fixtures/contract/r20-stability-gate.json) — machine-readable fixture
