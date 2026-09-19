# Feature Spec: A2A Routing Advice Foundation (#2196, offline slice 1)

> **Status**: offline foundation slice only. This slice ships a pure, no-I/O
> advisory library plus its contract tests, fixtures and documentation. It is
> NOT the model, NOT runtime integration, NOT the full classifier, and NOT
> issue completion. This document authorizes no dispatch, no deploy, no live
> routing change, and no worker/broker mutation.
>
> Baseline: `main@d622d7db4e1be032d6310c0a93f51de4d8655599`.

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
- The full 160-case independently labeled Phase A corpus is a **later** phase.
  The ≥20 reviewed-by-tests fixture cases below are illustrative contract
  examples and do NOT complete Phase A.

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
data, not performance evidence. The 160-case independently labeled corpus is a
later Phase A deliverable; the fixture count must never be presented as
completing it.

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
