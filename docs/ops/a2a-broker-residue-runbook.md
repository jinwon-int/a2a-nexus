# A2A Broker Residue And No-Live Health-Check Runbook

This runbook covers the source-only/no-live checks added after the 2026-06-26 Team2 worker-side timeout cleanup.

## Safety boundary

These commands are read-only or no-live task checks unless `--execute` is explicitly passed to the health helper. They do **not** authorize:

- task cancel/requeue/prune
- Terminal Brief ACK/replay
- database prune/migration
- provider/Telegram sends
- broker/Gateway/worker restarts
- cross-broker mutation

Any cleanup mutation needs a separate operator approval naming exact task IDs or outbox IDs.

## Official broker ownership

- Team1 evidence/capacity of record: **broker-alpha broker**.
- Team2 evidence/capacity of record: **broker-beta broker**.
- Stale Team2-ish rows on broker-alpha capacity are treated as historical/cross-team residue until proven otherwise.
- Do not use stale broker-alpha rows for official Team2 health. Use broker-beta capacity and broker-beta task evidence unless an explicit break-glass cross-broker handoff is approved.

## No-live A2A/A2AD health check

Use the checked-in helper instead of ad-hoc curl snippets:

```sh
node scripts/a2a-timeout-cleanup/no-live-a2a-a2ad-health-check.mjs \
  --team team2 \
  --broker-id broker-beta \
  --base-url http://127.0.0.1:8787 \
  --a2a-worker worker-theta \
  --a2ad-workers worker-epsilon,worker-zeta,worker-eta \
  --execute
```

The helper:

- reads capacity from current `totals` + `items[]` shape, with legacy `workers[]` fallback;
- probes `/schedz` and `/audit` first, then legacy `/admin/schedz` and `/admin/audit`;
- creates source-only/no-live tasks with `parentRoundId`, `parentRoundTotal`, and `parentRoundOrder`;
- prints compact evidence: run id, task ids, worker ids, status, and `analysisStatus`.

## Read-only residue classification

For broker-alpha stale Team2-ish queued rows or broker-beta terminal outbox backlog, use:

```sh
node scripts/a2a-timeout-cleanup/a2a-readonly-broker-residue-report.mjs \
  --broker-id broker-alpha \
  --official-team team1 \
  --official-workers worker-gamma,worker-alpha,worker-beta,worker-delta,mobile-alpha \
  --base-url http://127.0.0.1:8787
```

For broker-beta outbox diagnostics:

```sh
node scripts/a2a-timeout-cleanup/a2a-readonly-broker-residue-report.mjs \
  --broker-id broker-beta \
  --official-team team2 \
  --official-workers worker-epsilon,worker-zeta,worker-eta,mobile-beta,worker-theta \
  --base-url http://127.0.0.1:8787
```

The report classifies:

- queued tasks by worker, age bucket, origin fields, and cross-team suspicion;
- terminal outbox state as clean, recent watch, ack-ineligible residue, or actionable review;
- a bounded mutation plan with `allowedNow=false` and rollback notes.

## Terminal outbox interpretation

`ackEligibleUnacked` is the actionable count. `rawUnacked` may include rows that are not eligible for ACK because projection ownership forbids terminal ACK. A 7+ day old ack-eligible row is an **actionable review signal**, not permission to ACK or prune.

Safe next step is to classify destination/task/round with bounded reads and then ask for explicit cleanup approval if a targeted ACK/replay/prune is still needed.

## mobile-beta/Termux diagnostics

mobile-beta-class mobile workers are Termux/mobile workers, not normal systemd Ubuntu workers. Prefer Termux/tmux/process/env/file checks over `/etc/default` and `journalctl` routines. Mobile/reference workers must not call `/workers/register` on every polling tick; they should re-register only on first boot, TTL expiry, or heartbeat 404/410.
