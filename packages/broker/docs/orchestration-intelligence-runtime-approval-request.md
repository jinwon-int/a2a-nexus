# A2A Orchestration Intelligence v2 explicit runtime approval request

The runtime approval request packet is the source-only step after the runtime
design review for roadmap
[#968](https://github.com/jinwon-int/a2a-broker/issues/968).

It defines the operator-facing request text, required approval phrase, scope,
conditions, and evidence fields needed before a later packet may record explicit
runtime approval. This packet does not grant approval by itself.

## Request dimensions

- runtime design review is ready
- required approval phrase is explicit and scoped
- approver identity requirement is documented
- request scope is documented
- approval conditions are documented
- risk summary is documented
- rollback and abort criteria are referenced
- live boundary plan is referenced
- expiry or revocation criteria are documented

All dimensions must pass before the packet reports `approval_request_ready`.

## Runtime evidence patch

When the approval request is ready, the packet emits a conservative runtime
readiness evidence patch:

- `runtimeExecutorDesignReviewed=true`
- `validationEvidenceFresh=true`
- `explicitRuntimeApprovalPresent=false`
- all broker dispatch, worker-spawn, Daegyo/mobile expansion, rollback, and
  live-boundary readiness booleans remain `false`

The next step may present the request to the operator and record the response in
a separate approval decision evidence packet. This packet is only the request.

## CLI

```bash
npm run orchestration_intelligence_runtime_approval_request -- \
  --input fixtures/orchestration-intelligence/runtime-approval-request.ready.json
```

Use `--json` for the raw packet.

## Boundary

This packet is source/docs/tests only. It does not grant runtime approval, enable
a runtime executor, create broker dispatch, spawn workers, expand Daegyo/mobile
GitHub scope, send providers, perform Terminal ACK/replay, mutate a database,
deploy or restart services, publish releases, or move credentials.
