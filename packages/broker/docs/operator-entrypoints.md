# Operator script entrypoints (broker package)

Single discovery point for every operator/public entrypoint in
`packages/broker/package.json` (a2a-nexus#1503 acceptance criterion:
"public/operator entrypoints must be discoverable in one document"). Each
entrypoint below carries its tier, owner, consumer, and retirement condition —
directly or through its tier legend. For the audit/consolidation *procedure*
see `docs/npm-scripts-inventory.md`.

## 1. Dispatcher surfaces (post-ratchet operator tools)

Three npm entries dispatch to tool families through the shared lib
`scripts/lib/operator-dispatch.mjs`. The per-family manifest JSON is the
contract: it maps a tool name to its wrapper script and whether `npm run
build` runs first (`build: true`).

| npm entry | tools | manifest | runner |
|---|---|---|---|
| `terminal_brief` | 59 | `scripts/terminal-brief-manifest.json` | `scripts/terminal-brief.mjs` |
| `orchestration` | 21 | `scripts/orchestration-manifest.json` | `scripts/orchestration.mjs` |
| `rollout` | 22 | `scripts/rollout-preflight-manifest.json` | `scripts/rollout.mjs` |

```bash
npm run orchestration -- --list                 # discover valid tool names
npm run orchestration -- <tool> [tool args...]  # dispatch (builds first if build=true)
npm run orchestration -- <tool> --no-build      # skip the pre-dispatch build
```

Semantics (enforced by `scripts/operator-dispatch.test.mjs`):

- Unknown tools fail closed with exit code 2 and point at `--list`.
- argv, stdio, and the wrapper's exit code pass through unchanged.
- Manifest entries starting with `dist/` resolve to compiled entry points
  under the package `dist/`; everything else resolves next to the manifest.
- The lib never consolidates tool logic — wrappers stay separate files over
  the `src/core` engines. Only the npm-alias surface was retired.

Adding a tool: add the wrapper script plus a manifest entry, and bump the
expected tool count in `scripts/operator-dispatch.test.mjs`. Retiring a tool:
remove the manifest entry, then delete the wrapper only after the caller
audit in `docs/npm-scripts-inventory.md` shows no live references.

## 2. Direct npm scripts by tier

54 direct scripts remain. Owner for all tiers is the broker maintainer set
(`CODEOWNERS`); consumers and retirement conditions differ per tier.

| Tier | Consumer | Retirement condition |
|---|---|---|
| T0 build/runtime core | every developer + CI | never while the package ships |
| T1 PR/release gate | CI, release-gate, TCK history | only together with the gate it serves, via the gate's own manifest |
| T2 dispatcher entrypoint | operators | surface-level: after full caller audit; tool-level: via family manifest |
| T3 operator live/round tool | operator runbooks, round closeouts | runbook + CI + cron caller audit clean, then fold into a dispatcher or retire |
| T4 focused test shortcut | developers iterating on one gate | fold into the `npm test` manifest (`scripts/test-manifest.json`) |

| Script | Tier | Notes |
|---|---|---|
| `build` | T0 | tsc + build-info |
| `check` | T0 | typecheck |
| `test` | T0 | manifest-driven runner (`scripts/test-manifest.json`) |
| `clean:dist` | T0 | |
| `start` | T0 | broker server |
| `start:worker` | T0 | worker process |
| `dev` / `dev:worker` | T0 | watch mode |
| `start:local` | T0 | local loopback broker |
| `worker:echo` | T0 | local echo worker |
| `release_gate` | T1 | full release gate |
| `test:worker` | T1 | compiled worker test |
| `tck:self-check` / `tck:run` | T1 | A2A TCK harness |
| `tck:history:append` / `tck:check-regressions` | T1 | TCK history |
| `rollout_guard` | T1 | manifest-required gate (stays direct) |
| `worker_signature_rollout_preflight` | T1 | manifest-required gate (stays direct) |
| `scan:public-readiness` | T1 | package CI parity requiredScript (stays direct) |
| `coverage:baseline` | T1 | coverage floors (#1506) |
| `reconcile_closeout` | T1 | closeout reconciliation |
| `scripts_inventory` | T1 | npm script inventory/audit |
| `test:drift-watch` / `refresh:drift-refs` | T1 | protocol drift watch |
| `terminal_brief` | T2 | dispatcher, 59 tools |
| `orchestration` | T2 | dispatcher, 21 tools |
| `rollout` | T2 | dispatcher, 22 tools |
| `live_readiness_canary` | T3 | live broker canary |
| `smoke:restart-recovery` | T3 | restart recovery smoke |
| `smoke:docker-broker` / `smoke:docker-broker:fleet` | T3 | live docker smoke |
| `export:sqlite` | T3 | state export |
| `livez_stall_measure` / `livez_stall_measure_live` | T3 | livez stall attribution |
| `comprehensive_diagnostics` / `comprehensive_diagnostics_live` | T3 | broker diagnostics |
| `team1_dispatch_wrapper` | T3 | team dispatch |
| `a2a_dispatch_helper` / `team2_dispatch_helper` | T3 | team dispatch |
| `round_manifest` / `round_parent_aggregate_report` | T3 | round closeout |
| `a2a_dialectic_lite_finalizer` | T3 | round closeout |
| `round_coordinator_closeout_dry_run` | T3 | round closeout |
| `a2ad_evidence_classifier` | T3 | evidence classification |
| `a2a_hybrid_worker_mode_benchmark` | T3 | benchmark |
| `test:work_mode_pre_dispatch_decision` | T4 | |
| `test:adaptive_work_mode_selector` | T4 | |
| `test:execution-plan-draft` | T4 | |
| `test:operator-approval-request` | T4 | |
| `test:terminal_brief_activation_report` | T4 | |
| `test:edge_secret_rotation_diagnostics` | T4 | |
| `test:round_coordinator_closeout_dry_run` | T4 | |
| `test:livez-stall` | T4 | |
| `test:comprehensive-diagnostics` | T4 | |

## 3. Surface regrowth guard

`scripts/check-script-budget.mjs` (root `check:script-budget`) freezes three
counts — root `scripts/*.mjs`, root npm scripts, broker npm scripts. Adding a
direct npm alias fails the gate; budgets only ratchet **down** as
consolidation lands. The preferred response to new tooling is a manifest
entry on an existing dispatcher, not a new alias.

## 4. Broker core hotspot report

`scripts/core-hotspot-report.mjs` satisfies the #1503 requirement to report
broker-core hotspots and cycle/dependency direction automatically:

```bash
node scripts/core-hotspot-report.mjs            # text report, top 10
node scripts/core-hotspot-report.mjs --top 20   # wider rankings
node scripts/core-hotspot-report.mjs --json     # machine-readable
```

It builds the static import graph over `packages/broker/src` (tests excluded)
and reports top modules by fan-in/fan-out, coupling hotspots
(fan-in × fan-out, with line counts), import cycles as Tarjan
strongly-connected components, and layer-direction violations (`src/core`
importing outside `src/core` — an upward edge against the independent-core
direction locked by `check:broker-core-dependency-isolation`). Report-only:
it informs consolidation targets and never gates. Intentionally has no npm
alias — invoke it directly so the script budget stays flat; it runs in CI as
part of `npm test` via its regression test
(`scripts/core-hotspot-report.test.mjs`, test-manifest step-20).
