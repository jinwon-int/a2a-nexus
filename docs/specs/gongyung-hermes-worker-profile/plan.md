# Implementation Plan: Gongyung Hermes Lightweight Worker Profile

## Linked spec

- Spec: `docs/specs/gongyung-hermes-worker-profile/spec.md`
- Tracker: jinwon-int/a2a-plane#393
- Prior art: jinwon-int/a2a-plane#384

## Size classification

- [x] Small
- [ ] Medium
- [ ] Large

Reason: This change is limited to docs and an admission conformance test. No broker, worker, Docker Runner, or plugin source code is modified.

## Affected repos/components

- `a2a-plane`: spec packet at `docs/specs/gongyung-hermes-worker-profile/` and admission test.
- `a2a-broker`: no change.
- `a2a-docker-runner`: no change.
- `openclaw-plugin-a2a`: no change.
- worker/node config: no change (spec-only).
- Wiki/runbooks: no change (future operator step).

## Broker / worker / finalizer roles

- Broker of record / finalizer: Seoseo.
- Workers: jingun (this patch).
- Libero/validator: seoseo (issue owner).
- Human approval owner: not required (source-only).

## Execution lane

- [x] Direct small change — docs and test only.
- [ ] Isolated subagent.
- [ ] Broker-owned TaskFlow.
- [ ] TaskFlow + A2A evidence workers.
- [ ] Other:

Why this lane is safe: modifies docs and a static test script only. No production state, no broker/worker code, no runtime configuration.

## Data/control flow

1. Spec packet defines Gongyung Hermes lightweight worker profile under `docs/specs/gongyung-hermes-worker-profile/`.
2. Admission test asserts:
   - spec packet exists at the expected path;
   - reject/handoff rules are documented for `dockerRequired`, `buildRequired`, `testRequired`, `repoPatch`, `untrustedCode`;
   - allowed task classes are listed;
   - artifact contract and evidence manifest fields are specified;
   - prior art reference to jinwon-int/a2a-plane#384 is present;
   - no-live-Gateway/broker/deploy language is in the out-of-scope section.
3. PR is opened for review but not merged.
4. Seoseo reviews and finalizes.

## Tests and validation

- `npm run check:gongyung-hermes-worker-profile` — static admission test at `scripts/check-gongyung-hermes-worker-profile.test.mjs`.
- `git diff --check`.
- GitHub Actions check on PR.

## Rollout plan

- Open source-only PR; do not merge.
- After review and CI pass, Seoseo may merge as finalizer.

## Rollback plan

- Revert PR.
- No production state cleanup is required.

## Closeout evidence

- Finalizer decision: Seoseo.
- Evidence links: PR URL, CI status.
- Tests/checks: `npm run check:gongyung-hermes-worker-profile`.
- Approval-sensitive actions not performed: no deploy, restart, canary, DB mutation, ACK/replay, release/tag, or secret operation.
- Wiki/runbook update: not needed for source/spec packet.
