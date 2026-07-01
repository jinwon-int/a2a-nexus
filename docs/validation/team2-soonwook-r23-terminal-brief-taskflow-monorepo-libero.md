# Team2/Soonwook R23 Libero validation — End-to-end validation matrix for Terminal Brief / TaskFlow / monorepo

Issue: a2a-plane#338 (a2a-plane#338, internal tracker private)
Parent: a2a-plane#335 (a2a-plane#335, internal tracker private) — R23 validation round
Parent/origin broker: Seoseo (Team1) — Seoseo is the parent/origin broker and sole operator-facing parent Terminal Brief sender
Handoff broker: Gwakga (Team2) — Gwakga validates cross-broker Terminal Brief / TaskFlow / monorepo semantics as child/handoff broker only
Run: `a2a-r23-terminal-brief-spec-taskflow-monorepo-20260515T055352Z`
Lane: `soonwook` / Team2 libero validation (Terminal Brief / TaskFlow / monorepo end-to-end matrix)

This is a redacted, no-live validation artifact for the R23 Terminal Brief, TaskFlow, and monorepo validation cross-check. It performs repository and GitHub evidence review only. **It does not deploy, restart Gateway/broker/worker services, reload runtime config, send a live provider or Telegram canary, mutate/prune/migrate production databases, manually ACK or replay terminal-outbox rows, replay historical tasks, open a live cross-broker relay window, publish a release/tag, move or disclose secrets, force-push, rewrite history, change repository visibility, execute operator approval, claim operator-visible receipt, or issue a Terminal Brief ACK.**

## Decision

**R23 closeout is `NO-GO / Waiting`.** R23 source changes cannot be treated as final-GO until:

- Terminal Brief contract fixtures and cross-broker routing invariants from the parent-origin routing round are published as terminal validation evidence with linked PR/Done/Block markers.
- TaskFlow spec-first bridge design and runtime dry-run command each have terminal PR/Done/Block evidence with passing CI and local release-gate results.
- Monorepo contract/fixture/release gate coverage for Terminal Brief and TaskFlow domains is confirmed green and merged.
- Runtime bootstrap hygiene is confirmed: OpenClaw runtime context files (AGENTS.md, SOUL.md, USER.md, TOOLS.md, HEARTBEAT.md, IDENTITY.md, .openclaw/**, BOOTSTRAP.md, MEMORY.md, memory/**) are absent from branch diff, PR body, issue comments, and artifact evidence.
- Required tests pass and a separate explicit operator approval authorizes any runtime activation.

Safe current closeout for this lane: this PR documents the R23 end-to-end validation matrix, Terminal Brief contract/spec verification, TaskFlow bridge design and dry-run verification, monorepo release-gate coverage review, risk list, source-only GO/NO-GO decision, and explicit runtime activation blockers. It is not approval to merge implementation PRs, deploy/reload, send a provider canary, claim operator-visible receipt, or open a live relay window.

Source-public execution remains **`NO_GO`**. This is a **source-only** GO/NO-GO: it evaluates source changes, not runtime activation. Runtime activation requires a separate downstream approval after sibling lanes complete.

## R23 validation matrix

### Domain 1 — Terminal Brief: parent-origin routing contract and cross-broker semantics

| Gate | Required R23 behavior | Current evidence snapshot | Closeout state |
| --- | --- | --- | --- |
| Four-case parent-origin routing invariant | `initiatingBroker == parentBrokerId == originBrokerId == operatorFacingTerminalBriefSender` is preserved in contract and fixture. Team1-only stays Seoseo-local; Team2-only stays Gwakga-local; cross-team is parent-seeded projection. | Contract [`parent-terminal-brief-aggregation.md`](a2a-plane (internal tracker, private)blob/main/contracts/a2a/parent-terminal-brief-aggregation.md) v1 defines symmetric origin-broker semantics. Fixture [`terminal-brief-parent-origin-routing.json`](a2a-plane (internal tracker, private)blob/main/fixtures/contract/terminal-brief-parent-origin-routing.json) maintains the four-case invariant with all six routing gates. Conformance test `check-contract-fixtures.mjs` validates the fixture. | `PASS for contract/fixture definition`; no changes expected in R23 unless a new routing case is added. |
| Cross-broker Terminal Brief owner semantics | Seoseo remains parent/origin broker and sole operator-facing Terminal Brief sender. Gwakga does not render/send/update/retract/ACK the parent-round aggregate Brief in any cross-broker handoff scenario. | Broker [`terminal-brief-routing-contract.ts`](a2a-plane (internal tracker, private)blob/main/packages/broker/src/core/terminal-brief-routing-contract.ts) rejects direct Telegram/curl/provider routes for prepared Terminal Briefs. [`broker-handoff-protocol.md`](a2a-plane (internal tracker, private)blob/main/contracts/a2a/broker-handoff-protocol.md) v0 Freeze defines handoff envelope, peer permissions, and parent metadata invariants. Handoff-scenarios [`handoff-scenarios.ts`](a2a-plane (internal tracker, private)blob/main/packages/broker/src/core/handoff-scenarios.ts) and [`two-broker-safety-matrix.ts`](a2a-plane (internal tracker, private)blob/main/packages/broker/src/core/two-broker-safety-matrix.ts) define additional safety guardrails. | `PASS for contract/guard definition`; no regressions expected without new PRs. |
| Terminal evidence ACK boundary | `providerAccepted`, `providerMessageId`, `sendStatus: accepted`, and `sendStatus: sent` remain accepted-send evidence only. Only `manual_operator_receipt` and `current_session_visible` are ACK-safe receipt types. | Contract [`terminal-evidence-ack-boundary.md`](a2a-plane (internal tracker, private)blob/main/contracts/compatibility/terminal-evidence-ack-boundary.md) v0 Freeze. Fixtures [`accepted-send-non-ack.json`](a2a-plane (internal tracker, private)blob/main/fixtures/terminal-evidence/accepted-send-non-ack.json) and [`github-comment-projection.json`](a2a-plane (internal tracker, private)blob/main/fixtures/terminal-evidence/github-comment-projection.json) enforce the boundary. Conformance: `npm run check:message-id-ack-boundary` and `test/conformance/check-terminal-evidence-ack-boundary.mjs`. | `PASS for contract/fixture definition`; boundary remains frozen at v0. |
| Terminal Brief spec-first packet (a2a-broker#634) | Spec, plan, and tasks exist for the parent-origin routing contract as a spec-first trial. Four-case routing fixture has machine-readable coverage. | Spec docs at [`docs/specs/a2a-terminal-brief-parent-origin-routing/`](a2a-plane (internal tracker, private)blob/main/docs/specs/a2a-terminal-brief-parent-origin-routing/). Four-case routing fixture at [`fixtures/contract/terminal-brief-parent-origin-routing.json`](a2a-plane (internal tracker, private)blob/main/fixtures/contract/terminal-brief-parent-origin-routing.json). Conformance test checks the fixture against contract. | `PASS for spec-first packet`; spec/plan/tasks merged. |

### Domain 2 — TaskFlow: spec-first bridge design and runtime dry-run

| Gate | Required R23 behavior | Current evidence snapshot | Closeout state |
| --- | --- | --- | --- |
| TaskFlow bridge design doc | Design doc exists defining state schema, lifecycle states, child evidence task linkage, approval waits, finalizer closeout rules, and one concrete mapping example from `a2a-broker#634` / Terminal Brief routing. | Design doc [`docs/taskflow/a2a-spec-first-bridge.md`](a2a-plane (internal tracker, private)blob/main/docs/taskflow/a2a-spec-first-bridge.md) covers state schema (controllerId, goal, stateJson, waitJson), lifecycle states (spec_draft → closed), child lane linkage (plane-contract, broker-routing, plugin-relay, libero-validation), approval boundaries (all blocked by default), and the #634 mapping example. | `PASS` — design doc is merged with all required sections. |
| TaskFlow runtime dry-run command | Runtime rehearsal/dry-run command exists that validates a spec-first packet and emits a managed TaskFlow draft. Must fail closed for unsafe inputs and approval-sensitive actions. | Dry-run script [`scripts/a2a-spec-first-taskflow-runtime.mjs`](a2a-plane (internal tracker, private)blob/main/scripts/a2a-spec-first-taskflow-runtime.mjs) implements the rehearsal command. Test at [`scripts/a2a-spec-first-taskflow-runtime.test.mjs`](a2a-plane (internal tracker, private)blob/main/scripts/a2a-spec-first-taskflow-runtime.test.mjs) validates the fixture. Spec at [`docs/specs/a2a-spec-first-taskflow-runtime/`](a2a-plane (internal tracker, private)blob/main/docs/specs/a2a-spec-first-taskflow-runtime/). | `PASS` — command and tests exist, spec/plan/tasks merged. |
| TaskFlow state model safety | TaskFlow state must not store secrets, raw logs, private endpoints, or production DB/outbox contents. Approval-sensitive actions (deploy, restart, canary, DB mutation, ACK replay, release/tag, secret movement, force-push) must be blocked or `awaiting_approval`. | Design doc and spec both define strict safety/approval boundaries. Dry-run fixture `a2a-spec-first-taskflow-runtime-dryrun.json` sets `runtimeAutomationEnabled: false` and all approval boundaries to `not-approved`/`blocked`. Dry-run script rejects unsafe inputs with `NO_GO` and non-zero exit. | `PASS for design/spec/safety boundaries`; runtime enforcement depends on future live implementation. |
| TaskFlow child lane linkage | Child evidence lanes (plane-contract, broker-routing, plugin-relay, libero-validation) are defined with expected evidence packets. | Design doc §Child task linkage defines four lanes with expected evidence per lane. Dry-run fixture includes all four lanes. | `PASS` — lanes defined in both design doc and fixture. |

### Domain 3 — Monorepo: contract/fixture/release gate coverage and compatibility

| Gate | Required R23 behavior | Current evidence snapshot | Closeout state |
| --- | --- | --- | --- |
| Release gate coverage | `npm run check` / release gate must include conformance tests, contract fixture validation, terminal evidence ACK boundary checks, terminal-brief routing guard checks, and public-readiness scan. | Root gate `npm run check` (defined in [`docs/release-gate.md`](a2a-plane (internal tracker, private)blob/main/docs/release-gate.md)) runs: `check:layout`, `test:conformance`, `check:packages`, `check:runner-import-smoke`, `check:terminal-brief-routing`, `check:message-id-ack-boundary`, `scan:public-readiness`, `scan:readiness-gates`, `scan:external-secrets`, and compatibility baseline checks. | `PASS` — release gate covers all required domains. |
| Compatibility matrix | `contracts/compatibility/matrix.md` records exact source baselines for Broker, OpenClaw plugin, Docker runner, shared contracts. Public release candidate must update matrix with exact commits/tags. | Matrix exists at [`contracts/compatibility/matrix.md`](a2a-plane (internal tracker, private)blob/main/contracts/compatibility/matrix.md) with current baselines for all four components plus OpenClaw core fixture. | `PASS` — matrix is populated. Public release would need baseline updates. |
| Public-readiness scan | Runtime/bootstrap context files (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`, `BOOTSTRAP.md`, `MEMORY.md`, `memory/**`), token-shaped literals, and unsafe secret assignments must be absent from tracked or unignored candidate files. | `npm run scan:public-readiness` runs `scripts/public-readiness-scan.mjs`. `npm run scan:external-secrets` runs gitleaks/trufflehog when available. PR body, issue comments, and branch diff are manually inspected for bootstrap context leaks. | `PASS` — scanner exists; manual inspection required per PR. No known leaks in current branch. |
| Terminal Brief / TaskFlow / monorepo end-to-end validation matrix (this lane) | This document provides a cross-cutting validation matrix covering all three domains. Test script enforces required artifacts, safety boundaries, runtime activation blockers, bootstrap hygiene, and GO/NO-GO separation. | This validation document and its companion test `check-team2-soonwook-r23-terminal-brief-taskflow-monorepo-libero.test.mjs`. | `NO-GO / Waiting` until sibling lanes publish terminal evidence. |

## R23 lane snapshot

| Worker | Repo issue | Assigned scope | Snapshot |
| --- | --- | --- | --- |
| `soonwook` (Team2) | a2a-plane#338 (a2a-plane#338, internal tracker private) | This cross-domain libero validation: end-to-end validation matrix for Terminal Brief contract/spec, TaskFlow bridge design and runtime dry-run, and monorepo release-gate/compatibility coverage. Risk list, blocker documentation, and source-only GO/NO-GO. | Start evidence plus this validation document and test. |

Start, queued, running, provider accepted-send, GitHub comment creation, and PR creation are not terminal lane evidence. Count a sibling lane as terminal only when it has an explicit PR, Done, or Block marker with linked checks/evidence.

## Risk list and runtime activation blockers

### Current risks

1. **Terminal Brief / TaskFlow integration gap**: The TaskFlow bridge design references Terminal Brief child evidence lanes (plane-contract, broker-routing, plugin-relay, libero-validation). However, the bridge is design-only with no live TaskFlow job support. If a future live TaskFlow runtime is implemented before the Terminal Brief routing contract is deployed, the integration surface may have unspecified synchronization behavior between TaskFlow state mutations and Terminal Brief outbox projection.

2. **Spec-first packet version drift**: The dry-run fixture `a2a-spec-first-taskflow-runtime-dryrun.json` references specific spec/plan/tasks paths. If those paths are refactored or the Terminal Brief routing spec is updated without updating the dry-run fixture, the rehearsal command may reference stale or missing files.

3. **Monorepo release gate coverage completeness**: The root release gate covers contract fixtures, terminal-brief routing, message-id ACK boundary, public-readiness scan, and external secrets. It does not yet include a dedicated end-to-end validation lane that cross-references Terminal Brief contracts against TaskFlow bridge expectations. This validation document closes that gap for R23, but future rounds should consider adding an automated cross-domain check.

4. **Cross-broker relay window safety**: This R23 dispatch opens no live relay window. Future rounds that activate cross-broker Terminal Brief projection must ensure the parent-seeded relay window does not accidentally expose child broker terminal evidence before the parent aggregation guard is deployed.

5. **Runtime bootstrap hygiene drift**: New contributors or tooling changes could reintroduce OpenClaw runtime/bootstrap context files (AGENTS.md, SOUL.md, USER.md, TOOLS.md, HEARTBEAT.md, IDENTITY.md, .openclaw/**, BOOTSTRAP.md, MEMORY.md, memory/**) into branch diffs, issue comments, or artifact evidence. The public-readiness scan catches tracked files, but untracked leaked context in GitHub comments or runner artifacts requires manual inspection per PR.

### Runtime activation blockers

The following are confirmed **hard blockers** for any future runtime activation (separate operator approval):

- Terminal Brief parent-origin routing contract v1 has been deployed to at least one broker and the four-case fixture invariant is verifiable against live routing metadata.
- TaskFlow bridge design has been implemented as a managed TaskFlow runtime (not just dry-run), with child evidence lane support and approval wait handling.
- The TaskFlow dry-run command passes against the current spec-first packet fixture and no spec/plan/tasks file drift exists.
- Monorepo release gate includes a cross-domain end-to-end check (or this validation matrix is re-verified) before any live provider send or broker restart.
- Cross-broker relay window is explicitly opened by operator approval and bounded to a single parent-seeded round with known parentRoundId, originBrokerId, and handoffBrokerId.
- This validation lane's R23 source-only GO/NO-GO is **GO** (currently `NO-GO / Waiting`).
- No sibling lane relies on Start-only evidence for final closeout.
- Runtime bootstrap hygiene is confirmed: no OpenClaw runtime/bootstrap context files are present in branch diff, PR body, issue comments, or artifact evidence.
- Operator approval is a separate downstream action not satisfied by any lane evidence alone.

## Source-only GO/NO-GO decision

**Current: `NO-GO / Waiting`.**

Transition to `GO` (source-only) requires:

- Terminal Brief parent-origin routing contract v1 is published as terminal validation evidence with linked PR/Done/Block markers and passing CI.
- TaskFlow spec-first bridge design and runtime dry-run each have terminal PR/Done/Block evidence.
- Monorepo release-gate coverage for Terminal Brief and TaskFlow domains is confirmed green.
- Cross-broker Terminal Brief owner semantics are reverified and no regression in the four-case fixture invariant is found.
- No runtime/bootstrap hygiene leaks are detected in branch diff, PR body, issue comments, or artifact evidence.
- This validation lane's PR has passing CI and local `npm run check` results.

**`GO` is a source-only decision.** It does not authorize runtime activation, production deploy, broker restart, Gateway restart, DB mutation, live provider send, Terminal Brief ACK, relay window opening, or any other live action. Source execution remains `NO_GO` until a separate explicit operator approval is captured as a distinct downstream artifact.

## Required checks before R23 closeout

- Terminal Brief parent-origin routing contract v1 and four-case fixture are unchanged or any changes are revalidated for invariant preservation.
- TaskFlow bridge design doc exists with state schema, lifecycle states, child lane linkage, finalizer closeout rules, and the `a2a-broker#634` mapping example.
- TaskFlow runtime dry-run command and test pass against the current fixture.
- Cross-broker Terminal Brief owner semantics are documented in `parent-terminal-brief-aggregation.md` v1 (contract), `terminal-brief-parent-origin-routing.json` (fixture), `terminal-brief-routing-contract.ts` (guard), and `broker-handoff-protocol.md` (handoff envelope). No new PRs have modified these files.
- `npm run check:message-id-ack-boundary` remains green.
- `npm run check:team2-final-go-no-go-semantics-libero` passes and the final GO/NO-GO semantics doc covers R23 lane boundaries.
- `npm run check` (full release gate) passes for this validation branch.
- This lane's validation test (`check-team2-soonwook-r23-terminal-brief-taskflow-monorepo-libero.test.mjs`) passes.
- No production deploy/restart/reload, live provider/Telegram send, DB mutation/prune/migration, Terminal Brief ACK/replay, historical outbox replay, release/tag, secret movement/disclosure, force-push/history rewrite, visibility change, or cross-broker relay window opening occurred in this validation lane.
- Branch diff, PR body, issue comments, and artifact evidence exclude OpenClaw runtime/bootstrap context files. Before PR creation, fail closed and report exact repo-relative or artifact-relative offending paths for any `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`, `BOOTSTRAP.md`, `MEMORY.md`, or `memory/**` file.

## Verification performed for this lane

- Inspected parent issue a2a-plane#335 (a2a-plane#335, internal tracker private) (R23 validation round) and this issue a2a-plane#338 (a2a-plane#338, internal tracker private).
- Inspected Terminal Brief parent-origin routing contracts: `parent-terminal-brief-aggregation.md` (v1 symmetric origin-broker), `broker-handoff-protocol.md` (v0 Freeze handoff envelope), `terminal-brief-routing-contract.ts` (four-level receipt model, OpenClaw-only outbound lifecycle routing), `handoff-scenarios.ts`, `two-broker-safety-matrix.ts`.
- Inspected Terminal Brief spec-first packet at `docs/specs/a2a-terminal-brief-parent-origin-routing/`.
- Inspected four-case routing fixture `fixtures/contract/terminal-brief-parent-origin-routing.json` with invariant `initiatingBroker == parentBrokerId == originBrokerId == operatorFacingTerminalBriefSender`.
- Inspected terminal evidence ACK boundary contract at `contracts/compatibility/terminal-evidence-ack-boundary.md` and its fixtures.
- Inspected TaskFlow bridge design doc at `docs/taskflow/a2a-spec-first-bridge.md` (state schema, lifecycle states, child lane linkage, approval boundaries, #634 mapping example).
- Inspected TaskFlow spec-first runtime dry-run spec at `docs/specs/a2a-spec-first-taskflow-runtime/` (spec, plan, tasks).
- Inspected TaskFlow spec-first bridge design spec at `docs/specs/a2a-spec-first-taskflow-bridge/` (spec, plan, tasks).
- Ran or reviewed: `scripts/a2a-spec-first-taskflow-runtime.mjs`, `scripts/a2a-spec-first-taskflow-runtime.test.mjs`, and fixture `fixtures/contract/a2a-spec-first-taskflow-runtime-dryrun.json`.
- Inspected monorepo release gate at `docs/release-gate.md` and compatibility matrix at `contracts/compatibility/matrix.md`.
- Reviewed public-readiness scanner at `scripts/public-readiness-scan.mjs`.
- Reviewed existing libero validation artifacts: R22 (`team2-soonwook-r22-broker-lightweight-libero.md`), R20 (`team2-soonwook-r20-libero-go-nogo-retry.md`), R16 (`team2-soonwook-r16-terminal-brief-libero.md`), and earlier R13/R15/R9/R9b validation artifacts.
- Confirmed no unapproved PRs have modified `terminal-brief-routing-contract.ts` guard, `parent-terminal-brief-aggregation.md` contract, or the four-case fixture invariant since the R22 validation snapshot.
- Confirmed `crossBrokerHandoff` metadata invariants, parent-round metadata fields, and projection ownership rules are preserved in contract and fixture definitions.
- Confirmed TaskFlow bridge design pre-dates R23 and was reviewed in the spec-first adoption cycle (#315/#322/#324).
- Added a local validation test that fails if required R23 gates, Terminal Brief/TaskFlow/monorepo domain coverage, risk list, source-only GO/NO-GO semantics, runtime activation blockers, ACK/receipt separation, or bootstrap hygiene language are removed.
- Confirmed this patch adds documentation/test evidence only and does not create runtime/bootstrap files in the repository.
