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
- **Finalizer purity.** Verification/finalizer lanes must be reproducible from repository-visible evidence and the preserved task payload, not private memory, live web drift, or ad hoc execution. The Claude-backed finalizer/analysis tool policy is `Read Glob Grep` only; `Bash`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, and `WebSearch` are denied. Hermes-backed analysis lanes are pinned to the repository's finalizer-safe toolset and must not widen that policy via worker environment overrides. Verdicts must cite concrete file:line evidence, test output, workflow result, or commit/PR identifiers. K1 memory hints and K2 captured content may inform worker generation inputs, but finalizer verdicts may only rely on frozen/repo-visible artifacts; refetching live content is drift detection, not proof of completion.
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

#### Round replay before live re-dispatch (#1302)

Before burning a live round on a `projection`/`dispatch`-stage failure
hypothesis, bisect the stage locally by replaying the preserved payload
through the deterministic orchestration paths:

```
node packages/broker/scripts/replay-round.mjs --payload <preserved-payload.json> [--task task.json] [--result result.json] [--json]
```

Stages replayed: readiness → carrier projection → bridge-input files (with the
3-point carrier stats and the message-excerpt drift probe — the zero_files
signature) → the deterministic source-only bridge → acceptance judgment over a
preserved worker result. Provider/model calls, worker dispatch, GitHub side
effects, and acceptance command execution are never replayed (explicit skip
markers). The replay is read-only and prints live-comparable error codes
(`source_projection_empty`, `projection_zero_files`, …), so a
projection-classified incident should reproduce here before any re-dispatch;
attaching the replay log to the incident issue is recommended (not required).
Committed regression fixtures live in
`packages/broker/scripts/lib/replay-fixtures/`.

### Dialectic health counters (#1296)

When a round uses ordinary A2A lanes as a weak dialectic, the finalizer should record aggregate lane-health counters in the scorecard when readback evidence is available:

- `dispatchedLaneCount`: total lanes dispatched for the round.
- `substantiveLaneCount`: lanes that produced substantive analysis by the existing `a2ad-finalizer-gate.mjs` evidence-class criterion.

Do not invent a second classifier for this field. `readiness_only`, `generic_ack`, `wrapper_only`, `empty_substantive_output`, projection/infra failures, and provider/model failures are non-substantive. Record counts only — no worker names, node ids, private prompts, or raw excerpts. The scorecard gate validates `substantiveLaneCount <= dispatchedLaneCount` and warns when consecutive scorecard entries fall below the configured substantive-lane ratio threshold.

For a source-only local bridge class that is intentionally configured without a model/provider bridge (#1427), repeated successful `readiness_only` output is an as-designed health signal, not a defect. Keep it in `dispatchedLaneCount` when it was dispatched, exclude it from `substantiveLaneCount`, and avoid assigning it to substantive-required lenses unless an approved bridge/provisioning change has been canaried.

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

### H3 implementation measurement fields (#1349)

When an implementation lane is being used to measure the H1/H2 pipeline effect,
record the optional implementation measurement fields in the scorecard entry:

- `implementationMode`: `"solo"`, `"h1-pipeline"`, or `"h2-hybrid"`.
- `implementationDurationBand`: `"<1h"`, `"1-4h"`, or `">4h"`.

The scorecard gate fails closed for unknown values and requires the two fields as
a pair when either is present. The fields are top-level entry metadata, not
`metrics`, so they do not collide with the existing non-negative-integer metrics
contract. Existing entries are not backfilled.

Comparison protocol:

1. Compare against same-class work where possible (for N2, use the L-broker
   series and later stats/API slices as rough solo baselines; do not rewrite
   old entries).
2. Use the existing quality axes: review/finalizer defects, `reworkIssueCount`,
   `falseFindingCount`, `evidenceGateDeviationCount`, and failure narratives.
3. Use only the duration band for speed; do not record exact timestamps or
   session identifiers. **The band covers the whole wave wall-clock, including
   failed or discarded dispatch rounds before the successful one** — dispatch
   friction is part of a mode's real cost, and counting only the successful
   round understates it (ratified after Wave 1, where rounds r1–r3 were
   excluded from evidence but still consumed wall-clock). Record
   rounds-to-success as a one-line note in the entry narrative. Do not
   backfill earlier entries.
4. **Speed comparison requires a measured solo control.** Pre-H3 baseline
   entries (the #1289 L-broker series) carry quality counters but no duration
   bands, so a speed verdict against them is indeterminate. A promotion series
   must therefore include at least one fresh solo control wave on same-class
   work with the band recorded, run under the same evidence gates and the same
   finalizer verification as the h1/h2 waves (implementation mode is the only
   variable).
5. Promote a mode to the default recommendation only after three consecutive
   comparable waves show quality no worse than solo and a better duration band.
   Any quality regression blocks promotion pending cause analysis.

Solo baseline reference (H3-c; #1289 L-broker series, same-class R4 seam work,
entries unchanged): across the seven entries, `reworkIssueCount` and
`falseFindingCount` were 0 throughout, `evidenceGateDeviationCount` was 1 in
two waves, and substantive-lane rates ranged roughly 63–95%. No duration bands
exist for these entries (pre-H3-a) — hence rule 4. Quality parity against this
baseline means holding the zero counters; the substantive-lane rate is a
secondary signal, not a promotion axis.

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

The reviewer node must differ from the author/completing worker. For a
self-contained review task, the dispatcher should bind the trusted author
explicitly:

```json
{
  "review": {
    "required": true,
    "authorWorkerId": "the-author-worker-id"
  }
}
```

`authorWorkerId` is dispatcher-declared evidence, not reviewer input, and must
differ from the reviewer. Without it, the compatibility fallback uses the
task's assigned/claiming worker; a self-contained reviewer task can therefore
correctly fail independence rather than silently approve itself.

Missing reviewer evidence rejects completion as `review_evidence_missing`;
same-node review rejects as `review_not_independent`; failing review rejects as
`review_verdict_failed`. If `payload.review` is absent or `required` is false,
existing task completion behavior is unchanged.

Do not add `payload.acceptance.command` to an analysis-only review lane unless
that lane actually executes the command and returns separate smoke acceptance
evidence. Merely adding a harmless command such as `/usr/bin/true` activates
the acceptance contract and an otherwise valid review will fail with
`acceptance_evidence_missing`.

Reviewer input should be limited to the diff, the original task specification, and the acceptance result. Do not feed the reviewer the author's self-narrative as the primary evidence; that preserves oracle independence.

Use this contract as guidance for medium+ tasks when declared scope spans multiple broker packages, touches a completion gate or validator, or changes safety-sensitive lifecycle behavior. Hard auto-enforcement of the medium+ threshold is deferred.

### Bounded review lineage record mode (#1518 Phase 3b)

The broker can persist bounded PR review lineage telemetry when
`A2A_REVIEW_LINEAGE_MODE=record`. The default is `off`; `enforce` is rejected
at startup. Record mode is observational and does not change task completion,
retry, approval, or finalizer decisions.

Operator-safe projections are read-only:

- `GET /review-lineages` lists projected state and metrics.
- `GET /review-lineages/{lineageId}` returns one projection.

The projection includes lifecycle state, counters, terminal reason, current
and original head SHAs, and open blocking findings. It omits the frozen
contract, full ledger, raw receipts, and diff hashes. Only authenticated
`hub`, `operator`, `analyst`, and `researcher` roles may read these routes when
requester identity enforcement is enabled.

Phase 3b does not connect task/review execution to lineage events and exposes
no HTTP mutation route. The broker-internal record API is intentionally a
dead path until a separately reviewed adapter names and verifies the event
source. Setting record mode alone therefore does not create records.

### Lossless review-lineage observation contract (#1518 Phase 8)

Phase 8 defines the input boundary needed before a record-mode adapter can be
considered. `ReviewLineageObservationEnvelopeV1` requires an explicit,
producer-stable event id, UTC observation time, complete lineage/event input,
and exact current `intentHash` / HEAD / canonical diff binding.

The pure parser returns:

- a domain-separated idempotency key;
- a canonical complete-payload fingerprint;
- the expected current subject for a future compare-and-set;
- one existing engine command (`create_lineage` or `record_event`).

It never fills gaps from task status, result prose, GitHub state, provider
output, prompts, or local time. Unknown fields and versions, binding drift,
incomplete finding transitions, and same-key/different-payload replay fail
closed. Errors contain a stable code and JSON path only.

This phase still does not attach to task completion, call the store, expose an
HTTP mutation, or provide process-restart exactly-once effects. Before any live
producer is connected, separately review persistent idempotency conflict
detection, compare-and-set application, producer completeness, and retention/
redaction of the frozen intent and finding evidence.

### Review-lineage scorecard readback (#1518 Phase 7)

Phase 7 adds a manual, offline scorecard over redacted record-mode exports. It
does not read the broker, change `DEFAULT_LINEAGE_BUDGET`, enable `enforce`, or
apply a recommendation.

Build the broker once, then pass the strict
`a2a.review-lineage-scorecard-input.v1` envelope to the compiled CLI:

```bash
npm --workspace packages/broker run build
node packages/broker/dist/review-lifecycle/scorecard-cli.js \
  --input /path/to/redacted-lineages.json \
  --output /path/to/scorecard.json
```

The source fixture at
`packages/broker/fixtures/review-lineage-scorecard/sample-input.json` is
synthetic contract documentation, not rollout evidence.

The TypeScript projection
`projectReviewLineageScorecardSample(record, { sourceRoundId, asOf })` is the
only supported way to turn a full record into a scorecard sample. It reuses
`computeMetrics`, replaces the durable lineage ID with an envelope-local
reference, and omits the frozen goal, acceptance text, paths, HEAD/diff hashes,
receipts, ledgers, prompts, and chain-of-thought. The CLI accepts only that
redacted envelope and refuses malformed fields, mixed record versions,
duplicate lineages, non-`record` samples, bad timestamp ordering, and a
same-round replay with a different canonical input digest.

Read the output as follows:

- cohorts are separated by the exact global-budget signature;
- p50/p95 are deterministic nearest-rank values;
- `intentHash` false-positive rate counts only mismatch signals with an
  explicit final offline adjudication and evidence references; terminal state,
  appeal presence, or later hash equality is never treated as an implicit
  false positive;
- fewer than 30 terminal samples yields `insufficient_evidence`;
- an increase is only `investigate_increase` at 30+ terminal samples, at least
  five matching exhaustion stops, and a 10%+ exhaustion rate;
- a decrease is only `investigate_decrease` at 100+ terminal samples, zero
  exhaustion, and observed p95 no greater than half the current limit;
- every result is `advisory: true`; there is no apply field or runtime consumer.

`maxReviewerReplacements` remains `not_observable` because the current terminal
reason does not distinguish reviewer-run exhaustion from replacement
exhaustion. Do not tune that limit from this scorecard.

Start a new lineage only when the approved frozen intent changes. A metadata or
evidence-only HEAD refresh that preserves the frozen contract and canonical
diff remains the same lineage and does not reset its budget. A new goal,
non-goal, invariant, acceptance criterion, declared path, base, or original
HEAD requires a new `IntentContractV1`/`intentHash`; preserve the prior lineage
as immutable evidence.

Machine-visible dispositions remain distinct:

- `spec_ambiguity` is a `FindingV1.category` and must cite a criterion and
  concrete evidence; it is not permission for a resolution reviewer to add a
  new preference blocker;
- `scope_drift` is both a finding category and an engine rejection surfaced by
  `scopeDriftRejections` / terminal reason `scope_drift`;
- `intent_conflict` is reserved for a correction whose frozen `intentHash`
  changed and requires explicit operator disposition.

Until real terminal record-mode exports meet the evidence threshold, budget
defaults remain unchanged and broad runtime `enforce` remains a separate
operator decision.

## Approval records

Approval-sensitive execution records live under `fixtures/approvals/` and are validated by `npm run check:approval-records`. New approval records must use `approverRole: "operator"` and must not include personal-channel or raw-secret fields.

## Dated report naming and placement (#1290)

A dated report — any write-up whose value is the record of a completed
investigation, validation, triage, or closeout (name shape
`<topic>-YYYY-MM[-vN].md`) — is created under `docs/history/` from the start,
with a one-line row added to `docs/history/README.md`. It never lands in the
`docs/` top level, which is reserved for the living user and operator surface
(`docs/README.md` is the tier index). Machine-consumed dated evidence (JSON
ledgers, scorecards, registries) stays under `docs/ops/` while a gate reads
it, keeping the same `<topic>-YYYY-MM[-vN]` name shape; when its gate
retires, it moves to `docs/history/` in the same change. A living document
that later completes (an executed plan, a finished roadmap) moves to
`docs/history/` with every repository reference updated in the same PR —
`npm run check:markdown-links` is the safety net — and leaves a one-line
forwarding stub only when the old path was externally linkable (linked from
the root README or SECURITY).

## Agent Olympics Boundary

`agent-olympics` is independent. It must not be treated as an A2A package, source label, issue-routing lane, or blocker for A2A Nexus public-alpha work.
