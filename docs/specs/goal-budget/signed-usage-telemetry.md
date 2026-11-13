# Design: Signed Usage Telemetry for Spend Budgets

> **Issue:** [#2519](https://github.com/jinwon-int/a2a-nexus/issues/2519) (follow-up of [#2499](https://github.com/jinwon-int/a2a-nexus/issues/2499), spec decision 12)
> **Phase:** Spec-first. This document changes no code, schema, setting or runtime behaviour, and grants no approval.
> **Status:** Draft — awaiting owner ratification of the [decisions](#decisions-for-owner-ratification). Nothing in "Recommended design" exists yet.
> **Related:** [`spec.md`](spec.md) (decisions 4, 8, 12, 15, 16, 19), [`cross-broker-spend.md`](cross-broker-spend.md), [`packages/broker/docs/spend-budget-runbook.md`](../../../packages/broker/docs/spend-budget-runbook.md), [`packages/docker-runner/docs/signed-execution-proof.md`](../../../packages/docker-runner/docs/signed-execution-proof.md)

Code references are to `main` at `dc2fd4b2`; paths without a package are under `packages/broker/src/`. "Spec decision N" means a numbered decision in [`spec.md`](spec.md).

## Problem

The spend ledger meters each task from `executionTelemetry`, an unsigned object the worker reports.

- **Carriers.** The broker looks in four places: `result.output`, `error.details.bridgeFailure`, the same nested under `error.details.nestedError.details`, and the preserved negative-verdict result (`core/completion/broker-task-terminal.ts:624-638`). The first carrier that parses wins (`:699-707`).
- **Validation.** Values are bounded, never clamped: `costUsd` ≤ 1e6, tokens ≤ 1e12 (`:665-684`; caps at `core/store-schemas.ts:1144-1145`).
- **Row.** The row is built from the task record alone, at the terminal transition (`:727-776`), by the one-time late metering after a cancel (`:798-820`) and by the reconciliation (`:829-859`). It has no column that says where the numbers came from or whether anything vouched for them (`core/store/store.ts:1841-1852`).

What is signed today:

| Structure | Signed by | Covers usage | Stored | Verified by the broker |
|---|---|---|---|---|
| `a2a.result.provenance.v1` (`packages/attestation/src/provenance.ts:36-45`) | The worker's HTTP-signature key (`workers/broker-worker-client.ts:796-819`) | Indirectly, on success only: `resultHash` covers the whole normalized result except `provenance` and `finalizerVerdict` (`provenance.ts:111-131`), so it covers `output.executionTelemetry` | Yes, as `task.result.provenance`, with the broker countersignature (`provenance.ts:189-210`) | Yes, on `/complete` and on `/evidence` with outcome `done` or `pr` (`http/tasks-worker-routes.ts:120-178`, `:361-381`). Posture `off` passes it through unverified (`:130-132`) |
| Failure path | Nothing | No: `/fail` carries `error` and `negativeVerdictEvidence` with no provenance (`http/tasks-worker-routes.ts:396-408`; worker side `workers/broker-worker-client.ts:578-634`, `:828-833`) | — | — |
| `ExecutionProof` (`packages/docker-runner/src/types.ts:59-106`; signing `execution-proof-signing.ts:69-90`) | The runner key, off by default | No usage field | Not sent to the broker: `packages/broker` has no reference to it, and the broker has no registry of runner keys | No |
| Worker HTTP signature | The worker key | The request in transit | No | Yes |

So the gaps are:

1. The ledger never records whether the numbers it counted were under a verified signature. The row builder does not look at provenance.
2. Failure, nested-failure, negative-verdict and late failure carriers are under no signature at all, and failed work is where spend most needs recording (spec, "Usage and cost in terminal results", conclusion 4).
3. A worker without a signing key sends no provenance (`workers/broker-worker-client.ts:802-805`). Which fleet workers sign today is a deployment fact the repository does not show.
4. Outliers. `broker.spend.near_cap` fires only at half of a per-task cap (`core/store-schemas.ts:1195`, `core/completion/broker-task-terminal.ts:590-601`): 500 000 USD or 5e11 tokens for one task. A row that exhausts a real budget is far below that. Status shows the largest rows of a named scope (`http/goal-routes.ts:565-568`, `core/store/store.ts:1518-1549`), but an operator cannot take one out of the totals.

### What a signature does and does not give

A worker signature binds the numbers to a worker key and a task, makes the stored record tamper-evident, and makes the report attributable. It does **not** make the number true: the reporter holds the key, so a faulty or dishonest worker signs its wrong number. This is the same scope of proof the provenance module states for results (`provenance.ts:4-12`). Catching a dishonest under-report needs a meter the worker does not control, such as provider-side usage; that is out of scope. This design therefore delivers integrity, attribution, a visible verified/unverified split, and operator controls for outliers. It does not turn budgets into a security boundary, and spec decision 12 keeps that wording.

## Options

| Option | What it needs | Trust model | Failure behaviour | Cost |
|---|---|---|---|---|
| **A. Reuse `a2a.result.provenance.v1` as is** — mark a row verified when it was metered from `result.output` of a result whose provenance verified | A broker-side marker from the route to the row builder; no worker change | Worker key; usage is covered only as part of the whole result hash | Failed tasks, negative verdicts and late failures are never verified. The stored record re-verifies only while the stored result still hashes the same | Lowest |
| **B. Usage attestation in the provenance family** (recommended) — a small worker-signed object that carries the metered numbers, on every terminal path | Sign and verify functions on the existing primitives; a worker client change (worker rollout); broker accept, verify, store; one ledger column | Worker key registered for HTTP signatures, plus the broker countersignature | Absent or invalid: today's behaviour, row unverified | Medium |
| **C. Extend `ExecutionProof` with usage** | Submit the proof to the broker (not done today); a runner public-key registry on the broker (none); signing enabled on every runner; a new proof schema version | Runner key, on the same host as the worker | Covers docker-runner lanes only; analysis lanes are never verified | Highest: a second key system |

## Recommended design

Option B: the worker signs a **usage attestation** next to its terminal report, the broker verifies and stores it on the task record, the ledger meters from it and records that it did.

### 1. Attestation shape

A new schema in `packages/attestation/src/provenance.ts`, beside the result provenance and built on the same primitives (JCS canonicalization, `signAgentCard`, EdDSA or ES256). The `v1` result-provenance payload is not touched: changing a signed payload would break every existing verifier.

```jsonc
// request body field `usageAttestation` on POST /tasks/:id/complete, /fail and /evidence
{
  "schemaVersion": "a2a.usage.attestation.v1",
  "canonicalization": "rfc8785-jcs-v1",
  "alg": "EdDSA",
  "workerKeyId": "<registered worker key id>",
  "claimedAt": "2026-11-13T08:59:12.000Z",
  "outcome": "complete",
  "usage": {
    "telemetrySchemaVersion": "a2a.analysis-execution-telemetry.v1",
    "costUsd": 0.42,
    "inputTokens": 1200,
    "cacheCreationInputTokens": 300,
    "outputTokens": 800
  },
  "workerSig": { "protected": "<base64url header>", "signature": "<base64url>" }
}
```

- **Signed payload:** `{ schemaVersion, canonicalization, taskId, claimedAt, outcome, usage }`. As in `v1`, `taskId` is bound by the signature and taken from the route, not carried in the object.
- **`outcome`:** `complete` or `fail`.
- **`usage`:** a closed set, the fields the ledger meters. `costUsd` is omitted when the runtime reports no cost (spec decision 4). Unknown keys make the attestation invalid. Validation and caps are those of `parseSpendTelemetry`.
- **Why values and not a hash of the carrier:** the stored object is self-contained. It can be re-verified offline after the task result is pruned, and it does not depend on how a result or an error is normalized.
- **Size:** at most 4 KiB.

### 2. Worker side

In `workers/broker-worker-client.ts`, when a signing key is configured, the worker builds the attestation from the telemetry of the outcome it is about to post and sends it on `/complete`, `/fail` and `/evidence`. On success the source is `result.output.executionTelemetry`; on failure it is the first present carrier in the broker's failure-first order. No telemetry means no attestation. Other worker implementations can adopt the contract later; until then their rows stay unverified.

### 3. Broker: verify, countersign, store

- **Route** (`http/tasks-worker-routes.ts`, next to `verifyAndCountersignResultProvenance`): the key id equals the verified worker's key, the signature verifies against the registered public key, `outcome` matches the route, `usage` validates.
- **Posture:** the existing `A2A_RESULT_PROVENANCE_COUNTERSIGN` setting. `off` ignores the attestation. With a broker signer the broker adds a countersignature (`a2a.usage.attestation.broker-countersig.v1`, the shape of `provenance.ts:59-65`).
- **Invalid attestation:** the terminal report is still accepted, the attestation is dropped, and the broker logs one `broker.spend.usage_attestation_invalid` line (task id and reason code, never a value) and counts it. A telemetry problem never fails a terminal transition today, and this keeps that rule.
- **Storage:** `completeTask`, `failTask` and the late-evidence path receive the verified attestation as a broker-side argument and store it as `task.usageAttestation` (`lateEvidenceAfterCancel.usageAttestation` on the late path) with `verifiedAt`. It is outside `result`, so `resultHash` is unaffected and a worker cannot plant it through `result` or `error`.
- **Row:** the stored attestation's `usage` becomes the first candidate in both precedence orders of `spendTelemetryCandidates`, and `resolveSpendUsage` reports which candidate won. The row gets `usage_verified = 1` exactly when the attestation won. Because the row is still built from the task record, the live path, the late metering (its `UPDATE` also sets `usage_verified`) and the reconciliation agree.
- **Cross-check:** when the attestation and a legacy carrier both parse and differ, the attestation wins and the broker logs `broker.spend.usage_attestation_mismatch` (reason code only) and counts it.

### 4. Ledger schema change, migration, rollback

```sql
ALTER TABLE broker_spend_events ADD COLUMN usage_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE broker_spend_events ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0;
```

- **How:** `ensureColumn` (`core/store/store.ts:2792-2798`, as `goal_id` at `:1862`), plus the same columns in the `CREATE TABLE` for new stores. A constant default makes each statement O(1); no row is rewritten.
- **Existing rows** become `0 / 0`: unverified and counted, which is the truth about them. No backfill.
- **No new index.** The aggregates already select a scope's rows through `(period_key, <scope>)` and read each row.
- **`SQLITE_SCHEMA_VERSION` stays 14** (recommended; the precedent is the unique index of spec decision 16). An older v14 binary can still open the store: its insert names its columns (`core/store/store.ts:1278-1281`), so its rows take the defaults, and its reads name their columns.
- **Rollback:** install the previous binary. Its effect is stated, not hidden: rows written by it are unverified, and excluded rows count again. The columns are never dropped. With the alternative (version 15), an older binary refuses the store (`core/store/store.ts:1619-1631`) and rollback means restoring the pre-upgrade backup.
- **Approval:** either way, the first start of the new binary alters a production table. That is a database migration: a verified backup and the owner's approval, per broker.

### 5. Policy

**Count every row, flag the unverified part.** Enforcement and spec decision 15 do not change. No new setting.

Counting only verified usage would remove the spend of every worker that does not sign yet from the limits. That weakens enforcement, which is the opposite of the goal, and it does not stop a signing worker from over-reporting. It becomes a reasonable per-budget option only after the verified share is near 100%, and is listed as the alternative.

### 6. Status and alerts

- Totals (`period_total`, `scope_total`, `scopes[]`): add `usd_verified_total`, `verified_task_count`, `excluded_task_count`.
- `budgets[]`: add `usdSpentVerified` and `tokensSpentVerified`.
- `topRows`: each row adds `usageVerified` and `excluded`.
- New in-memory object `usageAttestation`: `{ invalidTotal, mismatchTotal, lastInvalidAt }`.
- `budget_warn` and `budget_exhausted` metadata add `usdSpentUnverified` and `tokensSpentUnverified` (numbers only). No new alert kind.

### 7. Outliers and exclusion

- `broker.spend.near_cap` stays.
- **Budget-relative marker.** When a row is built, for each budget of the row's scopes (the in-memory budget map; no store read), a row whose cost is at least 25% of `limitUsd`, or whose tokens are at least 25% of `limitTokens`, logs `broker.spend.outlier` with the task id, budget id and field name, and is counted in status.
- **Exclusion.** `POST /budgets/spend/:taskId/exclusion` with `{ "excluded": true | false, "actorId": "...", "note": "..." }`, for the roles that write budgets (`http/goal-routes.ts:51`).
  - It sets the flag only. The row's values are never edited and the row is never deleted, so the ledger stays auditable.
  - It appends a `spend.excluded` or `spend.restored` audit event (two additions to the closed `AuditAction` list, `core/types.ts:444`), with the actor and a note of at most 500 characters. An unknown task id is 404; repeating a request is a no-op.
  - `readSpendTotals` and `readSpendScopeUsage` skip excluded rows. `hasCostReportingSpend` does not (an excluded row still shows that the worker reports cost). `listTopSpendRows` keeps returning them, flagged.
  - The budget revision is bumped, so listings re-snapshot; alerts and goal limits follow at the next sweep.
- Raising the limit (`PATCH /budgets/:id`) stays the other remedy.

### 8. Behaviour when the signature is missing or wrong

| Case | Row metered from | `usage_verified` | Signal |
|---|---|---|---|
| No attestation (older worker, no key, other runtime) | Today's carriers | 0 | None |
| Valid attestation | The attestation | 1 | None |
| Bad signature, key id, task or outcome | Today's carriers | 0 | `usage_attestation_invalid` |
| Valid signature, `usage` out of bounds or with unknown keys | Today's carriers (never clamped) | 0 | `usage_attestation_invalid` |
| No registered public key for the caller | Today's carriers | 0 | `usage_attestation_invalid` |
| Countersign posture `off` | Today's carriers | 0 | None |
| Late evidence after a cancel | The late attestation, under the existing one-time guard | 1 | None |
| Row rebuilt by the reconciliation | The stored task record | Same as the live path | None |

Mixed versions: an older worker with a newer broker gives unverified rows, as today. A newer worker with an older broker sends a field the older broker does not read; a test pins that the request is still accepted.

## Decisions for owner ratification

Numbered within this document. Each has a recommendation and the alternative.

1. **Signed structure.** Recommended: the usage attestation (option B). Alternative: mark rows from `v1` result provenance only (A), or extend `ExecutionProof` (C).
2. **Invalid attestation.** Recommended: accept the terminal report and record the row unverified. Alternative: reject the report, as `provenance_invalid` does for result provenance; stricter, but a signing bug then blocks task completion.
3. **Success rows under `v1` provenance but without an attestation.** Recommended: unverified, so "verified" has one meaning. Alternative: count them as verified, which gives verified rows on the success path with no worker rollout; it needs a broker-side marker, because posture `off` stores provenance it did not verify.
4. **Policy.** Recommended: count all usage and flag the unverified part. Alternative: count only verified usage.
5. **Schema version.** Recommended: add the columns without a version bump; rollback is the previous binary. Alternative: version 15, so an older binary refuses the store and rollback needs the backup.
6. **Exclusion.** Recommended: operators can exclude and restore a single row; a flag plus an audit event, values untouched. Alternative: no exclusion, raise the limit instead.
7. **Who may exclude.** Recommended: the roles that write budgets, each use audited. Alternative: each exclusion needs a recorded owner approval.
8. **Budget-relative outlier log.** Recommended: add it at 25% of a limit. Alternative: keep only `near_cap`, or another share.
9. **Posture setting.** Recommended: reuse `A2A_RESULT_PROVENANCE_COUNTERSIGN`. Alternative: a separate setting for usage attestations.
10. **Approval gates.** Recommended: the list under Rollout. Alternative: fewer or more gates.

## Rollout order

Source PRs, in order. Each is source-only, reviewed by an A2A lane that did not author it, and merged on the owner's approval.

1. Attestation sign and verify, contract text, fixtures (`packages/attestation`).
2. Broker: the two columns, accept, verify, countersign, store, the row flag, status fields.
3. Worker client signs attestations.
4. Exclusion route, audit events, outlier log, runbook section.

Operator steps. Every step marked **[approval]** needs its own owner approval, per broker; a step on the other team's broker is a cross-broker change.

1. **[approval]** Deploy the broker build with PR 2 to one broker. This is a schema migration (two `ALTER TABLE` statements at first start) and a broker restart; it needs a verified backup first. Then the other broker, separately.
2. **[approval]** Roll out the worker build with PR 3 (worker restarts). The broker goes first.
3. Excluding a row on a live broker is an audited operator action; whether each use also needs approval is decision 7.

No enforcement mode changes in this rollout, and no setting is added. Rollback: the previous broker binary (see Ledger schema change) and the previous worker build; an attestation that nobody reads is harmless.

## Test plan

Unit and fixture tests only; no live broker.

- **Attestation:** round trip for EdDSA and ES256; every signed field tampered; wrong task id; wrong key; algorithm mismatch; unknown `usage` key; each cap; float and integer canonicalization; a contract fixture that a second implementation can verify.
- **Route:** valid; each invalid reason is accepted and unverified; key id mismatch; no registered key; the three countersign postures; `outcome` against the route; the 4 KiB bound.
- **Row:** the attestation wins both precedence orders; mismatch log; legacy fallback; `usage_verified` on complete, fail, negative verdict and late evidence; the late `UPDATE` guard; a reconciled row equals the live row; the worker-thread persistence queue.
- **Migration:** a v14 store without the columns gains them and keeps every row at `0 / 0`; a second start is a no-op; a fresh store has them; an insert that names only the old columns still succeeds (the previous binary's statement).
- **Aggregates and status:** verified totals; excluded rows leave budget evaluation and totals but stay in `topRows`; the cost-reporting probe ignores exclusion; bigint-safe JSON.
- **Exclusion:** roles; 404; idempotency; audit events; restore; budget revision bump; alert resolve and goal resume at the next sweep.
- **Outlier:** the 25% boundary for USD and tokens; no store read when the row is built; ids and field names only in the log.
- **Worker client:** signs on complete, fail and evidence; nothing without a key or telemetry; an older broker accepts the request.
- **Guards:** `node scripts/check-script-budget.mjs` and `node scripts/check-broker-core-dependency-isolation.mjs` stay green.

## Open questions

- Which fleet workers have a signing key configured today. It sets how fast the verified share can rise and cannot be read from the repository.
- Whether worker implementations other than the TypeScript client post terminal results. Each needs its own signer before its rows can be verified.
- With [`cross-broker-spend.md`](cross-broker-spend.md): peer summaries are built from the same aggregates, so excluded rows drop out of them at the next summary. Whether a summary should also carry verified totals is left to that document's implementation.

## Out of scope

- An independent meter (provider usage, a metering proxy) and any claim that signed usage is true usage.
- Changes to `ExecutionProof` or to the `v1` result-provenance payload.
- Enforcement that counts only verified usage.
- Backfilling `usage_verified` for existing rows; dropping columns.
- Pricing, cost reporting for more runtimes, dashboards, and cross-broker aggregation ([#2516](https://github.com/jinwon-int/a2a-nexus/issues/2516)).
