# A2A Operator Guide

> **Status:** current public-alpha operator guide. It is source-only and no-live; it does not authorize deployment, restart, release, publication, promotion, visibility, secret, DB/outbox/ACK/replay, provider-send, or history-rewrite actions.

## Roles

| Role | Responsibility | Boundary |
| --- | --- | --- |
| `operator` | Grants explicit approval for approval-sensitive actions when the action, target, and rollback/no-op boundary are named. | Ordinary issue/PR discussion, A2A worker output, and local tests are not approval. |
| `finalizer` | Closes PR/issue evidence loops, verifies CI/local gates, checks no-live boundaries, and confirms whether operator approval records exist. | The finalizer does not inherit operator authority from CODEOWNERS, package ownership, or worker assignment. |

Role changes must be made by repository administrators through an explicit commit or settings change. Public records should use role names and GitHub review context rather than personal messaging channels.

## Operator Decision Points

The operator must explicitly approve any action that changes runtime, release, visibility, promotion, external publication, or canonical source authority. Planning alone is not that approval.

Separate approval is required for:

- canonical source flip;
- branch protection or required-check mutation;
- repository archive, transfer, or visibility change;
- release tag, GitHub Release, npm publish, Docker publish, or GHCR publish;
- production deploy, Gateway restart, broker restart, or worker restart;
- database, queue, terminal-outbox, or Terminal ACK/replay mutation;
- provider, Telegram, notification, homepage, or external-promotion sends/metadata changes;
- credential movement, rotation, or disclosure;
- history rewrite, force push, or destructive cleanup.

## Current Operator Reading Order

1. [`README.md`](../README.md) for the public-alpha summary and safe local evaluation path.
2. [`quickstart.md`](quickstart.md) for a disposable loopback broker/worker path.
3. [`architecture.md`](architecture.md) and [`positioning.md`](positioning.md) for public-safe project framing.
4. [`release-readiness.md`](release-readiness.md) and [`release-checklist.md`](release-checklist.md) for release/package readiness criteria.
5. [`external-listings.md`](external-listings.md) for the gated external directory workflow.
6. [`history/README.md`](history/README.md) for completed migration and rehearsal records.
7. [`pr-review-guardrails.md`](pr-review-guardrails.md) before assisted PR review or merge batches.

## Finalizer Boundary

CODEOWNERS routes review attention. It does not move finalizer authority to A2A workers or package owners. A finalizer remains responsible for closeout judgment, no-live boundary checks, and operator sign-off evidence.

Before closing an issue or merging a closeout PR, the finalizer must compare every issue checklist item and acceptance criterion against concrete artifacts. Bulk closeout is a NO-GO unless the finalizer writes an issue-by-issue disposition that names completed items, deferred follow-ups, and skipped approval-sensitive actions. For A2A rounds, the default mapping is one implementation lane to one PR; consolidating lanes into one PR requires an explicit finalizer note explaining why review coverage is preserved.

This rule is machine-monitored (#1210): the scheduled [`closeout-hygiene`](../.github/workflows/closeout-hygiene.yml) workflow runs `scripts/check-issue-closeout-hygiene.mjs` and fails on issues closed as completed with unchecked task-list items. Deviations require the `closeout-exception` label plus an item-by-item disposition comment before close. Disposition comments are themselves checked: `scripts/check-disposition-references.mjs` (same workflow) fails when a disposition cites a PR, workflow run, or repo path that does not exist — a reconciliation that points at nothing is not a reconciliation (#1220).

### Finalizer judgment rules (#1220)

- **Oracle independence.** Never judge a round with a detector or gate that the same round built — the detector's blind spots are the implementation's blind spots (#1194 RC-A; observed in #1204). The reference for completion is always the issue's own acceptance criteria, read from the issue text.
- **Standard rejection reasons.** A PR that adds a new gate, scanner rule, or test without a red→green log (the check failing on the pre-change tree) is returned, not merged. A task whose spec demands mutation evidence is returned without the mutation log. These are standard dispositions, not discretionary calls.
- **Verification methodology.** When judging that an artifact is absent, sweep synonyms before concluding (a doc named `process-local-*` satisfies a "per-process" requirement), and trace config-layer defaults before reading runtime conditionals as opt-in (`config.ts` defaults flow into `runner.ts` guards). Both failure modes produced false findings in #1209.
- **Red→green evidence is a blocking closeout check (#1236).** A lane PR that introduces or extends a gate, scanner rule, or validator must carry the pre-change FAIL log in its PR body at review time. A finalizer retro-filling the log afterward (as happened for #1233 and #1234) is a recorded deviation (`evidenceGateDeviationCount` in the round-quality scorecard), not a substitute — closing the lane with neither the log nor a deviation record is a NO-GO.

### Failure classification (#1236)

When a round lane fails or a closeout PR is rejected, the finalizer records a failure category in the disposition comment — one of the closed set below. Classification is the finalizer's call, never the implementing worker's (oracle independence). Aggregated counts land in [`docs/ops/round-quality-scorecard.json`](ops/round-quality-scorecard.json) as the optional `failureBreakdown` object, validated fail-closed by `scripts/check-round-quality-scorecard.mjs`: unknown category keys, negative counts, and categories counted without a matching evidence narrative all fail the gate.

| Category | Judgment criterion |
| --- | --- |
| `spec_ambiguity` | The issue/spec admitted more than one reasonable reading and the lane implemented a reading the finalizer rejected. Accumulation points at the dispatch template. |
| `implementation_defect` | The spec was unambiguous; the delivered change is wrong or incomplete against it. Accumulation points at the worker guardpack. |
| `environment` | The failure came from the execution environment (missing binaries, network, container limits), not the spec or the change. Accumulation points at runner provisioning. |
| `acceptance_misconfigured` | The acceptance command or expectation was wrong for the lane (vacuous, wrong exit code, inapplicable path). Accumulation points at the acceptance contract docs (#1218). |
| `scope_drift` | The change stepped outside the declared scope (`diffHygiene.scopeDrift`). Forbidden paths remain the security boundary; scope drift is a quality/spec boundary and does not replace forbidden-path blocking. Accumulation points at declaredScope discipline (#1234/#1235). |
| `other` | Anything else — requires a free-text explanation in the evidence line; reclassify when better information surfaces. |

#### Failed-lane readback contract (#1248)

When a lane fails, the PR body or finalizer disposition readback must preserve enough bounded evidence for a later finalizer to choose a category narrower than `other` when possible. Each failed lane entry should include:

- lane/task id;
- failure stage: `dispatch`, `projection`, `handler`, `acceptance`, or `verification`;
- exit code or broker error code;
- finalizer category from the closed set above;
- a bounded, redacted excerpt from the failure output.

The broker standard field is `result.error.details` / `task.error.details` with optional `stage` and `excerpt` keys. `excerpt` must be operator-safe: no raw prompts, session dumps, secrets, personal data, private host paths, provider targets, or full unbounded logs. The broker normalizer bounds and redacts `excerpt`; writers should still submit only the minimum lines needed to explain the failure.

`other` is still allowed, but it must explain why a narrower category is impossible. The scorecard gate prints a warning when consecutive new scorecard entries have `failureBreakdown.other` as the majority, because that pattern means failed-lane readback is not giving the finalizer enough repo-visible evidence.

### Dialectic health counters (#1296)

When a round uses ordinary A2A lanes as a weak dialectic, the finalizer should record aggregate lane-health counters in the scorecard when readback evidence is available:

- `dispatchedLaneCount`: total lanes dispatched for the round.
- `substantiveLaneCount`: lanes that produced substantive analysis by the existing `a2ad-finalizer-gate.mjs` evidence-class criterion.

Do not invent a second classifier for this field. `readiness_only`, `generic_ack`, `wrapper_only`, `empty_substantive_output`, projection/infra failures, and provider/model failures are non-substantive. Record counts only — no worker names, node ids, private prompts, or raw excerpts. The scorecard gate validates `substantiveLaneCount <= dispatchedLaneCount` and warns when consecutive scorecard entries fall below the configured substantive-lane ratio threshold.

### Lane reliability ledger update (#1299)

When a finalizer has bounded lane readback for a completed round, add a report-only ledger update before closeout when it can be done without guessing:

1. Export the task/finalizer readback as JSON with lane status, evidence class, and any `validations[]` acceptance/review entries.
2. Run `scripts/lane-reliability-aggregate.mjs` against `docs/ops/lane-reliability-ledger.json` with anonymous routing axes only (`adapterClass`, `modelClass`, `taskClass`, `window`).
3. Run `scripts/check-lane-reliability-ledger.mjs` and the aggregate tests.
4. If the source readback lacks evidence classes or only has private/raw logs, skip the ledger update and record that skip in the disposition; do not infer classes from memory.

The ledger is not a router and does not authorize dispatch changes. M2 may consume it later. M1 records counts only — no worker names, node ids, URLs, raw prompts, secrets, private paths, or provider targets.

### Designated antithesis and plan mini-cycle closeout (#1297)

For ordinary A2A rounds that use designated antithesis lanes, finalizers judge
the antithesis as reviewer evidence rather than as another implementation vote:

- The antithesis must name the thesis/plan/implementation it is attacking.
- A substantive antithesis contains at least one concrete rebuttal point and at
  least one `evidenceRef`; a thesis-unused evidence reference is recommended.
  Agreement-only PASS, generic acknowledgements, wrapper output, and source-only
  readiness notes are non-substantive and excluded from #1296 health counters.
- When a plan-round mini-cycle is used, the closeout note should name the selected
  thesis, the antithesis lane ids, and whether the final plan changed.
- When a consequential plan round deliberately skips the mini-cycle, record a
  one-line reason in the disposition evidence. This is a reporting convention,
  not a new hard gate or a new scorecard schema field.

## Independent review evidence for medium+ tasks (#1237)

Tasks that are large enough to need an author/reviewer split can opt in with `payload.review.required: true`. This first slice is a manual contract only: the dispatcher chooses the reviewer lane; the broker does not auto-assign reviewers.

When `review.required` is true, successful completion must include independent reviewer evidence. The preferred shape for combined acceptance + review tasks is `result.validations[]` with separate entries:

```json
{
  "validations": [
    { "kind": "smoke", "verdict": "pass", "metrics": { "acceptance": true } },
    { "nodeId": "reviewer-b", "kind": "review", "verdict": "pass", "note": "diff matches spec" }
  ]
}
```

The review entry requires:

- `nodeId`: reviewer node id;
- `kind`: `"review"`;
- `verdict`: `"pass"` or `"fail"` (`"pass"` is required for completion);
- `note`: reviewer reason.

The legacy singleton `result.validation` shape remains accepted for review-only or backward-compatible submissions. When `result.validations[]` is present, the broker matches review evidence by `kind: "review"`; when it is absent, it falls back to the singleton field.

The reviewer node must differ from the author/completing worker. Missing reviewer evidence rejects completion as `review_evidence_missing`; same-node review rejects as `review_not_independent`; failing review rejects as `review_verdict_failed`. If `payload.review` is absent or `required` is false, existing task completion behavior is unchanged.

Reviewer input should be limited to the diff, the original task specification, and the acceptance result. Do not feed the reviewer the author's self-narrative as the primary evidence; that preserves oracle independence.

Use this contract as guidance for medium+ tasks when declared scope spans multiple broker packages, touches a completion gate or validator, or changes safety-sensitive lifecycle behavior. Hard auto-enforcement of the medium+ threshold is deferred.

## Approval records

Approval-sensitive execution records live under `fixtures/approvals/` and are validated by `npm run check:approval-records`. New approval records must use `approverRole: "operator"` and must not include personal-channel or raw-secret fields.

## Agent Olympics Boundary

`agent-olympics` is independent. It must not be treated as an A2A package, source label, issue-routing lane, or blocker for A2A Nexus public-alpha work.
