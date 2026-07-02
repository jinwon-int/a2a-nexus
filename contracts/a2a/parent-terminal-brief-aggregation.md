# Parent Terminal Brief Aggregation Contract (v1)

> **v0 (2026-05-13):** Parent-broker Terminal Brief aggregation defined the broker-beta-origin + broker-alpha-handoff canary path with the constraint `parentBrokerId == originBrokerId`. The v0 contract is preserved below; v1 lifts this constraint and defines symmetric origin-broker behavior.
>
> **v1 (2026-05-13, R12):** The origin-broker relationship is symmetric: any registered broker may be the origin broker, and a different broker may be the parent broker. The v0 constraint `parentBrokerId` must equal `originBrokerId` is removed. All v0 lifecycle rules, projection fields, redaction boundaries, title semantics, body/evidence separation, and safety gates remain in effect unless explicitly superseded by a v1 section.

This contract covers the broker-beta-origin + broker-alpha-handoff canary path and its symmetric counterpart (broker-alpha-origin + broker-beta-handoff). A broker owns the parent round and aggregation ledger, while a different broker may own a handoff child task and publish redacted terminal evidence back to the parent aggregation view. The relationship is symmetric: either broker can be the origin.

## Actors

- **Parent broker**: broker that owns the parent round and renders the aggregate Terminal Brief. In the broker-beta-origin canary, this is `broker-beta`; in the broker-alpha-origin canary, this is `broker-alpha`.
- **Origin broker**: broker that created the parent round metadata. In v0 it must equal the parent broker; in v1 (symmetric) it may differ from the parent broker. For the broker-beta-origin canary the origin broker is `broker-beta`; for the broker-alpha-origin canary it is `broker-alpha`.
- **Handoff broker**: broker that owns a child task created through handoff. In the broker-beta-origin canary, this is `broker-alpha`; in the broker-alpha-origin canary, this is `broker-beta`.
- **Child task broker of record**: the broker that controls child task lifecycle, worker assignment, and terminal evidence production.
- **Projection**: the parent broker's redacted, bounded record of the child terminal result.

## Four-case parent-origin routing matrix

For normal broker-alpha/Team1 and broker-beta/Team2 Terminal Brief routing, the initiating broker is always the parent/origin broker and the only operator-facing Terminal Brief sender.

| Case | Initiator | Requested scope | Parent/origin broker | Execution path | Operator-facing sender |
| --- | --- | --- | --- | --- | --- |
| 1 | `broker-alpha` | Team1 only | `broker-alpha` | Team1 local only | `broker-alpha` |
| 2 | `broker-alpha` | Team1 + Team2 | `broker-alpha` | Team1 local + Team2 child/handoff through `broker-beta` | `broker-alpha` |
| 3 | `broker-beta` | Team2 only | `broker-beta` | Team2 local only | `broker-beta` |
| 4 | `broker-beta` | Team1 + Team2 | `broker-beta` | Team2 local + Team1 child/handoff through `broker-alpha` | `broker-beta` |

Routing gates:

1. Team1-only work stays broker-alpha-local; broker-beta is not involved.
2. Team2-only work stays broker-beta-local; broker-alpha is not involved.
3. Cross-team work is parent-seeded: the opposite broker acts only as child/handoff broker and relays projections back to the initiating parent broker.
4. A parentless child projection must fail closed with `missing_parent`; it must not create an implicit parent round.
5. Relay success suppresses duplicate child-local parent notifications; relay failure may fall back to local operator notification as a failure-safety path, not as normal parent ownership.
6. Provider accepted/send evidence is never a terminal ACK, read receipt, or approval.

Machine-readable coverage lives in `fixtures/contract/terminal-brief-parent-origin-routing.json` and is enforced by `test/conformance/check-contract-fixtures.mjs`.

## Metadata lifecycle

The parent broker creates these metadata fields before child dispatch:

```json
{
  "parentRoundId": "round-broker-beta-origin-broker-alpha-handoff-canary-001",
  "originBrokerId": "broker-beta",
  "parentBrokerId": "broker-beta",
  "handoffBrokerId": "broker-alpha"
}
```

Lifecycle rules:

1. `parentRoundId` is minted once by the origin broker before the first child handoff and remains stable for every child projection in that parent round.
2. `originBrokerId` is minted with the parent round and must not be rewritten by child brokers or replay handlers.
3. A child handoff must copy `parentRoundId` and `originBrokerId` into its handoff envelope metadata before task creation.
4. The child broker may append its `childTaskId`, `childBrokerId`, `childIssueUrl`, and terminal evidence URL after it becomes broker of record for the child task.
5. Parent aggregation consumes child terminal evidence as projection input only. It must not mutate child task lifecycle, worker assignment, provider-send state, or terminal-outbox ACK rows.
6. Once a projection reaches `projected`, replay returns the existing projection by `projectionKey`; it must not create another parent Terminal Brief entry.

## Required projection fields

Every parent aggregation projection must carry these fields:

| Field | Requirement |
| --- | --- |
| `projectionKey` | Stable idempotency key derived from `parentRoundId`, `originBrokerId`, `childTaskId`, and terminal kind. |
| `parentRoundId` | Stable parent round id minted by `originBrokerId`. |
| `originBrokerId` | Broker that created the parent round; `broker-beta` for the canary. |
| `parentBrokerId` | Broker rendering the aggregate Terminal Brief. In v0 must equal `originBrokerId`; in v1 (symmetric) may differ from `originBrokerId`. |
| `handoffBrokerId` | Broker that received/owns the child handoff; `broker-alpha` for the canary. |
| `childBrokerId` | Broker of record for the child terminal task. |
| `childTaskId` | Child task id under the child broker of record. |
| `childIssueUrl` | Public-safe issue URL for child evidence, when available. |
| `terminalKind` | One of `pr`, `done`, or `block`. |
| `terminalEvidenceUrl` | URL of redacted PR/Done/Block evidence. |
| `terminalSummary` | Bounded human-readable summary suitable for the parent Terminal Brief. |
| `terminalBriefTitle` | Concise parent/origin-broker-rendered title. The default operator-facing completed-worker title with known total is `A2A Terminal Brief 완료: <worker>(<completed>/<total>)`, equivalently `A2A Terminal Brief 완료: worker(n/N)`; for example `A2A Terminal Brief 완료: worker-epsilon(1/7)`. If the round total is genuinely unavailable, omit the denominator rather than rendering `?`, for example `A2A Terminal Brief 완료: worker-delta(2)`. |
| `projectionState` | `pending`, `projected`, `blocked`, or `conflict`. |
| `redacted` | Must be `true`. |
| `projectedAt` | ISO-8601 timestamp when the parent projection was recorded. |
| `terminalOutboxAckMutated` | Must be `false`. |
| `liveProviderSend` | Must be `false` unless a separate approved live-canary contract explicitly says otherwise. |
| `isApproval` | Must be `false`. |
| `isTerminalAck` | Must be `false`. |
| `isReadReceipt` | Must be `false`. |

## Redaction boundary

Parent Terminal Brief aggregation may include issue/PR URLs, bounded summaries, changed-file counts, check command names, and pass/fail status. It must not include secrets, raw provider payloads, host-private paths, full transcripts, internal runtime/bootstrap context files, live tokens, private database rows, or child worker logs.

A parent projection that cannot be represented within this redaction boundary must become a `block` projection with a sanitized blocker summary rather than copying unsafe evidence.

## Concise title semantics

The aggregate Terminal Brief title is a parent-broker-only projection. The child broker supplies terminal evidence, but only the parent broker renders the operator-facing title from the parent aggregation ledger.

For the operator-facing default path, the parent broker is also the origin broker: `initiatingBrokerId == parentBrokerId == originBrokerId == operatorFacingTerminalBriefSender`. Cross-team brokers are child/handoff evidence relays only; they do not render or send the operator-facing parent-round title.

Title gates:

- default known-total completed-worker format: `A2A Terminal Brief 완료: <worker>(<completed>/<total>)` (`A2A Terminal Brief 완료: worker(n/N)` as the placeholder form);
- non-completed status format: `A2A Terminal Brief <상태>: <worker>(<completed>/<total>)`, using the bounded status labels defined by the parent contract;
- unknown-total fallback: `A2A Terminal Brief <상태>: <worker>(<completed>)`; the parent broker must never render an incorrect denominator such as `(2/?)`;
- example success title: `A2A Terminal Brief 완료: worker-epsilon(1/7)`;
- title source: parent/origin broker ledger fields for terminal status, worker id, completed count, total count when known, `parentRoundId`, `originBrokerId`, `parentBrokerId`, and `operatorFacingTerminalBriefSender`;
- max length: 80 characters;
- forbidden title content: task id, child issue URL, PR/Done/Block URL, terminal summary/body, child broker id, handoff broker id, provider message id, receipt status, ACK status, raw logs, secrets, private paths, and runtime/bootstrap file names;
- the title is not proof of provider delivery, operator receipt, approval, or terminal-outbox ACK.

The concise title policy is broker-neutral and symmetric for evidence projection compatibility. The operator-facing default notification path is stricter: the initiating broker remains both parent and origin, and is the only sender. The canary fixture includes one known-total broker-beta-origin title, one unknown-total broker-alpha-origin title, and one symmetric broker-alpha-origin + broker-beta-parent compatibility title to prevent regressions to verbose or ambiguous title text; the four-case parent-origin routing fixture separately enforces the default operator-facing title and sender rule.

## Body/evidence separation

The aggregate Terminal Brief notification consists of two distinct, non-overlapping parts:

- **Title**: the parent-broker-only, bounded, concise line defined in the Concise title semantics section above. The title is strictly limited to 80 characters, follows the known-total or unknown-total format, and must not include body content, terminal evidence URLs, terminal summary text, child broker IDs, handoff broker IDs, provider message IDs, receipt status, ACK status, or runtime/bootstrap file names.
- **Body/evidence**: the redacted child terminal PR/Done/Block evidence payload, rendered separately from the title. The body may include issue/PR URLs, bounded summaries, changed-file counts, check names, and pass/fail status — but must not duplicate the title, re-render the parentRoundId as title text, or embed provider delivery details.

Separation gates:

1. The title and body/evidence must be stored, transmitted, and rendered as separate fields. A parent broker must not concatenate the title and body into a single text block.
2. The title must not contain terminal summary text, terminal evidence URLs, child broker IDs, handoff broker IDs, provider message IDs, receipt status, or ACK status.
3. The body/evidence must not contain the `terminalBriefTitle` field or re-render the round title as an evidence header.
4. A body-only field with a blank or falling-back title is a projection error and must fail closed.
5. Terminal Brief notifications dispatched through the parent broker must carry the title as a first-class metadata field, not embedded in the message body.

This separation ensures the parent broker can independently compact/truncate the title for channel constraints (80 chars max) without touching evidence redaction, and cannot accidentally send evidence-identifying data in the notification title.

## Parent-only notification ownership

The aggregate Terminal Brief notification is owned and administered by the parent broker only. Child brokers, handoff brokers, and replay handlers must not:

1. Send, update, or retract the parent-round aggregate Terminal Brief notification themselves.
2. Render aggregate titles for a parent round they do not own.
3. Override, overwrite, or mutate the `terminalBriefTitle` field on a parent projection.
4. Dispatch a parent-round aggregate notification to any provider, including Telegram, without the parent broker's lifecycle routing.

Ownership gates:

0. Default operator-facing Terminal Brief notifications are parent/origin-only: the initiating broker must equal `parentBrokerId`, `originBrokerId`, and `operatorFacingTerminalBriefSender`. A handoff broker may relay evidence to that parent/origin ledger, but must not send the operator-facing parent-round notification.
1. The `terminalBriefTitle` may only be set by the broker whose `parentBrokerId` equals the projection's broker of record. In v0, `parentBrokerId` must equal `originBrokerId`; in v1 (symmetric), `parentBrokerId` may differ from `originBrokerId`, and the title owner is determined by `parentBrokerId` alone.
2. A child or handoff broker that receives parent metadata must not render its own aggregate Terminal Brief notification for the parent round.
3. Child evidence produced by a handoff broker flows into the parent aggregation ledger as evidence only; the handoff broker must not send its own parent-round title to any provider.
4. Replay or re-projection of a parent aggregation must preserve the original `parentBrokerId` and must not change the title owner.
5. If the parent broker becomes unavailable, no other broker may assume parent notification ownership without a contract version change that explicitly reassigns `originBrokerId`. This prevents silent ownership hijack during recovery.

The only exception is a handoff broker acting as a pure evidence relay (projecting child evidence back to the parent ledger as projection input, not as parent-round notification).

## broker-beta-origin + broker-alpha-handoff canary contract (v0)

The v0 canary proves only this path (parent-broker-equals-origin):

1. broker-beta mints `parentRoundId` and `originBrokerId` for a parent aggregation round.
2. broker-beta creates a child handoff envelope for broker-alpha that carries the parent metadata.
3. broker-alpha owns the child task as broker of record and produces redacted terminal PR/Done/Block evidence.
4. broker-beta records a single projection row in the parent Terminal Brief aggregation ledger.
5. The aggregate brief links to the child terminal evidence but does not claim provider delivery, human receipt, approval, or ACK.

This canary does not permit cross-worker registration, parent-broker worker dispatch on the child broker, provider sends, production database mutation, terminal-outbox ACK mutation, repository visibility changes, force-pushes, or automatic merges.

## broker-alpha-origin + broker-beta-handoff canary contract (v1 symmetric)

The v1 symmetric canary proves the reverse path (origin-broker-differs-from-parent):

1. broker-alpha mints `parentRoundId` and `originBrokerId` for a parent aggregation round where broker-alpha is the origin broker.
2. broker-alpha creates a child handoff envelope for broker-beta that carries the parent metadata.
3. broker-beta owns the child task as broker of record and produces redacted terminal PR/Done/Block evidence.
4. broker-alpha records a single projection row in the parent Terminal Brief aggregation ledger.
5. The aggregate brief links to the child terminal evidence but does not claim provider delivery, human receipt, approval, or ACK.
6. `parentBrokerId` may equal `originBrokerId` (v0-style) or differ (v1 symmetric). When they differ, the parent broker is the broker rendering the aggregate Terminal Brief; the origin broker is the broker that created the parent round metadata. Title ownership, notification dispatch, and evidence projection follow the same v0 rules, with `parentBrokerId` replacing `originBrokerId` as the authoritative renderer.

### Symmetric safe states

| State | Meaning | Required conditions |
| --- | --- | --- |
| `symmetric_origin_only` | Origin broker created parent round metadata; no handoff child has been created yet. | `parentRoundId`, `originBrokerId`, `parentBrokerId` are set. `parentBrokerId` may equal `originBrokerId` or differ. |
| `symmetric_handoff_created` | Origin broker created handoff child for the destination broker. | Handoff envelope carries `parentRoundId`, `originBrokerId`, `parentBrokerId`, `handoffBrokerId`. |
| `symmetric_child_terminal` | Destination broker produced terminal child evidence and relayed it back to origin. | Terminal evidence is redacted, bounded, and linked to the parent projection. |
| `symmetric_parent_projected` | Origin/parent broker recorded the child terminal evidence as a parent Terminal Brief projection. | Projection follows all v0 field requirements. |

### Symmetric invariants

1. `parentRoundId` is minted by the origin broker and remains stable across all child projections regardless of which broker is the parent.
2. `originBrokerId` is immutable and must not be rewritten by the handoff broker or parent broker.
3. `parentBrokerId` identifies the broker with notification dispatch authority. It may equal `originBrokerId` (v0) or differ (v1 symmetric).
4. A symmetric handoff must copy `parentRoundId`, `originBrokerId`, and `parentBrokerId` into the handoff envelope metadata before task creation.
5. The child broker must relay terminal evidence back to the origin broker's projection ledger, not to its own.
6. Only the broker matching `parentBrokerId` may send or update the aggregate Terminal Brief notification.
7. If `parentBrokerId != originBrokerId`, the notification must include `originBrokerId` metadata so recipients can distinguish the creator from the renderer.
8. All safety gates (no-live, no-ACK, no DB mutation, no visibility change, no provider send, no secret disclosure, runtime/bootstrap hygiene) apply identically in symmetric mode.

### Symmetric title examples

When origin and parent differ, the parent broker renders a title that follows the same known-total or unknown-total format:

| Origin | Parent | Handoff | Worker | Completed | Total | Title |
| --- | --- | --- | --- | --- | --- | --- |
| `broker-beta` | `broker-beta` | `broker-alpha` | `worker-epsilon` | 1 | 7 | `A2A Terminal Brief \uc644\ub8cc: worker-epsilon(1/7)` (v0 style, known-total) |
| `broker-alpha` | `broker-alpha` | `broker-beta` | `worker-delta` | 2 | unknown | `A2A Terminal Brief \uc644\ub8cc: worker-delta(2)` (v0 style, unknown-total) |
| `broker-alpha` | `broker-beta` | `broker-alpha` | `worker-epsilon` | 1 | 3 | `A2A Terminal Brief \uc644\ub8cc: worker-epsilon(1/3)` (v1 symmetric, origin differs from parent) |

All titles must satisfy the same 80-char max, forbidden-content, and separation gates defined in the Concise title semantics section.

## Rollback and no-replay guidance

- Rollback is metadata-only: mark the projection `blocked` or `conflict`, preserve the original projection URL/key, and add a redacted rollback reason.
- Do not delete or overwrite child terminal evidence from the parent broker.
- Do not rerun a child task just because parent aggregation failed. Create a new child task only with a new handoff/idempotency key and explicit operator scope.
- Replaying parent aggregation with the same `projectionKey` must return the existing projection and evidence URL with `newProjectionCreated: false`.
- A same-key/different-payload replay is a conflict and must fail closed.

## R9 addition: 7-child parent round and activation gate

### Fixture

The R9 concise-brief runtime readiness round uses a 7-child parent round fixture with known-total and unknown-total fallback coverage. The fixture includes:

1. **Direct Team1 children**: 3 direct child tasks with known total (completed=N/3), producing concise titles such as `A2A Terminal Brief 완료: worker-delta(1/3)`, `A2A Terminal Brief 완료: worker-gamma(2/3)`, `A2A Terminal Brief 완료: worker-beta(3/3)`.
2. **Cross-broker Team2 projected children**: 4 handoff child tasks projected back to the parent broker, with known total (completed=N/4), producing titles such as `A2A Terminal Brief 완료: worker-epsilon(1/4)`, `A2A Terminal Brief 완료: broker-beta(2/4)`, `A2A Terminal Brief 완료: worker-zeta(3/4)`, `A2A Terminal Brief 완료: worker-eta(4/4)`.
3. **Unknown-total fallback**: A scenario with `totalKnown: false` producing title `A2A Terminal Brief 완료: worker-delta(2)` (no denominator).

### Activation plan (approval-gated, not executed)

This contract does not authorize live activation. The following approval-gated steps are documented as the activation plan for future operator execution:

| Step | Action | Requires operator approval? | Evidence required after execution |
| --- | --- | --- | --- |
| A1 | Verify concise title renderer code is deployed to the Gateway plugin or broker runtime that renders aggregate round titles. | No — read-only verification of already-merged code. | Run test output showing the 7-child fixture renders correct known-total and unknown-total titles. |
| A2 | Verify body/evidence separation in the notification adapter: title and body are separate fields, no body content leaks into the title. | No — read-only verification of already-merged code. | Adapter schema snapshot or test confirming title is a separate wire field. |
| A3 | Verify parent-only notification ownership: only the broker matching `parentBrokerId` may send/update the aggregate notification. In v0 `parentBrokerId` equals `originBrokerId`; in v1 (symmetric) they may differ. | No — read-only contract/code review. | Code or contract showing `parentBrokerId` is the authoritative renderer for notification dispatch. |
| A4 | Enable the concise title renderer in a staging/isolated environment, connected to a non-production provider target. | Yes — separate operator approval naming the staging environment. | Approval comment URL; staging health check output. |
| A5 | Execute one-shot canary: dispatch a synthetic 7-child parent round aggregate notification to the staging provider target. | Yes — approval must name the exact task id, round id, and staging target. | Run output showing all 7 titles rendered correctly; provider accepted-send evidence recorded as non-ACK. |
| A6 | Verify no live provider send occurred outside the approved staging target, no terminal-outbox ACK was recorded, and no production database was mutated. | No — post-action read-only audit. | Outbox snapshot showing ACK column unchanged; no unapproved provider send logs. |
| A7 | Restore staging environment to no-live default: disable the notification bridge, remove the staging allowlist, stop the staging container. | No — documented rollback step. | Restoration evidence showing staging disabled and no-live defaults active. |
| A8 | Present GO decision for production activation with rollback evidence, operator approval, and all A1-A7 evidence linked. | Yes — explicit GO approval naming the exact production round, scope, and provider target. | GO approval comment URL; linked evidence for all sub-steps. |

Activation plan safety gates:

1. Steps A1-A3 may be executed in read-only mode without operator approval — they verify already-merged code.
2. Step A4 requires a separate operator approval naming the staging environment. Staging must be isolated from production (different provider token, different broker instance, non-production database).
3. Step A5 requires its own separate operator approval naming the exact task id, round id, and staging target. The same approval must not cover other actions.
4. Staging provider send must be recorded as provider accepted-send evidence only (receipt level 1). It must not be treated as terminal-outbox ACK, operator-visible receipt, or GO approval.
5. Step A8 requires yet another separate operator approval for production activation. The staging canary (step A5) approval must not be reused for production.
6. No step may deploy to production, restart production Gateway/broker, mutate production database or terminal-outbox ACK rows, change production secrets, or modify repository visibility.

### No-live proof requirement

Before any activation step that involves provider send (A5, A8), the operator must prove that:

1. The round dispatch carries `parentRoundId`, `originBrokerId`, `parentBrokerId`, and `handoffBrokerId` (when applicable) as required metadata.
2. Each child projection in the 7-child round uses a stable `projectionKey` derived from `parentRoundId`, `originBrokerId`, `childTaskId`, and terminal kind.
3. Replayed projection with the same key returns the existing entry and does not create a duplicate notification.
4. The `terminalBriefTitle` is rendered by the parent broker only and follows the known-total or unknown-total format.
5. Body/evidence is separated from the title: the title stays within 80 chars and contains no evidence URLs, broker IDs, task IDs, receipt status, or ACK status.
6. No provider send occurs outside the approved staging or production target.
7. Runtime/bootstrap hygiene is confirmed before any notification dispatch: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, and `.openclaw/**` must not enter the notification title, body, or evidence URLs.

## Evidence requirements

A PR/Done/Block closeout for this contract must provide:

- the contract document path and fixture path;
- local conformance command output for the fixture;
- the `parentRoundId`, `originBrokerId`, and `projectionKey` used in the synthetic proof;
- confirmation that evidence is redacted and no live provider send or ACK mutation occurred;
- replay/no-replay evidence showing duplicate aggregation returns the existing projection;
- rollback guidance or blocker handling for unsafe projection input;
- runtime/bootstrap hygiene confirmation before PR or artifact evidence publication.
