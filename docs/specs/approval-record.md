# Approval record contract

Approval-sensitive actions require a structured approval record before execution. The record names the action, target, operator role, approval timestamp, rollback/no-op boundary, evidence issue, and optional expiry.

This contract records approval evidence only; it does not grant permission by itself and does not authorize releases, tags, publication, deployment, visibility changes, secret movement, DB/outbox/ACK/replay mutation, provider sends, or history rewrites.

## Required fields

| Field | Meaning |
| --- | --- |
| `action` | One of the approval-gated action names in `fixtures/approvals/approval-record.schema.json`. |
| `target` | Repository, package, artifact, setting, service, or path being approved. |
| `approverRole` | Must be `operator`; do not record personal channels or names. |
| `approvedAt` | UTC timestamp for the approval evidence. |
| `rollbackBoundary` | The rollback, no-op, or stop boundary named with the approval. |
| `evidenceIssue` | GitHub issue number that carries the public-safe evidence. |
| `scopeExpiry` | Optional UTC expiry for time-bounded approval. |

## Public-safety rules

Records must not include raw secrets, personal messaging channels, production endpoint secrets, private topology, or personal-name fields. If the approval came from a private channel, record only the role-level fact and public-safe issue evidence.
