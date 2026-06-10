# A2A public-readiness next-round libero validation

Parent: [#163](https://github.com/jinwon-int/a2a-plane/issues/163)
Child: [#165](https://github.com/jinwon-int/a2a-plane/issues/165)
Run: `a2a-public-readiness-next-20260509T165108Z`
Broker of record: `seoseo`
Team: `team1-seoseo`
Worker: `yukson`
Snapshot: `2026-05-09T16:54:10Z`

This note is a validation artifact only. It does not implement sibling lanes, merge PRs, change repository visibility, create releases, deploy, restart services, mutate a database, send live provider/Telegram messages, ACK terminal outbox records, rotate secrets, rewrite history, or force-push.

## Round validation matrix

At this snapshot, the sibling lanes have Start evidence but no linked PR, Done, or Block closeout evidence observed from the public issue surfaces reviewed for this lane. The integration decision is therefore **NO-GO / Waiting** until each lane posts terminal evidence and Seoseo runs the merge-preflight gate for the exact A2A Nexus merge train.

| Lane | Issue | Required proof before it can count for this round | Snapshot evidence | Integration decision |
| --- | --- | --- | --- | --- |
| Team1 bangtong | [a2a-plane#164](https://github.com/jinwon-int/a2a-plane/issues/164) | Durable checkpoint and human-interrupt contract, plus tests or fixtures proving terminal/interruption states are not ambiguous. | Start marker only; no PR/Done/Block closeout observed. | Waiting. Do not let checkpoint wording imply production persistence or DB mutation. |
| Team1 sogyo | [openclaw-plugin-a2a#245](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/245) | Plugin evidence that provider-returned IDs and send success remain accepted-send/non-ACK only, with fail-closed wording. | Start marker only; no PR/Done/Block closeout observed. | Waiting. Merge/order against a2a-plane terms before any receipt closeout claims. |
| Team1 nosuk | [a2a-broker#457](https://github.com/jinwon-int/a2a-broker/issues/457) | Broker receipt roadmap and queue hygiene closeout that keeps requester/operator-visible receipt separate from provider acceptance. | Start marker only; no PR/Done/Block closeout observed. | Waiting. Must not mutate live broker state or terminal-outbox ACKs. |
| Team2 dungae | [a2a-plane#166](https://github.com/jinwon-int/a2a-plane/issues/166) | Independent compatibility/policy proof from public-safe files, tied back to issue #94. | Start marker only; no PR/Done/Block closeout observed. | Waiting. Useful as independent validation only after exact commands and changed paths are linked. |
| Team2 jingun | [a2a-plane#167](https://github.com/jinwon-int/a2a-plane/issues/167) | Scanner/readiness governance and redacted evidence audit that fail closes without scanner evidence and without explicit operator approval. | Start markers observed; no PR/Done/Block closeout observed. | Waiting. Should refresh after wording-changing lanes settle. |
| Team2 soonwook | [a2a-plane#168](https://github.com/jinwon-int/a2a-plane/issues/168) | Second-worker replay/no-duplicate proof and compact redacted trace validation. | Start markers observed; no PR/Done/Block closeout observed. | Waiting. Must prove replay safety without live sends, private topology, or ACK mutation. |

## Merge-order recommendation

1. Land A2A Nexus contract/fixture changes for checkpoint, interrupt, terminal-state, and accepted-send vocabulary first, starting with #164 if it changes shared terms.
2. Refresh or land the cross-repo plugin/broker receipt lanes (#245 and #457) against those terms before citing them as receipt-closeout evidence.
3. Land Team2 compatibility/policy proof (#166) after the shared A2A Nexus terms are stable, so it validates the same public contract rather than an older draft.
4. Land replay/no-duplicate and trace proof (#168) after provider-accepted/non-ACK wording is stable across plugin and broker surfaces.
5. Land scanner/readiness governance (#167) after the final wording and evidence surfaces settle, so the scanner/readiness gate validates the candidate tree that Seoseo will review.
6. Refresh this libero lane (#165) last, or explicitly keep it Block/Waiting, so the final closeout matrix reflects the actual PR/Done/Block outputs instead of Start-only evidence.

## Required round merge preflight

Before Seoseo merges more than one A2A Nexus PR from this round, the exact intended merge order must be tested locally with the integrated gate before the first merge:

```bash
npm run round:merge-preflight -- <a2a-plane-pr> [<a2a-plane-pr> ...]
```

If the round changes release-gate tests or public-readiness gates, use the stronger validation command:

```bash
npm run round:merge-preflight -- --run "npm run check && npm run test:release-gate" <a2a-plane-pr> [<a2a-plane-pr> ...]
```

Record the PR order, command, and successful output on #163 before merging the first PR. If any cross-repo lane (#245 or #457) is a prerequisite, cite its final PR/Done/Block evidence and re-run the A2A Nexus gate after rebasing/importing the dependent A2A Nexus PRs. A failed preflight stops the merge train; fix the integration gap in a PR before merging any round PR.

## Public-readiness wording check

Reviewed surfaces for this validation artifact:

- `docs/public-readiness.md`
- `docs/release-checklist.md`
- `docs/readiness/fail-closed-gates.json`

Current wording keeps technical readiness separate from operator authority:

- Public-readiness remains **NO-GO / Waiting** unless terminal evidence, replay safety, external scanner evidence, runtime/bootstrap hygiene, redacted evidence, and explicit operator approval are all satisfied.
- External scanner success, local `npm run check`, or PR CI success is not visibility approval.
- Operator approval must explicitly name repository visibility/publication and must be separate from any execution step.
- No lane may claim GO from provider accepted-send evidence, message IDs, Start comments, branch pushes, or GitHub PR existence alone.

## Runtime/bootstrap and evidence hygiene

This branch artifact is intended to include only this validation note. Fail closed before PR or Done evidence if any of these paths appear in the branch diff or artifact evidence: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`.

## Current decision

**NO-GO / Waiting.** Start evidence exists for the round, but terminal PR/Done/Block evidence for sibling lanes is not yet present in this snapshot. The next owner is Seoseo for merge-train coordination after sibling lanes publish terminal evidence; this libero lane should be refreshed last with the exact PR order, preflight command, and final GO/NO-GO matrix.

## Safety confirmation

This validation used redacted repository and GitHub issue inspection only. It did not perform production deploys, Gateway/broker/worker restarts, live provider or Telegram sends, production database mutations, terminal-outbox ACKs, edge-secret rotations, repository visibility changes, release publication, history rewrites, force pushes, raw secret disclosure, host-private path disclosure, or raw session dump publication. Provider send success and provider message IDs remain accepted-send evidence only and are not requester-visible receipt, operator-visible receipt, human-seen proof, terminal ACK, or terminal-outbox ACK evidence.
