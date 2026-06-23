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

## Measured baseline (2026-06-11, `--level must --transport jsonrpc`)

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

## Compliance trend (committed, in-repo)

The measured numbers are recorded in
[`docs/tck-history.json`](tck-history.json) so the trend is readable without
opening Actions artifacts. Each entry is one measurement (`date`, `level`,
`transport`, `overallPercent`, `must` pass/total, and per-category
pass/total).

| Date | Level / transport | MUST | agent_card | jsonrpc |
| --- | --- | --- | --- | --- |
| 2026-06-11 | must / jsonrpc | 12/75 | 6/6 | 12/75 |

Update the trend after a run:

```bash
cd packages/broker
node scripts/append-tck-history.mjs --log /tmp/tck-run.log \
  --level must --transport jsonrpc            # appends/refreshes today's entry
node scripts/check-tck-regressions.mjs        # flags a drop, lists promotion candidates
```

`append-tck-history.mjs` parses the same summary lines the workflow greps and
upserts the entry (one per `date`+`level`+`transport`). Commit the updated
`tck-history.json` in a follow-up docs PR.

### Stability ledger and gate promotion

`check-tck-regressions.mjs` is the loud signal:

- **Regression** — the comparable metric dropped between consecutive
  measurements of the same level+transport (MUST pass count when the suite
  size is unchanged, else OVERALL percent). It exits non-zero. A suite-size
  change is reported as a note, not a regression, so a larger TCK does not
  raise a false alarm.
- **Promotion candidates** — categories that are fully green
  (`pass == total`) across the last N measurements (default 2). These are the
  categories the next sentence's rule applies to.

Promote a category to a CI gate only once it appears as a stable promotion
candidate.

### Promoted-category PR gate

`.github/workflows/tck-promoted-gate.yml` is the first promoted-category PR
gate. It runs only the official TCK `agent_card` category:

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

Promotion evidence: the committed baseline records `agent_card: 6/6` green for
`must / jsonrpc` on 2026-06-11. This first `agent_card` PR gate is a documented
one-time promotion exception to the default stability-window rule: the category
is small, read-only, official-TCK backed, and limited to agent-card schema and
protocol-binding fields that are already part of every broker A2A surface
change. `check-tck-regressions.mjs` still keeps the default stable window at 2,
so future promoted categories must appear as stable promotion candidates across
the configured window before they are added as CI gates.

The promoted gate is deliberately scoped to
broker A2A-surface changes (`src/a2a`, protocol compatibility fixtures,
`server.ts`, the TCK harness, this runbook/history, and the workflow itself).
It is fail-closed for that promoted category, while the scheduled
`tck-measurement` workflow remains the broader non-gating measurement lane.

Do **not** broaden `tck-promoted-gate.yml` to the full TCK suite until the
additional categories appear in the stability ledger; add promoted categories
one at a time with their evidence and keep the measurement lane non-gating.

## Scheduled measurement (CI)

`.github/workflows/tck-measurement.yml` runs this harness weekly (and on
manual dispatch) against a freshly built, locally-booted broker, uploads
the official TCK compliance report as a 90-day artifact plus a job summary,
appends the measurement to `docs/tck-history.json` (uploaded as an artifact
to commit in a follow-up), and runs the regression check as a loud,
non-gating step.

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
