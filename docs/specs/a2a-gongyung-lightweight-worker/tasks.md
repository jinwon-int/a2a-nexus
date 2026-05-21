# Tasks: Gongyung Hermes Lightweight A2A Worker Profile

## Preconditions

- [x] Prior art exists: Hermes Broker-Agnostic Worker Contract (#384) with spec, plan, tasks, and validation.
- [x] Gongyung is confirmed as Hermes-only / Hermes-dedicated Android Termux device (2026-05-20 KST).
- [x] Docker/build/test/patch/untrusted-code execution is not practically available on Android Termux.

## Implementation tasks

- [x] Add spec packet under `docs/specs/a2a-gongyung-lightweight-worker/`.
- [x] Define allowed/rejected task classes with explicit flag names.
- [x] Specify artifact output path `~/.hermes/a2a/artifacts/<task-id>/`.
- [x] Define evidence manifest fields (taskId, workerId, status, filesProduced, redactionStatement, limitations, timestamp).
- [x] Register worker metadata template with `workerProfile=lightweight` and `dockerAvailable=false`.
- [x] Add Gongyung worker registration fixture.
- [x] Add Gongyung worker card example.
- [x] Add lightweight worker validation test.
- [x] Reference #384 Hermes integration as prior art.
- [ ] Run validation commands.
- [ ] Open PR.

## Evidence checklist

- [x] `docs/specs/a2a-gongyung-lightweight-worker/spec.md` — feature spec.
- [x] `docs/specs/a2a-gongyung-lightweight-worker/plan.md` — implementation plan.
- [x] `docs/specs/a2a-gongyung-lightweight-worker/tasks.md` — task checklist.
- [x] `docs/specs/a2a-gongyung-lightweight-worker/analyze.md` — analysis.
- [x] `fixtures/contract/gongyung-worker-registration.json` — worker registration fixture.
- [x] `examples/workers/standalone-http-worker/worker-card.json` — already exists for standalone; new Gongyung-specific card.
- [x] `scripts/check-gongyung-lightweight-worker.test.mjs` — validation test.
- [ ] `git diff --check`.
- [ ] `node --test scripts/check-gongyung-lightweight-worker.test.mjs`.
- [ ] `npm run test:conformance`.
- [ ] GitHub Actions check.

## Follow-up checklist

- [ ] If production Gongyung worker registration is requested, create a separate approval packet.
- [ ] Any live Gongyung registration must name exact broker URL, worker id, maximum task scope, rollback, and evidence redaction rules.
- [ ] Add operator-facing runbook entry for Gongyung lightweight worker lifecycle.
