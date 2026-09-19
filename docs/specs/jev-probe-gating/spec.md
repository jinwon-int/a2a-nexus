# Feature Spec: JEV Probe-vs-Real-Work Gating (#2185 arm-C wiring)

> **Status**: spec-first slice — spec trio + registration-gap prep commit,
> then source. This document authorizes no live jev call, no deploy, no
> restart, and no fleet rollout. Endpoint values and key material are NEVER
> stored in these docs or the repo.

## Problem

Broker-side probe-vs-real-work classification currently relies on local
heuristics only. #2185 plans an offline comparison of classification arms
(A rules / B LLM / C jev), but there is no wiring that lets a broker instance
consult the typesafe.ai jev classifier without changing default behavior,
response shapes, or the script budget.

Prior incident constraint: the jev API key leaked twice through chat. The key
must never appear in chat, logs, outputs, diffs, or fixtures again; it travels
only via a 0600 key-only file, and the endpoint value is deploy-time context,
never a committed artifact.

## Goal

- Opt-in, env-gated jev classification for tasks the handler classified as
  probes, executed at the handler's single async point (stdin CLI entry at
  EOF): one bounded HTTP attempt; a valid real-work verdict routes the task
  through the existing real-work path; every other outcome keeps the
  already-produced generic_ack output unchanged.
- Default OFF with byte-identical behavior (stdout/stderr/exit) when OFF or
  misconfigured; deterministic single-attempt fallback when ON and jev fails.
- No new response fields; existing response shapes only.

## Non-goals

- No accuracy or benchmark claims; arms A/B/C evaluation, leakage-free
  benchmark design, and Brier scoring stay in #2185.
- No retry, no backoff, no queueing, no multi-provider routing engine.
- No new CLI command, top-level script, npm script, or dependency: the
  classifier is a library facade at `scripts/lib/jev-classifier.mjs`; the
  script budget stays flat 160/160 (#882/#1485/#1503; `scripts/lib/` is not
  counted).
- No worker-process egress (approach B) in this slice.
- No changes to the probe-ack 6-key contract or `handleTask` synchronicity.

## Reuse contract (decided)

| Asset | Role in this slice |
|---|---|
| Handler generic_ack path | Fallback output: byte-identical to gate-off whenever jev does not yield a valid verdict. |
| Handler stdin CLI entry (argv == SOURCE_PATH, EOF) | Sole permitted async call site; `handleTask` stays fully synchronous. |
| `worker-artifact-rollout-guard` mechanism | 3-site registration for every handler/bridge-imported lib: guard list + Dockerfile handlers/ per-file cp block + guard-test fixture. |
| `a2a-task-handler.test.mjs` pattern | Unit-test style: `node --test`, stub transport, no network I/O, no secrets in fixtures. |

## Environment contract

| Variable | Required | Default | Behavior |
|---|---|---|---|
| `A2A_JEV_CLASSIFY` | gate | unset | Disable tokens (trimmed, case-insensitive): `''`, `none`, `null`, `undefined`. Any other non-empty value enables. |
| `A2A_JEV_ENDPOINT` | yes when enabled | — | Absolute URL. Missing/invalid → disabled. |
| `A2A_JEV_KEYFILE` | yes when enabled | — | Readable file (0600) containing the key only. Missing/unreadable → disabled. |
| `A2A_JEV_TIMEOUT_MS` | no | 1500 | Integer; unparseable → default; clamped to [250, 5000]. |
| `A2A_JEV_MODEL` | no | — | Passed through to jev when set. |

Enabled requires the valid trio: enabling gate token + valid endpoint + valid
keyfile. Gate on but configuration invalid → classification disabled: one
stderr warning line, then stdout byte-identical to gate-off.

## Behavior contract (approach A: reclassify at async CLI entry)

1. `handleTask` runs synchronously and emits the existing output (probe-class
   tasks → generic_ack). No network inside `handleTask`.
2. At the stdin CLI entry, if and only if enabled: exactly one jev attempt for
   probe-classified tasks, bounded by `A2A_JEV_TIMEOUT_MS`.
3. A verdict is accepted only when the response parses as JSON carrying a
   boolean `is_real_work`. Valid `true` → the task is handled through the
   existing real-work path. Valid `false` → generic_ack kept.
4. Any other outcome (invalid JSON, missing field, timeout, non-2xx, transport
   error) → deterministic fallback: the generic_ack output is kept unchanged.
5. Score-based thresholds and tuning are out of scope here (#2185).

## Invariants

- Gate-off (and invalid-config) behavior is byte-identical to current behavior.
- Single attempt per task; a failure never retries; nothing blocks on jev
  beyond the clamped timeout.
- The key exists only in the 0600 keyfile; never in env dumps, logs, error
  text, diffs, or test fixtures. BUILD_INFO keeps `credentialFree: true` and
  `hostNeutral: true`.
- Every handler/bridge-imported lib is registered at all three sites: guard
  list, Dockerfile handlers/ per-file cp block, guard-test fixture.

## Verification summary (what this slice proves)

- Gate parsing: disable/enable tokens, invalid trio, timeout clamp bounds.
- Stub-transport single-attempt: success re-route, invalid-verdict fallback,
  HTTP-failure fallback, timeout fallback (observed call count == 1).
- Golden default-off byte-identity test against pre-change output.
- Registration guard green with the fixture updated; tests do no network I/O.

## Acceptance criteria

- [ ] Spec/plan/tasks exist on this branch and match the implementation.
- [ ] `A2A_JEV_CLASSIFY` unset → byte-identical output (golden test green).
- [ ] Enabled + valid verdict `is_real_work: true` → real-work path taken.
- [ ] Enabled + any jev failure → generic_ack kept; exactly one attempt.
- [ ] Enabled + invalid trio → one stderr warning, stdout identical to gate-off.
- [ ] Timeout default 1500, clamp [250, 5000] honored.
- [ ] `scripts/lib/jev-classifier.mjs` registered at all three sites.
- [ ] Pre-existing registration gaps closed in a separate prep commit.
- [ ] Root `npm test` green; broker `tsc -b` green; test manifest aligned.
- [ ] Diff audit: no key material, no endpoint values, budget stays flat.
