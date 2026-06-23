# Approval-Gated Auto-Closeout Action Reconciliation Canary Gate

> No-live deterministic canary gate for the action reconciliation layer.
> Runs in pure synthetic mode: no provider API calls, no production DB mutations,
> no live GitHub comment/close operations, no terminal-outbox ACK mutations.

## Purpose

This canary gate verifies that the cross-repo action reconciliation layer (defined in
`contracts/a2a/action-reconciliation.md`) correctly maps go/no-go matrix decisions to
concrete closeout actions, respects approval boundaries, enforces idempotency, and
fail-closes on conflict or permission errors — before any production auto-closeout
action is enabled.

## Run

```sh
# Full canary (all 8 scenarios)
node scripts/check-action-reconciliation.mjs \
  --spec docs/specs/a2a-action-reconciliation/schema.json \
  --fixture fixtures/contract/action-reconciliation.json

# JSON output (for automation / evidence linking)
node scripts/check-action-reconciliation.mjs \
  --spec docs/specs/a2a-action-reconciliation/schema.json \
  --fixture fixtures/contract/action-reconciliation.json \
  --json
```

For a full pre-deploy check, also run the conformance suite:

```sh
npm run build  # if applicable
node test/conformance/check-contract-fixtures.mjs
npm test
```

Attach the command output to the PR/issue evidence comment. A passing canary reports
`canaryGate: PASS` for every scenario and confirms `liveProviderSend: false` and
`terminalOutboxAckMutated: false` for all records.

## Covered scenarios

| # | Scenario | Given | Expected |
|---|----------|-------|----------|
| 1 | **GO + actions reconciled** | Matrix GO, PENDING actions exist | Actions → RECONCILED; `expectedLastActionState: RECONCILED` |
| 2 | **NO_GO blocks reconciliation** | Matrix NO_GO (gate: e.g. `laneEvidenceCompleteness`) | Actions stay PENDING; `blockerMatrixDecision: NO_GO` surfaced |
| 3 | **BLOCKED blocks reconciliation** | Matrix BLOCKED (gate: e.g. `gitHubPermissionCheck`) | Actions stay PENDING; `operatorActionRequired: true` |
| 4 | **Operator approval required** | Matrix GO, actions RECONCILED but no approval | Matrix gate reports `actionReconciliationGate: PENDING_APPROVAL` |
| 5 | **Idempotency duplicate suppression** | Same action key+payload replayed after CONFIRMED | Returns `duplicateSuppressed: true`; no provider dispatch |
| 6 | **Idempotency conflict detection** | Same key, different payload | Returns `conflictDetected: true`; blocks dispatch |
| 7 | **GitHub 403 blocks all** | Permission check fails (403) for reconciling broker | All actions PENDING; `github403Detected: true` |
| 8 | **Broker of record mismatch** | Reconciling broker differs from brokerOfRecord | All actions PENDING; `brokerOfRecordMismatch: true` |

## Safety boundaries

This canary is intentionally pure and deterministic. It must remain safe to run in CI
and on an operator laptop without:

- GitHub API tokens or write access
- Broker database access or production configuration
- Any provider send, notification routing, or terminal-outbox mutation
- Service restarts or stateful side effects

## Production enablement gate

Passing this canary is a **necessary but not sufficient** condition for production
auto-closeout enablement. The full criteria are defined in
[§7.4 of the action reconciliation contract](../../../contracts/a2a/action-reconciliation.md).

## Relationship to other canaries

| Canary | Focus | This canary's dependency |
|--------|-------|--------------------------|
| Parent-round closeout go/no-go matrix | Gate evaluation for parent round closure | This canary consumes its output; does not depend on it to run |
| Receipt-gate no-live canary | Terminal-outbox receipt semantics | Independent — different concern |
| Wake-on-Task live canary | Real provider dispatch for Wake-on-Task | Independent — different concern |
| **Action reconciliation canary (this one)** | Action reconciliation between broker and plane | Own synthetic fixture; does not depend on other canaries |
