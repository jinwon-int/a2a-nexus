# Spin-off Packaging and Repository-Extraction Decision Record

> **Decision date:** 2026-10-29 (measured on `main` at `30832157`)
> **Status:** Accepted — owner readback 2026-10-29 (see [§6](#6-owner-decisions-2026-10-29)); revised the same day after an independent review added missing operational paths to §2.1 and §3. Documentation only.
> **Tracking issue:** [#2454](https://github.com/jinwon-int/a2a-nexus/issues/2454). Parent epic: [#1601](https://github.com/jinwon-int/a2a-nexus/issues/1601) (principle: *modularize-first, extract-second*).
> **Related:** [#1518](https://github.com/jinwon-int/a2a-nexus/issues/1518) (bounded PR review lifecycle), [#1480](https://github.com/jinwon-int/a2a-nexus/issues/1480) (policy-referee candidate), [#2453](https://github.com/jinwon-int/a2a-nexus/issues/2453) (core/ domain split; sequencing in §6), [product boundaries and extraction contract](product-boundaries.md), [core-slimdown first slice](specs/core-slimdown-first-slice/spec.md) (the `packages/nclex-evaluation` move recipe).
> **Revisit trigger:** see [Revisit triggers](#5-revisit-triggers). **Packaging move:** [#2477](https://github.com/jinwon-int/a2a-nexus/issues/2477).

This record does not move code, create repositories, publish packages, flip
`private`, tag, release, deploy, restart brokers or workers, or change live
review-lineage mode. The packaging move it recommends is a separate follow-up PR.

---

## 1. Summary verdict

| Question | Verdict |
|---|---|
| Split `packages/broker/src/review-lifecycle/` into its own `packages/*` workspace? | **Yes, as a follow-up PR.** Proposed boundary: `packages/review-lifecycle`, package `a2a-review-lifecycle` (private, `0.1.0`). It already has zero outbound imports into the broker, so the move is mechanical and follows the `packages/nclex-evaluation` precedent (#1827). |
| Extract `a2a-policy-referee` to its own repository? | **No, not now.** |
| Extract `a2a-attestation` to its own repository? | **No, not now.** |
| Extract bounded-review-lifecycle to its own repository? | **No, not now.** It is not even a workspace package yet (stage 1 is still pending). |
| Follow-up extraction issues to open | **None.** No candidate meets the "confirmed independent release demand" criterion. |

Why no extraction: none of the three candidates has a confirmed outside
consumer, none has ever had a release independent of the monorepo, and all of
them still change in the same commits as the broker. The broker also imports
all three at runtime. Under the [boundary rule](product-boundaries.md#boundary-rule),
Nexus core must not depend on a feature repository's runtime, so extracting any
of them today would either break that rule or force a fork maintained in two
places. The cross-repo CI and release cost would be paid with nothing gained.

---

## 2. Measurements

All commands run from the repository root on `30832157`. Numbers are
reproducible with the commands shown.

### 2.1 `packages/broker/src/review-lifecycle/`

```sh
R=packages/broker/src/review-lifecycle
NT=$(ls $R/*.ts | grep -v '\.test\.ts$')
ls $R | wc -l                                  # 37 files
ls $R/*.test.ts | wc -l                        # 16 test files (=> 21 non-test)
cat $NT | wc -l                                # 5966 non-test LOC
cat $R/*.test.ts | wc -l                       # 4237 test LOC
grep -nE "from ['\"]\.\./" $R/*.ts | wc -l     # 0 parent-relative imports (all 37 files)
grep -hoE "from ['\"][^'\"]+['\"]" $NT | grep -v "from \"\./" | sort | uniq -c
cat $NT | grep -cE '^export '                  # 176 top-level export declarations
grep -lE "from .(\./|(\.\./)+)review-lifecycle/" -r packages/broker/src --include=*.ts | grep -v "^$R/"
grep -rnE "review-lifecycle/" packages/broker/scripts scripts test --include=*.mjs --include=*.json
git log --oneline -- $R | wc -l                # 16 commits since eb8e418e (2026-07-20, #1584)
```

| Metric | Value |
|---|---|
| Files | 37 (21 non-test, 16 test) |
| Non-test LOC | 5,966 (largest: `scorecard.ts` 1,153, `observation.ts` 1,114) |
| Test LOC | 4,237 |
| Outbound imports into the broker (`../`) | **0** (verified in all 37 files) |
| External modules (non-test) | `zod` (`appeal.ts`, `patch-candidate.ts`, `simulation-fixture.ts`), `node:crypto`, `node:util`; `node:fs`/`node:path`/`node:url` only in `scorecard-cli.ts` |
| Exported surface | 176 top-level `export` declarations across 21 modules, **no duplicate names** (so a single `export *` barrel works). 32 distinct symbols are used by broker production code. |
| Wire contracts | Four core contract kinds (`IntentContractV1`, `ReviewLineageBudgetV1`, `FindingLedgerV1`, `ReviewReceiptV1`) plus the observation record, with five JSON Schemas in [`docs/specs/bounded-pr-review-lifecycle/schemas/`](specs/bounded-pr-review-lifecycle/schemas/), plus 15 `a2a.*.v1` schema ids in code (`a2a.review-lineage.v1`, `a2a.review-lineage-observation.v1`, `a2a.review-lineage-source-carrier.v1`, `a2a.review-lineage-producer-fact.v1`, `a2a.review-lineage-scorecard-*.v1`, `a2a.review-lineage-retention-*.v1`, `a2a.review-lineage.enforcement-decision.v1`, `a2a.intent-hash-assessment.v1`, …) |
| CLI | `scorecard-cli.ts`. An operator runs it as `node packages/broker/dist/review-lifecycle/scorecard-cli.js` ([operators.md](operators.md)). The owner-approved run on [#2274](https://github.com/jinwon-int/a2a-nexus/issues/2274) (OPEN, approval 2026-10-22) names this exact path. The broker `build` does not clean `dist` (`clean:dist` is a separate script), so after a move the old path keeps running **stale** code without an error. |
| Fixtures | Repo-root `fixtures/review-lifecycle/`, reached from `enforcement.test.ts` and `simulation-fixture.test.ts` through a path relative to `import.meta.url` |
| Change coupling | 16 commits; 10 of them also touched other `packages/broker/` files. 14 of the 16 landed 2026-07-20…07-28; only 2 since 2026-08-01. |

**Inbound importers (module imports): 11 production, 10 test files, all in `packages/broker/src`:**

- Production: `core/broker.ts`, `core/review-lineage-observation-store.ts`, `core/review-lineage-producer-admission.ts`, `core/review-lineage-store.ts`, `core/sqlite-worker-thread-persistence.ts`, `core/sqlite-worker.ts`, `core/store-contracts.ts`, `core/store.ts`, `http/review-lineage-routes.ts`, `retrieval/snapshot.ts` (only `canonicalize`/`sha256Hex`), `workers/review-report-producer.ts`.
- Test: `core/correction-generation-source-integration.test.ts`, `core/reviewer-replacement-source-integration.test.ts`, `core/review-lineage-observation-store.test.ts`, `core/review-lineage-producer-admission.test.ts`, `core/review-lineage-production-integration.test.ts`, `core/review-lineage-store.test.ts`, `core/review-report-source-integration.test.ts`, `http/review-lineage-routes.test.ts`, `server-review-lineage-review-report.test.ts`, `workers/review-report-producer.test.ts`.

**References by path or dist (not module imports), which the move must update:**
`packages/broker/scripts/a2a-task-handler.test.mjs` (dynamic import of
`../dist/review-lifecycle/review-report-source.js`),
`packages/broker/scripts/piri-a2a-analysis-bridge.test.mjs` and
`scripts/lib/review-lineage-client.test.mjs` (read `types.ts` as text),
`packages/broker/scripts/test-manifest.json` (`dist/review-lifecycle/*.test.js`),
`packages/broker/scripts/npm-scripts-inventory.test.mjs` (asserts the
`dist/review-lifecycle/*.test.js` command literally, so the move PR fails
until it is updated), `packages/broker/fixtures/review-lineage-scorecard/`,
the source paths quoted in `fixtures/review-lifecycle/README.md` and
`docs/specs/bounded-pr-review-lifecycle/observation-v1.md`,
and comment-only mentions in `core/store-schemas.ts`, `retrieval/snapshot.ts`,
`scripts/lib/review-lineage-client.mjs`, and `scripts/lib/nclex-lineage-spec.mjs`.

### 2.2 `packages/policy-referee` and `packages/attestation`

```sh
for p in policy-referee attestation; do
  find packages/$p/src -name '*.ts' ! -name '*.test.ts' | xargs cat | wc -l
  find packages/$p/src -name '*.test.ts' | xargs cat | wc -l
  git log --oneline -- packages/$p | wc -l
  git log --oneline --invert-grep --grep='^deps:' -- packages/$p | wc -l
done
grep -rlE "from ['\"]a2a-policy-referee['\"]" --include=*.ts --include=*.mjs packages scripts test | grep -v /dist/
grep -rlE "from ['\"]a2a-attestation['\"]|import\(['\"]a2a-attestation['\"]\)" --include=*.ts --include=*.mjs packages scripts test | grep -v /dist/
git log --format=%h -S'"version": "0.1.0"' -- packages/policy-referee/package.json packages/attestation/package.json
npm view a2a-policy-referee name version   # E404: never published
npm view a2a-attestation name version      # E404: never published
gh search code a2a-policy-referee --owner jinwon-int   # read-only; outside a2a-nexus: wiki/skill docs only
gh search code a2a-attestation --owner jinwon-int      # read-only; outside a2a-nexus: wiki docs only
```

| Metric | `a2a-policy-referee` | `a2a-attestation` |
|---|---|---|
| Created | 2026-07-23, `7b755d8d` (#1613, #1601 P1) | 2026-07-23, `0f452f39` (#1615, #1601 P2) |
| Non-test / test LOC | 858 (4 files) / 1,033 (3 files) | 2,521 (14 files) / 1,374 (8 files) |
| `package.json` | `version 0.1.0`, `private: true`, no `publishConfig`, `exports "."`, `bin a2a-policy-referee` | `version 0.1.0`, `private: true`, no `publishConfig`, `exports "."`, no bin |
| Runtime dependencies | none (node built-ins only) | none (node built-ins only) |
| Version history | `0.1.0` since creation; never bumped | `0.1.0` since creation; never bumped |
| In-repo consumers | `packages/broker` (16 files, exact pin `"a2a-policy-referee": "0.1.0"`) plus the package's own external-consumer example | `packages/broker` (40 files, exact pin `0.1.0`), `packages/nclex-evaluation` (2 files), `scripts/check-dist-import-resolution.test.mjs`, `scripts/verify-analysis-report.test.mjs` |
| Commits on dir (excluding `deps:` bumps) | 11 (8); 5 of the 8 also changed other `packages/broker/` files | 14 (11); 8 of the 11 also changed other `packages/broker/` files |
| Co-change caveat | The numerators include the extraction commit itself (`7b755d8d`) and two repo-wide sweeps that touched both packages (`449c149c` TAP pin, `627d2b59` #1987), so they overstate coupling; the verdict does not depend on them. | Same: extraction commit `0f452f39` plus the same two sweeps. (The review-lifecycle count in §2.1 likewise includes the 89-file sweep `8bd8631e`, #1619.) |
| Last non-dependency change | 2026-09-24 (`8b3b0f7c`, #2253, a broker refactor that touched the package) | 2026-10-03 (`b73473b9`, #2309, shared redactor adopted by the broker) |
| External consumers / independent release cadence | None found: no npm publication, no tags or releases, no publish workflow in `.github/workflows/`, no mention in [external-listings.md](external-listings.md) or [ecosystem-guide.md](ecosystem-guide.md), CHANGELOG mentions only as part of the monorepo. The code search is best-effort (index coverage needs confirmation). | Same: none found |

### 2.3 How CI builds the packages today

- `npm run check:packages` ([`scripts/check-packages.mjs`](../scripts/check-packages.mjs)) requires every `packages/*` manifest to be `private: true` "until explicit package-publication approval". It checks the `repository`, `homepage`, and `bugs` fields, rejects `npx` in scripts, and enforces a runtime-dependency allowlist (`zod` plus the in-repo workspaces). It then runs one `tsc -b tsconfig.json` solution build over broker, policy-referee, attestation, and nclex-evaluation, which are composite project references.
- `npm run check:layout` ([`scripts/check-layout.mjs`](../scripts/check-layout.mjs)) checks only that the required top-level paths exist (`packages/broker`, `packages/docker-runner`, `contracts/*`, `docs`, `examples`, `tsconfig.base.json`).
- `.github/workflows/ci.yml` has path-filtered `policy-referee` and `attestation` jobs that run `node scripts/run-monorepo-package-ci-parity.mjs <pkg>` (test plus `coverage:baseline`). The broker job also runs when either package changes, because the broker compiles against them.
- `packages/broker/Dockerfile` copies and `npm ci`s each workspace that the broker depends on (`-w packages/policy-referee -w packages/attestation -w packages/nclex-evaluation`).

---

## 3. Decision 1 — `packages/*` split for bounded-review-lifecycle

### 3.1 Verdict: split (follow-up PR)

Reasons:

1. **The boundary already exists in source.** There are zero `../` imports, and the only third-party dependency is `zod`, which is already on the allowlist. The broker uses 32 of the 176 exported symbols.
2. **It completes stage 1 of #1601 for the third named candidate.** policy-referee and attestation went through the same step in July. The nclex-evaluation move (#1827) proved the recipe for code that already had live broker importers.
3. **The compiler enforces the boundary.** A composite package with `rootDir: src` and no reference back to the broker cannot import broker internals without a compile failure. Today a new `../core/...` import inside `review-lifecycle/` would compile silently.
4. **It is cheap and behavior-preserving.** The move changes no contract, schema id, persisted shape, or HTTP route. The broker test suite and the package's own tests must pass unchanged.

Costs we accept: one more CI job, one more `Dockerfile` workspace line (this changes the image, so building and deploying it follows the normal approval path), and import-path churn in 11 production and 10 test broker files.

**Worker artifacts are affected too, not only the image.** The worker entry point reaches this code statically: `worker.ts` → `workers/external-handler.ts` → `workers/broker-worker-client.ts` → `workers/review-report-producer.ts` → review-lifecycle. A worker host that syncs only `packages/broker/dist` would fail at start with `ERR_MODULE_NOT_FOUND` once the code lives in a separate workspace. Worker rollout must use `worker-artifact-pack` and the rollout guard's `--deployed` workspace-dependency-exports check, under a separate deploy approval.

### 3.2 Proposed boundary

| Item | Proposal |
|---|---|
| Directory | `packages/review-lifecycle/` |
| Package name | `a2a-review-lifecycle`. This follows the unscoped `a2a-<name>` convention of the sibling workspaces. Scoped rename or publication is not approved. |
| Manifest | `version: "0.1.0"`, `private: true`, `type: module`, `license: MIT`, the `repository`/`homepage`/`bugs` fields required by `check-packages.mjs`, `engines.node >=22.5`, `dependencies: { "zod": <same range as broker> }`, `files: ["dist","scripts","README.md","package.json"]` |
| Exported entrypoints | One root export `"."`, which is a `src/index.ts` barrel doing `export *` over the 20 library modules. The no-collision check was verified (§2.1). No subpath exports at first. If tree-shaking or the size of the public surface becomes a concern, subpaths can be added later without breaking the root. |
| CLI | `scorecard-cli.ts` moves with the package. **Owner decision (§6): no `bin`;** the documented path becomes `node packages/review-lifecycle/dist/scorecard-cli.js`, and the move PR updates the #2274 command and documents removing the stale broker `dist/review-lifecycle/`. |
| What moves | All 21 non-test modules and 16 tests in `packages/broker/src/review-lifecycle/` (`git mv`, so history is kept). |
| What stays in the broker | Persistence and transport adapters (this rules out the `src/review-lifecycle/` option for `review-lineage-*` in the #2453 analysis; the owner placed them in the store domain): `core/review-lineage-store.ts`, `core/review-lineage-observation-store.ts`, `core/review-lineage-producer-admission.ts`, the SQLite worker/store wiring, `http/review-lineage-routes.ts`, `workers/review-report-producer.ts`, the `A2A_REVIEW_LINEAGE_MODE` rollout resolver, and all integration tests that need a broker. #2453 decides how those modules sit inside `core/`. This decision does not change them. |
| Fixtures and specs | `fixtures/review-lifecycle/` and `docs/specs/bounded-pr-review-lifecycle/` stay at their current repo paths. The two fixture-reading tests change their relative URL depth (`../../../../fixtures` becomes `../../../fixtures`). |
| `retrieval/snapshot.ts` | Keeps using `canonicalize`/`sha256Hex`, now imported from `a2a-review-lifecycle`. Moving that sorted-keys canonicalizer elsewhere is **out of scope**: its bytes must stay identical to what existing signed snapshots label. Note it is not the same algorithm as `a2a-attestation`'s RFC 8785 `canonicalizeJson`, so merging the two would change bytes. |

### 3.3 Version contract

- **Package version:** a workspace `0.x` that the broker pins exactly (`"a2a-review-lifecycle": "0.1.0"`), the same as the siblings. While `private: true`, the package version is not a compatibility signal. It changes only together with a publication decision.
- **Wire contract:** the compatibility unit is the schema id and kind tag (`a2a.review-lineage*.v1`, `a2a.intent-hash-assessment.v1`, `IntentContractV1`/`ReviewLineageBudgetV1`/`FindingLedgerV1`/`ReviewReceiptV1`) plus the JSON Schemas under `docs/specs/bounded-pr-review-lifecycle/schemas/`. A breaking wire change adds a `.v2` id next to `.v1`. A `.v1` shape is never changed in place, because broker SQLite rows and signed artifacts already carry `.v1`.
- **Canonical bytes:** `canonical-json.ts` output (used for `intentHash`, finding signatures, and retrieval snapshots) is part of the contract. The move must not change it.

### 3.4 Migration plan (one follow-up PR, `Refs #2454`)

1. `git mv packages/broker/src/review-lifecycle packages/review-lifecycle/src`. Add `index.ts`, `package.json`, a composite `tsconfig.json` (`rootDir: src`, `outDir: dist`, `declaration`, `composite`), `README.md`, and a package-local `scripts/coverage-baseline-report.mjs` copied from the sibling pattern. Package-local scripts are not counted by `check:script-budget`, and `brokerCoreModules` is unaffected because the directory is outside `src/core`.
2. Rewrite the 21 broker import sites (§2.1) to `from "a2a-review-lifecycle"`. Update the path and dist references listed in §2.1 (`a2a-task-handler.test.mjs`, `piri-a2a-analysis-bridge.test.mjs`, `scripts/lib/review-lineage-client.test.mjs`, `test-manifest.json`, the comment pointers, and the `scorecard-cli` path in `docs/operators.md`).
3. Wiring: root `tsconfig.json` references; `packages/broker/tsconfig.json` and `tsconfig.build.json` references; the broker `dependencies` entry; `check-packages.mjs` (allowlist entry and solution-build filter/label); a `run-monorepo-package-ci-parity.mjs` entry; a `ci.yml` paths-filter entry and job, with the broker job depending on it; `ASYNC_SAFETY_PACKAGES` in `check-source-quality-floors.mjs` plus `docs/ops/source-quality-floors.json`; `packages/broker/Dockerfile` COPY and `-w` lists; and `package-lock.json`. Also:
   - `packages/broker/scripts/npm-scripts-inventory.test.mjs` (literal `dist/review-lifecycle` assertion);
   - `.github/workflows/tck-promoted-gate.yml` `changes` filter (`packages/broker/src/**` no longer covers the moved code; add `packages/review-lifecycle/**`, and keep the #2476 coverage test green);
   - the Dockerfile runtime test-stripping step (#2080) only deletes `packages/broker/dist/**/*.test.js`, so the package's 16 compiled tests would ship in the image; extend it and `check-broker-docker-hardening.mjs`;
   - `.github/CODEOWNERS` (one line, as for the sibling packages, #1827 convention), the `a2a-body-safety-scan` roots, and the core-isolation check scope;
   - the package CI job must also trigger on `fixtures/**` (the `contracts` filter), because the package tests read `fixtures/review-lifecycle/`.
4. Docs: the root README package tree, `docs/current-state.md`, `docs/developers.md`, and a new inventory row in `docs/product-boundaries.md`.
5. Operations: update the #2274 scorecard command to `node packages/review-lifecycle/dist/scorecard-cli.js` in the move PR and in `docs/operators.md`, and tell operators to remove the stale `packages/broker/dist/review-lifecycle/` (or run `npm run clean:dist -w packages/broker`) before rebuilding.
6. Rollback: revert the single PR. There is no data or schema migration, and live mode is unchanged.

**Checks that must stay green on the move PR:** `npm run check:packages` (manifest rules plus solution build), `npm run check:layout`, `npm run check:script-budget`, `npm run check:source-quality-floors`, the package CI-parity job, the broker test manifest including the review-lineage integration tests, `node scripts/check-dist-import-resolution.mjs` (or its release-gate entry), the TCK blocking gate (#1500), and `npm run check:markdown-links`. To prove that no wire bytes changed, the `intentHash`/canonical-JSON tests and `fixtures/review-lifecycle/` replays must pass without fixture edits.

---

## 4. Decision 2 — separate-repository extraction verdicts

Criteria come from #1601 and #2454: (a) confirmed independent release demand,
(b) boundary stability, and (c) cross-repo CI and release cost. Item (d) is the
[product-boundaries](product-boundaries.md) dependency rule (Nexus core must not
depend on a feature repository's runtime).

| Candidate | (a) Independent release demand | (b) Boundary stability | (c) Cross-repo CI/release cost | (d) Dependency direction | Verdict |
|---|---|---|---|---|---|
| `a2a-policy-referee` (`packages/policy-referee`) | **Not confirmed.** It has a closed offline CLI and a no-network external-consumer example (#1705, #1707), so it is the most extraction-*ready*. But no consumer is named, it is not published (`npm view` E404, `private: true`), it has no tags or releases, and #1480 closed without an extraction request. | Moderate. Zero runtime dependencies and a narrow root export. 5 of 8 non-dependency commits also changed the broker. | High relative to its size (858 LOC): a second release gate, public-readiness and secret scans, Dependabot, branch protection, the review relay, and a publish path that `check-packages.mjs` forbids without approval. | The broker imports it at runtime (16 files). Extraction would turn this into a Nexus-to-feature-repo runtime dependency, which is forbidden, unless the broker keeps a copy. | **Do not extract. Keep it as a workspace package.** |
| `a2a-attestation` (`packages/attestation`) | **Not confirmed.** The epic calls it the chunk with the most standalone value, but there is no outside consumer, publication, or release. Its consumers are all in this repo (broker, nclex-evaluation, scripts). | Low to moderate. It is still absorbing shared code from the broker (#2047 consolidation, #2309 shared redactor). 8 of 11 non-dependency commits also changed the broker. | High: three in-repo consumers would need a pinned external version, and signing/keyring changes would need coordinated multi-repo releases. | The broker (40 files) and nclex-evaluation import it at runtime, which hits the same forbidden direction. | **Do not extract. Keep it as a workspace package.** |
| bounded-review-lifecycle (`packages/broker/src/review-lifecycle`) | **Not confirmed.** "Could be a standalone PR review product" in #1601 is a hypothesis with no consumer. Only the broker consumes it. | Not yet measurable as a package. It has zero outbound imports. It has the most commits in total, but 14 of its 16 landed in July 2026; since 2026-08-01 it had 2 (latest #2408, 2026-10-20), fewer than policy-referee (4) or attestation (10). 10 of 16 commits also changed the broker. | Highest: its contracts are persisted in broker SQLite and exposed over broker HTTP routes, so schema changes would have to be synchronized across repositories. | The broker imports it at runtime (11 production files). | **Do not extract.** Do the `packages/*` split first (§3). Reassess only after the package boundary has been stable for a while. |

### 4.1 Follow-up issues

**None.** No extraction target met the criteria, so no extraction issues are
opened. The §3 packaging move is tracked in [#2477](https://github.com/jinwon-int/a2a-nexus/issues/2477) (owner decision, §6).

---

## 5. Revisit triggers

Reopen the extraction question for a candidate only when **all** of the
following hold (thresholds as decided by the owner on 2026-10-29):

1. **Named demand:** a specific outside consumer (repository or team) commits to consuming a pinned version, or the owner approves publication (`private: false`) under the [split readiness checklist](product-boundaries.md#split-readiness-checklist).
2. **Stable boundary (owner decision 2026-10-29, replaces the 60-day window):** of the package's five most recent commits that are neither dependency bumps nor repo-wide sweeps, at most one also changes `packages/broker/`, **and** for 90 days the package's exported declarations (`dist/*.d.ts`) and its `.v1` schemas have not changed. A pure time window was rejected because it also passes a dormant package: review-lifecycle had no co-change from 2026-07-28 to 2026-10-10 only because it had no commits at all.
3. **Dependency direction solved:** a written plan for how Nexus core avoids depending on the extracted runtime, for example by keeping the code in Nexus as upstream and having the product repository consume a pinned Nexus contract.

---

## 6. Owner decisions (2026-10-29)

The owner accepted the review recommendations ("1", 2026-10-29).

| # | Question | Decision |
|---|---|---|
| 1 | Approve the §3 split | **Approved, name kept** (`packages/review-lifecycle`, `a2a-review-lifecycle`, private `0.1.0`). It lands before the #2453 PR-0, because both edit the same `test-manifest.json` line and a bare package specifier spares a second import rewrite when `core/` is later split. Image build/deploy and worker rollout stay separately approved. |
| 2 | Scorecard CLI | **Update the documented path only; no package `bin`.** The one known consumer is the #2274 run; the move PR updates that command and documents removing the stale broker `dist/review-lifecycle/`. |
| 3 | Tracking | **Child issue: [#2477](https://github.com/jinwon-int/a2a-nexus/issues/2477)**, carrying the §3.4 list (including the operational paths added in this revision) as acceptance criteria. |
| 4 | Revisit window | **Replaced** by the commit-mix and 90-day surface-stability metric in §5 item 2. |
| 5 | Close-out | **The repository-extraction half of #2454 is closed with this record as the table of record.** #2454 stays open only until #2477 lands. |

Sequence across #2454 and #2453: this revision → #2477 package move → #2453
PR-0 (enforcement with a domain map, plus Step 0) → retire CLI-only policy
modules → execution move pilot. See the
[#2453 analysis](specs/core-domain-boundaries/analyze.md#owner-decisions-2026-10-29).
