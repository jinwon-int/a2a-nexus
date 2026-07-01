# Tasks: Hermes Broker-Agnostic Worker Contract

## Preconditions

- [x] Tracker exists: a2a-plane#384 (internal tracker, private).
- [x] Phase 1 is limited to source/docs/tests.
- [x] Live registration/canary/deploy/restart are out of scope.
- [x] Phase 2 dry-run remains loopback/local-only unless a separate live canary approval packet exists.

## Implementation tasks

- [x] Add spec packet under docs/specs/hermes-worker-integration/.
- [x] Document minimal registration, heartbeat, polling, and evidence contract.
- [x] Add worker=<nodeId> and status=pending task poll aliases.
- [x] Add POST /tasks/:id/evidence terminal evidence alias.
- [x] Add local Hermes-style worker registration/heartbeat/poll/evidence server test.
- [x] Run targeted broker validation.
- [x] Add Hermes reference worker dry-run script and local smoke fixture.
- [x] Add cron-shaped no-agent poll loop documentation.
- [x] Add static validation for the Hermes reference worker safety boundary.
- [ ] Open Phase 2 PR.
- [ ] Monitor Phase 2 CI.

## Evidence checklist

- [x] git diff --check.
- [x] npm --workspace packages/broker test -- --test-name-pattern "Hermes-style worker".
- [x] npm --workspace packages/broker test.
- [x] npm run check:hermes-reference-worker.
- [x] python3 -m py_compile examples/workers/hermes-reference-worker/a2a_worker.py.
- [x] Local loopback smoke with packages/broker on 127.0.0.1:18787 and hermes-local-smoke-1.
- [ ] GitHub Actions check.

## Follow-up checklist

- [ ] If live Hermes worker work is requested, create a separate approval packet.
- [ ] Any live worker registration must name exact broker URL, worker id, maximum task scope, rollback, and evidence redaction rules.
- [ ] Family Wiki update only after source PR merge or an operator workflow decision.
