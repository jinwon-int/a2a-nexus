# Terminal Outbox Stale Accepted Residue Runbook

This runbook defines how operators should treat terminal outbox rows that are
still reported as accepted/unacked after the related canary, closeout, or
all-hands work is already complete.

The policy is intentionally conservative. These rows are evidence first, not
cleanup targets. Nothing in this runbook authorizes manual ACK, replay, DB
mutation, prune, synthetic receipt insertion, broker restart, or Gateway
restart.

## Scope

A stale accepted residue row is a terminal outbox row that satisfies all of the
following:

- The row is from completed historical work, such as a closed issue, merged PR,
  or completed canary round.
- The receipt state is accepted or otherwise non-terminal from the current
  operator point of view.
- The row has no current-session-visible or operator-visible ACK proof.
- Replaying or ACKing the row would create duplicate or misleading operator
  evidence.

These rows differ from actionable current-window rows. Current-window rows are
recent, still part of active work, or missing proof required to decide whether
the operator actually saw the terminal event.

## Preserve

Preserve stale accepted residue when any of these are true:

- It is linked to a known historical canary, release gate, all-hands round, or
  closeout record.
- It is needed to explain current health counters.
- There is no current-session-visible or operator-visible ACK proof.
- Cleanup would require manual SQL, synthetic receipt insertion, ACK replay, or
  provider resend.

Preserved rows may remain visible in diagnostics, but they should not be treated
as immediate operator action unless current evidence says the row still belongs
to active work.

## Mark As Stale Or Hide From Actionable Warnings

A product behavior may classify or hide a stale accepted residue row from
actionable warnings only when the classification is derived from read-only
signals, for example:

- linked issue or PR is closed or merged;
- row belongs to a completed run id, parent round, or canary id;
- row age exceeds the current operator-action window;
- receipt state is accepted but no current ACK proof exists;
- no active task, worker lane, or finalizer is waiting on that row.

The classification must be durable and audit-visible. It must not mutate ACK
state, perform replay, prune the row, or create synthetic receipt evidence.

## ACK Requirements

Manual ACK is not allowed for stale accepted residue unless a separate operator
approval explicitly authorizes it and the operator has current-session-visible
or operator-visible proof for the exact row being ACKed.

Provider acceptance, provider delivery success, task success, merged PR, closed
issue, or historical canary success is not terminal ACK evidence by itself.

## Cleanup Requirements

Before any prune/delete/stale-mark implementation is approved, the operator
must have:

- a dry-run cleanup plan listing exact row ids and reasons;
- backup or checkpoint proof sufficient for rollback;
- an approval token or equivalent confirmation tied to the dry-run plan;
- an audit event recording who approved the action and why;
- proof that no active task, finalizer, or worker lane still depends on the row.

Without those requirements, cleanup remains advisory only.

## Replay Avoidance

Do not replay stale accepted residue to manufacture current proof. Replays can
create duplicate Telegram/provider notifications and can make old work look
active again. If current proof is required, start a new explicit canary or
validation task instead of replaying a historical terminal outbox row.

## Recommended Health Semantics

Health and diagnostics should separate these categories:

- `actionableUnacked`: rows that still need operator attention now;
- `staleAcceptedResidue`: completed historical rows preserved for evidence;
- `blockedCleanupCandidates`: rows that would require explicit cleanup approval;
- `unsafeUnknown`: rows that cannot be classified safely and need manual review.

Only `actionableUnacked` should page or block a fresh release gate. Stale
accepted residue may warn, but it should explain why no ACK/replay/prune action
is currently allowed.

## Current Decision

For the two rows referenced by #1254, preserve them for now. They are historical
residue and not manual ACK/replay candidates. A future product change may hide
them from actionable health warnings after it can prove the row is historical
using read-only, audit-visible signals.
