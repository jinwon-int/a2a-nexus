# Round Coordinator Spec — Team1/nosuk Libero Validation

**Lane:** Team1 nosuk (3/4)
**Run:** `a2a-team1-round-coordinator-20260526T201140KST`
**Parent tracker:** [a2a-broker#927](https://github.com/jinwon-int/a2a-broker/issues/927)
**Lane issue:** [a2a-plane#467](https://github.com/jinwon-int/a2a-plane/issues/467)
**Broker/finalizer of record:** `seoseo`

---

## Purpose

This document validates the round coordinator spec/runbook/schema definitions
against the parent tracker's requirements and the a2a-plane project's existing
conventions. It does not execute, deploy, or authorise any live action.

## Scope

| Property | Value |
|---|---|
| Validation type | Libero (independent source review) |
| Artifacts reviewed | `docs/specs/a2a-round-coordinator/spec.md`, `runbook.md`, `schema.json` |
| Related artifacts | Parent closeout go/no-go schema, dispatch-wrapper runbook, round closeout reconciler |
| Source-safe | Yes — no broker, Gateway, or worker mutation |
| No-live | Yes — no provider send, DB mutation, terminal ACK |

## Validation checklist

### §1 Structural completeness

| # | Check | Pass/Fail | Notes |
|---|---|---|---|
| 1.1 | Spec defines coordinator lifecycle states | ✅ | SEEDED → TRACKING → ALL_DONE/TIMED_OUT → READY → CLOSED |
| 1.2 | State transition table present | ✅ | Section 2.2 |
| 1.3 | Cursor-based polling defined | ✅ | Section 2.3 — monotonic cursor with observedTaskIds |
| 1.4 | Backoff collector behavior defined | ✅ | Section 2.4 — exponential backoff with jitter, progress reset |
| 1.5 | Lane status classification defined | ✅ | Section 3 — 8 statuses with priority order |
| 1.6 | Evidence requirements defined | ✅ | Section 3.3 — prUrl/doneCommentUrl/blockCommentUrl/branchUrl |
| 1.7 | Closeout bundle format defined | ✅ | Section 4 — complete JSON schema |
| 1.8 | Human finalizer boundary defined | ✅ | Section 5 — clear split of owned actions |
| 1.9 | Approval-sensitive action gates defined | ✅ | Section 6 — always-refused vs override-gated |
| 1.10 | Worker capability policy defined | ✅ | Section 7 — maxConcurrency, noLive, noMutation, mobileStandby |
| 1.11 | Transition path from human polling defined | ✅ | Section 8 — three stages + rollback |
| 1.12 | Team1/Team2/cross-team examples present | ✅ | Section 9 — 4 examples |
| 1.13 | Interaction with existing components | ✅ | Section 10 — dispatch wrapper, closeout matrix, reconciler, broker |
| 1.14 | Source-only/no-live declaration | ✅ | Section 11 |
| 1.15 | Safety confirmation table | ✅ | Section 12 |

### §2 Runbook completeness

| # | Check | Pass/Fail | Notes |
|---|---|---|---|
| 2.1 | Command shape and invocation examples | ✅ | Runbook §1.1 |
| 2.2 | Manifest format documented | ✅ | Runbook §2 — including Team2, cross-team, mobile standby |
| 2.3 | Cursor management documented | ✅ | Runbook §3 — format, seed, reset, persistence |
| 2.4 | Backoff tuning documented | ✅ | Runbook §4 — defaults, overrides, progress reset |
| 2.5 | Bundle reading and inspection | ✅ | Runbook §5 — jq examples |
| 2.6 | Finalizer handoff documented | ✅ | Runbook §6 — handoff packet, review steps |
| 2.7 | Safe rollback documented | ✅ | Runbook §7 — scenarios, idempotency guarantee |
| 2.8 | Verification checks (pre/post) | ✅ | Runbook §8 |
| 2.9 | Risk notes documented | ✅ | Runbook §9 — 7 risks with mitigations |
| 2.10 | Emergency stop procedure | ✅ | Runbook §10 — SIGINT, no state mutation |

### §3 Schema completeness

| # | Check | Pass/Fail | Notes |
|---|---|---|---|
| 3.1 | Schema defines manifest format | ✅ | `schema.json` — manifest with requiredFields |
| 3.2 | Schema defines cursor format | ✅ | cursor with requiredFields |
| 3.3 | Schema defines closeout bundle format | ✅ | closeoutBundle with requiredBundleFields |
| 3.4 | Schema defines worker capability policy | ✅ | workerCapabilityPolicy with defaults |
| 3.5 | Schema defines mobile standby defaults | ✅ | mobileStandbyDefaults for Gongyung/Hermes |
| 3.6 | Schema defines always-refused actions | ✅ | 14 actions listed |
| 3.7 | Schema defines override-gated actions | ✅ | 3 actions listed |
| 3.8 | Schema defines runtime bootstrap deny paths | ✅ | matches parent closeout schema |
| 3.9 | Schema declares sourcePublicExecution NO_GO | ✅ | |
| 3.10 | Schema declares defaultDecision NO_GO | ✅ | |
| 3.11 | Schema lists bundle uses and prohibited uses | ✅ | |

### §4 Cross-reference with existing artifacts

| # | Check | Pass/Fail | Notes |
|---|---|---|---|
| 4.1 | References parent closeout go/no-go matrix | ✅ | Spec §10, Runbook §6, Schema |
| 4.2 | References dispatch-wrapper runbook | ✅ | Spec §10, Runbook §11 |
| 4.3 | References round closeout reconciler | ✅ | Spec §10 |
| 4.4 | References broker handoff protocol | ✅ | Spec §13 |
| 4.5 | References task lifecycle contract | ✅ | Spec §13 |
| 4.6 | Consistent with dispatch-wrapper closeout handoff | ✅ | §10.1 — coordinator is downstream |
| 4.7 | Consistent with parent-round closeout go/no-go | ✅ | §10.2 — coordinator feeds the matrix |
| 4.8 | Consistent with existing round-closeout-reconcile.ts | ✅ | §10.3 — complementary |

### §5 Safety and hygiene

| # | Check | Pass/Fail | Notes |
|---|---|---|---|
| 5.1 | No automatic close/merge/approval | ✅ | Explicitly refused in §6.1 |
| 5.2 | No live provider send | ✅ | Explicitly refused |
| 5.3 | No DB mutation | ✅ | Explicitly refused |
| 5.4 | No terminal ACK/replay | ✅ | Explicitly refused |
| 5.5 | No Gateway/broker/worker restart | ✅ | Explicitly refused |
| 5.6 | No credential movement or disclosure | ✅ | Explicitly refused |
| 5.7 | No history rewrite or force-push | ✅ | Explicitly refused |
| 5.8 | Seoseo retains finalizer authority | ✅ | Explicitly stated §5, §6, Runbook §6 |
| 5.9 | Runtime/bootstrap hygiene enforced | ✅ | denyPaths in schema |
| 5.10 | Bundle contents are redacted-safe | ✅ | Bundle confidentiality rules §4.2 |
| 5.11 | No secrets, private paths, raw dumps in docs | ✅ | Verified by inspection |

### §6 Transition path assessment

| # | Check | Pass/Fail | Notes |
|---|---|---|---|
| 6.1 | Stage 1 (coordinator-assisted) defined | ✅ | §8.1 — this spec's scope |
| 6.2 | Stage 2 (coordinator-guided) scoped | ✅ | §8.2 — future, not yet specified |
| 6.3 | Stage 3 (coordinated closeout) scoped | ✅ | §8.3 — requires explicit policy |
| 6.4 | Rollback path from any stage | ✅ | §8.4 — cursor reset, bundle regeneration |
| 6.5 | No automatic progression between stages | ✅ | Each stage requires separate spec update |

## Summary

| Metric | Value |
|---|---|
| Total checks | 47 |
| Passed | 47 |
| Failed | 0 |
| Blocked | 0 |

**Validation verdict:** ALL CHECKS PASS

The round coordinator spec, runbook, and schema are structurally complete,
internally consistent, cross-referenced with existing artifacts, and explicitly
safe (no unapproved live-impact actions, no automatic closeout, Seoseo retains
finalizer authority).

## Safety confirmation

| Property | Value |
|---|---|
| Source-only / no-live | Yes |
| No production deploy or restart | Yes |
| No broker/worker/Gateway restart | Yes |
| No live provider/Telegram send | Yes |
| No production DB mutation | Yes |
| No terminal-outbox ACK or replay | Yes |
| No release/tag/npm publish | Yes |
| No credential movement or disclosure | Yes |
| No repository visibility change | Yes |
| No history rewrite or force-push | Yes |
| No automatic issue close | Yes |
| No automatic PR merge | Yes |
| No automatic approval | Yes |
| Seoseo retains finalizer authority | Yes |

## Related documents

- [Round coordinator spec](../specs/a2a-round-coordinator/spec.md)
- [Round coordinator runbook](../specs/a2a-round-coordinator/runbook.md)
- [Round coordinator schema](../specs/a2a-round-coordinator/schema.json)
- [Parent-round closeout go/no-go schema](../specs/a2a-parent-round-closeout-go-nogo/schema.json)
- [Team1 dispatch-wrapper runbook](../specs/a2a-team1-dispatch-wrapper/runbook.md)
- [Round closeout reconciler source](../../packages/broker/src/github/round-closeout-reconcile.ts)
