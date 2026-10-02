# Offline routing reference

> Language: English with Korean passages carried over unchanged from the agent manual.

Offline, advisory-only routing tools for A2A Nexus (#2196): routing advice, corpus validation, the deterministic rules baseline and assignment forms. None of them changes live routing behavior.

> Moved from Appendix A of the [agent manual](../../agent-manual.md) (#2258 C7) to keep the manual's quick path lean. Content unchanged apart from relative links.

### Offline routing advice (optional, offline-only) (#2196 foundation slice)

Hosts can validate a caller-supplied recommendation for one of seven routing
templates and inspect the trusted host fields it still requires. Import the
pure advisory library from the same checkout revision:

```js
import {
  validateRoutingInput,
  validateRoutingAdviceOutput,
  projectRoutingAdvice,
} from './scripts/lib/a2a-routing-advice.mjs';
```

- `validateRoutingInput` enforces the versioned closed input contract
  (`a2a.routing-input.v1`): nonblank request text ≤ 4000 codepoints, pinned
  catalog `a2a.routing-templates.v1`, unique candidate template ids, and a
  closed trusted host context (`interaction`/`operation`/`access`). Host
  context is explicit caller-owned data, never parsed from request text, and
  never authentication or permission proof.
- `validateRoutingAdviceOutput` checks closed advisory output
  (`a2a.routing-advice.v1`) against that input and the caller's
  `expectedModelVersion` (mismatch is rejected). There is no confidence,
  probability, path, command, worker id, scope or budget field, and no
  provider/timeout reason code — those belong to a later adapter envelope.
- `projectRoutingAdvice` projects validated advice to a bounded descriptor
  (`advisoryOnly: true`, `dispatchAllowed: false`) that only names the host
  fields still required, or fails closed: context-violating recommendations
  (wrong interaction, non-matching or `unspecified` operation, `read_only` or
  `unspecified` access for write templates) yield a structured blocked
  projection, never a plan for a new task. This slice calls no model, broker,
  or `prepareAssignment`/`normalizeAssignRequest`; it returns advice metadata
  only and claims no assignment readiness (catalog metadata is not a
  #1597 readiness proof).

Contract details and invariants: [the routing-classifier spec](spec.md).
This entry is advisory-only and offline; it changes no live routing behavior.

### Offline routing corpus validation (optional, offline-only) (#2196 Phase A slice)

Hosts that already hold a routing corpus envelope can validate it, compute its
integrity digest, and extract label-free judgment inputs offline. Import the
pure synchronous library from the same checkout revision:

```js
import {
  validateRoutingCorpus,
  routingCorpusDigest,
  projectCorpusJudgmentInput,
} from './scripts/lib/a2a-routing-corpus.mjs';
```

- `validateRoutingCorpus(corpus)` enforces the closed versioned envelope
  (`a2a.routing-corpus.v1`): bounded identifiers, ≤ 2000 records, pinned
  catalog, closed split/exposure/language/status/tag vocabularies, exact
  `a2a.routing-input.v1` inputs, and closed labels whose acceptable outcomes
  are re-validated through the advisory foundation (context-blocked
  recommends are rejected). Integrity rules (unique case ids, group and
  variant stability, duplicate-pair and cross-group normalized-text leak
  rejection) and the exposure/label-status gates are enforced before a
  frozen normalized value plus a body-free counts-only summary is returned.
- `routingCorpusDigest(corpus)` returns a deterministic SHA-256 digest over
  the FULL validated corpus content (recursive key sort, arrays preserved),
  or a structured error — an invalid corpus never yields a digest. The
  digest proves integrity only, never semantic correctness or group
  independence.
- `projectCorpusJudgmentInput(record)` validates one record and returns a
  fresh defensive copy of ONLY its five closed input fields — labels, ids,
  split, exposure and tags can never appear. No model, provider, dispatcher,
  or `prepareAssignment` call exists in this slice.
- Error results use stable codes with structural paths and never echo
  request text, unknown field names, or identifier values. `exposure` is a
  caller assertion, not blinding proof; reviewer aliases are declared
  provenance, not review evidence. The public fixture corpus is synthetic,
  exposed development data with independently reviewed annotations (see the
  fixture README for review provenance and uncertainty) —
  NOT a blind holdout; the private calibration/holdout seal and any model
  evaluation remain later Phase A work.

The public corpus lives at
[fixtures/a2a-routing-advice/development-corpus.json](../../../fixtures/a2a-routing-advice/development-corpus.json)
with status labels in [its README](../../../fixtures/a2a-routing-advice/README.md).
Contract details: [the routing-classifier spec](spec.md).

### Offline deterministic routing rules baseline (optional, offline-only) (#2196 slice 3)

Hosts that want a conservative first-pass route for free-form request text can
classify a validated routing input with declared deterministic rules — no
model, no embeddings, no network. Import the pure synchronous library from the
same checkout revision:

```js
import { classifyRoutingWithRules, ROUTING_RULES_MODEL_VERSION } from './scripts/lib/a2a-routing-rules.mjs';
```

- `classifyRoutingWithRules(input)` takes the EXACT `a2a.routing-input.v1`
  contract (validate it with `validateRoutingInput`; the caller owns the
  trusted `hostContext`) and returns exactly `{ ok, value }` or
  `{ ok, errors }`: `value` is a closed `a2a.routing-advice.v1` advice stamped
  `modelVersion: 'a2a.routing-rules.v1'`, or `errors` is a batched list of
  `{ code, path, message }` items. There is no confidence, probability, path,
  command, worker id, scope, or budget field, and no extra result fields.
- The rules recognize narrow, declared Korean and English phrasing families
  for ALL seven templates (patch/docs-patch writes, analysis/docs-analysis,
  review, existing-task status checks, explicit resume-tracking), plus
  conservative defers: ambiguous, insufficient_context, no_candidate,
  unsupported_template, uncertain. Inference uses the requested action, not
  isolated keywords; text without a supported signal defers. Unusual contexts
  may still be misclassified, so recommendations remain advisory. This is a
  keyword/scope baseline, NOT general natural-language understanding.
- Precedence you can rely on: control/external_event/attachment interactions
  and explicit do-not-delegate or chat-only texts yield `not_a2a` independently; quoted or
  code-fenced commands never trigger a positive action by themselves and can
  never override trusted context; execution-retry asks (`restart/rerun the
  failed execution`, `실패한 작업을 다시 실행해줘`) defer as
  `unsupported_template` instead of pretending to be tracking resume;
  empty candidates yield `no_candidate`; missing or contrary trusted context
  defers — text claiming approval, write access, or readiness cannot change
  host flags. Recommendations always pass the frozen
  `isRecommendationEligible` gate, so projection is never blocked.
- Tracking resume with a separate review/analysis request stays ambiguous;
  resuming the same existing review remains supported. Declared alternatives
  such as `or`, `하거나`, and `또는` also defer rather than select one action.
- Unresolved competing actions stay ambiguous even if only one candidate is
  available. Recognized action prohibitions and reported-completion patterns
  suppress positive recommendations; normalization expansion beyond 4000
  codepoints defers without discarding a potentially meaningful suffix.
- Malformed input returns structured `ok:false` errors — never a throw, never
  a semantic defer; error text never echoes request text. A `defer` here is a
  SEMANTIC rules outcome, never a provider failure or timeout; an adapter
  process/timeout envelope remains a separately specified future boundary.
- Boundaries: pure and synchronous (no fs/network/process/clock, no module
  state), no common embedding/cache engine (that remains fleet-skill-router
  #4; nothing is duplicated), no private calibration/holdout seal, no
  prepare/dispatch/runtime wiring, no live pilot. The development-corpus
  replay in the test suite is a contract check over EXPOSED development data
  with honest counts — not an accuracy, quality, holdout, or latency claim.

Rule ordering, preprocessing, and the complete support surface:
[the routing-classifier spec](spec.md) (rules
baseline slice). This entry is advisory-only and offline; it changes no live
routing behavior.

### Offline routing assignment forms (optional, offline-only) (#2196 slice 4)

Hosts holding a validated advisory routing descriptor can build the exact
assignment request shape and prepare the assignment fully offline — the
readiness GATE, never dispatch. Import the wrapper from the same checkout
revision:

```js
import {
  buildAssignmentRequest,
  prepareRoutingAssignment,
  ROUTING_FORMS_VERSION,
} from './scripts/lib/a2a-routing-assignment-forms.mjs';
```

- `buildAssignmentRequest` is pure and synchronous and mirrors the entrypoint
  projection contract: request text, pinned template catalog, template id,
  lanes, and trusted host fields must satisfy the exact shapes
  `prepareAssignment` consumes. Host context is CONTEXT-ONLY and presence
  checks only — `host.*` values are never copied, echoed, or stored, unknown
  keys are dropped, and a host field equal to the broker URL or a
  secret-shaped key (`secret`, `token`, `password`, `authorization`,
  `credential`) fails closed with `untrusted_broker_or_secret_input` naming
  `request.<key>` BEFORE any draft is built.
- Success returns a frozen closed `{ ok: true, request }`; validation failure
  returns a frozen `{ ok: false, reasonCodes, missingFields, invalidFields }`
  with exact dotted field names. `none`/`blocked` projections are rejected as
  `projection_not_convertible` (a synthesized plan is never produced), and
  existing-reference templates must carry the referenced task/journal fields
  or fail with the exact missing names. There is no confidence, probability,
  scope, budget, or dispatch field anywhere in the shape.
- `prepareRoutingAssignment` has a FIXED offline posture (no mode parameter):
  an existing request-journal record resumes via `resumeAssignment`
  (journal-first), otherwise `prepareAssignment` runs with
  `mode: 'offline'`. It never POSTs and never contacts a broker — the fetch
  dependency must be injected, and omitting it throws at call time so a
  network attempt cannot happen silently. Receipts are returned UNMODIFIED:
  entrypoint reason codes and states (including `kind_lane_mismatch`, which
  surfaces as a `needs_input` receipt) stay entrypoint-authoritative; this
  wrapper adds forms plumbing only and never re-classifies.
- Boundaries: a `prepared` receipt proves contract shapes and local journal
  state only — no worker was contacted, no task created, no POST sent. It is
  NOT a #1597 readiness proof, there is no runtime/CLI wiring, and live
  routing behavior is unchanged.

Contract details and invariants:
[the routing-classifier spec](spec.md)
(assignment-forms slice). This entry is advisory-only and offline; it changes
no live routing behavior.
