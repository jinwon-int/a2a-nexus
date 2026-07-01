# Dry-Run Approval Packet Projection

Issue: [jinwon-int/plugin-a2a#256](https://github.com/jinwon-int/plugin-a2a/issues/256)
Parent: a2a-plane#197 (internal tracker, private) (a2a-plane#197, internal tracker private)
Run: `a2a-source-dryrun-orchestrator-20260510T133022Z`

## Purpose

The dry-run approval projection module (`src/approval-dry-run-projection.ts`)
provides evidence tooling for A2A broker approval operations. It projects what
an `a2a.task.approve` or `a2a.task.reject_approval` broker request would look
like **without ever sending it**.

This is evidence tooling only. Source-public execution (live broker send)
remains NO-GO until explicit operator approval is granted.

## Evidence ≠ Approval

The module enforces a strict separation between evidence packets and actual
approval operations:

| Property | Evidence (projection) | Approval (actual) |
|----------|----------------------|-------------------|
| `isApproval` | `false` | N/A (never produced by this module) |
| `dryRun` | `true` | N/A |
| `liveSend` | `false` | N/A |
| Broker HTTP call | Never | N/A |
| Key field name | `projectedPacket` | N/A |

Every result carries `isApproval: false`, `dryRun: true`, `liveSend: false`.
There is no code path in this module that can produce an actual approval.
No `fetch()` or broker client is ever constructed.

## API

### `projectApprovalDryRun(params, config, deps?)`

Projects a dry-run `a2a.task.approve` packet.

```ts
import { projectApprovalDryRun } from "./approval-dry-run-projection.js";

const result = projectApprovalDryRun(
  {
    sessionKey: "operator-session",
    approval: {
      method: "a2a.task.approve",
      taskId: "task-abc-123",
      reason: "operator approves deployment",
      approvalId: "approval-xyz",
    },
  },
  pluginRuntimeConfig,
  { runId: "my-run-001" },
);

if (result.ok) {
  // result.evidence.projectedPacket  → what WOULD be sent
  // result.evidence.operatorStatus   → operator readiness
  // result.isApproval                → false (always)
  // result.dryRun                    → true (always)
  // result.liveSend                  → false (always)
}
```

### `projectRejectApprovalDryRun(params, config, deps?)`

Projects a dry-run `a2a.task.reject_approval` packet.

```ts
import { projectRejectApprovalDryRun } from "./approval-dry-run-projection.js";

const result = projectRejectApprovalDryRun(
  {
    sessionKey: "operator-session",
    approval: {
      method: "a2a.task.reject_approval",
      taskId: "task-abc-123",
      reason: "operator rejects — needs revision",
      status: "rejected",
    },
  },
  pluginRuntimeConfig,
);
```

## Evidence Packet Shape

```ts
interface ApprovalDryRunEvidence {
  schema: "a2a.approval.dry-run.evidence";
  version: 1;
  action: "approve" | "reject_approval";
  taskId: string;
  projectedAt: number;          // epoch ms
  projectedPacket: {
    endpoint: string;           // e.g. "/tasks/{id}/approve"
    method: "POST";
    body: {
      actor: A2ABrokerPartyRef;
      reason?: string;
      approvalId?: string;
      status?: "rejected" | "expired" | "canceled";
    };
    headers: {
      "content-type": "application/json";
      "x-a2a-requester-id"?: string;
      "x-a2a-requester-kind"?: string;
    };
  };
  operatorStatus: {
    operatorConfigured: boolean;
    brokerReachable: boolean;
    pluginActive: boolean;
    summary: string;
  };
  runId: string;
}
```

## Operator Status

The `operatorStatus` field in the evidence packet reflects the plugin's
operator readiness at projection time:

| Field | Meaning |
|-------|---------|
| `pluginActive` | Plugin is enabled (not denied, allowlisted if needed) |
| `brokerReachable` | A `baseUrl` is configured |
| `operatorConfigured` | Plugin is explicitly activated (allowlisted or `enabled: true`) |
| `summary` | Human-readable readiness description |

Examples:
- **Fully active:** `"operator ready — approval packet projected (not sent)"`
- **No baseUrl:** `"no broker baseUrl configured — approval would fail with BROKER_UNAVAILABLE"`
- **Disabled:** `"plugin disabled — approval would fail-closed at gateway handler"`

## Safety Gates

1. **No live send.** The module imports `resolveA2ABrokerAdapterPluginConfig`
   (pure config read) and validator functions (pure validation). No `fetch()`,
   no `createConfiguredA2ABrokerClient()`, no HTTP of any kind.

2. **Fail-closed validation.** Invalid params (missing `taskId`, empty
   `sessionKey`, wrong method) are rejected before any projection is built.
   Error results still carry `dryRun: true` and `liveSend: false`.

3. **Non-ACK semantics preserved.** Every result has `isApproval: false`.
   Evidence packets are never confused with actual approvals. The
   `projectedPacket` is nested inside `evidence`, never surfaced as
   `approval` or `ack`.

4. **Config-safe.** The module works with any plugin config state — disabled,
   partially configured, or fully active. Operator status reflects the actual
   config rather than crashing.

## Running Tests

```bash
npm ci
npm run build
node --test tests/approval-dry-run-projection.test.ts
```

## Integration

This module is evidence tooling. It does not replace or wrap the gateway
handlers (`createA2AGatewayHandlers`). The gateway handlers continue to
own the live `a2a.task.approve` / `a2a.task.reject_approval` RPC surface.

Use the projection module when you need to inspect what an approval would
look like before committing to a live operation:

1. **Pre-flight checks:** Project the approval, inspect `operatorStatus`,
   verify the `projectedPacket` body matches expectations.
2. **Audit trail:** Save the evidence packet as a record of what was
   considered before an approval decision.
3. **Dry-run harnesses:** Use in test suites and CI to verify approval
   packet shapes without broker dependencies.

## Related

- [Operator Approval Gate](./operator-approval-gate.md) — live send boundary
- [No-Live Canary Harness](../tests/no-live-canary.test.ts) — notification dry-run
- [Conformance Smoke Gate](../src/conformance-smoke-gate.ts) — schema/handler boundary tests
