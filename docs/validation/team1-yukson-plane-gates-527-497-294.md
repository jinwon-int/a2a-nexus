# Team1/yukson plane gates for read-only validation and stability hardening

## R7 context

Stability R7 dispatch: [a2a-broker#548](https://github.com/jinwon-int/a2a-broker/issues/548)
This lane: a2a-plane#281 (a2a-plane#281, internal tracker private)
Run: `a2a-stability-r7-20260513T101831Z`

R7 target outcomes: lower broker CPU/OOM risk, formal read-only/libero task semantics, canary/receipt gates, PR-less evidence lanes, and Terminal Brief deployment-readiness evidence. No production activation.

### R7 validation summary

This lane revalidates the existing #527/#497/#294 gates against the R7 stability baseline and adds a deployment-readiness approval boundary for Terminal Brief activation. All prior gate content remains in effect; the R7 addendum formalizes the closeout criteria that would change the aggregate decision from `NO-GO / Waiting` to operator-reviewable.

| R7 outcome | Existing coverage | Verdict | R7 change required |
| --- | --- | --- | --- |
| Lower broker CPU/OOM risk | `docs/validation/team1-yukson-plane-gates-527-497-294.md` Gate B (`#497`) | **Covered** — broker stability, hot-table, heap/RSS gates documented; broker-side implementation remains separate. | None; plane gate matrix is spec. Broker #497 implementation is a broker repo lane. |
| Formal read-only/libero task semantics | Gate A (`#527`): intent=verify/analyze, read-only modes, Start+Done/Block evidence, no-diff acceptance | **Covered** — regression fixture `a2a-plane#240` blocks patch-lane false Done. | None; plane gate matrix is stable. |
| Canary/receipt gates | Gate C (`#294`): receipt vocabulary, canary no-live matrix, non-ACK evidence | **Covered** — `packages/broker/src/core/receipt-gate-canary.ts` provides pure no-live matrix. | None; canary/receipt semantics frozen at v0. |
| PR-less evidence lanes | Gate A: read-only validation/libero lanes accepted without diff; patch lanes still fail closed | **Covered** — Start plus Done/Block without PR for read-only tasks. | None; no-diff guard for patch lanes preserved. |
| Terminal Brief deployment-readiness evidence | Gate D below (R7 addendum) | **Gap filled** — deployment-readiness approval boundary matrix defined below. | This R7 document adds the deployment-readiness gate. |

### R7 risk matrix: deployment-readiness activation

Terminal Brief deployment-readiness is the R7-specific contribution to the existing gate packet. The following risk matrix identifies the key failure modes and operator-safe guards before any live Terminal Brief activation:

| Risk | Failure mode | Existing guard | Residual risk | Gate reference |
| --- | --- | --- | --- | --- |
| Provider acceptance treated as ACK | Broker or plugin promotes `providerAccepted` / `messageId` to terminal-outbox ACK. | `contracts/a2a/terminal-semantics.md` frozen v0 ACK boundary; `check-message-id-ack-boundary.mjs` scan; `terminal-brief-routing-contract.ts` enforces receipt levels. | Low — multiple static guards exist. | Gate D.1 |
| Gateway outbound success mutated as receipt | Gateway outbound adapter reports `sent` and broker records terminal ACK. | `operator-notification-adapter.ts` requires `current_session_visible` or `manual_operator_receipt`; `check-terminal-brief-routing.mjs` blocks direct Telegram/curl paths. | Low — adapter fail-closed without ACK-safe receipt. | Gate D.2 |
| Canary send without operator approval | An automated lane trigger sends a live provider notification before approval. | `receipt-gate-canary.ts` is pure no-live; `terminal-brief-activation-libero.md` requires one-shot allowlist + explicit approval. | Medium — requires operator discipline to not bypass the allowlist gate. | Gate D.3 |
| Duplicate/replayed Terminal Brief events | Broker replay or reprocess sends duplicate outbox rows as fresh notifications. | `parent-terminal-brief-aggregation.md` projection idempotency; `github-evidence-projection.md` evidence key dedup; `two-broker-safety-matrix.ts` idempotency guards. | Low — idempotency keys and replay suppression are contract-level. | Gate D.4 |
| Terminal Brief payload leaks secrets | Evidence summary includes provider targets, chat IDs, or raw session data. | `terminal-semantics.md` redaction rules; `parent-terminal-brief-aggregation.md` redaction boundary; `runtime/bootstrap hygiene gate` blocks AGENTS.md etc. | Low — bounded summaries enforced. | Gate D.5 |
| Rollback evidence missing | Post-canary state not restored, making relive easier next time. | `terminal-brief-activation-libero.md` gate G8 requires rollback/restoration evidence and no-live default restoration. | Medium — rollback is a documented post-step; operator must execute it. | Gate D.6 |

### Gate D — Terminal Brief deployment-readiness approval boundary (R7 addendum)

Before any live Terminal Brief canary or activation, the following deployment-readiness sub-gates must all be satisfied. These gates do not authorize production deploy, restart, mutation, or ACK — they are preconditions for an operator to consider a one-shot, no-live-restored canary.

| Sub-gate | Required evidence | Fail-closed condition |
| --- | --- | --- |
| D.1 Provider ACK boundary enforced | Frozen contracts and scan prove provider send success is not terminal ACK. | A contract change or code path promotes `providerAccepted` or `messageId` to ACK. |
| D.2 Gateway/plugin no-bypass | Operator notification adapter requires `current_session_visible` or `manual_operator_receipt` before ACK. | Adapter accepts `send success` or `providerAccepted` as receipt confirmation. |
| D.3 One-shot allowlist with explicit operator approval | The live canary is disabled by default, requires an explicit allowlist entry, and is tied to a fresh task/outbox id. Operator approval comment names the exact canary scope. | No allowlist guard; approval covers multiple actions; canary uses a stale or replayed task id. |
| D.4 Replay/idempotency protection | Evidence key deduplication, projection key idempotency, and two-broker safety guards prevent duplicate notifications. | Same evidence key produces multiple comments or outbox ACK mutations. |
| D.5 Redacted bounded evidence | Terminal Brief summaries are bounded, contain no secrets, target IDs, chat IDs, raw logs, or OpenClaw runtime/bootstrap files. | Summary contains `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `USER.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`, or raw session data. |
| D.6 Rollback/restoration evidence | Post-canary evidence proves no-live defaults were restored (notification disabled, allowlist removed, test container stopped). | No restoration step recorded; default remains allowlisted. |

**Terminal Brief live activation decision: `NO-GO / Waiting`.** The deployment-readiness approval boundary and sub-gates are defined and locally validated. Live activation remains blocked until an operator explicitly approves a one-shot canary, all six sub-gates are proven in that exact run, and post-run restoration evidence is captured.

---

## Base gate packet (pre-R7)

Parent: [a2a-broker#539](https://github.com/jinwon-int/a2a-broker/issues/539)
Plane lane: a2a-plane#275 (a2a-plane#275, internal tracker private)
Trackers: [a2a-broker#527](https://github.com/jinwon-int/a2a-broker/issues/527), [a2a-broker#497](https://github.com/jinwon-int/a2a-broker/issues/497), [a2a-broker#294](https://github.com/jinwon-int/a2a-broker/issues/294)
Snapshot: `2026-05-13T10:30Z`

This is a no-live Plane gate packet. It defines the safe evidence shape for GitHub read-only validation/libero lanes and the closeout gates for broker stability hardening. It does not deploy or restart services, mutate production databases, prune SQLite/WAL state, ACK terminal-outbox rows, replay historical outbox rows, send Telegram/provider messages, expose secrets, publish a release, force-push, rewrite history, or change repository visibility.

### Decision

**Decision: `NO-GO / Waiting` for operational activation.** Source docs/tests may proceed, but live broker rollout, cleanup, canary send, Terminal Brief ACK, or production state mutation remains blocked until every gate below has linked evidence and a separate explicit operator approval for that exact action.

Safe PR/Done evidence for this lane may say: **the read-only validation lane and broker-stability closeout gates are documented and locally tested; production activation remains `NO-GO / Waiting`.** It must not claim that #527, #497, or #294 is closed by documentation alone.

## Gate A — GitHub read-only validation/libero lane (`a2a-broker#527`)

A GitHub task with issue metadata may complete without a repository diff only when it is explicitly classified as read-only validation or analysis. Patch-producing tasks keep the existing no-diff false-Done guard.

| Required field or evidence | Pass condition | Fail-closed condition |
| --- | --- | --- |
| Intent/mode | The task uses `intent=verify` or `intent=analyze` with `taskOrigin=github` and a read-only mode such as `github-verify`, `github-read-only-validation`, or `read-only-analysis`. | GitHub issue metadata is forced into `github-propose-patch` when the worker role is validation/libero. |
| Allowed metadata | `repo`, `issue`, `issueNumber`, `issueUrl`, and `baseBranch` may be present for evidence binding. | Metadata implies a patch lane, live send, deploy, DB mutation, or terminal ACK. |
| Evidence | Start plus Done/Block GitHub evidence comments include bounded command results, issue/PR references, and a terminal kind of `done` or `block`. | Missing Start, missing terminal evidence, raw logs, secrets, host-private paths, or ambiguous terminal kind. |
| Repository diff | No diff is required for read-only validation/libero lanes. | A patch-producing lane posts Done with no diff or PR. |
| Terminal Brief | Terminal Brief may summarize the read-only result as evidence only. | Terminal Brief is treated as operator-visible receipt, read receipt, terminal ACK, or approval. |

Regression expectation: the `a2a-plane#240` style validation case from `a2a-broker#527` must be accepted as a read-only validation/libero task with Start and Done/Block evidence, while a `github-propose-patch` task with no repository changes still fails closed as false Done.

## Gate B — Broker hot-table growth and OOM stability (`a2a-broker#497`)

Before claiming #497 stability closure, require linked broker-side evidence for all of:

1. bounded SQLite hot-table loading or incremental persistence behavior that avoids full historical task/audit/outbox materialization in live heap;
2. health/readiness output that reports process memory, heap/RSS, table counts, terminal outbox total/acked/unacked counts, stale queued/claimed/running work, and WAL/checkpoint posture without secrets or host-private paths;
3. a representative regression, load, or soak test that seeds task/audit/outbox growth and shows startup/steady-state memory remains bounded;
4. terminal outbox hygiene that preserves unacked rows unless an approved retention policy handles them without forging ACK from provider accepted-send evidence;
5. safe-prune or cleanup APIs, if used, are dry-run first, target explicit tables/entities, require backup/restore evidence, and are blocked from production mutation without separate approval.

Any deploy, restart, DB prune, WAL mutation, backup/restore operation, or production cleanup is outside this Plane lane and remains `NO-GO / Waiting` without explicit approval.

## Gate C — Receipt semantics, queue hygiene, and canary safety (`a2a-broker#294`)

Before claiming #294 roadmap closure, require linked evidence for all of:

1. receipt vocabulary distinguishes `accepted`, `sent`, `provider-delivered-if-known`, `requester-visible`, `operator-visible`, `timed_out`, `stale`, `failed`, `Done`, `Block`, and `PR`;
2. provider accepted-send, Telegram message IDs, GitHub comment projection, and Terminal Brief notices are explicitly non-ACK and non-read-receipt evidence;
3. queue hygiene shows no stale claimed/running work, no unbounded backlog, and a clear no-change/evidence-only outcome path for validation/libero work;
4. a no-delivery or no-real-ACK canary path proves broker → plugin → worker → result projection without live provider send or terminal-outbox ACK;
5. any future live canary is disabled by default, one-shot allowlisted, replay/idempotency protected, tied to a fresh task/outbox id, and followed by restoration evidence.

The safe state for this lane is to leave #294 open as a residual-risk tracker until implementation PRs, canary proof, and operator approvals exist.

## Cross-broker Terminal Brief projection gate

For Seoseo-origin parent rounds and Gwakga handoffs, projected Terminal Brief evidence is an evidence ledger entry only. Accept it only when it includes:

- `parent=a2a-broker#539` and `lane=a2a-plane#275` or equivalent stable IDs;
- the child issue or PR/Done/Block evidence URL;
- a bounded summary and terminal kind (`pr`, `done`, or `block`);
- explicit flags showing no provider send, no terminal-outbox ACK, no read receipt, no approval, no production DB mutation, and no deploy/restart;
- runtime/bootstrap hygiene confirmation before copying the projection into parent evidence.

Do not manually ACK/replay Terminal Brief rows or replay historical outbox entries from this lane.

## Runtime/bootstrap and artifact hygiene gate

Before publishing PR, Done, or Block evidence, fail closed if any OpenClaw runtime/bootstrap context path would enter the branch, artifact evidence, or GitHub comment body. Report the exact repo-relative offending paths, including:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Evidence must be bounded summaries only. It must not include raw session dumps, provider payloads, tokens, authorization header values, GitHub PATs, host-private paths, chat IDs, or secret-bearing config.

## Suggested local verification

```bash
npm run check:team1-yukson-plane-gates
npm run check:layout
npm run check:no-diff-closeout-guidance
git status --short --ignored
```
