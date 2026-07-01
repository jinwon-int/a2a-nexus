# Team2/Gwakga cross-broker readiness validation

Parent: #146 (a2a-plane#146, internal tracker private)
Child: #153 (a2a-plane#153, internal tracker private)
Run: `a2a-vnext-contract-smoke-crossbroker-20260510`
Broker of record: `gwakga`
Team: `team2-gwakga`
Worker: `soonwook`

This note is a libero validation artifact for the Team2 lanes. It does not perform a cutover, register a worker, contact a live broker, send a provider message, mutate a database, or acknowledge terminal-outbox rows.

## Scope reviewed

- Team2 dispatch and ownership: parent issue #146 and child issues #151, #152, and #153.
- Cross-broker contract surface: `contracts/a2a/broker-handoff-protocol.md`.
- Team2/Gwakga runbook surface: `packages/broker/docs/team2-gwakga-worker-onboarding-retargeting.md`.
- Terminal evidence boundary: `contracts/a2a/terminal-semantics.md`, `contracts/a2a/task-lifecycle.md`, and `fixtures/terminal-evidence/accepted-send-non-ack.json`.
- Public-readiness boundary: `docs/public-readiness.md` and runtime/bootstrap hygiene guard paths.

## Evidence snapshot

| Lane | Observed evidence | Readiness impact |
| --- | --- | --- |
| #151 `dungae` Gwakga cross-broker proof fixture | Dispatch comment records Team2/Gwakga broker, worker `dungae`, and task `f51ae4b8-ef39-4698-b3bf-3b671b096e69`; only Start evidence was present during this validation snapshot. | Pending. The lane must still provide PR/Done/Block evidence with no-live fixture commands before it can be used as public-readiness proof. |
| #152 `jingun` second-worker compatibility proof | Dispatch comment records Team2/Gwakga broker, worker `jingun`, and task `b798c665-d549-4041-8e97-86970d6b2d6b`; Start evidence was present during this validation snapshot. | Pending. The lane must still prove the second-worker compatibility artifact from current main without private endpoints or secrets. |
| #153 `soonwook` libero validation | This document records the cross-check and safe merge-order recommendation. | Validation-only. It must not be used to close Team2 readiness before #151 and #152 have terminal evidence. |

The parent dispatch summary records all Team2 tasks as claimed/running under the Gwakga broker. That is useful broker-of-record evidence, but it is not terminal evidence, not requester-visible receipt, not operator-visible receipt, and not terminal ACK proof.

## Cross-broker findings

| Area | Status | Evidence | Follow-up gate |
| --- | --- | --- | --- |
| Broker of record | Pass for dispatch boundary | Parent #146 and Team2 child issues identify Gwakga as Team2 broker of record. `contracts/a2a/broker-handoff-protocol.md` requires `brokerOfRecord` to equal the destination broker and forbids cross-worker registration. | Keep Seoseo as source/global link owner only; Team2 task claim/start/finish state must remain under Gwakga policy. |
| No-live assumptions | Pass for this validation artifact | This lane used issue/docs inspection only. No deploy, restart, live provider send, DB mutation, terminal-outbox ACK, edge-secret rotation, or visibility change was performed. | Require the same statement in #151/#152 terminal evidence, with exact local commands where they modify docs/fixtures. |
| Accepted-send boundary | Pass for wording | Existing terminal evidence docs and fixtures keep provider send success/message id as accepted-send evidence only. This validation repeats that provider acceptance is not requester-visible receipt, operator-visible receipt, human-seen proof, or terminal ACK. | Reject any Team2 proof that upgrades provider acceptance or a message id into receipt/ACK evidence. |
| Public-readiness sufficiency | Waiting | Team2 dispatch/running evidence plus this validation note are not enough for public docs. The Team2 proof needs #151 and #152 PR/Done evidence, local validation output, clean runtime/bootstrap hygiene, and the repository-level scanner/operator approval gates from `docs/public-readiness.md`. | Keep public-readiness **NO-GO/Waiting** until all Team2 sibling lanes and repository gates are complete. |
| Runtime/bootstrap hygiene | Pass for this branch diff | This document contains only redacted issue links, public repo paths, worker IDs from the issues, and no raw session dumps or host-private paths. | Fail closed if `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**` enter a branch diff or artifact evidence. |

## Team2 merge-order recommendation

1. Merge any contract/fixture hardening that #151 needs for a Gwakga-owned handoff proof before treating Team2 broker evidence as stable.
2. Merge #151's public-safe cross-broker proof fixture or doc first, because #152 should reference the same broker-of-record and no-live evidence vocabulary.
3. Merge #152's second-worker compatibility proof after #151 settles the Team2 fixture shape, so the second worker proves compatibility rather than defining a competing convention.
4. Keep #153 as the final Team2 libero closeout. It should refresh sibling issue/PR states immediately before Done/Block evidence.
5. Do not promote Team2 proof into public docs as sufficient until repository-level public-readiness gates remain clean: local release gate, public-readiness scan, external secret/history scanner or explicit fail-closed disposition, explicit operator visibility approval, and runtime/bootstrap hygiene.

## Current decision

**Team2 public-readiness proof is NO-GO / Waiting.** The Gwakga broker-of-record dispatch evidence is directionally correct and safe to cite as non-terminal metadata, but sibling Team2 terminal evidence is still pending in this validation snapshot. Cross-broker proof is not sufficient for public docs until #151 and #152 provide PR/Done evidence with local validation and no private topology, and until the repository-level public-readiness gates remain satisfied.

## Safety confirmation

This validation performed redacted repository and GitHub issue inspection only. It did not perform production deploys, Gateway/broker/worker restarts, live provider or Telegram sends, production database mutations, terminal-outbox ACKs, edge-secret rotations, repository visibility changes, history rewrites, force pushes, raw secret disclosure, host-private path disclosure, or raw session dump publication.
