# A2A Public Topology Decision Record

> **Decision date:** 2026-05-27
> **Status:** 🟢 Adopted — hold full monorepo consolidation; keep split implementation repos with `a2a-plane` as the stronger public umbrella/start-here entrypoint.
> **Tracking issue:** [#473](https://github.com/jinwon-int/a2a-plane/issues/473)
> **Revisit trigger:** See [re-entry criteria](#future-monorepo-re-entry-criteria) below.

---

## 1. Summary

The four A2A repositories (`a2a-plane`, `a2a-broker`, `a2a-docker-runner`, `openclaw-plugin-a2a`) are already GitHub-PUBLIC. The question is whether to consolidate them into a single public monorepo before broader promotion announcement/release work.

After inspecting historical closed monorepo work, current public surfaces across all four repos, and the open umbrella lanes, the concrete recommendation is:

> **Hold full monorepo consolidation for now. Keep split implementation repos as independent release/CI/boundary surfaces. Strengthen `a2a-plane` as the public umbrella / start-here entrypoint before broader promotion.**

This recommendation is documented here along with re-entry criteria for future reconsideration.

---

## 2. Historical Closed Monorepo Work

### [#240 — Monorepo consolidation review (closed)](https://github.com/jinwon-int/a2a-plane/issues/240)

Initial review of whether to merge the four repos into a single entrypoint. Produced:
- [`docs/ecosystem-guide.md`](../docs/ecosystem-guide.md) — bilingual component guide mapping the 4 repos to roles.
- [`docs/monorepo-migration-checklist.md`](../docs/monorepo-migration-checklist.md) — short/medium/long-term migration checklist with 12 acceptance gates and versioning strategy.

**Outcome:** Mapped the migration path but did not declare cutover. CI parity, import rehearsal, CODEOWNERS split, and operator sign-off were deferred.

### [#335 — A2A R23: monorepo plan (closed)](https://github.com/jinwon-int/a2a-plane/issues/335)

R23 execution parent that included "create a monorepo plan/proof" as one of five end-state goals. Cross-repo Terminal Brief and spec-first design were the higher priorities.

**Outcome:** Monorepo proof was scoped as one work stream among many; R23 did not finalize the cutover.

### [#337 — R23 Team1 cutover proof (closed)](https://github.com/jinwon-int/a2a-plane/issues/337)

Produced the detailed architecture/migration proof with package boundaries, versioning strategy, CI matrix, compatibility risks, and rollback plan. The proof is preserved in `docs/monorepo-migration-checklist.md`.

**Outcome:** Established acceptance gates (9/12 🟢, 3 🟡/🔴) but required operator sign-off before any cutover.

### Merged PRs from closed issues

| PR | Source issue | What it delivered |
| --- | --- | --- |
| [#267](https://github.com/jinwon-int/a2a-plane/pull/267) | #240 | Migration checklist (`docs/monorepo-migration-checklist.md`) |
| [#268](https://github.com/jinwon-int/a2a-plane/pull/268) | #240 | Ecosystem guide (`docs/ecosystem-guide.md`) |
| [#484](https://github.com/jinwon-int/a2a-plane/pull/484) | #477 | Public umbrella quickstart (`docs/quickstart/public-umbrella.md`) |

### Key takeaway from closed work

The historical monorepo work built the *migration path* and *cutover gates* but never reached cutover. The gates themselves reveal why: AG-8 (import rehearsal), AG-10 (docs migration), AG-11 (CODEOWNERS split), and AG-12 (operator sign-off) were all incomplete. The existing docs still frame monorepo as the eventual direction, which now contradicts the current decision to hold consolidation.

---

## 3. Current Public Topology

### Repository surfaces

| Repository | Visibility | Public since | Canonical boundary | Release/tag status |
| --- | --- | --- | --- | --- |
| [`a2a-plane`](https://github.com/jinwon-int/a2a-plane) | Public | 2026-05-11 | Umbrella docs, contracts, coordination, release gates | None published (npm `private: true`) |
| [`a2a-broker`](https://github.com/jinwon-int/a2a-broker) | Public | 2026-05-11 | Broker runtime, task lifecycle, worker registry | None published (npm `private: true`) |
| [`a2a-docker-runner`](https://github.com/jinwon-int/a2a-docker-runner) | Public | 2026-05-11 | Isolated container worker, artifact capture, PR/Done/Block evidence | None published (npm scoped, not published) |
| [`openclaw-plugin-a2a`](https://github.com/jinwon-int/openclaw-plugin-a2a) | Public | 2026-05-11 | OpenClaw Gateway adapter, diagnostics, wake/event bridge | None published (npm `private: true`) |

### Current CI surfaces

| Repository | CI system | Key workflows |
| --- | --- | --- |
| `a2a-plane` | GitHub Actions (integrated) | `ci.yml` — docs, layout, paths-filter, setup |
| `a2a-broker` | GitHub Actions (standalone) | Per-broker CI (test, lint, compatibility) |
| `a2a-docker-runner` | GitHub Actions (standalone) | Per-runner CI (test, build, container) |
| `openclaw-plugin-a2a` | GitHub Actions (standalone) | Per-plugin CI (test, lint) |

### Independent trust boundaries

- **Runner** owns isolated task execution, repository checkout, container hardening, artifact capture, and bootstrap/private-context leak guard. Its security model is container-level isolation — coupling it into a shared release train would increase compatibility risk.
- **Plugin** owns OpenClaw Gateway adapter behavior — Gateway config schema, message/status mapping, diagnostics, and event/wake bridge. Its release depends on OpenClaw peer compatibility.
- **Broker** owns the task lifecycle API, worker registry, and evidence collection — the core runtime that runner and plugin depend on.

### Current docs/gate tension

Several docs still describe private/NO-GO/public-readiness-candidate status even though all repos are already PUBLIC. This is tracked as [P0 blocker #476](https://github.com/jinwon-int/a2a-plane/issues/476). The topology decision should not be confused with the stale-private-docs reconciliation — they are related but independent work streams.

---

## 4. Decision: Hold Monorepo Consolidation

### Concrete recommendation

| Dimension | Decision |
| --- | --- |
| Repo layout | **Keep split.** 4 repos remain independent public surfaces. |
| Umbrella entrypoint | **Strengthen `a2a-plane`** as the start-here repo with repo map, issue routing, quickstarts, cross-repo coordination, and public-readiness gates. |
| Release boundaries | **Keep per-repo releases.** Runner closest to publishable shape; broker and plugin need more cleanup before first release. |
| CI surfaces | **Keep independent CI.** Each repo maintains its own GitHub Actions workflows. Cross-repo compatibility enforced by plane-level matrix baselines. |
| Import rehearsal | **Defer.** Not needed until monorepo consolidation is re-activated. |
| CODEOWNERS split | **Defer.** Not needed until monorepo consolidation is re-activated. |
| Monorepo-migration-checklist.md | **Preserve as historical reference.** Update to reflect current decision. |

### Reasoning

1. **Release maturity asymmetry.** The docker-runner is closest to a publishable package shape (scoped npm name, standalone CI, container build). Broker and plugin still need license/package/public-surface cleanup before any release claim. A monorepo merge would force all four onto one release train, increasing compatibility and provenance risk.

2. **Trust boundaries are real.** Runner and plugin have distinct security/operational profiles: runner owns container-level isolation, the plugin owns Gateway adapter behavior. Coupling them into one repo with shared CI/release gates creates a larger blast radius for failures.

3. **Cutover gates are incomplete.** 3 of 12 acceptance gates from the historical checklist remain incomplete: import rehearsal (AG-8 🔴), docs migration (AG-10 🟡), CODEOWNERS split (AG-11 🟡). AG-12 (operator sign-off) has not been granted. Forcing cutover now would skip these gates.

4. **The umbrella is working.** `a2a-plane` now has a public quickstart, repo map, ecosystem guide, issue routing, and compatibility baselines. External users can start from `a2a-plane` and be routed to the correct implementation repo. This satisfies the "single entrypoint" requirement without a full monorepo merge.

5. **No open PRs block either direction.** The current audit across all four repos found zero open PRs. There is no active migration work that would be disrupted by holding the split layout.

### What does not change

- All four repos remain PUBLIC.
- `a2a-plane` continues as the umbrella/coordination surface.
- Cross-repo compatibility baselines continue to be maintained in `docs/compatibility/`.
- Issues continue to be routed per the repo map in `docs/quickstart/public-umbrella.md`.
- No repo visibility, release/tag, npm/Docker publication, production deploy, or credential movement occurs as a result of this decision.

---

## 5. Future Monorepo Re-entry Criteria

Revisit full monorepo consolidation only when **all** of the following are satisfied:

| # | Criterion | Required evidence | Current status |
| --- | --- | --- | --- |
| RE-1 | **Split repos stable at a release baseline** | Each of broker, runner, and plugin has published a `1.0.0` or equivalent stable release with documented semver policy | 🔴 None published |
| RE-2 | **Operator-initiated** | Explicit operator approval comment on [#473](https://github.com/jinwon-int/a2a-plane/issues/473) or a follow-up tracking issue, not inferred from earlier direction | 🔴 Not granted |
| RE-3 | **Import rehearsal complete** | Dry-run log exists and is clean for all 3 legacy implementation repos → monorepo layout | 🔴 Not started |
| RE-4 | **Docs migration planned** | Migration of `docs/` from split-repo layout to monorepo layout is documented with redirect/backlink/archive plan | 🔴 Not started |
| RE-5 | **CODEOWNERS split defined** | Package-level CODEOWNERS entries are reviewed and accepted by all team leads | 🔴 Not started |
| RE-6 | **CI parity proven** | Cross-repo CI from monorepo matches or exceeds per-repo CI coverage, verified by side-by-side run | 🔴 Not started |

Until all six are 🟢, the recommendation remains: keep split repos with `a2a-plane` as the stronger public umbrella.

### Change management

If a re-entry criterion is triggered and an operator initiates the monorepo discussion:

1. The `docs/monorepo-migration-checklist.md` should be revived as the canonical migration plan.
2. A new tracking issue should be opened (not reopened from #240, which is closed).
3. The cutover should proceed through the 12 acceptance gates from the checklist.
4. AG-12 (operator sign-off) must be the final gate before any visibility change or canonical-source declaration.

---

## 6. Follow-up Issue Map

The topology decision feeds into the following active lanes:

| Issue | Repo | Description | Dependency |
| --- | --- | --- | --- |
| [#476](https://github.com/jinwon-int/a2a-plane/issues/476) | `a2a-plane` | P0: reconcile stale private/NO-GO readiness docs with actual public visibility | Independent |
| [#477](https://github.com/jinwon-int/a2a-plane/issues/477) | `a2a-plane` | Public repo map and quickstart umbrella docs | 🟢 Merged via #484 |
| [#478](https://github.com/jinwon-int/a2a-plane/issues/478) | `a2a-plane` | Public-source security, secret-history, license, and provenance scan | Independent |
| [#479](https://github.com/jinwon-int/a2a-plane/issues/479) | `a2a-plane` | Public release, version, and provenance checklist | Independent |
| [#480](https://github.com/jinwon-int/a2a-plane/issues/480) | `a2a-plane` | Local public demo and quickstart across repos | Independent |
| [#482](https://github.com/jinwon-int/a2a-plane/issues/482) | `a2a-plane` | Refresh public compatibility matrix baselines | Independent |
| [#485](https://github.com/jinwon-int/a2a-plane/issues/485) | `a2a-docker-runner` | Lock release/tag workflow behind approval gates | Independent |
| [#486](https://github.com/jinwon-int/a2a-plane/issues/486) | `a2a-broker`/`openclaw-plugin-a2a` | Harden public contribution surface and CI gates | Independent |
| [#488](https://github.com/jinwon-int/a2a-plane/issues/488) | `a2a-plane` | Establish public repo protection baseline | Independent |

Cross-repo related issues that are not blocked by this decision:

| Issue | Repo | Description |
| --- | --- | --- |
| [`a2a-broker#951`](https://github.com/jinwon-int/a2a-broker/issues/951) | `a2a-broker` | Broker compatibility drift |
| [`a2a-broker#952`](https://github.com/jinwon-int/a2a-broker/issues/952) | `a2a-broker` | Signed AgentCard / trust metadata |
| [`openclaw-plugin-a2a#454`](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/454) | `openclaw-plugin-a2a` | Protocol-profile diagnostics |
| [`a2a-docker-runner#343`](https://github.com/jinwon-int/a2a-docker-runner/issues/343) | `a2a-docker-runner` | Go/Java evidence path |

---

## 7. Safety Boundary

This document is a **decision record only**. It does not authorize:

- Repository visibility changes
- Production deploy, Gateway/broker/worker restart or reload
- Live provider, Telegram, or notification sends
- Production database, queue, or terminal-outbox mutation
- Release tags, GitHub Releases, npm/Docker publication
- Secret rotation, credential movement, or raw secret evidence
- Destructive history rewrite or force push
- PR merge or issue close

No approval-gated action was performed in producing this document.

---

## References

- [#240](https://github.com/jinwon-int/a2a-plane/issues/240) — initial monorepo consolidation review (closed)
- [#335](https://github.com/jinwon-int/a2a-plane/issues/335) — R23 monorepo architecture plan (closed)
- [#337](https://github.com/jinwon-int/a2a-plane/issues/337) — R23 Team1 monorepo cutover proof (closed)
- [#473](https://github.com/jinwon-int/a2a-plane/issues/473) — current topology decision tracker (open)
- [#489](https://github.com/jinwon-int/a2a-plane/issues/489) — Team1 roadmap implementation parent (open)
- [`docs/monorepo-migration-checklist.md`](monorepo-migration-checklist.md) — historical migration checklist and cutover proof (preserved)
- [`docs/ecosystem-guide.md`](ecosystem-guide.md) — bilingual component guide with repo role mapping
- [`docs/quickstart/public-umbrella.md`](quickstart/public-umbrella.md) — public umbrella and repo map
- [`README.md`](../README.md) — current source entrypoint with #473 reference
