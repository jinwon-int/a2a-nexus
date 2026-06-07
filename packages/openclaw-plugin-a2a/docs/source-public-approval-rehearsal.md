# Source-Public Approval Rehearsal

**Issue:** jinwon-int/openclaw-plugin-a2a#261
**Parent:** jinwon-int/a2a-plane#211
**Run:** a2a-source-public-approval-rehearsal-20260511T014240Z

Rehearsal module for source-public (repository visibility) operations. Produces
deterministic approval packets, integrated evidence bundles, and no-live
Terminal Brief rehearsals **without ever executing** visibility changes,
approvals, provider sends, or production mutations.

## Safety Boundaries

| Boundary | Value |
|---|---|
| Live execution | `false` (always) |
| Visibility change | `false` (always) |
| Is rehearsal | `true` (always) |
| Approval execution | `false` (always) |
| Release publication | `false` (always) |
| Provider send | `false` (always) |
| Terminal ACK | `false` (always) |
| Production DB mutation | `false` (always) |

## Decision Outputs

The rehearsal produces one of three decisions:

- **GO_CANDIDATE** — all required gates passed; operator may proceed to
  execution after final review.
- **NO_GO** — a hard-blocker gate failed (e.g., invalid repo, runtime context
  files in branch); remediation is required before re-rehearsal.
- **NEEDS_OPERATOR_APPROVAL** — all hard-blocker gates passed but waivable
  gates (CI, review, acknowledgment) require operator action.

## Safety Gates (12 total)

| Gate | Required | Hard Blocker | Waivable |
|---|---|---|---|
| `repo_exists` | yes | yes | no |
| `repo_access` | yes | no | no |
| `not_already_public` | yes | no | no |
| `no_active_incidents` | yes | no | no |
| `operator_configured` | yes | no | no |
| `plugin_active` | yes | no | no |
| `approval_packet_valid` | yes | no | no |
| `no_secrets_in_branch` | yes | yes | no |
| `no_runtime_context_in_branch` | yes | yes | no |
| `ci_passing` | no | no | yes |
| `review_required` | yes | no | yes |
| `operator_acknowledgment` | no | no | yes |

## Usage

```typescript
import { rehearseSourcePublicApproval } from "openclaw-plugin-a2a/src/source-public-approval-rehearsal";

const report = rehearseSourcePublicApproval(
  {
    repo: "jinwon-int/openclaw-plugin-a2a",
    currentVisibility: "private",
    ciPassing: true,
    operatorReviewed: true,
    operatorAcknowledged: true,
    issueNumber: 261,
    evidenceUrls: {
      issue: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/261",
      startComment: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/261#issuecomment-1",
    },
  },
  pluginConfig,
  { runId: "my-rehearsal-run" },
);

console.log(report.decision); // "GO_CANDIDATE" | "NO_GO" | "NEEDS_OPERATOR_APPROVAL"
console.log(report.approvalPacket.dedupeKey); // deterministic, replay-proof
console.log(report.terminalBrief.line); // operator-facing terminal brief line
```

## Replay / No-Duplicate Proof

The approval packet includes a deterministic `dedupeKey` constructed from
`repo + runId + decision + timestamp`. Identical inputs produce identical
keys. Different inputs produce different keys. This prevents accidental
replay or duplicate approval submissions.

## Rollback / Abort

Since the rehearsal **never mutates state**, rollback requires no action.
To abort: discard the rehearsal report. To re-rehearse: call
`rehearseSourcePublicApproval()` with updated inputs.

## Integration

This module integrates with:

- `github-evidence-projection.ts` — GitHub evidence URLs for Terminal Brief
- `operator-terminal-notifier.ts` — operator-facing notification envelopes
- `approval-dry-run-projection.ts` — dry-run approval projections (broker)
- `conformance-smoke-gate.ts` — no-live conformance smoke gate

All integrations are read-only / projection-only. No module in this chain
performs live provider sends or visibility changes.
