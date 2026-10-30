# Analyze: broker `core/` domain boundaries — measurement and split order

> **Status:** repository analysis, documentation only. First deliverable of
> #2453 (parent #1601, modularize-first). No runtime change, no file move, no
> new script, and no gate change is made or authorized by this document.
> Measured at `origin/main` `30832157` (2026-10-29).
> **Revised 2026-10-29** after an independent review: Step 0 now has a fifth
> edit (the earlier numbers applied the sink only to edges that were already
> cross-domain), the TCK filter risk is resolved by #2476, more path consumers
> are listed, and the owner decisions are recorded in
> [Owner decisions](#owner-decisions-2026-10-29).
> **PR-0 implemented** (enforcement plus Step 0): see
> [PR-0 implemented](#pr-0-implemented).
> **Step 4 implemented** (CLI-only retirement: 6 of 8 retired in #2481; the
> other 2 are kept permanently by the 2026-10-30 owner decision): see
> [Step 4: CLI-only retirement](#step-4-cli-only-retirement).
> **Step 5 implemented** (execution pilot, the first physical move): see
> [Step 5: execution pilot](#step-5-execution-pilot).
> **Claim move implemented** (split-order row 3): see
> [Claim move](#claim-move).
> **Evidence move implemented** (split-order row 4): see
> [Evidence move](#evidence-move).
> **Dispatch move implemented** (split-order row 5): see
> [Dispatch move](#dispatch-move).
> **Completion move implemented** (split-order row 6): see
> [Completion move](#completion-move).
> **Observability move implemented** (split-order row 7, first of three
> domains): see [Observability move](#observability-move).

## Summary

- **Size.** `packages/broker/src/core/` holds **181 non-test modules /
  67,936 LOC** in one flat directory (no subdirectories). That is exactly the
  `brokerCoreModules` budget (181/181); ceremony-named modules are 20/21.
- **Domains.** A filename heuristic plus 53 explicit overrides puts every
  module in one of 12 buckets. The five loop domains together are 75 modules /
  28,201 LOC (41.5%): dispatch 17 / 7,382, claim 13 / 2,390, execution 9 / 2,348,
  completion 25 / 12,043 and evidence-retrieval 11 / 4,038. The largest
  single bucket is **policy-approval (37 modules / 15,335 LOC, 22.6%)**, which
  holds 19 of the 20 ceremony-named modules.
- **Graph.** 521 intra-core import edges, of which 208 are type-only. 395 edges
  cross a domain: 215 go into the kernel and 79 come out of the facade
  (`broker.ts`, fan-out 79). The remaining 110 cross-domain edges (**46 of them value
  edges**) are the ones the split has to deal with.
- **Cycles.** At file level there are **no value-import cycles**. The three
  file cycles (31, 4 and 3 modules) are type-only, so they are erased at
  runtime. At domain level everything is one strongly connected component
  today. Three things cause it: the kernel is not a sink (8 value edges out of
  it), there are 4 value back-edges into `broker.ts`, and a handful of
  misplaced shared shapes.
- **Step 0 removes every value-level domain cycle with no file move — with
  five edits.** The step is: sink 15 shared shape and port modules into the
  kernel, reclassify 6 modules, re-point 4 imports, and sink the
  `CURRENT_BROKER_STATE_VERSION` constant that `store-schemas` (a sunk module)
  value-imports from `store-contracts`. After it, the target allow-matrix shows
  **1 value violation (from 20) and 23 type-only (from 37); 24 total (from
  57)**, and the value-only domain graph without the facade is acyclic.
  Without the fifth edit the result is 25 / 2 and {completion, dispatch,
  execution, kernel, store} stays cyclic.
- **Proposed order (owner decision 2026-10-29):** the #2454 package move first,
  then PR-0 (enforcement scaffold with a committed filename-to-domain map, plus
  Step 0), then retire the CLI-only policy modules, then execution as the move
  pilot. The later order (policy-approval, claim, evidence-retrieval, dispatch,
  completion, outer layers) stays a proposal. The kernel and the facade stay at
  the `core/` root.
- **Enforcement:** replace the line-based import scan in
  `scripts/check-broker-core-dependency-isolation.mjs` (it misses the
  multi-line imports used by 83 core modules) and drive it from the domain map
  with an allow-matrix. No new `scripts/*.mjs` and no new npm script, because
  both budgets are full (160/160, 45/45).
- **Biggest hidden risks:**
  0. ~~The TCK filter skipped `core/`-only PRs~~ — **resolved by #2476**
     (`tck-promoted-gate` filter is now `packages/broker/src/**`).
  1. The broker test manifest globs `dist/core/*.test.js` without recursion,
     so moved tests would silently stop running (`tests 0` still exits 0).
  2. A domain directory whose name contains a ceremony marker (for example
     `approval`) would turn every module inside it into a ceremony module.
  3. 58 operator scripts import literal `dist/core/<file>.js` paths, and a few
     build the path at runtime, which `scripts/check-dist-import-resolution.mjs`
     does not see (see Risks 4).

## Inputs and relation to prior work

- Issues #2453 and #1601 (goal 1 loop: dispatch, claim, execute, verify,
  evidence, merge; principle: modularize-first, extract-second).
- [core-slimdown first slice spec](../core-slimdown-first-slice/spec.md). That
  slice moved a *workload domain* (NCLEX) out of the broker. This analysis
  covers the *control-plane* domains that stay inside `core/`. The import-guard
  recipe ("extend `check-broker-core-dependency-isolation.mjs` style guards") is
  reused here.
- `packages/broker/scripts/core-hotspot-report.mjs` (#1503) already reports
  file-level fan-in/fan-out, Tarjan SCCs and `core -> outside core` upward edges
  (52 today) over all of `packages/broker/src`. This survey **agrees with it**:
  `broker.ts` fan-in is 62 = 12 in-core + 50 outside, `types.ts` is 143 = 88 +
  55, and the same 31/4/3-module SCCs appear. It adds what that report lacks:
  domain grouping, type-only vs value edges, and an allow-matrix.
- `scripts/check-script-budget.mjs` (#882, #1601): budgets for core modules
  (181) and ceremony modules (21) that match on the *relative path*.
- `scripts/check-broker-core-dependency-isolation.mjs` currently forbids only
  harness packages (`openclaw`) in `packages/broker/src`. It has a unit test in
  the release-gate manifest.
- #2350 duplication cleanup (done). Its A7 item (status-table consolidation of
  the `orchestration-intelligence-*-approval-decision-evidence` modules) is on
  hold. Those modules sit in the policy-approval bucket below.

## Method

Scope: `packages/broker/src/core/*.ts` excluding `*.test.ts`. That is the same
set `check-script-budget.mjs` counts. `requester-role-contract.mjs` is the only
non-`.ts` file in `core/` and is not counted. LOC means newline count (`wc -l`).
The hotspot report counts one more per file.

**Import edges.** A regex scan finds static `import … from`, `export … from`,
bare `import "x"` and inline type `import("x")`. Edges are deduplicated per
(importer, target) pair; a value import wins over a type import. An edge is
*type-only* when the clause is `import type`, `export type`, or every named
specifier is `type X`. Coverage was checked against a raw grep of
`from "./…"`: the only unmatched hits are two comments.

**Domain classification** (deterministic, first match wins):

1. An explicit override table (53 entries). Each entry is a judgment call,
   visible in the appendix script.
2. Filename rules in this order:

| order | domain | filename pattern (regex) |
|---:|---|---|
| 1 | policy-approval | the 9 `CEREMONY_MODULE_MARKERS` of the budget script (with `dry-?run`), `^orchestration-intelligence-`, `canary` |
| 2 | test-support | `test-helpers` |
| 3 | store | `^store`, `repository`, `^sqlite-`, `retention`, `cleanup` |
| 4 | transport | `conversation`, `exchange`, `^task-event(s)`, `listener` |
| 5 | completion | `terminal`, `closeout`, `finalizer`, `receipt` |
| 6 | evidence-retrieval | `evidence`, `lineage`, `-read.ts`, `proposal-read` |
| 7 | observability | `dashboard`, `stats`, `report`, `alert`, `diagnostic`, `growth` |
| 8 | execution | `subagent` |
| 9 | claim | `worker`, `capabilit`, `claim`, `heartbeat`, `requeue`, `wake` |
| 10 | execution | `execution`, `checkpoint`, `cancel`, `retry`, `runtime` |
| 11 | dispatch | `dispatch`, `admission`, `intent`, `round`, `complexity`, `work-mode`, `wave-plan`, `scheduler`, `task-request`, `team1` |
| 12 | kernel | `helpers`, `error`, `collections`, `value-`, `guards`, `normalizers`, `filters`, `predicates`, `validators`, `types` |

No module is left unclassified.

**What each domain means:**

- **dispatch:** intake and admission, intent routing, round and wave planning,
  pre-dispatch work-mode and complexity classification.
- **claim:** who may take a task. Worker identity, capability, capacity and
  liveness, heartbeat, wake, stale requeue.
- **execution:** in-flight control. Execution policy, checkpoint, cancellation,
  retry, delegated runtime, knowledge injection, subagent briefs.
- **completion:** terminal transitions, Terminal Brief and outbox, finalizer
  verdict admission, round status and results, cross-broker terminal relay.
- **evidence-retrieval:** task, worker and evidence read models; task and
  review lineage; proof, release and wave evidence.
- **policy-approval:** policy evaluation plus the operator approval-ceremony
  chains (operator approval, orchestration-intelligence, complexity plan,
  Terminal Brief approval, source-public, proposals).
- **transport:** conversation, exchange and conference planes, task event
  stream and dispatcher, request security (HTTP authentication).
- **observability:** dashboards, stats, diagnostics, alerts, hot-table growth.
- **store:** the SQLite state store, schemas, snapshot I/O, retention and
  cleanup, repository ports.
- **kernel:** types, contracts, errors, value guards, shared normalizers and
  validators.
- **facade:** `broker.ts` (the `InMemoryA2ABroker` composition root).
- **test-support:** non-test helper modules used by tests.

**Ambiguity check.** For each module outside kernel, store, facade and
test-support, the script counts the domains of its imports and importers. A
module is flagged when the majority domain differs from the one it was
assigned.

**Reproduce:**

```sh
# Copy the appendix script to a scratch directory OUTSIDE the checkout, then:
node /tmp/core-survey/survey.mjs <checkout> > /tmp/core-survey/out.json
# The tables below are projections of out.json
# (domains, matrix, fileCycles, domainCycles, violations, violationsAfterSink).
```

## Measurements

### Per-domain size and coupling

In the coupling columns, *in* counts edges from other domains, excluding the
facade and test-support. *out* counts edges to other domains, excluding the
kernel. Each pair is shown as all edges / value edges. *outside-core
importers* is the number of modules in the domain that are imported from
`packages/broker/src` outside `core/`.

| domain | files | LOC | LOC % | ceremony-named | in (all/value) | out excl. kernel (all/value) | imported by facade | outside-core importers |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| dispatch | 17 | 7,382 | 10.9 | 1 | 12/9 | 6/3 | 6 | 6 |
| claim | 13 | 2,390 | 3.5 | 0 | 10/7 | 3/2 | 11 | 1 |
| execution | 9 | 2,348 | 3.5 | 0 | 4/1 | 3/2 | 3 | 3 |
| completion | 25 | 12,043 | 17.7 | 0 | 23/13 | 6/4 | 7 | 8 |
| evidence-retrieval | 11 | 4,038 | 5.9 | 0 | 6/1 | 12/7 | 9 | 4 |
| policy-approval | 37 | 15,335 | 22.6 | 19 | 4/3 | 10/5 | 4 | 7 |
| transport | 17 | 4,943 | 7.3 | 0 | 4/0 | 10/5 | 11 | 3 |
| observability | 9 | 4,084 | 6.0 | 0 | 6/2 | 7/4 | 3 | 5 |
| store | 27 | 8,105 | 11.9 | 0 | 27/6 | 25/5 | 16 | 5 |
| kernel | 13 | 2,994 | 4.4 | 0 | 205/131 | 25/8 | 9 | 6 |
| facade | 1 | 3,961 | 5.8 | 0 | 11/3 | 70/57 | — | 1 |
| test-support | 2 | 313 | 0.5 | 0 | 0/0 | 3/1 | 0 | 0 |
| **total** | **181** | **67,936** | 100 | 20 | | | | 49 |

The ceremony-named module filed under dispatch is `scheduler-dry-run`, placed
there by override.

### Domain membership

Each module is listed with its LOC.

- **dispatch (17):** `a2a-dispatch-helper` 629, `a2a-intent-router` 162,
  `a2a-round-policy` 409, `adaptive-work-mode-selector` 433,
  `broker-task-admission` 493, `broker-task-request-normalizers` 326,
  `complexity-orchestration-recommendation` 374, `live-task-admission` 339,
  `parent-round-registry` 232, `round-manifest` 802, `scheduler-dry-run` 689,
  `task-complexity-classifier` 437, `team1-dispatch-wrapper` 1182,
  `wave-plan-dag-v2-mode` 18, `wave-plan-store` 172, `wave-plan` 197,
  `work-mode-pre-dispatch-decision` 488.
- **claim (13):** `broker-capability-normalizers` 180,
  `broker-capability-profiles` 59, `broker-stale-task-requeue` 212,
  `broker-wake-normalizers` 89, `broker-worker-capacity` 147,
  `broker-worker-identity` 172, `broker-worker-runtime` 104,
  `broker-worker-status` 111, `heartbeat-persist-throttle` 36,
  `resource-aware-worker-policy` 480, `worker-capability-card` 496,
  `worker-identity-churn-tracker` 72, `worker-self-assessment-capacity` 232.
- **execution (9):** `a2a-execution-policy` 198, `broker-knowledge-injection`
  187, `broker-task-cancellation` 228, `broker-task-checkpoint` 242,
  `delegated-runtime` 288, `task-retry-policy` 188,
  `worker-subagent-context-brief` 295, `worker-subagent-planner-handoff` 242,
  `worker-subagent-spawn-authorization-request` 480.
- **completion (25):** `a2a-dialectic-lite-finalizer` 442,
  `broker-task-terminal` 521, `broker-terminal-receipt-parity` 265,
  `cross-broker-terminal-brief-receiver` 474, `cross-broker-terminal-brief`
  727, `finalizer-verdict-admission` 144, `github-task-completion` 323,
  `round-progress-tracker` 222, `round-result-collector` 1779, `round-status`
  417, `task-error-details` 135, `terminal-brief-auto-closeout-planner` 466,
  `terminal-brief-closeout-gate` 403, `terminal-brief-completion-watcher` 471,
  `terminal-brief-final-count-closeout` 339, `terminal-brief-finalizer-handoff`
  389, `terminal-brief-finalizer-workflow` 310, `terminal-brief-metadata` 714,
  `terminal-brief-query-api` 648, `terminal-brief-routing` 261,
  `terminal-brief-value-guards` 31, `terminal-event-outbox` 1688,
  `terminal-outbox-backlog-risk` 301, `terminal-outbox-legacy-classifier` 330,
  `terminal-receipt-gap-matrix` 243.
- **evidence-retrieval (11):** `broker-evidence-read` 92, `broker-task-read` 86,
  `broker-worker-read` 80, `proof-matrix` 418, `release-evidence` 508,
  `review-lineage-observation-store` 914, `review-lineage-producer-admission`
  50, `review-lineage-store` 104, `task-lineage-index` 438, `task-lineage-read`
  1268, `wave-evidence` 80.
- **policy-approval (37):** `broker-proposal-read` 44, `broker-proposal-write`
  313, `broker-rehearsal-manifest` 206, `broker-task-approval` 172,
  `complexity-execution-plan-draft` 855,
  `complexity-execution-plan-preflight-seal` 1112,
  `complexity-finalizer-approval-envelope-draft` 610,
  `complexity-orchestration-dry-run` 165, `operator-approval-request` 1375,
  15 × `orchestration-intelligence-*` (5,214 LOC in total), `policy` 165,
  `receipt-gate-canary` 401, `runtime-safety-gates` 400,
  `source-public-approval-rehearsal` 376,
  `source-public-execution-orchestrator` 566,
  `terminal-brief-approval-dispatch-adapter` 419,
  `terminal-brief-approval-executor` 357,
  `terminal-brief-approval-receipt-ingestor` 584,
  `terminal-brief-approval-request` 436,
  `terminal-brief-auto-closeout-dryrun-runner` 616,
  `terminal-brief-finalizer-approval-status` 551,
  `terminal-brief-sidecar-integration-rehearsal` 203,
  `two-broker-safety-matrix` 195.
- **transport (17):** `broker-conversation-relay` 402,
  `broker-conversation-task-bridge` 106, `broker-conversation` 1062,
  `broker-exchange-guards` 45, `broker-exchange-message-read` 54,
  `broker-exchange-normalizers` 39, `broker-exchange-read` 52,
  `broker-exchange-task-decision` 121, `broker-exchange` 169,
  `broker-listener-registry` 65, `conference-room` 341, `conference-types` 84,
  `event-buffer` 56, `request-security` 1590, `task-event-dispatcher` 154,
  `task-event-stream` 464, `task-events` 139.
- **observability (9):** `alert-projection` 417, `broker-compact-diagnostics`
  68, `broker-dashboard` 288, `broker-task-diagnostics` 365, `hot-diagnostics`
  104, `hot-table-growth` 881, `operator-dashboard-snapshot` 300,
  `operator-task-report` 396, `task-stats` 1265.
- **store (27):** 8 × `*-repository` ports (131 LOC in total),
  `broker-cleanup-discovery` 342, `broker-cleanup` 418,
  `broker-retention-policy` 106, `broker-retention-reachability` 293,
  `broker-retention-selectors` 288, `pending-hot-state-buffer` 166,
  `snapshot-extension-registry` 31, `sqlite-worker-thread-persistence` 612,
  `sqlite-worker` 107, `store-contracts` 238, `store-hot-diagnostics-read` 610,
  `store-hot-retention-planning` 280, `store-hot-select-projections` 256,
  `store-runtime-filters` 75, `store-runtime-repositories` 246,
  `store-schemas` 1054, `store-snapshot-fit` 109, `store-snapshot-io` 414,
  `store` 2329.
- **kernel (13):** `broker-contracts` 402, `broker-error` 64, `broker-helpers`
  63, `broker-list-filters` 96, `broker-payload-validators` 252,
  `broker-record-helpers` 43, `broker-status-predicates` 89,
  `broker-task-record-normalizers` 235, `broker-transition-guards` 77,
  `collections` 7, `types` 1550, `value-guards` 97, `value-text` 19.
- **facade (1):** `broker` 3961. **test-support (2):** `broker-test-helpers`
  59, `store-test-helpers` 254.

### Inter-domain import matrix

Rows import from columns. Each cell is all edges / value edges, and the
diagonal (in parentheses) is intra-domain. Abbreviations: disp = dispatch,
exec = execution, compl = completion, evid = evidence-retrieval, policy =
policy-approval, trans = transport, obs = observability, kern = kernel.

| from \ to | disp | claim | exec | compl | evid | policy | trans | obs | store | kern | facade | test |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| disp | (7/4) | 1/0 | . | 1/1 | . | 1/1 | 1/0 | . | 1/0 | 17/11 | 1/1 | . |
| claim | . | (7/7) | . | . | . | . | . | 1/1 | 1/1 | 17/5 | 1/0 | . |
| exec | 2/2 | 1/0 | (1/0) | . | . | . | . | . | . | 22/16 | . | . |
| compl | . | . | 1/1 | (16/8) | . | 3/2 | 1/0 | . | 1/1 | 23/16 | . | . |
| evid | 1/1 | 2/2 | . | 2/2 | (3/1) | . | . | . | 7/2 | 15/10 | . | . |
| policy | 3/2 | 1/1 | 1/0 | 4/2 | . | (33/16) | . | . | 1/0 | 46/41 | . | . |
| trans | . | . | . | 2/2 | . | . | (10/8) | 1/1 | 4/1 | 22/12 | 3/1 | . |
| obs | . | 3/3 | . | 1/1 | . | . | . | (1/0) | 1/0 | 14/10 | 2/0 | . |
| store | 2/0 | . | . | 9/3 | 5/1 | . | 2/0 | 4/0 | (37/22) | 29/10 | 3/1 | . |
| kern | 4/4 | 2/1 | 2/0 | 4/2 | 1/0 | . | . | . | 11/1 | (11/5) | 1/0 | . |
| facade | 6/5 | 11/11 | 3/3 | 7/5 | 9/7 | 4/4 | 11/11 | 3/3 | 16/8 | 9/8 | . | . |
| test | . | . | . | 1/0 | . | . | . | . | 1/0 | 1/0 | 1/1 | . |

What the matrix shows:

- policy-approval is the most self-contained large bucket: 33 internal edges,
  only 4 inbound edges, and 46 edges into the kernel.
- transport has **no inbound value edge** from any domain except the facade.
- store and kernel point *upward* into the business domains. The edges
  store→completion (9) and kernel→store (11, 10 of them type-only) are what
  make the whole graph one component.

### Cycles

| level | edges considered | strongly connected components (size > 1) |
|---|---|---|
| file | all | 3 components, of 31, 4 and 3 modules (all type-only) |
| file | value only | **none** |
| domain | all / value | 1 component containing all 11 non-test domains |
| domain | value, facade and test-support excluded | 1 component: claim, completion, dispatch, evidence-retrieval, execution, kernel, observability, policy-approval, store |
| domain | value, no facade, after the Step-0 sink only | 1 component: claim, completion, dispatch, evidence-retrieval, execution, kernel, observability, policy-approval, store |
| domain | value, no facade, after Step 0 edits 1–4 | {completion, dispatch, execution, kernel, store} (`store-schemas` → `store-contracts` becomes kernel → store) |
| domain | value, no facade, after the full Step 0 (all five edits, below) | **none** |

The 31-module type-only cycle is the `broker.ts` / `store.ts` / `broker-*`
extraction family. The 4-module cycle is `store-contracts`, `store-schemas`,
`terminal-event-outbox` and `review-lineage-observation-store`. The 3-module
cycle is `types`, `delegated-runtime` and `broker-status-predicates`. Outside
`core/`, the hotspot report also shows `sqlite-worker-thread-persistence` in
a 19-module cycle with `server.ts`, because it imports `../server.js`.

**Mutual domain pairs on value edges, excluding the facade.** These are the
concrete edges that must be cut:

| pair | A → B | B → A |
|---|---|---|
| kernel ↔ dispatch | `broker-payload-validators` → `a2a-round-policy`, `broker-task-request-normalizers`; `broker-task-record-normalizers`, `broker-transition-guards` → `broker-task-request-normalizers` | 11 ordinary dispatch → kernel edges |
| kernel ↔ completion | `broker-payload-validators` → `terminal-brief-metadata`; `broker-task-record-normalizers` → `task-error-details` | 16 ordinary edges |
| kernel ↔ claim | `broker-task-record-normalizers` → `broker-wake-normalizers` | ordinary edges |
| kernel ↔ store | `broker-payload-validators` → `store-schemas` | 10 ordinary edges |
| completion ↔ store | `terminal-event-outbox` → `store-schemas` | `store`, `broker-cleanup` → `terminal-event-outbox`; `store-hot-select-projections` → `task-error-details` |
| evidence-retrieval ↔ store | `broker-task-read` → `store-hot-select-projections` (one constant, `HOT_READ_HARD_MAX_LIMIT`); `review-lineage-observation-store` → `store-schemas` | `store` → `review-lineage-observation-store` |
| completion ↔ policy-approval | `terminal-brief-finalizer-handoff`, `terminal-brief-finalizer-workflow` → `terminal-brief-sidecar-integration-rehearsal` | `…-sidecar-integration-rehearsal` → `terminal-brief-final-count-closeout`; `terminal-brief-auto-closeout-dryrun-runner` → `terminal-brief-auto-closeout-planner` |
| dispatch ↔ policy-approval | `live-task-admission` → `runtime-safety-gates` | `complexity-orchestration-dry-run` → `complexity-orchestration-recommendation`, `task-complexity-classifier` |
| claim ↔ observability | `broker-stale-task-requeue` → `broker-task-diagnostics` (`getTaskRequeueReason`) | `broker-compact-diagnostics`, `broker-dashboard`, `broker-task-diagnostics` → `broker-worker-status` |

**Value back-edges into the facade.** All four are re-export shortcuts:

- `live-task-admission` and `request-security` import `BrokerError`, which
  `broker-error.ts` defines.
- `broker-cleanup` imports `DEFAULT_BROKER_RETENTION_POLICY`, which
  `broker-retention-policy.ts` defines.
- `broker-test-helpers` is test support.

Eight more modules type-import re-exported types from `./broker.js`.

### Hotspots

| top in-core fan-in | n | top in-core fan-out | n | top importers from outside `core/` | n |
|---|---:|---|---:|---|---:|
| `types` (kernel) | 88 | `broker` (facade) | 79 | `types` | 55 |
| `value-guards` (kernel) | 43 | `broker-contracts` (kernel) | 15 | `broker` | 50 |
| `broker-helpers` (kernel) | 20 | `store-runtime-repositories` (store) | 14 | `request-security` | 36 |
| `broker-error` (kernel) | 20 | `store` (store) | 14 | `store` | 35 |
| `broker-status-predicates` (kernel) | 18 | `broker-task-terminal` (completion) | 9 | `value-guards` | 10 |
| `terminal-event-outbox` (completion) | 14 | `store-contracts` (store) | 9 | `broker-error` | 8 |
| `broker` (facade) | 12 | `broker-payload-validators` (kernel) | 7 | `broker-status-predicates` | 5 |
| `store` (store) | 12 | `broker-task-approval` (policy) | 7 | `terminal-event-outbox` | 4 |

`terminal-event-outbox` is the only non-kernel module with high fan-in. Its 14
importers come from completion, store, transport, observability and
test-support, which makes it the anchor of the completion domain.

### Ambiguous modules

The neighbour-majority check flags 27 modules. The ones that matter for the
split are listed here with a proposed disposition.

| module | assigned | neighbours | proposed |
|---|---|---|---|
| `terminal-brief-sidecar-integration-rehearsal` | policy-approval (name) | completion ×4 | **completion**. The budget comment says it is reached from the live finalizer workflow. |
| `runtime-safety-gates` | policy-approval | dispatch ×1 (its only importer is `live-task-admission`) | **dispatch** (admission gate) |
| `broker-payload-validators` | kernel | dispatch/policy importers only | **dispatch** (create-time validators) |
| `broker-worker-status` | claim | observability ×3, claim ×2 | **kernel** (pure status derivation) |
| `broker-task-request-normalizers` | dispatch | imported by 3 kernel modules | **kernel** |
| `complexity-orchestration-recommendation` / `-dry-run` | dispatch / policy-approval | each other | split it: runtime-reached links stay, CLI-only links retire. See [Owner decisions](#owner-decisions-2026-10-29) #4. |
| `review-lineage-observation-store` (and siblings) | evidence-retrieval | store | **store** (owner decision #3; the `src/review-lifecycle/` option is withdrawn). |

The other 20 flags are single-vote cases with no structural effect:
`a2a-execution-policy`, `a2a-intent-router`, `a2a-round-policy`,
`broker-compact-diagnostics`, `broker-dashboard`, `broker-task-cancellation`,
`broker-task-diagnostics`, `broker-task-read`,
`broker-terminal-receipt-parity`, `broker-wake-normalizers`,
`broker-worker-read`, `live-task-admission`, `operator-task-report`,
`release-evidence`, `request-security`, `round-status`, `task-retry-policy`,
`terminal-brief-auto-closeout-dryrun-runner`, `terminal-outbox-backlog-risk`,
`wave-evidence`, `worker-self-assessment-capacity`.

### Modules with no importer under `packages/broker/src`

21 modules have no non-test importer. Most are reached only from operator CLI
wrappers in `packages/broker/scripts/*.mjs` through `dist/core/…`. A few have
no importer at all:

- `sqlite-worker` is loaded through a runtime path join in
  `sqlite-worker-thread-persistence.ts`.
- `two-broker-safety-matrix` and `terminal-brief-value-guards` are imported by
  tests only.

Full list: `a2a-dialectic-lite-finalizer`, `a2a-dispatch-helper`,
`a2a-execution-policy`, `adaptive-work-mode-selector`,
`broker-rehearsal-manifest`, `broker-terminal-receipt-parity`,
`broker-test-helpers`, `complexity-orchestration-dry-run`,
`cross-broker-terminal-brief-receiver`, `operator-approval-request`,
`orchestration-intelligence-worker-subagent-spawn-bridge`,
`round-result-collector`, `source-public-approval-rehearsal`,
`source-public-execution-orchestrator`, `sqlite-worker`, `store-test-helpers`,
`team1-dispatch-wrapper`, `terminal-brief-auto-closeout-dryrun-runner`,
`terminal-brief-value-guards`, `terminal-receipt-gap-matrix`,
`two-broker-safety-matrix`.

Eight of them are in policy-approval. These are the cheapest candidates for the
#1601 "approval steps as policy data" retirement, which also frees
`brokerCoreModules` budget.

## Target layering and allow-matrix

The layers run from the bottom up. A module may import its own domain and the
layers listed for it.

| importer | may import |
|---|---|
| kernel (stays at the `core/` root) | nothing outside the kernel |
| dispatch | kernel, claim (type) |
| claim | kernel |
| execution | kernel, dispatch, claim |
| completion | kernel, dispatch, claim, execution |
| evidence-retrieval, policy-approval | kernel and the four loop domains |
| observability | the above plus evidence-retrieval |
| store (adapter: `store.ts`, sqlite, snapshot, retention) | everything except transport and the facade |
| transport | everything except the facade |
| facade (`broker.ts`, stays at root) | everything |
| *anything* → facade | **forbidden** (test-support excepted) |

In import terms, the lifecycle runs *backwards*. Completion imports execution
(`task-retry-policy`), and execution imports dispatch (`a2a-intent-router`).
The matrix follows the measured direction instead of the narrative order.

The store sits above the domains because `store.ts` and `store-contracts.ts`
aggregate every domain's record shapes for snapshots. Domains reach
persistence only through ports: the `*-repository` interfaces and
`store-schemas`, which sink to the kernel.

**Violations against this matrix:**

| state | violations (all / value) |
|---|---:|
| today | 57 / 20 |
| after the Step-0 sink only (15 modules counted as kernel) | 33 / 10 |
| after Step 0 edits 1–4 (sink, reclassify, re-point) | 25 / 2 |
| after the full Step 0 (plus the `CURRENT_BROKER_STATE_VERSION` sink) | **24 / 1** |

These rows apply the sink and reclassification to **all** edges, including
edges that were intra-domain before (the first revision applied them only to
already-cross-domain edges and reported 32 / 9 and 24 / 1 without the fifth
edit). The full Step 0 is: the sink, plus 6 reclassifications, plus 4
re-pointed imports, plus one constant move. The 6 reclassifications are:

- `broker-payload-validators` and `runtime-safety-gates` → dispatch
- `…-sidecar-integration-rehearsal` → completion
- the three `review-lineage-*` modules → store

The 4 re-pointed imports are the three facade value back-edges plus
`HOT_READ_HARD_MAX_LIMIT` (a symbol move into a kernel module, not only a
specifier change). The facade re-points are behavior-preserving: `broker.ts`
re-exports `BrokerError` and `DEFAULT_BROKER_RETENTION_POLICY` from their
defining modules (same binding) and has no top-level side effects. Of the four
facade back-edges, the `broker-test-helpers` one is type-erased by `tsc`, so
three remain at runtime.

The fifth edit moves `CURRENT_BROKER_STATE_VERSION` from `store-contracts` into
`store-schemas` (kernel) and re-exports it from `store-contracts`, so existing
importers are unchanged.

The 15 sunk modules are `broker-task-request-normalizers`,
`task-error-details`, `broker-wake-normalizers`, `store-schemas`,
`broker-retention-selectors`, `terminal-brief-metadata`,
`broker-worker-status`, and the 8 `*-repository` ports.

The remaining value violation is `broker-stale-task-requeue` →
`broker-task-diagnostics` (`getTaskRequeueReason`): move the function to claim,
or sink it. The 23 type-only violations break down as:

- 8 `import type … from "./broker.js"` re-export shortcuts
- 6 domain types aggregated by `broker-contracts`
- 2 conversation types in `store-contracts`
- 1 each: `types` → `delegated-runtime`, `broker-record-helpers` → `store`,
  `hot-table-growth` → `store`, `broker-terminal-receipt-parity` →
  `receipt-gate-canary`, `terminal-event-outbox` → `task-events`, and two in
  `live-task-admission`

All of them can be fixed mechanically: re-point the import to the module that
defines the type, or declare a narrow port interface in the importing domain.

## Proposed split order

Ordering criteria:

1. Inbound value coupling after Step 0 (lowest first).
2. No remaining cycle through the domain.
3. Smallest import-site churn.
4. Value to #1601: LOC removed from the flat directory, and spin-off alignment.

Import-site counts are approximate: a basename grep over `packages/` and
`scripts/`, excluding the domain's own files. Name collisions such as `types`
or `policy` inflate them.

| step | scope | prerequisites (edge fixes) | rule turned on | guard | size |
|---|---|---|---|---|---|
| **PR-0** | Enforcement scaffold plus Step 0, no moves (after the #2454 package move lands — both edit the same `test-manifest.json` line) | The five Step 0 edits. Make the test-manifest glob recursive and add a test-count comparison (no such tool exists yet). Teach `check-dist-import-resolution` (or the new checker) about computed specifiers and the `src/core/*.mjs` source imports listed in Risks 4. | Replace the line-based scan in `check-broker-core-dependency-isolation.mjs` with a parser that sees multi-line and `export … from` imports; domain = committed filename-to-domain map with a completeness check (every core module declared); allow-matrix; value edges strict; type edges ratcheted against a JSON baseline | Checker unit test (synthetic fixtures, incl. multi-line imports); broker build; test-count comparison; TCK (#2476) | M (the scanner replacement makes the earlier "S" estimate too small) |
| **1** | `core/execution/` (9 modules + 5 tests, 2.3k LOC) | none after PR-0 and the CLI-only retirement | execution may import kernel, dispatch, claim; only completion and above may import execution | build, broker test manifest (count unchanged), `tck-promoted-gate`, `check-dist-import-resolution`, script budget flat | S (about 23 import sites; 5 dist and 4 src references outside core). It is the pilot that proves the recipe. |
| **2a/2b** | `core/policy/` (35 modules after 2 reclassifications, plus their tests; about 14.7k LOC): 2a the orchestration-intelligence and complexity chains; 2b Terminal Brief approval, source-public, proposals, `policy` | Reclassify `runtime-safety-gates` → dispatch and `…-sidecar-integration-rehearsal` → completion (they stay at the root until those steps). Keep A7 on hold or land it first, but not concurrently. | policy may import kernel and the loop domains; the loop domains may not import policy | the same guards; ceremony count must stay 20 | M + M (about 61 import sites, 44 of them `packages/broker/scripts` CLI wrappers) |
| **3** | `core/claim/` (11 modules after the sink + 5 tests) | Move `getTaskRequeueReason` to claim; sink `broker-worker-status` and `broker-wake-normalizers` (they stay at the root) | claim may import only the kernel | same | S (about 22 sites) |
| **4** | `core/evidence/` (8 modules after the `review-lineage-*` decision) | Decide `review-lineage-*` placement; sink `HOT_READ_HARD_MAX_LIMIT` | evidence may import kernel and the loop domains | same | S–M (about 28 sites) |
| **5** | `core/dispatch/` (16 after the sink + 2 reclassified) | `broker-task-request-normalizers` stays at the root (kernel) | dispatch may import kernel and claim (type) | same | M (about 40 sites) |
| **6** | `core/completion/` (23 after the sink + 1 reclassified) | `terminal-brief-metadata` and `task-error-details` stay at the root. `store.ts` → `terminal-event-outbox` is allowed (store is above). | completion may import kernel, dispatch, claim, execution | same; the promoted "task not found / invalid task" and "streaming / subscribe ordering" TCK jobs are the closest protocol oracle | L (about 84 sites; `terminal-event-outbox` has 14 importers) |
| **7** | `core/observability/`, `core/transport/`, `core/store/` | `request-security` (36 outside importers) and `store` (35) dominate the churn; `sqlite-worker` must move together with `sqlite-worker-thread-persistence` (runtime path join); `requester-role-contract.mjs` moves with `request-security` | the root flips from *legacy* to *kernel*: root modules other than `broker.ts` may not import any domain directory | same | M, M, L |
| — | kernel and `broker.ts` | — | stay at the `core/` root; types.ts has 143 importers, so moving it buys nothing | — | — |

Every move PR should be a pure `git mv` plus import-specifier rewrites, with
no symbol change. `git diff -M --stat` should show renames at or near 100%
similarity, and the broker test count should be identical before and after.

## Enforcement design (for PR-0; not implemented here)

- **Where.** Rework `scripts/check-broker-core-dependency-isolation.mjs` and
  `scripts/check-broker-core-dependency-isolation.test.mjs`. Both are already
  in the release gate, and `check:broker-core-dependency-isolation` already
  exists. This adds no `scripts/*.mjs` (160/160) and no npm script (45/45).
  The current scanner reads imports line by line, so it misses multi-line
  imports (83 core modules use them) and `import()`; it must be replaced, not
  extended. A small JSON baseline for type-only violations and the domain map,
  under `docs/ops/`, are data and do not count against any budget.
- **Domain derivation (owner decision: map first, move later).** A committed
  filename-to-domain JSON map assigns every core module to a domain, and the
  check fails when a module is missing from the map, so a new file must
  declare its domain and the map cannot drift silently. This protects the
  Step 0 result immediately, with no file move. Physical `core/<domain>/`
  directories come later, one domain per move PR; when a domain directory
  exists, its path is authoritative and the map entry is removed.
- **Rules.**
  1. A carved domain imports only its own directory, the root, and the
     allowed domains.
  2. No module imports `broker.ts` except test-support.
  3. Value violations fail the check.
  4. Type-only violations may not exceed the baseline, and the baseline only
     goes down.
- **Optional.** Add a `--domains` view to `core-hotspot-report.mjs`. It lives
  under `packages/broker/scripts`, which is outside the `scriptsMjs` budget, so
  the matrix above becomes a standing report.

## Risks

0. **The TCK gate skipped `core/` changes — resolved.** #2476 (`508b4f18`)
   widened the `tck-promoted-gate.yml` `changes` filter to
   `packages/broker/src/**` and added a test that every module the TCK surface
   imports stays covered. A core-only change was shown to run all promoted
   jobs (run 40870395308).
1. **Silent test loss.** `packages/broker/scripts/test-manifest.json` runs
   `dist/core/*.test.js` through `/bin/sh`, which is not recursive, and a glob
   with no match still exits 0 (`tests 0`). Moved tests would stop running
   while CI stays green. Other places pin the flat layout too: the
   `ratchet-harness` list, 4 broker npm scripts with `dist/core` test paths,
   and 4 core tests that resolve `../../fixtures` from `__dirname`. PR-0 must
   make the glob recursive and add a before/after test-count comparison (no
   such tool exists today).
2. **Ceremony budget by path.** `isCeremonyModule()` matches the *relative
   path*. A directory named `policy-approval/`, `approval/` or `rehearsal/`
   would mark every module inside it as ceremony and fail the 21 budget. Use
   `policy/`. `evidence/` is safe (the marker is `evidence-collector`).
3. **Core-module budget.** The module count is recursive, so `git mv` is
   neutral. A barrel `index.ts` per domain would add one module each and fail
   181/181. Either skip barrels or offset them by retiring CLI-only modules.
4. **Compiled-path consumers.** 62 `packages/broker/scripts/*.mjs` files
   mention `dist/core/` paths: 58 import literal `dist/core/<file>.js`
   specifiers, 2 build the path at runtime, and 2 are coverage data. (The
   first revision also claimed `scripts/lib/*` files import `dist/core`; that
   was wrong.) The precedent: a subdirectory move once left 17 scripts dead.
   `scripts/check-dist-import-resolution.mjs` checks literal specifiers only,
   so these break silently:
   - computed specifiers: `export-sqlite-state.mjs` (template literal to
     `store.js`; a DB recovery tool), `operator-approval-request.mjs`
     (`join()`), and 3 `test/conformance/*` files (`path.join` to `dist/core`);
   - source imports of `src/core/requester-role-contract.mjs` from
     `scripts/a2a-dispatch-round.mjs` and `scripts/lib/task-assign-entrypoint.mjs`.
   Path strings stored as data also need updates: `shared-state-*-v1-values`
   `sourceRefs`, the secret-scan allowlist, and two coverage floors.
5. **Runtime path joins.** `sqlite-worker.js` is resolved relative to
   `sqlite-worker-thread-persistence`, so both must move together.
   `request-security.ts` imports `./requester-role-contract.mjs`.
6. **A7 hold.** The `orchestration-intelligence-*-approval-decision-evidence`
   modules are A7's target. A rename in step 2a while A7 is reopened would
   conflict. Sequence them; do not run them in parallel.
7. **Upward edges outside `core/`.** The 52 `core -> outside` edges remain,
   including `sqlite-worker-thread-persistence` → `../server.js` and
   `broker-contracts` → `task-attempt` / `wave-plan-dag-v2`. They are out of
   scope for the domain matrix but block any later package extraction.
8. **Heuristic error.** The classification is filename-led and override-heavy
   (53 overrides). The numbers are stable per rule set, but a reviewer may
   move individual modules. Each such move shifts the per-domain LOC, not the
   file-level graph or the cycle findings. The domain regex `dry-?run` also
   differs from the budget's `dry-run` marker.
9. **Survey-script limits.** The appendix script does not treat
   `export * from` as an edge and classifies an un-awaited `import()` as
   type-only. Neither pattern occurs in `core/` today, so the numbers stand,
   but PR-0's checker must handle both.

## Owner decisions (2026-10-29)

The owner accepted the review recommendations ("1", 2026-10-29). These replace
the earlier "Needs confirmation" list.

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Physical directories or a data map | **Hybrid: committed filename-to-domain map with a completeness check in PR-0; physical moves later, one domain per PR** | Protects Step 0 at once with no churn across 60+ path consumers; avoids leaving the root unchecked for ~6 PRs; the completeness check prevents map drift |
| 2 | Pilot: execution or policy-approval | **execution** | Few outside references (5 dist, 4 src); policy-approval is entangled with the A7 hold, ceremony naming, 44 CLI wrappers, and the retirement in #6 |
| 3 | `review-lineage-*` placement | **store** | Matches the #2454 decision record (persistence adapters stay in the broker); `review-lineage-observation-store` value-imports `store-schemas`, so putting it in the review-lifecycle package would make that package depend on the broker. The `src/review-lifecycle/` option is withdrawn. |
| 4 | Complexity chain | **Split it.** classifier, recommendation, envelope-draft and plan-draft are reached at runtime through `http/complexity-orchestration-routes.ts` (`/complexity-orchestration/recommendation`, `/complexity-execution-plan/draft`) and stay in dispatch/policy. dry-run, preflight-seal and operator-approval-request are CLI-only and become retirement candidates. | Route retirement, if ever, only after call-count instrumentation shows zero use (#1665 style) |
| 5 | Type-only edges strict or ratcheted | **Ratchet now (baseline only goes down); strict per domain when a domain is extracted** | 8 of the 23 are `broker.js` re-export shortcuts (easy); 6 are `broker-contracts` aggregation (structural); strict now would bloat PR-0 |
| 6 | Retire CLI-only policy modules before moving | **Yes, before the moves.** The 8: `broker-rehearsal-manifest`, `complexity-orchestration-dry-run`, `operator-approval-request`, `orchestration-intelligence-worker-subagent-spawn-bridge`, `source-public-approval-rehearsal`, `source-public-execution-orchestrator`, `terminal-brief-auto-closeout-dryrun-runner`, `two-broker-safety-matrix` | No functional change since August and no workflow reference. The source-public gate uses its own `scripts/lib/source-public-gate-kit`. `operator-approval-request` needs its npm script and 8 docs cleaned up in the same PR. **Amended 2026-10-30:** `two-broker-safety-matrix` and `orchestration-intelligence-worker-subagent-spawn-bridge` are kept permanently as an operator gate and a reuse oracle. See [Step 4](#step-4-cli-only-retirement). |
| 7 | TCK filter | **Done in #2476** | — |

**Sequence:** (1) this correction; (2) the #2454 `packages/review-lifecycle`
move (child issue); (3) PR-0; (4) CLI-only retirement; (5) execution pilot.
(2) and (3) edit the same `test-manifest.json` line, so they merge in that
order, not in parallel. Each implementation PR is approved separately; this
record authorizes none of them.

## PR-0 implemented

PR-0 (#2453) landed the enforcement scaffold and the full Step 0, with no file
move:

- **Map and allow-matrix:** `docs/ops/broker-core-domain-map.json` assigns all
  181 core modules (post-Step 0: kernel 27, policy-approval 35, completion 24,
  store 20, dispatch 18, transport 17, claim 11, execution 9, observability 9,
  evidence-retrieval 8, test-support 2, facade 1) and holds the matrix above
  (`mayImport`, plus `mayImportTypeOnly` for dispatch → claim).
- **Checker:** `npm run check:broker-core-dependency-isolation` (release-gate
  step `broker-core-dependency-isolation`; unit test
  `scripts/check-broker-core-dependency-isolation.test.mjs`). It parses imports
  with the TypeScript compiler API and fails on a module missing from the map, a
  map entry with no module, any value edge the matrix forbids, or a type-only
  violation not in `docs/ops/broker-core-type-edge-baseline.json`.
- **Step 0 result:** 0 value violations (the remaining `getTaskRequeueReason`
  edge was fixed by moving the function into `broker-stale-task-requeue`, with
  a re-export from `broker-task-diagnostics`) and 23 type-only violations, all
  baselined.
- **Silent test loss:** the manifest runs `'dist/core/**/*.test.js'` (quoted, so
  node expands it recursively). `run-test-manifest.mjs` fails when a test step
  matches 0 files, or when a compiled test with a source file is matched by no
  step.
- **Computed paths:** `scripts/check-dist-import-resolution.mjs` inventories the
  Risks 4 consumers (`CORE_PATH_CONSUMERS`). It fails on a new unlisted
  consumer, a stale entry, or a reference that no longer resolves.

**Updating the map and the baseline:**

1. A new core module: add `"<file>.ts": "<domain>"` to `modules`. Once a
   `core/<domain>/` directory exists, a file inside it takes its domain from
   the directory and must not have a map entry.
2. A value violation: re-point the import to the defining module, move the
   symbol down a layer (re-exporting from its old home), or change the module's
   domain. Do not widen `mayImport` without review.
3. A type-only violation: never add it to the baseline by hand. Re-point the
   import or declare a narrow port. When a baselined entry is fixed, the check
   reports it; run
   `node scripts/check-broker-core-dependency-isolation.mjs --lower-baseline`.
   That command refuses to write if it would add an entry.

## Step 4: CLI-only retirement

Owner decision #6 named eight CLI-only modules. Six are retired (#2481). The
pre-delete audit found that the other two have a reference path the import
graph does not see: a doc or spec that tells operators to run the module, or
that relies on it (Family Wiki A2 runbook). The owner decided on 2026-10-30 to
keep both permanently.

**Retired (6):** `broker-rehearsal-manifest`, `complexity-orchestration-dry-run`,
`operator-approval-request`, `source-public-approval-rehearsal`,
`source-public-execution-orchestrator`, `terminal-brief-auto-closeout-dryrun-runner`.
Each one goes together with its test, its `packages/broker/scripts/` wrapper and
dispatcher entry, its tool doc and its fixtures. Also removed:
`complexity-orchestration-recommendation.mjs`, which despite its name only
wrapped the dry-run (the runtime `complexity-orchestration-recommendation.ts`
behind `/complexity-orchestration/recommendation` stays, per decision #4), plus
`generate-operator-approval-request-fixtures.ts` and the
`test:operator-approval-request` npm script.

- Dispatchers: `terminal_brief` goes 22 → 18 tools and `orchestration` 21 → 19.
- Budgets: broker npm scripts 57 → 56, core modules 181 → 175, ceremony
  modules 21 → 16.
- Domain map: 175 modules, with `policy-approval` 35 → 29. Value violations
  stay at 0 and type-only at 23 (the baseline is unchanged).
- Callers: none in `.github/`. A GitHub code search across the `jinwon-int`
  org found no reference to these tool or file names outside a2a-nexus.
- The `scripts/a2a-source-public-*` release-gate family and its schemas and
  fixtures are separate code that only shares the name. They are untouched.
- `docs/specs/delegated-approval-matrix.md` now cites the retired
  `operator-approval-request.md` through a permalink at `d90a5ede`.

**Kept permanently (2), owner decision 2026-10-30:** these are exceptions
to "CLI-only means retire". They are an operator gate and a reuse oracle, not
dead code. Do not propose them for retirement again unless the dependent gate
or spec changes first: move the cutover GO/NO-GO check to another gate, or
amend the piri reuse oracle. For the domain moves they stay in
`policy-approval`, and they count against the core and ceremony budgets like
any other module.

| module | why kept |
|---|---|
| `two-broker-safety-matrix` | `packages/broker/docs/a2a-2broker-safety-regression-readiness-matrix.md` names `node --test dist/core/two-broker-safety-matrix.test.js` as the no-live cutover GO/NO-GO gate. The module was deleted and then restored in the 2026-08-09 T2 cleanup round for exactly this reason. |
| `orchestration-intelligence-worker-subagent-spawn-bridge` | `docs/specs/piri-lane-fanout-reuse/phase-1-mapping.md` §5 lists its test as a "must keep passing unchanged" reuse oracle. Its wrapper path is also hard-coded in the worker source-bundle lists (`hermes-a2a-analysis-bridge.mjs`, `piri-a2a-analysis-bridge.mjs`, `lib/analysis-source-bundle.mjs`), so retiring it changes worker artifacts. |

## Step 5: execution pilot

The first physical domain move. It proves the recipe for the later moves.

**Moved:** 9 modules and 6 tests, from `packages/broker/src/core/` to
`packages/broker/src/core/execution/`. The split-order table counted 5 tests;
it missed `delegated-runtime-regression.test.ts`. File contents are unchanged
except for relative import specifiers.

- Modules: `a2a-execution-policy`, `broker-knowledge-injection`,
  `broker-task-cancellation`, `broker-task-checkpoint`, `delegated-runtime`,
  `task-retry-policy`, `worker-subagent-context-brief`,
  `worker-subagent-planner-handoff`, `worker-subagent-spawn-authorization-request`.
- Tests: `a2a-execution-policy`, `delegated-runtime`,
  `delegated-runtime-regression`, and the three `worker-subagent-*` tests.

**Recipe** (repeat it for each later domain):

1. `git mv` the domain's files into `core/<domain>/`.
2. Rewrite every relative `.js` specifier mechanically: resolve each one to its
   real target, then recompute it from the file's new location. Here that was
   47 specifiers in 23 files.
3. Rewrite the `../dist/core/<module>.js` paths in
   `packages/broker/scripts/*.mjs` (here, 5 wrappers).
4. Update fixture data that names source paths and that a test opens (here, 2).
5. Remove the moved modules from `docs/ops/broker-core-domain-map.json`. The
   `core/<domain>/` directory is now authoritative, and a duplicate map entry
   fails the gate. Re-key the moved modules' entries in the type baseline
   (here, 2).
6. Run `clean:dist` before building. `build` does not clean `dist/`, so a
   checkout built before the move keeps stale `dist/core/<module>.js` files,
   and those would run old code without any error.
7. Compare the worker artifact closure before and after with
   `worker-artifact-pack.mjs --out <tmp>`.

**Results:** 175 core modules (`execution` 9, now assigned by directory), 166
map entries. Value violations stay at 0 and type-only at 23 = baseline. The
recursive test glob from PR-0 (`'dist/core/**/*.test.js'`) picks the moved
tests up, so the broker test count is unchanged.

**Worker artifact impact:** the worker closure includes
`dist/core/worker-subagent-context-brief.js`, which is now under
`dist/core/execution/`. Five payload scripts import execution modules by dist
path. The source change merges normally, but rolling it out to workers is a
separate deploy step with its own approval. Pack the artifact and run the
`--deployed` guard first.

## Claim move

Split-order row 3, done with the Step 5 recipe. Its prerequisites were already
met: PR-0 moved `getTaskRequeueReason` into `broker-stale-task-requeue`, and
`broker-worker-status` and `broker-wake-normalizers` stay at the root as
kernel.

**Moved:** 11 modules and 5 tests to `packages/broker/src/core/claim/`.

- Modules: `broker-capability-normalizers`, `broker-capability-profiles`,
  `broker-stale-task-requeue`, `broker-worker-capacity`,
  `broker-worker-identity`, `broker-worker-runtime`,
  `heartbeat-persist-throttle`, `resource-aware-worker-policy`,
  `worker-capability-card`, `worker-identity-churn-tracker`,
  `worker-self-assessment-capacity`.
- Tests: `broker-worker-capacity`, `broker-worker-identity-equality`,
  `resource-aware-worker-policy`, `worker-capability-card`,
  `worker-self-assessment-capacity`.

**Changes:**

- 46 specifiers rewritten.
- 1 wrapper (`worker-self-assessment-capacity.mjs`) moves to
  `../dist/core/claim/`.
- 11 map entries removed; 1 type-baseline entry re-keyed.
- 9 path strings in docs and comments updated. This time the sweep looked for
  path strings, not only imports, before any test ran. That includes the
  stale `broker-stale-task-requeue.ts:196` citation in
  `delegated-approval-matrix.md`, which is now `:236`.

**Results:** 175 core modules (`claim` 11, `execution` 9, both assigned by
directory), 155 map entries. Value violations stay at 0 and type-only at 23 =
baseline.

**Worker artifact:** no claim module is in the worker dist closure. The only
artifact change is the import path inside the payload script
`worker-self-assessment-capacity.mjs`.

**Rollout decision (owner, 2026-10-30):** the worker artifact changes from
#2477, Step 5 and this move ship with the next regular worker deploy. There is
no separate rollout now. Pack the artifact, run the `--deployed` guard, and run
`clean:dist` as part of that deploy.

## Evidence move

Split-order row 4, done with the Step 5 recipe. Its prerequisites were already
met: owner decision #3 keeps the three `review-lineage-*` modules in `store`,
and PR-0 sank `HOT_READ_HARD_MAX_LIMIT`.

**Directory name:** `core/evidence-retrieval/`, not the `core/evidence/` that
the split-order table wrote. The checker assigns a domain from a directory only
when the directory name equals the domain key, and this key is
`evidence-retrieval`. Matching the key avoids renaming it across the
allow-matrix.

**Moved:** 8 modules and 6 tests.

- Modules: `broker-evidence-read`, `broker-task-read`, `broker-worker-read`,
  `proof-matrix`, `release-evidence`, `task-lineage-index`,
  `task-lineage-read`, `wave-evidence`.
- Tests: `broker-task-read`, `proof-matrix`, `release-evidence`,
  `task-lineage-index`, `task-lineage-read`, `wave-evidence`.

**Changes:**

- 55 specifiers rewritten.
- 18 dist and source path strings updated in scripts, docs and tests.
- 8 map entries removed; no type-baseline entry involved.

**Coverage floor:** `release-evidence` carries the enforced 97% core line
floor. The floor value is unchanged; only its key path changes, in three
places:

- `packages/broker/scripts/coverage-baseline-report.mjs`
- `scripts/check-promotion-capstone-conformance.mjs`, including its
  regex-escaped doc marker `dist\/core\/…`
- the `CORE_PATH_CONSUMERS` inventory

The synthetic coverage table in `coverage-baseline-report.test.mjs` now nests
`release-evidence.js` under `evidence-retrieval`. The real measurement parses
the nested path and passes: 98.67% against the 97% floor.

**Recipe additions:**

- Step 2 also has to search for regex-escaped paths (`core\/<module>\.js`).
  The first capstone run failed on one, because a plain string search does not
  match the escaped form.
- Step 2 also has to search for file-relative paths built at runtime
  (`new URL("../..", import.meta.url)`, `__dirname`, `import.meta.dirname`).
  `task-lineage-read.test.ts` loaded `../../fixtures/…` relative to itself and
  needed one more `../` after the move; this is Risk 4. The import rewriter
  does not see these paths because they are not `.js` specifiers.

**Results:** 175 core modules (`evidence-retrieval` 8, `claim` 11 and
`execution` 9, all assigned by directory), 147 map entries. Value violations
stay at 0 and type-only at 23 = baseline. No evidence module is in the worker
dist closure.

## Dispatch move

Split-order row 5, done with the Step 5 recipe and its two later additions.
`broker-task-request-normalizers` stays at the root as kernel.

**Moved:** 18 modules (16 after the sink, plus `runtime-safety-gates` and
`broker-payload-validators`, which were reclassified) and 17 tests to
`packages/broker/src/core/dispatch/`. The tests include
`round-manifest-resource-policy` and `wave-plan-recovery`, whose names differ
from the modules they test.

**Changes:**

- 70 specifiers rewritten.
- 25 path strings updated in docs, wrappers, bridge tests and two broker npm
  scripts (`test:work_mode_pre_dispatch_decision`,
  `test:adaptive_work_mode_selector`).
- 3 tests that build file-relative paths get one more `../`: 2 use
  `join(__dirname, "../../fixtures/…")` and `a2a-dispatch-helper.test.ts` uses
  `resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/…")`.
  **Recipe correction:** sweep for every `import.meta.url`, `__dirname` and
  `__filename` use in the moved files, not only for `new URL("../`. The
  `fileURLToPath(import.meta.url)` form slipped past the narrower pattern and
  failed 4 tests on the first run.
- 18 map entries removed; 2 type-baseline entries re-keyed.
- The three dispatch files that call `new URL()` parse URLs only and are
  unaffected.

**Results:** 175 core modules (`dispatch` 18, `evidence-retrieval` 8, `claim`
11, `execution` 9, all assigned by directory), 129 map entries. Value
violations stay at 0 and type-only at 23 = baseline.

**Worker artifact — larger than the earlier moves:**
`dist/core/runtime-safety-gates.js` is in the worker dist closure, and the
worker handler entry `scripts/a2a-task-handler.mjs` imports it directly. The
handler and its dist file must therefore ship together, in the same
pack-built artifact. Per the 2026-10-30 owner decision this goes out with the
next regular worker deploy, together with pack, the `--deployed` guard and
`clean:dist`. Copying only the handler, without the new dist, breaks it with
`ERR_MODULE_NOT_FOUND`.

## Completion move

Split-order row 6, done with the corrected recipe. `terminal-brief-metadata`
and `task-error-details` stay at the root as kernel. `store.ts` →
`terminal-event-outbox` is allowed, because `store` sits above `completion`.

**Moved:** 24 modules and 20 name-matched tests to
`packages/broker/src/core/completion/`. 23 of the modules come after the
sink; the 24th is the one reclassified module. Integration tests that combine
completion modules with `broker`, `store` and other modules stay at the root;
examples are `cross-broker-relay-fallback`, `task-events` and
`parent-round-*`. The domain checker does not assign test files to a domain.

**Changes:**

- 104 specifiers rewritten.
- 51 path strings updated. They include the shared-state registries inside
  src (`shared-state-idempotency-v1-values.ts`,
  `shared-state-outbox-v1-values.ts`) and their golden fixture, 16 wrappers,
  the runtime-reliability lane, and docs.
- 24 map entries removed; 4 type-baseline entries re-keyed.

**Left unchanged on purpose:** `fixtures/contract/bounded-pr-review-lifecycle.json`
cites `packages/broker/src/core/broker-task-terminal.ts` (and `:106`) as
example `declaredPaths` and `evidenceRefs`. That fixture is hashed by the
canonical-JSON golden vectors in
`test/conformance/check-bounded-pr-review-lifecycle.mjs`, so its strings are
contract data, not live references. #2477 made the same call for its intent
contract strings.

**Results:** 175 core modules. Completion has 24, dispatch 18,
evidence-retrieval 8, claim 11 and execution 9, all assigned by directory;
105 map entries remain. Value violations stay at 0 and type-only at 23 =
baseline.

**Worker artifact:** `dist/core/github-task-completion.js` is in the worker
dist closure and moves to `dist/core/completion/`. Like the dispatch move,
this ships in one pack-built artifact with the next regular worker deploy.

## Observability move

The first of row 7's three domains. Row 7 is split into four PRs:
observability, transport, store, and finally the root flip from *legacy* to
*kernel*, which is a gate rule change.

**Moved:** 9 modules (`alert-projection`, `broker-compact-diagnostics`,
`broker-dashboard`, `broker-task-diagnostics`, `hot-diagnostics`,
`hot-table-growth`, `operator-dashboard-snapshot`, `operator-task-report`,
`task-stats`) and 5 tests to `packages/broker/src/core/observability/`.

**Changes:**

- 54 specifiers rewritten.
- 15 path strings updated in docs and the piri A/B fixture.
- 9 map entries removed; 3 type-baseline entries re-keyed.

**Left unchanged on purpose:** `docs/ops/round-quality-scorecard.json`
quotes `core/task-stats` inside historical round evidence text.

**Results:** 175 core modules (observability 9), 96 map entries. Value
violations stay at 0 and type-only at 23 = baseline. No observability module
is in the worker dist closure.

## Appendix: survey script

Throwaway. Do not add it under `scripts/` because of the budget. Copy it to a
scratch directory outside the checkout and run
`node survey.mjs <checkout> > out.json`. At `30832157` it prints `base`
`{"files":181,"loc":67936,"edges":521,"typeOnly":208}`.

**Correction (2026-10-29):** the script's "full Step 0" row applies the
reclassifications and re-points only to `crossEdges`. That misses edges that
were intra-domain before the sink (for example `store-schemas` →
`store-contracts`, store-internal before, kernel → store after). Sink and
reclassify must be applied to **all** edges; doing so gives the corrected
numbers in the violations table (33 / 10, 25 / 2, and 24 / 1 with the fifth
edit).

<details>
<summary>survey.mjs</summary>

```js
#!/usr/bin/env node
// a2a-nexus#2453 core/ domain survey (throwaway; not committed under scripts/).
// Usage: node survey.mjs <repo-root>   -> JSON on stdout
// Deterministic: filename RULES (first match wins) after explicit OVERRIDES;
// regex import scan (static import/export-from, bare import, inline import("x")).
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');
const CORE = path.join(root, 'packages/broker/src/core');
const SRC = path.join(root, 'packages/broker/src');

const OVERRIDES = {
  'broker.ts': 'facade', 'types.ts': 'kernel', 'broker-contracts.ts': 'kernel', 'store-contracts.ts': 'store',
  'broker-proposal-write.ts': 'policy-approval', 'broker-proposal-read.ts': 'policy-approval',
  'complexity-execution-plan-draft.ts': 'policy-approval', 'policy.ts': 'policy-approval',
  'two-broker-safety-matrix.ts': 'policy-approval', 'runtime-safety-gates.ts': 'policy-approval',
  'broker-task-approval.ts': 'policy-approval', 'source-public-execution-orchestrator.ts': 'policy-approval',
  'broker-test-helpers.ts': 'test-support', 'store-test-helpers.ts': 'test-support',
  'request-security.ts': 'transport', 'event-buffer.ts': 'transport', 'conference-room.ts': 'transport',
  'conference-types.ts': 'transport', 'broker-listener-registry.ts': 'transport',
  'finalizer-verdict-admission.ts': 'completion', 'a2a-dialectic-lite-finalizer.ts': 'completion',
  'github-task-completion.ts': 'completion', 'task-error-details.ts': 'completion',
  'round-progress-tracker.ts': 'completion', 'round-status.ts': 'completion', 'round-result-collector.ts': 'completion',
  'broker-transition-guards.ts': 'kernel', 'broker-status-predicates.ts': 'kernel',
  'broker-task-record-normalizers.ts': 'kernel', 'broker-payload-validators.ts': 'kernel',
  'broker-wake-normalizers.ts': 'claim', 'heartbeat-persist-throttle.ts': 'claim',
  'broker-stale-task-requeue.ts': 'claim', 'resource-aware-worker-policy.ts': 'claim',
  'delegated-runtime.ts': 'execution', 'broker-knowledge-injection.ts': 'execution', 'task-retry-policy.ts': 'execution',
  'a2a-execution-policy.ts': 'execution', 'broker-task-checkpoint.ts': 'execution', 'broker-task-cancellation.ts': 'execution',
  'snapshot-extension-registry.ts': 'store', 'pending-hot-state-buffer.ts': 'store',
  'hot-table-growth.ts': 'observability', 'hot-diagnostics.ts': 'observability',
  'broker-compact-diagnostics.ts': 'observability', 'broker-task-diagnostics.ts': 'observability',
  'wave-evidence.ts': 'evidence-retrieval', 'release-evidence.ts': 'evidence-retrieval', 'proof-matrix.ts': 'evidence-retrieval',
  'wave-plan-dag-v2-mode.ts': 'dispatch', 'scheduler-dry-run.ts': 'dispatch', 'round-manifest.ts': 'dispatch',
  'parent-round-registry.ts': 'dispatch',
};
const RULES = [
  ['policy-approval', /approval|rehearsal|preflight|dry-?run|receipt-ingestor|evidence-collector|review-decision|canary-plan|grant-proposal|^orchestration-intelligence-|canary/],
  ['test-support', /test-helpers/],
  ['store', /^store|repository|^sqlite-|retention|cleanup/],
  ['transport', /conversation|exchange|^task-event|^task-events|listener/],
  ['completion', /terminal|closeout|finalizer|receipt/],
  ['evidence-retrieval', /evidence|lineage|-read\.ts$|proposal-read/],
  ['observability', /dashboard|stats|report|alert|diagnostic|growth/],
  ['execution', /subagent/],
  ['claim', /worker|capabilit|claim|heartbeat|requeue|wake/],
  ['execution', /execution|subagent|checkpoint|cancel|retry|runtime/],
  ['dispatch', /dispatch|admission|intent|round|complexity|work-mode|wave-plan|scheduler|task-request|team1/],
  ['kernel', /helpers|error|collections|value-|guards|normalizers|filters|predicates|validators|types/],
];
const classify = (f) => OVERRIDES[f] ?? RULES.find(([, re]) => re.test(f))?.[0] ?? 'UNCLASSIFIED';

const CLAUSE = String.raw`(?:type\s+)?(?:\w+\s*,\s*)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)`;
const STATIC = new RegExp(String.raw`^\s*(?:import|export)\s+(${CLAUSE})\s*from\s*(['"])([^'"]+)\2`, 'gm');
function scan(text) {
  const out = [];
  for (const m of text.matchAll(STATIC)) {
    const c = m[1].trim();
    const specs = c.startsWith('{') ? c.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean) : [];
    out.push({ spec: m[3], typeOnly: c.startsWith('type ') || (specs.length > 0 && specs.every((s) => s.startsWith('type '))) });
  }
  for (const m of text.matchAll(/^\s*import\s+(['"])([^'"]+)\1/gm)) out.push({ spec: m[2], typeOnly: false });
  for (const m of text.matchAll(/import\(\s*(['"])([^'"]+)\1\s*\)/g)) // type position unless awaited
    out.push({ spec: m[2], typeOnly: !/await\s*$/.test(text.slice(Math.max(0, m.index - 8), m.index)) });
  return out;
}

const isMod = (n) => n.endsWith('.ts') && !n.endsWith('.test.ts');
const files = fs.readdirSync(CORE).filter(isMod).sort();
const mod = {};
for (const f of files) {
  const text = fs.readFileSync(path.join(CORE, f), 'utf8');
  const deps = new Map();
  for (const { spec, typeOnly } of scan(text)) {
    if (!spec.startsWith('./')) continue;
    const to = spec.slice(2).replace(/\.js$/, '.ts');
    if (to === f || !files.includes(to)) continue;
    deps.set(to, deps.has(to) ? deps.get(to) && typeOnly : typeOnly); // value wins
  }
  mod[f] = { domain: classify(f), loc: text.split('\n').length - 1, deps: [...deps].map(([to, typeOnly]) => ({ to, typeOnly })) };
}
const edges = files.flatMap((f) => mod[f].deps.map((d) => ({ fa: f, fb: d.to, a: mod[f].domain, b: mod[d.to].domain, type: d.typeOnly })));

// importers outside core (non-test files under packages/broker/src)
const outside = {};
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (p !== CORE) walk(p); continue; }
    if (!isMod(e.name)) continue;
    for (const { spec } of scan(fs.readFileSync(p, 'utf8'))) {
      const abs = path.resolve(path.dirname(p), spec).replace(/\.js$/, '.ts');
      if (path.dirname(abs) === CORE && mod[path.basename(abs)]) (outside[path.basename(abs)] ??= new Set()).add(p);
    }
  }
})(SRC);

function scc(es) { // Tarjan; returns components of size > 1
  const adj = {}; const nodes = new Set();
  for (const e of es) { nodes.add(e.a); nodes.add(e.b); if (e.a !== e.b) (adj[e.a] ??= new Set()).add(e.b); }
  let i = 0; const idx = {}, low = {}, on = {}, st = [], out = [];
  const visit = (v) => { idx[v] = low[v] = i++; st.push(v); on[v] = true;
    for (const w of adj[v] ?? []) { if (idx[w] === undefined) { visit(w); low[v] = Math.min(low[v], low[w]); } else if (on[w]) low[v] = Math.min(low[v], idx[w]); }
    if (low[v] === idx[v]) { const c = []; let w; do { w = st.pop(); on[w] = false; c.push(w); } while (w !== v); if (c.length > 1) out.push(c.sort()); } };
  for (const n of [...nodes].sort()) if (idx[n] === undefined) visit(n);
  return out;
}

// Step-0 what-if: shared shapes / persistence ports that lower layers already import sink to kernel.
const SINK = new Set(['broker-task-request-normalizers.ts', 'task-error-details.ts', 'broker-wake-normalizers.ts',
  'store-schemas.ts', 'broker-retention-selectors.ts', 'terminal-brief-metadata.ts', 'broker-worker-status.ts',
  ...files.filter((f) => /-repository\.ts$/.test(f))]);
const sunk = (e) => ({ ...e, a: SINK.has(e.fa) ? 'kernel' : e.a, b: SINK.has(e.fb) ? 'kernel' : e.b });
// Target allow-matrix (importer -> allowed target domains). Same-domain always allowed.
const LIFE = ['dispatch', 'claim', 'execution', 'completion'];
const ALLOW = {
  kernel: [], dispatch: ['kernel', 'claim'], claim: ['kernel'], execution: ['kernel', 'dispatch', 'claim'],
  completion: ['kernel', 'dispatch', 'claim', 'execution'],
  'evidence-retrieval': ['kernel', ...LIFE], 'policy-approval': ['kernel', ...LIFE],
  observability: ['kernel', ...LIFE, 'evidence-retrieval'],
  store: ['kernel', ...LIFE, 'evidence-retrieval', 'observability', 'policy-approval'],
  transport: ['kernel', ...LIFE, 'evidence-retrieval', 'observability', 'policy-approval', 'store'],
  facade: ['kernel', ...LIFE, 'evidence-retrieval', 'observability', 'policy-approval', 'store', 'transport'],
  'test-support': ['kernel', ...LIFE, 'evidence-retrieval', 'observability', 'policy-approval', 'store', 'transport', 'facade'],
};
const violations = (es) => es.filter((e) => e.a !== e.b && !ALLOW[e.a]?.includes(e.b)).map((e) => `${e.a}>${e.b} ${e.fa}>${e.fb}${e.type ? ' [type]' : ''}`).sort();
const noFacade = (e) => e.a !== 'facade' && e.b !== 'facade' && e.a !== 'test-support';

const domains = {}; const matrix = {};
for (const f of files) { const d = (domains[mod[f].domain] ??= { files: 0, loc: 0, modules: [] }); d.files++; d.loc += mod[f].loc; d.modules.push(`${f}(${mod[f].loc})`); }
for (const e of edges) { const c = ((matrix[e.a] ??= {})[e.b] ??= { all: 0, value: 0 }); c.all++; if (!e.type) c.value++; }
const fanIn = {}; for (const e of edges) fanIn[e.fb] = (fanIn[e.fb] ?? 0) + 1;
const cross = edges.filter((e) => e.a !== e.b);
// ambiguity: neighbour-domain majority (imports + importers, ignoring kernel/store/facade/test-support) disagrees with assignment
const NEUTRAL = new Set(['kernel', 'store', 'facade', 'test-support']);
const ambiguous = files.filter((f) => !NEUTRAL.has(mod[f].domain)).map((f) => {
  const votes = {};
  for (const e of edges) { const n = e.fa === f ? e.b : e.fb === f ? e.a : null; if (n && !NEUTRAL.has(n)) votes[n] = (votes[n] ?? 0) + 1; }
  const top = Object.entries(votes).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
  return top && top[0] !== mod[f].domain && top[1] > (votes[mod[f].domain] ?? 0) ? `${f}: ${mod[f].domain} vs ${JSON.stringify(votes)}` : null;
}).filter(Boolean);
console.log(JSON.stringify({
  base: { files: files.length, loc: files.reduce((s, f) => s + mod[f].loc, 0), edges: edges.length, typeOnly: edges.filter((e) => e.type).length },
  unclassified: files.filter((f) => mod[f].domain === 'UNCLASSIFIED'),
  domains, matrix,
  fileCycles: { all: scc(edges.map((e) => ({ a: e.fa, b: e.fb }))), value: scc(edges.filter((e) => !e.type).map((e) => ({ a: e.fa, b: e.fb }))) },
  domainCycles: {
    all: scc(cross), value: scc(cross.filter((e) => !e.type)),
    valueNoFacade: scc(cross.filter((e) => !e.type && noFacade(e))),
    valueNoFacadeAfterSink: scc(cross.filter((e) => !e.type && noFacade(e)).map(sunk)),
  },
  topFanIn: Object.entries(fanIn).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([f, n]) => `${f}:${n}:${mod[f].domain}`),
  topFanOut: files.map((f) => [f, mod[f].deps.length]).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([f, n]) => `${f}:${n}:${mod[f].domain}`),
  outsideImporters: Object.entries(outside).map(([f, s]) => [f, s.size]).sort((x, y) => y[1] - x[1]).map(([f, n]) => `${f}:${n}:${mod[f].domain}`),
  ambiguous,
  noSrcImporter: files.filter((f) => !fanIn[f] && !outside[f]),
  crossEdges: cross.map((e) => `${e.a}>${e.b} ${e.fa}>${e.fb}${e.type ? ' [type]' : ''}`).sort(),
  violations: violations(cross), violationsAfterSink: violations(cross.map(sunk)),
}, null, 1));
```

</details>
