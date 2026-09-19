# Feature Spec: A2A Routing Advice Foundation (#2196, offline slice 1)

> **Status**: offline slices only. This document specifies (1) the offline
> foundation slice — a pure, no-I/O advisory library plus its contract tests,
> fixtures and documentation — and (2) the Phase A **corpus-validation slice**
> (see [Corpus slice](#corpus-slice-2196-phase-a-slice-offline-corpus-validation-a2aroutingcorpusv1)):
> a pure, synchronous corpus-envelope validator, integrity digest and
> judgment-input projection, plus a public synthetic development corpus. Neither
> slice is the model, runtime integration, the full classifier, the private
> Phase A calibration/holdout seal, or issue completion. Nothing here
> authorizes dispatch, deploy, live routing change, or worker/broker mutation.
>
> Baselines: foundation slice `main@d622d7db4e1be032d6310c0a93f51de4d8655599`
> (merged via #2197, `b0c7346f`); corpus slice on top of that foundation.

## Problem

Hosts that receive a work request currently have no shared, offline way to ask
"which of the seven known routing templates could this request plausibly map
to, and what trusted host data would each require?" — so every integration
re-derives template knowledge by hand from `docs/agent-manual.md`, and model
output is at risk of being treated as authorization. Issue #2196 calls for a
routing classifier; before any model exists, the contract surface (closed
input, closed output, immutable template catalog, fail-closed projection) must
exist and be testable offline.

## Goal

One pure library, `scripts/lib/a2a-routing-advice.mjs`, that:

1. validates a **versioned, closed** routing input (request text + candidate
   template ids + trusted host context);
2. validates **closed** advisory output against that input and a caller-supplied
   `expectedModelVersion`;
3. projects **validated** advice to a bounded descriptor that names the host
   fields still required — with `advisoryOnly: true` and `dispatchAllowed:
   false` invariants — or fails closed.

The library performs no filesystem, network, process, or clock effects and
imports nothing. It is advice metadata only: it never dispatches, never
prepares or admits a task, and never elevates readiness.

## Non-goals (this slice)

- No model call, provider adapter, or runtime integration; no
  `normalizeAssignRequest`/`prepareAssignment` invocation; no new top-level
  CLI (script budget #882/#1485/#1503 stays flat), dependency, service, or
  worker/broker mutation.
- No change to the PR #2195 / #2185 Jev-based calibration spec or the
  `task-assign-entrypoint` implementation; the entrypoint is a *later* consumer
  of this advice, not a participant in this slice.
- No confidence scores, probabilities, paths, commands, worker ids, scopes, or
  budgets anywhere in the output contract.
- No live routing behavior change: deployed hosts and live routing are out of
  scope; shared state, CHANGELOG, and root bootstrap files are untouched.
- The full Phase A deliverable — an independently reviewed corpus sealed for
  private calibration/holdout use and any model evaluation over it — is a
  **later** phase. The ≥20 reviewed-by-tests fixture cases below are
  illustrative contract examples and do NOT complete Phase A. The corpus
  slice below ships only the offline validation infrastructure and a public
  synthetic, draft-label, development-split corpus awaiting independent
  review; it makes no blind-set claim.

## Closed input contract (`a2a.routing-input.v1`)

Exactly these top-level fields (unknown fields, wrong types, wrong versions,
unknown template ids → structured rejection; error messages are stable codes
and never echo request text):

| Field | Requirement |
|---|---|
| `schemaVersion` | exactly `a2a.routing-input.v1` |
| `requestText` | nonblank Unicode string, ≤ 4000 codepoints (codepoints, not bytes/UTF-16 units; multibyte boundaries tested) |
| `catalogVersion` | exactly `a2a.routing-templates.v1` |
| `candidateTemplateIds` | array, unique ids, each in the seven-id catalog; empty array allowed |
| `hostContext` | closed object, exactly the three fields below |

### Trusted host context (caller-owned, never parsed from request text)

| Field | Closed values |
|---|---|
| `interaction` | `user_request` \| `control` \| `external_event` \| `attachment` |
| `operation` | `new_task` \| `observe_existing` \| `resume_existing` \| `unspecified` |
| `access` | `read_only` \| `write_allowed` \| `unspecified` |

Invariants:

- Host context is **explicit caller-owned data**. It is never inferred,
  guessed, or parsed out of `requestText`; text containing JSON or
  instructions that claim a context cannot change it (tested).
- Host context is **not authentication or permission proof**. It is a
  restriction surface for advisory eligibility only; actual authorization
  remains with the host and the existing gates (#1597 canary, dispatcher
  validation).
- `operation` and `access` are restrictions. `operation: unspecified` must not
  authorize new assignment by default (no `new_task` template is eligible).
  `access: read_only` forbids write escalation; `access: unspecified` never
  allows writes (no write-capable template is eligible).
- Explicit identifiers and control events stay with the host: existing task /
  request references and control/external-event/attachment interactions never
  appear in, and never become part of, model output; the model output contract
  has no field that could carry them.
- There is no "unknown" context value in the closed vocabulary: a host that
  cannot state context states `unspecified`, which is restrictive (never
  authorizing).

## Immutable template catalog (`a2a.routing-templates.v1`)

Seven templates, owned by code, deep-frozen, defensive-copied on lookup.
Catalog metadata with literal capability requirements is **advice, not
readiness proof**:

| id | operation | assignmentKind | intent | mode | required host access | mints new id |
|---|---|---|---|---|---|---|
| `new_patch` | `new_task` | `patch` | `propose_patch` | `github-propose-patch` | `write_allowed` | yes |
| `docs_patch` | `new_task` | `patch` | `propose_patch` | `github-propose-patch` | `write_allowed` | yes |
| `new_analysis` | `new_task` | `analysis` | `analyze` | `analysis-only` | `read_only` | yes |
| `docs_analysis` | `new_task` | `analysis` | `analyze` | `analysis-only` | `read_only` | yes |
| `review_readonly` | `new_task` | `analysis` | `analyze` | `github-verify` | `read_only` | yes |
| `observe_existing` | `observe_existing` | — (absent) | — (absent) | — (absent) | `read_only` | **no** |
| `resume_existing` | `resume_existing` | — (absent) | — (absent) | — (absent) | `read_only` | **no** |

`observe_existing` / `resume_existing` carry no `assignmentKind`, `intent`, or
`mode` and never mint an identifier; existing references are host-owned and
never appear in model output.

## Closed output contract (`a2a.routing-advice.v1`)

Exactly these fields (no confidence, probability, paths, commands, worker ids,
scope, budgets, or any extra field):

| Field | Requirement |
|---|---|
| `schemaVersion` | exactly `a2a.routing-advice.v1` |
| `decision` | `recommend` \| `not_a2a` \| `defer` |
| `templateId` | a candidate template id from the input, or `null` |
| `reasonCode` | fixed enum, consistent with `decision` (below) |
| `catalogVersion` | must equal the input's `catalogVersion` |
| `modelVersion` | bounded nonblank string; must equal the caller's `expectedModelVersion` (mismatch → rejected) |
| `policyVersion` | exactly `a2a.routing-policy.v1` |

Reason/decision consistency (anything else is invalid):

| decision | allowed reasonCode |
|---|---|
| `recommend` | `matched` (requires non-null `templateId` that is a member of `candidateTemplateIds`) |
| `not_a2a` | `not_applicable` (requires `templateId: null`) |
| `defer` | `ambiguous` \| `insufficient_context` \| `no_candidate` \| `unsupported_template` \| `uncertain` (requires `templateId: null`) |

The reason enum deliberately contains **no provider-failure or timeout code**:
a provider/timeout failure is never represented as a successful `defer`;
those outcomes belong to the later adapter result envelope (a separate,
adapter-owned contract).

Version strings are bounded (nonblank, ≤ 64 codepoints).

## Eligibility and fail-closed projection

Structural validation (decision/reason/templateId consistency, versions,
candidate membership) happens in `validateRoutingAdviceOutput`. The trusted
**context gates** are enforced where they cannot be bypassed — in
`projectRoutingAdvice`, which first re-runs both validators and then computes
eligibility from the validated input:

A `recommend` is eligible only when ALL hold:

1. `hostContext.interaction === 'user_request'`;
2. `hostContext.operation` equals the template's operation **exactly**
   (`unspecified` never matches; a known existing-task context —
   `observe_existing`/`resume_existing` — rejects a
   `new_patch`/`new_analysis`/any-`new_task` recommendation even when the model
   is confident);
3. write-capable templates (`new_patch`, `docs_patch`) require
   `hostContext.access === 'write_allowed'`; `read_only` forbids them and
   `unspecified` never allows writes; read-only templates are eligible under
   any access value because they write nothing.

Context-violating recommendations project to a structured **blocked**
descriptor (`projection: 'blocked'`, no template, no required fields, no plan
for a new task) — never a throw that loses structure, and never a plan.

`control` / `external_event` / `attachment` interactions therefore never
produce a recommendation projection: control events stay with the host.

Invalid output (wrong shape, mixed decision/reason, version mismatch, unknown
field) is **never partially projected**: projection runs both validators first
and refuses whole.

## Bounded descriptor (`projectRoutingAdvice` output)

A frozen, bounded object — not a task, not a manifest, not a callable action:

- `schemaVersion`, `advisoryOnly: true`, `dispatchAllowed: false`,
  `decision`, `reasonCode`, `templateId`, `catalogVersion`, `modelVersion`,
  `policyVersion`;
- `projection`: `template_descriptor` \| `blocked` \| `none`;
- `template`: defensive copy of the pinned catalog entry (recommend only);
- `eligibility`: `eligible` \| `context_not_eligible` (recommend only);
- `requiredHostFields`: fixed per-template metadata naming **host fields only**
  (recommend only). The descriptor never invents repo/source/scope/tests/ids
  and never copies arbitrary model fields.

Required-field metadata preserves the actual mapping (source contract, not a
live claim):

| template | requiredHostFields |
|---|---|
| `new_patch`, `docs_patch` | `requestId`, `objective`, `requestRef`, `target.repo`, `target.declaredScope.paths`, `target.repoTests` (the literal `task-assign-entrypoint` missing-field names) |
| `new_analysis`, `docs_analysis` | `requestId`, `objective`, `requestRef`, plus host-provided source/ownership contracts (`host.sourceCarriers`, `host.ownershipContracts`) — normalization alone does NOT make an analysis assignment-ready |
| `review_readonly` | the analysis fields plus host-provided PR/revision/workspace metadata (`host.pullRequestReference`, `host.revision`, `host.workspaceMetadata`) per the github-verify lane contract |
| `observe_existing` | `existingTaskReference` (host-validated; never minted here) |
| `resume_existing` | `existingRequestReference` (host-validated; never minted here) |

This slice does **not** call `normalizeAssignRequest` or `prepare`. The
descriptor only indicates still-required host fields; there is no
prepared/admitted state, no worker selection, no solo-team-hybrid
reclassification, and no readiness elevation anywhere in this slice.

## Exported surface (all pure, documented, actually implemented)

- `ROUTING_INPUT_SCHEMA_VERSION`, `ROUTING_ADVICE_SCHEMA_VERSION`,
  `ROUTING_CATALOG_VERSION`, `ROUTING_POLICY_VERSION`,
  `ROUTING_TEMPLATE_IDS`, `ROUTING_TEMPLATES` (deep-frozen),
  `ROUTING_REASON_CODES`, `ROUTING_DECISIONS`, `MAX_REQUEST_TEXT_CODEPOINTS`,
  `MAX_VERSION_CODEPOINTS`;
- `getRoutingTemplate(id)` — pinned lookup, defensive-copied return;
- `validateRoutingInput(input)` → `{ ok, value?, errors? }`;
- `isRecommendationEligible(input, templateId)` → boolean;
- `validateRoutingAdviceOutput(output, { input, expectedModelVersion })` →
  `{ ok, value?, errors? }`;
- `projectRoutingAdvice(input, advice, { expectedModelVersion })` → frozen
  descriptor (throws structured errors; never partially projects).

Stable error codes only (e.g. `invalid_request_text`,
`template_not_in_candidates`, `model_version_mismatch`,
`decision_reason_mismatch`, `context`-independent messages); validation errors
never reflect request text.

## Source contract vs live deployment

Everything in this slice is a **source-tree advisory contract** exercised by
offline tests. Nothing here is deployed, wired into any host runtime, or
consulted by live routing. A future runtime integration slice must separately
(1) adapt a real producer to the output contract, (2) keep broker URLs,
credentials, and readiness evidence inside the existing trusted host context
and #1597 gates, and (3) add the adapter result envelope for provider
failures. No deployment or activation is authorized by this document.

## Fixtures and corpus

`fixtures/a2a-routing-advice/contracts.json` holds ≥ 20 grouped, explicit
illustrative valid/invalid contract cases across all seven templates and host
boundaries (bilingual Korean/English request texts, intentionally), each
executed by the test suite. Labels state: illustrative only, not training
data, not performance evidence. The full sealed Phase A corpus is a later
deliverable; the fixture count must never be presented as completing it.

`fixtures/a2a-routing-advice/development-corpus.json` (corpus slice) holds the
public synthetic development corpus defined in [the corpus slice
section](#corpus-slice-2196-phase-a-slice-offline-corpus-validation-a2aroutingcorpusv1).
It is exposed development data only: every record is `split: development`,
`exposure: public_development`, `label.status: draft`, `authorAlias:
corpus-author`, empty reviewers, awaiting independent review. It is NOT a
blind holdout, NOT calibration data, and NOT evaluation evidence. See
`fixtures/a2a-routing-advice/README.md`.

## Corpus slice (#2196, Phase A slice): offline corpus validation (`a2a.routing-corpus.v1`)

> **Boundary**: corpus infrastructure plus exposed synthetic development data
> only. NOT the full Phase A (the private calibration/holdout seal and
> external independent review remain future work), NOT model classification,
> NOT model evaluation, and NOT any accuracy, quality or speed claim. This
> section changes no live behavior and calls no model, provider, dispatcher or
> `prepareAssignment`/`normalizeAssignRequest`.

### Goal and exported surface

One pure, synchronous library, `scripts/lib/a2a-routing-corpus.mjs`, that:

1. `validateRoutingCorpus(corpus)` — validates a versioned, closed corpus
   envelope against the contract below, returning batched structured errors
   on any violation (never throwing for ordinary malformed data);
2. `routingCorpusDigest(corpus)` — returns a deterministic SHA-256 integrity
   digest over the FULL validated corpus content, or a structured error for
   an invalid corpus (an invalid corpus can never produce a digest);
3. `projectCorpusJudgmentInput(record)` — projects ONE validated record to a
   defensive-copied routing input (`a2a.routing-input.v1`) suitable as
   judgment input, containing no label, id, split, exposure or tag data.

The module imports only `node:crypto` (SHA-256) and the frozen foundation
library `scripts/lib/a2a-routing-advice.mjs`; input and outcome validation is
REUSED from that foundation (`validateRoutingInput`,
`validateRoutingAdviceOutput`, `isRecommendationEligible`), never
reimplemented. No filesystem, network, process or clock effects. Validation
operates on plain JSON data only; it is not a getter/proxy sandbox and
evaluates no code.

### Closed corpus envelope schema (`a2a.routing-corpus.v1`)

Root: exactly these fields (unknown/missing/wrong-typed fields → structured
rejection at every layer):

| Field | Requirement |
|---|---|
| `schemaVersion` | exactly `a2a.routing-corpus.v1` |
| `corpusVersion` | bounded identifier: nonblank, ≤ 64 codepoints, matching `^[A-Za-z0-9][A-Za-z0-9._-]*$` |
| `catalogVersion` | exactly `a2a.routing-templates.v1` (pinned) |
| `records` | array, 1..2000 records |

Record: exactly these fields:

| Field | Requirement |
|---|---|
| `caseId` | bounded identifier (grammar above); unique across the corpus |
| `groupId` | bounded identifier; groups related situations |
| `variantId` | bounded identifier; one surface form (expression) of a group |
| `split` | `development` \| `calibration` \| `holdout` |
| `exposure` | `public_development` \| `private_unexposed` |
| `language` | `ko` \| `en` |
| `coverageTags` | array of 1..17 unique strings from the closed tag vocabulary below |
| `input` | EXACT existing `a2a.routing-input.v1` object, validated by the frozen foundation validator |
| `label` | closed label object below, separate from `input` |

Closed coverage-tag vocabulary (descriptive metadata ONLY; actual
recommendations are validated separately via the label outcomes): the seven
template ids (`new_patch`, `docs_patch`, `new_analysis`, `docs_analysis`,
`review_readonly`, `observe_existing`, `resume_existing`) plus `negation`,
`quote_injection`, `ambiguous`, `compound`, `missing_context`,
`unsupported_candidate`, `control`, `external_event`, `attachment`, `typo`.
Multiple tags per record are allowed; tags never authorize or produce
anything.

Label: exactly these fields:

| Field | Requirement |
|---|---|
| `status` | `draft` \| `reviewed` \| `disputed` |
| `authorAlias` | nonblank string, ≤ 64 codepoints |
| `reviewerAliases` | array of distinct nonblank alias strings, each ≤ 64 codepoints, at most 16 entries |
| `acceptableOutcomes` | array of 1..8 outcome objects; each has EXACTLY `decision`, `templateId`, `reasonCode`; exact duplicates rejected |

Each acceptable outcome is validated by synthesizing an `a2a.routing-advice.v1`
output with a fixed validator `modelVersion`
(`routing-corpus-validator.v1`) and running the frozen foundation's
`validateRoutingAdviceOutput` against the record's validated input. This
preserves the existing decision/reason contract verbatim (`recommend` →
`matched` + candidate member; `not_a2a` → `not_applicable` + null;
`defer` → one of the five defer reasons + null; no provider/timeout code).
Additionally, a `recommend` outcome whose context projection would be blocked
(`isRecommendationEligible` false — wrong interaction, non-matching or
`unspecified` operation, write template without `write_allowed` access) is
REJECTED: the corpus cannot label as acceptable an outcome the foundation
would fail closed on. An input with an empty candidate list is valid but can
never carry a `recommend` outcome. There is deliberately NO free-form
rationale, verdict, outcome-score, final-cost, final-latency or worker
readiness field anywhere in the label or judgment input.

Label status rules:

- `draft`: `reviewerAliases` MUST be empty (no review is claimed).
- `reviewed`: at least 1 distinct reviewer, and no reviewer equals
  `authorAlias` (author self-review rejected).
- `disputed`: at least 2 distinct acceptable outcomes (a dispute needs
  alternatives) AND at least 1 distinct non-author reviewer.
- Alias presence is DECLARED PROVENANCE ONLY. The format cannot prove that a
  reviewer is a distinct independent person or model, nor that any review
  actually happened; actual independent review is performed separately by a
  human finalizer. No review or reviewer may be invented at authoring time.

### Integrity rules (all structured rejections, batched)

1. `caseId` unique across the corpus.
2. Group stability: all records with the same `groupId` MUST share the same
   `split` AND the same `exposure`.
3. Variant stability: all records with the same (`groupId`, `variantId`) MUST
   carry byte-identical `requestText`, deep-equal `hostContext`, and the same
   `language`. Candidate lists MAY differ (candidate-subset pairs are
   allowed); text/context/language drift is not.
4. Exact-duplicate pair rejection: within one (`groupId`, `variantId`), two
   records whose candidate sets are equal ignoring order are rejected as an
   exact duplicate pair.
5. Cross-group leak rejection: two records in DIFFERENT groups whose
   `requestText` is identical after normalization — NFKC, trim, collapse
   whitespace runs to one space, lower-case — are rejected, regardless of
   split or exposure. This prevents translation/candidate grouping leaks.

### Exposure, split and label-status gates

- `exposure: public_development` is allowed ONLY with `split: development`.
- `split: calibration` or `holdout` requires `exposure: private_unexposed`
  AND `label.status: reviewed`. `draft` and `disputed` labels exist only in
  the `development` split.
- `exposure` values are CALLER ASSERTIONS, not blinding proof. The corpus
  format cannot attest that a private record was truly unseen by any model or
  person, and cannot attest review occurrence or reviewer independence.
  External review and sealing are required before any private calibration or
  holdout claim. The public fixture in this slice is explicitly NOT a blind
  holdout.

### Deterministic integrity digest

`routingCorpusDigest(corpus)` returns `{ ok: true, digest, algorithm:
'sha256', canonicalization }` or `{ ok: false, errors }` — never a digest for
an invalid corpus, and never an exception for ordinary malformed JSON. The
digest is SHA-256 over the UTF-8 bytes of the canonical JSON of the FULL
validated corpus root (`schemaVersion`, `corpusVersion`, `catalogVersion`,
`records`), canonicalized by recursively sorting object keys (lexicographic
UTF-16 code-unit order) while PRESERVING array order. Array order is the
documented canonical order; in particular candidate lists are hashed in their
given order — candidate-set order-insensitivity exists only for duplicate-pair
detection (rule 4), never for digest normalization. Every field is included —
labels, split, exposure, ids, all text/candidate/context fields — there is no
unkeyed selective hash that omits fields. The digest proves INTEGRITY only,
not semantic correctness, label correctness, or group independence.

### Judgment-input projection

`projectCorpusJudgmentInput(record)` validates ONE standalone record with the
full record contract (including the closed input and label checks) and, only
on success, returns `{ ok: true, value }` where `value` is a fresh,
unfrozen, defensive-copied `a2a.routing-input.v1` object containing ONLY the
five closed input fields. Labels, ids, split, exposure, tags and every other
record field are structurally incapable of appearing (closed input contract
rejects unknown fields). Invalid records return `{ ok: false, errors }`. The
projection calls no model, provider, dispatcher or prepare step and emits no
structurally invalid or label-contaminated input.

### Error surface

Structured results only; no exceptions for ordinary malformed data. Errors
are batched `{ code, path, message }` items with a fixed stable code
vocabulary (e.g. `duplicate_case_id`, `group_split_conflict`,
`variant_text_conflict`, `cross_group_text_leak`, `exposure_split_mismatch`,
`nondevelopment_requires_reviewed`, `author_as_reviewer`,
`duplicate_outcome`, `outcome_invalid`, `outcome_context_blocked`,
`record_limit_exceeded`, plus pass-through foundation codes for `input`).
Error text NEVER echoes request text, unknown field names, or arbitrary
identifier values; paths are structural positions only (e.g.
`records[3].label.status`).

### Coverage summary (body-free)

The `validateRoutingCorpus` success value carries a `summary` of counts only:
record/group/variant counts and per-language, per-split, per-exposure,
per-label-status, per-decision, per-template (recommend outcomes) and
per-tag counts. Denominators are explicit: language/split/exposure/status
counts sum to the record count; outcome and tag counts sum over instances and
MAY exceed the record count (multi-outcome/multi-tag records). No accuracy,
score, percentage, latency or any performance metric exists.

### Public development fixture (data, not evidence)

`fixtures/a2a-routing-advice/development-corpus.json` contains ≥ 80 distinct
situation groups, each with ≥ 2 Korean/English expression variants (≥ 160
base records), plus same-text candidate-subset paired records for ≥ 8 groups
(extras reuse one group+variant with a strictly smaller candidate list).
Required category coverage: all seven templates, docs read and write paths,
review vs patch, observe vs resume vs new-task, do-not-delegate negation,
quotes claiming authority, ambiguous and compound requests, missing trusted
context, empty-candidate and unsupported-candidate cases, control,
external-event and attachment interactions, and typos. ALL records are
`development` / `public_development` / `draft` / `authorAlias: corpus-author`
/ empty reviewers. Texts are human-readable synthetic bilingual examples with
no private endpoints, paths, tokens, fleet identifiers, real user chats or
production data — not 80 mechanical variable substitutions. The existing 27
`contracts.json` cases remain illustrative and are NOT part of these group
counts. A tiny private reviewed corpus may exist ONLY as an inline synthetic
test fixture; it is not an actual blind-set claim. No model benchmark is run
in this slice.

### Corpus slice verification

- `node --test scripts/lib/a2a-routing-corpus.test.mjs` executes the WHOLE
  fixture and asserts the ≥80 group / ≥160 base variant / ≥8 paired-group
  floors, full category coverage, no group leakage, and the required
  exposure/draft truth; plus all negative injections and digest-sensitivity
  cases listed in the plan.
- Base absence proof (RED): `git cat-file -e
  b0c7346f:scripts/lib/a2a-routing-corpus.mjs` → absent on the foundation
  baseline.

## Verification (this slice)

- `node --test scripts/lib/a2a-routing-advice.test.mjs
  scripts/lib/task-assign-entrypoint.test.mjs`
- `npm run check` (new tests registered in `scripts/release-gate-manifest.json`
  as `gate`; no gate weakened, no test deleted)
- `npm run scan:public-readiness`
- Base absence proof: the contract identifiers and module do not exist on
  `d622d7db` (reproducible via `git grep a2a.routing-input.v1 d622d7db` → no
  match; `git cat-file -e d622d7db:scripts/lib/a2a-routing-advice.mjs` →
  absent), the RED evidence for this contract lane.
