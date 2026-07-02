# Approval-Gated Auto-Closeout Action Reconciliation Contract (v0)

> **v0 Freeze (2026-05-20):** Cross-repo contract between a2a-broker and a2a-plane for
> approval-gated auto-closeout action reconciliation. Defines the reconciliation protocol,
> approval boundaries, rollback/no-op criteria, idempotency-key semantics, evidence
> requirements, and the canary gate that must pass before any production auto-closeout
> enablement. This contract is source-only: it produces no deployment, restart, production
> DB/state mutation, secret rotation, live GitHub comment/close automation, or
> terminal-outbox ACK.

Parent issue: [a2a-broker#844](https://github.com/jinwon-int/a2a-broker/issues/844)
Child issue: a2a-plane#402 (a2a-plane#402, internal tracker private)
Parent round: `a2a-team1-auto-closeout-action-reconcile-20260520T180955Z` (4/4)
Worker: `worker-alpha`

This contract builds on the existing:
- [Parent-round closeout go/no-go matrix](./parent-round-closeout-go-nogo-matrix.md)
- [Terminal semantics](./terminal-semantics.md)
- [Task lifecycle](./task-lifecycle.md)
- [Cancellation & idempotency](./cancellation-idempotency.md)
- [Parent Terminal Brief aggregation](./parent-terminal-brief-aggregation.md)
- [Public/private boundary governance](../../docs/governance/public-private-boundary-gates.md)
- [Broker closeout reconciler](../../packages/broker/docs/closeout-reconciler.md)
- [Broker closeout reconcile runbook](../../packages/broker/docs/closeout-reconcile-runbook.md)

---

## 1. Scope and definitions

### 1.1 What this contract covers

This contract defines the reconciliation between the broker's closeout decision engine
(which produces terminal-outbox entries for comment posting / issue closing) and the
plane-level go/no-go matrix (which evaluates whether a parent round is ready to close).
It covers:

1. **Action reconciliation protocol** — how the broker and plane negotiate which
   closeout actions are pending, which are approved, and which are executed.
2. **Approval boundaries** — which actions require explicit operator approval and
   which may proceed automatically after a GO decision.
3. **Rollback/no-op criteria** — when and how to roll back or no-op a reconciliation.
4. **Idempotency-key semantics** — unique stable keys for each reconciliation action.
5. **Canary gate** — the verification gate that must pass before production enablement.
6. **Evidence requirements** — what redacted evidence is needed for each gate.

### 1.2 What this contract does NOT cover

- **Go/no-go matrix evaluation itself** — that is defined in
  [parent-round-closeout-go-nogo-matrix.md](./parent-round-closeout-go-nogo-matrix.md).
- **Broker task lifecycle** — that is defined in
  [task-lifecycle.md](./task-lifecycle.md).
- **Terminal-outbox ACK semantics** — those are defined in
  [terminal-semantics.md](./terminal-semantics.md).
- **Provider send / notification routing** — those are defined in
  [parent-terminal-brief-aggregation.md](./parent-terminal-brief-aggregation.md).
- **Deployment, restart, production DB mutation, secret rotation, or visibility changes** —
  none of these are covered or authorized by this contract.

### 1.3 Actors

| Actor | Role |
|-------|------|
| **Closeout reconciler** | Broker component (`closeout-reconciler.ts`) that aggregates child task terminal states and produces closeout action proposals. |
| **Go/no-go matrix** | Plane-level evaluation (`parent-round-closeout-go-nogo-matrix.md`) that determines if a parent round passes all gates. |
| **Action reconciliation layer** | The broker/plane coordination layer defined by this contract. Produces a reconciliation record that maps go/no-go decisions to concrete closeout actions. |
| **Operator** | Human who reviews reconciliation records and grants or denies explicit approval for each reconciliation action batch. |
| **Broker of record** | The broker instance responsible for executing approved closeout actions (broker-alpha for Team1, broker-beta for Team2). |

### 1.4 Action types

Each auto-closeout action is one of:

| Action kind | Description | Requires explicit operator approval |
|-------------|-------------|-----------------------------------|
| `comment_post` | Post a terminal-evidence comment on a parent issue summarizing the closeout. | Yes — first production enablement per round |
| `issue_close` | Close the parent issue after all terminal evidence is posted. | Yes — separate from comment approval |
| `metadata_update` | Update closeout metadata fields (timestamps, status, retry count) without posting or closing. | No — auto-reconciled |
| `idempotency_register` | Register a reconciliation idempotency key to prevent duplicate action execution. | No — auto-reconciled |
| `rollback_record` | Record a rollback of a previous closeout action. | No — auto-reconciled |

---

## 2. Reconciliation lifecycle

### 2.1 States

A reconciliation record progresses through these states:

```
PENDING → RECONCILED → APPROVED → DISPATCHED → CONFIRMED
                            ↘           ↘
                          REJECTED   FAILED
```

| State | Meaning |
|-------|---------|
| `PENDING` | Action proposed by reconciler but not yet reconciled against plane state. |
| `RECONCILED` | Proposed action matched against go/no-go matrix output; pending operator review. |
| `APPROVED` | Operator explicitly approved this action batch. Idempotency key registered. |
| `DISPATCHED` | Approved action dispatched to provider (GitHub API). Non-terminal — may still fail. |
| `CONFIRMED` | Provider returned success; action execution confirmed. Terminal state for this action. |
| `REJECTED` | Operator explicitly rejected this action batch. No execution will occur. |
| `FAILED` | Provider returned non-retryable error or max retries exceeded. Manual intervention required. |

### 2.2 Lifecycle rules

1. **Single transition per action kind:** Each action kind (comment_post, issue_close) may
   have at most one non-terminal reconciliation record per parent round at any time.
2. **No auto-advance past APPROVED:** Transitions from APPROVED to DISPATCHED require
   explicit operator approval. The reconciler may auto-advance PENDING → RECONCILED
   and DISPATCHED → CONFIRMED.
3. **FAILED is terminal for the action:** A FAILED action must not be re-dispatched
   without operator review. The operator may reset it to PENDING for retry.
4. **REJECTED blocks all sibling actions:** When any action for a parent round is
   REJECTED or FAILED, no sibling auto-closeout action for that same parent round
   may be auto-evaluated as GO without operator intervention.
5. **CONFIRMED actions are recorded but not replayed:** Once an action reaches
   CONFIRMED, the reconciliation layer must not dispatch it again. The idempotency
   key prevents duplicate execution.

---

## 3. Approval boundaries

### 3.1 What requires explicit operator approval

| Boundary | Condition for operator approval | Evidence required with approval |
|----------|-------------------------------|--------------------------------|
| **First production comment_post** | Any parent round's first auto-closeout comment post to a production GitHub issue | Link to: go/no-go matrix GO output, redacted evidence payload, reconciliation record, GitHub permission check (no 403) |
| **First production issue_close** | Any parent round's first auto-closeout issue close in a production repo | Link to: associated comment_post CONFIRMED record, issue metadata, idempotency key |
| **FAILED action retry** | Recovery from a FAILED closeout action | Operator review comment explaining retry rationale; root cause assessment |
| **Rollback of CONFIRMED action** | Undoing an already-confirmed closeout action | Explicit rollback plan; impact assessment; alternative resolution documented |

### 3.2 What does NOT require operator approval

| Action | Why auto-reconciled |
|--------|-------------------|
| Metadata updates on a GO/NO_GO/BLOCKED matrix output | No external side effect |
| Idempotency key registration | Pure bookkeeping |
| Rollback record creation | Pure bookkeeping |
| PENDING → RECONCILED transition | Pure reconciliation logic |
| DISPATCHED → CONFIRMED transition | Confirmation of completed external action (not the execution itself) |

### 3.3 Approval gate rules

1. **Single-approval scope:** Each approval covers exactly one action type for exactly one
   parent round. An approval for `comment_post` does not cover `issue_close`.
2. **Approval expires with round:** Approval is scoped to the `parentRoundId`. A new
   parent round requires a new approval.
3. **Approval is not inheritable:** Child tasks, sibling brokers, or handoff brokers
   cannot inherit or reuse an approval from a parent or sibling round.
4. **Approval must be explicit text:** An approval comment must name the exact
   `parentRoundId`, action kind, broker of record, and the reconciliation record id.
5. **Approval must be separate from other actions:** The same approval comment must
   not also authorize a deploy, restart, DB mutation, provider send, secret rotation,
   visibility change, or release.

---

## 4. Idempotency keys

### 4.1 Key derivation

Every reconciliation action carries an idempotency key of the form:

```
reconcile:<parentRoundId>:<actionKind>:<brokerOfRecord>
```

Example: `reconcile:a2a-team1-auto-closeout-dryrun-wiring-20260520T174311Z:comment_post:broker-alpha`

The same parent round + action kind + broker of record always produces the same key.

### 4.2 Key lifecycle

1. **Key registered at RECONCILED → APPROVED transition:** The idempotency key is
   persisted before any provider dispatch begins.
2. **Key prevents duplicate dispatch:** If the same key is presented again with the
   same action payload, the reconciler returns the existing record instead of
   dispatching a new one.
3. **Key conflict detection:** If the same key is presented with a different action
   payload (different terminal evidence URL, different close target), the reconciler
   must detect the conflict and block the dispatch, returning `conflictDetected: true`.
4. **Key survives restart:** Keys are persisted to disk or database. A broker restart
   must not lose the registered keys or allow duplicate dispatch.
5. **Key expiry:** Keys for CONFIRMED actions are valid indefinitely. Keys for REJECTED
   or FAILED actions may be reset by an operator with an explicit `reset_key` approval.
6. **Key collision with closeout reconciler:** The action reconciliation idempotency key
   must not collide with any idempotency key used by the broker's closeout reconciler
   (which operates at the task level, not the action level).

### 4.3 Idempotency enforcement gates

1. An action must not reach APPROVED without a registered idempotency key.
2. A key collision with a different payload is a BLOCKED condition and must surface the
   conflicting record details to the operator.
3. Replaying an already-CONFIRMED action returns `duplicateSuppressed: true` and no new
   provider call.
4. Replaying a FAILED action returns `staleKey: true` and advises operator review — it
   must not auto-retry.

---

## 5. Rollback/no-op criteria

### 5.1 Rollback scenarios

| Scenario | Rollback action | Safety gate |
|----------|----------------|-------------|
| Comment post CONFIRMED, but parent issue should not close | No-op on issue_close; leave comment visible but mark reconciliation record as "no-close" via metadata update | Must not delete or edit the posted comment (GitHub history should not be rewritten) |
| Wrong metadata updated | Reset metadata to pre-reconciliation value; record rollback in rollback_record | Must not touch provider state |
| Idempotency key registered but action not yet APPROVED | Delete key; revert to PENDING | No external state affected |
| Action APPROVED but not yet DISPATCHED | Revoke approval (set to PENDING, not REJECTED); delete key | Operator must explicitly approve the revocation |
| Action DISPATCHED but provider returned error before CONFIRMED | Leave as FAILED; operator reviews and decides retry or abandon | No auto-retry |
| Action DISPATCHED and CONFIRMED but with wrong payload | Record payload-correcting action as a new reconciliation record; do not undo the original | New action requires its own operator approval |

### 5.2 No-op criteria

A reconciliation action is a no-op (no provider dispatch) when:

1. **Idempotency replay:** Same key, same payload → return existing CONFIRMED record.
2. **Matrix outputs NO_GO or BLOCKED:** All reconciliation actions for that round
   must remain PENDING or transition to REJECTED — never APPROVED.
3. **Matrix outputs GO but reconciliation rejects:** If the action reconciliation
   layer determines the pending actions are unsafe (e.g., GitHub 403 detected in
   permission check, or runtime bootstrap hygiene failed), the action must remain
   PENDING and surface a BLOCKED condition.
4. **Broker of record changed:** If `brokerOfRecord` for the parent round differs from
   the reconciling broker, the action must be PENDING until the correct broker confirms.

### 5.3 Rollback guidance metadata

Every reconciliation record that is rolled back must capture:

```json
{
  "rollbackType": "metadata-only",
  "deleteChildEvidence": false,
  "overwriteExistingProjection": false,
  "createNewChildTaskForCloseoutFailure": false,
  "markReconciliationBlockedOrConflict": true,
  "preserveReconciliationKey": true,
  "noAutoRetryOn403": true,
  "noAutoRetryOnConflict": true
}
```

---

## 6. Reconciliation protocol

### 6.1 Broker → Plane flow

1. Broker closeout reconciler produces a set of closeout actions for a parent round
   (comment_post, issue_close).
2. Each action is registered as PENDING in the reconciliation layer.
3. The reconciliation layer reads the go/no-go matrix output for the parent round.
4. If matrix says NO_GO or BLOCKED → actions stay PENDING; reconciliation record
   includes `blockerMatrixDecision: <NO_GO|BLOCKED>`.
5. If matrix says GO → actions transition to RECONCILED and await operator approval.

### 6.2 Plane → Broker flow

1. The go/no-go matrix evaluation reads the reconciliation record to determine if any
   pending or unreconciled actions exist.
2. If actions are RECONCILED but not APPROVED, the matrix must report
   `actionReconciliationGate: PENDING_APPROVAL` as a gate result, not as GO.
3. The matrix must NOT auto-approve any action. It reports gate status only.

### 6.3 Cross-repo reconciliation invariants

1. The broker's reconciliation record and the plane's go/no-go matrix output must be
   coherent for the same `parentRoundId`. If the broker reports actions PENDING but
   the plane reports `closeoutAllowed: true`, this is a reconciliation conflict and
   must surface as BLOCKED.
2. The plane must not mutate the broker's reconciliation records and the broker must
   not bypass the plane's go/no-go evaluation.
3. Both sides must agree on brokerOfRecord for the parent round. Disagreement is
   a BLOCKED condition requiring operator intervention.

---

## 7. Canary gate

### 7.1 Purpose

The approval-gated auto-closeout action reconciliation canary gate verifies that the
reconciliation layer is correctly wired and fail-closed before any production
auto-closeout action is enabled. It is a no-live, deterministic proof.

### 7.2 Canary scenarios

| Scenario | Input | Expected output |
|----------|-------|----------------|
| **GO + actions reconciled** | Matrix returns GO for a parent round with 4/4 terminal lanes; reconciliation layer has PENDING actions | Actions transition to RECONCILED; record shows `lastActionState: RECONCILED` |
| **NO_GO blocks reconciliation** | Matrix returns NO_GO with a specific failing gate | Actions stay PENDING; record shows `blockerMatrixDecision: NO_GO`, `blockedGate: <gateId>` |
| **BLOCKED blocks reconciliation** | Matrix returns BLOCKED with operator action required | Actions stay PENDING; record shows `operatorActionRequired: true` |
| **Operator approval required** | RECONCILED actions with no operator approval | Matrix gate reports `actionReconciliationGate: PENDING_APPROVAL` |
| **Idempotency duplicate suppression** | Same action key+payload replayed after CONFIRMED | Returns `duplicateSuppressed: true`; no new dispatch |
| **Idempotency conflict detection** | Same key but different payload | Returns `conflictDetected: true`; blocks dispatch |
| **GitHub 403 blocks all** | GitHub permission check fails for the reconciling broker | All actions remain PENDING; record shows `github403Detected: true` |
| **Broker of record mismatch** | Reconciling broker differs from brokerOfRecord | All actions remain PENDING; record shows `brokerOfRecordMismatch: true` |

### 7.3 Canary safety confirmations

- The canary runs in pure deterministic mode: no provider API calls, no production DB
  mutations, no live GitHub comment/close operations, no terminal-outbox ACK mutations,
  no broker restarts.
- The canary fixture is synthetic: it uses no real parent rounds, real issues, or real tokens.
- The canary output is redacted: it reports gate statuses, not raw payloads or secrets.
- Runtime/bootstrap hygiene is confirmed before canary execution: `AGENTS.md`, `SOUL.md`,
  `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, and `.openclaw/**` must not appear
  in the canary evidence payload.

### 7.4 Production enablement criteria

Production auto-closeout action execution may be enabled only when ALL of the following
are true:

1. The canary gate passes for all scenarios in §7.2 on a synthetic fixture.
2. At least one operator has reviewed and explicitly approved the reconciliation contract
   and canary results.
3. The broker of record confirms GitHub API write access for the production repo
   (permission check passes, no 403).
4. The go/no-go matrix is frozen at a version that includes `actionReconciliationGate`
   as a required gate.
5. Operator approval for each action kind (comment_post, issue_close) is separate and
   explicit.
6. Runtime/bootstrap hygiene is confirmed for the branch and all evidence artifacts.

---

## 8. Evidence requirements

A PR/Done closeout for this contract must provide:

| Evidence | Requirement |
|----------|-------------|
| Contract document path | `contracts/a2a/action-reconciliation.md` |
| Schema path | `docs/specs/a2a-action-reconciliation/schema.json` |
| Fixture path | `fixtures/contract/action-reconciliation.json` |
| Validation script path | `scripts/check-action-reconciliation.mjs` |
| Canary gate spec path | `docs/specs/a2a-action-reconciliation/canary-gate.md` |
| Runbook path | `docs/specs/a2a-action-reconciliation/runbook.md` |
| `parentRoundId` used in synthetic proof | `a2a-team1-auto-closeout-action-reconcile-20260520T180955Z` |
| Broker of record for the synthetic proof | `broker-alpha` |
| Redacted conformance output | Validation script output for all 8 canary scenarios |
| All gates pass claim | Matrix showing RECONCILED → APPROVED with operator approval |
| NO_GO / BLOCKED blocking proof | Matrix showing actions stay PENDING when matrix says NO_GO or BLOCKED |
| Idempotency replay suppression proof | `duplicateSuppressed: true` on replay |
| Idempotency conflict detection proof | `conflictDetected: true` on payload mismatch |
| GitHub 403 blocking proof | `github403Detected: true` with actions PENDING |
| Broker of record mismatch proof | `brokerOfRecordMismatch: true` with actions PENDING |
| Rollback/no-op proof | Rollback record shows `noAutoRetryOn403: true` |
| No live provider send | `liveProviderSend: false` on all records |
| No terminal-outbox ACK mutation | `terminalOutboxAckMutated: false` on all records |
| Runtime/bootstrap hygiene confirmation | Explicit confirmation that denyPaths are absent from branch diff and evidence |

---

## 9. Safety confirmations

```json
{
  "contractVersion": "v0",
  "frozenAt": "2026-05-20T18:09:55Z",
  "parentIssue": "https://github.com/jinwon-int/a2a-broker/issues/844",
  "childIssue": "a2a-plane#402 (internal tracker, private)",
  "parentRoundId": "a2a-team1-auto-closeout-action-reconcile-20260520T180955Z",
  "scope": "Cross-repo approval-gated auto-closeout action reconciliation: contract, runbook, canary gate",
  "syntheticFixtureOnly": true,
  "noProductionDeployOrRestart": true,
  "noProductionDatabaseMutation": true,
  "noLiveProviderSend": true,
  "noTerminalOutboxAckMutation": true,
  "noSecretRotationOrDisclosure": true,
  "noHostSpecificPrivatePath": true,
  "noProductionAutoCloseoutEnabled": true,
  "runtimeBootstrapHygieneRequiredBeforePublication": true,
  "operatorApprovalRequiredForProduction": true,
  "defaultReconciliationState": "PENDING",
  "failClosedOnConflict": true,
  "nonAckBoundary": "Action reconciliation records are non-terminal evidence of pending/approved/confirmed/rejected state. They are not approval, read receipt, or terminal ACK."
}
```
