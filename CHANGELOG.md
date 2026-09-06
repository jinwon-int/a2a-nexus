# Changelog

All notable public-safe changes for **A2A Nexus** are collected here. This file is release-preparation documentation only: it does not publish packages, create tags, change repository visibility, deploy services, restart services, mutate production state, send provider messages, rotate secrets, or ACK terminal outbox records.

## Unreleased

Public-safe changes accrued since `v0.1.0-alpha`, grouped by theme (running
summary with representative PR anchors; not every internal change is listed).
This section is release-preparation documentation only — it does not publish,
tag, deploy, or mutate any live state.

### Added — signed finalizer verdicts and merge-gate enforcement

- Signed finalizer verdict contract + enforcement gate, with in-broker and
  offline verdict-signature verification and a `finalizer-verdict-gate` CI job
  bound to the PR head SHA (`#1383`, `#1384`, `#1430`, `#1435`).
- Finalizer keyring lifecycle: a single keyring format serves both the broker
  and the repo merge gate, with immediate revocation and `producedAt` validity
  windows (`#1432`, `#1436`). Structural finalizer independence via a disjoint
  role-registry validator and provenance-derived producing-worker keys
  (`#1429`, `#1433`).

### Added — verifiable analysis reports and provenance binding

- Verifiable analysis report v0 contract with an independent offline verifier,
  fail-closed exporter, and result↔source binding (`#1378`, `#1379`, `#1396`,
  `#1398`). Signed retrieval snapshots bound to analysis results (`#1399`).
- Verifiable delegation contract v0 with a spec↔broker conformance gate
  (`#1304`, `#1425`).
- Per-task attestation bundles with embedded cryptographic provenance and an
  independent verifier, plus a round-replay CLI for deterministic reruns
  (`#1301`, `#1423`, `#1448`, `#1302`, `#1449`).

### Added — policy engine, durable wave plans, and sub-agent fanout

- Declarative worker-class policy engine (warn→enforce) (`#1355`, `#1404`),
  including observation-driven source-only safe-intent refinement and dispatch
  rejection for source-only GitHub write lanes.
- Durable wave-plan state machine with persistence, restart resume, HTTP
  lifecycle routes, and a stale-plan reaper (`#1357`).
- Source-only sub-agent fanout controls: token-budget counter, spawn-gate
  decision, deterministic evidence assembly, shared context brief, and a
  redaction gate (`#1537`), plus the Phase-2 container-lane fanout wiring
  (`#1543`).
- First-class Codex runner profile and analysis bridge (`#1549`, `#1551`).

### Changed — live-task admission and runtime hardening

- Live-task approvals bound to scoped HMACs with atomic admission and persisted
  approval-consumption keys (`#1510`). Result-provenance countersign posture
  flag with a startup preflight (`#1389`, `#1403`).
- Graceful broker drain on redeploy with jittered worker reconnect (`#1405`),
  and tolerance for small clock skew on A2A signature timestamps (`#1402`).

### Added — source-only quality and doc-consistency gates

- Measure-only coverage baselines across the broker, runner, and plugin
  packages (`#1506`). Semantic current-state, package-matrix, and
  CHANGELOG-release-drift doc gates (`#1501`). Executable quickstart onboarding
  (`#1505`) and a gated author-independent review policy (`#1507`).

### Added — shared-state V1: durable SQLite adapter, fenced ownership, closed query surface

- Shared-state V1 SQLite adapter built slice by slice: schema and migration,
  adapter lifecycle with exclusive ownership, replay/rate/lease/idempotency
  primitives, claim-graph primitives, and the idempotency↔outbox effect link
  (`#1934`–`#1944`). All seven conformance phases (2.1–2.7) now run against the
  V1 adapter (`#1940`, `#1942`, `#1947`–`#1950`), and again through a bounded
  FIFO worker lane (`#1970`–`#1978`), with read-path and write-effect
  fail-closed proofs (`#1979`, `#1981`, `#1983`, `#1984`).
- Deployment-grade configuration that refuses startup when invalid (`#1952`,
  `#1953`), a serving fence acquired at startup with a `/readyz` route that
  re-reads it (`#1954`, `#1955`), non-liveness routes refused once the fence is
  lost (`#1956`), and `lost_fence` latching that drops connections and exits
  without draining (`#1959`–`#1961`). `/health` publishes a thin `stateContract`
  and volatile replay/rate reset risk (`#1957`, `#1958`).
- Closed V1 query envelopes with outbox-reconciliation and graph-evidence
  queries, promoted to a bounded public query surface (`#1964`–`#1968`).
- Conformance harnesses for expiry boundaries, claim-graph
  projection/rollback, and partition/unavailable injection (`#1925`, `#1929`,
  `#1931`).

### Added — trusted conversation plane (envelope v1, C1–C6)

- `conversation-envelope.v1` contract frozen and split into child slices
  (`#1861`, `#1867`), then implemented as a broker core domain with an
  inbox/reply loop and HTTP surface (`#1868`, `#1870`), additive
  `conversation:*` peer scopes (`#1869`), cross-broker relay and worker↔worker
  routing (`#1871`, `#1875`), mirror consume with ack lineage sync (`#1876`),
  worker message signatures (`#1874`), a task↔conversation bridge (`#1873`),
  and delivery clarity for offline/stale/busy recipients (`#1872`).
- Real two-broker topology with a conversation-plane loopback E2E and operator
  runbook (`#1877`).

### Added — Piri analysis/patch bridge and container fanout lane

- Piri analysis bridge with an in-harness schema lock and `--progress-file`
  wiring, plus harness progress carried in task heartbeats and used for task
  staleness (`#1745`, `#1751`, `#1753`, `#1760`, `#1801`).
- Host Piri GitHub patch bridge (`#1887`), runner-owned PR evidence with a
  transcript-derived sub-agent report (`#1856`), and an opt-in native exec mode
  with hardened boundaries (`#1900`, `#1901`).
- Piri fanout, spec-first through WS1–WS5: mirrored per-lane opt-in flag,
  hardened sub-agent extension baked into the image, command-script wiring with
  tool/budget advertising, and a bare-JSON evidence extractor (`#1836`,
  `#1839`, `#1841`, `#1844`, `#1846`).
- Bounded output-schema retry reason enum and bounded execution telemetry on
  bridge failure records (`#1847`, `#1849`, `#1851`), and opt-in host memory
  snapshot injection for the Piri lane (`#1890`, `#1892`).

### Added — A2A spec conformance (`#1912`) and wave-plan DAG v2

- Spec-path `ListTasks` hardening: strict spec-vocabulary filters, bounded
  pagination with scope-bound cursors, artifact elision behind
  `includeArtifacts`, and status-timestamp ordering, pinned by a conformance
  test (`#1916`, `#1998`–`#2000`, `#2004`).
- Agent card and protocol surface: `protocolVersion` per `AgentInterface`, a
  declared edge-secret auth scheme, a typed signed wire shape, per-task SSE
  `A2A-Version` negotiation, and rejection of an undeclared tenant instead of
  ignoring it (`#1915`, `#1917`, `#1922`–`#1924`).
- `WavePlanDagV2`: runtime admission with deterministic dry-run, record-only
  observation mode, a versioned dispatch-boundary classifier, a
  rehearsal-evidence store, and broker wiring with read-only evidence routes
  (`#1800`, `#1992`–`#1996`).
- `TaskAttemptRecordV1` runtime producer with a durable store (default-off) and
  advisory views feeding a dispatcher preflight read path (`#1883`, `#1918`).

### Added — signed web retrieval, skills intake, and worker observability

- Signed web-retrieval snapshot gateway, spec packet then slice (`#2018`,
  `#2022`).
- `skills.skill-intake-review.v1` and `skills_intake_revise` specs with
  deterministic conformance checkers, review-provenance verdict fields, and the
  A2A verdict as the final promotion gate (`#2008`, `#2009`, `#2014`, `#2015`,
  `#2029`, `#2031`, `#2034`, `#2035`).
- Resource-aware worker onboarding evaluated at registration (`#1789`),
  implementation capability projected on `/workers/capacity` (`#1792`),
  advisory per-worker latency profiles behind a `/stats/workers` route
  (`#2036`), observable 401/unauthorized rejections (`#1767`), an observable
  idempotent `POST /tasks` marker (`#2026`), and a weekly watchdog surfacing
  default-branch workflow-run redness (`#1821`).
- Symmetric T2-origin→T1-child cross-broker handoff (`#1812`).

### Changed — provenance, retention, and hot-path performance

- The broker image owns its provenance and bakes `image.tag` so it tracks the
  verified revision; a claimed build revision that does not match the built
  tree now fails closed (`#1770`, `#1773`, `#1775`). An unreadable canonical
  mirror degrades `/health` instead of returning 500, and an oversized
  canonical snapshot is repaired instead of dead-ending (`#1765`, `#1777`).
- The prune path now enforces the terminal-task byte budget (`#1769`).
- Hot-path cost cuts across broker, storage, runner, and the CI gate
  (`#1988`), plus a batch of 24 code-review findings (`#1987`).

### Removed — retired ceremony, dead modules, and the OpenClaw plugin package

- The staged monorepo migration ceremony was retired rather than maintained:
  16 validators, 17 npm aliases, 17 release-gate inventory steps, 16 registry
  checks, 16 fixtures and 14 history documents (`#1779`). **Breaking for local
  workflows:** `npm run check:historical`, `check:monorepo-reentry`,
  `check:monorepo-import-rehearsal` and `check:monorepo-ci-parity` no longer
  exist. Round artifacts and unreachable broker/runner modules followed
  (`#1780`, `#1781`), and every surviving gate was made to actually run, with
  the two that had rotted repaired (`#1782`).
- The `openclaw-plugin-a2a` package was retired and the harness story made
  provider-neutral, with routing/scan references cleaned up in two passes
  (`#1783`, `#1820`, `#1823`).
- Terminal-brief sidecar HTTP routes and ceremony modules removed (`#1790`,
  `#1791`); the NCLEX evaluation domain, docker-runner mounts preflight,
  dynamic sub-agent runtime, sub-agent evidence finalization, worker
  metadata/analysis-probe cluster, HTTP-signature cluster, env parsing,
  external-handler errors, task-handler factories and the broker worker client
  were all extracted out of `worker.ts` into their own modules (`#1601`,
  `#1826`–`#1828`, `#1831`, `#1835`, `#1838`, `#1840`, `#1842`, `#1843`,
  `#1845`, `#1848`).

### Fixed — security and correctness

- Bounded the attestation redaction-marker probe to stop a polynomial ReDoS
  (`#1756`), and made card-signature verification check **any** signature
  rather than only `signatures[0]` (`#1920`).
- Kept Piri credentials out of task artifacts (`#1806`); removed a dead
  gitleaks path allowlist in favour of single-sourced exact fixtures
  (`#1991`).
- Analysis-bridge honesty: the adapter label follows the resolved bridge
  command over env hints, the A/B evaluator cross-checks the executed binary
  against the label, readiness degrades when adapter metadata contradicts the
  handler path, and the payload-carrier contract fails closed (`#1896`–`#1898`,
  `#2025`).
- Unmapped broker error codes are answered instead of hanging the request
  (`#1793`); byte-capped bridge inputs are cut on UTF-8 character boundaries
  (`#2006`); Piri progress absorption is bounded to the task's own session
  (`#2012`); negative-verdict evidence is preserved on `review_verdict_failed`
  (`#1878`).
- Dependency and supply-chain bumps: `fast-uri` override for dependabot alert
  #3 then `3.1.7` (`#1850`, `#2037`), `zod` `4.5.2` (`#2032`), and periodic
  GitHub Actions group bumps (`#1811`, `#1879`, `#1986`, `#2033`).

### Added — documentation and governance

- Repository health metrics definition (`#1762`), branch-protection docs
  aligned with the enforced ruleset including the PUT hazard (`#1758`), a
  designated backup reviewer on every CODEOWNERS path (`#1759`), corrected
  mirror-repo claims — archived and private, not active (`#1784`), the hybrid
  model-tier policy decision for the implementation lane (`#2001`), and
  per-file peer-coverage opt-ins with a stated reason (`#1837`).

## v0.1.0-alpha — 2026-07-05

Status: **release candidate prepared for operator-approved tag/release**. This entry is the release-note source for the initial `v0.1.0-alpha` tag. npm, Docker/GHCR publication, repository visibility changes, production deployment, provider sends, and database/outbox mutations remain out of scope unless separately approved.

### Added — supply-chain hardening for CI workflows (#1228)

- Every GitHub Actions workflow now declares a minimal top-level `permissions:` block (OpenSSF Scorecard Token-Permissions); `ci.yml` defaults to `contents: read` with job-level widening only where needed. Enforced fail-closed by the core release-gate step `workflow-permissions` (`scripts/check-workflow-permissions.mjs`).
- CodeQL SAST workflow (`.github/workflows/codeql.yml`) scans `javascript-typescript` on every pull request, on `main` pushes, and weekly; findings surface as code-scanning alerts.
- External GitHub Actions references are pinned to full commit SHAs with source tag comments, enforced by the core `workflow-action-pinning` gate (`scripts/check-workflow-action-pinning.mjs`).

### Changed — docker-runner trusted-lane defaults (behavior change, #1204/#1209)

- The trusted-operator default network dropped from `host` to `bridge`. Untrusted lanes keep `none`. Trusted workers that relied on host networking must opt in explicitly with `A2A_DOCKER_RUNNER_NETWORK=host`.
- Trusted lanes now default to a read-only root filesystem (`--read-only` plus a bounded `noexec,nosuid` `/tmp` tmpfs) and a non-root container user (`--user 1000:1000`). Escape hatches: `A2A_DOCKER_RUNNER_READ_ONLY_ROOTFS=0`, `A2A_DOCKER_RUNNER_USER=root`. Full matrix and migration note: [`packages/docker-runner/docs/trusted-operator-hardening.md`](packages/docker-runner/docs/trusted-operator-hardening.md).

### Added — broker runtime robustness (#1204)

- Broker entrypoint installs `unhandledRejection`/`uncaughtException` handlers with structured logging and graceful-shutdown reuse.
- Process-local security limits (replay cache, rate limiter) are documented in [`packages/broker/docs/process-local-security-limits.md`](packages/broker/docs/process-local-security-limits.md); restarts reset both and horizontal scaling needs a shared store.

### Included scope

- Sanitized A2A Nexus workspace layout for broker, adapter plugin, Docker runner, shared contracts, examples, and public-safe documentation.
- Integrated local/CI release gate through `npm run check`, including layout checks, package-local checks, public-readiness scan, and compatibility-baseline validation.
- Public-safe quickstart, canonical demo, known limitations, security policy, issue templates, and release-gate documentation.
- Compatibility contracts for task lifecycle, terminal semantics, worker registration/read-model assumptions, and broker-to-broker handoff boundaries.
- Acceptance contracts, Definition-of-Ready linting, scope-drift/readback guardrails, and terminal evidence semantics used to keep delegated work reviewable before merge.
- Round quality and evidence scorecard gates, including weak-dialectic health signals and source-projection/readback checks for A2A/A2AD review lanes.
- Release evidence paths for redacted public-readiness and external secret/history scan disposition.

### Required pre-tag evidence

- GitHub Actions `ci` workflow passes on the exact release candidate commit.
- `npm ci --ignore-scripts --include=dev` passes from a clean checkout.
- `npm run check` passes from the same checkout.
- `npm run scan:public-readiness` passes with no runtime/bootstrap or secret-shaped findings.
- `npm run scan:external-secrets` passes with a supported scanner, or an operator records explicit fail-closed Block evidence.
- Clone smoke validates the public-safe quickstart/docs from a fresh checkout with no private configuration copied in.

### Operator decision points

- Choose the tag name: `v0.1.0-alpha` for the first promotion candidate, or `v0.1.0` only after the operator decides the repository is public/release ready.
- Explicitly approve any repository visibility change separately from tag/release creation.
- Keep npm/Docker publication out of scope unless a later operator approval names those artifacts and registries.
