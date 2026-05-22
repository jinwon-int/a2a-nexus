# Implementation Plan: Gongyung Hermes Lightweight A2A Worker Profile

## Linked spec

- Spec: `docs/specs/gongyung-hermes-worker-profile/spec.md`
- Tracker: jinwon-int/a2a-plane#393
- Prior art: jinwon-int/a2a-plane#384
- Finalizer: Seoseo

## Size classification

- [ ] Small
- [x] Medium
- [ ] Large

Reason: This change is docs + validation tests within a single repo (`a2a-plane`).
No broker runtime code, no OpenClaw plugin API surface change, no deploy/restart.
The admission function is specified as source-only; a future implementation may
move it into the broker or the plugin's mobile-safety-lane module.

## Affected repos/components

- `a2a-plane`: new spec packet under `docs/specs/gongyung-hermes-worker-profile/`,
  plus admission validation tests under `packages/openclaw-plugin-a2a/tests/`.
- `a2a-broker`: no change (profile is consumer-agnostic).
- `a2a-docker-runner`: no change.
- `openclaw-plugin-a2a`: addition of
  `tests/gongyung-worker-profile-admission.test.ts` — new test file only,
  no source modification.
- Wiki/runbooks: no update needed at this time.

## Execution lane

- [x] Direct small change (docs + tests in one package)
- [ ] Isolated subagent
- [ ] Broker-owned TaskFlow
- [ ] TaskFlow + A2A evidence workers
- [ ] Other:

Why this lane is safe: spec-only document plus validation test. No broker
runtime, no worker handler, no deploy/restart, no secret exposure. All
test assertions are deterministic and do not require a live broker.

## Data/control flow

1. Spec defines Gongyung profile as a consumer of the existing Hermes
   broker-agnostic worker contract.
2. Validation tests exercise the fail-closed admission function against a
   matrix of admissible, rejected, and handoff task shapes.
3. Evidence manifest validation tests verify the fixed artifact schema,
   redaction rules, and the `manifest ok` inline check.
4. Spec explicitly documents that Gongyung must reject Docker runner task
   patterns at admission time — the tests verify this is structurally possible.

## Tests and validation

### Admission validation tests (`packages/openclaw-plugin-a2a/tests/gongyung-worker-profile-admission.test.ts`)

- `admit()` against admissible intents (analyze, review, clarify, observe,
  check_readiness, cross_check).
- `admit()` against rejected intents (docker, patch_repo, build_repo, test_repo).
- `admit()` against Docker runner indicators (executorMode=docker,
  runnerScope=all-github, WORKER_HANDLER_COMMAND inference, etc.).
- `admit()` against team modes (fanout → lightweight, swarm → observe,
  split → NO-GO).
- `admit()` against capability requirements (heavy proof, GitHub push, live
  promotion).
- `admit()` at capacity (maxConcurrentTasks exceeded → NO-GO).
- Evidence manifest validation: required fields, allowed outcomes, artifact
  structure.
- Redaction rule enforcement: manifest ok check rejects evidence with raw
  device identifiers.

### Static checks

- `git diff --check` for whitespace.
- `npm run check` for overall monorepo health.
- `node --test packages/openclaw-plugin-a2a/tests/gongyung-worker-profile-admission.test.ts`.

## Rollout plan

- Merge source PR after local validation.
- Do not deploy, restart, register live Gongyung workers, send provider
  notifications, or point the spec at non-loopback brokers.
- Create a separate tracker if a runtime admission function implementation
  is requested.

## Rollback plan

- Revert PR: remove `docs/specs/gongyung-hermes-worker-profile/` directory
  and `packages/openclaw-plugin-a2a/tests/gongyung-worker-profile-admission.test.ts`.
- No production state cleanup required.
