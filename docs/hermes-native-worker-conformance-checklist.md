# Hermes Native Worker Conformance Checklist

Operator-facing acceptance path for Gongyung/Daegyo-style Hermes Android/Termux
native workers. This checklist builds on:

- [Hermes broker-agnostic worker contract](specs/hermes-worker-integration/spec.md) (a2a-plane#435 (internal tracker, private))
- [Hermes reference worker dry-run](specs/hermes-worker-integration/plan.md) (Phase 2, #441)
- [Gongyung Hermes lightweight worker profile](specs/gongyung-hermes-worker-profile/spec.md) (#393)
- [Hermes/Android native worker runbook](hermes-android-native-worker-runbook.md)
- [No-live conformance fixture](../fixtures/native-worker/no-live-conformance.json)

## Safety preamble

All checks in this document are **no-live**: they use only loopback broker URLs,
public-safe test fixtures, and no production infrastructure. No deploy, restart,
provider send, DB mutation, Terminal Brief ACK/replay, release/tag, secret
movement, or force-push occurs during these checks.

Live enrollment requires a separately approved canary packet and human operator
approval from Seoseo.

---

## 1. Registration

### 1.1 Payload shape

- [ ] Registration body contains `nodeId`, `role`, `displayName`, `brokerUrl`,
      `workerMode`, `capabilities`, and `metadata`.
- [ ] `workerMode` is `mobile`.
- [ ] `metadata.runtime` is `hermes-agent`.
- [ ] `metadata.openClawRequired` is `"false"`.
- [ ] `metadata.transport` is `http-poll`.
- [ ] `brokerUrl` is `http://127.0.0.1:<port>` or a loopback Tailscale address.
      **Non-loopback URLs are blocked** unless `A2A_HERMES_REFERENCE_ALLOW_NON_LOOPBACK=1`
      with separate operator approval.
- [ ] No provider tokens, device identifiers, private paths, or credentials
      appear in registration metadata.

**Reference:** `fixtures/contract/hermes-worker-registration.json`

**Test:** `node --test scripts/check-hermes-reference-worker.test.mjs`

### 1.2 Broker acceptance

- [ ] `POST /workers/register` returns 201 with a worker record.
- [ ] The broker stores the worker without requiring OpenClaw-specific fields.
- [ ] `GET /workers/:nodeId` returns the registered worker's data.

---

## 2. Heartbeat / Reconnect

- [ ] `POST /workers/:nodeId/heartbeat` returns 200.
- [ ] Heartbeat metadata includes `runtime: hermes-agent` and `heartbeat: ok`.
- [ ] After a simulated network drop or process restart, the worker re-registers
      and resumes heartbeat on the next loop iteration.
- [ ] Heartbeat stale threshold is 30 seconds (`workerMode: mobile`).
- [ ] Termux:Boot boot script (`.termux/boot/a2a-hermes-worker`) acquires wake
      lock before network access.

**Reference:** `docs/hermes-android-native-worker-runbook.md`

**Android caveats:**
- Doze suspends network between heartbeats. Accept stale responses.
- The re-registration-repoll pattern is by design: each loop iteration is
  self-contained.

---

## 3. Task Polling

- [ ] `GET /tasks?worker=<nodeId>&status=pending` returns 200.
- [ ] The broker maps `worker=<nodeId>` to `assignedWorkerId=<nodeId>`.
- [ ] The broker maps `status=pending` to the internal queued status.
- [ ] Empty response arrays are normal (no pending tasks).
- [ ] Poll loop sleep of 20 seconds is acceptable for mobile nodes.

---

## 4. Bounded Task Execution

### 4.1 Task admission

- [ ] Only tasks with allowed intents are claimed: `analyze`, `research`,
      `report`, `review`, `clarify`, `observe`, `check_readiness`,
      `cross_check`, `hermes-ops`, `canary`.
- [ ] Tasks with Docker runner indicators (`executorMode=docker`,
      `runnerScope=all-github`, etc.) are **not** claimed; a NO-GO signal
      is returned with reason `gongyung_not_docker_runner`.
- [ ] Tasks requiring `dockerRequired`, `buildRequired`, `testRequired`,
      `repoPatch`, `untrustedCode`, `dependencyHeavy`, `serviceRestart`,
      `brokerDBMutation`, `credentialMovement`, or `productionACK` are
      rejected or handed off.

**Reference:** `docs/specs/gongyung-hermes-worker-profile/spec.md`

**Test:** `node --test scripts/check-gongyung-hermes-worker-profile.test.mjs`

### 4.2 Task lifecycle

- [ ] `POST /tasks/:id/claim` returns 200 (worker claims the task).
- [ ] `POST /tasks/:id/start` returns 200 (worker starts execution).
- [ ] The worker executes a bounded handler: no Docker, no GitHub push,
      no live provider contact, no DB mutation.
- [ ] Handler output is deterministic for a given input.

---

## 5. Local Redacted Evidence Manifest

- [ ] Before network evidence submission, the worker writes
      `~/.hermes/a2a/artifacts/<task-id>/evidence.json`.
- [ ] The evidence file follows schema `a2a.hermesWorker.localEvidence.v1`.
- [ ] Required fields: `taskId`, `workerId`, `status`, `redactionStatement`,
      `timestamp`.
- [ ] `status` is one of `accepted`, `rejected`, or `handoff`.
- [ ] All device identifiers, provider tokens, private paths, and raw session
      dumps are redacted to `<redacted>`.
- [ ] `nodeId` (`gongyung`), outcome, summary, artifact paths, and profile
      metadata are kept as safe evidence content.
- [ ] Artifact root uses 0700 permissions (private to Termux user).
- [ ] The manifest is readable by the operator for offline review.

**Reference:** `docs/hermes-android-native-worker-runbook.md`

**Redaction rules detail:**

| Must redact | Must keep |
|-------------|-----------|
| IMEI, Android ID, device serial, hardware UUID | `nodeId` (public-safe handle) |
| Tailscale node key, MAC addresses | Outcome, summary |
| Provider tokens, API keys, edge secrets | Artifact paths, artifact kinds |
| Raw session dumps, execution trace IDs | Profile metadata (`gongyungProfile`, `termux-hermes`) |
| `~/.config/a2a/hermes-worker.env` contents | Commit SHAs, repo-relative paths |
| Private Termux paths (`/data/data/com.termux/...`) | `manifest ok` or failure description |

---

## 6. Broker-Visible Result Evidence

- [ ] `POST /tasks/:id/evidence` with `outcome: "done"` returns 200.
- [ ] The task transitions to `succeeded` on the broker.
- [ ] `POST /tasks/:id/evidence` with `outcome: "blocked"` returns 200 and the
      task transitions to `failed`.
- [ ] Evidence body contains `workerId`, `outcome`, `result.summary`,
      `result.output.gongyungProfile`, and `result.artifacts`.
- [ ] `result.output.openClawRequired` is `false`.
- [ ] `result.output.runtimeFlavor` is `termux-hermes`.
- [ ] `result.output.profileVersion` is `1`.
- [ ] Each artifact entry has `path`, `kind`, and `redacted` fields.
- [ ] Evidence does **not** include `outcome: "pr"` (Gongyung cannot push
      branches).

**Reference:** `docs/specs/gongyung-hermes-worker-profile/spec.md`

**Test:** `node --test scripts/check-hermes-reference-worker.test.mjs`

---

## 7. No-Live / Canary Separation

- [ ] All steps above use only loopback broker URLs and no-live task fixtures.
- [ ] Live enrollment checks are **explicitly separated** into a future canary
      approval gate.
- [ ] The fixture at `fixtures/native-worker/no-live-conformance.json` declares
      `safety.liveRegistration: false` and `safety.nonLoopbackBrokerContact: false`.
- [ ] No credential movement, provider send, or terminal ACK occurs.

---

## 8. Terminal Brief / Receipt Safety

- [ ] The worker does **not** ACK Terminal Brief rows, replay providers, prune
      state, or mutate broker storage.
- [ ] "Provider accepted" evidence is telemetry only, not a terminal ACK.
- [ ] Final count (`N/N`) is closeout input only, not an irreversible action
      by itself.

**Reference:** `docs/specs/hermes-worker-integration/spec.md`

---

## 9. Admission Validation (Gongyung Profile)

- [ ] `admit()` returns `{ ok: true }` for allowed intents.
- [ ] `admit()` returns `{ ok: false, noGoSignal: { reason: "gongyung_not_docker_runner" } }`
      for Docker runner indicators (checked first).
- [ ] `admit()` returns NO-GO for rejected intents and capabilities.
- [ ] `admit()` returns NO-GO for unknown intents (fail-closed default).
- [ ] `admit()` returns NO-GO when `maxConcurrentTasks` would be exceeded.
- [ ] Evidence manifest validation fails structured when required fields are
      missing or redaction rules are violated.

**Reference:** `docs/specs/gongyung-hermes-worker-profile/spec.md`
**Test:** `node --test scripts/check-gongyung-hermes-worker-profile.test.mjs`
**Plugin test:** `npx node --test packages/openclaw-plugin-a2a/tests/gongyung-worker-profile-admission.test.ts`

---

## 10. Full Conformance Run

### Prerequisites

```bash
# Local broker
cd packages/broker
HOST=127.0.0.1 PORT=18787 \
PUBLIC_BASE_URL=http://127.0.0.1:18787 \
STATE_FILE=.local/hermes-reference-worker-state.json \
STALE_REAPER_ENABLED=0 \
npm run start
```

### Run all Hermes native worker checks

```bash
# Reference worker static checks
node --test scripts/check-hermes-reference-worker.test.mjs

# Gongyung profile static checks
node --test scripts/check-gongyung-hermes-worker-profile.test.mjs

# Native worker conformance fixture checks
node --test scripts/check-native-worker-conformance.test.mjs

# Gongyung admission tests (requires package build)
cd packages/openclaw-plugin-a2a && npx node --test tests/gongyung-worker-profile-admission.test.ts
```

### Local loopback smoke test

```bash
# Terminal 1: start broker
cd packages/broker
HOST=127.0.0.1 PORT=18787 PUBLIC_BASE_URL=http://127.0.0.1:18787 \
STATE_FILE=.local/hermes-reference-worker-state.json \
STALE_REAPER_ENABLED=0 \
npm run start

# Terminal 2: register worker, submit task, run worker, verify
A2A_BROKER_URL=http://127.0.0.1:18787 \
python3 examples/workers/hermes-reference-worker/a2a_worker.py --action register

curl -s -X POST http://127.0.0.1:18787/tasks \
  -H 'Content-Type: application/json' \
  -H 'X-A2A-Requester-Id: local-operator' \
  -H 'X-A2A-Requester-Kind: node' \
  -H 'X-A2A-Requester-Role: operator' \
  -d @examples/workers/hermes-reference-worker/hermes-local-smoke-task.json

A2A_BROKER_URL=http://127.0.0.1:18787 \
python3 examples/workers/hermes-reference-worker/a2a_worker.py --action run-once

curl -s http://127.0.0.1:18787/tasks/hermes-local-smoke-1 \
  -H 'X-A2A-Requester-Id: local-operator' \
  -H 'X-A2A-Requester-Kind: node' \
  -H 'X-A2A-Requester-Role: operator'
```

Expected: `hermes-local-smoke-1` reaches `succeeded` with redacted Hermes
reference Done evidence.

---

## Approval-Sensitive Boundaries

| Action | Status |
|--------|--------|
| Production deploy | ⛔ Requires separate operator approval |
| Gateway/broker/worker restart | ⛔ Requires separate operator approval |
| Live provider/Telegram canary | ⛔ Requires separate operator approval |
| DB mutation/prune/migration/replay | ⛔ Requires separate operator approval |
| Manual Terminal Brief ACK/replay | ⛔ Requires separate operator approval |
| Release/tag/npm publish | ⛔ Requires separate operator approval |
| Credential movement/secret disclosure | ⛔ Requires separate operator approval |
| Repo visibility change/history rewrite | ⛔ Requires separate operator approval |
| PR merge | ⛔ Requires separate operator approval |
| Issue close/finalizer comment execution | ⛔ Requires separate operator approval |
| Force push | ⛔ Requires separate operator approval |
| **Conformance checklist read-only run** | ✅ Safe, no approval needed |
| **Local loopback smoke test** | ✅ Safe, no approval needed |
| **Fixture creation and static tests** | ✅ Safe, no approval needed |

---

## Risk Notes

- This checklist covers **no-live conformance only**. Live enrollment requires
  a separate canary approval packet and Seoseo as finalizer.
- Gongyung runs on Android Termux with no Docker, no GitHub push, and limited
  memory. Heavy, build, or patch tasks must be rejected or handed off.
- Secret values must never appear in docs, fixtures, tests, evidence, or chat.
  The fixture at `fixtures/native-worker/no-live-conformance.json` contains
  zero secret values.
- Android Doze and Termux resource limits mean the worker may be slow or
  temporarily unreachable. This is expected for `workerMode: mobile`.
- Termux:Boot scripts are device-dependent; test on each target device.

---

## Conformance Evidence Capture

After a successful conformance run, capture:

1. Exit code of each `node --test` command.
2. `curl` response for `GET /tasks/hermes-local-smoke-1` showing `succeeded`.
3. Contents of `~/.hermes/a2a/artifacts/hermes-local-smoke-1/evidence.json`
   (redacted).
4. `git diff --check` output.
5. `npm run check:hermes-reference-worker` output.
6. `npm run check:gongyung-hermes-worker-profile` output.
7. `npm run check:native-worker-conformance` output.

Store evidence under `~/.hermes/a2a/conformance/` with ISO-8601 timestamp.
Do not paste raw evidence into GitHub issues or PRs — use redacted summaries.

---

*This checklist is source-only and produces no production state. Seoseo
remains Team1 broker/finalizer of record.*
