# Implementation Plan: Signed Web-Retrieval Snapshot Gateway

Status: source-only plan for #2017, spec at
`docs/specs/web-retrieval-snapshot-gateway/spec.md`. No runtime mode switch,
broker restart, provider canary, persisted schema migration, release,
visibility change, DB mutation, or live worker behavior change is approved by
this document.

## Linked spec

- Spec: `docs/specs/web-retrieval-snapshot-gateway/spec.md` (same PR)

## Size classification

- [ ] Small
- [x] Medium
- [ ] Large

Reason: cross-module (broker decision-dialectic + round-dispatch docs +
shared snapshot types) but reversible, single-repo, default-off, and no
approval-sensitive action is exercised.

## Affected repos/components

- `a2a-plane`: n/a
- `a2a-broker`: retrieval gateway module, dialectic round plumbing for
  snapshot injection + dedup labeling, manifest validation for the
  `retrieval` block
- `a2a-docker-runner`: none functionally — reuse of snapshot
  canonicalization/signing types only; no runner behavior change
- `openclaw-plugin-a2a`: none
- worker/node config: none in this slice (providers configured later behind
  separate approval)
- Wiki/runbooks: follow-up after implementation

## Broker / worker / finalizer roles

- Broker of record / finalizer: initiating broker (this lane), per the
  one-finalizer rule in `docs/a2a-constitution.md`
- Workers: none live in this slice; all validation is fixture/contract based
- Libero/validator: `npm run check` + focused package tests
- Human approval owner: fleet operator (only for the later live-provider
  canary slice, not this one)

## Execution lane

- [x] Direct small change (docs + module + fixtures, no live traffic)
- [ ] Isolated subagent
- [ ] Broker-owned TaskFlow
- [ ] TaskFlow + A2A evidence workers

Why this lane is safe: default-off feature, no container/worker changes, no
provider keys touched, CI runs fixtures only.

## Data / control flow

```
lane manifest (opt-in retrieval block)
  → broker validates allowlist/budget (fail-closed, same style as
    validateEgressAllowlistConfig)
  → retrieval queue (host-side; broker foreground never blocks)
  → provider adapter (search/scrape API; aggregator opt-in only)
  → a2a.retrieval.web.snapshot.v1 (canonicalized + signed; url/retrievedAt/
    contentHash/provider/requestQuery/bounded body)
  → snapshot store (dedup by url+hash)
  → lane receives snapshot refs + quoted untrusted data body
  → round evidence binds claims ↔ snapshot ids; shared citations across
    phases labeled as correlated
```

Boundaries: provider credentials stay host-side; task containers gain no new
network capability; broker foreground sessions only ever see brief status.

## Tests and validation

- Oracle independence / finalizer coverage review: corpus scoring reuses the
  existing A2AD rubric fixtures (`docs/specs/a2ad-reasoning-uplift/plan.md`
  shape); implementing lane does not grade itself.
- Red-to-green evidence for new gates: "unsigned web citation rejected" must
  fail on base tree, pass after change; captured in PR.
- Discovery inventory: n/a (no removal/cleanup).
- Follow-up issue materialization: (1) provider adapter + key handling slice,
  (2) first live retrieval canary (separately approved), (3) runbook/Wiki
  update. Each becomes an issue before this slice's closeout.
- Lane-to-PR mapping: one lane = one PR (this packet + module + fixtures).
- Unit tests: allowlist accept/deny (internal hosts, non-canonical host,
  port forms), budget denial classification, dedup id stability, snapshot
  signature verify/fail, injection-quoting contract string present in
  receiving prompt templates.
- Contract/conformance tests: manifest `retrieval` block schema round-trip in
  `scripts/a2a-dispatch-round.mjs` fixtures; dialectic round fixture with
  snapshot-bearing evidence.
- Build/lint/typecheck: `npm run check`.
- Dry-run/doctor checks: n/a for this slice.
- CI checks: standard repo CI; no live network in CI.
- Live canary, if separately approved: deferred to follow-up issue.

## Rollout plan

- Source PR order: this PR first (spec + module + fixtures, default-off).
- Merge/rehearsal order: merge when green; no deployment step in this slice.
- Deployment gate: any later activation on live brokers is a separate,
  operator-approved change.
- Communication/Terminal Brief expectations: none in this slice.

## Rollback plan

- Revert path: revert the single PR; feature is opt-in and default-off, so
  nothing depends on it at merge time.
- Config rollback: removing the manifest `retrieval` block disables the path
  per lane.
- State cleanup: snapshot store is append-only cache; pruning it later is a
  normal maintenance action, not part of rollback.
- Approval required before cleanup: none beyond normal review for the revert
  itself.

## Closeout evidence

- Finalizer decision: recorded on the implementing PR.
- Evidence links: CI run, red-to-green capture, fixtures list.
- Tests/checks: `npm run check` + focused package tests.
- Approval-sensitive actions not performed: deploy, restart, canary, provider
  key movement, DB mutation, release/tag.
- Wiki/runbook update: deferred to follow-up issue.
