# A2A Nexus #831 advisory sidecar safety-boundary cross-check

analysisStatus: complete-source-only
issue: jinwon-int/a2a-nexus#831 — cross-check #831 safety boundaries: no live sidecar, no provider, no routing influence
startSha: 5c3c0425b1af133af2fc0a2dc33f5f820983c989
parentTracker: jinwon-int/a2a-nexus#834
startCommentUrl: https://github.com/jinwon-int/a2a-nexus/issues/831#issuecomment-4723566238

recommendation: needs PR-first implementation slice before closeout. The no-live-sidecar and no-provider-send boundaries are well covered in source, but the routing-influence boundary is not closeable because `resolveAdvisorySidecarRoutingPolicy()` can still return an `allowed` `advisory_sidecar` route from deterministic labels/capabilities. Even if the current policy is advisory-only and bypasses are false, #831's stated boundary asks for no routing influence; the present source leaves that boundary ambiguous.

## evidence

- `packages/broker/src/core/a2a-advisory-sidecar-contract.ts`
  - Lines 1-8 declare the recommendation contract pure/no-live and explicitly say it does not start a sidecar process, send providers, mutate broker state, or change dispatch/routing.
  - `validateAdvisorySidecarRecommendation()` rejects malformed output, `advisoryOnly !== true`, overlong/unbounded values, and secret-like fields.
  - `resolveAdvisorySidecarRecommendation()` returns deterministic fallback for disabled, timeout, unavailable, or malformed states.
  - `packages/broker/src/core/a2a-advisory-sidecar-contract.test.ts` covers validation, fallback, unsupported model preservation without authorization, secret-like field rejection, and advisory-only fallback.
- `packages/broker/src/core/a2a-advisory-sidecar-resolver.ts`
  - `ADVISORY_SIDECAR_DEFAULT_OFF_BOUNDARY` hardcodes `startsSidecarProcess: false`, `sendsProviderRequests: false`, `mutatesBrokerState: false`, `mutatesDatabase: false`, `dispatchesTasks: false`, and `changesRouting: false`.
  - `resolveDefaultOffAdvisorySidecarRecommendation()` treats missing/false `enabled` or missing/false `configured` as `effectiveStatus: "disabled"` and only passes raw output when both enabled and configured.
  - `packages/broker/src/core/a2a-advisory-sidecar-resolver.test.ts` verifies default-off fallback, raw-output ignore while disabled, enabled-but-unconfigured fallback, timeout/unavailable fallback, and the no-side-effect boundary flags.
- `packages/broker/src/core/a2a-advisory-sidecar-operator-decision.ts`
  - `createAdvisorySidecarOperatorDecisionPacket()` emits a source-only/no-live packet with `processSpawnPermitted`, `sidecarStartPermitted`, `providerSendPermitted`, `dispatchPermitted`, `routingChangePermitted`, `dbMutationPermitted`, `deployRestartPermitted`, `approvalGrantPermitted`, and `executionPermitted` all false.
  - The packet's integration contract also hardcodes `startsSidecarProcess: false`, `sendsProviderRequests: false`, `dispatchesTasks: false`, `changesRouting: false`, `grantsApproval: false`, and `executesAction: false`.
  - `packages/broker/src/core/a2a-advisory-sidecar-operator-decision.test.ts` verifies the packet remains default-off/source-only, excludes approval-sensitive execution paths, records guardrail refs, and is deeply immutable.
- `packages/broker/scripts/worker-model-policy.mjs`
  - `advisorySidecarWorkerModelPolicySnapshot()` reports `startsSidecarProcess: false`, `sendsProviderRequests: false`, `mutatesBrokerState: false`, `dispatchesTasks: false`, and all bypass flags false.
  - `resolveAdvisorySidecarFallbackDecision()` fails closed for disabled/unavailable/timeout/schema/bypass cases with `route: "default_worker"`, `startsSidecarProcess: false`, `sendsProviderRequests: false`, and `mutatesBrokerState: false`.
  - However, `ADVISORY_SIDECAR_ROUTING_POLICY.allowedRoute` is `"advisory_sidecar"`, and `resolveAdvisorySidecarRoutingPolicy()` can return `status: "allowed"` with `route: "advisory_sidecar"` when an activation label, allowed model, required capabilities, and no approval gate are present. That is the source-level ambiguity for #831's no-routing-influence boundary.
  - `packages/broker/scripts/a2a-task-handler.test.mjs` currently verifies both the no-bypass policy snapshot and the allowed advisory route path (#804), so a closeout claim of "no routing influence" would conflict with existing tested behavior unless the distinction is narrowed and documented.

## risks

- Closing #831 now could falsely certify "no routing influence" while the source still exposes a deterministic `advisory_sidecar` route decision.
- A live/runtime implementation might interpret `allowed` + `advisory_sidecar` as dispatch influence even though current source labels the policy advisory-only.
- Tightening the route behavior may break #804 expectations and any downstream tests or scripts that rely on the current allowed route value.
- Provider/model guardrails are source-tested, but unsupported model recommendations are intentionally preserved as advisory data in the contract; future dispatch layers must continue to enforce allowlists separately.

## proposedSlice

Smallest safe PR-first slice: make the no-routing-influence boundary explicit in the deterministic advisory-sidecar routing policy before closing #831.

Exact files/functions/tests:

1. `packages/broker/scripts/worker-model-policy.mjs`
   - Add an explicit policy field such as `routingInfluencePermitted: false`.
   - Change `resolveAdvisorySidecarRoutingPolicy()` so sidecar labels/capabilities cannot produce an operational `route: "advisory_sidecar"` unless a future, separately approved live-routing gate is introduced. While #831 is active, the safe return should remain `route: "default_worker"` or a finalizer-review route with `advisoryOnly: true`, `finalizerRequired: true`, and all bypass flags false.
   - Preserve `resolveAdvisorySidecarFallbackDecision()` as fail-closed and side-effect-free.
2. `packages/broker/scripts/a2a-task-handler.test.mjs`
   - Update #804 tests so an activation label proves advisory metadata only, not route selection.
   - Add a #831 regression asserting no input combination can return an operational `advisory_sidecar` route without a separately named approval/live-routing gate.
   - Keep tests for unsupported model, missing capability, approval-gate, schema-mismatch, and bypass attempts.
3. Optional documentation update if the behavior distinction is intentionally not changed:
   - Add a short contract note in `contracts/a2a/harness-neutral-analysis-adapter.md` or `contracts/a2a/action-reconciliation.md` clarifying that advisory-sidecar labels are evidence-only and cannot select dispatch/routing targets.

Acceptance checks:

- `node --test packages/broker/scripts/a2a-task-handler.test.mjs`
- `npm run check:terminal-brief-routing`
- `npm run check:current-state-no-live-smoke`
- `npm run test:release-gate` if the slice changes release-gate-covered routing semantics.

## tests

This evidence patch adds `scripts/check-a2a-nexus-831-advisory-sidecar-boundary-cross-check.test.mjs`, a source-only document regression that verifies:

- all required output fields are present;
- the recommendation is PR-first rather than close-now;
- no-live-sidecar, no-provider-send, and no-routing-influence evidence is tied to exact source files/functions/tests;
- the routing ambiguity around `resolveAdvisorySidecarRoutingPolicy()` and `advisory_sidecar` is explicitly captured;
- non-actions preserve noLive/sourceOnly constraints and no runtime/bootstrap context paths enter the branch.

## closeability

not closeable now. #831 should remain open until the routing-influence ambiguity is resolved by the PR-first slice above, or until maintainers explicitly narrow #831 to "no sidecar recommendation can bypass deterministic routing" instead of the stronger "no routing influence" wording. The no-live-sidecar and no-provider-send portions are closeout-ready from current source/tests; the routing-influence portion is not.

## nonActions

- Did not start a sidecar, worker, broker, Gateway, provider, or local service.
- After the runner-posted Start marker above, this source-only patch work did not call a provider, send Telegram messages, create additional GitHub comments, create PRs/issues, deploy, restart, mutate DB/state, move secrets, ACK terminal outbox rows, or change routing in a live system.
- Did not run `git commit`, `git push`, or `gh pr create`.
- Did not add OpenClaw runtime/bootstrap context files to the branch or evidence. Guard check found no repo-relative offending paths among `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.
