# A2A Orchestration Intelligence v2 broker dispatch approval request

The broker dispatch approval request packet is the source-only step after the
runtime approval decision evidence for roadmap
[#968](https://github.com/jinwon-int/a2a-broker/issues/968).

It defines the operator-facing request text, required approval phrase, dispatch
scope, target repo/issue, worker/team constraints, operator identity requirement,
expiry/revocation conditions, rollback/abort requirements, and evidence fields
needed before a later packet may record explicit broker dispatch approval.

**This packet does not grant approval and is not execution permission.** It only
prepares operator-facing request/evidence requirements for a future broker
dispatch approval decision.

## Request dimensions

- runtime approval decision evidence is accepted with `explicitRuntimeApprovalPresent=true`
- dispatch scope is documented
- target repository is documented
- target issue number is documented
- worker and team constraints are documented
- operator identity requirement is documented
- expiry and revocation requirements are documented
- rollback and abort requirements are documented
- required future decision evidence fields are documented

All dimensions must pass before the packet reports
`dispatch_approval_request_ready`.

## Runtime evidence patch

When the dispatch approval request is ready, the packet emits a conservative
runtime readiness evidence patch:

- `runtimeExecutorDesignReviewed=true`
- `explicitRuntimeApprovalPresent=true` (inherited from upstream decision evidence)
- `validationEvidenceFresh=true`
- `brokerDispatchApprovalPresent=false`
- all worker-spawn, mobilebeta/mobile expansion, rollback, and live-boundary readiness
  booleans remain `false`

The next step may present the request to the operator and record the response in
a separate broker dispatch approval decision evidence packet. This packet is only
the request.

## CLI

```bash
npm run orchestration -- orchestration_intelligence_broker_dispatch_approval_request \
  --input fixtures/orchestration-intelligence/broker-dispatch-approval-request.ready.json
```

Use `--json` for the raw packet.

## Boundary

This packet is source/docs/tests only. It does not grant broker dispatch approval,
create broker tasks, invoke executors, spawn workers/subagents, mutate TaskFlow/DB,
send providers, or touch live services. All fail-closed readiness fields remain false;

- `brokerDispatchApprovalPresent=false`
- `workerSpawnApprovalPresent=false`
- `mobilebetaMobileScopeResolved=false`
