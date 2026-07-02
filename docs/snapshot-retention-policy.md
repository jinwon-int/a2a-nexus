# Snapshot & Validation-Packet Retention Policy

> **Status:** policy (advisory). This document defines *when* point-in-time
> migration snapshots and frozen validation packets may be retired. It does not
> itself remove any file or gate.
> **Owner surface:** `a2a-nexus` release-gate maintainers.
> **Related:** [`docs/current-state.md`](current-state.md), `scripts/release-gate.mjs`, [#577](https://github.com/jinwon-int/a2a-nexus/issues/577).

## Why this policy exists

The root release gate (`npm run release-gate` → `scripts/release-gate.mjs`)
runs 32 steps. **19 of them** are `check:monorepo-*` /
`check:current-state-*` steps that validate frozen point-in-time artifacts
from the monorepo-split migration (`a2a-plane#506` → `a2a-nexus#553`):

- **`fixtures/current-state/*.json`** — 18 JSON snapshots, each freezing the
  approved state of one migration phase so the gate fails if the live tree
  drifts from an operator-approved decision.
- **`docs/validation/*.md`** — 64 frozen session acceptance packets. Most are
  narrative evidence and are *not* wired into any gate; a small number are
  referenced by `*.test.mjs` release-gate tests.

This was the right shape *during* the migration: each phase needed a tamper-
evident record that later phases could not silently regress. But the migration
has now reached its terminal source-state invariant
(`MONOREPO_PACKAGES_CANONICAL`, then `ACTIVE_PROVENANCE_MIRROR`). Once a phase
is superseded, its snapshot keeps gating CI without protecting any live
behavior — the gate becomes dominated by historical milestones. This policy
defines the criteria and process for retiring those, **without ever weakening
live-behavior coverage**.

## Artifact classes

| Class | Location | Gated? | Purpose |
| --- | --- | --- | --- |
| Live-behavior gate | conformance/layout/packages/secrets/ack-boundary/routing checks | Yes — always | Protects runtime contracts. **Never retired by this policy.** |
| Migration-phase snapshot | `fixtures/current-state/*.json` + its `check:monorepo-*` step | Yes | Freezes one approved migration decision. Retirable once superseded. |
| Frozen validation packet | `docs/validation/*.md` | Mostly no | Narrative session evidence. Retirable once its phase closes. |

## Lifecycle states

Every migration-phase snapshot and validation packet is in exactly one state:

1. **Active-invariant** — asserts a guardrail that is *still currently true and
   load-bearing* (e.g. "packages are canonical", "split repos are
   active-provenance mirrors, not archived"). Keep.
2. **Superseded-milestone** — records a phase that a *later* snapshot now
   re-asserts at equal-or-stronger strength. Retirement candidate.
3. **Retired** — removed from the tree and from `release-gate.mjs`.

## Retention criteria

A migration-phase snapshot MAY move from **Superseded-milestone → Retired**
only when **all** of the following hold:

1. **Superseded.** A later snapshot (or a live-behavior gate) asserts the same
   invariant at equal-or-greater strength, so removing this one drops no
   guarantee. The terminal-state snapshots that still encode the *current*
   canonical/mirror invariant are **not** superseded and stay until the
   migration epic (#553) is formally closed.
2. **No live-behavior coverage.** The snapshot only checks the shape of a
   frozen JSON record — it does not exercise runtime, conformance, secret
   scanning, or contract behavior. (If a check does both, split the
   live-behavior assertion into a permanent gate *before* retiring the rest.)
3. **No inbound references.** `git grep` finds no remaining references to the
   fixture or doc from other gated scripts, tests, or `docs/current-state.md`
   narrative that would dangle on removal.
4. **Recorded supersession.** The superseding snapshot/issue is named in the
   retirement note, so provenance is preserved in history even after the file
   is gone.

A frozen `docs/validation/*.md` packet MAY be retired when its phase is closed
**and** it is not referenced by any release-gate test (criterion 3 above
applies to the `*.test.mjs` validators specifically).

A `fixtures/current-state` snapshot MUST stay (state **Active-invariant**) if
any of the following is true: it encodes the current canonical source state,
it encodes the current split-repo disposition, or its `NO_GO / Waiting` /
`HOLD` fields are the live guardrail blocking an execution-sensitive action
(release, publish, deploy, ownership transfer, Terminal ACK/replay, secret
movement). Retiring those would remove a real brake, not dead weight.

## Non-negotiable: live-behavior gates are never retired

This policy applies **only** to migration-phase snapshots and frozen
validation packets. The following stay in the release gate permanently and are
out of scope here: `check:layout`, `test:conformance`,
`check:packages`, `check:runner-import-smoke`,
`check:terminal-brief-routing`, `check:message-id-ack-boundary`,
`check:external-harness-conformance`, `scan:public-readiness`,
`scan:readiness-gates`, `scan:external-secrets`,
`check:compatibility-baselines`, and `check:repo-protection-baseline`.

## Retirement process

When a snapshot meets every retention criterion:

1. Remove the `fixtures/current-state/<name>.json` file (and its
   `docs/<name>.md` narrative if that doc exists only to describe the
   snapshot).
2. Remove the matching step from `scripts/release-gate.mjs` **and** the
   `check:monorepo-<name>` / `check:current-state-<name>` script from the root
   `package.json`.
3. Remove the `scripts/check-monorepo-<name>.mjs` checker.
4. `git grep` the removed `<name>` to confirm zero dangling references
   (including in `docs/current-state.md`); update that narrative if it pointed
   at the retired snapshot.
5. Run `npm run release-gate` and confirm the remaining steps pass.
6. In the commit/PR body, name the superseding snapshot or issue so the
   supersession chain stays auditable.

Retire in small, reviewable batches (one migration phase per PR), not in a
single sweep — the gate is the safety net and each removal should be
independently verifiable.

## Current classification (as of 2026-06-11)

This is a *snapshot of intent*, not an approval to delete. Each entry still
needs the four retention criteria re-checked at retirement time.

| Snapshot | Phase / issue | State | Rationale |
| --- | --- | --- | --- |
| `monorepo-actual-canonical-flip-execution-result` | #553 terminal | Active-invariant | Encodes the current `MONOREPO_PACKAGES_CANONICAL` source state. |
| `monorepo-active-provenance-mirror-execution-result` | #553 terminal | Active-invariant | Encodes the current `ACTIVE_PROVENANCE_MIRROR` disposition of the split repos. |
| `monorepo-split-repo-disposition-preflight` | #553 | Active-invariant | Holds the future disposition options as `HOLD` guardrails. |
| `monorepo-operator-approval-handoff` | #553 | Active-invariant | Records the live operator approval gating PR-first canonical planning. |
| `monorepo-branch-release-package-policy` | #517 | Active-invariant | Live brake on release/tag/publish/Docker until separate approval. |
| `monorepo-docs-routing` | #515 | Active-invariant | Live policy: keeps `agent-olympics` out of A2A routing; CODEOWNERS-bound. |
| `monorepo-final-operator-signoff-matrix` | #549 → #553 | Active-invariant | Current `GO_CANDIDATE` matrix; holds execution fields at `NO_GO / Waiting`. |
| `monorepo-canonical-source-flip-execution-handoff` | #553 | Active-invariant | Source-only handoff guardrail (records worker-beta dissent brake). |
| `monorepo-actual-canonical-flip-execution-preflight` | #553 | Superseded-milestone | Preflight for the flip whose *result* snapshot now asserts the stronger invariant. |
| `monorepo-canonical-flip-readiness` | #541 phase 5 | Superseded-milestone | Readiness packet superseded by the executed-flip result. |
| `monorepo-branch-protection-approval-packet` | #543 phase 6 | Superseded-milestone | Pre-flip proposal; superseded once protection policy is settled. |
| `monorepo-split-repo-disposition-rollback` | #545 phase 7 | Superseded-milestone | Pre-flip rollback owner packet; superseded by current disposition. |
| `monorepo-release-package-tag-approval-packet` | #547 phase 8 | Superseded-milestone | Dry-run approval packet; release fields still `NO_GO` — verify criterion 4 before retiring. |
| `monorepo-phase3-package-ci-gate` | #534 phase 3 | Superseded-milestone | Package-CI parity gate now enforced live by CI parity jobs. |
| `monorepo-ci-parity-matrix` | #514 | Superseded-milestone | Parity recorded; live parity jobs supersede the frozen matrix. |
| `monorepo-import-rehearsal` | #513/#530 | Superseded-milestone | Throwaway prefix-import rehearsal; superseded by the executed import. |
| `monorepo-reentry-decision` | #511 phase 0 | Superseded-milestone | Re-entry decision; the decision has been executed. |
| `no-live-integration-smoke` | #508 | Active-invariant | No-live cross-repo smoke is ongoing behavior coverage, not a one-off milestone. |

`docs/validation/*.md`: treat all 64 as **Frozen validation packet**. Retire a
packet only with its closing phase and only after confirming no `*.test.mjs`
release-gate test reads it.

## What this policy intentionally does not do

It does not retire anything by itself, it does not touch live-behavior gates,
and it does not authorize any execution-sensitive action. Retirements happen in
separate, reviewable PRs that each cite this policy and name the superseding
artifact.
