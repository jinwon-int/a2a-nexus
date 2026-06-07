# Plugin durable-runtime boundary

This document defines the A2A behavior currently owned by
`openclaw-plugin-a2a` and the line where ownership must stop until the
remaining OpenClaw-core seams are opened.

It exists to keep three things explicit:

1. what the plugin already owns today,
2. what still remains core-owned for now,
3. what fields and lifecycle transitions must not drift while the
   durable-runtime move is in flight.

## 1. Plugin-owned gateway boundary

Today this repo owns the OpenClaw gateway surface for:

- `a2a.task.request`
- `a2a.task.update`
- `a2a.task.cancel`
- `a2a.task.status`
- opt-in `a2a.monitor.status` operator-event projection mode

Those handlers live in `src/gateway-handlers.ts` and deliberately talk
straight to the standalone broker client. They do not import OpenClaw
core A2A runtime logic.

At this boundary, the plugin owns:

- request validation (`src/gateway-schema.ts`, `src/gateway-validators.ts`)
- broker request construction (`buildBrokerCreateTaskRequestFromOpenClaw`)
- update-to-broker lifecycle writes (`claimTask`, `startTask`,
  `completeTask`, `failTask`)
- cancel-to-broker mapping (`cancelTask` actor + reason shaping)
- broker record to gateway status projection
- broker error to gateway error shaping
- broker approval outcome interpretation for blocked live-impact announces

## 2. Broker lifecycle mapping owned here

The plugin translates gateway writes into broker lifecycle calls using
this mapping:

### `a2a.task.request`

The plugin builds a broker create-task request from OpenClaw-facing
fields, including:

- `taskId`
- `correlationId`
- `parentRunId`
- requester session/display/channel refs
- target session/display/channel refs
- `task.input`
- `task.expectedOutput`
- runtime fields such as `waitRunId`, `roundOneReply`,
  `announceTimeoutMs`, `maxPingPongTurns`, `cancelTarget`

This is the plugin-owned write boundary into broker task creation.

### `a2a.task.update`

Execution-status writes map to broker lifecycle transitions:

- `accepted` -> `claimTask` when broker task is still `queued`
- `running` -> `claimTask` then `startTask` when needed
- `completed` -> ensure started, then `completeTask`
- `failed` -> ensure started, then `failTask`
- `timed_out` -> ensure started, then `failTask` with timeout-flavored
  error code
- `waiting_reply` / `waiting_external` -> no broker state transition yet

The plugin therefore owns the write-side translation of gateway runtime
state into broker lifecycle state.

### `a2a.task.cancel`

Cancel requests map to broker cancel fan-out using:

- broker task lookup by `taskId`
- actor resolution from configured requester or broker task requester
- optional reason carry-through

The plugin owns the OpenClaw-facing cancel envelope and the broker
cancel request payload shape.

### `a2a.task.approve` / `a2a.task.reject_approval`

Approval action requests map to the broker's approval endpoints using:

- broker task lookup by `taskId`
- actor resolution from configured requester or broker task requester
- optional `approvalId`, `reason`, and terminal `status` carry-through

`a2a.task.approve` resumes an approval-gated broker task by calling
`POST /tasks/:id/approve`. `a2a.task.reject_approval` calls
`POST /tasks/:id/reject-approval` with `rejected`, `expired`, or `canceled` and
keeps the live-impact work stopped. Both gateway results include the broker
`approval` / `approvalOutcome` records in `metadata` so OpenClaw status surfaces
can show the exact operator decision without replaying a write.

When the broker records a terminal approval outcome (`rejected`, `expired`, or
`canceled`) for an approval-gated task, the delegated runtime marks the matching
blocked announce delivery as terminal and does not run the announce flow. This
keeps the adapter seam idempotent: only an explicit approved broker record can
release an already-audited blocked announce delivery.

### `a2a.task.status`

Broker records map back into monitoring-friendly gateway fields:

- broker `blocked` -> gateway `accepted` (the A2A vocabulary has no first-class
  blocked status; callers that need to distinguish a blocked task MUST inspect
  `metadata.evidenceRefs` for a `blockUrl` or `metadata.taskInput.blockUrl`)
- broker `queued | claimed` -> gateway `accepted`
- broker `running` -> gateway `running`
- broker `succeeded` -> gateway `completed`
- broker `failed` with timeout code -> gateway `timed_out`
- broker `failed` otherwise -> gateway `failed`
- broker `canceled` -> gateway `cancelled`

**Evidence-only and no-change outcomes:** Both map to broker `succeeded` → gateway
`completed`. The distinction is carried in task metadata:

- `metadata.evidenceRefs` — array of evidence URLs (Start comment, Block comment,
  Done comment) captured from the worker's GitHub issue comments.
- `metadata.taskInput.doneUrl` — the Done comment URL on the issue.
- `metadata.taskInput.blockUrl` — the Block comment URL (when the task was blocked).
- For worker-status-marker consumers, the `WorkerStatusDoneEvent.payload.outcome`
  field classifies the result as `done_with_changes`, `done_evidence_only`, or
  `done_no_changes`.

**Done evidence never implies terminal ACK, read receipt, live-send success, or
visibility confirmation.** Provider-accepted-only states are permanently
insufficient for terminal-outbox ACK evidence (see `docs/public-stable-readiness.md`).

The plugin also shapes:

- `deliveryStatus`
- `summary`
- `output`
- `error`
- `metadata`, including broker `approval` / `approvalOutcome` records when present
- sanitized `metadata.githubMergeGate` when broker/runner payloads include merge-gate facts (`mergeStateStatus`, `reviewDecision`, `requiredReviewCount`, `requireLastPushApproval`, `hasConflicts`, `blockedBy`, `summary`). The plugin derives `state` as `clean`, `review_required`, `conflict`, `blocked`, or `unknown` and intentionally does not project tokens or raw GitHub API responses.
- `requester` / `target` refs
- `startedAt` / `updatedAt`

### `a2a.monitor.status` operator-event bridge

When plugin config enables
`plugins.entries.a2a-broker-adapter.config.operatorEvents.enabled = true`
and the request opts in with `operatorEvents.enabled = true`, the plugin
starts a read-only SSE bridge against broker `/a2a/operator/events`.

The returned monitoring shape is plugin-owned and includes:

- projected operator snapshot
- latest live summary
- open and resolved alert lists
- bridge connection state, cursor, and visible last failure

Regular `a2a.monitor.status` diagnostics may also include compact
`terminalReceiptGaps` projected from broker diagnostics. These fields keep
provider/Gateway send success separate from operator-visible receipt evidence:
missing, stale, or failed receipt states remain `pending`, set
`terminalAckEligible: false`, and add a `terminal_receipt_gap` warning instead
of being projected as success.

Regular monitor diagnostics may also include compact
`brokerRuntimeOwner` metadata projected from broker health, such as
`manager: docker-compose`, Compose project/service, container name, or a
legacy systemd unit name when the broker reports one. The plugin treats
that as redacted status context only: it does not expose host paths,
secrets, raw process dumps, or credentials, and it must not try to control
Docker Compose or systemd from this repository.

This path is intentionally read-only. It does not mutate broker tasks,
enable wake-on-task, control Docker/systemd, or depend on any peer-status
RPC.

### Operator terminal notifications

The broker remains the source of terminal task/outbox events and the plugin
owns operator notification delivery. The bridge consumes the broker stream with
`Last-Event-ID` cursor replay, turns terminal success/failure/block/PR events
into compact `a2a.operator.notification` envelopes, and suppresses duplicate
`dedupeKey` deliveries after reconnect/replay.

Delivery ownership is explicit in each envelope:

- `deliveryOwner: "openclaw.plugin-notifier"`
- `deliveryTarget: "operator-main-session"`

Each notification also carries compact, secret-safe evidence under
`evidence.schema: "a2a.operator.notification.evidence"` with only durable
operator fields: `taskId`, `worker`, `status`, `repo`, `issueUrl`,
`prUrl`, `doneUrl`, `blockUrl`, `summary`, and `createdAt`. The
OpenClaw Telegram adapter projection uses the same dedupe key plus
`delivery: { mode: "announce", channel: "telegram" }`; it does not contain
Telegram tokens or call Telegram APIs directly.

Per-worker terminal/completion Telegram notification delivery is fail-closed.
Stale target fields such as `notification.to`, `notification.chatId`, or
`notification.channel` are ignored unless both gates are explicitly true:

- `plugins.entries.a2a-broker-adapter.config.operatorEvents.enabled=true`
- `plugins.entries.a2a-broker-adapter.config.operatorEvents.notification.enabled=true`

The normal operator workflow should read the broker's `/operator/task-report`
endpoint and let the main operator session summarize a round once, without cron
or per-worker Telegram sends. If an operator temporarily opts into the legacy
plugin-owned live delivery path, configure the target under
`operatorEvents.notification`, for example
`{ "enabled": true, "channel": "telegram", "to": "telegram:<operator-chat-id>", "accountId": "default" }`.
The schema intentionally keeps `additionalProperties: false`; secrets such as bot
tokens do not belong in this notification target block.

Broker and worker processes must not call Telegram directly. Tests can use
dry-run delivery to assert envelope rendering without sending external messages.

For release validation, use the plugin-side
`createA2ATelegramSafeDryRunNotificationHarness()`. It projects the exact
Telegram adapter payload while forcing `dryRun: true`, retaining no Telegram
bot token, chat id, or direct send target, and applying a bounded retention fuse
(default 100 notifications) so broker replay storms cannot become unbounded
operator-notification floods. A live Telegram send remains outside this repo and
requires the OpenClaw notifier/operator approval path.

## 3. Fields that must round-trip intact

Until the durable-runtime move is complete, these fields are the most
important carry-through contract at the plugin boundary:

- `correlationId`
- `parentRunId`
- requester `{ sessionKey, displayKey, channel }`
- target `{ sessionKey, displayKey, channel }`
- `taskInput`
- `expectedOutput`
- `exchangeId`
- `proposalId`
- `policyContext`
- `approval` / `approvalOutcome`
- GitHub merge-gate summaries under `githubMergeGate`, `mergeGate`, `github.mergeGate`, or `metadata.mergeGate` inside `taskInput`, `result.output`, or `error.details`
- `evidenceRefs`
- runtime `cancelTarget`
- runtime `waitRunId`
- runtime `roundOneReply`

The broker must preserve them in a way that lets
`readBrokerTaskPayload()` project them back into gateway status.

## 4. What is still not plugin-owned

This repo does **not** fully own delegated-task durable execution yet.
The following still remain OpenClaw-core responsibilities until the new
seams land:

- sessions-send delegation interception and routing hook
- wait-run registration and resolution
- heartbeat / timeout watchdog scheduling
- session-run cancel fan-out back into OpenClaw runtime
- the per-turn delegated ping/pong orchestration loop

That means this repo currently owns the gateway boundary and broker
mapping layer, but not the entire delegated-task runtime.

## 5. Executable coverage in this repo

The current standalone tests under `test/` lock down this owned
boundary:

- request mapping into broker `createTask`
- update mapping into `claim -> start -> complete`
- cancel mapping into broker cancel fan-out
- approval / rejection mapping into broker approval endpoints
- status projection for queued, completed, canceled, failed, and timeout
  states
- metadata round-trip for drilldown and monitoring fields

Run with:

```bash
npm test
```

## 6. Near-term follow-up

The next implementation step for this repo is not to grow more hidden
runtime inside the plugin. It is to keep this boundary explicit while
core opens the missing seams described in `docs/migration-plan.md`.

Once those seams exist, the delegated-task runtime pieces can move here
without changing the already-locked request/update/cancel/status
contract.

## Supervised external-announce gate

When the delegated-task runtime completes a broker task, it may generate an
announce reply and send it through the target channel adapter. Because that is a
live external send, the runtime treats broker `policyContext` as a human gate:

- `requiresApproval: true`
- `liveImpact: true`
- `targetEnvironment: "live"`

If any of those flags are present on the terminal broker task, the plugin does
not run the announce subagent flow and does not call `sendText`. The handled
result remains terminal (`status: "ok"` when the broker task succeeded) but its
`delivery` field is explicit:

```json
{
  "status": "blocked",
  "mode": "human_approval_required",
  "reason": "live-impact task requires explicit human approval before external announce"
}
```

This keeps successful live-impact work visible while preventing unsupervised
production sends until an operator performs an explicit approval/send step.

### Blocked announce resume seam

Until the broker publishes a canonical approval event API, the plugin keeps the
resume boundary explicit and local to the delegated runtime:

- a blocked live-impact announce is recorded as a pending delivery with a
  stable `deliveryId` (`announce:<taskId>:<waitRunId>`), task/wait-run refs,
  target/requester refs, `policyContext`, and an audit trail;
- no announce subagent step and no channel `sendText` call runs while the
  delivery is in `blocked` state;
- `resumeBlockedDelivery({ deliveryId | taskId, approved: true, approvalId })`
  is the temporary approval seam. Missing `approved: true` or a stable
  `approvalId` is rejected;
- the first valid approval atomically moves the delivery to `delivering`, runs
  the normal announce flow once, then records `delivered` or `skipped` audit
  metadata;
- duplicate approvals after `delivering`, `delivered`, or `skipped` are audited
  as `duplicate_approval` and do not call `sendText` again.

Broker approval metadata now feeds this seam rather than bypassing it. If the
terminal broker task carries `approval.approvalId`, the runtime records the
blocked announce delivery and immediately resumes it through the same
`resumeBlockedDelivery` path, preserving exactly-once delivery, duplicate
protection, and the local audit trail. Tasks without broker approval remain
blocked until an explicit local resume signal is supplied.
