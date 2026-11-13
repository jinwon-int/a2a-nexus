# Design: Cross-Broker Spend Aggregation for Budgets

> **Issue:** [#2516](https://github.com/jinwon-int/a2a-nexus/issues/2516) (follow-up of [#2499](https://github.com/jinwon-int/a2a-nexus/issues/2499))
> **Phase:** Spec-first. This document changes no code, schema, setting or runtime behaviour, and grants no approval.
> **Status:** Draft — awaiting owner ratification of the [decisions](#decisions-for-owner-ratification). Nothing in "Recommended design" exists yet.
> **Related:** [`spec.md`](spec.md) (decisions 9, 10, 11, 13, 15, 19), [`plan.md`](plan.md) ("Scope of a budget"), [`signed-usage-telemetry.md`](signed-usage-telemetry.md), [`docs/specs/cross-broker-parent-round/spec.md`](../cross-broker-parent-round/spec.md)

Code references are to `main` at `dc2fd4b2`; paths without a package are under `packages/broker/src/`. "Spec decision N" means a numbered decision in [`spec.md`](spec.md).

## Problem

Budgets and spend are per broker ([`plan.md`](plan.md), "Scope of a budget"). The Team 1 broker and the Team 2 broker each keep their own `broker_spend_events` and `broker_budgets`.

Every consumer of a budget goes through one function, `evaluateBudget` (`core/broker.ts:2128-2132`). It reads one scope's spend from the local ledger (`readSpendScopeUsage`, `core/store/store.ts:1482-1498`) and applies `evaluateBudgetUsage` (`core/dispatch/broker-task-admission.ts:513-537`). Its callers:

| Consumer | Location |
|---|---|
| Claim refusal (spec decision 15) | `core/broker.ts:2258-2287`, called from `claimTask` at `:5088` |
| Queued-listing filter | `core/broker.ts:2369-2389` |
| `pause` at create | `core/broker.ts:2427-2461` |
| Goal `budget_limited` sweep | `core/broker.ts:2514` |
| Alerts (spec decision 19) | `core/broker.ts:2929`, evaluation at `:2974`; projection `core/observability/alert-projection.ts:357-400` |
| `GET /budgets/status` | `http/goal-routes.ts:473-591`, per-budget evaluation at `:577` |

None of them sees the other broker. A lane or goal that runs on both brokers, with the same budget on each, can spend the limit twice, and neither status nor alerts show the total.

Two facts that shape the design:

- The claim path is not free of store reads today: it does one indexed aggregate per budget of the task's scopes and at most one cost probe (`core/broker.ts:2174-2215`). This design reads the issue's requirement as: **remote spend adds no store read and no network call to the claim path.**
- The broker server never calls its peer. Cross-broker traffic is carried by a separate relay process (`packages/broker/scripts/cross-broker-terminal-brief-receiver.mjs`, which is the only caller of `pollCrossBrokerTerminalBriefReceiver`, `core/completion/cross-broker-terminal-brief-receiver.ts:219`).

### Existing mechanisms this design reuses

| Mechanism | Location |
|---|---|
| Per-scope period totals (one period aggregate plus one grouped aggregate per scope type) | `readSpendTotals`, `core/store/store.ts:1426-1474` |
| Ledger coverage (`firstPeriod`, time zone, missing rows) | `core/types.ts:277-291`, shown in status at `http/goal-routes.ts:546-552` |
| Broker signing key (agent cards, result-provenance countersignature) | `server.ts:984-985` (`AGENT_CARD_SIGNING_KEY_FILE`) |
| Pinned peer public keys (`{ "<brokerId>": "<SPKI PEM>" }`) and their loader | `a2a/cross-broker-sender-proof.ts:32-52` |
| JWS plumbing, freshness window (±5 min), `off / record / enforce` staging, `/health` counters | `a2a/cross-broker-sender-proof.ts:72-123, 167, 277-302`; `server.ts:2006` |
| Minimum-scope peer credentials (closed scope vocabulary with additive token sets) | `core/transport/request-security.ts:1279-1309`; used at `http/a2a-terminal-outbox-routes.ts:65-80` |
| Relay process with one instance per direction, file-based secrets | [`examples/deploy/cross-broker-terminal-brief-receiver/`](../../../examples/deploy/cross-broker-terminal-brief-receiver/README.md) |

## Options

| Option | What it needs | Trust model | When the peer is unreachable | Cost |
|---|---|---|---|---|
| **A. Pull by the broker** — each broker calls the peer's `GET /budgets/status` | An outbound HTTP client, peer URL and peer credential inside the broker process (none today); a timer; a cache anyway, to stay off the claim path | Transport only (edge secret, peer credential), unless responses are also signed | Timeouts and retries inside the broker process; falls back to the cache | High: a new outbound surface in broker core |
| **B. Signed periodic summaries, relayed** (recommended) | One read route on the source, one ingest route on the destination, an in-memory cache, a second job in the existing relay | The source broker signs the summary with its own key; the destination verifies against a pinned key. The relay is untrusted transport | The last verified summary of the same period is kept and flagged stale; with none, evaluation is local-only, as today | Medium: reuses the relay, peer credentials and key pinning |
| **C. External aggregator** — a service reads both ledgers and serves totals | A new service with read access to both brokers, its own storage, key, deploy and monitoring; both brokers consume its output | A new trust root that both brokers must trust | A single point of failure for the combined view; brokers fall back to local-only | Highest: a new component to run and secure |

## Recommended design

Option B. Each broker periodically publishes a signed summary of its own spend for the current period. A relay carries it to the peer. The peer verifies it, keeps the newest one in memory, and adds the remote spend to its own when it evaluates a budget.

### 1. What is aggregated

- **Unit:** the period total of one scope: `(scope_type, scope_id, period_key)`, exactly what `readSpendTotals` returns. Rows are never sent.
- **Matching:** string equality of scope type and scope id. A lane is the task `intent`; an agent is the worker id; a goal counts on both brokers only if the same goal id exists on both. Goals are not synchronised between brokers, so an operator creates the goal on each.
- **Limits are not aggregated.** Each broker compares *its own* `broker_budgets` row with local plus remote spend. A fleet-wide limit is the same budget created on both brokers.
- **Period:** a summary covers the source's current period. The destination uses it only for the same `period_key`.
- **Time zone (spec decision 11):** the summary carries the source's zone. The destination uses a summary only when that zone equals its own; otherwise the peer state is `zone_mismatch` and evaluation stays local. Changing `A2A_BUDGET_PERIOD_TIME_ZONE` becomes a change made on both brokers at the same month boundary.
- **Assumption to pin with a test:** one unit of work has a spend row on exactly one broker. Task ids and the ledger primary key are per broker, and a cross-broker handoff creates the child task only on the receiving broker; the parent broker stores a projection, not a task.

### 2. Summary shape

```jsonc
{
  "schemaVersion": "a2a.budget.peer-spend-summary.v1",
  "canonicalization": "rfc8785-jcs-v1",
  "senderBrokerId": "<source broker id>",
  "audienceBrokerId": "<destination broker id>",
  "periodKey": "2026-11",
  "timeZone": "Asia/Seoul",
  "generatedAt": "2026-11-13T09:00:00.000Z",
  "ledger": { "firstPeriod": "2026-11", "periodComplete": false, "missingSpendRows": 0 },
  "periodTotal": { "usdKnown": 12.5, "inputTokens": "1200000", "outputTokens": "300000",
                   "taskCount": 40, "costUnknownTaskCount": 6, "unmeteredTaskCount": 1 },
  "scopes": [ { "scopeType": "lane", "scopeId": "analyze", "usdKnown": 9.1, "inputTokens": "900000",
                "outputTokens": "210000", "taskCount": 31, "costUnknownTaskCount": 4, "unmeteredTaskCount": 1 } ],
  "truncated": { "agent": false, "lane": false, "goal": false },
  "signature": { "protected": "<base64url header>", "signature": "<base64url>" }
}
```

- Token totals are always decimal strings, so they stay exact past 2^53.
- **Signature:** a JWS (EdDSA or ES256) over the JCS form of the summary without `signature`, made by the source broker process with its broker signing key. A broker without a signing key answers the summary route with 409 `unsupported_operation`.
- **Bounds:** at most 500 scopes per scope type, ordered by scope id (the existing `readSpendTotals` query with `limit: 500`); `truncated.<type>` is true when there are more. The body is at most 256 KiB.
- **Cost on the source:** the same reads as one status call. The source caches the built summary for 30 seconds, so a relay cannot make it aggregate more than twice a minute.

### 3. Transport

- **Source:** `GET /budgets/peer-summary?audience=<brokerId>` returns the signed summary. Peer scope `budget:spend-read`.
- **Destination:** `POST /a2a/cross-broker/spend-summaries` takes the signed summary. Peer scope `budget:spend-write`.
- The two scopes are a new additive token set next to the handoff and conversation sets (`core/transport/request-security.ts:1279-1309`); the handoff v0 scopes are not changed. Peer-scope mode `auto` and `enforce` behave as on the existing cross-broker routes.
- **Relay:** a second, default-off job in the existing relay script (the script budget is full, so no new script), one direction per instance, interval 60 seconds. It holds no signing key for this job and cannot alter a summary without breaking the signature.

### 4. Ingest and verification

The destination runs this ladder. Each rejection is counted by reason and changes nothing.

1. Mode `off`: 409 `unsupported_operation`.
2. Shape and bounds: schema version, canonicalization, required fields, body size, array sizes, scope ids valid for their type, numbers finite and non-negative, token strings of at most 19 digits. Per scope, `usdKnown` ≤ 1e6 × `taskCount` and each token total ≤ 1e12 × `taskCount` (the per-task caps of spec decision 12 times the row count). Else `malformed`.
3. `senderBrokerId` is pinned and is not this broker; `audienceBrokerId` is this broker. Else `unpinned` or `wrong_audience`.
4. The signature verifies against the pinned key. Else `invalid_signature`.
5. `generatedAt` is within ±5 minutes of the local clock. Else `outside_freshness`.
6. `generatedAt` is newer than the summary already held for that sender. Equal is an idempotent replay (200); older is `stale_replay` (409).
7. Accept: replace the in-memory entry for that sender (202).

Pinned keys use the existing file format and loader, under a new setting `A2A_BUDGET_PEER_SPEND_KEYS_FILE`. It may point at the sender-proof anchors file only if the peer's sender-proof key is its broker signing key; the repository cannot tell (see Open questions).

### 5. Storage

Memory only: one accepted summary per pinned peer, indexed by `(scope_type, scope_id)`. No table, no column, no `schema_version` change; the ledger is untouched. After a restart the entry is empty until the next relay push (at most one interval), and evaluation is local-only in between.

### 6. Consumption

- **One change point.** `evaluateBudget` adds the remote usage of `(budget.scopeType, budget.scopeId)` to the local usage before `evaluateBudgetUsage`, when the summary's `period_key` is the evaluated period and the zones match. It has two views: *enforcement* (claim, listing filter, `pause`, goal limits) includes remote spend only in mode `on`; *visibility* (alerts, status) includes it in `shadow` and `on`. All six consumers in the Problem table follow.
- **Claim path (spec decision 15).** The remote part is a map lookup: no store read, no network call. The cost-reporting probe becomes "a local `cost_known` row (`hasCostReportingSpend`) **or** a remote agent entry for that worker with `taskCount − costUnknownTaskCount > 0`", also from memory. The refusal shape (`policy_denied`, `budget_exhausted`, `details.scopes`) does not change.
- **Status.** `GET /budgets/status` gains `peers[]` (`brokerId`, `state` = `fresh | stale | missing | period_mismatch | zone_mismatch`, `periodKey`, `generatedAt`, `receivedAt`, `ageSeconds`, `timeZone`, `ledger`, `truncated`) and `peerSpend` counters (`accepted`, `rejected` by reason). Existing fields keep their local meaning. Each scope entry gains `remote` (the same six totals, or null) and `combined`. Each `budgets[]` entry gains `local`, `remote` and `combined` usage, and the existing `usdSpent`, `tokensSpent`, `usdExhausted`, `tokensExhausted` and `warn` report the enforcement view.
- **Alerts (spec decision 19).** `budget_warn` and `budget_exhausted` use combined spend in peer mode `shadow` and `on`; the metadata adds `usdSpentLocal`, `usdSpentRemote`, the token equivalents and `peerState`. A new warning alert `budget_peer_stale` (subject kind `budget`, id `peer:<brokerId>`) opens while a peer in mode `shadow` or `on` has no usable summary for longer than the maximum age.
- **Re-snapshot.** The claim check reads the map on every call, so an accepted summary takes effect at once. Alerts and the SSE re-snapshot follow at the next sweep through the existing budget revision (`core/broker.ts:2982`).

### 7. Behaviour when the peer or the signature is missing (spec decision 13)

| Condition | Enforcement uses | Shown as |
|---|---|---|
| Mode `off` | Local only (today's behaviour) | No `peers` |
| No summary yet, or after a restart | Local only | `state: "missing"` |
| Summary older than the maximum age, same period | The last verified summary, as a lower bound | `state: "stale"`, `budget_peer_stale` |
| Summary for another period (month rolled) | Local only | `state: "period_mismatch"` |
| Zone differs | Local only | `state: "zone_mismatch"` |
| Signature, key, audience, shape or freshness rejected | The previously accepted summary; the rejected one is never used | `peerSpend.rejected.<reason>` |
| Scope missing from a truncated scope type | Local only for that scope | `remote: null`, `truncated` |

A claim is never refused because the peer is unreachable, and nothing fails closed. A stale summary can only under-count, because spend within a period only grows; the exception is a row excluded on the peer after the summary was made (see [`signed-usage-telemetry.md`](signed-usage-telemetry.md)), which over-counts until the next summary.

Accepted overshoot (extends spec decision 10): up to one relay interval of peer spend, plus the tasks already claimed on either broker.

### 8. Settings and placement

- `A2A_BUDGET_PEER_SPEND_MODE` = `off | shadow | on`, default `off`, read at startup. `shadow`: serve and ingest summaries, show them in status and alerts, enforce local-only. `on`: enforcement uses combined spend. A mode other than `off` without a broker id, a signing key or the keys file refuses startup.
- `A2A_BUDGET_PEER_SPEND_KEYS_FILE`, `A2A_BUDGET_PEER_SPEND_MAX_AGE_SEC` (default 600).
- No new core file and no new script (`node scripts/check-script-budget.mjs` reports both budgets full): pure functions go into `core/dispatch/broker-task-admission.ts`, signing and verification into `a2a/cross-broker-sender-proof.ts`, the routes into `http/goal-routes.ts` and `http/a2a-terminal-outbox-routes.ts`.

## Decisions for owner ratification

Numbered within this document. Each has a recommendation and the alternative.

1. **Where the total lives.** Recommended: signed periodic summaries carried by the relay (option B). Alternative: broker pull (A) or an external aggregator (C).
2. **Who signs.** Recommended: the source broker process, with its broker signing key, so the relay is untrusted. Alternative: only the relay's request-bound sender proof, as for Terminal Briefs; simpler, but the relay host then vouches for the numbers.
3. **Limits.** Recommended: each broker compares combined spend with its own budget row; operators create the same budget on both. Alternative: replicate budget rows between brokers, or split one limit into per-broker shares.
4. **Storage.** Recommended: memory only, so there is no schema change and rollback is a setting. Alternative: persist the last accepted summary (a `broker_metadata` value or a new table), which removes the post-restart gap and adds a store write path.
5. **Stale summaries.** Recommended: keep using the last verified summary of the same period as a lower bound, flagged. Alternative: drop to local-only after the maximum age, which re-opens claims that the combined total had refused.
6. **Peer's first period (spec decision 9).** Recommended: use the remote spend even when the peer reports `periodComplete: false`, and show the flag. Alternative: treat combined enforcement as `shadow` until both ledgers cover the period.
7. **Alerts.** Recommended: combined spend in `shadow` and `on`, plus the `budget_peer_stale` warning. Alternative: no new alert kind, peer state in status only (as spec decision 19 does for `checkFailed`).
8. **Cost-reporting probe (spec decision 15).** Recommended: local or remote. Alternative: local only, which lets a worker that reported cost only on the peer pass a USD-exhausted scope once.
9. **Summary contents.** Recommended: every scope with spend, up to 500 per type. Alternative: a destination-driven scope list, so only budgeted scopes are disclosed, at the price of one more call per cycle.
10. **Bounds.** Recommended: interval 60 s, maximum age 600 s, freshness ±5 min, 500 scopes per type, 256 KiB. Alternative: other values.
11. **Approval gates.** Recommended: the list under Rollout. Alternative: fewer or more gates.

## Rollout order

Source PRs, in order. Each is source-only, default-off, reviewed by an A2A lane that did not author it, and merged on the owner's approval.

1. Summary builder, signature, verifier, merge function, fixtures.
2. Source and ingest routes, the two peer scopes, the in-memory peer state, the mode setting, status fields.
3. Evaluator consumption, alerts, the cost-reporting probe.
4. Relay job, deploy example, runbook section.

Operator steps. Every step marked **[approval]** needs its own owner approval, per broker; a step on the other team's broker is a cross-broker change.

1. **[approval]** Deploy the build to the Team 1 broker, mode `off` (broker restart). Then the same on the Team 2 broker.
2. **[approval]** Provision peer credentials with the two new scopes on each broker (credential registry change, secret handling, restart to load).
3. **[approval]** Provision the pinned public keys on each broker and set mode `shadow` (restart).
4. **[approval]** Enable the relay spend job in each direction (relay configuration change and relay restart).
5. Shadow observation. When it is approved, its start and end are recorded on the issue as absolute times, with the checks: every peer `state` is `fresh`, rejected counters stay at zero, and `combined` equals the sum of both brokers' status output.
6. **[approval]** Set mode `on` (restart). This changes claim decisions. Switch both brokers in the same window; with one side `on`, only that side enforces the combined total.

There is no schema migration in this design. Rollback is mode `off` and a restart (exactly today's behaviour), then disabling the relay job; reverting the PRs is code-only.

## Test plan

Unit and fixture tests only; no live broker, no network.

- **Summary:** built from fixture spend rows; token strings exact past 2^53; ordering, the 500 cap and `truncated`; KST month boundary; a second build inside the cache window does no store read.
- **Signature:** round trip for EdDSA and ES256; every signed field tampered; wrong key; unpinned sender; wrong audience; own broker id as sender.
- **Ingest ladder:** one test per rejection reason; replay idempotency; `stale_replay`; oversize body; per-scope plausibility bound; a rejected summary leaves the accepted one in place.
- **Evaluation:** local plus remote for USD and tokens; modes `off`, `shadow`, `on`; period mismatch; zone mismatch; stale; missing; truncated scope; two peers.
- **Claim path:** a store spy proves the read count per claim is unchanged from today; refusal on combined spend; the cost-reporting probe with a remote-only cost row; fail-open when the peer state is missing.
- **All consumers agree:** listing filter, `pause` at create, goal limit and resume, alerts and status give the same answer for one fixture.
- **Alerts:** combined open and resolve; `budget_peer_stale` opens once and resolves; no duplicate within a period.
- **Disjointness:** a handoff fixture produces a spend row on exactly one broker.
- **Relay job:** fake fetch; default off; a failed source or destination call changes no cursor of the brief job.
- **Guards:** `node scripts/check-script-budget.mjs` and `node scripts/check-broker-core-dependency-isolation.mjs` stay green.

## Open questions

- Whether both fleet brokers have a broker signing key configured, and whether the deployed sender-proof key is that same key. Both are deployment facts; they decide whether one anchors file can serve both purposes.
- Whether any worker id claims tasks on both brokers. If none does, agent scopes never have remote spend and only lane and goal scopes matter.

## Out of scope

- Deploying any of this; changing `broker_spend_events` or `broker_budgets`.
- Synchronising budgets or goals between brokers.
- Accuracy below one relay interval, and a combined view of past periods.
- Provider-side cost reconciliation, pricing, and dashboards.
- More than the pinned peers of one fleet; the design allows several peers, but only two brokers are in scope for tests and rollout.
