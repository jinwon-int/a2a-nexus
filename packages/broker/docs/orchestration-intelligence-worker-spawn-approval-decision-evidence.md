# A2A Orchestration Intelligence v2 worker spawn approval decision evidence

This packet is the source-only layer after the worker/subagent spawn approval request packet.

It records whether an operator response satisfies the requested worker/subagent spawn approval evidence. It does not execute, dispatch, spawn, deploy, restart, send provider messages, mutate databases, ACK or replay Terminal rows, publish releases, or move credentials.

## Accepted Evidence

Accepted evidence must be explicit and scoped:

- operator identity matches the approval request
- approval phrase exactly matches the requested phrase
- approval timestamp is valid and not in the future
- approval is not expired
- target repository and issue match the expected context
- spawn scope covers the requested conditions
- allowed worker classes match the request
- no-live exclusions match the request
- requested conditions are explicitly accepted
- revocation or expiry rule is documented

Only then may the packet set `workerSpawnApprovalPresent=true` as source readiness evidence.

## Fail-Closed Cases

The packet keeps `workerSpawnApprovalPresent=false` when evidence is missing, rejected, expired, conflicting, ambiguous, stale by expiry, scope-mismatched, authority-mismatched, or when the upstream approval request is not ready.

## CLI Smoke

```bash
npm run build
node scripts/orchestration-intelligence-worker-spawn-approval-decision-evidence.mjs \
  --input fixtures/orchestration-intelligence/worker-spawn-approval-decision-evidence.accepted.json \
  --json
```

The accepted fixture should report:

- `state=worker_spawn_approval_evidence_accepted`
- `runtimeReadinessEvidencePatch.workerSpawnApprovalPresent=true`
- `safety.workerSpawned=false`
- `safety.brokerDispatchCreated=false`
