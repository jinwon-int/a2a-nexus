# A2A open-issue cleanup after PR #886

Worker lane focus: implementation slice selection and issue graph consistency.

Start marker: https://github.com/jinwon-int/a2a-nexus/issues/880#issuecomment-4738680174

Scope reviewed: currently open payload issues #880, #881, #882, #884, and #885 after PR #886 merged.
This document is a source-backed worker opinion only. It does not apply GitHub labels, edit issue bodies, close issues, dispatch A2A tasks, deploy, restart, mutate data, send provider messages, release, publish, or change repository visibility.

## 1. Per-issue recommendations

| Issue | Classification | Recommended labels | Recommended body edit or comment text | Stay open? |
| --- | --- | --- | --- | --- |
| #880 - repo optimization / one-off process artifacts | actionable | Keep `enhancement`, `validation`; add `worker-task` only if the finalizer wants implementation children tracked from this issue. | Comment: "After PR #883, the shared `scripts/lib/doc-check.mjs` helper exists and two duplicated monorepo checks were refactored. Keep this issue open for the remaining cleanup roadmap, but do not remove release-gate steps until a source-backed gate inventory classifies each step as core, public-readiness, historical, or approval-gated. The next cleanup PR should be either another small helper-adoption batch or a report-only release-gate inventory." | Yes |
| #881 - a2a-nexus public transition checklist | blocked | Keep current labels: `a2a-public`, `safety-gate`, `no-go-public`, `public-transition`, `promotion-readiness`, `docs`, `validation`. No new implementation label recommended. | Body edit: mark the root `package.json` description item as resolved/superseded by PR #879; keep `private: true` as a package-publication guard unless a separate publish decision changes it. Keep the remaining blockers explicit: external secret/history scanner evidence, plugin package license metadata/package-level LICENSE decision, redacted inventory disposition, and separate operator approval for any private-to-public visibility action. | Yes |
| #882 - meta-process/data-driven engine optimization | parent | Keep `enhancement`, `worker-task`, `validation`. | Comment: "Treat #882 as the broader parent for development-orchestration convergence. #880 is the concrete cleanup child. Do not collapse this into #880: #882 covers data-driven engines, manifest/spec registries, round-output-as-data, and recurrence-prevention guards. Split future PRs as: inventory/report-only first, small helper adoption second, manifest/spec-registry prototype third, and only then release-gate tiering or npm-script namespace cleanup." | Yes |
| #884 - A2AD read-only analyze lanes return wrapper-only generic evidence | actionable | Keep `worker-task`, `safety-gate`, `validation`, `source:a2a-broker`; add `blocker` if finalizer wants it to gate future claims of A2AD worker consensus. | Comment: "PR #886 resolved the lane workspace `nodeId` dispatch blocker, but #884 should remain open. Remaining acceptance criteria are substantive read-only analysis output and exact wrapper-only evidence classification. The next smallest code slice should add a deterministic regression for the literal generic output (`generic analyze task accepted by versioned A2A task handler`) and classify it as `wrapper_only`/non-substantive for analysis/review lanes, without changing live dispatch or comments." | Yes |
| #885 - A2A/A2AD reasoning-performance uplift R&D | parent | Keep `enhancement`, `safety-gate`, `validation`; add `docs` for the spec-first packet; add `worker-task` only after an approved implementation task is split out. | Body edit: add an explicit dependency note: "Blocked on #884 for reliable substantive/non-substantive evidence classification before any debate/reflection/search mode can be evaluated. First PR should be docs/spec only under `docs/specs/a2ad-reasoning-uplift/`, with no runtime mode switch and no persisted memory beyond redacted, finalizer-approved fields." | Yes |

No issue in this payload is closeable now. None is a duplicate. #881 is intentionally separate from the code/process cleanup issues because visibility change and package/publication approval remain separate safety gates.

## 2. Cross-issue graph

- #882 is the broad parent for development-orchestration/meta-process convergence.
  - #880 is the concrete, near-term cleanup child under #882. It may also act as the local tracker for small cleanup PRs such as helper adoption and release-gate inventory.
  - #884 is an infrastructure/evidence-quality child that blocks claims of A2AD-backed consensus for #880/#882 work until read-only analysis output is substantive or classified as non-substantive.
  - #885 is an R&D/spec parent or child-of-#882, depending on finalizer taxonomy. It should depend on #884 before any reasoning-performance evaluation claims are accepted.
- #881 is an independent public-readiness/visibility parent. It shares safety non-actions with the other issues but is not a child or duplicate of #880/#882/#884/#885.
- Superseded sub-slices:
  - PR #883 supersedes only the first #880/#882 helper-extraction slice; it does not supersede the release-gate diet, npm-script cleanup, or data-driven engine work.
  - PR #886 supersedes only the #884 `workspace.nodeId` dispatch sub-blocker; it does not supersede the substantive read-only analysis bridge or wrapper-only evidence classification acceptance criteria.
  - PR #879 supersedes part of #881's stale wording item by updating public-readiness language, but does not supersede the no-go public transition issue.

## 3. PR slice recommendation

Recommended next implementation slice: #884 wrapper-only classifier regression.

Smallest safe code slice:

1. Add a unit test in `packages/broker/src/core/round-result-collector.test.ts` for a succeeded analysis/review lane whose result summary or output message is exactly `generic analyze task accepted by versioned A2A task handler` and whose findings/recommendations are empty.
2. Extend `isWrapperOnlySuccess` in `packages/broker/src/core/round-result-collector.ts` so that exact generic analyze-handler output is `wrapper_only`.
3. Verify that an analysis/review lane with this output is blocked/non-substantive and does not count toward `summary.substantiveEvidence` or finalizer success.
4. Run the narrow test (`npm --workspace packages/broker run test -- round-result-collector` or the repository's equivalent TypeScript test command) plus `npm run check:packages` if dependencies are available.

Why this slice first:

- It is smaller and safer than removing release-gate steps, changing package-publication metadata, or adding new A2AD reasoning modes.
- It directly addresses the payload's lane focus: issue graph consistency and implementation slice selection after PR #886.
- It is source-only and deterministic. It does not dispatch broker tasks, post GitHub comments, mutate a database/outbox, send provider messages, or change visibility.

Do not select a release-gate diet PR yet. #880/#882 need a report-only gate inventory before any gate removal because `scripts/release-gate.mjs` still mixes core checks, public-readiness checks, package/publication checks, and historical monorepo/canonical-flip checks.

## 4. Evidence refs

Issue evidence:

- #880 body: measurement table for `scripts/*.mjs`, root and broker npm scripts, release-gate steps, and docs; optimization priorities for release-gate diet, helper commonization, npm script cleanup, CI caching/parallelization, and docs archiving.
- #880 comment "PR1 landed - safe helper-extraction slice": PR #883 merged `scripts/lib/doc-check.mjs` and refactored two monorepo validation scripts; larger cleanup remains open pending a gate-by-gate classification table.
- #880 preliminary finalizer review: #880 concrete repo-optimization parent, #882 broader meta-process parent, #884 blocker/infra issue, #881 separate public-readiness tracker.
- #881 body: public-transition checklist and blockers: external secret/history scanner, plugin license metadata, redacted inventory disposition, operator approval for visibility.
- #881 triage comment: PR #879 updated root package description and public-readiness wording, while repository visibility remains private/no-go.
- #882 body: scale of 93 `check-*` scripts, 37 current release-gate steps in source, 111 root npm scripts, 149 broker scripts, and data-driven dispatch precedent.
- #884 body and comments: read-only analyze lanes were rejected or returned wrapper-only generic output; later full triage attempts hit lane workspace mismatches and timeouts; PR #886 fixed only GitHub lane workspace derivation.
- #885 body: R&D scope for ReAct/reflection/tree-search/debate/evaluation, explicit no-live boundaries, and proposed spec-first packet.

SourceBundle/repo evidence:

- `scripts/release-gate.mjs`, `steps` array: current source has 37 release-gate steps, including core checks and many monorepo/canonical-flip/publication/approval steps. This supports the recommendation to inventory before removing gates.
- `scripts/lib/doc-check.mjs`, `createDocCheckContext`: PR #883's helper exists and centralizes `fail`, `expect`, `readRel`, `parseJson`, and `finish`.
- `package.json`, root metadata and scripts: description now says public-readiness alpha and approval-gated visibility/package publication; `private: true` remains. Root scripts include `release-gate`, `test:conformance`, many monorepo/public-readiness checks, and 111 total scripts by local count.
- `packages/broker/package.json`, scripts section: broker currently has 149 scripts and 38 script keys containing `sidecar` by local count, matching #880/#882's script-surface concern.
- `packages/openclaw-plugin-a2a/package.json`, metadata: package is `private: true` and has no `license` field; `packages/openclaw-plugin-a2a/LICENSE*` is absent. This keeps #881's plugin license blocker open.
- `docs/current-state.md`, snapshot/status and active work sections: source-state canonical flip is executed at package level while external/live execution-sensitive actions remain separate.
- `docs/public-readiness.md`, current-state decision table: repo visibility remains private unless separately approved, external scanner remains a NO-GO/Waiting item, and runtime/bootstrap hygiene guard paths are explicitly fail-closed.
- `docs/a2ad-round-dispatch.md`, GitHub verify/read-only validation lanes section: after PR #886, inherited GitHub lane workspaces preserve `workspaceId` and stamp `nodeId` from each target worker; explicit mismatches fail closed.
- `scripts/a2a-dispatch-round.mjs`, `deriveWorkspaceForLane`, `validateGitHubVerifyLane`, and `buildCreateTaskBody`: source now implements the PR #886 workspace derivation/pass-through behavior.
- `contracts/a2a/harness-neutral-analysis-adapter.md`, required adapter output/evidence classification/finalizer rules: `wrapper_only` is explicitly non-substantive and only substantive lanes count as worker opinions.
- `fixtures/contract/harness-neutral-analysis-adapter.json`, evidenceClasses and `wrapper-only-success` scenario: fixture freezes `wrapper_only` as not counting as a worker opinion.
- `test/conformance/check-contract-fixtures.mjs`, harness-neutral analysis assertions: conformance verifies the closed evidence classes and that wrapper/source-blocked/handler/provider/queued scenarios do not count as worker opinions.
- `packages/broker/src/core/round-result-collector.ts`, lane evidence/readiness types and classification path: source already has `wrapper_only` and blocks succeeded analysis/review lanes whose evidence class is not substantive, but `isWrapperOnlySuccess` only recognizes echo/prompt-message wrapper cases and not the exact #884 generic analyze-handler phrase.
- `packages/broker/src/core/round-result-collector.test.ts`: existing collector tests cover core lane states and evidence URLs; the recommended #884 exact generic-output regression should be added here.

Local read-only counts used above:

- `scripts/*.mjs`: 139.
- `scripts/check-*.mjs`: 93.
- root `package.json` scripts: 111.
- `packages/broker/package.json` scripts: 149, with 38 script keys containing `sidecar`.
- `scripts/release-gate.mjs` current steps: 37.

## 5. Risks and explicit non-actions

Risks:

- If #880 release-gate steps are removed before inventory, active safety/public-readiness/package gates could be accidentally retired as "historical".
- If #884 is closed after PR #886, future A2AD rounds may again treat dispatch/readback or wrapper-only output as substantive worker consensus.
- If #885 proceeds before #884's classifier/bridge semantics are stable, debate/reflection/search modes may optimize verbosity rather than correctness and may amplify false Done/Block decisions.
- If #881 is mixed into cleanup work, repository visibility or package-publication approval boundaries could be blurred.

Explicit non-actions performed by this worker:

- No GitHub issue body edits, label edits, comments, closures, PR creation, merges, or releases.
- No A2A/A2AD broker dispatch, deploy, service restart, live provider/Telegram send, Terminal Brief ACK/replay, database/outbox mutation, secret movement/disclosure, repository visibility change, history rewrite, or force-push.
- No OpenClaw runtime/bootstrap context files were added to this branch or cited as evidence.
- No raw session dumps, secrets, provider payloads, or host-private paths were written into this report.
