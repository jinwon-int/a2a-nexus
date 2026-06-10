# Team1 source public-readiness libero matrix

Parent: [#185](https://github.com/jinwon-int/a2a-plane/issues/185)
Child: [#186](https://github.com/jinwon-int/a2a-plane/issues/186)
Run: `a2a-team1-source-public-readiness-20260510T054829Z`
Broker of record: `seoseo`
Team: `team1`
Worker: `yukson`
Reviewed at: `2026-05-10T06:53:00Z`
Closeout refreshed at: `2026-05-10T06:53:00Z`

This is a redacted validation artifact only. It does not change repository visibility, import private source history, deploy, restart Gateway/broker/worker services, mutate production databases, send provider/Telegram messages, ACK terminal outbox rows, rotate or disclose secrets, rewrite history, or force-push.

## Evidence reviewed

- Team1 dispatch parent: [a2a-plane#185](https://github.com/jinwon-int/a2a-plane/issues/185).
- Libero lane: [a2a-plane#186](https://github.com/jinwon-int/a2a-plane/issues/186).
- Broker lane: [a2a-broker#469](https://github.com/jinwon-int/a2a-broker/issues/469); implementation PR [a2a-broker#470](https://github.com/jinwon-int/a2a-broker/pull/470).
- Plugin lane: [openclaw-plugin-a2a#251](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/251).
- Runner lane: [a2a-docker-runner#168](https://github.com/jinwon-int/a2a-docker-runner/issues/168); recurrence-prevention follow-up [a2a-docker-runner#169](https://github.com/jinwon-int/a2a-docker-runner/issues/169).
- Local public-readiness surfaces: `contracts/a2a/terminal-semantics.md`, `contracts/compatibility/terminal-evidence-ack-boundary.md`, `docs/readiness/fail-closed-scanner-readiness.md`, `docs/governance/public-private-boundary-gates.md`, `docs/public-readiness.md`, and `docs/promotion-validation.md`.
- GitHub metadata observed read-only during this review: `jinwon-int/a2a-plane` is public; `jinwon-int/a2a-broker`, `jinwon-int/openclaw-plugin-a2a`, and `jinwon-int/a2a-docker-runner` remain private source repositories.

## Integrated validation matrix

| Gate | Required public-ready condition | Current evidence | Libero decision |
| --- | --- | --- | --- |
| Broker source lane (`bangtong`) | Receipt vocabulary and queue hygiene must keep provider accepted-send and message IDs separate from requester-visible receipt, operator-visible receipt, human-seen proof, terminal ACK, and terminal-outbox ACK. | [a2a-broker#469](https://github.com/jinwon-int/a2a-broker/issues/469) posted Start and PR evidence; [a2a-broker#470](https://github.com/jinwon-int/a2a-broker/pull/470) is the linked patch and CI was green/mergeable at closeout review. | **Pass for round closeout once PR #470 is merged.** This is source/test evidence only and does not activate public readiness. |
| Plugin source lane (`sogyo`) | Install/compatibility docs and no-live Terminal Brief evidence must forbid direct Telegram/curl bypasses and label provider send success as accepted-send non-ACK only. | [openclaw-plugin-a2a#251](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/251) posted Start and Done evidence with scanner/test/preflight pass and no changes warranted. The broker task was marked failed by the no-change guard; RCA links it to runner follow-up [a2a-docker-runner#169](https://github.com/jinwon-int/a2a-docker-runner/issues/169). | **Pass as evidence-only / no-change lane.** Keep #169 open for recurrence prevention; do not treat the false-failure wording as plugin readiness failure. |
| Runner source lane (`nosuk`) | Docker runner sandbox, auth handling, cleanup, scanner/history, and artifact evidence must be public-safe and must not leak runtime context, private host paths, raw logs, or credentials. | [a2a-docker-runner#168](https://github.com/jinwon-int/a2a-docker-runner/issues/168) posted Start and Block-style no-change evidence. RCA showed the terminal failure was `no_changes_after_patch_command`, not a primary Docker image pull failure; recurrence-prevention issue [a2a-docker-runner#169](https://github.com/jinwon-int/a2a-docker-runner/issues/169) tracks evidence-only/no-change classification. | **Pass as evidence captured; follow-up open.** The round may close with #169 as tracked recurrence prevention, but source public-readiness remains NO-GO pending explicit approval. |
| Terminal evidence and replay safety | A2A Nexus must prove terminal evidence and replay/no-duplicate behavior without live sends or terminal-outbox ACK mutation. Provider message-id/send success is accepted-send evidence only. | Current contracts and fixtures encode the accepted-send non-ACK boundary, especially `contracts/a2a/terminal-semantics.md` and `contracts/compatibility/terminal-evidence-ack-boundary.md`; this Team1 round did not perform live sends or terminal ACK mutation. | **Baseline pass for no-live closeout.** This remains source/preflight evidence, not public activation. |
| Scanner/readiness | Public-readiness gates must fail closed on missing external scanner evidence, missing terminal/replay proof, runtime/bootstrap leakage, or missing approval separation. | `docs/readiness/fail-closed-scanner-readiness.md` and `docs/governance/public-private-boundary-gates.md` require fail-closed gates and separated operator approval. This validation branch adds a matrix/test only. | **Pass for wording and round evidence capture.** Do not promote local checks or issue comments into scanner/approval proof. |
| Source visibility boundary | A2A Nexus public visibility must not imply public release of private source repos or import of their raw histories. Source repositories remain private unless a separate explicit operator decision names that action. | Read-only GitHub metadata: `a2a-plane` public; `a2a-broker`, `openclaw-plugin-a2a`, and `a2a-docker-runner` private. No visibility action was performed in this lane. | **Pass for boundary; NO-GO for source-history/publication expansion.** Public A2A Nexus evidence must stay sanitized and link source lanes without copying private material. |
| Runtime/bootstrap hygiene | Branch diff, PR body, issue comments, and artifact evidence must exclude runtime/bootstrap context files and raw session dumps. | Branch-intended artifact is this validation note and its test. Runtime/bootstrap guard paths are not modified by this lane. | **Pass if final diff stays limited.** Fail closed if runtime/bootstrap paths enter the branch or evidence. |
| Explicit approval separation | Visibility/publication, deploy/restart, live provider/Telegram sends, production DB mutation, terminal ACK, secret changes, history rewrite, and force-push require explicit operator approval separate from any PR/test closeout. | Parent and child issues state the safety gates. No explicit operator approval for new live-impact or source-visibility action was observed or used. | **Pass for separation; NO-GO for live-impact action.** Tests, scanner success, provider IDs, and PR/Done/Block comments are not approval. |

## Merge and closeout order

1. Merge [a2a-broker#470](https://github.com/jinwon-int/a2a-broker/pull/470) after CI remains green. It closes [a2a-broker#469](https://github.com/jinwon-int/a2a-broker/issues/469).
2. Merge this A2A Nexus validation PR after local gates pass. It closes [a2a-plane#186](https://github.com/jinwon-int/a2a-plane/issues/186).
3. Close [openclaw-plugin-a2a#251](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/251) as Done/no-change evidence and [a2a-docker-runner#168](https://github.com/jinwon-int/a2a-docker-runner/issues/168) as RCA-linked Block/no-change evidence. Keep [a2a-docker-runner#169](https://github.com/jinwon-int/a2a-docker-runner/issues/169) open as recurrence-prevention follow-up.
4. If more than one A2A Nexus PR from the round exists, run the merge train locally before merging the first PR:

```bash
npm run round:merge-preflight -- <a2a-plane-pr> [<a2a-plane-pr> ...]
```

Use the stronger gate when public-readiness wording or tests change:

```bash
npm run round:merge-preflight -- --run "npm run check && npm run test:release-gate" <a2a-plane-pr> [<a2a-plane-pr> ...]
```

5. Post parent closeout on [a2a-plane#185](https://github.com/jinwon-int/a2a-plane/issues/185) with merged commits, issue closures, and the open #169 recurrence-prevention follow-up. If any sibling lane is missing, ambiguous, or unsafe, keep the aggregate decision **NO-GO / Waiting**.

## Current aggregate decision

**Round closeout OK; public-readiness still NO-GO.** Team1 source-public-readiness preflight evidence is captured, with #169 left open for recurrence prevention. The current safe state is:

- broker and libero lanes produced PR evidence; plugin and runner lanes produced no-change evidence/RCA;
- accepted-send evidence remains non-ACK and cannot prove read, visibility, requester receipt, operator receipt, human-seen proof, terminal ACK, or terminal-outbox ACK;
- scanner/readiness and runtime/bootstrap gates remain fail-closed;
- A2A Nexus being public does not publish or approve private source repository history;
- no new live-impact, source-visibility, terminal ACK, production mutation, history rewrite, or force-push action is authorized without separate explicit operator approval.

## Safety confirmation

This validation used repository inspection and redacted GitHub issue/repository metadata only. It did not perform production deploys, Gateway/broker/worker restarts, live provider or Telegram sends, production database mutations, terminal-outbox ACKs, secret rotations/disclosures, repository visibility changes, source-history imports, release publication, history rewrites, force pushes, raw secret disclosure, host-private path disclosure, or raw session dump publication.
