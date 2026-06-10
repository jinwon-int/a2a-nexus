# Phase 6c Runbook: Cross-node Wake-on-Task E2E Proof

> Status: draft
> Coordinator: node-remote
> Implementation owner: node-hub
> Tracks: jinwon-int/plugin-a2a#40
> Epic: jinwon-int/a2a-broker#39
> Author date: 2026-04-25
> Prereq: Phase 1–5 baseline green · Wake-on-Task feature flag available (default off)

---

## 1. Goal

Prove, end-to-end on two real nodes, that an accepted incoming A2A task wakes the target agent in **under one minute from accepted-at** without waiting for the normal proactive heartbeat cycle, and that the wake path does not multiply work under duplicate delivery or crash the baseline on failure.

Success is not "it wakes on my laptop." Success is a repeatable, instrumented procedure that two operators can run from different nodes and agree on the result.

## 2. Non-goals

- No production cutover. Flag stays default-off after this proof.
- No worker-gamma involvement. Regression lock preserved — worker-gamma neither sender nor receiver in any scenario here.
- No streaming status (Phase 7) or peer.status query (Phase 8) dependencies; this runbook self-contains observation.

## 3. Prerequisites

| Item | State |
|------|-------|
| Phase 1–5 baseline merged to main | required |
| A2A path (internal or standalone) operational between chosen pair | required |
| Wake-on-Task hook implemented by node-hub | required |
| Feature flag `a2a.wakeOnTask.enabled=true` available on both nodes | required |
| Neither node is worker-gamma | required |
| Both nodes have >5 min of clean audit log before start | required |
| Operator time sync: both nodes within ±500 ms (ntp verified) | required |

Canary pair: **node-remote (sender) ↔ node-hub (receiver)**. Secondary pair for confirmation: **worker-alpha ↔ worker-beta**.

## 4. Instrumentation points

The only way to measure sub-minute wake honestly is to tag and correlate four timestamps. All four must be recorded per trial:

| Stage | Name | Source | Clock |
|-------|------|--------|-------|
| T0 | `task.accepted` | broker audit event | broker |
| T1 | `wake.signal.sent` | sender-side hook log | broker or sender gateway |
| T2 | `wake.signal.received` | target gateway log | target |
| T3 | `agent.wake.started` | target agent runtime log | target |

Primary metric: `T3 - T0` (accepted → agent started). Targets:

- P50 ≤ 10 s
- P95 ≤ 30 s
- P99 ≤ 60 s (hard ceiling)

Secondary metrics: `T1 - T0` (broker → signal), `T3 - T2` (signal → runtime wake). These diagnose where delay lives.

## 5. Scenarios

### S1 — Cold wake (baseline)

Target agent is idle (no active session, last heartbeat ≥10 min ago).

Steps:
1. Verify target idle via audit log.
2. Sender creates task with trivial payload (e.g. echo).
3. Capture T0–T3.
4. Verify target completes task.
5. Check audit trail has exactly one `agent.wake.started` between T0 and T3.

**Pass**: `T3 - T0 ≤ 60 s`, task completes, exactly one wake recorded.

### S2 — Warm wake (target busy)

Target agent is currently running a long task.

Steps:
1. Start a 3-min no-op task on target.
2. 30 s into that task, sender creates a second task.
3. Observe that the second task either queues or wakes an additional concurrent slot per target's configured capacity.
4. Verify no duplicate agent instance is spawned for the same session.

**Pass**: second task serviced per capacity rules; no duplicate spawn on shared session.

### S3 — Duplicate delivery

Same logical task delivered twice (simulating broker retry).

Steps:
1. Sender creates task T.
2. Immediately after T0, sender re-submits the same idempotency key.
3. Observe target receives delivery but does not start a second agent run.
4. Verify broker returns "duplicate, existing task_id" response.

**Pass**: only one `agent.wake.started` event; broker reports duplicate.

### S4 — Wake-path failure with fallback

Wake hook is intentionally broken on target (e.g. hook binary moved, or injected fault flag `a2a.wakeOnTask.testFaultInject=true`).

Steps:
1. Enable fault injection on target.
2. Sender creates task.
3. Observe `wake.signal.sent` occurs but `agent.wake.started` does not within 30 s.
4. Verify target's next scheduled heartbeat (or ≤2 min later) drains the queue and runs the task.
5. Verify audit trail shows both the failed-wake record and the heartbeat-fallback record.

**Pass**: task completes via heartbeat fallback within heartbeat interval; failure is visible in audit.

### S5 — Target unreachable

Target gateway is down at the time of send.

Steps:
1. Stop target gateway.
2. Sender creates task.
3. Verify broker reports `accepted` but `delivery=deferred` with reason.
4. Restart target gateway.
5. Verify task is delivered and completed on next reconnect.

**Pass**: no data loss; task eventually runs; sender sees a clear unreachable→recovered transition.

## 6. Failure modes to catch

These are **fail-the-run** conditions, not merely warnings:

- Duplicate agent spawn on same session → fail S3.
- Wake hook starts a second agent process on a node that already has one running for the same session → fail S2.
- Baseline heartbeat loop stops firing after wake hook is enabled → fail (regression on baseline path).
- Audit trail missing any of T0/T1/T2/T3 for a trial → fail (can't measure).
- Target exceeds memory/CPU budget during S2 due to wake storm → fail.
- Any worker-gamma audit event appears during the run → abort immediately.

## 7. Procedure

### 7.1 Pre-run (both operators)

1. Confirm Phase 1–5 baseline green tag is deployed.
2. Confirm `a2a.wakeOnTask.enabled=true` on both nodes (scoped to this run).
3. Start a clean audit capture: `openclaw audit tail --since=now > /tmp/phase-6c-run.log` on both nodes.
4. Record: operator ids, node versions, broker version, timestamp.

### 7.2 Run

Execute S1 → S5 in order. Between scenarios, wait ≥2 min to let audit timestamps separate cleanly.

For each scenario, record:
- Scenario id
- Trial number (run each scenario 5× for statistical sense)
- T0, T1, T2, T3
- Pass/fail
- Notes

Minimum trials for gate: **5 per scenario × 5 scenarios = 25 trials**, all on the canary pair. Repeat once on the secondary pair for a second opinion (25 more). Total: 50 trials recorded.

### 7.3 Post-run

1. Stop audit capture on both nodes.
2. Compute P50/P95/P99 of `T3 - T0` over S1 and S2 trials (S3–S5 are not latency-graded).
3. Write results table into this runbook's companion file `phase-6c-wake-on-task-results.md`.
4. Post results summary as comment on issue #40 with one status marker (`Done` if all pass, `Block` if any scenario fails).
5. Disable feature flag on both nodes after results recorded.

## 8. Rollback

If any scenario fails, or if baseline heartbeat path shows any regression during the run:

1. Immediately set `a2a.wakeOnTask.enabled=false` on both nodes.
2. Restart both gateways.
3. Verify baseline heartbeat loop resumes (two consecutive heartbeats on each node).
4. Post `Block` on issue #40 with scenario id, observed timestamps, and suspected cause.
5. Pair back up once node-hub has a fix; re-run from scratch (no partial credit for prior trials).

Rollback takes priority over diagnosis. Collect logs after rollback, not during.

## 9. Out-of-scope for this runbook

- Wake-on-Task implementation details (owned by node-hub, tracked in #38, #39).
- Multi-hop wake (A wakes B which wakes C) — explicitly excluded; single hop only.
- Cross-cloud or cross-continent latency characterization — our nodes are close enough that if we can't hit 60 s, the bug is in the code path, not the network.
- Load testing (>1 task/sec per target) — Phase 6 is about correctness, not throughput.

## 10. Acceptance mapping

From `jinwon-int/plugin-a2a#40`:

- [x] E2E test or reproducible runbook exists → this document
- [ ] Healthy host-class nodes demonstrate sub-minute wake → executes in §7, records in results companion
- [ ] Duplicate wake prevention is demonstrated → S3
- [ ] Failure fallback is demonstrated → S4

Runbook-level checklist satisfied; executed trials land in `phase-6c-wake-on-task-results.md` once node-hub's implementation lands and Phase 1–5 is green.
