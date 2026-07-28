# Feature Spec: Bounded PR Review Lifecycle (Frozen Intent + Lineage Budget)

> **Status:** spec-first packet for #1518. Documentation-only: this spec does not approve
> production deploys, broker/Gateway/worker restarts, provider sends,
> DB/outbox/ACK/replay/prune/migration, releases, tags, package publication, GitHub
> settings/ruleset mutation, secret movement, visibility change, history rewrite, or force push.

## Problem

A review system can be individually fail-closed yet operationally unsafe when it has no global
liveness bound. An independent-review incident outside A2A spent more than 24 hours on one PR:
multi-reviewer verdicts were regenerated after every tree change, findings outside the original
PR intent were absorbed, and the patch expanded instead of converging. Local retry/fix limits did
not compose into a PR-wide stop condition, and reviewers could effectively move the goalposts.

A2A Nexus has stronger controls than that pipeline — advisory review lanes are evidence-only, the
finalizer is separated from the author, ordinary retry policy hard-denies review/acceptance
failures, and signed finalizer verdicts bind to an exact subject. Current contracts still admit
the same class of liveness and intent-drift failure:

- `docs/specs/a2a-dialectic-review-mode/analyze.md` records **no maximum review duration**.
- `docs/implementation-pipeline.md` requires a bounded fix list but does not bound total
  correction generations across verifier → A2AD → finalizer → GitHub review.
- `docs/a2ad-round-dispatch.md` limits one rebuttal pass but permits "another bounded round";
  individually bounded rounds can compose into an unbounded PR lineage.
- `packages/broker/src/worker-review.ts` validates reviewer identity, pass/fail, and note, but
  the basic review receipt is not required to bind the reviewed HEAD/diff or a frozen intent
  contract.
- `packages/broker/src/worker.ts` (`validateTaskCompletionEvidence`, called from the completion
  path at `worker.ts:431`) invokes `validateReviewEvidence(task, result)` **without a trusted
  author worker id**. The validator falls back to `task.claimedBy`/`assignedWorkerId`
  (`worker-review.ts:69`), which is the reviewer itself for a self-contained review task — so
  exact-head source-only review tasks fail as `review_not_independent` even when the review is
  genuinely independent (observed on PR #1548; see the #1518 issue comment).
- `docs/operators.md` records real false findings from synonym/config-flow misreads (#1209) and
  classifies `spec_ambiguity` and `scope_drift` as distinct failure modes, but only as narrative
  guidance — not machine-visible dispositions.

This matters directly to #1499. Enforcing finalizer/CodeQL gates is necessary, but a strict merge
gate without a bounded resolution lifecycle risks a system that is safe against unreviewed merge
yet unable to terminate or preserve the author's approved intent.

## User / operator stories

- As an operator, I want every PR review lineage to carry one global budget so that review
  always terminates — with `passed`, `blocked_needs_operator`, or `intent_conflict` — instead of
  editing until a model says PASS.
- As an author, I want reviewers to evaluate my frozen intent (goal, non-goals, invariants,
  acceptance criteria, declared scope) so that review cannot silently rewrite what was approved.
- As a reviewer, I want a stable finding ledger with durable finding IDs so that a resolution
  pass checks *my* findings instead of restarting the issue list from scratch.
- As a finalizer, I want resolution review restricted to reopen/resolution plus narrowly
  justified new blockers, so that second-pass review cannot become a new design review.
- As an operator, I want record-mode metrics (elapsed time, generation count, finding churn,
  stop reason) before any enforcement, so that false-positive behavior is measured first.
- As a dispatcher, I want self-contained review tasks to declare a trusted author identity so
  that independence validation compares the reviewer against the real author, not against the
  review task's own claimer (#1548 defect).

## Actors

| Actor | Role in the bounded lifecycle | Authority |
| --- | --- | --- |
| **Author** | Produces the PR and optional correction generations | Owns the branch; intent is frozen at lineage start |
| **Reviewer lane** | Initial review and resolution review | Read-only; returns findings bound to the intent contract |
| **Fixer lane (optional)** | Produces an isolated correction patch candidate | Proposal-only; never auto-pushes; never rewrites the only copy of the author head |
| **Finalizer** | Records dispositions for disputed findings; one per lineage | Exactly one; separated from author; existing verdict gates unchanged |
| **Broker** | Stores intent contract, budget counters, finding ledger, lifecycle state | Enforces transitions fail-closed; record mode before enforce mode |
| **Operator** | Owns `blocked_needs_operator` / `intent_conflict` disposition | Human; only actor who may start a new lineage or adjust intent |

## Scope

### In scope

- `IntentContractV1` — frozen intent oracle with canonical `intentHash`.
- `ReviewLineageBudgetV1` — one global budget per PR lineage, shared across all layers.
- Lifecycle state machine (`reviewing_initial` → … → terminal states).
- Additive review-receipt binding: `headSha`, `diffHash`, `intentHash`, reviewer identity,
  finding-ledger reference, and dispatcher-declared trusted author identity.
- Blocking-finding ledger with stable IDs, eligibility rules, and dispositions.
- Resolution-review restrictions (no moving goalposts).
- Appeal path: disputed findings resolved by exactly one finalizer disposition.
- Intent-drift / scope-drift guards per correction generation.
- Operator-visible metrics and rollout modes (`off` / `record` / `enforce`).
- Reconciliation with #1499 so finalizer enforcement and bounded resolution coexist.

### Out of scope

- Weakening or bypassing finalizer verdict, CodeQL, reviewer-independence, required-check, or
  operator-approval gates.
- Automatically accepting reviewer- or fixer-authored changes.
- Allowing reviewer/finalizer/fixer lanes to push, merge, deploy, restart, publish, or perform
  other side effects.
- Model/provider-specific prompting as the primary safety boundary.
- Production deploy/restart/canary, DB/outbox/ACK/replay/prune/migration, provider sends,
  release/tag/package publication, secret movement, visibility change, history rewrite, or
  force push.
- GitHub ruleset mutation (coordinated with #1499 but separately approved).

## Contracts

### IntentContractV1

Frozen at PR lineage start. Reviewers evaluate this contract; they cannot silently rewrite it.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `"IntentContractV1"` | yes | Schema tag |
| `lineageId` | string | yes | Stable PR-lineage identifier (see clarify.md) |
| `goal` | string | yes | Original approved goal |
| `nonGoals` | string[] | yes | Explicit non-goals (may be empty only if recorded as none) |
| `invariants` | string[] | yes | Safety/behavior invariants the change must preserve |
| `acceptanceCriteria` | `{ id: string; text: string }[]` | yes | Stable criterion IDs (e.g. `AC-1`); findings reference these |
| `declaredPaths` | `{ allowed: string[]; forbidden?: string[] }` | yes | Declared/allowed path globs; forbidden paths remain the security boundary (#1234/#1235) |
| `baseSha` | string | yes | Original PR base SHA |
| `headSha` | string | yes | Original author head SHA at lineage start |
| `createdAt` | ISO-8601 | yes | Freeze time |
| `intentHash` | string | yes | Canonical hash (see below) |

Canonical `intentHash`: SHA-256 over the canonical JSON serialization (sorted keys, UTF-8, no
insignificant whitespace) of every field above **except** `createdAt` and `intentHash` itself.
Any change to goal, non-goals, invariants, acceptance criteria, declared paths, or original
base/head MUST change the hash. Metadata-only restatements that do not alter meaning are
normalized before hashing (exact normalization rules in clarify.md).

### ReviewLineageBudgetV1

One budget per PR lineage. Preflight, implementation verifier, A2AD, finalizer correction, and
GitHub review MUST NOT each reset independent correction counters.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `maxWallClockSeconds` | number | `21600` (6h) | Total lineage wall clock from freeze to terminal state |
| `maxCorrectionGenerations` | number | `1` | Bounded correction generations after the original head |
| `maxReviewerRuns` | number | `2` | Initial review run + resolution review run |
| `maxReviewerReplacements` | number | `1` | Classified infrastructure failure only; never resets budget |
| `repeatedFindingThreshold` | number | `2` | Identical unresolved finding signatures that trigger early stop |
| `onExhaustion` | enum | `blocked_needs_operator` | Terminal behavior; never auto-retry, never stay `running` |

Budget counters (`elapsedSeconds`, `correctionGenerations`, `reviewerRuns`,
`reviewerReplacements`, finding-churn counters) live with the lineage state and are exported to
the operator metrics surface.

### Lifecycle states

| State | Meaning | Allowed next states |
| --- | --- | --- |
| `reviewing_initial` | Initial review running against the frozen intent | `correction_pending`, `passed`, `blocked_needs_operator`, `intent_conflict`, `canceled` |
| `correction_pending` | Blocking findings open; at most one bounded correction generation in flight | `reviewing_resolution`, `blocked_needs_operator`, `intent_conflict`, `canceled` |
| `reviewing_resolution` | Resolution check of the finding ledger (not a new design review) | `passed`, `blocked_needs_operator`, `intent_conflict`, `canceled` |
| `passed` | Review lifecycle converged | terminal |
| `blocked_needs_operator` | Budget exhausted or no-progress; human disposition required | terminal (operator may start a **new** lineage) |
| `intent_conflict` | A correction changed the frozen intent | terminal (requires explicit operator disposition) |
| `canceled` | Operator canceled the lineage | terminal |

Exhaustion of wall-clock, correction-generation, reviewer-run, or no-progress budgets transitions
to `blocked_needs_operator` — never to `running` and never to an automatic retry.

### Review receipt binding (additive)

The existing basic review receipt (`worker-review.ts`: reviewer `nodeId`, `kind: "review"`,
`verdict`, `note`) is extended additively. When a lineage opts in, a valid receipt MUST also
carry:

- `headSha` and `diffHash` of the reviewed tree — mismatch fails closed;
- `intentHash` of the frozen contract — mismatch fails closed;
- `findingLedgerRef` — the ledger the findings were recorded against;
- reviewer identity (unchanged requirement), which must differ from the **trusted author
  identity**.

**Trusted author identity (#1548 slice).** Self-contained review tasks declare the author under
review in `task.payload.review.authorWorkerId` (dispatcher-declared at task creation).
`validateReviewEvidence` receives this identity explicitly and compares
`reviewerNodeId !== authorWorkerId`. When the field is absent, the current fallback
(`claimedBy` → `assignedWorkerId` → `targetNodeId`) is preserved for backward compatibility.
Dispatchers MUST NOT attach `payload.acceptance.command` to analysis-only review tasks: review
validation is independent from smoke acceptance, and an unexecuted acceptance command fails as
`acceptance_evidence_missing` by design.

### Authenticated review-report source (Phase 16)

Record mode accepts a complete review report only through
`POST /review-lineages/{lineageId}/review-report`. The requester must be
authenticated by the broker's A2A Ed25519 worker-signature registry. The
verified signing-key owner is the reviewer issuer, and the canonical Phase 8
`ReviewReceiptV1` parser requires that issuer to equal
`receipt.reviewerNodeId`. Request JSON cannot select issuer, authority,
producer ID, source-event ID, source kind, or namespace.

The exact-field body carries an immutable report reference, observation time,
subject binding, complete receipt, and resolved/reopened/new-finding arrays.
Phase 13 authorization, Phase 12 awaited admission, and Phase 8 parsing remain
canonical. The minimized source event, canonical lineage transition, and
observation-ledger result commit atomically in one direct transaction or one
worker-thread command and durable ACK. Projection changes only after the ACK.

No generic task, result, validation summary, log, provider response, or prose
inference can create this event. At the end of Phase 16,
`correction_generation` and `reviewer_replacement` remained detached and
authoritative-source coverage was exactly `3/5`. See
[review-report-source-v1.md](review-report-source-v1.md).

### Authenticated correction-generation source (Phase 17)

Record mode accepts committed-generation evidence only through
`POST /review-lineages/{lineageId}/correction-generation`. An authenticated
requester must have the exact `operator` role. Trusted broker code treats that
operator as the issuer of semantic `correction_controller` authority; request
JSON cannot select authority, namespace, source kind, issuer, producer ID, or
source-event ID.

The exact-field body carries only an immutable generation reference,
observation time, the complete pre-correction intent/head/diff binding, next
head and diff, the unchanged frozen intent hash, and all changed paths. The
Phase 8 parser remains the only complete field/subject/event parser. Phase 13
authorizes the carrier, Phase 12 awaits admission, and schema 13 stores the
minimized source event, canonical lineage result, and ledger result in one
transaction or one worker-thread command and durable ACK.

The canonical store admits a correction command only from
`correction_pending`. Exact-subject or frozen-intent drift fails closed.
Forbidden or out-of-scope paths leave the pre-correction head in place and
record only redacted rejection effects. A successful allowed-path event moves
to `reviewing_resolution` and records the supplied already-committed head; the
route itself never applies a patch or invokes a fixer.

No generic task, result, validation summary, log, prose, retry, completion, or
finalizer output can create this event. At the Phase 17 boundary,
`reviewer_replacement` remained detached, so authoritative-source coverage was
exactly `4/5`. See
[correction-generation-source-v1.md](correction-generation-source-v1.md).

### Authenticated reviewer-replacement source (Phase 18)

Record mode accepts an already classified infrastructure-failure replacement
decision only through
`POST /review-lineages/{lineageId}/reviewer-replacement`. An authenticated
requester must have the exact `operator` role. Trusted broker code treats that
operator as issuer of semantic `reviewer_allocator` authority and fixes
`reviewer_replacement_decided`, the source namespace, observation kind, and
reason `infrastructure_failure`.

The exact-field body carries only an immutable decision reference,
observation time, and the complete current intent/head/diff binding. It cannot
select reason, authority, namespace, issuer, producer ID, source-event ID,
reviewer identity, replacement worker, task, or assignment. The Phase 8 parser,
Phase 13 authorization, Phase 12 awaited admission, schema 13, composite
transaction, worker-thread durable ACK, and post-ACK projection remain
canonical.

An admitted replacement increments only the existing replacement counter. It
never resets the shared budget, start time, intent, head, diff, reviewer-run or
correction-generation counters, or finding ledger. Replacement-budget
exhaustion remains terminal and visible. Already-terminal lineages record a
stable rejection instead of an applied no-op.

The route records a decision only. It does not classify generic failures,
choose a worker, mutate assignment, infer from task/result/error/log/prose,
retry/completion/finalizer state, or create an automatic loop. The closed
source/authority/command/observation set is exactly all five tuples, so
authoritative-source attachment coverage is exactly `5/5`. This is source
attachment, not record-mode activation, independent review, finalizer
closeout, or issue closeout. See
[reviewer-replacement-source-v1.md](reviewer-replacement-source-v1.md).

### Blocking-finding ledger (FindingLedgerV1)

Findings are stable objects. A new reviewer cannot restart the issue list from scratch.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `findingId` | string | yes | Stable per lineage (`F-1`, `F-2`, …); never reused |
| `criterionRef` | string | yes | Acceptance-criterion or invariant ID the finding maps to |
| `evidenceRefs` | string[] | yes | Concrete repository/test evidence |
| `severity` | enum | yes | `critical` / `major` / `minor` |
| `category` | enum | yes | e.g. `correctness`, `security`, `regression`, `spec_ambiguity`, `scope_drift` (machine-visible form of `docs/operators.md` guidance) |
| `blocking` | boolean | yes | Style, preference, scope expansion, and optional design improvements are `false` |
| `introducedAtHead` | string | yes | HEAD where the defect was introduced |
| `firstSeenAtHead` | string | yes | HEAD at initial detection |
| `resolvedAtHead` | string \| null | yes | HEAD that resolved it, if any |
| `disposition` | enum | yes | `open` / `resolved` / `reopened` / `overruled_by_finalizer` |
| `signature` | string | yes | Stable hash of (criterionRef, category, normalized evidence) for repeated-finding detection |

### Resolution-review restrictions (no moving goalposts)

Second-pass review is a resolution check, not a new design review. It MAY:

- mark prior finding IDs `resolved` or `reopened` with evidence.

It MAY add a new blocking finding only when one of these holds, with explicit justification:

1. **Introduced regression** — the defect was introduced by the correction generation
   (`introducedAtHead` = correction head);
2. **Critical security defect** — newly exposed, with concrete evidence;
3. **Demonstrably unavailable evidence** — the evidence could not have been examined at the
   first pass, with the reason recorded.

Any other new blocker (preference, scope expansion, optional design improvement) is recorded
non-blocking or rejected as `scope_drift`.

### Appeal and finalizer disposition

A disputed finding goes to exactly one finalizer, who records `overruled_by_finalizer` or
upholds it. The same reviewer must not veto indefinitely: once the finalizer overrules a
finding, that finding ID cannot be reopened by the same reviewer without new evidence class
(1)–(3) above. Existing finalizer-verdict verification
(`scripts/check-finalizer-verdict.mjs`, `scripts/verify-finalizer-verdict.mjs`) remains the
merge-gate authority; this lifecycle does not replace it.

### Intent-drift / scope-drift guards

Each correction generation is compared with the frozen contract:

- Frozen-intent fields changed (goal/non-goals/invariants/criteria/paths) → `intent_conflict`,
  explicit operator disposition required.
- Patch touches paths outside `declaredPaths.allowed` → candidate rejected; `scope_drift`
  disposition recorded.
- The original author head/branch remains recoverable: correction candidates are additive child
  generations, never destructive rewrites of the only copy.

### Operator-visible metrics

Per lineage, exported in record mode and readable before enforce mode:

- elapsed wall time; correction generation count;
- reviewer-run and reviewer-replacement counts;
- finding churn (new / reopened / resolved);
- repeated/no-progress signature hits;
- scope/intent-drift dispositions;
- terminal stop reason.

Metrics contain no private prompts or chain-of-thought.

### Rollout modes

| Mode | Behavior |
| --- | --- |
| `off` | No lineage state; current behavior unchanged (default until record-mode evidence exists) |
| `record` | Lifecycle state, budget counters, and metrics are recorded; no transition blocks completion |
| `enforce` | Budget exhaustion and intent drift transition to terminal states fail-closed |

## Relationship to #1499

#1499 enforces the finalizer verdict and CodeQL policy in the active main ruleset — the merge
gate. This spec bounds the **resolution lifecycle upstream of that gate**. The two are
complementary: a strict gate without a bounded lifecycle cannot terminate; a bounded lifecycle
without the gate cannot guarantee review. Invariant: these liveness controls MUST NOT weaken
finalizer verdict HEAD binding, reviewer independence, evidence requirements, CodeQL, or
approval boundaries.

## Success criteria

- [ ] This spec packet exists at `docs/specs/bounded-pr-review-lifecycle/` (spec, clarify,
  analyze, plan, tasks, checklist).
- [ ] `IntentContractV1` canonicalization and `intentHash` stability/change rules are defined.
- [ ] One global lineage budget covers all review/correction layers with terminal exhaustion.
- [ ] Review-receipt binding (headSha/diffHash/intentHash/trusted author) is specified additively
  without weakening existing gates.
- [ ] Finding ledger, resolution-review restrictions, appeal path, and drift guards are defined.
- [ ] Rollout modes (`off`/`record`/`enforce`) and operator metrics are defined.
- [ ] #1499 reconciliation is explicit.
- [ ] All out-of-scope actions are explicitly excluded.

## Safety and approval boundaries

### Secrets and private data

- Contracts carry SHAs, paths, criterion IDs, and finding metadata — never secrets, private
  endpoints, provider IDs, Telegram IDs, production data, raw session dumps, or
  runtime/bootstrap file contents.
- Reviewer/author identities are worker/node IDs already present in broker task records.

### Human approval required for

- [ ] production deploy / broker / Gateway / worker restart
- [ ] DB/outbox/ACK/replay/prune/migration
- [ ] live canary / provider send
- [ ] release/tag/package publication
- [ ] secret movement
- [ ] GitHub ruleset mutation (#1499 coordination)
- [x] none of the above for this spec packet

## Rollback / failure handling

- **Failure indication**: record mode produces unexpected terminal dispositions or hash-binding
  false positives on metadata-only changes.
- **State restored**: `off` mode restores current behavior with no migration; lineage records
  are additive and can be ignored.
- **Safe cleanup**: a lineage in `record` mode never blocks completion, so rollback cannot strand
  in-flight tasks.
- **Approval-required cleanup**: none for the spec; enforce-mode activation is a separate
  operator decision after scorecard readback.

## Wiki/runbook follow-up

- Operator runbook: how to read lineage metrics, disposition `blocked_needs_operator` /
  `intent_conflict`, and start a new lineage.
- Dispatcher runbook: declaring `payload.review.authorWorkerId` for self-contained review tasks
  and the acceptance-command pitfall (#1548).
- `docs/operators.md` failure-mode table gains machine-visible `spec_ambiguity` / `scope_drift`
  dispositions once enforce mode lands.

## Source references

- Issue #1518 (this packet), including the PR #1548 review-lifecycle defect comment.
- Issue #1499 — finalizer verdict + CodeQL ruleset enforcement.
- Issue #1027 — task-level repeated-error early-stop direction (extended here to PR lineage).
- `packages/broker/src/worker-review.ts`, `packages/broker/src/worker.ts` (completion evidence
  chain), `packages/broker/src/worker-review.test.ts`.
- `docs/implementation-pipeline.md`, `docs/a2ad-round-dispatch.md`,
  `docs/specs/a2a-dialectic-review-mode/`, `docs/operators.md`.
- `scripts/a2ad-finalizer-gate.mjs`, `scripts/check-finalizer-verdict.mjs`,
  `scripts/verify-finalizer-verdict.mjs`.
