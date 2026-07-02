# Team1 Scheduler / Control-Tower Libero Validation Matrix

Parent: #434 (a2a-plane#434, internal tracker private)
Assigned: #448 (a2a-plane#448, internal tracker private)
Run: `a2a-team1-scheduler-control-tower-20260525T2255KST`
Broker of record: `brokerAlpha`
Team: `team1`
Worker: `workerDelta`
Reviewed at: `2026-05-25T22:55:00Z`

This is a validation artifact only. It validates the scheduler/control-tower policy spec
against existing contracts, the three-broker lane topology, and the source-only activation
boundaries defined in the A2A Nexus public-private boundary gates.

This validation does not change repository visibility, import private source history, deploy,
restart Gateway/broker/worker services, mutate production databases, send provider or Telegram
messages, ACK terminal outbox rows, rotate or disclose credentials, rewrite history, force-push,
publish a release, or post to community channels.

---

## Evidence Reviewed

### Spec under review

- `docs/specs/a2a-scheduler-control-tower/spec.md` (this PR)

### Existing contracts cross-checked

| Contract | Path | Version/Freeze |
| --- | --- | --- |
| Worker Registration | `contracts/a2a/worker-registration.md` | v0 Freeze (2026-05-09) |
| Worker Capability Profile | `contracts/a2a/worker-capability-profile.md` | R31 (2026-05-16) |
| Task Lifecycle | `contracts/a2a/task-lifecycle.md` | v0 Freeze (2026-05-09) |
| Broker Handoff Protocol | `contracts/a2a/broker-handoff-protocol.md` | v0 Freeze (2026-05-09) |
| Terminal Semantics | `contracts/a2a/terminal-semantics.md` | v0 Freeze |
| Cancellation Idempotency | `contracts/a2a/cancellation-idempotency.md` | v0 Freeze |
| Compatibility Baseline | `contracts/compatibility/matrix.md` | R23 milestone |
| Public-Private Boundary Gates | `docs/governance/public-private-boundary-gates.md` | — |
| Bare / existing issues: #434 (a2a-plane#434, internal tracker private), #448 (a2a-plane#448, internal tracker private) | — | — |

### Existing validation matrices cross-checked

| Matrix | Path | Lane |
| --- | --- | --- |
| Team1 source-dryrun orchestrator | `docs/validation/team1-source-dryrun-orchestrator-libero.md` | workerDelta |
| Team1 source-public execution orchestrator | `docs/validation/team1-source-public-execution-orchestrator-libero.md` | workerDelta |
| Team1 roadmap cross-check | `docs/validation/team1-roadmap-cross-check.md` | workerDelta |
| Team1 workerDelta plane gates 527-497-294 | `docs/validation/team1-workerDelta-plane-gates-527-497-294.md` | workerDelta |
| Team2 brokerBeta cross-broker readiness | `docs/validation/team2-brokerBeta-cross-broker-readiness.md` | Team2 |

---

## Validation Matrix

### Gate 1: Worker Capacity Semantics

| Criterion | Required condition | Observed | Libero decision |
| --- | --- | --- | --- |
| Extends existing profile without breaking v0 freeze | Capacity fields are additive (`softConcurrencyLimit`, `queueDepth`, `queueCapacityClass`, `capacityScore`). No existing field is renamed, removed, or redefined. | The spec §1.1 table marks `maxConcurrentTasks` as inherited from Capability Profile. All new fields have defaults and do not change the frozen profile schema. | **Pass** |
| Capacity scoring is deterministic and documented | §1.2 defines weights, score tiers, and scheduling behavior. | `capacityScore` derivation is formula-driven with explicit weight tables. | **Pass** |
| Capacity evidence in terminal briefs preserves existing phrasing conventions | §1.4 defers to `worker-capability-profile.md` § "Capacity-Limited Slow Lane Phrasing". | No new phrasing introduced; reference-only. | **Pass** |
| Rebalance triggers are bounded and documented | §1.3 lists 5 discrete triggers. | No infinite loops or cascading triggers. Rebalance operates on queued tasks only, not running tasks. | **Pass** |

### Gate 2: Scheduler Dry-Run Acceptance Criteria

| Criterion | Required condition | Observed | Libero decision |
| --- | --- | --- | --- |
| Dry-run evidence packet shape is defined | §2.1 provides a JSON schema. | Schema includes `failClosed`, `defaultDecision`, worker entries with `capacityScore`, `gates`, and `sourcePublicExecution`. | **Pass** |
| Mandatory gates are enumerated | §2.2 lists 8 gates with GO conditions. | All gates are specific, testable, and fail-closed. Default decision is NO-GO. | **Pass** |
| No mutation guarantee | Gate `noMutationEvidence` requires a `noMutationHash`. | Clear evidence requirement. | **Pass** |
| Determinism | Gate `assignmentDeterminism` and `replayIdempotent` require identical output for identical input. | Multi-run determinism is explicitly gated. | **Pass** |
| Dry-run → Simulate → Execute progression | §2.4 defines three-stage activation. | Each stage requires explicit operator approval for the next. Simulate cannot skip a failing dry-run. | **Pass** |

### Gate 3: Libero / Validator Assignment Rules

| Criterion | Required condition | Observed | Libero decision |
| --- | --- | --- | --- |
| Role definitions distinguish execution from libero tasks | §3.1 defines Execution, Libero, and Validator roles with workload strength mappings. | Clear separation. Execution carries `code-patch`, `build-test`, `docs-evidence`, `fixtures`. Libero carries `validation-libero`, `inspection`. | **Pass** |
| Same-team preference | §3.2 rule 1: prefer same-team libero. | Reasoned heuristic; not a hard requirement. | **Pass** |
| Cross-team mandatory for handoff tasks | §3.2 rule 2: handoff tasks MUST use destination broker's team. | Consistent with broker-handoff-protocol.md § "Broker of record" invariant. | **Pass** |
| Self-validation exclusion | §3.2 rule 3: execution worker must not validate own output. | Hard block, not a preference. Correct for safety. | **Pass** |
| Capacity check | §3.2 rule 4: libero worker needs `capacityScore` ≥ 0.5. | Yellow tier minimum. | **Pass** |
| Explicit override with reason | §3.2 rule 5: operator override must be recorded. | Override reason is required evidence. | **Pass** |
| Validation assertions in evidence | §3.3 lists 6 required assertions. | All are specific and testable. | **Pass** |

### Gate 4: Stuck / Backoff Safety Gates

| Criterion | Required condition | Observed | Libero decision |
| --- | --- | --- | --- |
| Stuck detection thresholds | §4.1 defines `stuckTimeoutMs` (30 min), `stuckActivityWindowMs` (10 min), `stuckCheckIntervalMs` (5 min). | All thresholds are documented with recommended defaults. | **Pass** |
| Backoff schedule is bounded | §4.2 defines exponential backoff from 1 min to 2 h, then BLOCKED at 5+ retries. | Schedule is finite. Maximum 4 retries before operator escalation. | **Pass** |
| Worker-level stuck throttle | §4.3 deprioritizes workers after 3, 5, or 10 consecutive stuck tasks. | Throttle is graduated. Counter resets on successful outcome. | **Pass** |
| Escalation path | §4.4: task transitions to `blocked` with reason `stuck-escalation`; operator notified. | Consistent with `task-lifecycle.md` BLOCKED terminal state. | **Pass** |
| No infinite loops | All counters have upper bounds; throttle resets. | Backoff and throttle are finite and bounded. | **Pass** |

### Gate 5: Source-Only Activation Boundaries

| Criterion | Required condition | Observed | Libero decision |
| --- | --- | --- | --- |
| Source-only file scope defined | §5.1 lists `docs/`, `contracts/`, `scripts/`, root metadata, `.github/`, `examples/`, `fixtures/`. | All source-only-safe paths enumerated. | **Pass** |
| Non-source paths called out | §5.2 lists `packages/broker/`, `packages/openclaw-plugin-a2a/`, `packages/docker-runner/`, infra config, secrets, DB schemas. | Clear boundary. No ambiguity. | **Pass** |
| Preconditions before activation | §5.3 lists 6 preconditions: dry-run pass, tests pass, libero cross-check, no stale profiles, capacity fixture tested, operator approval separate. | Preconditions are verifiable and testable. No gap. | **Pass** |
| Source-only execution is NO-GO by default | §5.4 explicitly states source-only execution is always NO-GO until operator approval recorded separately. | Consistent with existing dry-run and orchestrator contracts. | **Pass** |

### Gate 6: Three-Broker Lane Cross-Check

| Criterion | Required condition | Observed | Libero decision |
| --- | --- | --- | --- |
| Lane summary | §6.1 table identifies brokerAlpha (Team1), brokerBeta (Team2), and cross-broker handoff lanes. | Worker names and roles are correctly identified. | **Pass** |
| Cross-check dimensions | §6.2 evaluates capacity profile, libero routing, stuck handling, slow-lane phrasing, source-only activation, and dry-run capability across all three lanes. | Each dimension has a finding and libero decision. Team1 is the primary implementation; Team2 is deferred or default. | **Pass** |
| Integration risks documented | §6.3 lists 3 risks: Team2 capacity model gap, handoff stuck escalation gap, libero availability fallback. | Risks are specific, actionable, and have follow-up recommendations. | **Pass** |
| Recommendation | §6.4 recommends merge, defers Team2 adoption, and files follow-up issues. | Consistent with existing roadmap cross-check patterns. | **Pass** |

### Gate 7: Contract Compatibility and Consistency

| Criterion | Required condition | Observed | Libero decision |
| --- | --- | --- | --- |
| No conflict with existing contracts | Spec does not redefine frozen fields, remove transitions, or contradict terminal semantics, handoff protocol, or registration schema. | Spot-check: capacity extensions are additive; stuck handling uses task lifecycle `blocked` state; libero rules respect handoff broker-of-record invariant. | **Pass** |
| Capacity-limited slow lane phrasing defers to existing contract | §1.4 references `worker-capability-profile.md` phrasing conventions. | No duplicate phrasing; single source of truth preserved. | **Pass** |
| Libero assignment uses `validation-libero` workload strength, which exists in the capability profile vocabulary | `validation-libero` is listed in `worker-capability-profile.md` § "Workload strengths". | Strength label is consistent and not invented. | **Pass** |
| Stuck/backoff does not contradict termination semantics | Stuck escalation transitions to `blocked`, which is a valid terminal state in `task-lifecycle.md`. | Consistent. | **Pass** |

### Gate 8: Safety and Approval Boundaries

| Criterion | Required condition | Observed | Libero decision |
| --- | --- | --- | --- |
| No secrets, private paths, or runtime context in branch diff | PR must not include `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`. | This validation matrix and the spec document contain only public-safe worker names, GitHub identifiers, and policy text. | **Pass** |
| Approval checklist includes all restricted actions | §7.2 lists deploy, restart, canary, DB mutation, ACK, replay, release, secrets, visibility, force-push, merge. | The box "None of the above" is checked. No restricted action is authorized by this spec. | **Pass** |
| Evidence contract is documented | §8 lists all artifacts: spec, validation matrix, parent issue, assigned issue. | Clear artifact map. | **Pass** |
| Rollback path is documented | §9 defines failure indicators, restoration, safe cleanup, and fresh-approval boundaries. | No production state was touched; rollback is branch-level only. | **Pass** |

---

## Aggregate Libero Decision

**Decision: GO for merge (source-only spec).** All validation gates pass. The scheduler/control-tower spec extends existing contracts consistently, defines deterministic dry-run criteria, establishes libero/validator assignment rules with self-validation protection, models bounded stuck/backoff escalation, and clearly documents source-only activation boundaries. The three-broker lane cross-check identifies implementation gaps (Team2 capacity model, handoff stuck escalation) but does not block this spec.

### Follow-Up Issues

| Issue | Description | Priority |
| --- | --- | --- |
| Handoff stuck escalation | Extend broker-handoff-protocol.md with stuck-detection and escalation semantics for relayed tasks. | Medium (before cross-team capacity scheduling is enabled). |
| Libero fallback behavior | Document what happens when the preferred libero worker is unavailable or capacity-constrained. | Low (current default heuristic is safe). |
| Team2 capacity profile adoption | Add Team2 workers to the capability profile schema with initial defaults. | Low (Team1 spec is forward-compatible). |

### Risks Noted for Approver

1. **Team2 capacity model**: The spec assumes conservative defaults for workers without profiles.
   This is safe but will produce suboptimal assignments until Team2 adopts the profile schema.
2. **Handoff stuck gap**: Cross-broker tasks that get stuck on the destination side have no explicit
   escalation path in the handoff protocol. This spec defines scheduler-level gates, but the
   handoff contract should be extended separately.
3. **Libero availability**: If all `validation-libero` workers on a team are busy, the scheduler
   falls to default heuristics. A separate fallback doc would help operators understand behavior.

---

## Safety Confirmation

This validation used only local repository inspection, GitHub issue metadata (public issue/PR
identifiers), and this documentation update. It did not perform:

- Production deploys, Gateway/broker/worker restarts, or live provider/Telegram sends
- Production database mutations, terminal-outbox ACKs, or credential rotations
- Repository visibility changes, source-history imports, or release publication
- History rewrites, force pushes, raw credential disclosure, or raw session dump publication
- Host-private path disclosure or runtime/bootstrap evidence publication

Provider send success and provider message IDs remain accepted-send evidence only and are not
requester-visible receipt, operator-visible receipt, human-seen proof, terminal ACK, or
terminal-outbox ACK evidence.
