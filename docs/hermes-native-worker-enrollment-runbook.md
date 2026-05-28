# Hermes Native Worker Enrollment Runbook

> **Operator-facing enrollment runbook** for Gongyung/Daegyo-style Hermes Android/Termux
> native workers. Covers pre-enrollment prerequisites, step-by-step procedure,
> health/readiness checks, GO/NO-GO criteria, rollback/disable path, and evidence
> packet capture.
>
> **Issue:** [a2a-plane#504](https://github.com/jinwon-int/a2a-plane/issues/504)
> **Parent:** [a2a-plane#503](https://github.com/jinwon-int/a2a-plane/issues/503) — A2A Team1 roadmap wave 4
> **Broker/finalizer of record:** `seoseo`
>
> **Prerequisite documents:**
> - [Hermes/Android native worker runbook](hermes-android-native-worker-runbook.md) — loopback-only operation
> - [Hermes native worker conformance checklist](hermes-native-worker-conformance-checklist.md) — no-live conformance
> - [Gongyung Hermes lightweight worker profile spec](specs/gongyung-hermes-worker-profile/spec.md) — capability boundaries
> - [Hermes broker-agnostic worker contract spec](specs/hermes-worker-integration/spec.md) — HTTP contract
> - [No-live conformance fixture](../fixtures/native-worker/no-live-conformance.json) — baseline fixture
> - [Enrollment evidence fixture](../fixtures/native-worker/enrollment-evidence.json) — enrollment-specific fixture
> - [Platform adapter interface](../contracts/a2a/platform-adapter-interface.md) — broker-agnostic contract

---

## 1. Overview

This runbook covers **enrollment** of a Hermes native worker into a non-loopback
(production or staging) broker. "Enrollment" means:

1. The worker has passed all no-live conformance steps (see [prerequisite checklist](#2-pre-enrollment-prerequisites)).
2. The operator has reviewed and approved the enrollment decision via the GO/NO-GO matrix.
3. The worker transitions from loopback-only mode to a named production/staging broker URL.
4. A non-loopback enrollment evidence packet is recorded for auditability.

### 1.1 What enrollment means

| Change | Before enrollment | After enrollment |
|--------|------------------|-----------------|
| Broker URL | `http://127.0.0.1:<port>` (loopback) | Production/staging broker URL |
| `workerMode` | `mobile` (unchanged) | `mobile` (unchanged) |
| Task scope | No-live test tasks only | Live approved tasks per GO/NO-GO gate |
| Evidence | Loopback-validated fixtures | Production broker-visible evidence |
| Heartbeat target | Local broker | Production broker |
| Rollback capability | N/A (no production state) | Documented disable procedure (see §8) |
| Seoseo approval | Not required (no-live) | Required per GO/NO-GO matrix |

### 1.2 Safety boundary

- **No production deployment** of Gateway, broker, or worker is performed by this runbook.
- **No Gateway/broker/worker restart** is authorized.
- **No live provider/Telegram canary or notification send** is authorized.
- **No production DB mutation, prune, or migration** is authorized.
- **No terminal-outbox ACK or replay** is authorized.
- **No release, tag, or npm publish** is authorized.
- **No credential movement or secret disclosure** is authorized.
- **No repository visibility change** is authorized.
- Enrollment creates a **redacted evidence packet only** — no code, no state mutation.

---

## 2. Pre-Enrollment Prerequisites

**Before considering enrollment, the Hermes native worker must pass all no-live
conformance checks.** The operator validates the following:

### 2.1 No-live conformance

- [ ] Worker registration with loopback broker URL works (POST /workers/register → 201).
- [ ] Heartbeat succeeds with `runtime: hermes-agent` metadata (POST /workers/:id/heartbeat → 200).
- [ ] Task polling via broker-agnostic alias works (GET /tasks?worker=<nodeId>&status=pending → 200).
- [ ] Task claim, start, and execution complete successfully.
- [ ] Local redacted evidence manifest is written (schema `a2a.hermesWorker.localEvidence.v1`).
- [ ] Broker-visible terminal evidence posts successfully.
- [ ] Simulated network drop or process restart: worker re-registers on next loop.
- [ ] Unsafe tasks are rejected (admission function returns NO-GO).
- [ ] Evidence redaction rules are followed (no provider tokens, device IDs, private paths).

**Validation commands:**

```bash
# All no-live conformance checks
npm run check:native-worker-conformance
npm run check:hermes-reference-worker
npm run check:gongyung-hermes-worker-profile

# Current results must all be PASS
```

### 2.2 Reference fixture alignment

- [ ] Worker identity matches `fixtures/native-worker/no-live-conformance.json` worker definition.
- [ ] `capabilities` and `rejectedIntents` match the Gongyung profile.
- [ ] `registration` body matches `fixtures/contract/hermes-worker-registration.json` shape.
- [ ] Terminal evidence matches expected schema (see [conformance checklist §6](hermes-native-worker-conformance-checklist.md#6-broker-visible-result-evidence)).

### 2.3 Pre-enrollment evidence inventory

The operator collects the following evidence before enrolling:

| Evidence | Source | Status must be |
|----------|--------|----------------|
| No-live conformance test pass | `npm run check:native-worker-conformance` | All tests PASS |
| Loopback smoke test | `examples/workers/hermes-reference-worker/hermes-local-smoke-task.json` | Task `succeeded` |
| Redaction audit | Manual review of evidence manifests | No secrets found |
| Worker hardware info (redacted) | Device inspection | Device meets minimum specs |
| Pre-enrollment GO/NO-GO matrix (see §7) | This document | All GO gates pass |

---

## 3. Enrollment Preflight Checks

Run these checks immediately before any enrollment action. They confirm the
worker and broker are ready.

### 3.1 Worker readiness

```bash
# 1. Verify worker script and environment are current
python3 -m py_compile examples/workers/hermes-reference-worker/a2a_worker.py

# 2. Confirm reference worker dry-run mode does not require Gateway
grep 'gatewayRequired=false' examples/workers/hermes-reference-worker/README.md

# 3. Check local artifact directory exists and has correct permissions
ls -la ~/.hermes/a2a/artifacts/  # 0700 expected
```

### 3.2 Target broker readiness

The non-loopback broker must be reachable and healthy:

```bash
# 4. Broker health check
curl -s -o /dev/null -w '%{http_code}' <broker-url>/health
# Expected: 200

# 5. Verify broker accepts Hermes-style registration
curl -s -X POST <broker-url>/workers/register \
  -H 'Content-Type: application/json' \
  -d '{
    "nodeId": "enrollment-preflight-check",
    "role": "analyst",
    "displayName": "Enrollment Preflight Probe",
    "brokerUrl": "<broker-url>",
    "workerMode": "mobile",
    "capabilities": {"canAnalyze": true},
    "metadata": {"runtime": "hermes-agent", "openClawRequired": "false", "transport": "http-poll"}
  }'
# Expected: 201

# 6. Clean up preflight probe registration
curl -s -X DELETE <broker-url>/workers/enrollment-preflight-check
# Expected: 200 or 204
```

### 3.3 Enrollment environment

```bash
# 7. Verify env file exists with correct permissions
ls -la ~/.config/a2a/hermes-worker.env  # 600 expected

# 8. Confirm broker URL in env file is non-loopback and reachable
grep 'A2A_BROKER_URL' ~/.config/a2a/hermes-worker.env

# 9. Verify worker id is set
grep 'A2A_WORKER_ID' ~/.config/a2a/hermes-worker.env
```

**Preflight pass/fail:**

| Gate | Condition | Pass | Fail action |
|------|-----------|------|-------------|
| P1 | Worker script compiles | Python compile ok | Fix script; re-run |
| P2 | Worker does not require Gateway | README says `gatewayRequired=false` | Review worker config; block enrollment |
| P3 | Artifact directory exists with 0700 | `ls -la` shows directory | Create directory; set permissions |
| P4 | Broker health | HTTP 200 | Resolve broker availability |
| P5 | Broker accepts Hermes registration | HTTP 201 | Resolve broker compatibility |
| P6 | Preflight probe cleaned up | HTTP 200/204 on DELETE | Manual cleanup if needed |
| P7 | Env file secure | chmod 600 | Set permissions |
| P8 | Broker URL is non-loopback | Not `127.0.0.1` or `localhost` | Set correct URL |
| P9 | Worker ID is set | Non-empty value | Configure worker id |
| P10 | Worker has approved loopback conformance | All tests PASS from §2.1 | Complete conformance first |

**All preflight gates must pass before proceeding to §4.**

---

## 4. Enrollment Procedure

### 4.1 Operator approval gate

Before any enrollment action, the operator (Seoseo or delegate) must:

1. Review the [GO/NO-GO matrix](#7-go-no-go-matrix) and confirm all GO gates pass.
2. Post an explicit approval comment on the enrollment tracker issue
   (a2a-plane#504) naming the exact broker URL, worker ID, and enrollment scope.
3. Record the approval comment URL as enrollment evidence.

**Approval is separate from evidence.** A "Start" or "Done" comment is not
approval. The approval comment must contain the literal word "APPROVED" and
name the exact enrollment parameters.

### 4.2 Step-by-step enrollment

#### Step E1 — Record pre-enrollment state snapshot

```bash
cat > ~/.hermes/a2a/enrollment-$(date +%Y%m%dT%H%M%SZ).pre.json <<'SNAP'
{
  "schema": "a2a.hermesWorker.enrollmentPreSnapshot.v1",
  "workerId": "<worker-id>",
  "targetBrokerUrl": "<broker-url>",
  "enrollmentTimestamp": "<ISO-8601>",
  "preEnrollmentState": {
    "loopbackRegistrationExists": true|false,
    "conformanceTestsPassed": true,
    "conformanceEvidencePath": "~/.hermes/a2a/conformance/<latest>.json",
    "envFileSecure": true,
    "operatorApprovalCommentUrl": "<comment-url>"
  },
  "redactionStatement": "All device identifiers, provider tokens, and private paths redacted to <redacted>."
}
SNAP
```

#### Step E2 — Update env file for non-loopback broker

Edit `~/.config/a2a/hermes-worker.env` to update `A2A_BROKER_URL` to the
production/staging broker URL. Preserve all other values.

```bash
# Backup existing env file
cp ~/.config/a2a/hermes-worker.env ~/.config/a2a/hermes-worker.env.backup.$(date +%Y%m%dT%H%M%SZ)

# Edit env file — update A2A_BROKER_URL only
sed -i 's|^export A2A_BROKER_URL=.*$|export A2A_BROKER_URL=<production-broker-url>|' \
  ~/.config/a2a/hermes-worker.env

# Verify edit
grep '^export A2A_BROKER_URL=' ~/.config/a2a/hermes-worker.env
# Expected: export A2A_BROKER_URL=<production-broker-url>

chmod 600 ~/.config/a2a/hermes-worker.env
```

#### Step E3 — Register worker with target broker

```bash
A2A_BROKER_URL=<production-broker-url> \
python3 examples/workers/hermes-reference-worker/a2a_worker.py --action register
# Expected: registration confirmed or "already registered"
```

#### Step E4 — Verify registration persists

```bash
# Check broker-side worker record
curl -s <production-broker-url>/workers/<worker-id> | python3 -m json.tool
# Expected: 200 with worker metadata matching pre-enrollment snapshot
```

#### Step E5 — Start worker loop

```bash
# If using Termux:Boot, the boot script automatically starts.
# For manual start:
. ~/.config/a2a/hermes-worker.env
python3 ~/.local/share/a2a/hermes-worker/a2a_worker.py --action run-once

# Verify heartbeat
curl -s <production-broker-url>/workers/<worker-id>/heartbeat
# Expected: 200 with heartbeat metadata
```

#### Step E6 — Submit a test-only task (read-only, zero side effect)

Use the existing `hermes-local-smoke-task.json` fixture but **do not modify it**
for live mode. The purpose is to verify the enrollment pipeline end-to-end
without any live action:

```bash
# Submit the loopback-origin smoke task — it will be rejected by the
# Gongyung profile if it has Docker or "required" capabilities.
# Operator must verify the broker maps the worker alias correctly.

curl -s -X POST <production-broker-url>/tasks \
  -H 'Content-Type: application/json' \
  -H 'X-A2A-Requester-Id: <worker-id>' \
  -H 'X-A2A-Requester-Kind: node' \
  -H 'X-A2A-Requester-Role: operator' \
  -d '{
    "id": "hermes-enrollment-readiness-check",
    "assignedWorkerId": "<worker-id>",
    "targetNodeId": "<worker-id>",
    "payload": {
      "mode": "hermes-reference-dry-run",
      "noLive": true,
      "intent": "check_readiness",
      "task": "Verify Hermes worker enrollment readiness: confirm worker can poll, claim, provide evidence, and verify redaction rules."
    },
    "policyContext": {"liveImpact": false},
    "metadata": {"enrollmentCheck": true}
  }'

# Poll until terminal
# curl -s <production-broker-url>/tasks/hermes-enrollment-readiness-check
```

#### Step E7 — Capture enrollment evidence

```bash
cat > ~/.hermes/a2a/enrollment-$(date +%Y%m%dT%H%M%SZ).post.json <<'SNAP'
{
  "schema": "a2a.hermesWorker.enrollmentEvidence.v1",
  "workerId": "<worker-id>",
  "brokerUrl": "<production-broker-url>",
  "enrollmentTimestamp": "<ISO-8601>",
  "preEnrollmentSnapshot": "~/.hermes/a2a/enrollment-<timestamp>.pre.json",
  "postEnrollmentEvidence": {
    "registrationSucceeded": true,
    "heartbeatSucceeded": true,
    "readinessCheckTaskId": "hermes-enrollment-readiness-check",
    "readinessCheckStatus": "succeeded|blocked",
    "readinessCheckEvidencePath": "~/.hermes/a2a/artifacts/hermes-enrollment-readiness-check/evidence.json"
  },
  "operatorApprovalCommentUrl": "<comment-url>",
  "redactionStatement": "All device identifiers, provider tokens, and private paths redacted to <redacted>."
}
SNAP
```

---

## 5. Post-Enrollment Health Verification

After enrollment is complete, run these health checks:

### 5.1 Immediate checks

```bash
# 1. Worker is registered
curl -s <production-broker-url>/workers/<worker-id> | grep -q '"nodeId":"<worker-id>"'

# 2. Heartbeat timestamp is recent (within last 60 seconds)
curl -s <production-broker-url>/workers/<worker-id> | python3 -c "
import sys, json
w = json.load(sys.stdin)
print('heartbeat recent:', w.get('lastHeartbeat', 'never'))
"

# 3. Task polling works
curl -s "<production-broker-url>/tasks?worker=<worker-id>&status=pending" | python3 -c "
import sys, json
tasks = json.load(sys.stdin)
print('pending tasks:', len(tasks) if isinstance(tasks, list) else 'non-list response')
"

# 4. Evidence manifest is readable
ls -la ~/.hermes/a2a/artifacts/hermes-enrollment-readiness-check/evidence.json
cat ~/.hermes/a2a/artifacts/hermes-enrollment-readiness-check/evidence.json | python3 -m json.tool
```

### 5.2 Operator verification

| Check | Expected | Actual |
|-------|----------|--------|
| Registration persisted across restart (worker-side) | After Termux process restart, worker re-registers and heartbeats | Verify via broker |
| Registration persisted across broker restart (if applicable) | Broker retains worker state or can re-accept | Verify via broker |
| Backed-up env file intact | `~/.config/a2a/hermes-worker.env.backup.*` exists | `ls -la` |
| Worker log shows no errors | `~/.hermes/a2a/worker.log` tail | `tail -20` |
| No unexpected broker tasks created | Broker task list has only expected tasks | `curl <broker>/tasks?state=all` |

### 5.3 Warning signs

| Sign | Action |
|------|--------|
| Worker shows `offline` after 30s stale threshold | Check network connectivity and Doze mode; re-register if needed |
| Heartbeat returns 404 | Worker registration was lost; re-register |
| Task poll returns 4xx | Check task query parameter mapping on broker |
| Evidence post returns 4xx | Check evidence schema compatibility |
| Env file permissions changed from 600 | Reset to `chmod 600` |

---

## 6. Allowed and Rejected Task Classes

These tables are carried forward from the [no-live conformance checklist](hermes-native-worker-conformance-checklist.md#4-bounded-task-execution).
Enrollment **does not change** the allowed/rejected task classes. The Gongyung
profile is fixed; only scope of broker connectivity changes.

### 6.1 Allowed intents (worker may claim)

| Intent | Note |
|--------|------|
| `analyze` | Source-only analysis |
| `research` | Information retrieval (no live provider) |
| `report` | Document generation |
| `review` | Code/checklist review |
| `clarify` | Ambiguity resolution |
| `observe` | Read-only observation |
| `check_readiness` | Readiness gate evaluation |
| `cross_check` | Cross-referencing validation |
| `hermes-ops` | Hermes-specific operations |
| `canary` | No-live canary in approved scope |

### 6.2 Rejected intents (worker returns NO-GO)

| Intent | NO-GO reason |
|--------|-------------|
| `docker` | `gongyung_not_docker_runner` |
| `patch_repo` | `gongyung_not_docker_runner` |
| `build_repo` | `gongyung_not_docker_runner` |
| `test_repo` | `gongyung_not_docker_runner` |
| `split` | `mode_not_allowed` |
| `swarm_non_observe` | `mode_not_allowed` |

### 6.3 Rejected capabilities (task not claimed)

| Capability | Reason |
|------------|--------|
| `dockerRequired` | Gongyung has no Docker |
| `buildRequired` | Gongyung cannot build repos |
| `testRequired` | Gongyung cannot run test suites |
| `repoPatch` | Gongyung cannot push branches |
| `untrustedCode` | Gongyung is a lightweight runner |
| `dependencyHeavy` | Gongyung has minimal dependencies |
| `serviceRestart` | Gongyung has no service control |
| `brokerDBMutation` | Blocked by safety boundary |
| `credentialMovement` | Blocked by safety boundary |
| `productionACK` | Blocked by safety boundary |

---

## 7. GO/NO-GO Matrix

### 7.1 Required gates

The operator evaluates each gate before approving enrollment:

| # | Gate | Required condition | Evidence source | Fail-closed |
|---|------|-------------------|----------------|-------------|
| G1 | No-live conformance | All conformance tests PASS | `npm run check:native-worker-conformance` | NO-GO if any fail |
| G2 | Worker admission profile | Worker capabilities match Gongyung profile | Profile spec, conformance fixture | NO-GO if mismatch |
| G3 | Registration payload | Payload matches `fixtures/contract/hermes-worker-registration.json` shape | Fixture validation | NO-GO if shape differs |
| G4 | Evidence redaction | Evidence manifest passes redaction audit | Manual review | NO-GO if secrets found |
| G5 | Preflight all pass | 10 preflight gates (P1–P10) all GREEN | §3 checklist | NO-GO if any fail |
| G6 | Operator approval | Explicit "APPROVED" comment on enrollment issue | GitHub comment URL | NO-GO if missing |
| G7 | Env file backup | Pre-enrollment env file backed up | `ls ~/.config/a2a/*.backup.*` | NO-GO if no backup |
| G8 | Rollback procedure documented | This runbook §8 is complete | This document | NO-GO if rollback not documented |
| G9 | Non-loopback broker authorized | Broker URL is in approved list or separately authorized | Operator statement | NO-GO if unknown |
| G10 | Enrollment evidence captured | Both pre- and post-enrollment snapshots exist | File existence | NO-GO if missing |

### 7.2 Decision

| ALL gates GO | **GO** — Proceed with enrollment (§4) |
|---|---|
| One or more NO-GO | **NO-GO** — Document blockers, do not enroll |
| Safety violation (secret leak, 403, unauthorized action) | **BLOCKED** — Escalate to Seoseo immediately |

### 7.3 GO/NO-GO evidence packet

After the decision, capture the evidence packet:

```bash
cat > ~/.hermes/a2a/enrollment-go-nogo-$(date +%Y%m%dT%H%M%SZ).json <<'PKT'
{
  "schema": "a2a.hermesWorker.enrollmentGoNoGo.v1",
  "workerId": "<worker-id>",
  "targetBrokerUrl": "<broker-url>",
  "decisionTimestamp": "<ISO-8601>",
  "decision": "GO|NO_GO|BLOCKED",
  "gateResults": {
    "G1_noLiveConformance": "PASS|FAIL",
    "G2_workerProfile": "PASS|FAIL",
    "G3_registrationPayload": "PASS|FAIL",
    "G4_evidenceRedaction": "PASS|FAIL",
    "G5_preflightAllPass": "PASS|FAIL",
    "G6_operatorApproval": "PASS|FAIL",
    "G7_envBackup": "PASS|FAIL",
    "G8_rollbackProcedure": "PASS|FAIL",
    "G9_nonLoopbackAuthorized": "PASS|FAIL",
    "G10_enrollmentEvidence": "PASS|FAIL"
  },
  "blockers": [
    "<list of NO-GO gate IDs and reasons>"
  ],
  "operatorApprovalCommentUrl": "<comment-url>",
  "enrollmentSnapshotPreUrl": "~/.hermes/a2a/enrollment-<timestamp>.pre.json",
  "enrollmentSnapshotPostUrl": "~/.hermes/a2a/enrollment-<timestamp>.post.json",
  "redactionStatement": "All device identifiers, provider tokens, and private paths redacted to <redacted>.",
  "safetyConfirmation": {
    "noProductionDeploy": true,
    "noGatewayRestart": true,
    "noBrokerWorkerRestart": true,
    "noLiveProviderSend": true,
    "noDbMutation": true,
    "noTerminalAck": true,
    "noCredentialMovement": true,
    "noSecretDisclosure": true
  }
}
PKT
```

---

## 8. Rollback / Disable Path

### 8.1 When to rollback

Rollback is indicated when:

- Enrollment verification steps (Step E4–E7) reveal a problem.
- Worker cannot maintain heartbeat to the production broker.
- Worker inadvertently claims or starts an unsafe task (immediate rollback).
- Evidence manifest leaks secret values (immediate quarantine/rollback).
- Operator approval is revoked or discovered to be insufficient.
- Any BLOCKED condition is detected post-enrollment.

### 8.2 Rollback procedure

#### Step R1 — Stop worker loop

```bash
# Terminate the active loop (Ctrl+C or SIGTERM)
# If running via Termux:Boot:
#   comment out or remove ~/.termux/boot/a2a-hermes-worker
#   or add an early-exit guard

mkdir -p ~/.hermes/a2a/rollback
touch ~/.hermes/a2a/rollback/rolled-back-$(date +%Y%m%dT%H%M%SZ).marker
```

#### Step R2 — Notify broker (graceful unregister)

```bash
# The broker will mark the worker stale after 30s (no heartbeat) if
# explicit unregister is not available. For clean rollback, if the
# broker supports DELETE /workers/:id:

curl -s -X DELETE <production-broker-url>/workers/<worker-id>
# Expected: 200 or 204 (optional; 404 means already gone)
```

#### Step R3 — Restore env file from backup

```bash
# Restore the pre-enrollment env file
cp ~/.config/a2a/hermes-worker.env.backup.* ~/.config/a2a/hermes-worker.env

# Verify loopback URL is restored
grep '^export A2A_BROKER_URL=' ~/.config/a2a/hermes-worker.env
# Expected: http://127.0.0.1:<port> or original loopback URL

chmod 600 ~/.config/a2a/hermes-worker.env
```

#### Step R4 — Restart worker with loopback broker

```bash
# Verify worker can still register and heartbeat to the original loopback broker
A2A_BROKER_URL=http://127.0.0.1:<port> \
python3 examples/workers/hermes-reference-worker/a2a_worker.py --action register

A2A_BROKER_URL=http://127.0.0.1:<port> \
python3 examples/workers/hermes-reference-worker/a2a_worker.py --action run-once
```

#### Step R5 — Capture rollback evidence

```bash
cat > ~/.hermes/a2a/rollback/rollback-$(date +%Y%m%dT%H%M%SZ).json <<'RB'
{
  "schema": "a2a.hermesWorker.rollbackEvidence.v1",
  "workerId": "<worker-id>",
  "rolledBackFromBrokerUrl": "<production-broker-url>",
  "rollbackTimestamp": "<ISO-8601>",
  "rollbackReason": "<reason for rollback>",
  "stepsCompleted": [
    "R1 - stopped worker loop",
    "R2 - notified broker (graceful unregister)",
    "R3 - restored env file from backup",
    "R4 - verified loopback worker registration"
  ],
  "loopbackRecoverySuccess": true,
  "remainingEvidence": {
    "preEnrollmentSnapshot": "~/.hermes/a2a/enrollment-<timestamp>.pre.json",
    "postEnrollmentSnapshot": "~/.hermes/a2a/enrollment-<timestamp>.post.json",
    "enrollmentGoNogoPacket": "~/.hermes/a2a/enrollment-go-nogo-<timestamp>.json"
  },
  "redactionStatement": "All device identifiers, provider tokens, and private paths redacted to <redacted>.",
  "safetyConfirmation": {
    "noProductionDeploy": true,
    "noGatewayRestart": true,
    "noBrokerWorkerRestart": true,
    "noLiveProviderSend": true,
    "noDbMutation": true,
    "noTerminalAck": true,
    "noCredentialMovement": true,
    "noSecretDisclosure": true
  }
}
RB
```

### 8.3 Rollback invariants

During rollback, the operator must ensure:

1. **No evidence deletion.** Pre-enrollment, post-enrollment, and rollback
   evidence snapshots are preserved for audit.
2. **No comment deletion.** Rollback does not delete any GitHub comments.
   Post a follow-up comment explaining the rollback.
3. **No terminal-outbox mutation.** Rollback does not ACK, replay, or prune
   terminal-outbox rows.
4. **No provider send.** Rollback does not contact live providers.
5. **No DB mutation.** Rollback does not mutate broker storage.
6. **No restart of unrelated services.** Only the enrolled worker is affected.

### 8.4 Post-rollback state

After successful rollback:

| Aspect | State |
|--------|-------|
| Env file | Restored to pre-enrollment (loopback URL) |
| Worker loop | Stopped; can be restarted manually in loopback mode |
| Broker registration | Detached (worker offline, can be re-registered) |
| Enrollment evidence | Preserved under `~/.hermes/a2a/enrollment-*` |
| Rollback evidence | Preserved under `~/.hermes/a2a/rollback/rollback-*` |
| Heartbeat | Worker does not contact production broker |
| Task acceptance | All future claims use loopback broker only |

---

## 9. Android / Termux Caveats

Carried forward from no-live conformance with enrollment-specific additions:

### 9.1 Enrollment on Android

| Caveat | Enrollment-specific guidance |
|--------|------------------------------|
| **Doze mode** | Enrollment heartbeats may not arrive during Doze. Verify via broker that worker reconnects after Doze window. Set heartbeat interval below 30s stale threshold. |
| **Wake lock** | The Termux:Boot script must call `termux-wake-lock` before accessing the production broker URL. Enrollment test must verify wake lock is acquired. |
| **Network reconnect** | Enrollment assumes the worker can reach the production broker over the network. If using Tailscale or VPN, verify connectivity before proceeding to Step E3. |
| **Storage paths** | Enrollment evidence (`~/.hermes/a2a/enrollment-*.json`) must use 0700 permissions. Do not store enrollment evidence on shared Termux storage. |
| **Secret handling** | Enrollment env file (`~/.config/a2a/hermes-worker.env`) must remain `chmod 600`. Production broker URL is not a secret, but any edge secrets in the env file must follow existing redaction rules. |
| **Resource limits** | Enrollment may temporarily increase CPU/memory usage during health checks. Verify the worker can complete Step E6 within Termux resource limits. |
| **Boot persistence** | Enrollment does not change the boot script. If the boot script references `A2A_BROKER_URL`, verify the updated env file is sourced correctly after reboot. |
| **No Gateway** | Enrollment does not require Gateway on-device. Verify the worker can reach the production broker via HTTP polling without Gateway middleware. |
| **Battery optimization** | If enrolling a battery-constrained device, consider that production broker polling (every 20s) may have higher battery impact than loopback polling. Verify acceptable battery drain. |
| **Tunnel stability** | If the production broker requires a tunnel (Tailscale, ngrok, SSH), verify tunnel stays up for at least 60 minutes of uninterrupted heartbeat. A tunnel drop is not a rollback trigger by itself — the worker re-registers on reconnect. |

### 9.2 Enrollment-specific Android checks

```bash
# Verify wake lock is available
dumpsys power | grep -i "locks.*wake_lock" | head -1

# Verify broker reachability from the device
curl -s -o /dev/null -w '%{http_code}' --connect-timeout 5 <production-broker-url>/health

# Check battery status (non-redacted OK for local inspection)
termux-battery-status
```

---

## 10. Approval-Sensitive Boundaries

| Action | Status |
|--------|--------|
| Production deploy of Gateway, broker, or worker | ⛔ Requires separate operator approval from Seoseo |
| Gateway/broker/worker restart | ⛔ Requires separate operator approval |
| Live provider/Telegram canary or notification send | ⛔ Requires separate operator approval |
| Production DB mutation, prune, migration, replay | ⛔ Requires separate operator approval |
| Terminal-outbox ACK or replay | ⛔ Requires separate operator approval |
| Release, tag, or npm publish | ⛔ Requires separate operator approval |
| Credential movement or secret disclosure | ⛔ Requires separate operator approval |
| Repo visibility change or history rewrite | ⛔ Requires separate operator approval |
| PR merge | ⛔ Requires separate operator approval |
| Issue close/finalizer comment execution | ⛔ Requires separate operator approval |
| Force push | ⛔ Requires separate operator approval |
| **Enrollment preflight (read-only checks)** | ✅ Safe, no approval needed |
| **Enrollment evidence packet creation** | ✅ Safe, no approval needed |
| **Rollback procedure (if enrolled previously)** | ✅ Safe, no approval needed (emergency action) |
| **Enrollment ACT (broker URL change)** | ⛔ Requires explicit GO from matrix (§7) + operator approval |

---

## 11. Evidence Inventory

After completing enrollment (or rollback), the operator should have:

| File | Source | Purpose |
|------|--------|---------|
| `~/.hermes/a2a/enrollment-<timestamp>.pre.json` | Step E1 | Pre-enrollment state snapshot |
| `~/.hermes/a2a/enrollment-<timestamp>.post.json` | Step E7 | Post-enrollment state snapshot |
| `~/.hermes/a2a/enrollment-go-nogo-<timestamp>.json` | §7.3 | GO/NO-GO decision packet |
| `~/.hermes/a2a/rollback/rollback-<timestamp>.json` | §8.2 Step R5 | Rollback evidence (if applicable) |
| `~/.hermes/a2a/artifacts/hermes-enrollment-readiness-check/evidence.json` | Step E6 | Enrollment readiness task evidence |
| `~/.config/a2a/hermes-worker.env.backup.*` | Step E2 | Pre-enrollment env file backup |
| GitHub comment (operator approval) | §4.1 | `https://github.com/jinwon-int/a2a-plane/issues/504#issuecomment-*` |

---

## 12. Residual Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Worker cannot reach production broker | Medium (network/firewall) | Enrollment fails | Preflight check P4/P8/P9; rollback procedure |
| Worker claims unsafe task from production queue | Low (admission gate) | Unauthorized action | Admission function blocks unsafe intents (proven in no-live conformance) |
| Heartbeat timeout exposes enrollment to stale detection | Low (Doze/tunnel) | Broker marks worker offline | Worker re-registers on next loop; rollback not required |
| Evidence manifest leaks device identifier | Low (redaction audit prevents) | Secret exposure | Pre-enrollment G4 redaction audit; rollback if detected post-enrollment |
| Accidental enrollment to wrong broker URL | Medium (operator error) | Wrong target | Preflight P8 verifies URL; operator approval gate; env file backup |
| Rollback fails to restore loopback connectivity | Low (backup exists) | Worker cannot continue | R4 verification step confirms loopback recovery; manual fix if env backup is missing |

---

## 13. Related Documents

| Document | Relation |
|----------|----------|
| [Hermes/Android native worker runbook](hermes-android-native-worker-runbook.md) | Source-only operation (pre-enrollment baseline) |
| [Hermes native worker conformance checklist](hermes-native-worker-conformance-checklist.md) | No-live conformance validation |
| [Gongyung Hermes lightweight worker profile spec](specs/gongyung-hermes-worker-profile/spec.md) | Capability boundaries |
| [Hermes broker-agnostic worker contract spec](specs/hermes-worker-integration/spec.md) | HTTP contract |
| [No-live conformance fixture](../fixtures/native-worker/no-live-conformance.json) | Baseline fixture |
| [Enrollment evidence fixture](../fixtures/native-worker/enrollment-evidence.json) | Enrollment-specific fixture |
| [Platform adapter interface](../contracts/a2a/platform-adapter-interface.md) | Broker-agnostic contract |
| [Parent-round closeout go/nogo matrix](../contracts/a2a/parent-round-closeout-go-nogo-matrix.md) | Closeout decision framework |
| [Worker registration contract](../contracts/a2a/worker-registration.md) | Registration semantics |

---

## Safety Confirmation

This runbook documents the operator-facing Hermes native worker enrollment procedure.
It is **source/docs only**. It does not authorize:

- Production deployment or Gateway/broker/worker restart
- Live provider/Telegram canary or notification send
- Production DB mutation, prune, or migration
- Terminal-outbox ACK or replay
- Historical outbox replay
- Release, tag, or npm publish
- Credential movement or secret value disclosure
- Repository visibility change or history rewrite
- Force push or PR merge

Enrollment decision is **GO/NO-GO only** — it produces evidence, not production state.
The actual broker URL change (Step E2) requires operator approval per §4.1.
All evidence is redacted and stored locally with 0700 permissions.

*Seoseo remains Team1 broker/finalizer of record.*
