# Implementation Plan: JEV Probe-vs-Real-Work Gating (#2185 arm-C wiring)

## Baseline

- Branch `feat/jev-probe-gating` @ `d622d7d`, clean tree.
- Handler sources live at `packages/broker/scripts/` (repo layout); `handlers/`
  is the in-image layout only.
- Registration sites pinned:
  - `HANDLER_SUPPORT_FILENAMES` at
    `packages/broker/scripts/worker-artifact-rollout-guard.mjs` L49-54
    (currently worker-model-policy.mjs, lib/source-carriers.mjs,
    lib/retrieval-snapshot-carriers.mjs, lib/live-operation-adapter.mjs);
  - Dockerfile L95 whole-dir `COPY scripts/lib` serves the scripts/ layout;
    the handlers/ per-file cp block ~L103-109 (handler, worker-model-policy,
    3 libs, bridge, chown) is the under-registration site;
  - guard-test fixture paths L60-65 and asserts L143/L165 in
    `worker-artifact-rollout-guard.test.mjs`.
- Pre-existing unregistered imports (confirmed; none in guard list nor cp
  block):
  - `a2a-task-handler.mjs` L19 → `./lib/analysis-execution-telemetry.mjs`;
  - `hermes-a2a-analysis-bridge.mjs` L6 → `./finalizer-tool-policy.mjs`;
  - `hermes-a2a-analysis-bridge.mjs` L14 → `./lib/utf8-byte-budget.mjs`.

## Decisions

- Telemetry/bridge registration gaps: fixed as a SEPARATE prep commit on this
  branch (distinct concern; keeps the jev commit small and reviewable). The
  new `jev-classifier.mjs` registration rides the jev commit.
- Approach A (reclassify at the broker stdin CLI entry) over approach B
  (worker-process egress). B is revisited only if the CLI-entry egress
  precondition is rejected.
- Verdict gate: boolean `is_real_work` only; no score thresholds in this
  slice.

## Phases

### Phase A — spec trio (this step)

1. `docs/specs/jev-probe-gating/{spec,plan,tasks}.md` written via bash and
   verified on disk against `feat/jev-probe-gating@d622d7d`.
2. Contract decisions fixed: env gate tokens and trio validity, timeout
   default/clamp, single-attempt fallback, verdict shape, 3-site registration
   duty, prep-commit split.

### Phase B — registration-gap prep commit

1. Register `lib/analysis-execution-telemetry.mjs`,
   `finalizer-tool-policy.mjs`, and `lib/utf8-byte-budget.mjs` in
   `HANDLER_SUPPORT_FILENAMES` + the Dockerfile handlers/ cp block + the
   guard-test fixture.
2. Guard test green; commit isolated from jev changes.

### Phase C — classifier lib

1. `packages/broker/scripts/lib/jev-classifier.mjs`: env parsing (gate
   tokens, trio validity, timeout clamp), keyfile read at call time,
   injectable (stub-able) transport, single attempt.
2. Unit tests in the `a2a-task-handler.test.mjs` pattern (`node --test`);
   synthetic non-secret fixtures; zero network I/O.

### Phase D — CLI-entry hook

1. After generic_ack at the stdin CLI entry (argv == SOURCE_PATH): one
   attempt, `is_real_work` verdict gate, deterministic fallback.
2. Golden default-off byte-identity test; gate-on-invalid-config
   stderr-warning test.

### Phase E — validation & manifests

1. Register `jev-classifier.mjs` at all three sites.
2. Align test-manifest / release-gate coverage entries (single big
   `node --test` entry); root `npm test`; broker `tsc -b`.
3. Diff audit: no secrets, budget flat, BUILD_INFO untouched.

## Risks & mitigations

- **Egress permission unknown** for the handler runtime: the call is confined
  to the broker CLI entry; the endpoint comes from prior operator context at
  deploy time and is never echoed or stored; live calls stay gated on
  operator approval.
- **Secret leakage**: keyfile-only (0600); the key is never logged; fixtures
  carry synthetic strings; any key material in a diff blocks the PR.
- **Behavior drift when OFF**: a golden byte-identity test proves
  default-off behavior.
- **Silent misconfig**: gate-on-invalid-config prints one stderr warning
  before behaving like gate-off.
- **Shared-repo discipline**: main is merge-queue protected; open PRs
  #1802/#1799/#1784/#1789 untouched; no deploys/restarts in trains; seoseo-ai
  gh credentials stay on the seoseo node.
