# brokerbeta→brokeralpha durable handoff receiver operations

This runbook packages the safe operator path for the durable brokerbeta→brokeralpha handoff receiver. It is intentionally default-off: it documents how the receiver must be configured, validated, and evidenced without deploying it, restarting brokers, rotating secrets, mutating production databases, sending through live providers, acknowledging terminal outbox rows, or changing GitHub repository settings.

Reference config: [`examples/brokerbeta-brokeralpha.receiver.env.example`](../examples/brokerbeta-brokeralpha.receiver.env.example).

## Intended receiver flow

```text
brokerbeta parent comment or manifest
  → brokeralpha receiver inbox
  → brokeralpha broker Team1 task creation
  → targetTaskId and sanitized evidence returned to the parent issue
```

Ownership boundary:

| Field | Required value | Why |
| --- | --- | --- |
| `brokerOfRecord` | `brokeralpha` | Team1 task creation happens on or through the brokeralpha broker. |
| `requestedByBroker` | `brokerbeta` | The upstream request originates from brokerbeta/Team2 coordination. |
| `targetTeam` | `team1` | The receiver must not create Team2 or cross-owned tasks. |
| brokeralpha edge secret | local secret store/env only | Never paste the value into GitHub, chat, artifacts, or brokerbeta-side logs. |

## Accepted handoff package

The receiver may accept either a structured handoff manifest or a `/a2a assign <worker> ...` parent comment once the code path is enabled. Both inputs must normalize to the same durable package before task creation:

```yaml
brokerOfRecord: brokeralpha
requestedByBroker: brokerbeta
requestingAgent: brokerbeta
sourceTaskId: brokerbeta-parent-249
# targetTaskId is empty until brokeralpha accepts and creates the task.
targetTaskId: null
targetTeam: team1
handoffReason: closeout evidence collection
status: accepted
idempotencyKey: brokerbeta-249-team1-workergamma-closeout-20260512-0217
evidenceUrls:
  - a2a-plane#249 (internal tracker, private)
assignment:
  workerId: workergamma
  intent: propose_patch
```

Fail closed before task creation when any of these are true:

- `idempotencyKey` is missing or blank.
- `brokerOfRecord` is not `brokeralpha` or `requestedByBroker` is not `brokerbeta`.
- `targetTeam` is anything other than `team1`.
- the target worker is unknown, offline beyond the approved stale window, or not a Team1/brokeralpha worker.
- the same `idempotencyKey` was already accepted; return the stored `targetTaskId` and evidence instead of creating a duplicate.
- the input or evidence body would expose an edge secret, raw `.env` contents, private host path, terminal outbox payload, or OpenClaw runtime/bootstrap context file.

## Durable state and idempotency

The receiver should persist the normalized handoff package before calling the brokeralpha broker task API. The minimum durable record is:

- `idempotencyKey`
- `sourceTaskId`
- `targetTaskId` once created
- `requestingAgent`
- `targetTeam`
- `status` (`accepted`, `running`, `pr-open`, `done`, or `blocked`)
- sanitized evidence URLs and timestamps

On retry or duplicate comment, look up `idempotencyKey` first. If a record already has `targetTaskId`, post or return that existing evidence. If the record is present without `targetTaskId`, keep the package blocked for operator review instead of attempting a second create.

## Packaged read-only checks

These npm scripts make the operations discoverable without adding a live receiver side effect:

```bash
# Confirm the same online worker ID is not active on both brokers.
npm run brokerbeta_brokeralpha_receiver_preflight -- \
  --brokeralpha-url "${brokeralpha_BROKER_URL}" \
  --brokerbeta-url "${brokerbeta_BROKER_URL}" \
  --json

# Confirm terminal receipt projections remain shape-compatible; GET only.
npm run brokerbeta_brokeralpha_receiver_receipt_parity -- \
  --brokeralpha-url "${brokeralpha_BROKER_URL}" \
  --brokerbeta-url "${brokerbeta_BROKER_URL}" \
  --brokeralpha-edge-secret "${brokeralpha_BROKER_EDGE_SECRET}" \
  --brokerbeta-edge-secret "${brokerbeta_BROKER_EDGE_SECRET}" \
  --limit 20 \
  --json
```

Both checks are safe to run before enabling the receiver because they only read broker state. Keep command output sanitized: counts, worker IDs, timestamps, and URLs are acceptable; secrets, raw task payloads, and raw session logs are not.

## Evidence comments

The receiver should return one of these statuses to the parent issue:

- `accepted`: package persisted and brokeralpha task created; include `targetTaskId`.
- `running`: Team1 worker claimed or started the task; include worker ID and timestamp.
- `pr-open`: worker returned a pull request URL.
- `done`: worker completed without a PR; include completion evidence URL.
- `blocked`: no task was created or progress stopped; include the safe reason and exact sanitized offending paths when the block is caused by bootstrap/runtime context leakage.

Evidence comment template:

```text
brokerbeta→brokeralpha handoff: <status>
sourceTaskId: <sourceTaskId>
targetTaskId: <targetTaskId-or-none>
idempotencyKey: <idempotencyKey>
targetTeam: team1
workerId: <workerId>
evidence: <url>
```

## Default-off enablement checklist

1. Load `examples/brokerbeta-brokeralpha.receiver.env.example` into a local ignored env file and fill only approved placeholder values.
2. Run `npm run build` from this repository.
3. Run `npm run brokerbeta_brokeralpha_receiver_preflight` with brokeralpha and brokerbeta broker URLs.
4. Run `npm run brokerbeta_brokeralpha_receiver_receipt_parity` if terminal receipt evidence will be mirrored in parent comments.
5. Confirm the receiver remains disabled until an operator approves the specific enablement window.
6. Enable only the receiver process/path; do not restart unrelated Gateway/broker services, rotate secrets, force-push, or ACK terminal outbox rows as part of receiver enablement.
7. Post sanitized `accepted` or `blocked` evidence to the parent issue.

## Rollback

Rollback is disabling the receiver path, not deploying a broker rollback by default.

Trigger rollback when duplicate brokeralpha tasks are created for one `idempotencyKey`, target workers are wrong or unknown, evidence cannot be sanitized, or any secret/context leakage is detected.

Steps:

1. Disable the receiver flag/process.
2. Preserve the durable receiver store for audit; do not prune records until the operator approves.
3. Query the brokeralpha broker for `targetTaskId` values already created by accepted records.
4. Post a `blocked` parent comment with sanitized IDs and evidence URLs.
5. Re-run the preflight after remediation before re-enabling.
