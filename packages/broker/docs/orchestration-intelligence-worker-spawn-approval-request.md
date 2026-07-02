# A2A Orchestration Intelligence v2 worker/subagent spawn approval request

The worker/subagent spawn approval request packet is the source-only step after the
broker dispatch approval decision evidence for roadmap
[#968](https://github.com/jinwon-int/a2a-broker/issues/968).

It defines the operator-facing request text, required approval phrase, spawn
scope, target repo/issue, worker/team constraints, allowed worker classes,
no-live/live exclusions, operator identity requirement, expiry/revocation
conditions, rollback/abort requirements, and evidence fields needed before a
later packet may record explicit worker/subagent spawn approval.

**This packet does not grant approval and is not execution permission.** It only
prepares operator-facing request/evidence requirements for a future worker/subagent
spawn approval decision.

## Request dimensions

- broker dispatch approval decision evidence is accepted with
  `brokerDispatchApprovalPresent=true`
- spawn scope is documented
- target repository is documented
- target issue number is documented
- worker and team constraints are documented
- allowed worker classes are documented
- no-live/live exclusions are documented
- operator identity requirement is documented
- expiry and revocation requirements are documented
- rollback and abort requirements are documented
- required future decision evidence fields are documented

All dimensions must pass before the packet reports
`worker_spawn_approval_request_ready`.

## Runtime evidence patch

When the worker spawn approval request is ready, the packet emits a conservative
runtime readiness evidence patch:

- `runtimeExecutorDesignReviewed=true`
- `explicitRuntimeApprovalPresent=true` (inherited from upstream chain)
- `brokerDispatchApprovalPresent=true` (inherited from upstream chain)
- `rollbackAbortCriteriaDocumented=true`
- `validationEvidenceFresh=true`
- `workerSpawnApprovalPresent=false`
- all mobilebeta/mobile expansion and live-boundary readiness booleans remain `false`

The next step may present the request to the operator and record the response in
a separate worker spawn approval decision evidence packet. This packet is only
the request.

## CLI

```bash
npm run orchestration_intelligence_worker_spawn_approval_request -- \
  --input fixtures/orchestration-intelligence/worker-spawn-approval-request.ready.json
```

Use `--json` for the raw packet.

## Boundary

This packet is source/docs/tests only. It does not grant worker/subagent spawn
approval, create broker tasks, invoke executors, spawn workers/subagents, mutate
TaskFlow/DB, send providers, or touch live services. All fail-closed readiness
fields remain false:

- `brokerDispatchApprovalPresent=true` (inherited from upstream, flag only)
- `workerSpawnApprovalPresent=false`
- `mobilebetaMobileScopeResolved=false`
