# Worker poll-profile migration

This note tracks the repo-only migration path for replacing OpenClaw-era worker
profile names with neutral broker poll/HTTP names.

## Current state

- Canonical external-handler profile: `A2A_WORKER_PROFILE=broker-poll-only`.
- Canonical runtime flavor: `broker-poll-http-handler`.
- Legacy compatibility profile: `A2A_WORKER_PROFILE=openclaw-poll-only`.
- Legacy runtime flavor: `openclaw-poll-handler`.
- Both profiles use the same broker poll/HTTP/stdin-stdout handler contract.

The legacy profile is retained only so already deployed workers can be migrated
without an immediate outage. Do not remove `scripts/openclaw-a2a-task-handler.mjs`
or live worker environment aliases until a fresh operator-approved fleet audit
proves no active node still references them.

## Safe migration order

1. **Inventory live worker env and handler paths** without restarting services.
   Record service name, worker root, `A2A_WORKER_PROFILE`, handler path, runtime
   flavor, and whether the canonical `scripts/a2a-task-handler.mjs` exists.
2. **Switch repo/runbook examples** to `broker-poll-only` and
   `broker-poll-http-handler`.
3. **Roll workers one by one** only after approval for the relevant service
   restart. Keep the legacy profile available during this window.
4. **Observe heartbeats and task completion** after each approved restart.
5. **Remove compatibility wrapper/env names** in a later PR only after all active
   workers report the neutral profile/flavor and rollback has been documented.

## Approval boundaries

The repo change that adds the neutral alias is safe and no-live. The following
are not safe without fresh approval:

- worker service restart;
- Docker runner rebuild or image switch;
- broker/Gateway restart;
- broker DB mutation or task replay;
- deleting deployed handler compatibility files;
- release/tag/public visibility changes.

## Local validation

```bash
npm run build
npx tsx --test src/worker.test.ts
```
