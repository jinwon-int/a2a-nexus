# Operator Install and Configuration Checklist

Plugin: `a2a-broker-adapter` (plugin-a2a)
Release-readiness lane: Team1/2
Parent: a2a-plane#453 (internal tracker, private) (a2a-plane#453, internal tracker private)

This document provides a step-by-step operator checklist for installing,
configuring, and diagnosing the A2A broker adapter plugin. It consolidates
the safety boundaries, diagnostics commands, and verification procedures
from the broader `docs/` tree into one operator-facing reference.

---

## 1. Prerequisites

Before installing the plugin, verify:

- [ ] **OpenClaw Gateway** is running (minimum baseline matching the
      [compatibility matrix](./compatibility-matrix.md)).
- [ ] **a2a-broker** is deployed and reachable. The plugin does not control
      the broker; see the `a2a-broker` project for broker deployment steps.
- [ ] **Node.js ≥ 20** is available (the plugin builds from TypeScript source).
- [ ] **OpenClaw** is installed globally or resolvable as a peer dependency
      (`npm ls -g openclaw` or equivalent).
- [ ] The deploying operator has reviewed the **alpha boundaries**
      ([`docs/alpha-boundaries.md`](./alpha-boundaries.md)) and accepts that
      breaking changes are expected during alpha.

---

## 2. Plugin Installation

The plugin is **unpublished** (`"private": true` in `package.json`). There is
no `npm install plugin-a2a` path. Install from source:

```bash
# Clone the repository
git clone https://github.com/jinwon-int/plugin-a2a.git
cd plugin-a2a

# Install dependencies
npm ci

# Build the plugin (TypeScript → dist/)
npm run build
```

**Termux/Android note:** On Termux, the `openclaw` peer dependency may need a
symlink workaround. See the [Termux notes](../README.md#android--termux-validation-note)
in `README.md` for details.

---

## 3. Plugin Configuration Checklist

Add the plugin entry to the Gateway config (`openclaw.plugins.entries`):

```json
{
  "plugins": {
    "entries": {
      "a2a-broker-adapter": {
        "enabled": true,
        "config": {
          "baseUrl": "https://broker.example.test",
          "edgeSecret": "${A2A_EDGE_SECRET}",
          "requester": {
            "id": "openclaw-operator",
            "kind": "service",
            "role": "operator"
          },
          "operatorEvents": {
            "enabled": false,
            "notification": {
              "enabled": false
            }
          },
          "wakeOnTask": {
            "enabled": false
          }
        }
      }
    }
  }
}
```

### Checklist

- [ ] **`baseUrl`** — Points to the running a2a-broker HTTP(S) endpoint. Use
      `https://broker.example.test` in shared docs; never paste production URLs.
- [ ] **`edgeSecret`** — Optional `x-a2a-edge-secret` header value. Use an
      environment variable reference like `${A2A_EDGE_SECRET}` in config files;
      never record the literal secret in code or docs.
- [ ] **`requester.id` / `kind` / `role`** — Identity sent as `x-a2a-requester-*`
      headers to the broker. Valid `kind` values: `session`, `node`, `user`,
      `service`. Valid `role` values: `hub`, `live-trader`, `researcher`,
      `analyst`, `operator`.
- [ ] **`operatorEvents.enabled`** — Defaults to `false` (permanent safety
      default). Set to `true` only when the operator event bridge (SSE) is
      needed for `a2a.monitor.status` rich diagnostics.
- [ ] **`operatorEvents.notification.enabled`** — Defaults to `false`
      (permanent safety default). **Must remain `false`** unless the operator
      has explicitly approved live notification delivery. See §7 (Approval
      Gates) below.
- [ ] **`wakeOnTask.enabled`** — Defaults to `false` (opt-in experimental
      feature). Leave `false` unless the wake path has been validated.
- [ ] **`noDuplicateSend.enabled`** — Defaults to `true` (fail-closed hardened
      gate). Keep this default to prevent duplicate broker task creation from
      replay-prone callsites.

---

## 4. Verification: Diagnostics Commands

Once configured, use these diagnostics surfaces to verify the plugin is working
correctly. All commands are read-only RPC calls to the Gateway — they do not
send live messages, restart the Gateway, or ACK terminal outbox records.

### 4.1 `a2a.monitor.status` — Full operator status projection

Fetches broker diagnostics, live-readiness state, receipt gap projections, and
no-live rehearsal state in one projection.

```json
{
  "method": "a2a.monitor.status"
}
```

The response includes:

| Block | Purpose |
|-------|---------|
| `health` | Broker health metadata (version, revision, latency) |
| `noLiveRehearsal` | Dry-run projection status (`ready` / `blocked`) with receipt states |
| `liveReadiness` | Canary evidence acceptance, queue signals, and overall readiness |
| `terminalReceiptGaps` | Per-outbox receipt gap projections separating provider delivery from operator receipt |
| `runtimeOwner` | Broker runtime-owner metadata for operator context |
| `buildInfo` | Broker build version and revision |

### 4.2 `a2a.monitor.status` (preflight mode) — No-live operator notification preflight

Pass `operatorEvents.preflight=true` to run a no-live notification preflight
that checks the four readiness layers without sending a message or ACKing
terminal outbox:

```json
{
  "method": "a2a.monitor.status",
  "params": {
    "operatorEvents": {
      "preflight": true
    }
  }
}
```

The response carries `kind: "a2a.operator.notification.preflight"`,
`decision: "GO" | "BLOCK"`, `safeToRestartGateway`, and per-layer check
results. It always reports `liveSendPerformed=false`,
`providerSendPerformed=false`, and `terminalOutboxAckPerformed=false`.

Pass proposed `operatorEvents.enabled` / `operatorEvents.notification` values
to test a canary config before deployment:

```json
{
  "method": "a2a.monitor.status",
  "params": {
    "operatorEvents": {
      "preflight": true,
      "enabled": true,
      "notification": {
        "enabled": true,
        "channel": "telegram",
        "to": "operator-chat"
      }
    }
  }
}
```

### 4.3 `a2a.monitor.status` (single task diagnostics)

Pass a `taskId` to get diagnostics and receipt gaps for a specific broker task:

```json
{
  "method": "a2a.monitor.status",
  "params": {
    "taskId": "task-xxx"
  }
}
```

### 4.4 `a2a.alerts.list` — Operator alerts

Fetches operator-facing alerts from the broker diagnostics surface. Use this to
check for unresolved warnings, bottleneck indicators, or recovery signals.

### 4.5 `a2a.task.status` — Task-level status

Fetches the status of a specific A2A task, returning `executionStatus`,
`deliveryStatus`, broker error codes, and operator-facing summary fields.

### 4.6 Public-readiness scan (pre-commit guard)

```bash
npm run scan:public-readiness
```

Scans all tracked files for:
- Raw API keys / token patterns (§5.1)
- Non-example broker URLs (§5.2)
- Numeric Telegram chat IDs (§5.3)
- Raw `edgeSecret` literal values (§5.4)
- Live notification target configs (§5.5)
- OpenClaw runtime/bootstrap context file leakage (§5.6)

Returns exit code 0 (clean) or 1 (findings = Block evidence). **Must pass**
before any PR is created.

### 4.7 Conformance smoke gate

```bash
npm run smoke:a2a-conformance
```

Runs the conformance smoke gate suite against the plugin's built entry point.
Exercises receipt-runtime boundary, no-live-send guarantees, and safe-operation
projections without connecting to a live broker.

---

## 5. Requester-Visible Diagnostics

The diagnostics commands in §4 expose different detail levels depending on
the audience. The following table documents what is requester-visible vs
operator-only for each principal diagnostics surface.

### 5.1 Visibility by diagnostics surface

| Surface | Requester sees | Operator additionally sees |
|---------|---------------|---------------------------|
| `a2a.monitor.status` | Plugin health, health summary string, broker connectivity, no-live rehearsal `ready`/`blocked`, receipt gap summary (status + label only), operator alerts | Full per-invariant safety breakdown, raw terminal-outbox cursor positions, runtime adapter metadata, terminalOutboxAllowedIds, full health detail, broker build info |
| `a2a.monitor.status` (preflight mode) | `decision: "GO" | "BLOCK"`, `safeToRestartGateway`, `liveSendPerformed=false`, `providerSendPerformed=false`, `terminalOutboxAckPerformed=false` | Full per-layer preflight detail with adapter resolution reason, full storage/state projection |
| `a2a.task.status` | `executionStatus`, `deliveryStatus`, operator-facing summary | Broker internal error details, raw broker response, retry/fan-out metadata |
| `a2a.alerts.list` | Alert kind + operator-facing message | Raw alert payload + broker-provided debug context |
| GO/NO-GO projection (status card) | `goNoGo`, `title`, `summary`, `rationale` (redacted), `requiredActions` (blocking only) | `reasonCategory`, `pluginHealth` detail, full `requiredActions` with advisory items, `warnings`, `safetyConfirmation`, `executionStatus` projection, full `metadata` |

### 5.2 What requester-visible diagnostics never expose

- Raw session keys (always replaced by `safeSessionKeyLabel()` → `<missing>` / `<empty>` / `<present>`)
- Provider message IDs without redaction
- Broker edge secrets, tokens, or credential values
- Internal stack traces or runtime host paths
- Terminal-outbox cursor positions (operator-only)
- `terminalOutboxAllowedIds` or cursor allowlist values
- Runtime adapter or channel adapter internals

### 5.3 Diagnostics redaction example

```json
{
  "kind": "a2a.operator.notification.preflight",
  "mode": "no-live",
  "decision": "GO",
  "safeToRestartGateway": true,
  "liveSendPerformed": false,
  "providerSendPerformed": false,
  "terminalOutboxAckPerformed": false,
  "preflight": {
    "pluginActivation": { "ok": true, "message": "plugin is activated" },
    "operatorEventsEnabled": { "ok": true, "message": "operatorEvents enabled (broker: broker.example.test)" },
    "notificationTarget": { "ok": true, "message": "notification target resolved (channel: telegram, to: telegram:<operator-chat-id>)" },
    "runtimeAdapter": { "ok": true, "message": "runtime adapter loaded" },
    "terminalOutboxFuse": { "ok": true, "message": "no unacknowledged outbox events" }
  }
}
```

Note: `broker.example.test` and `telegram:<operator-chat-id>` are placeholders.
Real diagnostics must redact or replace production values before appearing in
public-shared evidence.

---

## 6. Status Wording — Safety Semantics

The following status/label conventions are enforced in the monitoring surface
to ensure provider delivery is never conflated with operator receipt.

**Evidence semantic note:** Provider-accepted / message-id evidence is
send-acceptance telemetry only. None of the wordings below use "provider" as
a synonym for operator receipt. Provider send success and operator-visible
receipt are always distinct and separately labeled.

### Terminal receipt gap reasons

| Gap status | Wording | Meaning |
|------------|---------|---------|
| `confirmed` | "receipt confirmed — terminal ack eligible" | Current-session/manual receipt exists; ACK eligible |
| `failed` | "receipt failed — terminal ack blocked" | Receipt attempt failed; no ACK |
| `timed_out` | "receipt timed out — must refresh before ack" | Receipt window expired; ACK blocked until refresh |
| `stale` | "receipt stale — must refresh before ack" | Receipt state is stale; ACK blocked until refresh |
| `duplicate_suppressed` | "duplicate suppressed — no receipt confirmation, ack blocked" | Duplicate was suppressed; no receipt |
| `pending_receipt` (missing) | "no current-session/manual receipt — ack blocked" | No receipt of any kind; ACK blocked |

**Key invariant:** None of these messages use the word "provider" as a synonym
for operator receipt. Provider-send success and operator-visible receipt are
always distinct.

### Operator receipt labels (dashboard-friendly)

| State | Label | Receipt-safe? |
|-------|-------|---------------|
| `receipt_confirmed` | `✓ receipt confirmed` | ✅ Never claims "read" or "terminal ACK" |
| `timed_out` | `⏱ timed out` | ✅ |
| `stale` | `⚠ stale receipt` | ✅ |
| `failed` | `✗ receipt failed` | ✅ |
| `duplicate_suppressed` | `duplicate suppressed` | ✅ |
| `pending_receipt` | `⋯ pending receipt` | ✅ |

### Evidence acceptance wording

| Kind | Status | Wording |
|------|--------|---------|
| PR | accepted | "PR proof-of-change accepted by broker verifier" |
| PR | missing | "required PR evidence is missing — no proof-of-change" |
| PR | rejected | "PR evidence (kind) was rejected by broker verifier" |
| Done | accepted | "Done evidence accepted (PR-less or read-only)" |
| Done | missing | "required Done evidence is missing — no completion marker" |
| Block | accepted | "Block evidence accepted (PR-less blocker)" |
| Block | missing | "required Block evidence is missing — no blocker marker" |

**Evidence-integrity note:** The phrase "accepted" in this table refers to
broker-verifier acceptance of the evidence payload, not operator-visible
receipt or terminal ACK. No evidence acceptance wording uses "read",
"visible", or "terminal completed" as synonyms. See §7 for the full
accepted-send vs ACK policy.

### Queue signal messages

| Signal | Wording |
|--------|---------|
| Active tasks | `active tasks: queued=N, claimed=N, running=N` |
| Stale workers | `stale workers/tasks (no recent heartbeat): N — operator review recommended` |
| Timed-out tasks | `timed-out tasks (exceeded deadline): N — may need cancellation` |

---

## 7. Safety: Accepted-Send vs ACK Policy

**Provider/Gateway send success is NEVER terminal-outbox ACK evidence.**

This is a permanent policy (not an alpha limitation). It was established after
a live-send discrepancy where the Gateway reported success but the operator did
not receive the message ([a2a-broker#241](https://github.com/jinwon-int/a2a-broker/issues/241)).

### What counts as ACK

A terminal notification may be acknowledged **only** when one of these receipt
projections exists:

| Receipt Projection | ACK Eligible? | Evidence Requirement |
|--------------------|---------------|---------------------|
| `current_session_visible` | ✅ Yes | Channel adapter returns receipt indicating message is visible in the current operator session |
| `manual_operator_receipt` | ✅ Yes | Explicit operator/manual confirmation present |
| `provider_send_success` | ❌ **No** | Provider accepted the send — does not prove operator saw it |
| `send_ok` / `delivery_sent` / `gateway_provider_send_success` | ❌ **No** | Transport-level success only |
| `<missing>` | ❌ **No** | No receipt evidence at all |

### Non-ACK statuses (blocked at the `candidateIsAcceptedButNotAcknowledged` gate)

These statuses are explicitly recognized as provider-acceptance-only and will
never advance terminal ACK state:

- `accepted`, `queued`, `sent`, `provider_sent`
- `provider_send_success`, `provider_accepted_send`
- `message_sent`, `send_ok`, `delivery_sent`, `send_success`
- `gateway_provider_send_success`
- Boolean flags: `accepted`, `providerAccepted`, `provider_accepted`,
  `sendAccepted`, `send_accepted`, `delivered`

### Enforcement points

| Layer | Gate | Behavior |
|-------|------|----------|
| Config | `operatorEvents.notification.enabled` | Must be `true`; otherwise target resolution returns `undefined` |
| Notification adapter | `createA2AOperatorNotificationAdapter` | Returns `undefined` when no target is configured |
| Receipt projection | `normalizeReceiptProjection` | Only `current_session_visible` and `manual_operator_receipt` are valid; provider-only acceptance is rejected |
| Candidate filter | `candidateIsAcceptedButNotAcknowledged` | Explicitly rejects provider-only statuses before ACK eligibility |
| Dry-run harness | `createA2ATelegramSafeDryRunNotificationHarness` | Never sends live; records in-memory with `dryRun: true` |
| Conformance smoke gate | `createA2AConformanceSmokeGate` | All `safeOperations` are explicitly `false` |

---

## 8. No-Live-Send and No-ACK Boundaries

**By default, the plugin performs no live sends and no terminal-outbox ACKs.**
This is the permanent safety posture, not a temporary alpha restriction.

### What "no-live" means

| Operation | Default | Gate |
|-----------|---------|------|
| Telegram/notification send | ❌ Blocked | `notification.enabled` must be `true` + operator approval |
| Gateway restart | ❌ Blocked | Preflight must return `safeToRestartGateway: true` |
| Terminal-outbox ACK | ❌ Blocked | Requires current-session/manual receipt evidence |
| Provider send | ❌ Blocked | Transport-only canary (`allowUnconfirmedProviderSend`) available but never counts as ACK |

### No-live canary harness

Run the no-live canany to verify all four boundary conditions without sending
a live message:

```bash
npm run build
node --test tests/no-live-canary.test.ts
```

This exercises:
1. Notification disabled → no send possible
2. Provider accepted-send → distinct from operator-visible receipt
3. Operator-visible receipt → required for ACK eligibility
4. ACK eligibility → gated on operator-visible receipt only

### Preflight before any live operation

Before asking an operator to restart Gateway, enable notifications, or run a
live canary, run the no-live preflight that verifies all readiness layers:

```bash
npm run build
npm run test
node --test tests/no-live-canary.test.ts
node --test tests/status-card-wording.test.ts
node --test test/operator-event-bridge.test.mjs
```

The `a2a.monitor.status` preflight mode (`operatorEvents.preflight=true`)
checks all four readiness layers without operator intervention.

### When live operations require operator approval

Each of these actions requires **its own explicit operator approval**:

1. **Live Telegram delivery** — `createA2AOperatorNotificationAdapter.notify()`
   with a real runtime.
2. **Gateway restart** — `openclaw gateway restart` with notification enabled.
3. **Production deploy** — any change to the running plugin configuration.
4. **Terminal-outbox ACK** — advancing the cursor/ACK state on a broker
   terminal-outbox record.
5. **Transport-only canary** — enabling
   `operatorEvents.notification.allowUnconfirmedProviderSend` for a provider
   send that is not terminal ACK evidence.

---

## 9. Quick-Reference: Related Documents

| Document | What it covers |
|----------|----------------|
| [`docs/alpha-boundaries.md`](./alpha-boundaries.md) | Alpha exit criteria, experimental features, operational constraints |
| [`docs/compatibility-matrix.md`](./compatibility-matrix.md) | Plugin ↔ OpenClaw ↔ broker compatibility dimensions |
| [`docs/operator-approval-gate.md`](./operator-approval-gate.md) | Full live-send approval checklist and receipt-ACK eligibility matrix |
| [`docs/operator-terminal-notification-receipts.md`](./operator-terminal-notification-receipts.md) | Terminal notification receipt policy and cross-broker routing |
| [`docs/public-stable-readiness.md`](./public-stable-readiness.md) | Public-safe config placeholders and notification defaults |
| [`docs/gateway-config-bridge.md`](./gateway-config-bridge.md) | Safe config bridge (backup → apply → verify → rollback) |
| [`docs/migration-plan.md`](./migration-plan.md) | Extraction status and remaining work |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md) | Development setup, safety gates, PR checklist |

---

## 10. Verification Runbook (Quick Start)

```bash
# 1. Build
npm ci && npm run build

# 2. Public-readiness scan (must pass)
npm run scan:public-readiness

# 3. Full test suite
npm test

# 4. No-live canary
node --test tests/no-live-canary.test.ts

# 5. Status wording safety tests
node --test tests/status-card-wording.test.ts

# 6. Operator notification preflight (local)
node --test tests/no-live-canary.test.ts

# 7. Config bridge tests (if changing config)
node --test test/gateway-config-bridge.test.mjs

# 8. Operator event bridge tests (if changing event bridge)
node --test test/operator-event-bridge.test.mjs
```

All steps above are **no-live**: no Telegram messages, no Gateway restarts,
no terminal-outbox ACKs, no production config mutations.
