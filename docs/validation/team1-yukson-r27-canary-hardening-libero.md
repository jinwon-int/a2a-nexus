# Team1/yukson R27 canary hardening libero validation matrix — retry-1

Parent: #364 (a2a-plane#364, internal tracker private)
Run: `a2a-r27-team1-terminal-brief-canary-hardening-20260516T121247Z-yukson-retry1`
Broker of record: `seoseo`
Team: `team1`
Worker: `yukson`
Snapshot: `2026-05-16T12:21Z`
Retry: yes — previous attempt blocked on worker handler compat path gap; gap repaired before this retry.

This is a redacted validation artifact only. It does not change repository visibility, import private source history, deploy, restart Gateway/broker/worker services, mutate production databases, send provider or Telegram messages, ACK terminal outbox rows, rotate or disclose secrets, rewrite history, force-push, publish a release, or post to community channels.

## Evidence reviewed

- Parent dispatch: a2a-plane#364 (a2a-plane#364, internal tracker private)
- Receipt-gate no-live canary matrix: `packages/broker/docs/receipt-gate-canary-matrix.md`
- Receipt-gated ACK canary smoke runbook: `packages/broker/docs/receipt-gated-ack-canary-runbook.md`
- Broker canary source: `packages/broker/src/core/receipt-gate-canary.ts` and `packages/broker/src/core/receipt-gate-canary.test.ts`
- Broker rehearsal manifest: `packages/broker/src/core/broker-rehearsal-manifest.ts` and `packages/broker/src/core/broker-rehearsal-manifest.test.ts`
- Session isolation contract: `packages/broker/src/workers/session-isolation.ts`, `packages/broker/src/workers/session-isolation.test.ts`, and `packages/broker/docs/session-isolation.md`
- Intent router: `packages/broker/src/workers/intent-router.ts` and `packages/broker/src/workers/intent-router.test.ts`
- Worker handler (compat path): `packages/broker/src/worker.ts` — `createExternalWorkerHandler`, `createWorkerConfigFromEnv`, `createWorkerHandlerFromEnv`
- Terminal Brief activation report: `packages/broker/docs/terminal-brief-activation-report.md`
- Wake-on-task live canary runbook: `packages/broker/docs/wake-on-task-live-canary-runbook.md`
- Live canary readiness libero: `docs/validation/live-canary-readiness-libero.md`
- R20 stability gate contract: `contracts/a2a/r20-stability-gate.md` (C1 no-live canary boundary)
- Team1/yukson Terminal Brief activation libero (R11): `docs/validation/team1-yukson-terminal-brief-activation-libero.md`
- A2A all-hands stability closeout gates: `docs/validation/a2a-allhands-stability-closeout-gates.md`

## Retry context: worker handler compat path repair

The prior run blocked on a worker handler compat path gap. The `createExternalWorkerHandler` and `createWorkerHandlerFromEnv` paths now correctly:

1. Apply task-scoped session isolation (`buildSessionIsolatedArgs`) when constructing external handler arguments, preventing history leakage between unrelated tasks.
2. Enforce `--session-id` derivation from the task record (`a2a-<nodeId>-<taskId>`) and reject forbidden shared session ids (`main`, `telegram`, `a2a-worker`, `openclaw-tui`, `agent`).
3. Route canary dispatch through the intent router, ensuring per-intent handler registration with fallback and `beforeHandle` validation.

This retry validates that the worker handler compat path repair does not weaken the canary hardening matrix.

## Canary hardening validation matrix

| Gate | Required hardening condition | Current evidence | Libero decision |
| --- | --- | --- | --- |
| C1. Receipt-gate canary completeness | All six receipt-gate scenarios must be covered with no-live semantics, deterministic verdicts, and operator-safe evidence summaries. | `RECEIPT_GATE_CANARY_SCENARIOS` covers `no_notification_configured`, `send_accepted_no_receipt`, `receipt_confirmed`, `send_failed`, `stale_timed_out`, and `duplicate_terminal_event`. Each fixture has an `expectedDecision` mapped to `hold_unacked`, `receipt_confirmed`, or `suppress_duplicate`. The test suite confirms `providerCalled=false` and `productionAckAttempted=false` for every cell. | **Pass.** Scenario count, verdict mapping, and no-live invariants are complete. Duplicate terminal event is correctly mapped to `suppress_duplicate` and `ackAllowed=false`. |
| C2. No-live activation boundary | `runMode` must be `"no-live"` in the canary matrix. Every cell must report `providerCalled: false` and `productionAckAttempted: false`. Default fixtures must not require credentials. | `runReceiptGateCanaryMatrix()` hardcodes `runMode: "no-live"` and the type enforces `providerCalled: false` and `productionAckAttempted: false`. `defaultReceiptGateCanaryFixtures()` requires no secrets, tokens, or live endpoints. The markdown renderer always includes "Run mode: no-live" and the safety assertion. | **Pass.** No-live boundary is type-level and test-verified. The matrix cannot accidentally switch to live mode without a type change. |
| C3. Session isolation & worker handler compat path | Every external worker handler invocation must use a task-scoped ephemeral session id derived from node + task. Shared/long-lived session ids must be rejected. | `validateSessionIsolation` detects missing `--session-id`, forbidden ids (`main`, `telegram`, `a2a-worker`, `openclaw-tui`, `agent`), and session id mismatch. `buildSessionIsolatedArgs` produces `--session-id a2a-<nodeId>-<taskId>`. `createWorkerHandlerFromEnv` in `worker.ts` constructs the handler with `buildSessionIsolatedArgs` when the handler compat path is used. The test suite verifies regression guards for missing isolation and shared session dispatch. | **Pass.** The worker handler compat path repair ensures task-scoped session ids propagate through `createExternalWorkerHandler`. Forbidden session ids are rejected at the validation layer. |
| C4. Intent-router canary dispatch | Canary dispatch must route through the intent router with per-intent handler registration and `beforeHandle` validation. Unmatched intents must fall back to a safe default (noop/no-change). | `createIntentRouter` registers per-intent handlers with `handlerMap`. Unmatched intents fall back to a `defaultHandler` that reports `"no handler registered for intent=..."`. `beforeHandle` supports pre-dispatch validation, abort via `TaskAssertionError`, and `withProposalContext` middleware. The test suite covers routing, fallback, beforeHandle abort, `assertProposalTask`, `assertWorkspaceTask`, and `assertPayloadField`. | **Pass.** Intent routing is deterministic and safe. Unmatched intents do not panic or produce misleading output. |
| C5. Broker rehearsal manifest integration | The rehearsal manifest must include the receipt-gate canary matrix, safety gates, and ack-audit decisions that reject `provider_send_success` as ACK evidence. | `buildBrokerRehearsalManifest` embeds `runReceiptGateCanaryMatrix()` output. Safety gates hardcode `false` for `productionDeploy`, `gatewayRestart`, `liveProviderSend`, `databaseMutation`, and `terminalOutboxAck`. `terminalOutboxReadinessGate.rejectedEvidence` includes `provider_send_success`. `ackAuditDecisions` marks `provider_sent` as `pending`/`ackAllowed=false` because "provider send-only success is not terminal ACK evidence". The operator summary includes the canary verdict. | **Pass.** The manifest correctly integrates the canary matrix and keeps all safety gates at `false`. Provider send success is explicitly rejected as ACK evidence. |
| C6. Terminal Brief activation gate separation | Activation gates must be separate from the canary validation. No-live canary success must not be treated as activation approval. Provider accepted-send must remain non-ACK. | The Terminal Brief activation report (R3) requires seven distinct gates (code merged, canary deployed, operator bridge enabled, one-shot fresh task sent, operator-visible receipt proven, manual ACK recorded, final no-live restoration). The activation report **returns `Block`** if any gate lacks bounded HTTP evidence. Activation and no-live status are separate. The R20 stability gate (C1.2) enumerates canary activation preconditions that require explicit operator approval separate from canary success. | **Pass.** No-live canary success does not authorize activation. The activation gate checklist maintains separation and requires operator approval. |
| C7. Provider accepted-send non-ACK boundary | No code, contract, or documentation must promote `providerMessageId`, `providerAccepted`, `sendStatus: accepted`, or `sendStatus: sent` to terminal-outbox ACK. | `receipt-gate-canary.ts` assigns `ackAllowed: false` for `no_notification_configured`, `send_accepted_no_receipt`, `send_failed`, `stale_timed_out`. Only `receipt_confirmed` has `ackAllowed=true`. `duplicate_terminal_event` has `ackAllowed=false`. The canary test asserts that `RECEIPT_GATE_CANARY_SCENARIOS` includes `send_accepted_no_receipt` with `decision: "hold_unacked"`. The rehearsal manifest `ackAuditDecisions` maps `provider_sent` to `pending`/`ackAllowed=false`. The R20 stability gate (C1.1) lists `provider accepted-send is non-ACK` as an invariant. | **Pass.** The non-ACK boundary is enforced at three levels: canary matrix, rehearsal manifest, and stability gate contract. |
| C8. Canary evidence hygiene | Operator-safe evidence summaries must not contain tokens, secrets, host-private paths, raw session dumps, or provider identifiers. Evidence output must be deterministic and redacted. | `summarizeFixture` in `receipt-gate-canary.ts` uses fixed template strings with no token/secret/credential fields. The markdown renderer includes `Run mode: no-live` and `providerCalled=false, productionAckAttempted=false`. The test suite asserts `renderReceiptGateCanaryMarkdown` output does not match `/token|secret|password|file:\/\//i`. The rehearsal manifest `safeEvidenceFields.forbidden` lists `rawPrompt`, `rawLogs`, `localPath`, `secrets`, and `providerSendOnlySuccess`. | **Pass.** Evidence summaries are deterministic, operator-safe, and redacted. The regex guard in tests prevents accidental secret inclusion in evidence output. |
| C9. Runtime/bootstrap hygiene | Branch diff, PR text, issue comments, and artifact evidence must exclude OpenClaw runtime/bootstrap context files and raw session dumps. | Intended patch is this validation document plus any companion test. Runtime/bootstrap guard paths (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`) are not part of the tracked diff. | **Pass if final diff stays limited to `docs/validation/` and optionally `scripts/`.** Fail closed before PR creation if any guard path or raw runtime transcript enters the branch or evidence. |

## Worker handler compat path repair validation

| Compat path component | Repaired behavior | Validation evidence | Decision |
| --- | --- | --- | --- |
| `createExternalWorkerHandler` | Accepts task-scoped `--session-id` via `buildSessionIsolatedArgs`; enforces timeout, exit code, stdout JSON parsing, and external error normalization. | `worker.ts` lines 309–404: spawn child process with isolated session args, parse stdout JSON, reject invalid/non-JSON output. `createWorkerHandlerFromEnv` builds from `WORKER_HANDLER_COMMAND`/`WORKER_HANDLER_ARGS_JSON` env vars. | **Pass.** External handler dispatch is deterministic, bounded, and session-isolated. |
| `createWorkerConfigFromEnv` | Reads canary/config env vars with correct fallback order (`WORKER_*`, then `A2A_WORKER_*`, then defaults). `handler` is constructed via `createWorkerHandlerFromEnv`. | `worker.ts` lines 363–394: `handlerTimeoutMs`, `pollIntervalMs`, `heartbeatIntervalMs` all have documented env var names with `A2A_` prefix fallback. `parseBuiltinWorkerHandlerKind` validates `noop`/`echo` only. | **Pass.** Config initialization has correct fallback order and type-safe defaults. |
| `validateSessionIsolation` | Detects missing `--session-id`, forbidden shared session ids, and session id mismatch. `buildSessionIsolatedArgs` produces correct canonical format. | `session-isolation.test.ts` covers derivation, forbidden id rejection, missing flag detection, and wrong-id detection. | **Pass.** Session isolation validation catches all known misconfiguration patterns. |
| `createIntentRouter` | Routes canary dispatch to correct intent handler; performs pre-dispatch validation via `beforeHandle`. | `intent-router.test.ts` covers routing, fallback, beforeHandle abort, proposal task assertions, workspace assertions, payload field assertions, and proposal context middleware. | **Pass.** Intent routing with pre-dispatch validation is fully tested. |

## Remaining gates before parent closeout (#364)

1. Ensure `docs/validation/team1-yukson-r27-canary-hardening-libero.md` passes CI and release-gate checks.
2. Confirm the worker handler compat path repair is reflected in all downstream integration tests (`npm test` in `packages/broker`).
3. Keep the aggregate verdict `NO-GO / Waiting` for live broker restart, deployment, live provider/Telegram send, production DB mutation, terminal-outbox ACK, source visibility expansion, or any production activation — these require separate explicit operator approval.
4. Before closing #364, confirm that `git diff --name-only -- AGENTS.md SOUL.md USER.md TOOLS.md HEARTBEAT.md IDENTITY.md .openclaw` returns no output from the branch.
5. Link the worker handler compat path PR or commit reference in the parent #364 closeout comment.

## Current aggregate decision

**Canary hardening validation matrix captured; R27 canary hardening round is `NO-GO / Waiting` for live activation.** The receipt-gate canary matrix, session isolation, intent router, rehearsal manifest integration, and worker handler compat path all pass libero validation. However, no-live canary success does not authorize live activation, terminal ACK mutation, or production deployment — those remain gated on separate explicit operator approval.

| Component | Gate | Libero decision |
| --- | --- | --- |
| Receipt-gate canary scenarios and verdicts | C1 | **Pass** |
| No-live activation boundary | C2 | **Pass** |
| Session isolation & worker handler compat path | C3 | **Pass** |
| Intent-router canary dispatch | C4 | **Pass** |
| Broker rehearsal manifest integration | C5 | **Pass** |
| Terminal Brief activation gate separation | C6 | **Pass** |
| Provider accepted-send non-ACK boundary | C7 | **Pass** |
| Canary evidence hygiene | C8 | **Pass** |
| Runtime/bootstrap hygiene | C9 | **Pass** (conditionally — verify at PR creation time) |

**Aggregate: `NO-GO / Waiting` for live activation.** This libero matrix validates canary hardening evidence; it does not authorize production impact.

## Safety confirmation

This validation used repository inspection and redacted GitHub issue metadata only. It did not perform production deploys, Gateway/broker/worker restarts, live provider or Telegram sends, production database mutations, terminal-outbox ACKs, secret rotations or disclosures, repository visibility changes, source-history imports, release publication, history rewrites, force pushes, raw secret disclosure, host-private path disclosure, or raw session dump publication.
