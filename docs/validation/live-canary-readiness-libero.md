# A2A live-canary readiness libero validation

Parent: #174 (a2a-plane#174, internal tracker private)
Child: #176 (a2a-plane#176, internal tracker private)
Run: `a2a-live-canary-readiness-20260509T173917Z`
Broker of record: `brokerAlpha`
Team: `team1-brokerAlpha`
Worker: `workerDelta`
Snapshot: `2026-05-09T17:41Z`

This note is a validation artifact only. It does not implement sibling lanes, merge PRs, change repository visibility, create releases, deploy, restart services, mutate a database, send live provider/Telegram messages, ACK terminal outbox records, rotate or disclose secrets, rewrite history, or force-push.

## Round validation matrix

At this snapshot, all live-canary readiness lanes have Start evidence, and no linked PR, Done, or Block closeout evidence was observed from the public issue/PR surfaces reviewed for this lane. The integration decision is therefore **NO-GO / Waiting** until each lane posts terminal evidence and brokerAlpha runs the merge-preflight gate for the exact A2A Nexus merge train.

| Lane | Issue | Required proof before it can count for this round | Snapshot evidence | Integration decision |
| --- | --- | --- | --- | --- |
| Team1 workerGamma | a2a-plane#175 (a2a-plane#175, internal tracker private) | A2A Nexus #93/#130 policy gaps closed with no-live canary wording, accepted-send/non-ACK boundaries, and tests/docs for terminal evidence separation. | Start marker only; no PR/Done/Block closeout observed. | Waiting. Must not imply public-readiness GO from policy text or local checks alone. |
| Team1 workerBeta | [openclaw-plugin-a2a#247](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/247) | Plugin no-live Terminal Brief canary harness proving provider send/message id remains accepted-send evidence only. | Start marker only; no PR/Done/Block closeout observed. | Waiting. Cross-repo prerequisite for receipt wording, but cannot replace A2A Nexus merge-preflight. |
| Team1 workerAlpha | [a2a-broker#459](https://github.com/jinwon-int/a2a-broker/issues/459) | Broker no-delivery canary and receipt gate showing no real terminal-outbox ACK, no live send, and observable receipt gaps. | Start marker only; no PR/Done/Block closeout observed. | Waiting. Must remain no-delivery/no-real-ACK unless operator explicitly approves otherwise. |
| Team1 workerDelta | a2a-plane#176 (a2a-plane#176, internal tracker private) | This validation matrix, explicit merge order, and NO-GO/approval wording. | This document. | Waiting until sibling lanes publish terminal evidence and any A2A Nexus PR order is known. |
| Team2 workerEpsilon | [a2a-broker#460](https://github.com/jinwon-int/a2a-broker/issues/460) | Independent AgentCard/capability registry public seam review with redacted evidence and no visibility change. | Start marker only; no PR/Done/Block closeout observed. | Waiting. Useful as independent validation after Team1 receipt/capability terms settle. |
| Team2 workerZeta | [a2a-docker-runner#164](https://github.com/jinwon-int/a2a-docker-runner/issues/164) | Isolated runner visibility and cleanup hardening proof, including secret-safe logs/artifacts. | Start marker only; no PR/Done/Block closeout observed. | Waiting. Must not leak runner workspace paths, raw logs, or bootstrap context in evidence. |
| Team2 workerEta | a2a-plane#177 (a2a-plane#177, internal tracker private) | No-duplicate replay proof plus scanner/approval-boundary proof that scanner success is not operator approval. | Start markers only; no PR/Done/Block closeout observed. | Waiting. Should be merged after accepted-send/non-ACK wording is stable. |

## Merge-order recommendation

1. Land A2A Nexus policy/contract changes first, starting with #175 if it changes shared #93/#130 live-canary or terminal evidence vocabulary.
2. Refresh or land cross-repo plugin/broker no-live canary lanes (#247 and #459) against those shared terms before citing them as receipt/Terminal Brief evidence.
3. Land Team2 AgentCard/capability and runner visibility validations (#460 and #164) after the shared public seam and artifact-hygiene terms are stable.
4. Land A2A Nexus replay/scanner/approval-boundary proof (#177) after accepted-send/non-ACK and runner evidence wording is stable, so the proof validates the candidate tree rather than an older draft.
5. Refresh this libero lane (#176) last, or keep it Waiting/Block, so final closeout reflects actual PR/Done/Block evidence and exact PR order.

If multiple A2A Nexus PRs from this round exist, brokerAlpha must run the local-only merge train before the first merge, using the exact intended order:

```bash
npm run round:merge-preflight -- <a2a-plane-pr> [<a2a-plane-pr> ...]
```

If the round changes release-gate tests or public-readiness gates, use the stronger command:

```bash
npm run round:merge-preflight -- --run "npm run check && npm run test:release-gate" <a2a-plane-pr> [<a2a-plane-pr> ...]
```

Record the PR order, command, and successful output on #174 before merging the first PR. A failed preflight stops the merge train; fix the integration gap in a PR before merging any round PR. Cross-repo PRs (#247, #459, #460, #164) must be cited as prerequisite evidence, but they are not substitutes for the A2A Nexus merge-preflight on A2A Nexus PRs.

## NO-GO and approval wording

Public-readiness remains **NO-GO / Waiting** unless all of the following are true:

- Each child lane posts terminal PR/Done/Block evidence with redacted, canonical links.
- A2A Nexus terminal evidence and replay-safety proofs show provider accepted-send evidence is not requester-visible receipt, operator-visible receipt, terminal ACK, human-seen proof, or terminal-outbox ACK.
- Local public-readiness/release gates and any required scanner/readiness gates are clean or explicitly blocked with redacted evidence.
- Runtime/bootstrap hygiene is clear for the branch diff and artifact evidence.
- the operator explicitly approves repository visibility/publication in a separate operator decision after the evidence is complete.

Scanner success, PR CI success, branch existence, Start comments, provider send success, provider message ids, or no-live canary success do **not** authorize repository visibility/publication and do **not** constitute terminal ACK evidence.

## Runtime/bootstrap and evidence hygiene

Fail closed before PR/Done evidence if any of these paths enter the branch diff or artifact evidence: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`.

## Current decision

**NO-GO / Waiting.** The round has Start evidence only at this snapshot. Next owner is brokerAlpha for merge-train coordination after sibling lanes publish terminal evidence; this libero lane should be refreshed last with the exact A2A Nexus PR order, merge-preflight command/output, and final GO/NO-GO matrix.

## Safety confirmation

This validation used redacted repository and GitHub issue/PR inspection only. It did not perform production deploys, Gateway/broker/worker restarts, live provider or Telegram sends, production database mutations, terminal-outbox ACKs, edge-secret rotations, repository visibility changes, release publication, history rewrites, force pushes, raw secret disclosure, host-private path disclosure, or raw session dump publication.
