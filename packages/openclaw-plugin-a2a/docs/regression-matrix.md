# Plugin ↔ broker regression matrix

Closes out plugin-a2a#3. This is the scope-of-coverage doc
for plugin-to-broker task lifecycle behavior. It defines the
scenarios, what "pass" looks like for each, whether the scenario
should be an automated test or a scripted smoke check, and the
signals that let you correlate a plugin symptom back to a broker
cause.

## How to use this doc

- Each row is a distinct behavior, not a distinct API call. One row
  may exercise several methods in sequence.
- "Automated" = unit or integration test that runs on every change to
  this repo. "Smoke" = scripted manual run against a local broker,
  used pre-release or when triaging.
- Today, full end-to-end lifecycle coverage lives in the OpenClaw
  monorepo because the delegated-task runtime is still there
  (see `docs/migration-plan.md` §1.1). Rows flagged *automated (now
  blocked)* should become automated in this repo only after that
  extraction step.

## Scenarios

### 1. Success path — request → claim → start → complete

- **Setup**: broker up, one idle worker matching
  `target.sessionKey` / `displayKey`.
- **Steps**:
  1. gateway `a2a.task.request` with `task.intent = delegate`
  2. gateway `a2a.task.update { executionStatus: "accepted" }`
     (drives `claimTask`)
  3. gateway `a2a.task.update { executionStatus: "running" }`
     (drives `startTask`)
  4. gateway `a2a.task.update { executionStatus: "completed",
     summary, output }` (drives `completeTask`)
  5. gateway `a2a.task.status`
- **Pass signals**:
  - final broker status `succeeded`
  - `mapBrokerStatusToExecutionStatus` → `completed`
  - `mapBrokerStatusToDeliveryStatus` → `skipped`
  - payload round-trip: `requesterSessionKey`, `targetDisplayKey`,
    `correlationId`, `parentRunId` returned verbatim via
    `readBrokerTaskPayload`
  - `result.output`, `result.summary` returned in
    `buildGatewayTaskOutput` / `buildGatewayTaskStatus`
- **Coverage**: **automated**. Pure plugin → broker HTTP, no core
  runtime needed. Drive it with a sibling `a2a-broker` in a test
  fixture.

### 2. Timeout path — task never completes within deadline

- **Setup**: broker up, worker claims but never sends `started`
  within `announceTimeoutMs`, OR claims and starts but never
  completes before `timeoutSeconds` elapses.
- **Pass signals**:
  - broker terminal status `failed` with error code in
    `BROKER_TIMEOUT_CODES` = `timeout | timed_out | broker_timeout`
  - `mapBrokerStatusToExecutionStatus` → `timed_out` (not `failed`)
    — this is the one status where the broker error *code* changes
    the OpenClaw mapping
  - gateway response carries
    `error.code = "timed_out"` (see
    `src/gateway-handlers.ts::buildBrokerError` /
    `buildGatewayTaskError`)
- **Correlation signal**: compare broker-reported `error.code` with
  the `BROKER_TIMEOUT_CODES` set. If the plugin surfaces
  `executionStatus = "failed"` but the broker code is a timeout
  variant, the set in `type-mapping.ts::isBrokerTimeoutCode` has
  drifted from the broker.
- **Coverage**: **automated** for the mapping (unit test over
  `mapBrokerStatusToExecutionStatus`). **Smoke** for the end-to-end
  timer behavior until the delegated-task runtime moves here
  (`docs/migration-plan.md` §1.1).

### 3. Stale worker / requeue / dead-letter

- **Setup**: task is claimed, worker goes silent past the broker's
  heartbeat/lease window. Broker requeues it; eventually dead-letters
  after N attempts.
- **Pass signals**:
  - broker SSE emits `task-status-update` with reason in
    `requeued`, `reassigned`, then `dead_lettered` (see
    `A2ABrokerTaskSseStatusUpdateReasonSchema` in
    `standalone-broker-client.ts`)
  - final broker status `failed`
  - plugin gateway surface returns `executionStatus = "failed"` with
    a non-timeout error code (so distinguishable from scenario 2)
  - re-claim by a different worker id is reflected in
    `brokerTask.claimedBy` — `resolveWorkerId` in
    `gateway-handlers.ts` must prefer the current `claimedBy` over
    `assignedWorkerId` so follow-up `a2a.task.update` calls are
    addressed to the right worker after requeue.
- **Correlation signal**: the SSE reason chain is the ground truth
  for why a task "failed". A plugin-side symptom of "task failed for
  no clear reason" should be traced to SSE reasons. If the reason was
  `dead_lettered`, the broker retry policy is what's in play, not the
  plugin.
- **Coverage**: **automated** for the requeue/reassign worker-id
  picking logic (unit test over `resolveWorkerId`). **Smoke** for
  full dead-letter propagation.

### 4. Auth failure

- **Setup**: plugin configured with a missing or wrong `edgeSecret`
  (or missing `requester` when the broker requires one).
- **Pass signals**:
  - `A2ABrokerClientError.status` is `401` or `403`
  - `buildClientError` in `standalone-broker-client.ts` preserves the
    broker error `code` and `message`
  - gateway handler wraps it with `A2AErrorCodes.INTERNAL` and
    message `"a2a.task.<method> failed: <underlying>"`
    (see `toGatewayError` in `src/gateway-handlers.ts`)
- **Correlation signal**: the gateway `error.message` contains the
  broker's original message. If that substring is missing, the plugin
  is swallowing details — treat as a regression in error shaping.
- **Coverage**: **automated**. Spin the broker with a known secret
  and call with a wrong one.

### 5. Rate-limit behavior

- **Setup**: drive requests past the broker request-rate limit
  (for smoke, that is the `RATE_LIMIT_MAX_REQUESTS` /
  `WORKER_RATE_LIMIT_MAX_REQUESTS` knobs called out in the README
  Termux section).
- **Pass signals**:
  - broker returns `429`
  - `A2ABrokerClientError.status === 429` and `code` (if broker
    provides one) is preserved
  - plugin does **not** currently retry — rate limit is surfaced
    through the gateway as an error, not masked. Any change to
    add retry/backoff is a behavior change that needs a dedicated
    regression entry here.
- **Correlation signal**: gateway-side symptom of "broker
  unavailable" during smoke on Termux is almost always a 429 from
  self-polling, not a real outage. The Termux validation notes in
  the README exist specifically because of this.
- **Coverage**: **automated** for "429 surfaces as gateway error"
  (unit test can mock a 429 response). **Smoke** for real pressure.

### 6. Mapping / error-shaping cases

These are pure translation regressions, fully testable without a
broker.

- **6a. Status mapping**
  every value in `BrokerTaskStatus` exercised through
  `mapBrokerStatusToExecutionStatus` and
  `mapBrokerStatusToDeliveryStatus`. Include
  `failed + error.code = "timed_out"` → `timed_out`.
- **6b. Broker error → task error**
  `mapBrokerErrorToTaskError` returns `undefined` when there is no
  code and no status, and synthesizes `"remote_task_failed"` when
  status is `failed` with no explicit code.
- **6c. Cancel target resolution**
  `resolveCancelTarget` prefers explicit → payload → request → synth
  from `targetSessionKey`+`runId`. Test all four arms.
- **6d. Payload round-trip**
  feed a broker task whose `payload` includes the six keys listed in
  `docs/migration-plan.md` §4.7 and assert every one is echoed in the
  gateway status.
- **6e. Output envelope**
  `buildGatewayTaskOutput` includes `artifactIds`, `validation`,
  `apply`, `note` when present and omits the whole `output` key when
  they're all absent and no extra `result.output` fields exist.
- **6f. Cancel result shape**
  `buildGatewayTaskResult("a2a.task.cancel", …)` sets
  `abortStatus = "aborted"` iff broker status is `canceled`,
  otherwise `"not-attempted"`.
- **6g. Validator errors**
  each of the four gateway validators rejects the minimal-missing-
  field case and returns an `INVALID_REQUEST` through
  `validateParams`.
- **6h. Missing broker client**
  when `createA2AGatewayBrokerClient` throws (e.g. `baseUrl`
  missing), gateway returns `NOT_FOUND` with the client error message
  — see `respondBrokerUnavailable` in `src/gateway-handlers.ts`.

**Coverage**: all of 6a–6h are **automated**. They should be the
first tests stood up in this repo because they do not depend on any
of the remaining core seams.

### 7. Cancel lifecycle

- **Setup**: task in `running`, gateway issues `a2a.task.cancel`.
- **Pass signals**:
  - broker status transitions to `canceled`
  - `executionStatus` → `cancelled` (note: OpenClaw side is
    `cancelled` with two l's, broker side is `canceled` with one —
    this is deliberate, do not "fix")
  - cancel result includes `abortStatus: "aborted"`
  - if the task was already terminal when cancel arrived,
    `abortStatus: "not-attempted"`
- **Coverage**: **automated** for the shape/mapping. **Smoke** for
  broker-initiated cancel fan-out until the cancel seam from
  `docs/migration-plan.md` §2.3 lands.

### 8. Task-not-found

- **Setup**: gateway call with a task id the broker has never seen.
- **Pass signals**:
  - `standalone-broker-client.ts` returns `A2ABrokerClientError`
    with `status === 404`
  - `getBrokerTask` in `src/gateway-handlers.ts` swallows the 404 to
    `undefined`
  - gateway responds with `NOT_FOUND` and message
    `"a2a task not found: <id>"`
- **Coverage**: **automated**.

## Automation plan

The rows above split into three buckets:

1. **Automate first** (no core seams needed): 1, 4, 5, 6a–6h, 8.
   Stand these up as `tests/` in this repo. They can run against a
   locally-spawned sibling `a2a-broker` for 1 / 4 / 5 and purely
   in-memory for 6 / 8.

2. **Partially automate** (mapping is unit-testable now, end-to-end
   is blocked on §1.1 extraction): 2, 3, 7. Ship unit coverage for
   the mapping arms today; flip the e2e arms to automated when the
   delegated-task runtime moves here.

3. **Smoke-only until further notice**: the Termux-validated
   delegated-task round trip in `README.md`. This stays a scripted
   smoke check because it exercises a third environment (Android
   Termux), not just plugin + broker.

## Correlating plugin symptoms to broker causes

When a plugin-side failure shows up, these are the pointers from
symptom back to the likely broker-side cause:

| plugin symptom | likely broker-side cause | where to look |
| --- | --- | --- |
| gateway `error.code = "timed_out"` | broker watchdog fired, worker never finished | broker error code in `BROKER_TIMEOUT_CODES` |
| gateway `executionStatus = "failed"` with no message | broker `failed` status but no `error.code`/`message` — usually dead-letter | SSE reason chain for `requeued`/`dead_lettered` |
| gateway `NOT_FOUND` on a task we just created | task id mismatch, or the create call actually failed and we kept going | client logs for the original `createTask` response |
| gateway `INTERNAL` with a 401/403 | edge auth drift (secret rotated, requester headers missing) | broker auth logs; check `edgeSecret` + `requester` config |
| gateway `INTERNAL` with a 429 | broker or worker rate limit; often self-inflicted during polling | broker rate-limit metrics; see README Termux smoke knobs |
| `executionStatus = "failed"` but a timeout was expected | `isBrokerTimeoutCode` set drifted from the broker's error code vocabulary | `type-mapping.ts` vs. broker error-code source |
| cancel returned `abortStatus: "not-attempted"` | task was already terminal at cancel time | broker `updatedAt` / terminal timestamp |
| payload fields missing on read-back | broker stopped preserving `payload` verbatim | broker payload handling; `readBrokerTaskPayload` expects verbatim keys |
| follow-up `a2a.task.update` targets wrong worker | `claimedBy` changed after a requeue; `resolveWorkerId` picked stale `assignedWorkerId` | broker SSE reason chain for `reassigned` |

These map one-to-one onto the scenarios above; when triage lands on
a symptom, the matching row is the regression to extend.
