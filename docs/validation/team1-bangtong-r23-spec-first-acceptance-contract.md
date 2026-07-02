# Team1 workerGamma R23: Terminal Brief spec-first acceptance contract

Issue: a2a-plane#336 (a2a-plane#336, internal tracker private)
Parent: a2a-plane#335 (a2a-plane#335, internal tracker private)
Run: `a2a-r23-terminal-brief-spec-taskflow-monorepo-20260515T055352Z`
Parent round: `a2a-r23-terminal-brief-spec-taskflow-monorepo-20260515T055352Z`
Origin broker / finalizer: `brokerAlpha`
Lane: Team1/workerGamma
Order: 7/7
Round: A2A R23 — Terminal Brief spec-first TaskFlow automation and monorepo plan
Snapshot: `2026-05-15T06:08Z`

This is the Team1/workerGamma spec-first acceptance contract for Terminal Brief. It defines the canonical acceptance criteria for implementation lanes covering: states, ACK boundaries, provider-accepted evidence, concise titles, evidence body templates, fixtures, and compatibility gates. It references frozen contracts, fixtures, and conformance tests as binding acceptance evidence.

## Safety boundary

This lane does not deploy or restart Gateway/broker/worker, send a live provider/Telegram canary, open a broad cross-broker relay window, mutate production databases or terminal-outbox ACK rows, perform Terminal Brief ACK/replay or historical outbox replay, change secrets or repository visibility, publish a release/tag, rewrite history or force-push, or execute approval without fresh explicit operator approval. Provider accepted/message-id evidence is provider-accepted evidence only — never read/visibility/terminal ACK.

## Canonical acceptance model

The spec-first acceptance contract is organized into seven domains. Each domain references the definitive source contracts, fixtures, and conformance tests that constitute the acceptance evidence.

### 1. States acceptance

| Criterion | Acceptance edge | Source contract | Acceptance evidence |
|-----------|----------------|-----------------|---------------------|
| Terminal states are `done`, `pr`, `blocked`, `cancelled` | Any other state promoted to terminal violates the contract | `contracts/a2a/task-lifecycle.md` | `fixtures/contract/task-lifecycle.json` `terminalStates` field; conformance validates `allowedTransitions` for terminal states are empty |
| `cancelling` is non-terminal transitory; only `cancelled` is terminal | Code that treats `cancelling` as terminal or `cancelled` as non-terminal fails acceptance | `contracts/a2a/cancellation-idempotency.md` | `task-lifecycle.json` assertions check `cancelling is a non-terminal transitory state` |
| Cancellation from `queued` or `claimed` goes directly to `cancelled` (no `cancelling` intermediary) | Any implementation that introduces a transitory state between queued/claimed and cancelled fails | `contracts/a2a/cancellation-idempotency.md` | `task-lifecycle.json` `cancellationEvents` trace; conformance validates direct transition |
| Evidence kind enum is exactly `[blocked, done, pr]` | Unknown evidence kind passes projection but must not be used for canonical terminal closeout | `contracts/a2a/terminal-semantics.md` | `fixtures/contract/terminal-evidence.json` `evidence` array; conformance validates `evidenceKinds` |
| State machine transitions are closed under `queued → {blocked, cancelled, claimed}`, `claimed → {blocked, cancelled, running}`, `running → {blocked, cancelling}`, `cancelling → {cancelled}`, terminal states have no outgoing transitions | Any unrecognized transition is not spec-first and must be treated as an extension requiring explicit approval | `contracts/a2a/task-lifecycle.md` | `fixtures/contract/task-lifecycle.json` `allowedTransitions` map; `test/conformance/check-contract-fixtures.mjs` validates every event transition |

**Acceptance rule**: Implementations that introduce new terminal states, change allowed transitions, or promote non-terminal states to terminal must produce a v0→v1 contract change. A spec-first implementation that stays within the frozen v0 state model is accepted by fixture conformance alone.

### 2. ACK boundary acceptance

| Criterion | Acceptance edge | Source contract | Acceptance evidence |
|-----------|----------------|-----------------|---------------------|
| Four receipt levels: (1) accepted-send, (2) requester-visible, (3) operator-visible, (4) terminal ACK | Merging, skipping, or reordering levels invalidates acceptance | `contracts/a2a/terminal-semantics.md` (Receipt levels) | `fixtures/contract/terminal-evidence.json` `safetyConfirmations` |
| Provider-send success is level 1 (accepted-send) only | Any code path that promotes `providerAccepted`, `sendStatus:accepted`, or `sendStatus:sent` to terminal ACK fails acceptance | `contracts/a2a/terminal-semantics.md` (ACK boundary) | `fixtures/terminal-evidence/accepted-send-non-ack.json` scenarios; `test/conformance/check-terminal-evidence-ack-boundary.mjs` |
| Provider message IDs are non-ACK lifecycle evidence | Recording `providerMessageId` as terminal ACK evidence or using it to satisfy ACK requirements fails | `contracts/a2a/terminal-semantics.md` (ACK boundary) | `accepted-send-non-ack.json` `nonAckSignals` includes `providerMessageId` |
| Terminal-outbox ACK mutation requires explicit operator approval | Any automated or implicit terminal ACK mutation without documented operator approval fails | `contracts/a2a/terminal-semantics.md` (Safety gates) | `terminal-evidence.json` `terminalOutboxAckMutated: false` on all entries |
| ACK-safe receipt types: `manual_operator_receipt`, `current_session_visible` | Any other value treated as ACK-safe fails acceptance | `contracts/a2a/github-evidence-projection.md` | `github-evidence-projection.json` `ackSafeReceiptTypes`; conformance validates boundaries |
| GitHub comment URL is NOT ACK-safe | Implementation that uses `githubCommentUrl` as terminal ACK fails | `contracts/a2a/github-evidence-projection.md` | `github-evidence-projection.json` `nonAckSignals` includes `githubCommentUrl` |

**Acceptance rule**: An implementation that preserves the four-level receipt hierarchy without promoting lower-level signals to terminal ACK, and never mutates terminal-outbox ACK without operator approval, is accepted at the ACK boundary.

### 3. Provider-accepted evidence acceptance

| Criterion | Acceptance edge | Source contract | Acceptance evidence |
|-----------|----------------|-----------------|---------------------|
| Provider evidence class is `accepted-send` when provider accepted payload and returned message ID but no receipt evidence exists | Any system mapping `accepted-send` evidence to terminal ACK or read receipt fails | `contracts/compatibility/terminal-evidence-ack-boundary.md` | `fixtures/terminal-evidence/accepted-send-non-ack.json` scenarios with `evidenceClass: 'accepted-send'` |
| Evidence class is `ack-safe-receipt` when receipt evidence type is in `ackSafeReceiptTypes` | Receipt evidence with an unknown type is not ACK-safe | `contracts/compatibility/terminal-evidence-ack-boundary.md` | `accepted-send-non-ack.json` scenarios with `evidenceClass: 'ack-safe-receipt'` |
| Provider evidence must be redacted: no secrets, private endpoints, raw session dumps, host paths | Any fixture or evidence that contains unredacted private data fails acceptance | `contracts/a2a/terminal-semantics.md` (Safety gates) | `fixtures/contract/terminal-evidence.json` `redacted: true`; conformance pattern-matches secrets |
| `liveProviderSend` must be `false` in redacted evidence | Any fixture or evidence with `liveProviderSend: true` outside live-canary contexts fails | `contracts/a2a/terminal-semantics.md` | `terminal-evidence.json` `liveProviderSend: false` on all entries |

**Acceptance rule**: Provider-accepted evidence is valid when: the evidence class is correctly assigned (accepted-send vs ack-safe-receipt), the evidence is redacted, no terminal-outbox ACK mutation was performed, and no live provider send was executed.

### 4. Concise title acceptance

| Criterion | Acceptance edge | Source contract | Acceptance evidence |
|-----------|----------------|-----------------|---------------------|
| Title format: `A2A Terminal Brief <상태>: <worker>(<order>/<assignedChildTaskTotal>)` | Any deviation from format fails acceptance | `contracts/a2a/parent-terminal-brief-aggregation.md` (Concise title semantics) | `fixtures/contract/parent-terminal-brief-aggregation.json` `titleFormat` |
| Status label is Korean: `완료` | English or mixed-language status labels fail | `contracts/a2a/parent-terminal-brief-aggregation.md` | Documented in contract examples |
| Maximum title length ≤ 80 characters | Title exceeding 80 chars fails | `contracts/a2a/parent-terminal-brief-aggregation.md` | `parent-terminal-brief-aggregation.json` title constraints |
| Denominator is the broker-assigned child task total for this round, NOT a global constant | Implementation that hardcodes total or uses wrong total fails | `contracts/a2a/parent-terminal-brief-aggregation.md` | `parent-terminal-brief-aggregation.json` metadata lifecycle |
| Title must not contain: task IDs, child issue URLs, PR/Done/Block URLs, evidence body, broker IDs, provider message IDs, receipt state, ACK state, raw logs, secrets, private paths, runtime/bootstrap file names | Any forbidden content in title fails acceptance | `contracts/a2a/parent-terminal-brief-aggregation.md` (Title constraints) | `parent-terminal-brief-aggregation.json` forbidden content lists |
| Title is separate from body/evidence — never concatenated | Concatenated title+body fails acceptance | `contracts/a2a/parent-terminal-brief-aggregation.md` (Body/evidence separation) | Conformance for title/body separation |

**Acceptance rule**: A concise title is accepted when it matches the format spec, stays within length constraints, uses the correct status label, references the correct per-round total, excludes forbidden content, and is stored/transmitted separately from the evidence body.

### 5. Evidence body templates acceptance

| Criterion | Acceptance edge | Source contract | Acceptance evidence |
|-----------|----------------|-----------------|---------------------|
| Done body: `kind: done`, `summary`, `changedFiles` (may be empty), `checksRun`, `safetyConfirmed: true`, `redacted: true` | Missing required fields in Done evidence body fails | `contracts/a2a/terminal-semantics.md` (Result types); `contracts/a2a/fixtures/terminal-evidence-examples.json` | `terminal-evidence-examples.json` Done example |
| PR body: `kind: pr`, `prUrl`, `summary`, `changedFiles`, `rootCheck` (no OpenClaw bootstrap files), `safetyConfirmed: true`, `redacted: true` | Missing `rootCheck` or `prUrl` in PR body fails | `contracts/a2a/terminal-semantics.md` | `terminal-evidence-examples.json` PR example; `github-evidence-projection.json` manifest binding |
| Block body: `kind: blocked`, `blockerCategory` (one of known categories), `reason` (redacted), `redactedEvidence` (redacted description), `safetyConfirmed: true`, `redacted: true` | Missing `blockerCategory` or unredacted reason fails | `contracts/a2a/terminal-semantics.md` | `terminal-evidence-examples.json` Blocked example |
| GitHub comment evidence body follows manifest-bound template: manifest digest, compact summary, check results, safety confirmation, no secrets | Comment without manifest reference or with unredacted content fails | `contracts/a2a/github-evidence-projection.md` (Manifest-bound, Redacted sections) | `fixtures/terminal-evidence/github-comment-projection.json` example |
| Evidence body must be stored/transmitted separately from the terminal brief title | Concatenated title+body in any data path fails | `contracts/a2a/parent-terminal-brief-aggregation.md` (Body/evidence separation) | Parent aggregation fixture |

**Acceptance rule**: An evidence body template is accepted when it includes all required fields for the evidence kind, is redacted, is stored separately from the title, and for GitHub projection includes a manifest reference.

### 6. Fixture acceptance

| Criterion | Acceptance edge | Source contract | Acceptance evidence |
|-----------|----------------|-----------------|---------------------|
| Every contract fixture must carry `v0Freeze` with `frozenAt` and `round` | Fixture without v0Freeze is not a frozen contract fixture | `contracts/a2a/README.md` (v0 Freeze) | `test/conformance/check-contract-fixtures.mjs` validates `v0Freeze` on all fixtures |
| Contract fixture registry is defined in `test/conformance/check-contract-fixtures.mjs` `fixtureFiles` | New fixture not registered in the conformance checker is not part of the canonical acceptance contract | N/A (convention) | `check-contract-fixtures.mjs` imports every fixture |
| Fixtures must not contain OpenClaw runtime/bootstrap paths (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`) | Any fixture referencing bootstrap paths fails | `contracts/a2a/terminal-semantics.md` (Safety gates) | Conformance scans all fixture text for forbidden paths |
| Fixtures must not contain secret-like patterns (GitHub tokens, Slack tokens, private keys, host paths) | Any fixture containing secret-like patterns fails | `contracts/a2a/terminal-semantics.md` (Safety gates) | Conformance pattern-matches each fixture |
| Terminal evidence fixtures must have `terminalOutboxAckMutated: false` and `liveProviderSend: false` | Fixture with `true` for either field must have explicit justification and be outside v0 freeze | `contracts/a2a/terminal-semantics.md` | Conformance validates every evidence entry |
| Fixture schema matches its source contract | Mismatch between fixture shape and contract spec fails | Per-contract schema | Conformance validates field-by-field |

**Acceptance rule**: A fixture is accepted when it carries v0Freeze, is registered in the conformance checker, passes hygiene scans for bootstrap paths and secrets, and its internal invariants match the conformance assertions.

### 7. Compatibility gates acceptance

| Criterion | Acceptance edge | Source contract | Acceptance evidence |
|-----------|----------------|-----------------|---------------------|
| Cross-broker handoff carries `parentRoundId`, `originBrokerId`, `brokerOfRecord`, `destinationBrokerId` | Missing any required handoff metadata field fails compatibility | `contracts/a2a/broker-handoff-protocol.md` | `fixtures/contract/brokerBeta-cross-broker-handoff.json` |
| Second-worker compatibility proofs must reference registered workers | Proof without matching registered worker name fails | `fixtures/contract/worker-registration-capabilities.json` | `check-contract-fixtures.mjs` validates `workerNames` |
| Compatibility proofs must not require `liveProviderSend`, `terminalAckMutation`, or `privateTopology` | Proof with any of these set `true` fails compatibility gate | `contracts/a2a/worker-registration.md` | Worker conformance checks `requiresPrivateTopology`, `liveProviderSend`, `terminalAckMutation` |
| Public compatibility policy enumerates safe boundaries | Missing policy or policy with undefined boundaries fails | `contracts/a2a/r20-stability-gate.md` | `fixtures/contract/public-compatibility-policy.json` |
| All compatibility-gated samples must pass the same conformance checker | Sample that fails `check-contract-fixtures.mjs` is not a valid compatibility artifact | `test/conformance/check-contract-fixtures.mjs` | Every compatibility proof references the validation command |

**Acceptance rule**: A compatibility gate is accepted when all required metadata fields are present in cross-broker handoffs, proofs reference registered workers, no live/sensitive operations are required, the policy is enumerated, and all samples pass the conformance checker.

---

## Acceptance gate checklist

| Gate ID | Gate | Pass condition | Fail / NO-GO condition | Acceptance evidence |
|---------|------|----------------|------------------------|---------------------|
| A1 | Terminal states acceptance | v0 state model preserved: terminal states = done/pr/blocked/cancelled; cancelling is transitory; transitions match frozen spec | New terminal state, removed state, or changed freezing-violating transition | `fixtures/contract/task-lifecycle.json`, conformance pass |
| A2 | ACK boundary acceptance | Four receipt levels preserved; provider evidence never promoted to ACK; terminal-outbox ACK not mutated | Any receipt-level conflation or implicit ACK | `fixtures/terminal-evidence/accepted-send-non-ack.json`, conformance pass |
| A3 | Provider evidence acceptance | evidenceClass correctly assigned; evidence redacted; no liveProviderSend; no terminalOutboxAckMutation | Wrong evidence class, unredacted data, live provider send | `fixtures/contract/terminal-evidence.json`, conformance pass |
| A4 | Concise title acceptance | Title matches format `A2A Terminal Brief <상태>: <worker>(<order>/<total>)`; ≤80 chars; Korean status; correct per-round total; no forbidden content; title separate from body | Format deviation, length violation, wrong language, wrong total, forbidden content, concatenated title+body | `contracts/a2a/parent-terminal-brief-aggregation.md`, `parent-terminal-brief-aggregation.json` |
| A5 | Evidence body template acceptance | Each evidence kind has required fields present; body is redacted; body separate from title; GitHub comment body manifest-bound | Missing required field, unredacted data, concatenated body, unbound comment | `contracts/a2a/fixtures/terminal-evidence-examples.json`, `github-evidence-projection.md` |
| A6 | Fixture acceptance | v0Freeze present on all fixtures; registered in conformance checker; hygiene scans pass; invariants match contract | Missing v0Freeze, unregistered fixture, hygiene failure, invariant mismatch | `test/conformance/check-contract-fixtures.mjs` pass, `test/conformance/check-terminal-evidence-ack-boundary.mjs` pass |
| A7 | Compatibility gate acceptance | Handoff metadata fields present; workers registered; no live/sensitive operations required; policy enumerated; all samples conformance-checked | Missing metadata, unregistered worker, live-sensitive requirement, missing policy, conformance failure | `fixtures/contract/brokerBeta-cross-broker-handoff.json`, `worker-registration-capabilities.json`, conformance pass |
| A8 | Runtime/bootstrap hygiene | No OpenClaw context files in branch diff; no secrets in evidence | Any bootstrap file or secret pattern in diff | Pre-publication scan |
| A9 | Safety confirmation | No approval-gated action performed without explicit operator approval | Any unapproved live action | This document |

---

## GO/NO-GO decision matrix

| Aggregate state | Required gates | Allowed closeout |
|----------------|----------------|------------------|
| `GO for acceptance contract` | A1–A7 pass with linked contract/fixture/conformance evidence; A8 hygiene clean; A9 safety confirmed | PR/Done evidence may say the spec-first acceptance contract is defined and validated against existing fixtures and conformance tests. Implementation lanes reference this contract as acceptance criteria. |
| `GO_CANDIDATE / Needs operator review` | A1–A6 pass, A7 documented, A8 clean, A9 not violated, but some implementation-specific edge cases remain unresolved or depend on broker-specific runtime behavior. | PR/Done evidence may request finalizer review; must not claim full acceptance coverage for all implementation scenarios. |
| `NO-GO / Waiting` | Any gate has Start-only or missing evidence; fixture or conformance results cannot be obtained; acceptance criteria ambiguous. | Block evidence documenting the specific gate and what resolution is needed. |
| `BLOCK` | Safety gate violation: bootstrap files in branch, secret leak, unapproved live action, or contradictory acceptance criteria across contracts. | Stop and report exact violation, file path, and rejection rationale. |

### Current aggregate decision

**Decision: `GO` for the spec-first acceptance contract definition.**

The seven-domain acceptance model is defined and cross-referenced against existing frozen contracts, fixtures, and conformance tests. Each acceptance gate has a clear pass/fail condition and maps to concrete acceptance evidence.

This acceptance contract serves as the authoritative acceptance criteria for Terminal Brief implementation lanes in the R23 round and beyond. Implementation teams use the seven acceptance domains and their gate checklist to validate that their work meets the spec-first standard.

---

## Per-child title examples (R23 round, 7 children)

| Order | Worker | Team | Broker of record | Concise title |
|-------|--------|------|------------------|---------------|
| 1 | `workerEta` | Team2 | `brokerBeta` (handoff) | `A2A Terminal Brief 완료: workerEta(1/7)` |
| 2 | `workerEpsilon` | Team2 | `brokerBeta` (handoff) | `A2A Terminal Brief 완료: workerEpsilon(2/7)` |
| 3 | `workerZeta` | Team2 | `brokerBeta` (handoff) | `A2A Terminal Brief 완료: workerZeta(3/7)` |
| 4 | `n/a` | Team1 | `brokerAlpha` | `A2A Terminal Brief 완료: n/a(4/7)` |
| 5 | `n/a` | Team1 | `brokerAlpha` | `A2A Terminal Brief 완료: n/a(5/7)` |
| 6 | `n/a` | Team1 | `brokerAlpha` | `A2A Terminal Brief 완료: n/a(6/7)` |
| 7 | `workerGamma` | Team1 | `brokerAlpha` | `A2A Terminal Brief 완료: workerGamma(7/7)` |

Title constraints verified for every row:
- Source: parent broker (`brokerAlpha`) aggregation ledger, not child issue body or child broker local state.
- Maximum length: ≤80 characters.
- Forbidden content: no task IDs, child issue URLs, PR/Done/Block URLs, evidence body, child broker ID, handoff broker ID, provider message ID, receipt state, ACK state, raw logs, secrets, private paths, or runtime/bootstrap file names.
- Status label: `완료` (Korean).
- Not proof of: provider delivery, operator receipt, approval, or terminal-outbox ACK.

---

## Residual risk matrix

| Risk area | Acceptance requirement | Current risk posture | Fail-closed condition |
|-----------|----------------------|---------------------|-----------------------|
| State model drift | Implementation that extends or changes the v0 state model must produce a contract change | v0 frozen; conformance validates state model | Implementation introduces new terminal state or transition without contract change |
| ACK boundary erosion | Provider evidence stays at level 1 (accepted-send); no implicit termination | v0 frozen; fixture proves non-ACK boundary | Any code path promotes accepted-send to ACK |
| Title total misassignment | Denominator is per-round, not global; each round's total from broker metadata | Contract and examples document per-round semantics | Hardcoded total; wrong total; no per-round metadata |
| Evidence body leak | Title/body separation enforced; no secret content in body | Contract and fixtures enforce separation | Concatenated title+body; unredacted content in body |
| Fixture rot | Fixtures match current contracts; conformance passes | Continuous conformance check | Stale fixture not updated after contract change |
| Hygiene failure | Bootstrap paths and secrets absent from branch/artifacts | Pre-publication scan | Context file or secret enters branch diff |

---

## Safety confirmation

This lane:

- Did not deploy or restart any Gateway, broker, or worker service.
- Did not mutate production databases or terminal-outbox ACK rows.
- Did not send any live provider or Telegram message beyond normal A2A task completion notifications.
- Did not perform Terminal Brief ACK/replay or historical outbox replay.
- Did not open a broad cross-broker relay window.
- Did not change secrets, repository visibility, or release state.
- Did not rewrite history or force-push.
- Did not execute approval without fresh explicit operator approval.
- Provider accepted/message-id evidence is provider-accepted evidence only, never read/visibility/terminal ACK.
- Used redacted repository evidence only (contracts, fixtures, conformance test output, validation documents).
- Confirmed runtime/bootstrap hygiene before evidence publication (guard paths absent).

## Runtime/bootstrap and artifact hygiene gate

Before PR/Done/Block evidence publication, fail closed if any OpenClaw runtime/bootstrap context file would enter the branch diff. Offending paths:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

### Hygiene scan result (this run)

Guard scan performed at snapshot time on branch `a2a-patch-20260515-060858-23cc5ec0-c7b2-4ba2-8abe-c5c26e381dba`:

Result: **PASS** — no guard paths detected in branch diff or staged changes.

## Reference map

| Domain | Primary contract(s) | Primary fixture(s) | Conformance test(s) |
|--------|---------------------|--------------------|----------------------|
| States | `contracts/a2a/task-lifecycle.md`, `contracts/a2a/cancellation-idempotency.md` | `fixtures/contract/task-lifecycle.json`, `fixtures/contract/cancellation-idempotency.json` | `test/conformance/check-contract-fixtures.mjs` |
| ACK boundaries | `contracts/a2a/terminal-semantics.md` | `fixtures/terminal-evidence/accepted-send-non-ack.json`, `fixtures/terminal-evidence/github-comment-projection.json` | `test/conformance/check-terminal-evidence-ack-boundary.mjs` |
| Provider evidence | `contracts/a2a/terminal-semantics.md`, `contracts/compatibility/terminal-evidence-ack-boundary.md` | `fixtures/contract/terminal-evidence.json` | `test/conformance/check-contract-fixtures.mjs` |
| Concise titles | `contracts/a2a/parent-terminal-brief-aggregation.md` | `fixtures/contract/parent-terminal-brief-aggregation.json` | `test/conformance/check-contract-fixtures.mjs` |
| Evidence templates | `contracts/a2a/terminal-semantics.md`, `contracts/a2a/github-evidence-projection.md` | `contracts/a2a/fixtures/terminal-evidence-examples.json` | N/A (structural reference) |
| Fixtures | `contracts/a2a/README.md` | All `fixtures/contract/*.json`, `fixtures/terminal-evidence/*.json` | `test/conformance/check-contract-fixtures.mjs`, `check-terminal-evidence-ack-boundary.mjs` |
| Compatibility gates | `contracts/a2a/broker-handoff-protocol.md`, `contracts/a2a/worker-registration.md` | `fixtures/contract/brokerBeta-cross-broker-handoff.json`, `worker-registration-capabilities.json` | `test/conformance/check-contract-fixtures.mjs` |

## Local validation commands

```bash
# Contract fixture conformance (primary)
node test/conformance/check-contract-fixtures.mjs

# Terminal evidence ACK boundary
node test/conformance/check-terminal-evidence-ack-boundary.mjs

# GitHub evidence projection conformance
node test/conformance/check-github-evidence-projection.mjs

# Quickstart conformance
node scripts/check-quickstart-conformance.mjs
```

## Closeout boundary

This lane publishes PR evidence for the spec-first acceptance contract document. It defines the canonical acceptance criteria for Terminal Brief implementation lanes. It does not claim implementation completion, live automation GO, canary authorization, deploy/reload approval, terminal ACK/read receipt, or source-public/visibility approval. The `/7` denominator is the R23 broker-assigned child task total, not a global constant.
