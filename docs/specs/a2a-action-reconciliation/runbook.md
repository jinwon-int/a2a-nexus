# Approval-Gated Auto-Closeout Action Reconciliation Operator Runbook

> Operator-facing runbook for the cross-repo approval-gated auto-closeout action
> reconciliation layer. Covers canary execution, approval flow, rollback, and
> production enablement procedures.

**Contract:** `contracts/a2a/action-reconciliation.md`
**Schema:** `docs/specs/a2a-action-reconciliation/schema.json`
**Canary gate:** `docs/specs/a2a-action-reconciliation/canary-gate.md`
**Broker reconciler:** `packages/broker/src/core/closeout-reconciler.ts`
**Parent issue:** [a2a-broker#844](https://github.com/jinwon-int/a2a-broker/issues/844)
**Child issue:** a2a-plane#402 (a2a-plane#402, internal tracker private)

---

## 1. Preflight: Runtime/bootstrap hygiene check

Before running any canary, creating any evidence, or publishing any artifact, run:

```sh
git status --short
git diff --name-only HEAD --
```

Then explicitly confirm these paths are **absent** from branch diffs, canary evidence,
and any artifact evidence:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

If any listed path appears, **stop** and post **Block** evidence with the exact
repo-relative offending paths. Do not proceed until they are removed.

---

## 2. Canary execution

### 2.1 Preconditions

- [ ] Repository is checked out on the target branch.
- [ ] All contract, schema, fixture, and validation script files exist in the expected paths.
- [ ] No runtime/bootstrap hygiene violations (see §1).
- [ ] Operator has reviewed the contract (`contracts/a2a/action-reconciliation.md`) and
      agreed to the boundaries.

### 2.2 Run the synthetic canary

```sh
node scripts/check-action-reconciliation.mjs \
  --spec docs/specs/a2a-action-reconciliation/schema.json \
  --fixture fixtures/contract/action-reconciliation.json
```

Expected output: `canaryGate: PASS` for all 8 scenarios.

For machine-readable evidence:

```sh
node scripts/check-action-reconciliation.mjs \
  --spec docs/specs/a2a-action-reconciliation/schema.json \
  --fixture fixtures/contract/action-reconciliation.json \
  --json
```

### 2.3 Redact evidence

Post only the following in the evidence comment:

- Command exit status and summary line (`canaryGate: PASS`)
- For each scenario: name, expected state, actual state, pass/fail
- Count of passed / total scenarios
- Confirmation that `liveProviderSend: false` and `terminalOutboxAckMutated: false`
  on all records
- Confirmation that runtime/bootstrap hygiene passed: no deny paths in branch diff
- The `parentRoundId` and `brokerOfRecord` used in the fixture

Do **not** include:
- Raw JSON dumps with full payload hashes
- Host-specific private paths
- Provider identifiers or API tokens
- Full session transcripts or raw logs

---

## 3. Approval flow

### 3.1 Requesting operator approval

When a reconciliation record has actions in `RECONCILED` state, post an approval
request that includes:

1. The exact `parentRoundId`
2. Action kind(s) requiring approval (`comment_post`, `issue_close`)
3. Broker of record
4. Reconciliation record id
5. Link to canary gate results showing `actionReconciliationGate` status
6. Link to go/no-go matrix output for the parent round
7. Confirmation of GitHub permission check (no 403)
8. Confirmation of runtime/bootstrap hygiene

### 3.2 Approving

The operator must post a comment that explicitly includes all of:

1. ✅ **Repository name:** `a2a-plane (internal tracker, private)` (or applicable)
2. ✅ **Approved parent round id:** exact `parentRoundId` from the request
3. ✅ **Approved action kind(s):** `comment_post` and/or `issue_close`
4. ✅ **Broker of record:** `broker-alpha` or `broker-beta`
5. ✅ **Scope exclusions:** confirms this approval does not authorize deploy, restart,
    production DB mutation, provider send (other than the approved closeout action),
    terminal-outbox ACK mutation, secret rotation, visibility change, force-push,
    or release
6. ✅ **Evidence link:** URL to the redacted canary output and go/no-go matrix

If any element is missing, record the reconciliation record as `PENDING` and do not
transition to `APPROVED`.

### 3.3 After approval

Once the operator approval comment is recorded:

1. Register the idempotency key for each approved action.
2. Transition each action from `RECONCILED` to `APPROVED`.
3. Execute the action (dispatch to GitHub API for `comment_post` / `issue_close`).
4. On provider success, transition from `DISPATCHED` to `CONFIRMED`.
5. Post evidence of the confirmed action.

---

## 4. Rollback procedures

### 4.1 Rollback: Comment posted but should not have been

| Step | Action | Safety gate |
|------|--------|-------------|
| 1 | Do not delete or edit the posted comment. | GitHub issue history should not be rewritten. |
| 2 | Record a new reconciliation record of kind `rollback_record`. | New record gets its own idempotency key. |
| 3 | Set `rollbackType: metadata-only` on the original comment_post record. | Original CONFIRMED record is preserved for audit. |
| 4 | No-op on issue_close if it was also queued. | Mark issue_close as "no-close" via metadata update. |
| 5 | Post an operator-visible note explaining the rollback. | Include link to original comment and rationale. |

### 4.2 Rollback: Wrong metadata updated

| Step | Action | Safety gate |
|------|--------|-------------|
| 1 | Reset metadata to pre-reconciliation value. | Must not touch provider state. |
| 2 | Record rollback with `rollbackType: metadata-only`. | No external side effect. |
| 3 | Verify no other reconciliation records were affected. | Check all sibling actions for the same parentRoundId. |

### 4.3 Rollback: Idempotency key registered but action not yet APPROVED

| Step | Action | Safety gate |
|------|--------|-------------|
| 1 | Delete the idempotency key. | No external state affected. |
| 2 | Revert action to `PENDING`. | Preserves action intent for future approval. |
| 3 | Notify operator that action was reset. | Include record id and parentRoundId. |

### 4.4 Rollback: Action APPROVED but not yet DISPATCHED

| Step | Action | Safety gate |
|------|--------|-------------|
| 1 | Revoke approval: set action to `PENDING`, not `REJECTED`. | RECONCILED → APPROVED requires explicit approval. |
| 2 | Delete the registered idempotency key. | Prevents stale key from blocking future approval. |
| 3 | Operator must explicitly approve the revocation in writing. | Approval revocation is separate from original approval. |
| 4 | Post evidence of the reset state. | Includes record id, old state, new state, timestamp. |

### 4.5 Rollback: Action FAILED from provider error

| Step | Action | Safety gate |
|------|--------|-------------|
| 1 | Leave action as `FAILED`. | No auto-retry. |
| 2 | Operator reviews the failure reason. | Identify root cause (permissions, rate limit, payload issue). |
| 3 | If retry is warranted, post a comment authorizing the retry. | Must name the exact record id and retry rationale. |
| 4 | Reset action to `PENDING` with new idempotency key. | Old key is retired; new key prevents replay of old payload. |
| 5 | Re-run the approval flow from §3. | Full approval cycle for the retried action. |

### 4.6 Rollback: Comment posted with wrong payload

| Step | Action | Safety gate |
|------|--------|-------------|
| 1 | Do not delete or edit the wrong comment. | GitHub issue history should not be rewritten. |
| 2 | Post a **correcting comment** on the same issue. | New comment is a new action with its own record and approval. |
| 3 | Record the correction as a new reconciliation record. | New action requires its own operator approval (§3). |
| 4 | Link the correction record to the original record via `conflictingRecordId`. | Audit trail shows the correction history. |

---

## 5. Production enablement checklist

Use this checklist before enabling any production auto-closeout action.

### 5.1 Pre-enablement checks

- [ ] Canary gate passes all 8 scenarios on synthetic fixture.
- [ ] At least one operator has reviewed and explicitly approved the action
      reconciliation contract (comment on the child issue).
- [ ] Go/no-go matrix contract (frozen version) includes `actionReconciliationGate`
      as a required gate.
- [ ] Broker of record confirms GitHub API write access for the production repo
      (no 403 on permission check).
- [ ] Operator approval obtained for each production auto-closeout action kind:
      - Comment post approval: ___ (link)
      - Issue close approval: ___ (link)
- [ ] Runtime/bootstrap hygiene confirmed for the release branch and all evidence.
- [ ] Reconciliation idempotency keys registered and verified.
- [ ] Rollback procedures are documented and operator-confirmed.
- [ ] Production issue selected for the first auto-closeout action.
- [ ] Fail-closed behavior verified: if GitHub 403 occurs during first action,
      the reconciliation layer blocks all sibling actions and surfaces operator
      action required.

### 5.2 First production action execution

1. Tag the first production issue for auto-closeout.
2. Ensure operator is available to monitor the first action.
3. Execute the comment_post action:
   - Dispatch the approved reconciliation action.
   - Verify the comment appears on the issue.
   - Confirm reconciliation record transitions to CONFIRMED.
4. After comment is confirmed, execute issue_close:
   - Dispatch the approved reconciliation action.
   - Verify the issue is closed.
   - Confirm reconciliation record transitions to CONFIRMED.
5. Post evidence of both actions to the child issue.
6. If any step fails, follow rollback procedures (§4) and do not proceed until
   the failure is resolved.

### 5.3 Post-enablement verification

- [ ] Reconciliation records show `CONFIRMED` for all actions.
- [ ] `liveProviderSend: false` for all metadata-only actions.
- [ ] `terminalOutboxAckMutated: false` for all records.
- [ ] No orphaned idempotency keys or PENDING actions remain.
- [ ] Broker health check passes.
- [ ] Plane go/no-go matrix reflects the completed closeout.

---

## 6. Fail-closed scenarios

| Scenario | Operator action |
|----------|----------------|
| Canary fails on scenarios 1-4 | Fix reconciliation logic and re-run canary before any production action. |
| Canary fails on scenarios 5-6 | Fix idempotency key handling; verify key derivation matches contract. |
| Canary fails on scenario 7 | Check GitHub token permissions; verify permission check is wired. |
| Canary fails on scenario 8 | Verify broker of record field is populated correctly in reconciliation records. |
| Approval request missing required fields | Request clarification from operator; do not infer missing fields. |
| GitHub 403 during first production action | Follow rollback §4.5; do not retry without operator approval. |
| Idempotency key collision with different payload | Follow rollback §4.6; do not overwrite the existing record. |
| Runtime/bootstrap hygiene violation | Block all actions; remove violating files; re-run hygiene check. |

---

## 7. Evidence comment template

```markdown
Done: Approval-gated auto-closeout action reconciliation

Parent issue: <url>
Child issue: <url>

### Canary results

- Scenario 1 (GO + actions reconciled): PASS — RECONCILED
- Scenario 2 (NO_GO blocks): PASS — PENDING
- Scenario 3 (BLOCKED blocks): PASS — PENDING
- Scenario 4 (approval required): PASS — PENDING_APPROVAL
- Scenario 5 (idempotency duplicate): PASS — duplicateSuppressed
- Scenario 6 (idempotency conflict): PASS — conflictDetected
- Scenario 7 (GitHub 403): PASS — github403Detected
- Scenario 8 (broker mismatch): PASS — brokerOfRecordMismatch

Summary: 8/8 PASS — canaryGate: PASS

### Safety confirmations

- liveProviderSend: false (all records)
- terminalOutboxAckMutated: false (all records)
- Runtime/bootstrap hygiene: PASS (no deny paths in branch diff)

### Links

- Contract: contracts/a2a/action-reconciliation.md
- Schema: docs/specs/a2a-action-reconciliation/schema.json
- Fixture: fixtures/contract/action-reconciliation.json
- Validation script: scripts/check-action-reconciliation.mjs
- Canary gate spec: docs/specs/a2a-action-reconciliation/canary-gate.md
- Runbook: docs/specs/a2a-action-reconciliation/runbook.md
- Canary output: <url>
- Operator approval: <url>

### Rollback readiness

- Rollback procedures documented in runbook §4
- No live provider send occurred
- No production DB/state mutated
```
