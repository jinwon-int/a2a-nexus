# GitHub Evidence Projection (Terminal Brief Extension, v0)

> **v0 (2026-05-11):** GitHub issue/PR comment evidence projection as a first-class Terminal Brief extension.
> Comments are evidence ledger entries — durable, reviewable, manifest-bound — but they are never
> ACK, read receipt, visibility proof, or approval. This contract is frozen pending a v0→v1 plan
> only for the non-ACK boundary and manifest-binding rules.

A2A workers, brokers, and runners may project terminal evidence into GitHub issue/PR comments for
durable, reviewable, cross-team traceability. This contract defines the schema, idempotency,
replay-suppression, redaction, and non-ACK boundary rules that make GitHub comments safe evidence.

## Core principles

- **Evidence ledger, not ACK**: A GitHub comment is an append-only ledger entry. It does not prove
  that any human read it, saw the Terminal Brief, or approved the result.
- **Manifest-bound**: Every evidence comment is bound to a task manifest (idempotency key + envelope hash).
  A single manifest can produce at most one comment of each evidence kind (Start, PR, Done, Block).
- **Idempotent**: Posting the same evidence kind for the same manifest is a no-op; the existing
  comment URL is returned without creating a duplicate.
- **Replay-safe**: Replaying a completed task returns the existing evidence comment URLs; no new
  comments are posted, no side effects are introduced.
- **Redacted**: Comment bodies must not contain secrets, private endpoint values, host-specific
  private paths, or raw session dumps.
- **Separated from approval**: GitHub comments are never sufficient for operator approval.
  Approval must travel through a separate, explicit channel (as defined in the approval-boundary
  contract).

## Evidence comment kinds

| Kind    | Purpose                                          | Terminal Brief relation           |
|---------|--------------------------------------------------|-----------------------------------|
| `start` | Work has begun for this run/round                | Precedes PR/Done/Block evidence   |
| `pr`    | A pull request has been created with the changes | Accompanies terminal `pr` result  |
| `done`  | A non-PR task completed successfully             | Accompanies terminal `done` result|
| `block` | The task was blocked (unsafe, impossible, etc.)  | Accompanies terminal `block` result|

The runner's issue `start` comment keeps the literal first line `Start` and now carries an
`<!-- a2a:github-evidence:v1 task=<id> issue=<repo#N> outcome=start -->` marker plus a one-line
sanitized requester/task summary, so claimants are identifiable when sessions share one GitHub
account. Dedupe lookups by marker are unaffected because the outcome is part of the marker.

## Idempotency and replay suppression

Every evidence comment carries an **evidence key** derived from the task manifest:

```
evidenceKey = "<idempotencyKey>:<envelopeHash>:<evidenceKind>"
```

Rules:

- **Post**: If no comment with this evidence key exists, create it. The returned comment URL is
  immutable evidence.
- **Deduplicate**: If a comment with this evidence key already exists, return the existing URL.
  Do not create a second comment.
- **Conflict**: If the evidence key exists but the logical payload differs (different summary or
  changed-files set), the broker must surface the conflict and refuse to overwrite.
- **Replay**: Replay of a terminal task returns the terminal result artifact and its attached
  evidence comment URLs without posting new comments.

## Non-ACK boundary (explicit separation)

GitHub evidence comments are receipt level 2 evidence (requester-visible receipt) at most. They:

- Are **never** terminal ACK (level 4).
- Do **not** constitute operator-visible receipt (level 3) unless the operator has explicitly
  confirmed seeing the comment through a separate ACK-safe channel.
- Are **not** approval. `githubCommentUrl` must never be used as an approval signal.
- Are **not** a substitute for `manual_operator_receipt` or `current_session_visible` ACK-safe proofs.

This boundary is frozen. No future contract change may promote `githubCommentUrl` to terminal ACK
without an explicit v0→v1 plan and cross-team review.

## Manifest binding

Every evidence projection event includes:

```json
{
  "evidenceKey": "<idempotencyKey>:<envelopeHash>:<evidenceKind>",
  "runId": "<run identifier>",
  "issueUrl": "https://github.com/<owner>/<repo>/issues/<n>",
  "evidenceKind": "start|pr|done|block",
  "timestamp": "<ISO-8601>",
  "commentUrl": "https://github.com/<owner>/<repo>/issues/<n>#issuecomment-<id>",
  "redacted": true,
  "terminalOutboxAckMutated": false,
  "liveProviderSend": false,
  "isApproval": false,
  "isTerminalAck": false,
  "isReadReceipt": false
}
```

## Redaction rules

Comment bodies must pass the same redaction checks as terminal evidence:

- No GitHub personal access tokens (`ghp_…`, `github_pat_…`).
- No Slack/Telegram/Discord bot tokens (`xox[baprs]-…`).
- No private SSH keys (`-----BEGIN … PRIVATE KEY-----`).
- No host-specific home-directory paths (`/home/<user>/`, `/Users/<user>/`).
- No raw session dumps or internal Gateway/broker state.
- No OpenClaw runtime/bootstrap file references (`AGENTS.md`, `SOUL.md`, `USER.md`, etc.).

## Safety gates

GitHub evidence projection must confirm:

- No production deploy or Gateway/broker/worker restart.
- No live provider/Telegram send outside GitHub comments.
- No terminal-outbox ACK mutation.
- No production database mutation.
- No secret rotation or secret value disclosure.
- No repository visibility change.
- No automatic merge, release, or community publication.
- No force-push or history rewrite.
- `isApproval: false`, `isTerminalAck: false`, `isReadReceipt: false` on every evidence comment.
