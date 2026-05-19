# Team1/yukson Terminal Brief default-on production observation libero matrix

Parent: [a2a-broker#802](https://github.com/jinwon-int/a2a-broker/issues/802)  
Lane: Team1/yukson, [a2a-plane#389](https://github.com/jinwon-int/a2a-plane/issues/389)  
Run: `a2a-terminal-brief-default-on-prod-observe-20260519T152200Z-yukson`  
Lane: 4/4  
Snapshot: `2026-05-19T15:22:00Z`

This is a redacted validation artifact for the Terminal Brief default-on production observation round. It evaluates whether the default-on (always-active) Terminal Brief behavior is safe to observe in production without triggering unintended side-effects: duplicate provider sends, automatic ACK of terminal-outbox rows, receipt/ACK boundary violations, runtime context leakage, or cross-broker semantic drift.

It does not deploy or restart a broker, restart Gateway, enable core Gateway config, perform a live provider send, record Terminal Brief ACK, mutate production data, change secrets, rewrite history, force-push, release, or change repository visibility.

## Current decision

**Decision: `NO-GO / Waiting`.** At this snapshot the lane has dispatch and Start evidence, but no terminal PR/Done/Block evidence proves that default-on Terminal Brief observation is safe to run in production. A Start marker proves work began; it is not observation-readiness evidence.

A later `GO_CANDIDATE` may be presented only after every required gate below has redacted evidence confirming that default-on behavior does not auto-ACK, duplicate-send, or leak runtime context. Provider accepted-send/message id alone is not visibility evidence. No live provider send or terminal-outbox ACK is authorized by this lane.

## Evidence snapshot

| Lane / source | Required evidence for this round | Snapshot evidence | Validation result |
| --- | --- | --- | --- |
| Parent dispatch — [a2a-broker#802](https://github.com/jinwon-int/a2a-broker/issues/802) | Round lane list, safety gates, default-on observation context, and prior activation evidence for this round. | Parent issue body records scope and safety boundaries. Child lane Start evidence pending per-lane open. | Pass for dispatch context only; does not prove observation readiness. |
| Broker stability lane — TBD | Broker stability evidence: default-on Terminal Brief does not increase CPU/memory, duplicate sends, or auto-ACK rows when no notification target is configured. | Issue not observed at snapshot. | `NO-GO` until broker default-on evidence lands. |
| Plugin observation lane — TBD | Plugin-level observation evidence: default-on Terminal Brief events respect the accepted-send non-ACK boundary, do not leak targets, and do not emit duplicate events. | Issue not observed at snapshot. | `NO-GO` until plugin default-on evidence lands. |
| Runner observation lane — TBD | Runner evidence: default-on observation produces bounded terminal evidence without runtime context leakage and without treating provider IDs as receipts. | Issue not observed at snapshot. | `NO-GO` until runner default-on evidence lands. |
| Team2 parity lane — TBD | Team2 cross-broker parity: Gwakga and Seoseo default-on Terminal Brief semantics agree on receipt boundaries, one-shot safety, and non-ACK invariants. | Issue not observed at snapshot. | `NO-GO` until parity evidence lands. |
| Team1/yukson lane — [a2a-plane#389](https://github.com/jinwon-int/a2a-plane/issues/389) | This default-on production observation safety matrix and go/no-go validation. | This libero document and its regression test. | Pass for validation shape only; aggregate remains `NO-GO / Waiting`. |

## Default-on observation gate checklist

| Gate | Pass condition | Fail / NO-GO condition | Current status |
| --- | --- | --- | --- |
| G1. Default-on non-duplicate send | Default-on Terminal Brief must not cause duplicate provider sends. Observation mode produces at most one send attempt per task lifecycle, regardless of retry reconciliation or re-delivery events. | More than one provider send attempt observed per task, duplicate event triggered by re-delivery, or replay incorrectly classified as new task. | `NO-GO`: waiting on broker default-on evidence. |
| G2. Default-on non-ACK boundary | Default-on observation must not auto-ACK terminal-outbox rows. Provider accepted-send, message id, and Gateway outbound success remain non-ACK evidence only. | Observation path automatically sets `ackAllowed=true`, emits ACK for accepted-send-only rows, or drops unacked rows without separate operator approval. | `NO-GO`: waiting on plugin observation evidence. |
| G3. Default-on runtime context safety | Default-on evidence must exclude secrets, provider targets, chat IDs, raw session dumps, private host paths, and unredacted logs. Observation output must be operator-safe and deterministic. | Evidence contains tokens, credentials, private paths, raw session transcripts, or provider identifiers. | `NO-GO`: waiting on runner observation evidence. |
| G4. Default-on cross-broker parity | Seoseo and Gwakga default-on Terminal Brief behavior must produce semantically identical observation evidence respecting the accepted-send non-ACK boundary. | Cross-broker observation evidence diverges on receipt semantics, non-ACK rule, or one-shot guard. | `NO-GO`: waiting on Team2 parity evidence. |
| G5. Prior activation context preserved | Default-on observation does not override, reset, or advance prior activation state. Terminal-outbox unacked rows remain unacked and replayable. | Observation mode mutates ack state, resets retry counters, or claims prior rows as delivered. | `NO-GO`: waiting on evidence that prior state is unchanged. |
| G6. Rollback/restoration | Default-on observation can be disabled without side-effects. Disabling restores no-live behavior, does not leave duplicate-send risk, and does not leak rows. | Disabling leaves partial ACK state, orphaned rows, or requires DB mutation to restore safe state. | `NO-GO`: waiting on rollback evidence. |

## GO/NO-GO decision matrix

| Aggregate state | Required gates | Allowed closeout |
| --- | --- | --- |
| `GO` | G1-G6 all pass with redacted terminal evidence; operator approval is separate and explicit; default-on observation produces at most one send per task; no auto-ACK observed; runtime context remains clean; cross-broker parity confirmed. | Done evidence may say default-on production observation is safe and can proceed or continue for the named scope. |
| `GO_CANDIDATE / Needs operator approval` | G1-G3 and G6 pass, observation plan is ready, rollback plan is rehearsed, but operator approval has not been granted. | Done/PR evidence may request approval; it must not claim observation is active. |
| `NO-GO / Waiting` | Any required lane has Start-only/missing evidence, default-on safety invariant is disputed, receipt/ACK boundary is ambiguous, or parity is incomplete. | Current state. Post PR/Done with this matrix or Block if no safe artifact is needed. |
| `BLOCK` | Any safety gate is violated: duplicate provider send, auto-ACK of unacked rows, runtime context leakage into evidence, core config mutation, or runtime/bootstrap context files entering branch/artifacts. | Stop observation, run rollback/restoration if anything changed, and post Block with exact offending repo-relative paths or violated gates. |

## Rollback / abort procedure

Use this procedure if any default-on observation gate fails or if an operator stops the observation window. Steps must be evidenced with redacted output only.

1. **Disable default-on observation first.** Set notification opt-in off or restore no-live config. Do not leave a window where default-on mode could auto-send or auto-ACK.
2. **Preserve receipt truth.** Do not ACK terminal-outbox rows based on observation-period provider accepted-send evidence. Leave unconfirmed rows unacked and replayable for reconciliation.
3. **Verify no duplicate sends.** Confirm each observed task produced at most one provider send attempt and that no backlog/historical task was sent during the observation window.
4. **Check for unintended ACK mutations.** Verify that no terminal-outbox rows were automatically ACKed by the default-on path. If any were, document the exact rows and scope before remediation.
5. **Restore no-live config.** Revert only the default-on observation settings changed for this window. Do not mutate core Gateway config.
6. **Post terminal evidence.** Post Done if rollback restored no-live cleanly; post Block if any safety gate was violated, receipt is ambiguous, runtime context leaked, or exact offending paths/artifacts must be reported.

## Runtime/bootstrap and artifact hygiene

Before PR creation or Done evidence, fail closed if any OpenClaw runtime/bootstrap context file would enter the branch diff, PR body, issue comments, or artifact bundle. Offending paths must be reported exactly, including `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.

Evidence must also avoid secrets, provider targets, chat IDs, raw session dumps, private host paths, raw task payloads, and unredacted logs.

## Safe closeout

The safe closeout for this lane is a PR/Done marker that says the default-on production observation safety matrix is documented and the current aggregate decision remains **`NO-GO / Waiting`**. Refresh this libero matrix last after sibling lanes post refreshed terminal evidence; do not advance to `GO` while any default-on non-duplicate, non-ACK, runtime safety, cross-broker parity, prior-state preservation, or rollback gate remains missing or disputed.

This lane does not advance to `GO` for default-on production observation while any acceptance gate remains Start-only/missing, receipt/ACK boundaries are disputed, parity evidence is incomplete, or operator approval for observation has not been granted. This is a read-only validation round; no live activation or default-on production change is authorized or attempted.

## Safety confirmation

This validation used repository inspection and redacted GitHub issue/repository metadata only. It did not perform production deploys, Gateway/broker/worker restarts, live provider or Telegram sends, production database mutations, terminal-outbox ACKs, secret rotations/disclosures, repository visibility changes, source-history imports, release publication, history rewrites, force pushes, raw secret disclosure, host-private path disclosure, or raw session dump publication.
