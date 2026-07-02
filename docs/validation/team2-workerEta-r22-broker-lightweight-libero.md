# Team2/workerEta R22 Libero validation — Broker lightweight/performance round

Issue: a2a-plane#332 (a2a-plane#332, internal tracker private)
Parent: [a2a-broker#497](https://github.com/jinwon-int/a2a-broker/issues/497) — Broker high CPU/memory and Node heap OOM under hot-table state growth
Roadmap: [a2a-broker#294](https://github.com/jinwon-int/a2a-broker/issues/294) — A2A Stability Roadmap (receipt semantics, queue hygiene, canary gates)
Parent/origin broker: brokerAlpha (Team1) — brokerAlpha remains the sole operator-facing parent Terminal Brief owner
Libero cross-checker: brokerBeta (Team2) — brokerBeta validates lightweight/performance lanes and cross-broker Terminal Brief owner semantics as child/handoff broker only
Run: `a2a-r22-broker-lightweight-20260515T015139Z`
Lane: `workerEta` / Team2 libero validation (broker lightweight/performance round)

This is a redacted, no-live validation artifact for the R22 broker lightweight/performance cross-check. It performs repository and GitHub evidence review only. **It does not deploy, restart Gateway/broker/worker services, reload runtime config, send a live provider or Telegram canary, mutate/prune/migrate production databases, manually ACK or replay terminal-outbox rows, replay historical tasks, publish a release/tag, move or disclose secrets, force-push, rewrite history, change repository visibility, execute operator approval, claim operator-visible receipt, or issue a Terminal Brief ACK.**

## Decision

**R22 closeout is `NO-GO / Waiting`.** R22 source changes cannot be treated as final-GO until:
- Active R14 child lanes (#617, #618, #619 under parent #615) publish terminal PR/Done/Block evidence for their hot-table retention, secret-safe diagnostics, and two-broker deploy safety scope.
- Lightweight/performance changes inferred from #497 are explicitly documented with dedicated lane issues and PR evidence against current main.
- Cross-broker Terminal Brief owner semantics are reverified against the contract fixture matrix and no regression is found in `crossBrokerHandoff` metadata invariants.
- Required tests are green and a separate explicit operator approval authorizes any runtime activation.

Safe current closeout for this lane: this PR documents the R22 validation matrix, cross-broker Terminal Brief owner semantics review, R14 residual child lane review, lightweight/performance gap assessment, risk list, source-only GO/NO-GO decision, and explicit runtime activation blockers. It is not approval to merge implementation PRs, deploy/reload, send a provider canary, or claim operator-visible receipt.

Source-public execution remains **`NO_GO`**. This is a **source-only** GO/NO-GO: it evaluates source changes, not runtime activation. Runtime activation requires a separate downstream approval after sibling lanes complete.

## R22 validation matrix

| Gate | Required R22 behavior | Current evidence snapshot | Closeout state |
| --- | --- | --- | --- |
| Broker hot-table state growth / lightweight round (#497 parent) | Broker hot-table state growth constraints, bounded memory profile, and lightweight/performance guardrails are present or explicitly scoped to a future lane. | Parent [a2a-broker#497](https://github.com/jinwon-int/a2a-broker/issues/497) defines the root problem. Active R14 children under [#615](https://github.com/jinwon-int/a2a-broker/issues/615) address immediate retention/diagnostics/deploy safety. Lightweight-specific lane issues are not yet separately tracked beyond the R14 scope. | `NO-GO / Waiting`; require explicit lightweight/performance lane issues or terminal evidence that #497 scope is subsumed by R14 residual lanes. |
| R14 residual — hot-table retention (#617, workerAlpha) | Broker hot-table retention reduces unbounded task/event/state growth. Committed `retentionMs` windows and prune-safe lifecycle. | [jinwon-int/a2a-broker#617](https://github.com/jinwon-int/a2a-broker/issues/617) assigned to workerAlpha (Team1). Evidence: Start only at validation snapshot. | `NO-GO / Waiting`; require terminal PR/Done/Block. |
| R14 residual — secret-safe diagnostics (#618, workerEpsilon) | Diagnostic payload redaction and bounded audit log retention. Safely inspect hot-table state without leaking secrets. | [jinwon-int/a2a-broker#618](https://github.com/jinwon-int/a2a-broker/issues/618) assigned to workerEpsilon (Team2). Evidence: Start only at validation snapshot. | `NO-GO / Waiting`; require terminal PR/Done/Block. |
| R14 residual — two-broker deploy safety (#619, workerZeta) | Single-broker default safety and two-broker preflight readiness for brokerBeta onboarding without live operator-visible risk. | [jinwon-int/a2a-broker#619](https://github.com/jinwon-int/a2a-broker/issues/619) assigned to workerZeta (Team2). Evidence: Start only at validation snapshot. | `NO-GO / Waiting`; require terminal PR/Done/Block. |
| Cross-broker Terminal Brief owner semantics | brokerAlpha remains parent/origin broker and the sole operator-facing parent Terminal Brief sender. brokerBeta does not render, send, update, retract, or ACK the parent Terminal Brief in any cross-broker handoff scenario. Four-case routing matrix invariant `initiatingBroker == parentBrokerId == originBrokerId == operatorFacingTerminalBriefSender` is preserved. | Contract [parent-terminal-brief-aggregation.md](a2a-plane (internal tracker, private)blob/main/contracts/a2a/parent-terminal-brief-aggregation.md) v1 defines symmetric origin-broker semantics with parent aggregation/rendering. Fixture [terminal-brief-parent-origin-routing.json](a2a-plane (internal tracker, private)blob/main/fixtures/contract/terminal-brief-parent-origin-routing.json) maintains the four-case invariant. Broker-side [terminal-brief-routing-contract.ts](a2a-plane (internal tracker, private)blob/main/packages/broker/src/core/terminal-brief-routing-contract.ts) rejects direct Telegram/curl/provider routes for prepared Terminal Briefs. Test [terminal-brief-routing-contract.test.ts](a2a-plane (internal tracker, private)blob/main/packages/broker/src/core/terminal-brief-routing-contract.test.ts) verifies route rejection. [handoff-scenarios.ts](a2a-plane (internal tracker, private)blob/main/packages/broker/src/core/handoff-scenarios.ts) and [two-broker-safety-matrix.ts](a2a-plane (internal tracker, private)blob/main/packages/broker/src/core/two-broker-safety-matrix.ts) define handoff/safety guardrails. | `PASS for contract/guard definition`; runtime compliance depends on R14 child evidence and operator-approved deployment. |
| `crossBrokerHandoff` metadata invariants | Handoff children carry `parentRoundId`, `originBrokerId=brokerAlpha`, `handoffBrokerId=brokerBeta`, and parent total/order metadata. No handoff payload rewrites origin or assigns brokerBeta as parent Terminal Brief owner. | Contract [parent-terminal-brief-aggregation.md](a2a-plane (internal tracker, private)blob/main/contracts/a2a/parent-terminal-brief-aggregation.md) v1 and [broker-handoff-protocol.md](a2a-plane (internal tracker, private)blob/main/contracts/a2a/broker-handoff-protocol.md) define the metadata shape. Fixture matrix maintains origin identity. | `PASS for contract definition`; runtime enforcement depends on broker implementation lane evidence. |
| Terminal Brief routing guard integrity | `terminal-brief-routing-contract.ts` preserves four receipt levels: accepted-send (lifecycle evidence only, never terminal ACK), requester-visible, operator-visible, terminal ACK. `providerAccepted` + `providerMessageId` remains level-1 lifecycle evidence, not read/visibility/ACK. | Source code at commit `afbd89d` (`terminal-brief-routing-contract.ts` + `.test.ts`) confirms the four-level receipt model and OpenClaw-only outbound lifecycle routing. Existing tests pass. | `PASS for source integrity`; no new PRs have modified this guard. |
| Lightweight/performance gap assessment | All known #497 hot-table state growth paths are identified. Lightweight-specific lane issues exist or are explicitly deferred to a dedicated next round with PR/Done/Block evidence. | R14 children cover retention, diagnostics, and deploy safety. Lightweight-specific issues are not separately tracked beyond #497 parent. No lightweight-targeted benchmarks, memory profiling integration, or dedicated lightweight PRs are visible. | `NO-GO / Waiting`; lightweight round is partial until dedicated lightweight lanes publish terminal evidence or a parent-level disposition closes #497 by subsumption under R14 outputs. |

## R22 lane snapshot

| Worker | Repo issue | Assigned scope | Snapshot |
| --- | --- | --- | --- |
| `workerAlpha` (Team1) | [jinwon-int/a2a-broker#617](https://github.com/jinwon-int/a2a-broker/issues/617) | R14 residual — broker hot-table retention | Start evidence only at validation snapshot; requires terminal PR/Done/Block. |
| `workerEpsilon` (Team2) | [jinwon-int/a2a-broker#618](https://github.com/jinwon-int/a2a-broker/issues/618) | R14 residual — secret-safe diagnostics | Start evidence only at validation snapshot; requires terminal PR/Done/Block. |
| `workerZeta` (Team2) | [jinwon-int/a2a-broker#619](https://github.com/jinwon-int/a2a-broker/issues/619) | R14 residual — two-broker deploy safety | Start evidence only at validation snapshot; requires terminal PR/Done/Block. |
| `workerEta` (Team2) | a2a-plane#332 (a2a-plane#332, internal tracker private) | This independent libero validation, cross-broker Terminal Brief owner semantics review, lightweight/performance gap assessment, risk list, and blocker documentation. | Start evidence plus this PR after runner closeout. |

Start, queued, running, provider accepted-send, GitHub comment creation, and PR creation are not terminal lane evidence. Count a sibling lane as terminal only when it has an explicit PR, Done, or Block marker with linked checks/evidence.

## Risk list and runtime activation blockers

### Current risks

1. **Lightweight/performance scope ambiguity**: The #497 parent identifies hot-table state growth and OOM risk, but no dedicated lightweight/performance lane issues are tracked beyond R14 residual children. Without explicit lightweight PRs against current main, the "broker lightweight round" has no bounded scope. Risk that #497 remains unclosed after R14 children land.
2. **Hot-table retention completeness**: R14 child #617 (workerAlpha) covers retention boundaries but without dedicated lightweight benchmarks or memory profiling integration. The underlying unbounded state growth risk described in #497 may persist after #617 lands.
3. **Two-broker deploy safety dependency**: #619 (workerZeta) must produce terminal evidence before any brokerBeta operator-facing deployment. Cross-broker Terminal Brief owner semantics assume brokerBeta never sends parent-origin Briefs, but this safety property depends on #619's deploy guardrails being effective in practice.
4. **Secret-safe diagnostics timing**: #618 (workerEpsilon) diagnostics redaction may affect lightweight round evidence gathering. If diagnostics are too aggressive, lightweight/performance regression detection during reviews becomes harder.
5. **Cross-broker Terminal Brief owner regression**: No active PR changes the `terminal-brief-routing-contract.ts` guard or the fixture matrix invariant. However, any future `parent-terminal-brief-aggregation.md` or `broker-handoff-protocol.md` changes must be reviewed for origin-broker identity leak.

### Runtime activation blockers

The following are confirmed **hard blockers** for any future runtime activation (separate operator approval):

- At least one R14 residual lane (#617/#618/#619) has terminal Done/PR/Block evidence against current main before any lightweight/performance deploy is approved.
- Lightweight-specific lane issues are explicitly tracked with terminal evidence, or #497 parent is formally closed by subsumption under R14 outputs with documented gap assessment.
- Cross-broker Terminal Brief owner semantics are reverified against the four-case fixture matrix and `parent-terminal-brief-aggregation.md` v1 contract; any regression in `initiatingBroker == parentBrokerId == originBrokerId == operatorFacingTerminalBriefSender` invariant is a hard blocker.
- This validation lane's R22 source-only GO/NO-GO is **GO** (currently `NO-GO / Waiting`).
- No sibling lane relies on Start-only evidence for final closeout.
- Operator approval is a separate downstream action not satisfied by any lane evidence alone.

## Source-only GO/NO-GO decision

**Current: `NO-GO / Waiting`.**

Transition to `GO` (source-only) requires:
- All three R14 residual lanes (#617, #618, #619) have terminal PR/Done/Block evidence against current main.
- Lightweight/performance-specific lane issues exist with bounded scope, or #497 parent is formally closed by subsumption under R14 outputs with a documented gap assessment that confirms all #497 concerns are addressed.
- Cross-broker Terminal Brief owner semantics are reverified and no regression in the four-case fixture invariant is found.
- Lightweight/performance gap assessment documents known unbounded-memory paths and their disposition (fixed, deferred with tracking issue, or accepted as out-of-scope).
- No runtime/bootstrap hygiene leaks are detected in branch diff, PR body, issue comments, or artifact evidence.

**`GO` is a source-only decision.** It does not authorize runtime activation, production deploy, broker restart, Gateway restart, DB mutation, live provider send, Terminal Brief ACK, or any other live action. Source execution remains `NO_GO` until a separate explicit operator approval is captured as a distinct downstream artifact.

## Required checks before R22 closeout

- R14 residual broker lanes #617/#618/#619 each have terminal PR/Done/Block evidence against current main.
- Lightweight/performance gap assessment is published as a tracked issue or documented in this lane's terminal evidence.
- Cross-broker Terminal Brief owner semantics are documented in `parent-terminal-brief-aggregation.md` v1 (contract) and the fixture matrix `terminal-brief-parent-origin-routing.json`; any changes to these files since the validation snapshot require fresh review.
- `terminal-brief-routing-contract.ts` guard is unchanged or any changes are revalidated for receipt-level separation (provider-accepted ≠ terminal ACK).
- `broker-handoff-protocol.md` handoff envelope and `crossBrokerHandoff` metadata invariants are unchanged or revalidated.
- This lane's validation test passes and the final diff remains docs/tests only.
- `npm run check:message-id-ack-boundary` remains green for A2A Nexus receipt/ACK wording.
- `npm run check:team2-final-go-no-go-semantics-libero` passes and the final GO/NO-GO semantics doc covers R22 lane boundaries.
- No production deploy/restart/reload, live provider/Telegram send, DB mutation/prune/migration, Terminal Brief ACK/replay, historical outbox replay, release/tag, secret movement/disclosure, force-push/history rewrite, or visibility change occurred in this validation lane.
- Branch diff, PR body, issue comments, and artifact evidence exclude OpenClaw runtime/bootstrap context files. Before PR creation, fail closed and report exact repo-relative or artifact-relative offending paths for any `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`, `BOOTSTRAP.md`, `MEMORY.md`, or `memory/**` file.

## Verification performed for this lane

- Inspected parent [a2a-broker#497](https://github.com/jinwon-int/a2a-broker/issues/497), roadmap [a2a-broker#294](https://github.com/jinwon-int/a2a-broker/issues/294), this issue a2a-plane#332 (a2a-plane#332, internal tracker private), and R14 parent [a2a-broker#615](https://github.com/jinwon-int/a2a-broker/issues/615) with children [#617](https://github.com/jinwon-int/a2a-broker/issues/617), [#618](https://github.com/jinwon-int/a2a-broker/issues/618), [#619](https://github.com/jinwon-int/a2a-broker/issues/619).
- Reviewed cross-broker Terminal Brief owner semantics contracts: `parent-terminal-brief-aggregation.md` (v1 symmetric origin-broker), `broker-handoff-protocol.md`, `terminal-brief-routing-contract.ts` (four-level receipt model, OpenClaw-only outbound lifecycle routing).
- Reviewed fixture matrix `terminal-brief-parent-origin-routing.json` (four-case routing with invariant `initiatingBroker == parentBrokerId == originBrokerId == operatorFacingTerminalBriefSender`).
- Reviewed store.ts retention mechanisms (`BrokerStateStore`, `retentionMs`, reaper), `types.ts` type definitions, and broker hot-table state growth surface.
- Reviewed existing libero validation artifacts: R20 (`team2-workerEta-r20-libero-go-nogo-retry.md`) and R16 (`team2-workerEta-r16-terminal-brief-libero.md`).
- Confirmed no PRs have modified `terminal-brief-routing-contract.ts` guard, `parent-terminal-brief-aggregation.md` contract, or the four-case fixture invariant since validation snapshot.
- Confirmed `crossBrokerHandoff` metadata invariants are preserved in contract and fixture definitions; no runtime enforcement lane evidence is available yet.
- Added a local validation test that fails if required R22 gates, cross-broker Terminal Brief owner semantics, risk list, source-only GO/NO-GO semantics, runtime activation blockers, ACK/receipt separation, or bootstrap hygiene language are removed.
- Confirmed this patch adds documentation/test evidence only and does not create runtime/bootstrap files in the repository.
