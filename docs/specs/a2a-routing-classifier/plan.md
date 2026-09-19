# Implementation Plan: A2A Routing Advice Foundation (#2196, offline slice 1)

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
