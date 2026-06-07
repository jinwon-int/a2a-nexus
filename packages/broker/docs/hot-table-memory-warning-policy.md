# Hot-table memory warning policy

Issue: [#1255](https://github.com/jinwon-int/a2a-broker/issues/1255)

Hot-table memory warnings are not all action-required. A warning can mean either "bounded condition worth observing" or "pressure signal that needs follow-up". The broker projection exposes that distinction as `operatorAction`.

## Operator action tiers

| `operatorAction` | Meaning | Operator response |
|---|---|---|
| `observe` | The warning is bounded or informational. | Record the observation and recheck later. No cleanup, restart, cap change, or ACK action. |
| `investigate` | A warning has pressure or trend signals. | Open or update an issue with `/health.hotTableGrowth` evidence before proposing any action. |
| `approval_required` | A critical table or aggregate critical memory condition is present. | Do not mutate state. Prepare an issue, backup/rollback plan, and explicit operator approval request. |

## Current steady-state classification

`broker_audit_events` near its runtime cap is `observe` when all of these are true:

- the table is at or above the audit runtime warning ratio;
- `runtimeSkipped=0`;
- estimated memory is below the warning memory threshold;
- growth is absent or below the warning growth threshold.

This preserves the visible `severity="warning"` while making the action clear: no prune is needed just because the audit ring buffer is near cap.

When total hot-table memory is above the warning threshold but no table has pressure signals, the aggregate `operatorAction` is also `observe`. The correct response is trend monitoring, not immediate DB cleanup.

## Approval boundary

The projection is read-only. It does not approve or perform:

- DB mutation, prune, migration, or manual SQL;
- Terminal ACK/replay or terminal-outbox deletion;
- broker/Gateway restart or recreate;
- retention cap or environment changes;
- provider/Telegram canary sends.

Those actions require a separate issue-backed plan, backup/rollback evidence where applicable, and explicit operator approval.
