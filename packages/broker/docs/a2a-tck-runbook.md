# A2A TCK runbook — measuring conformance against the official kit

The [official A2A Technology Compatibility Kit](https://github.com/a2aproject/a2a-tck)
(`a2aproject/a2a-tck`) is a pytest-based conformance suite for A2A
implementations with RFC 2119 MUST/SHOULD/MAY categorization and HTML/JSON
compliance reports. This runbook wires it to the broker as an **opt-in
measurement lane** — like `refresh:drift-refs`, it is run by maintainers on
demand, not by default CI.

## Why a measurement lane, not a release gate

The broker is an *A2A 1.0-compatible alpha profile* with documented
deviations (see `src/fixtures/a2a-protocol-compatibility.ts`): REST and gRPC
transports are unsupported, push notification **delivery** is not implemented
(the four push-notification config CRUD methods ARE implemented, opt-in via
`A2A_PUSH_NOTIFICATIONS_ENABLED` — the TCK's PUSH-* categories only run when
the SUT is started with that flag, because they gate on
`capabilities.pushNotifications`), and 0.3 compatibility mode is
intentionally absent. Some mandatory TCK tests are therefore **expected to
fail today**. The value of the TCK here is a measured, versioned compliance
report — claims about spec compatibility come from the official kit's
output, not self-assertion.

When the deviation set shrinks, re-run the TCK and check the report delta.
Promote categories to a CI gate only once they are stably green.

## Quick self-check (no Python required)

```bash
cd packages/broker
npm run tck:self-check
```

Boots an ephemeral loopback broker (temp state file, no live surfaces),
probes `/.well-known/agent-card.json` and the JSON-RPC `ListTasks` method,
and exits. This is the harness's own health check and is safe to run
anywhere.

## Full TCK run

```bash
# one-time setup
git clone https://github.com/a2aproject/a2a-tck
cd a2a-tck
uv venv
. .venv/bin/activate
uv pip install -e .
cd -

# run MUST-level JSON-RPC conformance against a fresh local broker
cd packages/broker
A2A_TCK_DIR=/path/to/a2a-tck npm run tck:run -- --level must --transport jsonrpc
```

Requirement levels and transports (per the TCK):

| Flag | Values | Meaning |
| --- | --- | --- |
| `--level` | `must`, `should`, `may` | RFC 2119 requirement level to run |
| `--transport` | `jsonrpc`, `grpc`, `http_json` | Transport filter; this broker currently uses JSON-RPC |

Reports are written by the TCK into its own output directory; attach the
JSON/HTML report to the round evidence when citing compliance numbers.

## Historical baseline (2026-06-11, `--level must --transport jsonrpc`)

First official-TCK run after wiring `supportedInterfaces` and relaxing the
harness rate limits:

- **agent_card: 6/6** — full agent-card tier passes (required fields,
  `supportedInterfaces` protocol bindings, schema).
- **jsonrpc MUST: 12/75 pass, rest fail/skip** — the dominant remaining
  blockers are (a) JSON-RPC error codes not matching the A2A reserved family
  (`-32001 TaskNotFoundError` etc.) and missing `ErrorInfo` in `error.data`,
  and (b) `SendMessage` requiring a pre-registered broker worker, which the
  TCK (a single-agent client) cannot satisfy, cascading into the task-
  creating CORE tests.

Track this number down as alignment PRs land. The error-code/`ErrorInfo`
alignment is in-scope correctness work; the worker-registration model is an
architectural decision recorded for follow-up.

## Latest official measurements (2026-07-22)

[Workflow run 29915210798](https://github.com/jinwon-int/a2a-nexus/actions/runs/29915210798)
measured the pinned official TCK against commit `c64ae2e` on a disposable
loopback broker. Outcome accounting was complete (`48 passed`, `20 failed`,
`167 skipped`; 235 observed node IDs), so the five selector-based JSON-RPC
sub-categories were emitted into the committed history:

| JSON-RPC sub-category | Result | Promotion state |
| --- | --- | --- |
| error codes and ErrorInfo | 6/13 | blocked; failures remain |
| task-not-found and invalid-task | 1/7 | blocked; failures remain |
| artifact/message projection | 4/9 | blocked; failures remain |
| streaming/subscribe ordering | 3/9 | blocked; six selected tests skipped |
| version negotiation | 4/4 | first green window |

The version-negotiation result is a real RED-to-GREEN change from the same-day
[main measurement](https://github.com/jinwon-int/a2a-nexus/actions/runs/29914841795)
(`3/4`) to the branch measurement (`4/4`). A second independent
[main measurement](https://github.com/jinwon-int/a2a-nexus/actions/runs/29917128590)
at merge commit `a078564` also measured `4/4` with sufficient outcome
accounting. This satisfies the normal two-window stability rule, so version
negotiation is now a blocking promoted sub-category.

## Compliance trend (committed, in-repo)

The measured numbers are recorded in
[`docs/tck-history.json`](tck-history.json) so the trend is readable without
opening Actions artifacts. Each entry is one measurement (`date`, `level`,
`transport`, `overallPercent`, optional `must` pass/total, per-category
pass/total, and (for complete verbose runs) selector-based sub-category
pass/total plus outcome accounting).

| Date / run | Level / transport | Overall | MUST | agent_card | jsonrpc | version negotiation |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-06-11 | must / jsonrpc | — | 12/75 | 6/6 | 12/75 | not measured |
| 2026-07-22 / 29915210798 | must / jsonrpc | 65.7% | — | 6/6 | 46/94 | 4/4 (window 1/2) |
| 2026-07-22 / 29917128590 | must / jsonrpc | 65.7% | — | 6/6 | 46/94 | 4/4 (window 2/2) |

Update the trend after a run:

```bash
cd packages/broker
node scripts/append-tck-history.mjs --log /tmp/tck-run.log \
  --level must --transport jsonrpc            # appends/refreshes today's entry
node scripts/check-tck-regressions.mjs        # flags a drop, lists promotion candidates
```

`append-tck-history.mjs` preserves those coarse summary fields and also parses
verbose pytest `PASSED`/`FAILED`/`SKIPPED` node outcomes. The deterministic,
mutually exclusive selectors in `docs/tck-failing-categories.json` map nodes to
the five JSON-RPC sub-categories. A sub-category `pass`/`total` is emitted only
when the unique verbose node counts reconcile exactly with pytest's terminal
summary and no node matches multiple selectors. Failure-summary duplicates are
deduplicated; unmatched node IDs remain listed under `pytestOutcomeAccounting`
as `unclassified`, and truncated/failure-only logs retain incomplete accounting
without emitting a measured pass/total. The entry is then upserted by
`date`+`level`+`transport`+`source` when a source identity is present, so
independent same-day workflow runs remain separate stability windows. Legacy
source-less entries retain daily replacement behavior. Commit the updated
`tck-history.json` from the fresh official-TCK artifact together with its
baseline/readiness projection.

### Stability ledger and gate promotion

`check-tck-regressions.mjs` is the loud signal:

- **Regression** — the comparable metric dropped between consecutive
  measurements of the same level+transport (MUST pass count when the suite
  size is unchanged, else OVERALL percent). It exits non-zero. A suite-size
  change is reported as a note, not a regression, so a larger TCK does not
  raise a false alarm.
- **Promotion candidates** — categories and selector-based sub-categories that
  are fully green (`pass == total`) across the last N independent measurements
  (default 2). These are the categories the next sentence's rule applies to.

Promote a category to a CI gate only once it appears as a stable promotion
candidate.

### Promoted-category PR gate

`.github/workflows/tck-promoted-gate.yml` contains fail-closed jobs for the
official TCK `agent_card` category and the promoted version-negotiation
sub-category. The agent-card job runs:

```bash
cd packages/broker
A2A_TCK_DIR=/tmp/a2a-tck npm run tck:run -- \
  --level must --transport jsonrpc -- \
  --ignore=tests/compatibility/core_operations \
  --ignore=tests/compatibility/grpc \
  --ignore=tests/compatibility/http_json \
  --ignore=tests/compatibility/jsonrpc \
  -q
```

`run_tck.py` always seeds pytest with `tests/compatibility/`, so this gate
uses explicit `--ignore` entries for the non-promoted compatibility directories
instead of appending `tests/compatibility/agent_card` as a positional path.

The version-negotiation job uses a pytest `-k` expression for the three unique
test functions and explicitly deselects the two unrelated parameter cases from
`test_error_code_in_valid_range`. That leaves exactly four official-TCK tests;
the job fails on any failure and uploads its log independently.

Promotion evidence: the committed baseline records `agent_card: 6/6` green for
`must / jsonrpc` on 2026-06-11. This first `agent_card` PR gate is a documented
one-time promotion exception to the default stability-window rule: the category
is small, read-only, official-TCK backed, and limited to agent-card schema and
protocol-binding fields that are already part of every broker A2A surface
change. `check-tck-regressions.mjs` still keeps the default stable window at 2,
so future promoted categories must appear as stable promotion candidates across
the configured window before they are added as CI gates.

Version-negotiation promotion evidence is the pair of sufficient official-TCK
runs `29915210798` and `29917128590`, each at `4/4`. The committed regression
checker reports `jsonrpc-version-negotiation` under
`subCategoryPromotionCandidates`; the blocking job reproduces the same four
selectors against every matching PR.

Artifact/message-projection promotion evidence is the pair of sufficient
official-TCK runs `30225853781` and `30225919582`, each at `9/9`; the blocking
job reproduces the same nine selectors (five artifact/message tests plus the
four data-model shape tests). Error-codes/ErrorInfo promotion evidence is the
same run pair, each at `12 passed / 0 failed / 1 capability-skip` of 13: the
skipped selector (`test_unsupported_operation_error`) is capability-unreachable
by design — the TCK skips it whenever the agent card declares
`capabilities.streaming`, and its only `-32004` trigger is
`SendStreamingMessage` against a non-streaming agent. It is recorded under
`capabilityExcludedSelectors` in `docs/tck-failing-categories.json`, the gate
job runs the twelve runnable selectors, and
`scripts/project-tck-readiness.mjs` only projects such a category when the
latest sufficient measurement shows zero failures and exactly the documented
number of skips.

Two `test_requirements.py` runner tests (`CORE-SEND-003`, `CORE-MULTI-002a`)
are unwinnable by construction at the pinned TCK ref
(`29063fe95e903cddac5d8ff811ab94df1ad6ef86`): their requirement definitions
lack `expected_error` bindings, so the parametrized runner demands
`response.success` for tests whose purpose is an error response. They belong
to no promoted selector set; revisit when the TCK pin is bumped.

Task-not-found/invalid-task promotion evidence is the pair of sufficient
official-TCK runs `30227144905` and `30227192223`, each at `7/7` with zero
skips; the blocking job reproduces the same seven selectors (owning only the
`GetTask-nonexistent` variant of the shared `test_error_code_in_valid_range`
parameter test). The category became measurable once the embedded default
agent learned the `tck-complete-task` convention and terminal-task operations
returned `-32004` (#1500 PRs #1650/#1652).

Streaming/subscribe-ordering promotion evidence is the pair of sufficient
official-TCK runs `30229217224` and `30229296963`, each at `9/9` with zero
skips; the blocking job reproduces the same nine selectors. The category
became measurable once `SubscribeToTask` upgraded to a real SSE stream for
`Accept: text/event-stream` clients and the embedded default agent learned
the `tck-input-required` convention (#1500 PR #1655). With this promotion all
five #1500 sub-categories gate PRs.

The promoted gate is deliberately scoped to
broker A2A-surface changes (`src/a2a`, protocol compatibility fixtures,
`server.ts`, the TCK harness, this runbook/history, and the workflow itself).
It is fail-closed for that promoted category, while the scheduled
`tck-measurement` workflow remains the broader non-gating measurement lane.

The current overall, Agent Card, JSON-RPC, and promoted-sub-category results
are also projected into the repository-level
[`docs/release-readiness.md`](../../../docs/release-readiness.md). Do not edit
those numbers by hand. `scripts/project-tck-readiness.mjs` reads the latest
sufficient `must / jsonrpc` entry from `docs/tck-history.json`, combines it
with only the promotion state in `docs/tck-failing-categories.json`, and
renders the marked block deterministically:

```bash
cd packages/broker
node scripts/project-tck-readiness.mjs --check
# After committing a fresh official-TCK measurement:
node scripts/project-tck-readiness.mjs --write
```

The promoted-gate workflow runs the check and its synthetic stale-output
regression test. Missing markers, stale results, incomplete measurement
accounting, or a disagreement between the latest promoted result and its
classification baseline fail closed.

Do **not** broaden `tck-promoted-gate.yml` to the full TCK suite until the
additional categories appear in the stability ledger; add promoted categories
one at a time with their evidence and keep the measurement lane non-gating.

## Scheduled measurement (CI)

`.github/workflows/tck-measurement.yml` runs this harness weekly (and on
manual dispatch) against a freshly built, locally-booted broker, uploads
the official TCK compliance report as a 90-day artifact plus a job summary,
appends the measurement to `docs/tck-history.json` (uploaded as an artifact
to commit in a follow-up), and runs the regression check as a loud,
non-gating step. It passes pytest `-v` through the existing harness separator
and captures stderr with stdout so every selected test's node outcome is
available to the history parser.

It is an **opt-in measurement lane, never a release gate** (`continue-on-error`,
no PR trigger): the documented profile deviations mean some MUST tests are
expected to fail, so the job's purpose is a tracked compliance number that
surfaces regressions, not a pass/fail gate. As deviations shrink (spec
result shapes, error codes, default-agent mode, push config), the weekly
number should climb; a drop is the signal to investigate.

## Safety

The harness binds loopback only, uses an ephemeral temp state file, disables
the stale reaper, and performs no live sends, deploys, terminal ACKs, or DB
mutations. It is source-only measurement.

## Interactive debugging

For ad-hoc inspection of the broker's A2A surface (agent card rendering,
message sending, task views), the official
[a2a-inspector](https://github.com/a2aproject/a2a-inspector) debug UI can be
pointed at a locally started broker (`npm run start:local`). Treat it as a
developer tool — it is not part of any gate.
