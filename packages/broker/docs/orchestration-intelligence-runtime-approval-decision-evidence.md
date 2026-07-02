# A2A Orchestration Intelligence v2 runtime approval decision evidence

The runtime approval decision evidence packet is the source-only step after the
runtime approval request for roadmap
[#968](https://github.com/jinwon-int/a2a-broker/issues/968).

It classifies an operator response to the approval request. Accepted evidence
can produce `explicitRuntimeApprovalPresent=true` for a later runtime-readiness
gate, but this packet still does not enable any runtime action.

## Accepted evidence requirements

All of the following must pass before the packet reports
`approval_evidence_accepted`:

- the runtime approval request is `approval_request_ready`
- decision kind is `approval_grant`
- operator matches the approval request
- approval phrase exactly matches the requested phrase
- `approvedAt` is parseable and not in the future
- expiry is absent or still in the future
- repository and issue context match the expected scope
- supplied scope covers every requested scope item
- supplied conditions cover every required condition and are explicitly accepted
- revocation or expiry rule is documented

Rejected, expired, conflicting, missing, vague, stale, or mismatched evidence
fails closed.

## Runtime evidence patch

Accepted evidence emits:

- `runtimeExecutorDesignReviewed=true`
- `explicitRuntimeApprovalPresent=true`
- `validationEvidenceFresh=true`

It keeps all execution-facing gates false:

- `brokerDispatchApprovalPresent=false`
- `workerSpawnApprovalPresent=false`
- `mobilebetaMobileScopeResolved=false`
- rollback/live readiness remains false

Those remaining gates require separate packets and, later, explicit operator
approval before any runtime enablement can be considered.

## CLI

```bash
npm run orchestration_intelligence_runtime_approval_decision_evidence -- \
  --input fixtures/orchestration-intelligence/runtime-approval-decision-evidence.accepted.json
```

Use `--json` for the raw packet.

## Boundary

This packet is source/docs/tests only. It does not grant execution approval,
enable a runtime executor, create broker dispatch, spawn workers, expand
mobilebeta/mobile GitHub scope, send providers, perform Terminal ACK/replay, mutate
a database, deploy or restart services, publish releases, or move credentials.
