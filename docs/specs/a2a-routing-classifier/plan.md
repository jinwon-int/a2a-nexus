# Implementation Plan: A2A Routing Advice Foundation (#2196, offline slice 1)

> Slice 1 (the advisory foundation) is merged via #2197 (`b0c7346f`). The
> plan below is retained as the slice-1 record. Slice 2 — the Phase A corpus
> validation slice specified in [the corpus slice spec
> section](spec.md#corpus-slice-2196-phase-a-slice-offline-corpus-validation-a2aroutingcorpusv1) —
> is planned in [Slice 2](#slice-2-phase-a-corpus-validation-2196) at the end
> of this document, written before its code per the spec-first rule.

## Baseline

- Source baseline: `main@d622d7db4e1be032d6310c0a93f51de4d8655599` (issue #2196
  names this revision; it is current main in this checkout).
- Absence proof on base (RED for this contract lane), reproducible:
  - `git cat-file -e d622d7db:scripts/lib/a2a-routing-advice.mjs` → path absent;
  - `git grep -l 'a2a.routing-input.v1' d622d7db` → no match;
  - `git grep -l 'a2a-routing-advice' d622d7db` → no match.

## Scope discipline

Exactly seven paths change in this slice — three new code/fixture paths, two
new spec docs, two edits. No other file is touched: not the PR #2195 / #2185
calibration spec, not `scripts/lib/task-assign-entrypoint.mjs`, not shared
state, not CHANGELOG, not root bootstrap files, not deployed hosts, not live
routing.

| Path | Change |
|---|---|
| `docs/specs/a2a-routing-classifier/spec.md` | new — Medium spec (this packet) |
| `docs/specs/a2a-routing-classifier/plan.md` | new — this plan |
| `scripts/lib/a2a-routing-advice.mjs` | new — pure no-I/O advisory library |
| `scripts/lib/a2a-routing-advice.test.mjs` | new — contract + adversarial tests |
| `fixtures/a2a-routing-advice/contracts.json` | new — ≥ 20 reviewed-by-test illustrative contract cases |
| `docs/agent-manual.md` | edit — optional OFFLINE advisory entry only |
| `scripts/release-gate-manifest.json` | edit — register the new test as `gate` |

## Phase 1 — spec & plan (this PR, written before code)

1. Fix the closed contracts: input `a2a.routing-input.v1`, output
   `a2a.routing-advice.v1`, catalog `a2a.routing-templates.v1`, policy
   `a2a.routing-policy.v1`; reason-code enum with no provider/timeout codes;
   version-string bound (nonblank, ≤ 64 codepoints); request-text bound
   (nonblank, ≤ 4000 codepoints counted as codepoints).
2. Fix the seven-template catalog (deep-frozen, defensive copies), the
   eligibility gates (interaction `user_request`, exact operation match,
   write templates only under `write_allowed`), and the fail-closed projection
   (`template_descriptor` / `blocked` / `none`, `advisoryOnly`,
   `dispatchAllowed`).
3. Fix required-host-field metadata to preserve the actual mapping from
   `scripts/lib/task-assign-entrypoint.mjs` (patch fields verbatim; analysis +
   host-owned source/ownership contracts; review + PR/revision/workspace;
   `existingTaskReference` / `existingRequestReference`).

## Phase 2 — library (this PR)

`scripts/lib/a2a-routing-advice.mjs`, zero imports, zero I/O:

- deep-freeze helpers; stable `RoutingAdviceError` with `code`/`path`/generic
  message (never echoes request text);
- `validateRoutingInput`: closed-field check (unknown fields rejected at every
  level), enum checks, codepoint-length check, uniqueness/subset checks,
  frozen normalized value;
- `getRoutingTemplate` / `ROUTING_TEMPLATES`: pinned immutable catalog,
  defensive-copied returns;
- `isRecommendationEligible`: pure predicate over validated input + template;
- `validateRoutingAdviceOutput`: closed output fields, decision/reason/
  templateId consistency, candidate membership, catalog/policy/model version
  equality against input + caller `expectedModelVersion`, frozen value;
- `projectRoutingAdvice`: re-validates input + output, applies context gates,
  returns the bounded frozen descriptor; invalid output never partially
  projects; context-violating recommendations yield the structured `blocked`
  descriptor (never a plan for a new task).

## Phase 3 — tests & fixture (this PR)

`scripts/lib/a2a-routing-advice.test.mjs` (node:test, offline):

- all seven catalog mappings (operation/assignmentKind/intent/mode/access/
  new-id posture, observe/resume absence of assignmentKind/intent/mode);
- exhaustive 128 candidate subsets × 7 output template ids (recommend valid
  iff member; projection `template_descriptor` iff eligible else `blocked`);
- candidate unavailable / empty-candidate behavior (`no_candidate` defer);
- invalid mixed decision/reason/null-template matrices;
- wrong versions/types/missing/extra fields, nested host-context violations;
- multibyte request-text boundary (4000/4001 codepoints, surrogate pairs);
- `read_only`/`unspecified` access → write templates never eligible;
- `control`/`external_event`/`attachment` → no recommendation projection;
- observe/resume contexts can never become new-task plans; unknown
  (`unspecified`) context cannot authorize;
- request-text injection cannot override trusted context;
- input/result/catalog mutation cannot change future behavior (frozen values,
  defensive copies, no cross-call state);
- no output/error echoes secrets, commands, or request text;
- every fixture case in `fixtures/a2a-routing-advice/contracts.json` executed
  (≥ 20 cases, valid and invalid, all seven templates and host boundaries,
  bilingual Korean/English texts, explicit illustrative/not-trained/
  not-performance labels).

Fixture cases are data only: no private fleet names, paths, or secrets; public
doc language English.

## Phase 4 — gate registration & manual (this PR)

1. `scripts/release-gate-manifest.json`: append the new test file as
   `class: "gate"` with a justification note (offline advisory contract for
   #2196; no round id in filename). No entry is removed or weakened.
2. `docs/agent-manual.md`: add an optional OFFLINE advisory subsection
   exposing only functions that actually exist
   (`validateRoutingInput`, `isRecommendationEligible`,
   `validateRoutingAdviceOutput`, `projectRoutingAdvice`) with the
   advisory-only/dispatch-allowed-false boundary and a link to the spec.

## Phase 5 — verification (this PR)

1. `node --test scripts/lib/a2a-routing-advice.test.mjs
   scripts/lib/task-assign-entrypoint.test.mjs` — record exact pass counts.
2. `npm run check` (full release gate incl. manifest coverage sweep).
3. `npm run scan:public-readiness`.
4. Confirm no OpenClaw runtime/bootstrap context files
   (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`,
   `IDENTITY.md`, `.openclaw/**`) enter the changed-path set.

## Later phases (NOT this PR — explicitly tracked, not claimed)

1. Producer adapter: a real advice producer honoring
   `a2a.routing-advice.v1`, plus the separate adapter result envelope for
   provider/timeout failures (never folded into `defer`).
2. Phase A corpus: the full 160-case independently labeled corpus; the ≥ 20
   fixture cases here do not complete it.
3. Runtime integration: host wiring, `task-assign-entrypoint` consumption of
   the descriptor, live pilot — each requires its own spec, approval, and
   gate; zero runtime change is authorized by this slice.

## Risks & mitigations

- **Contract drift vs entrypoint mapping**: required-field metadata is copied
  from the entrypoint's actual missing-field names and reviewed against them
  in tests; the descriptor names host fields only and claims no
  assignment-readiness.
- **Advice mistaken for authorization**: `advisoryOnly: true` /
  `dispatchAllowed: false` invariants are structural (frozen into every
  descriptor) and asserted in tests; docs state catalog metadata is not
  readiness proof.
- **Context bypass via request text**: eligibility derives only from trusted
  host context; injection tests prove text cannot flip it.
- **Gate weakening**: manifest change is purely additive; the coverage sweep
  and full gate are run in Phase 5.

## Slice 2 — Phase A corpus validation (#2196)

> Written before its code (spec-first). Scope: corpus infrastructure plus an
> exposed synthetic development corpus ONLY. This slice is NOT the full
> Phase A: no private calibration/holdout seal, no external independent
> review (the finalizer performs review separately), no model classification,
> no model evaluation, no accuracy/quality/speed claim. PR refs #2196; does
> not close it.

### Baseline

- Source baseline: `main@b0c7346f` (foundation slice 1 merged via #2197).
- Absence proof on base (RED for this corpus lane), reproducible:
  - `git cat-file -e b0c7346f:scripts/lib/a2a-routing-corpus.mjs` → path
    absent;
  - `git grep -l 'a2a.routing-corpus.v1' b0c7346f` → no match.

### Scope discipline

Exactly eight paths change in this slice. The frozen foundation library
`scripts/lib/a2a-routing-advice.mjs`, its fixture `contracts.json` and its
test file are REUSED, never modified. No CHANGELOG, no root bootstrap, no
other files. No new top-level CLI, dependency, model/provider call,
dispatcher/prepare call, server or deployment. No PR2195 calibration file is
touched and no competing model evaluator is introduced. No skill-router v1
data or labels.

| Path | Change |
|---|---|
| `docs/specs/a2a-routing-classifier/spec.md` | edit — corpus slice section with the closed `a2a.routing-corpus.v1` schema (written first) |
| `docs/specs/a2a-routing-classifier/plan.md` | edit — this slice plan |
| `scripts/lib/a2a-routing-corpus.mjs` | new — pure synchronous corpus validator + SHA-256 digest + judgment-input projection |
| `scripts/lib/a2a-routing-corpus.test.mjs` | new — whole-fixture execution + adversarial/negative injections + digest sensitivity |
| `fixtures/a2a-routing-advice/development-corpus.json` | new — public synthetic development corpus (≥80 groups, ≥160 base records, ≥8 paired groups) |
| `fixtures/a2a-routing-advice/README.md` | new — corpus status labels (bilingual, synthetic, development-only, review pending, seal pending) |
| `docs/agent-manual.md` | edit — optional OFFLINE corpus-validation entry only |
| `scripts/release-gate-manifest.json` | edit — register the new test as `gate` (purely additive) |

### Phase 1 — spec & plan (done first, in this PR)

The corpus slice section of `spec.md` fixes, before any code: the closed
envelope schema (`a2a.routing-corpus.v1`; bounded identifier grammar; 1..2000
records; closed split/exposure/language/status/tag/alias vocabularies and
finite bounds), the label/outcome contract (reuse of the foundation
validators with the fixed `routing-corpus-validator.v1` modelVersion;
context-blocked recommends rejected; no rationale/verdict/cost/latency/
readiness fields), the five integrity rules (unique caseId; group split AND
exposure stability; variant text/context/language stability; order-insensitive
exact-duplicate-pair rejection; cross-group normalized-text leak rejection),
the exposure/label-status gates, the caller-assertion (not blinding-proof)
semantics of `exposure`, the full-content key-order-independent SHA-256
digest with preserved array order, the label-free defensive-copied
judgment-input projection, the no-echo error surface, the body-free coverage
summary, and the public development fixture floors.

### Phase 2 — library

`scripts/lib/a2a-routing-corpus.mjs`: zero I/O, synchronous, imports only
`node:crypto` (createHash) and the frozen foundation module. `validateRoutingCorpus`
validates root, records, inputs (via `validateRoutingInput`), labels,
outcomes (synthesized `a2a.routing-advice.v1` via `validateRoutingAdviceOutput`
+ `isRecommendationEligible`) and all integrity/gate rules, returning frozen
normalized values plus the body-free summary. `routingCorpusDigest` reuses
that validation and hashes canonical JSON (recursive UTF-16 code-unit key
sort, arrays order-preserved). `projectCorpusJudgmentInput` runs the full
standalone record validation and returns a fresh unfrozen deep copy of ONLY
the five closed input fields. Stable error codes; paths are structural; never
echo request text, unknown field names or identifier values.

### Phase 3 — fixture, README, tests

1. `fixtures/a2a-routing-advice/development-corpus.json`: hand-authored
   synthetic bilingual situations across ≥80 groups (all seven templates;
   negation, quote_injection, ambiguous, compound, missing_context,
   unsupported_candidate, control, external_event, attachment, typo; empty
   candidates; subset pairs), every record development/public_development/
   draft/corpus-author/empty reviewers. No private endpoints, paths, tokens,
   fleet identifiers, real user chats or production data.
2. `fixtures/a2a-routing-advice/README.md`: bilingual corpus, synthetic,
   exposed development only, labels awaiting independent review, Phase A
   private calibration/holdout seal still pending; no blind-holdout claim.
3. `scripts/lib/a2a-routing-corpus.test.mjs`: executes the whole fixture and
   asserts ≥80 groups / ≥160 base variants / ≥8 paired groups, all required
   categories, no group leakage, exposure/draft truth. Negative injections:
   duplicate ids; group split/exposure conflict; normalized-text duplicates
   across groups (Unicode NFKC + whitespace variants); same-variant
   text/context/language drift; reordered-candidate exact duplicates;
   candidate-missing/empty recommend; wrong-context recommend; mixed
   reason/null matrices; missing/unknown keys nested at every layer; invalid
   versions/types/nonfinite/improper bounds; label-field input leak; public
   holdout promotion; draft calibration; author self-review; duplicate
   aliases; disputed-constraint violations. Digest sensitivity: every
   label/input/metadata field changes the digest; key order does not; failed
   validation yields no digest. Projection: excludes all label/metadata,
   mutation-isolated. No body reflection of sentinel keys/text. A tiny
   synthetic private reviewed corpus (inline test data only) proves the
   calibration/holdout gates without any blind-set claim.

### Phase 4 — gate registration & manual

1. `scripts/release-gate-manifest.json`: append the new test as `class:
   "gate"` (no round id in filename). No entry removed or weakened.
2. `docs/agent-manual.md`: optional OFFLINE corpus-validation subsection
   exposing only functions that actually exist, with the caller-assertion
   boundary and no blind-holdout claim.

### Phase 5 — verification

1. `node --test scripts/lib/a2a-routing-corpus.test.mjs
   scripts/lib/a2a-routing-advice.test.mjs scripts/lib/task-assign-entrypoint.test.mjs`
   — record exact pass counts.
2. `npm run check` (full release gate incl. manifest coverage sweep).
3. `npm run scan:public-readiness`.
4. Confirm no OpenClaw runtime/bootstrap context files (`AGENTS.md`,
   `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`,
   `.openclaw/**`) enter the changed-path set.

### Later phases (NOT this slice — explicitly tracked, not claimed)

1. External independent review of these draft labels by the finalizer, then
   sealing of private calibration/holdout corpora under the same envelope.
2. Producer adapter and runtime integration (separate spec, approval, gate).
3. Any model classification, evaluation or performance measurement over the
   corpus. None is authorized or performed by this slice.

### Risks & mitigations

- **Fixture mistaken for a blind set**: README, spec and manual state the
  corpus is public, synthetic, exposed development data with draft labels;
  tests assert the exposure/draft truth structurally.
- **Digest mistaken for correctness proof**: docs state the digest proves
  integrity only; coverage summary carries counts, never scores.
- **Label contamination of judgment input**: projection returns a defensive
  copy of the closed five-field input only; closed input validation rejects
  any extra field; tests inject label-shaped sentinel fields and assert
  absence and mutation isolation.
- **Gate weakening**: manifest change is purely additive; full gate run in
  Phase 5.
