# Team1/yukson Terminal Brief pre-activation GO/NO-GO matrix (R8)

Issue: #285 (a2a-plane#285, internal tracker private)
Parent: [a2a-broker#553](https://github.com/jinwon-int/a2a-broker/issues/553)
Run: `a2a-r8-ops-dashboard-20260513T111122Z`
Lane: Team1/yukson, a2a-plane#285 (a2a-plane#285, internal tracker private)
Snapshot: `2026-05-13T11:11:22Z`

This is a redacted R8 ops-dashboard and queue-hygiene pre-activation validation matrix for Terminal Brief. It evaluates the two-broker dashboard/read model, stale worker/task clarity, PR-less validation evidence, receipt-safe operator UX, and cross-team parity after the GitHub-current fleet update. It does not deploy a broker, restart Gateway, enable core Gateway config, perform a live provider send, record Terminal Brief ACK, mutate production data, change secrets, rewrite history, force-push, release, or change repository visibility.

## Current R8 decision

**Decision: `NO-GO / Waiting` for pre-activation release.** The two-broker dashboard/read model and state-machine-queue model defined in this matrix pass no-live spec review. However, the aggregate canary/receipt and parity gates remain Start-only or un-evidenced at snapshot time. A later `GO for pre-activation rehearsal` may be considered only after every gate below has linked PR/Done/Block evidence from at least one validated per-broker run and a separate operator approval explicitly authorizes the rehearsal scope.

The R8 target outcomes do not include live Terminal Brief activation. All outcomes are pre-activation: read models, spec/contract clarity, evidence hygiene, and rollback procedure definition.

## R8 target outcomes

| # | Outcome | Scope | Validation gate reference |
| --- | --- | --- | --- |
| 1 | **Bounded two-broker dashboard/read model** | Operator dashboard `operatorSnapshot` projection covers both worker worker-lists, task-status summaries, and stale/active split by broker identity without exposing secrets or private paths. | G1 below |
| 2 | **Stale worker/task clarity** | The dashboard and recovery summary distinguish stale workers, stale tasks, and broker-idle queue rows so the operator can triage without opening raw task logs. | G2 below |
| 3 | **PR-less validation evidence** | Read-only/libero lanes accept Start+Done/Block GitHub comments as terminal evidence. The no-diff patch-lane false-Done guard is preserved. | G3 below |
| 4 | **Receipt-safe operator UX** | The dashboard and Terminal Brief gate matrix enforce the receipt vocabulary: provider accepted-send is not operator-visible receipt, operator-visible receipt is not terminal-outbox ACK, and ACK is not read-receipt or approval. | G4 below |
| 5 | **Cross-team parity** | Team2 (gwakga/soyeon) evidence agrees on the receipt boundary, one-shot safety, rollback semantics, and final closeout evidence shape. Disagreements are documented and addressed before any `GO`. | G5 below |

## Evidence snapshot

| Lane / source | Required evidence for this round | Snapshot evidence | Validation result |
| --- | --- | --- | --- |
| Parent dispatch — [a2a-broker#553](https://github.com/jinwon-int/a2a-broker/issues/553) | Round lane list, safety gates, and previous activation context. | No snapshot Start evidence yet. | `NO-GO`: dispatch context not yet recorded. |
| Two-broker safety matrix — [a2a-broker#414](https://github.com/jinwon-int/a2a-broker/issues/414) | PR/Done/Block evidence for cutover-readiness matrix, backward compatibility, and evidence hygiene (R8-R10). | Two-broker safety regression/readiness matrix merged at repo snapshot. | `NO-GO`: no per-broker validation evidence from GitHub-current fleet. |
| Broker identity lane — [a2a-broker#410](https://github.com/jinwon-int/a2a-broker/issues/410) | PR/Done evidence for brokerId config/defaults, `/health` exposure, and worker register/heartbeat read-model tests. | No refreshed R8 snapshot Start evidence. | `NO-GO`: pre-R8 evidence must be re-validated against current fleet. |
| Worker home-broker lease lane — [a2a-broker#411](https://github.com/jinwon-int/a2a-broker/issues/411) | PR/Done evidence for `A2A_HOME_BROKER_ID` validation, local lease, mismatch fail-close, retarget path. | No refreshed R8 snapshot Start evidence. | `NO-GO`: pre-R8 evidence must be re-validated. |
| Broker-of-record lifecycle lane — [a2a-broker#412](https://github.com/jinwon-int/a2a-broker/issues/412) | PR/Done evidence for task ownership defaults, legacy compatibility, lifecycle guards. | No refreshed R8 snapshot Start evidence. | `NO-GO`: pre-R8 evidence must be re-validated. |
| Duplicate worker preflight lane — [a2a-broker#413](https://github.com/jinwon-int/a2a-broker/issues/413) | PR/Done evidence for two-broker worker list comparison, duplicate detection, stale/unreachable ambiguity handling. | No refreshed R8 snapshot Start evidence. | `NO-GO`: pre-R8 evidence must be re-validated. |
| Cutover runbook lane — [a2a-broker#415](https://github.com/jinwon-int/a2a-broker/issues/415) | Runbook for seoseo/gwakga conventions, stop/retarget/restart procedure, duplicate preflight requirement, rollback. | No refreshed R8 snapshot Start evidence. | `NO-GO`: pre-R8 runbook must be validated. |
| Dashboard/read-model — a2a-plane#285 (a2a-plane#285, internal tracker private) | This pre-activation matrix plus bounded `operatorSnapshot` spec review for two-broker stale/task clarity. | Start evidence for this lane plus R8 target outcome definitions. | Start-only: matrix spec defined; implementation validation pending. |
| Team2 cross-team parity — separately tracked | Team2/gwakga or soyeon evidence on receipt boundary, one-shot safety, rollback, final closeout shape. | No R8 parity evidence at snapshot. | `NO-GO`: parity gates cannot be satisfied by Team1 alone. |
| Terminal Brief activation — a2a-plane#243 (a2a-plane#243, internal tracker private) | Activation matrix from R7 or earlier re-dispatch requires re-validation against R8 baseline. | Previous R7 activation evidence exists. | `NO-GO`: terminal activation awaiting pre-activation gates to close. |

## Pre-activation gate checklist

| Gate | Pass condition | Fail / NO-GO condition | Current status |
| --- | --- | --- | --- |
| G1. Two-broker dashboard/read model | Operator dashboard `operatorSnapshot` projection covers both broker worker-lists, task-status summaries by broker identity, and stale/active split — without exposing secrets, private paths, or raw task payloads. Projection is documented in `operator-dashboard-snapshot.md` or equivalent. | Dashboard conflates brokers, omits stale/active split, leaks secrets/paths, or cannot produce a bounded per-broker summary from GitHub-current fleet data. | In progress: spec documented in `packages/broker/docs/operator-dashboard-snapshot.md`; two-broker split projection validation pending. |
| G2. Stale worker/task clarity | Recovery summary distinguishes stale workers, stale tasks, and broker-idle queue rows. Each stale item has `whyStuck`, `whoClaimed`, `whatNext` for operator triage. | Stale/unhealthy/non-terminal items collapse into a single count with no triage guidance. Operator must open raw task logs to understand blocking condition. | In progress: `operator-dashboard-snapshot.md` defines attention items; two-broker stale/task validation pending. |
| G3. PR-less validation evidence | Read-only/libero lanes produce Start + Done/Block GitHub comment evidence. No-diff for read-only tasks is accepted; no-diff for patch lanes is still fail-closed. | Read-only lane produces no Start evidence, or patch lane with no diff is accepted as Done. | Spec stable: `a2a-broker#527` gate A documented. No re-validation failure evidence. |
| G4. Receipt-safe operator UX | Dashboard and gate matrix enforce: provider accepted-send ≠ operator-visible receipt ≠ terminal-outbox ACK ≠ read-receipt ≠ approval. All points have distinct evidence conditions. | Dashboard reports provider accepted-send as receipt, ACK as receipt, or conflates any two distinct steps. | Spec stable: `terminal-brief-activation-libero.md` and `two-broker-safety-matrix.ts` enforce boundaries. No re-validation evidence. |
| G5. Cross-team parity | Team2 evidence agrees on receipt boundary, one-shot safety, rollback, and final closeout evidence. Disagreements are recorded and addressed. | No Team2 evidence, or Team2 evidence contradicts receipt/safety/rollback/closeout consensus. | `NO-GO`: no R8 parity evidence at snapshot. G5 must be satisfied after sibling lanes produce terminal evidence. |
| G6. Pre-activation rollback definition | Rollback procedure lists steps to restore dashboard model, remove canary read-model changes, and re-verify no-live default state. | No documented rollback path, or rollback assumes live mutation to reverse. | Start-only: rollback procedure defined below; no execution evidence. |

## GO/NO-GO decision matrix

| Aggregate state | Required gates | Allowed closeout |
| --- | --- | --- |
| `GO for pre-activation rehearsal` | G1-G6 all pass with linked PR/Done/Block evidence from at least one validated per-broker run. Operator approval is separate and explicit for the rehearsal scope. | PR/Done evidence may say pre-activation matrix validated; rehearsal may proceed under operator approval. |
| `GO_CANDIDATE / Needs operator approval` | G1-G4 pass, rollback defined (G6), but G5 (parity) or operator approval is pending. | PR/Done evidence may request approval; must not advance to rehearsal without explicit go. |
| `NO-GO / Waiting` | Any required gate has Start-only/missing evidence, stale worker/task clarity is disputed, receipt/ACK boundaries are not enforced, or parity is incomplete. | Current state. Post PR/Done with this matrix or Block if no safe artifact is needed. |
| `BLOCK` | Any safety gate is violated: non-bounded dashboard exposure, core config mutation, duplicate provider send path, unapproved live send, DB/secret/history/release/visibility change, raw private evidence leak, or runtime/bootstrap context files entering branch/artifacts. | Stop validation, restore no-live defaults, and post Block with exact offending repo-relative paths or violated gates. |

## Rollback / abort procedure

Use this procedure if any pre-activation gate fails or if an operator stops the R8 validation window. Steps must be evidenced with redacted output only.

1. **Remove dashboard model changes.** Revert any `operatorSnapshot` projection changes made for the two-broker read model. Restore single-broker default shape if a two-broker projection was prototyped.
2. **Reset stale/task clarity additions.** Remove any recovery-summary attention-item fields added specifically for the R8 validation, unless they are backward-compatible no-ops.
3. **Preserve receipt truth.** Do not ACK terminal-outbox rows from provider accepted-send, message id, or Gateway outbound success. Leave unconfirmed rows unacked and replayable.
4. **Restore spec/contract state.** Revert any spec, contract, or doc changes to the pre-R8 default. Keep code changes only if they are backward-compatible additive contracts.
5. **Verify no-live default.** Confirm `operatorEvents.enabled`, notification bridge, and any plugin-level canary config are disabled or at pre-R8 baseline.
6. **Post terminal evidence.** Post Done if rollback restored pre-R8 state cleanly; post Block if any safety gate was violated, receipt is ambiguous, or exact offending paths must be reported.

## R8 residual risk matrix

| Risk | Failure mode | Existing guard | Residual risk | Gate reference |
| --- | --- | --- | --- | --- |
| Two-broker dashboard leaks worker identity | `operatorSnapshot` includes raw `workerId` or `nodeId` that identifies the other broker's workers without redaction. | `operator-dashboard-snapshot.md` specifies redaction rules; `two-broker-safety-matrix.ts` requires bounded output. | Low — redaction rules are spec-level. | G1 |
| Stale worker/task clarity conflates triage | Recovery summary `stale` count mixes stale workers with stale tasks, giving operator unclear signal. | `operator-dashboard-snapshot.md` separates `staleWorkerAssignments` and `staleWorkersWithActiveTasks`. | Low — spec clearly separates; implementation must follow spec. | G2 |
| PR-less evidence lane merged as release | A read-only validation lane Done marker is counted as release-ready approval by a downstream gate. | `a2a-broker#527` gate A requires separate explicit operator approval for release/production. | Medium — downstream gate must enforce approval boundary. | G3 |
| Receipt boundary weakened by dashboard | Dashboard renders provider accepted-send as receipt, encouraging operator to conflate. | `terminal-brief-activation-libero.md` gate G6 requires receipt evidence to be explicitly labeled `operator_visible_receipt`, not `provider_send`. | Low — spec-level separation; dashboard must follow. | G4 |
| Parity is assumed without evidence | Team2 issue goes silent and operators treat lack of response as consent. | G5 explicitly requires Team2 evidence, not silence. | Medium — operator discipline required. | G5 |

## Runtime/bootstrap and artifact hygiene

Before PR creation or Done evidence, fail closed if any OpenClaw runtime/bootstrap context file would enter the branch diff, PR body, issue comments, or artifact bundle. Offending paths must be reported exactly, including `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.

Evidence must also avoid secrets, provider targets, chat IDs, raw session dumps, private host paths, raw task payloads, and unredacted logs.

## Safe closeout

The safe closeout for this lane is a PR/Done marker that says the R8 pre-activation matrix is documented and the current aggregate decision remains **`NO-GO / Waiting`**. This lane may post PR/Done evidence after the validation document, the no-live test, and the `operatorSnapshot` two-broker split review are confirmed. Do not advance to `GO for pre-activation rehearsal` while any dashboard, stale/task, PR-less, receipt, parity, or rollback gate remains missing or disputed.
