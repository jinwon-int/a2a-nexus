# Alpha boundaries for plugin-a2a

This document defines what "alpha" means for `plugin-a2a` and sets the boundary conditions that must be met before the plugin can leave alpha status.

## Current alpha status

As of the current extraction window:

- The plugin is **unpublished** (`"private": true` in `package.json`)
- The plugin id `a2a-broker-adapter` is stable for the alpha window
- The delegated-task runtime still partially lives in OpenClaw core
- The compatibility matrix is narrow: `0.1.x` plugin ↔ `0.1.x` broker ↔ schema `5`
- No public wildcard compatibility guarantee is offered

## What "alpha" means

### 1. Breaking changes are expected

Plugin configuration layout, broker wire contract fields, and plugin-SDK seam requirements may change without a deprecation window. Operators should pin to a specific commit, not a version range.

### 2. Narrow compatibility scope

The only supported compatibility configuration is:

| Component | Supported range |
| --- | --- |
| Plugin | `0.1.x` (latest `main`) |
| OpenClaw | Pre-extraction seam state (delegated-task runtime in core) |
| Broker (`a2a-broker`) | `0.1.x` |
| Broker schema | `5` |

Any combination outside this matrix is untested and may fail silently.

### 3. No public install path

The plugin is not published to npm. Installation requires cloning the repository and building from source:

```bash
git clone <this-repo> && cd plugin-a2a && npm ci && npm run build
```

A public `npm install` path does not exist and must not be documented until the plugin leaves alpha.

### 4. No-live defaults (permanent)

The plugin ships with all notification delivery gates set to `false`:
- `operatorEvents.enabled: false`
- `operatorEvents.notification.enabled: false`
- `wakeOnTask.enabled: false`

These are **permanent safety defaults**, not temporary alpha restrictions. They are enforced by the receipt-runtime boundary and the fail-closed policy documented in [`docs/public-stable-readiness.md`](./public-stable-readiness.md) and [`docs/operator-approval-gate.md`](./operator-approval-gate.md).

### 5. Provider-accepted is non-ACK (permanent)

Per the post-#78261 fail-closed policy, provider/gateway send success is **permanently non-ACK**. Terminal-outbox acknowledgement requires current-session-visible or manual-operator receipt. This is not an alpha limitation — it is an intentional safety invariant that will persist beyond alpha.

#### What does NOT count as ACK evidence

The following statuses are explicitly recognized as provider-acceptance-only and are
blocked from advancing terminal ACK state by the
`candidateIsAcceptedButNotAcknowledged` gate in
[`src/operator-notification-adapter.ts`](../src/operator-notification-adapter.ts):

- `accepted`, `queued`, `sent`, `provider_sent`
- `provider_send_success`, `provider_accepted_send`
- `message_sent`, `send_ok`, `delivery_sent`, `send_success`
- `gateway_provider_send_success`
- Boolean flags: `accepted`, `providerAccepted`, `accepted`, `sendAccepted`, `delivered`

#### What DOES count as ACK evidence

| Receipt Projection | ACK Eligible? | Evidence Requirement |
|--------------------|---------------|---------------------|
| `current_session_visible` | ✅ Yes | Channel adapter confirms message is visible in the current operator session |
| `manual_operator_receipt` | ✅ Yes | Explicit operator/manual confirmation present |
| Any provider-only status | ❌ No | Transport-level success only; no operator visibility proof |
| Missing / absent | ❌ No | No receipt evidence at all |

See [`docs/operator-install-checklist.md`](./operator-install-checklist.md#6-safety-accepted-send-vs-ack-policy)
for the full safety boundary summary and enforcement-point table.
See [`docs/operator-approval-gate.md`](./operator-approval-gate.md) for the
live-send approval checklist.

### 6. Experimental features

The following features are marked experimental during alpha:

| Feature | Status | Gate |
| --- | --- | --- |
| Operator event bridge (SSE) | Alpha | `operatorEvents.enabled` |
| Wake on task | Alpha | `wakeOnTask.enabled` |
| Remote handoff visibility policy | Alpha | Explicit config allowlist |
| Goal operator UX | Alpha | Draft method surface |

## Exit criteria for leaving alpha

The plugin can leave alpha when all of the following are true:

1. **Delegated-task runtime extraction complete** — no A2A-specific runtime code remains in OpenClaw core; the plugin owns the full path from gateway method to broker response.
2. **Plugin-SDK seams stable** — sessions-send hook, wait-run handle, cancel fan-out, and timer seam are available and documented in the OpenClaw plugin SDK.
3. **Public install path exists** — the plugin is published to a package registry or has a documented stable install process.
4. **Compatibility matrix broadened** — at least one stable plugin/broker/OpenClaw combination is validated end-to-end beyond the initial narrow matrix.
5. **Regression coverage complete** — all scenarios in `docs/regression-matrix.md` have automated tests.
6. **SECURITY.md, CONTRIBUTING.md, and issue templates are published** — repository community standards are met.
7. **Operator approval gate passes** — the operator has reviewed and approved the live-send boundary for the target deployment.

## While in alpha: operational constraints

- No production deploy or Gateway restart without operator approval
- No live Telegram/notification send without operator approval
- No terminal-outbox ACK without current-session-visible or manual receipt
- No public release publication
- No community announcement or npm publish
- Compatibility claims must be scoped to the exact matrix row
- Experimental features must carry explicit alpha markers in docs

## Related

- [`docs/operator-install-checklist.md`](./operator-install-checklist.md) — operator-facing install/config checklist, diagnostics commands, safety boundaries, and verification runbook
- [`docs/public-stable-readiness.md`](./public-stable-readiness.md) — public-safe config and notification defaults
- [`docs/compatibility-matrix.md`](./compatibility-matrix.md) — exact compatibility dimensions
- [`docs/operator-approval-gate.md`](./operator-approval-gate.md) — live-send approval requirements
- [`docs/operator-terminal-notification-receipts.md`](./operator-terminal-notification-receipts.md) — receipt-confirmed ACK policy
- [`docs/migration-plan.md`](./migration-plan.md) — extraction status and remaining work
