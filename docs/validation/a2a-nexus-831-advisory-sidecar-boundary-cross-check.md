# A2A Nexus #831 advisory sidecar safety-boundary cross-check

analysisStatus: complete-source-only
issue: jinwon-int/a2a-nexus#831 — read-only advisory sidecar readiness evidence
startSha: 5c3c0425b1af133af2fc0a2dc33f5f820983c989
parentTracker: jinwon-int/a2a-nexus#834
startCommentUrl: https://github.com/jinwon-int/a2a-nexus/issues/831#issuecomment-4723566238
workerTask: a2a-open-cleanup-20260616T204949Z-yukson-issue-831
worker: yukson
finalizerUpdate: PR #835 adds the code/test slice that resolves the worker-identified routing-influence ambiguity.

recommendation: PR-first implementation slice is required and included in this branch. Before this PR, the no-live-sidecar and no-provider-send boundaries were already source-covered, but the routing-influence boundary was ambiguous because `resolveAdvisorySidecarRoutingPolicy()` could return `status: "allowed"` with an operational-looking `route: "advisory_sidecar"`. This PR keeps advisory metadata allowed while making operational routing stay on `default_worker` and exposing `routingInfluencePermitted: false` / `operationalRoutingChanged: false` evidence.

## evidence

- `packages/broker/src/core/a2a-advisory-sidecar-contract.ts`
  - The recommendation contract remains pure/no-live and does not start a sidecar process, send providers, mutate broker state, or change dispatch/routing.
  - `validateAdvisorySidecarRecommendation()` rejects malformed output, `advisoryOnly !== true`, overlong/unbounded values, and secret-like fields.
  - `resolveAdvisorySidecarRecommendation()` returns deterministic fallback for disabled, timeout, unavailable, or malformed states.
- `packages/broker/src/core/a2a-advisory-sidecar-resolver.ts`
  - `ADVISORY_SIDECAR_DEFAULT_OFF_BOUNDARY` hardcodes `startsSidecarProcess: false`, `sendsProviderRequests: false`, `mutatesBrokerState: false`, `mutatesDatabase: false`, `dispatchesTasks: false`, and `changesRouting: false`.
  - `resolveDefaultOffAdvisorySidecarRecommendation()` treats missing/false `enabled` or missing/false `configured` as `effectiveStatus: "disabled"` and ignores raw sidecar output unless both are true.
- `packages/broker/src/core/a2a-advisory-sidecar-operator-decision.ts`
  - `createAdvisorySidecarOperatorDecisionPacket()` emits a source-only/no-live packet with all execution-sensitive permissions false.
  - The integration contract hardcodes `startsSidecarProcess: false`, `sendsProviderRequests: false`, `dispatchesTasks: false`, `changesRouting: false`, `grantsApproval: false`, and `executesAction: false`.
- `packages/broker/scripts/worker-model-policy.mjs`
  - `advisorySidecarWorkerModelPolicySnapshot()` now includes `routingInfluencePermitted: false` alongside `startsSidecarProcess: false`, `sendsProviderRequests: false`, `mutatesBrokerState: false`, and `dispatchesTasks: false`.
  - `ADVISORY_SIDECAR_ROUTING_POLICY.allowedRoute` is now `"default_worker"`, with the non-operational metadata candidate preserved separately as `advisoryCandidateRoute: "advisory_sidecar"`.
  - `resolveAdvisorySidecarRoutingPolicy()` can still return `status: "allowed"` for advisory metadata when labels/model/capabilities pass, but it returns `route: "default_worker"`, `routingInfluencePermitted: false`, and `operationalRoutingChanged: false`.
  - `resolveAdvisorySidecarFallbackDecision()` remains fail-closed and side-effect-free.
- `packages/broker/scripts/a2a-task-handler.test.mjs`
  - #804 tests are updated so activation labels prove advisory metadata only, not operational route selection.
  - #831 regression asserts no input combination can return an operational sidecar route without a future, separately named live-routing gate.

## risks

- Downstream code that interpreted `allowedRoute: "advisory_sidecar"` as a future operational route must now use `advisoryCandidateRoute` for metadata only.
- This PR intentionally does not start, configure, or test any live advisory sidecar process.
- This PR narrows #831 only; #764 remains the umbrella for any future operator-approved live sidecar activation work.

## proposedSlice

Implemented in this PR:

1. `packages/broker/scripts/worker-model-policy.mjs`
   - Add `routingInfluencePermitted: false`.
   - Keep advisory candidate metadata separate from operational routing.
   - Ensure allowed advisory metadata keeps `route: "default_worker"` and `operationalRoutingChanged: false`.
2. `packages/broker/scripts/a2a-task-handler.test.mjs`
   - Update #804 assertions for advisory metadata-only routing.
   - Add #831 no-operational-sidecar-route regression.
3. This validation doc/test records the A2A evidence and closeout boundary.

## tests

Expected validation:

- `node --test packages/broker/scripts/a2a-task-handler.test.mjs`
- `npm run check:a2a-nexus-831-advisory-sidecar-boundary-cross-check`
- `npm run check:terminal-brief-routing`
- `npm run check:current-state-no-live-smoke`
- `npm run test:release-gate`

## closeability

#831 is closeable after this PR merges and the checks above pass, because the remaining ambiguity identified by the A2A worker is resolved in source and covered by regression tests. #764 should remain open as the broader optional advisory sidecar umbrella.

## nonActions

- Did not start a sidecar, worker, broker, Gateway, provider, or local service.
- Did not deploy, restart, mutate DB/state, move secrets, ACK terminal outbox rows, publish a release/tag, or change routing in a live system.
- The A2A runner created the PR-first branch/PR as GitHub evidence for the source-only task; finalizer changes in this branch are limited to source/docs/tests.
- No runtime/bootstrap context files are intentionally added to the branch or evidence.
- No raw secrets, bearer tokens, raw session dumps, or broker edge secrets are recorded here.
