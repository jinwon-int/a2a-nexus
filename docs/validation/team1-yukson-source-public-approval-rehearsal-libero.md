# Team1 source-public approval rehearsal validation

Parent: #211 (a2a-plane#211, internal tracker private)
Child: #213 (a2a-plane#213, internal tracker private)
Run: `a2a-source-public-approval-rehearsal-20260511T014240Z`
Broker of record: `seoseo`
Team: `team1`
Worker: `yukson`
Reviewed at: `2026-05-11T01:45:01Z`
Packet fixture: [`fixtures/dry-run/source-public-approval-rehearsal-packet.json`](../../fixtures/dry-run/source-public-approval-rehearsal-packet.json)

This is a redacted, no-live approval rehearsal artifact. It does not perform approval, source-public execution, release publication, repository visibility changes, provider/Telegram sends, Terminal Brief ACK, production database mutation, deploys, restarts, secret changes, history rewrites, force-pushes, automatic merges/approvals, or community posts.

## Rehearsal decision vocabulary

| Output | Meaning in this round | Execution posture |
| --- | --- | --- |
| `GO_CANDIDATE` | The deterministic approval packet, integrated evidence bundle, no-live Terminal Brief rehearsal, replay/no-duplicate proof, rollback/abort paths, redaction, and runtime/bootstrap hygiene all pass. | Still not execution approval; source-public execution remains blocked until a later explicit operator approval names the actions. |
| `NEEDS_OPERATOR_APPROVAL` | Technical rehearsal gates are otherwise complete, but the only remaining blocker is explicit operator approval. | No execution. The packet may be presented for operator review. |
| `NO_GO` | Any required rehearsal gate is missing, unsafe, stale, Start-only, non-deterministic, or mixes approval with execution. | Fail closed and post Block evidence; do not request or execute approval. |

## Current packet result

**Decision: `NO_GO`.** The packet shape is now deterministic and public-safe, but current sibling-lane evidence is Start-only at this snapshot. That is enough to document the rehearsal gate contract, not enough to claim an integrated approval bundle, replay/no-duplicate proof, rollback/no-live restoration proof, or final operator-review packet.

Source-public execution remains **NO_GO**. If later technical evidence becomes complete, the next safe posture is `GO_CANDIDATE` or `NEEDS_OPERATOR_APPROVAL`; neither state may execute approval, release, visibility, provider send, Terminal Brief ACK, deploy, restart, DB mutation, history rewrite, force-push, or community post.

## Deterministic approval packet requirements

A valid packet for this round must be deterministic and replay-safe:

1. Use a stable `packetKey` scoped by run, lane, and packet version.
2. Sort object keys and keep array order stable by gate id.
3. Exclude volatile local fields such as generation timestamps, host paths, raw logs, and session dumps from canonical packet identity.
4. Name every candidate action as `rehearsalOnly: true` and `executed: false`.
5. Include a decision from exactly `GO_CANDIDATE`, `NO_GO`, or `NEEDS_OPERATOR_APPROVAL`.
6. Keep `sourcePublicExecution: NO_GO` unless a later explicit operator approval is reviewed in a separate execution round.

The checked-in packet fixture follows this shape and intentionally records `NO_GO` because required evidence is not complete.

## Integrated evidence bundle gate

| Evidence lane | Required closeout evidence | Current observed state | Libero assessment |
| --- | --- | --- | --- |
| Plane schema/final gate (`bangtong`) | PR/Done/Block for deterministic packet schema and final gate. | a2a-plane#212 (a2a-plane#212, internal tracker private) has Start-only evidence at snapshot. | `NO_GO` until landed or explicitly blocked evidence exists. |
| Plugin status (`sogyo`) | Operator-facing no-live status rendering with Terminal Brief/GitHub evidence URLs and non-ACK/non-approval boundaries. | [openclaw-plugin-a2a#261](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/261) has Start-only evidence at snapshot. | `NO_GO` until PR/Done/Block evidence exists. |
| Runner bundle (`nosuk`) | Deterministic scanner/artifact bundle, redaction proof, no-secret fixture, and no-live final scanner status. | [a2a-docker-runner#185](https://github.com/jinwon-int/a2a-docker-runner/issues/185) has Start-only evidence at snapshot. | `NO_GO` until PR/Done/Block evidence exists. |
| Broker evidence/export (`dungae`) | Read-only evidence bundle export plus idempotent approval-intent/rehearsal record; no approval execution. | [a2a-broker#484](https://github.com/jinwon-int/a2a-broker/issues/484) has Start-only evidence at snapshot. | `NO_GO` until PR/Done/Block evidence exists. |
| Team2 parity/cross-check (`jingun`, `soonwook`) | Independent parity audit and GO/NO-GO semantics cross-check. | [a2a-docker-runner#186](https://github.com/jinwon-int/a2a-docker-runner/issues/186) and a2a-plane#214 (a2a-plane#214, internal tracker private) have Start-only evidence at snapshot. | `NO_GO` until cross-check evidence exists. |
| Libero validation (`yukson`) | This validation doc, deterministic packet fixture, and regression test. | This patch adds the validation and fixture; tests enforce the no-live and fail-closed terms. | Pass for local contract shape only; aggregate remains `NO_GO`. |

## No-live Terminal Brief rehearsal gate

The rehearsal can project redacted GitHub issue/PR URLs as evidence ledger entries, but those URLs are not Terminal Brief ACK, read receipt, operator-visible receipt, or operator approval. A valid no-live Terminal Brief rehearsal must prove:

- `providerSendExecuted=false` and `terminalAckExecuted=false`.
- Provider accepted-send evidence, Telegram message ids, queue state, or GitHub comments cannot satisfy terminal ACK or operator approval gates.
- Replaying the packet cannot send a live notice or ACK a terminal-outbox row.

## Replay/no-duplicate proof gate

Replay safety is tied to the stable `packetKey`. Re-running the same packet may update or supersede the same rehearsal evidence, but must not mint a second approval intent, live provider send, visibility change, release, Terminal Brief ACK, or community post. The current run is `NO_GO` because concrete sibling-lane replay/no-duplicate evidence is not yet posted.

## Rollback and abort paths

Because this is a no-live rehearsal, rollback is normally an abort/no-op plus Block evidence. Abort immediately if any of these occur:

- A safety invariant flips true: deploy/restart, live provider/Telegram send, terminal ACK, production DB mutation, secret/visibility change, history rewrite, force-push, release publication, community post, automatic merge/approval, approval execution, or repository visibility change.
- Runtime/bootstrap paths would enter the branch diff, PR body, issue comments, or artifact evidence. Deny paths: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`.
- The integrated evidence bundle is missing PR/Done/Block closeout or contains raw secrets, host-private paths, provider identifiers, Telegram identifiers, raw logs, or session dumps.
- Approval is bundled with execution instead of being reviewed as a separate later operator decision.

## Final assessment for this lane

- Approval rehearsal packet shape: **documented / fixture added**.
- Integrated evidence bundle: **NO_GO** until sibling lanes provide PR/Done/Block evidence.
- No-live Terminal Brief rehearsal boundary: **pass for documented boundary; proof pending sibling evidence**.
- Replay/no-duplicate proof: **NO_GO** until packet-key/idempotency proof lands.
- Rollback/abort paths: **documented; executable restoration proof pending**.
- Operator approval: **not present, not requested, not executed**.

Final source-public assessment: **NO_GO** for execution. The only safe closeout from this patch is repository-level rehearsal-gate documentation and tests; it is not approval, release, visibility, or Terminal Brief activation.
