# Public/Private Boundary Governance Gates

This governance note defines who may turn public-readiness evidence into a visibility action for A2A Nexus. It is a control surface, not approval to act.

## Boundary principles

- **Private by default (historical):** the repository was private until operator approval was granted. Public since 2026-05-27. The governance principles for evidence handling, operator approval, and fail-closed checks remain valid for future promotion steps.
- **Evidence is not approval:** passing tests, clean scanners, merged PRs, or green CI may support review, but none of them authorizes a visibility change.
- **No bundled live actions:** visibility approval must not bundle deploys, service restarts, production database mutations, live provider sends, terminal-outbox ACKs, edge-secret rotation, secret disclosure, history rewrite, or force-push.
- **OpenClaw/A2A receipt boundary remains blocking:** do not claim public-readiness is unblocked by provider message ids or send-result evidence. `openclaw/openclaw#78261` is closed/superseded; A2A Nexus must prove terminal evidence, replay safety, scanner readiness, and explicit operator approval instead.

## Gate owners and outcomes

| Gate | Owner | GO condition | NO-GO / Block condition |
| --- | --- | --- | --- |
| Public/private boundary | Broker of record (`gwakga`) prepares evidence; operator decides | Public; materials contain no private context. Historical private-readiness evidence is archived. | Any private endpoint, provider ID, host-specific path, raw session dump, or OpenClaw runtime/bootstrap file would enter branch/artifact/evidence |
| Terminal evidence | Lane owner links redacted terminal evidence | Candidate flow has requester/operator-visible terminal receipt evidence; provider message IDs or accepted-send results are labeled non-terminal | Terminal evidence is missing, stale, ambiguous, or replaced by provider send success/IDs |
| Replay safety | Lane owner links redacted replay/canary proof | Duplicate sends/retries cannot mint a false terminal ACK, and replay controls are described without secrets/provider IDs | Replay-safety proof is absent, stale, disputed, or exposes sensitive identifiers |
| Scanner output | Lane owner links redacted scanner output | Supported external scanner evidence is clean or explicitly dispositioned, and local readiness scans pass | External scanner unavailable, stale, or replaced by local-only checks |
| GO/NO-GO matrix | Cross-team broker | Every required gate is GO with owner, timestamp, and evidence link | Any required gate is missing, waiting, disputed, or stale |
| Evidence policy | PR author and reviewer | Evidence is redacted and limited to commands, statuses, counts/classes, commit SHAs, and links | Evidence includes raw secrets, matched values, private paths, provider IDs, Telegram IDs, raw session dumps, or terminal ACK mutation data |
| Operator approval | Operator only | Explicit comment approves repository visibility/publication for this repository and is separate from execution | Approval absent, ambiguous, scoped to another repository, or bundled with live-impact actions |

## Operator approval contract

A valid approval comment must include:

1. Repository name: `a2a-plane (internal tracker, private)`.
2. Approved action: repository visibility/publication, not a generic "looks good".
3. Scope exclusions: no deploy, restart, production DB mutation, provider send, terminal ACK, secret rotation/disclosure, history rewrite, force-push, npm publish, Docker publish, or release creation unless separately approved.
4. Link to the latest redacted GO/NO-GO matrix, terminal evidence, replay-safety proof, and scanner output.

If any element is missing, record **NO-GO / Waiting** and ask for clarification. Do not infer approval.

## Pre-PR fail-closed check

Before a PR/Done marker, run and report:

```sh
git status --short
npm run scan:readiness-gates
npm run scan:public-readiness
git diff --name-only HEAD --
```

Then explicitly confirm that these paths are absent from branch diffs and artifact evidence:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

If any listed path appears, stop and post Block evidence with the exact repo-relative offending paths.
