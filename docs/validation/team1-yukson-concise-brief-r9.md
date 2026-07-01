# Team1/yukson: concise Terminal Brief contract/runbook gate (R9)

Issue: a2a-plane#289 (a2a-plane#289, internal tracker private)
Parent: [a2a-broker#560](https://github.com/jinwon-int/a2a-broker/issues/560)
Run: `a2a-r9-concise-brief-runtime-20260513T134143Z`
Contract: `contracts/a2a/parent-terminal-brief-aggregation.md`
Lane: Team1/yukson
Snapshot: `2026-05-13T13:41:43Z`

This runbook gate validates that future all-hands/cross-broker rounds require:

1. Parent aggregation metadata (`parentRoundId`, `originBrokerId`, `parentBrokerId`, `handoffBrokerId` where applicable) in every child dispatch.
2. Concise parent-round Terminal Brief titles — known-total format `A2A Terminal Brief <상태>: <worker>(<completed>/<total>)` or unknown-total fallback `A2A Terminal Brief <상태>: <worker>(<completed>)`.
3. Body/evidence separation — the aggregate title is a separate field from the terminal evidence body.
4. Parent-only notification ownership — only the parent broker renders the aggregate title; child/handoff brokers must not.
5. No-live proof and approval-gated activation plan — documented but not executed.

This is a read-only validation/runbook gate. It does not deploy or restart services, mutate production databases, mutate terminal-outbox ACK rows, send provider messages, change secrets, publish releases, rewrite history, force-push, or change repository visibility.

---

## Gate A — Parent aggregation metadata in child dispatch

Future all-hands/cross-broker rounds must carry the following metadata in every child task dispatch:

| Field | Required? | Source | Example |
| --- | --- | --- | --- |
| `parentRoundId` | Required | Minted by the origin/parent broker before first child handoff. | `round-gwakga-origin-seoseo-handoff-canary-001` |
| `originBrokerId` | Required | Broker that created the parent round; immutable after minting. | `gwakga` |
| `parentBrokerId` | Required | Broker rendering the aggregate Terminal Brief notification; must equal `originBrokerId` in v0. | `gwakga` |
| `handoffBrokerId` | Required when child is a handoff | Broker that received the child handoff. | `seoseo` |
| `childBrokerId` | Required | Broker of record for child task after handoff. | `seoseo` |
| `brokerOfRecord` | Required | Same as `childBrokerId`; identifies the broker controlling the child lifecycle. | `seoseo` |
| `knownTotal` | Recommended | Total number of child tasks in the parent round, when known. May be omitted if unknown. | `7` |
| `dispatcherId` | Recommended | Identifier for the dispatch origin — e.g. `a2a-r9-concise-brief-runtime`. | `a2a-r9-concise-brief-runtime-20260513T134143Z` |

**Fail-closed condition:** A round dispatch without `parentRoundId` or `originBrokerId` must be rejected at the broker dispatch gate. A handoff child without `handoffBrokerId` must be rejected. Missing `childBrokerId` or `brokerOfRecord` at task creation time must be rejected.

**Evidence requirement:** Check that the parent-terminal-brief-aggregation contract lists these fields and that the fixture proves the metadata lifecycle.

---

## Gate B — Concise parent-round title format

Every aggregate Terminal Brief notification title must follow one of these formats:

| Total known | Format | Max chars | Example |
| --- | --- | --- | --- |
| Yes | `A2A Terminal Brief <상태>: <worker>(<completed>/<total>)` | 80 | `A2A Terminal Brief 완료: dungae(1/7)` |
| No | `A2A Terminal Brief <상태>: <worker>(<completed>)` | 80 | `A2A Terminal Brief 완료: yukson(2)` |

**Status labels:** `완료` (success/complete), `실패` (failure), `차단` (block), `PR` (pull request pending).

**Fail-closed conditions:**

- Title exceeds 80 characters → rejected.
- Title contains task ids, child issue URLs, terminal evidence URLs, terminal summary text, child broker IDs, handoff broker IDs, provider message IDs, receipt status, ACK status, or runtime/bootstrap file names → rejected.
- Title renders an unknown total with a denominator placeholder (e.g. `(2/?)`) → rejected. When total is unknown, render only the completed count.
- Title is missing entirely or falls back to a raw evidence dump → rejected.
- Status label is missing, uses an unrecognized value, or uses English when Korean is available for the status labels listed above → soft warning (not fail-closed but must be documented).

**Evidence requirement:** The contract's Concise title semantics section and the fixture's `terminalBriefTitlePolicy` block must document the exact format with examples for both known-total and unknown-total cases.

---

## Gate C — Body/evidence separation

The aggregate Terminal Brief notification must split title and body/evidence into separate fields. The title and body must not be concatenated into a single text block.

**Fail-closed conditions:**

- Title contains terminal summary text, evidence URLs, child broker IDs, handoff broker IDs, provider message IDs, receipt/ACK status, or runtime/bootstrap file names → rejected.
- Body/evidence contains the `terminalBriefTitle` field or re-renders the round title as an evidence header → rejected.
- A body-only notification with a blank or missing title is present → rejected.
- The notification adapter or transport schema does not carry the title as a first-class metadata field → rejected.

**Evidence requirement:** The contract must have a Body/evidence separation section (added in the R9 update) and the fixture must prove that title and body are separate, non-overlapping fields.

---

## Gate D — Parent-only notification ownership

Only the broker matching `originBrokerId` (and `parentBrokerId` in v0) may render, dispatch, update, or retract the aggregate Terminal Brief notification for a parent round.

**Fail-closed conditions:**

- A child or handoff broker dispatches its own parent-round aggregate notification → rejected.
- A child broker modifies or overwrites the `terminalBriefTitle` field on a parent projection → rejected.
- Replay or re-projection changes `parentBrokerId` or title ownership → rejected.
- A broker other than `originBrokerId` assumes parent notification ownership (even during recovery) without a contract version change → rejected.

**Evidence requirement:** The contract must document parent-only notification ownership rules. The fixture's `terminalBriefTitleOwnerBrokerId` and `terminalBriefTitleRenderedByParentBrokerOnly` flags must be set correctly.

---

## Gate E — No-live proof and approval-gated activation

This runbook gate does not execute live activation. It documents the approval-gated steps required for future activation.

### E.1 Pre-activation read-only verification

The following may be verified in read-only mode without operator approval:

- E.1a: Concise title renderer code is deployed to the Gateway plugin or broker runtime. Evidence: test output showing the 7-child fixture renders correct known-total and unknown-total titles.
- E.1b: Body/evidence separation exists in the notification adapter schema. Evidence: adapter schema snapshot or test showing title is a separate wire field.
- E.1c: Parent-only notification ownership is enforced by the contract and runtime. Evidence: code or contract showing `parentBrokerId` must equal `originBrokerId` for notification dispatch.

### E.2 Staging activation (requires operator approval)

- E.2a: Enable the concise title renderer in a staging environment (isolated, non-production provider target).
- E.2b: Dispatch a synthetic 7-child parent round aggregate notification to the staging target.
- E.2c: Verify all 7 titles render with correct known-total format for direct children and cross-broker projected children.
- E.2d: Verify the unknown-total fallback renders correctly without denominator placeholder.

### E.3 Post-activation verification

- E.3a: Verify no live provider send occurred outside the approved staging target.
- E.3b: Verify terminal-outbox ACK column is unchanged.
- E.3c: Verify no production database mutation occurred.
- E.3d: Verify staging environment restored to no-live defaults.

### E.4 Production activation (requires separate operator approval)

- E.4a: Separate operator approval naming the exact production round, scope, and provider target.
- E.4b: All pre-activation, staging, and post-activation evidence linked.
- E.4c: Rollback/restoration evidence from staging activation.
- E.4d: Explicit GO approval for production activation.

**Decision:** `NO-GO / Waiting` for any live activation. This runbook gate documents the path but does not authorize production deploy, restart, provider send, terminal-outbox ACK, DB mutation, or any other live action.

---

## Gate F — 7-child parent round fixture

The R9 concise-brief runtime readiness round proves:

1. **Direct Team1 children** (3 tasks, known total):
   - `A2A Terminal Brief 완료: yukson(1/3)`
   - `A2A Terminal Brief 완료: bangtong(2/3)`
   - `A2A Terminal Brief 완료: sogyo(3/3)`

2. **Cross-broker Team2 projected children** (4 handoff tasks, known total):
   - `A2A Terminal Brief 완료: dungae(1/4)`
   - `A2A Terminal Brief 완료: gwakga(2/4)`
   - `A2A Terminal Brief 완료: jingun(3/4)`
   - `A2A Terminal Brief 완료: soonwook(4/4)`

3. **Unknown-total fallback**:
   - `A2A Terminal Brief 완료: yukson(2)` (no denominator, no `(2/?)`)

**Fail-closed conditions:**

- Any of the 7+1 titles does not match the expected format → rejected.
- Unknown-total fallback contains a denominator like `(2/?)` → rejected.
- Any title contains forbidden content (task id, broker id, evidence URL, etc.) → rejected.
- Any title exceeds 80 characters → rejected.

**Evidence requirement:** The fixture or test must prove all 8 title examples render correctly.

---

## Gate G — Runtime/bootstrap and artifact hygiene

Before publishing PR, Done, or Block evidence from this lane, fail closed if any OpenClaw runtime/bootstrap context file would enter the branch diff, PR body, issue comments, or artifact bundle. Report the exact repo-relative offending paths, including:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Evidence must be bounded summaries only. It must not include secrets, provider targets, chat IDs, raw session dumps, private host paths, or unredacted logs.

---

## Safety confirmations

This runbook gate:

- Did not deploy or restart any service.
- Did not mutate production databases or terminal-outbox ACK rows.
- Did not send any provider or Telegram message.
- Did not change secrets, repository visibility, or releases.
- Did not rewrite history or force-push.
- Did not execute any activation step listed in Gate E.
- Used redacted repository evidence only (contracts, fixtures, tests).

## Local validation commands

```bash
npm run check:layout
npm run check:team1-yukson-plane-gates
node --test scripts/archive/check-team1-yukson-concise-brief-r9.test.mjs
git status --short --ignored
```
