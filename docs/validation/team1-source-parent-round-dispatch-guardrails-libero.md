# Team1 source-only parent-round dispatch guardrails

Parent: [#829](https://github.com/jinwon-int/a2a-broker/issues/829)
Child: [#394](https://github.com/jinwon-int/a2a-plane/issues/394)
Run: `a2a-team1-post-bangtong-readiness-20260520T110014Z`
Broker of record: `seoseo`
Team: `team1`
Worker: `bangtong`
Reviewed at: `2026-05-20T11:05:00Z`

This is a redacted validation artifact only. It documents the guardrails that apply
to Team1 source-only parent-round dispatch. It does not change repository visibility,
import private source history, deploy, restart Gateway/broker/worker services, mutate
production databases, send provider or Telegram messages, ACK terminal outbox rows,
rotate or disclose credentials, rewrite history, force-push, publish a release, or
post to community channels.

Parent round metadata:
- `parentRoundId=a2a-team1-post-bangtong-readiness-20260520T110014Z`
- `parentRoundTotal=4`
- `parentRoundOrder=4`
- `parentRoundProgress=0`
- `originBrokerId=seoseo`
- `brokerOfRecordId=seoseo`

## Evidence reviewed

- Parent broker dispatch: [a2a-broker#829](https://github.com/jinwon-int/a2a-broker/issues/829).
- Libero lane: [a2a-plane#394](https://github.com/jinwon-int/a2a-plane/issues/394).
- Team1 dispatch contracts: `contracts/a2a/parent-terminal-brief-aggregation.md`, `contracts/a2a/broker-handoff-protocol.md`, `contracts/a2a/canonical-progress-validation-matrix.md`.
- Broker dispatch docs: `packages/broker/docs/github-dispatch-payload.md`.
- Prior Team1 source-only artifacts: `docs/validation/team1-source-public-readiness-libero.md`, `docs/validation/team1-source-public-approval-packet-libero.md`, `docs/validation/team1-source-dryrun-orchestrator-libero.md`, `docs/validation/team1-source-public-approval-rehearsal-libero.md`, `docs/validation/team1-source-public-execution-orchestrator-libero.md`.
- Team2 dispatch guard references: `docs/validation/team2-soonwook-r9-concise-terminal-brief-runtime-readiness.md`, `docs/validation/team1-yukson-r13-terminal-brief-acceptance-matrix.md`, `docs/validation/parent-terminal-brief-aggregation-checklist.md`.

## Guardrail matrix

This matrix enumerates the specific guardrails that Team1 source-only parent-round
dispatch must satisfy. Fail-closed means a missing or inconsistent guard requirement
is **Block** evidence for the lane, not a silent skip or partial continuation.

| # | Guardrail | Required condition | Source-only enforcement | Fail-closed criterion |
| --- | --- | --- | --- | --- |
| G1 | Parent metadata propagation | Every dispatched child carries `parentRoundId`, `originBrokerId`, `parentRoundTotal`, and order/position metadata. Handoff children carry explicit `crossBrokerHandoff` tuple. | ✗ (contract-level; runtime enforcement depends on broker implementation) | A child dispatched without `parentRoundId` or `originBrokerId` must be rejected at the broker dispatch gate. |
| G2 | Origin broker ownership | Only the broker matching `originBrokerId` (or `parentBrokerId` in v1 symmetric) may render, dispatch, update, or retract the aggregate Terminal Brief notification for a parent round. A child or handoff broker must not dispatch its own parent-round aggregate notification. | ✗ (contract-level; runtime dispatch guard not yet implemented in this repo) | A non-origin broker attempting parent-round notification is Block evidence for the round. |
| G3 | Handoff metadata integrity | Handoff brokers receive `parentRoundId` and `originBrokerId` as copied metadata only. They must not rewrite `originBrokerId`, `parentRoundId`, or the immutable metadata block. | ✗ (contract-level; assumes runtime broker enforcement) | Any child payload with a rewritten origin or parent round id must be rejected before task creation. |
| G4 | Dispatch topology creation | The parent dispatch must create lane-linked issues for the intended round roles (broker, plugin, runner, libero) with a known child total and explicit lane mapping. Source-only lanes must not include live-impact actions. | ✓ (verifiable in issue topology) | Parent issue missing lane list, known total, or containing live-impact actions (deploy, restart, provider send, DB mutation, terminal ACK) is Block evidence. |
| G5 | Start-marker discipline | Each lane must post a Start marker before work begins. Start markers are not terminal evidence; they only prove work commenced. | ✓ (verifiable per issue) | A lane with no Start marker is Block evidence; aggregate parent closeout must wait until every lane has Start evidence. |
| G6 | Post-dispatch metadata verification | Within 30–60 seconds after dispatching GitHub issue work, the dispatcher or post-dispatch verifier must assert that `parentRoundId`, `originBrokerId`, and `parentRoundTotal` match on the broker task snapshot. | ✓ (verifiable via broker REST `/tasks?taskOrigin=github&detail=full`) | Verifier missing, window exceeded, or metadata mismatch detected is Block evidence; parent aggregate must not close. |
| G7 | Dispatcher guard implementation | The dispatcher guard must refuse all-hands or cross-broker dispatch when `parentRoundId`, `originBrokerId`, `parentBrokerId`, broker-of-record/handoff routing, and known total are missing or inconsistent. | ✗ (runtime guard; references `a2a-broker#598`, `a2a-broker#608`, `a2a-broker#599`) | Missing dispatcher guard implementation is Block evidence for the broker lane. |
| G8 | Binary no-change guard | A lane that produces no terminal evidence (no PR, Done, or explicit Block) after Start must be treated as Block evidence, not as silent continuation. | ✓ (verifiable per lane issue) | A lane with Start but no subsequent PR/Done/Block comment within round timeout is Block evidence. |
| G9 | Source visibility boundary | Public A2A Plane evidence may reference source-lane issue/PR identifiers only. It must not copy private source material, raw histories, raw session dumps, secrets, provider targets, or host-private paths. | ✓ (verifiable in documentation and artifact evidence) | Any public artifact containing private source material, raw transcripts, credentials, provider targets, or host-private paths is Block evidence. |
| G10 | Runtime/bootstrap hygiene | Branch diff, PR text, issue comments, and artifacts must exclude OpenClaw runtime/bootstrap context files: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`. | ✓ (verifiable before PR creation) | If any deny-list file enters the branch or artifact evidence, report the exact repo-relative offending paths. **Fail closed; do not create PR.** |
| G11 | Approval separation | Start, PR, Done, Block, test, scanner, and provider-id evidence are not operator approval for live-impact or source-visibility actions. Separate explicit operator approval is required for visibility/publication, deploy/restart, live provider send, production DB mutation, terminal ACK, secret changes, history rewrite, force-push, and community posts. | ✓ (verifiable in issue comments and documentation) | Any issue comment, PR, or artifact claiming approval authority for live-impact actions without explicit operator gate evidence is Block evidence. |
| G12 | Generic false-success rejection | Post-dispatch verifier must detect `resultSummary` matching `generic .* accepted by versioned OpenClaw A2A handler` and reject as false success. The old task must be marked superseded/no-op, not treated as work evidence, and re-dispatched only with the canonical GitHub payload. | ✓ (verifiable via broker REST read path) | Generic false success accepted as terminal evidence is Block evidence. |

### Guardrail ownership key

- **✓** = enforceable at the source-only/validation layer (documentation, issue topology inspection, post-hoc verification).
- **✗** = depends on runtime broker/dispatcher implementation (tracked in broker issues `#598`, `#599`, `#608`, `#829`).

## Team1 source-only dispatch scope

The Team1 source-only parent-round dispatch guardrails apply to the current run:

| Field | Value |
| --- | --- |
| Run id | `a2a-team1-post-bangtong-readiness-20260520T110014Z` |
| parentRoundId | `a2a-team1-post-bangtong-readiness-20260520T110014Z` |
| parentRoundTotal | 4 |
| parentRoundOrder | 4 (source-only lane 4/4) |
| parentRoundProgress | 0 |
| originBrokerId | `seoseo` |
| brokerOfRecordId | `seoseo` |
| team | team1 |
| worker | bangtong |
| Safety gate | **source-only** — no production deploy, worker/broker/Gateway restart, live Telegram/provider send, production DB mutation/prune/migration, terminal ACK/replay, historical outbox replay, release/tag/publish, or credential movement. |

## Guardrail state at this snapshot

| Guardrail | Enforcement layer | Current state | Decision |
| --- | --- | --- | --- |
| G1 — Parent metadata propagation | Broker dispatch gate (runtime) | Parent metadata is defined in the round envelope; runtime enforcement tracked in `a2a-broker#829`. | Depends on broker implementation. |
| G2 — Origin broker ownership | Broker dispatch gate (runtime) | Contract-level definition exists; runtime guard not yet implemented. | Tracked in downstream broker issues. |
| G3 — Handoff metadata integrity | Broker dispatch gate (runtime) | Contract-level definition exists; runtime guard not yet implemented. | Tracked in downstream broker issues. |
| G4 — Dispatch topology creation | Issue topology (this round) | This round creates 4 lanes (parent #829, this libero lane, sibling Team1 lanes). Known total = 4, no live-impact actions. | **Pass.** Topology is valid and source-only. |
| G5 — Start-marker discipline | Issue comments (this round) | This lane will post a Start marker. Sibling Start status must be verified at parent closeout. | **Pass for this lane.** Aggregate depends on siblings. |
| G6 — Post-dispatch metadata verification | Broker REST read path (this round) | Post-dispatch verifier assertion window is available via `GET /tasks?taskOrigin=github&detail=full`. | Verifier must be run at parent closeout. |
| G7 — Dispatcher guard implementation | Broker source (runtime) | Multiple broker issues track this (`#598`, `#599`, `#608`). Not yet merged. | **NO-GO** until broker dispatch guard implementation is merged. |
| G8 — Binary no-change guard | Issue comments (this round) | This lane will produce a PR with documentation evidence. | **Pass for this lane.** Aggregate depends on siblings. |
| G9 — Source visibility boundary | Evidence redaction (this round) | This artifact records issue/PR identifiers only, not private source material. | **Pass.** Redacted evidence policy is followed. |
| G10 — Runtime/bootstrap hygiene | Pre-PR guard (this round) | No OpenClaw runtime files are present in the working tree or will enter the branch. | **Pass.** Deny-list verified clean. |
| G11 — Approval separation | Issue comments (this round) | No issue comment or artifact reviewed here grants live-impact or visibility approval. | **Pass for separation.** This is documentation only. |
| G12 — Generic false-success rejection | Post-dispatch verifier (this round) | Verifier must check `resultSummary` for generic handler pattern before treating task as evidence. | Verifier must be run at parent closeout. |

## Local validation commands

```bash
# Run the dispatch guardrail documentation test
npm run check:team1-source-parent-round-dispatch-guardrails
```

## Merge and closeout order

1. Merge any sibling PRs first (broker, plugin, runner lanes).
2. Merge this A2A Plane validation PR after local gates pass. It closes [a2a-plane#394](https://github.com/jinwon-int/a2a-plane/issues/394).
3. Run the merge preflight across all A2A Plane PRs from this round:

```bash
npm run round:merge-preflight -- <a2a-plane-pr> [<a2a-plane-pr> ...]
```

4. Post parent closeout on [a2a-broker#829](https://github.com/jinwon-int/a2a-broker/issues/829) with merged commits, issue closures, guardrail state, and any remaining Block items. If any sibling lane is missing, ambiguous, or unsafe, keep the aggregate decision **NO-GO / Waiting**.

## Current aggregate decision

**Dispatch guardrails documented; source-only lane closeout is NO-GO / Waiting for sibling lane evidence and runtime dispatch guard implementation.** This lane produces a validation artifact that captures the 12 guardrails applicable to Team1 source-only parent-round dispatch. The guardrails marked ✓ are verifiable in this round; those marked ✗ depend on broker runtime implementation tracked in `a2a-broker#598`, `a2a-broker#599`, `a2a-broker#608`, and `a2a-broker#829`.

## Safety confirmation

This validation used repository inspection and redacted GitHub issue metadata only. It did not perform production deploys, Gateway/broker/worker restarts, live provider or Telegram sends, production database mutations, terminal-outbox ACKs, credential rotations/disclosures, repository visibility changes, source-history imports, release publication, community posts, history rewrites, force pushes, raw credential disclosure, host-private path disclosure, or raw session dump publication.
