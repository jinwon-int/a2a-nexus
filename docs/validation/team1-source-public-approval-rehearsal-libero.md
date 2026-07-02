# Team1 source-public approval rehearsal validation matrix

Parent: #211 (a2a-plane#211, internal tracker private)
Child: #212 (a2a-plane#212, internal tracker private)
Run: `a2a-source-public-approval-rehearsal-20260511T014240Z`
Team: `team1`
Lane: `workerGamma`
Reviewed at: `2026-05-11T01:42:40Z`

This is a redacted validation artifact only. It does not change repository visibility, import private source history, deploy, restart Gateway/broker/worker services, mutate production databases, send provider or Telegram messages, ACK terminal outbox rows, rotate or disclose credentials, rewrite history, force-push, publish a release, or post to community channels.

## Evidence reviewed

- Parent dispatch: a2a-plane#211 (a2a-plane#211, internal tracker private).
- Team1 lane: a2a-plane#212 (a2a-plane#212, internal tracker private).
- Approval packet schema: `docs/approval-rehearsal/source-public-approval-packet-schema.json`.
- Approval rehearsal aggregator: `scripts/a2a-source-public-approval-rehearsal.mjs`.
- Conformance tests: `scripts/a2a-source-public-approval-rehearsal.test.mjs`.
- Test fixture: `fixtures/approval-rehearsal/team1-workerGamma-approval-rehearsal-evidence.json`.
- Prior dry-run schema: `docs/dry-run/source-public-dryrun-schema.json`.
- Prior fail-closed gates: `docs/readiness/fail-closed-gates.json`.

## Approval rehearsal outputs

The approval rehearsal round produces deterministic approval packets with integrated evidence bundles. It introduces three decision outputs:

| Decision | Condition | Meaning |
| --- | --- | --- |
| **GO_CANDIDATE** | All 14 required gates GO including explicit operator approval | Approval packet is structurally valid and ready for operator review; source-public execution is still NO_GO |
| **NO_GO** | Any required gate not GO | Evidence is insufficient or blocked; approval packet cannot proceed |
| **NEEDS_OPERATOR_APPROVAL** | All non-approval gates GO but operatorApproval is not GO | Rehearsal passes technical gates; explicit operator sign-off required |

## Approval packet validation matrix

| Gate | Required condition | Current evidence | Decision |
| --- | --- | --- | --- |
| Broker/plugin/runner packets | Each domain must provide redacted readiness evidence with health, queue, worker matrix, and no-live flags. | Approval rehearsal schema and aggregator enforce domain-specific validation of evidence packets; test fixture provides canonical GO structure. | **Pass for packet structure after fixture validates.** Domain-specific evidence comes from sibling source repos. |
| Scanner/history evidence | External scanner/history procedure and redacted output must be present or explicitly Blocked. | Schema gate requires external scanner evidence; missing scanner evidence blocks GO_CANDIDATE. | **NO_GO for execution until external scanner evidence is linked.** Schema-correct; actual scanner evidence is a remaining operator gate. |
| Source visibility boundary | Repository is private; no source visibility change is performed. | All files added are redacted, public-safe schema, aggregator, tests, docs, and fixtures. No private endpoints, provider IDs, or raw session dumps. | **Pass for boundary; NO_GO for expansion.** |
| Terminal/replay/readiness gates | Provider message ID/send success is not terminal ACK evidence; it is accepted-send evidence only. Replay/no-duplicate readiness requires separate proof. | Schema includes `rehearsalIdempotencyProof` gate requiring at least two identical rehearsal runs producing same output. No live provider send or terminal ACK is performed. | **Pass for no-live posture; NO_GO for activation.** |
| License/support/docs gaps | Not applicable to schema/aggregator/test round. | This round adds schema, code, and test artifacts only. | **Pass; not a blocker for this round.** |
| Exact operator approvals | Visibility, release, deploy, live provider send, terminal ACK, secret change, history rewrite, force-push, and community posts require explicit operator approval. | Schema enforces `operatorApproval` as a separate gate; `NEEDS_OPERATOR_APPROVAL` decision documents the gap. | **Pass for separation; NO_GO for execution.** |
| Runtime/bootstrap hygiene | Branch diff, PR text, issue comments, and artifacts must exclude runtime/bootstrap context files. | `.gitignore` excludes `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, and `.openclaw/**`. Schema `runtimeBootstrapHygiene` gate enforces denyPaths. | **Pass; denyPaths excluded from branch.** |

## Additional approval rehearsal gates

Beyond the dry-run gates, the approval rehearsal round adds three new required gates:

| Gate | Purpose | Evidence |
| --- | --- | --- |
| `approvalPacketIntegrity` | Ensures the approval packet is structurally complete with all required gates, evidence URLs, and timestamps. | Aggregator validates every required gate has status and evidence links; missing gates block GO_CANDIDATE. |
| `rehearsalIdempotencyProof` | Proves the rehearsal produces deterministic, replay-safe output with no duplicate packets. | Schema requires at least two identical rehearsal runs; idempotency key/run identifier is tracked. |
| `rollbackAbortPath` | Documents rollback and abort procedures that leave no side effects. | Both rollback and abort are no-live: no deploy, restart, provider send, or DB mutation. |

## Rollback/abort path

This approval rehearsal round is no-live and read-only:

- **Rollback:** Delete the approval rehearsal schema, aggregator, tests, and fixture from the branch. No stateful side effects exist.
- **Abort:** Halt all approval-rehearsal processing. No partial state, provider messages, database mutations, or live service changes are left behind.
- **Safety:** Both rollback and abort are pure code removal with no deploy, restart, or live-impact steps.

## Current aggregate decision

**NEEDS_OPERATOR_APPROVAL.** The approval rehearsal schema, aggregator, conformance tests, and validation docs are structurally complete. All technical gates pass. Source-public execution remains NO_GO without explicit operator approval for the approval packet. This is an approval rehearsal round only: GO_CANDIDATE, NO_GO, and NEEDS_OPERATOR_APPROVAL decisions are produced as rehearsal output; no approval, release, or visibility change is executed.

## Safety confirmation

This validation used repository inspection and redacted GitHub issue metadata only. It did not perform production deploys, Gateway/broker/worker restarts, live provider or Telegram sends, production database mutations, terminal-outbox ACKs, credential rotations/disclosures, repository visibility changes, source-history imports, release publication, community posts, history rewrites, force pushes, raw credential disclosure, host-private path disclosure, or raw session dump publication.
