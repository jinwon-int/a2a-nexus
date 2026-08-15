# Feature Spec: core-slimdown first slice — move the NCLEX evaluation domain out of the broker core

Parent: #1601 (Nexus 재편 epic). Status: proposal, spec-first — documentation only; no runtime change authorized by this document.

## Problem

The 2026-08-15 repository review measured the broker core at ~213k LOC across 554 files and found:

1. **Business domains live inside the generic control plane.** `src/nclex-evaluation/` (receipt contract/store/keyring + merge-ready projection, ~28k on disk with tests), `src/trading-dialectic/` and `src/decision-dialectic/` (~140k combined) are workload-specific feature modules inside `packages/broker/src`, whose stated product is dispatch → claim → execute → verify → evidence → merge (#1601 goal 1).
2. **Change blast radius keeps growing.** The top-churn files of the last six weeks are exactly the largest files — `worker.ts` (2,948 lines, 9 touches), `core/broker.ts` (2,445, 19), `server.ts` (2,074, 18), `core/store.ts` (2,147, 10). Every server-level feature lane (like the NCLEX routes wired into `server.ts:206-208,374-387`) adds more surface to the same files.
3. **The script surface is saturated.** root 159/159, broker-core 175/175, npm-scripts 81/81 — the #1503 reverse-ratchet is at budget with no headroom, which blocks new core work until something moves out.

The NCLEX domain is the smallest and cleanest of the three domain modules (4 source files, one route handler, one store, self-contained contracts, already keyring-isolated), which makes it the right first slice to prove the modularize-first extraction pattern before anyone attempts the dialectic engines.

## User / operator stories

- As a maintainer, I want NCLEX evaluation code out of the broker core so broker-core churn (server.ts/store.ts) stops being coupled to a workload-specific feature.
- As a broker operator, I want the NCLEX feature to be optional at build/config time so a plain broker deployment does not carry it.
- As a reviewer, I want the extraction to be provably behavior-preserving so the release gate plus broker tests pass unchanged.
- As a #1601 contributor, I want a written, reusable extraction recipe (boundaries, import rules, CI parity, script-budget accounting) so the next slices (trading-dialectic, decision-dialectic) are mechanical.

## Scope

### In scope

- Move `packages/broker/src/nclex-evaluation/**` and its HTTP route wiring into a new workspace package boundary `packages/nclex-evaluation` (name exact at implementation) with an explicit contract:
  - the broker keeps only a route-delegation seam (`server.ts` calls the package's route matcher/handler if the feature is enabled);
  - the package owns receipt-contract/receipt-store/keyring loading/merge-ready projection and their tests;
  - `packages/broker` may depend on the package; the package must not depend on broker internals (enforced by extending `check-broker-core-dependency-isolation.mjs` style guards or a package-boundary check).
- Config gating: the feature becomes opt-in (env-driven, default off for a plain broker) with the existing env names documented.
- CI parity entry + package manifest following the existing workspace package pattern; script-budget accounting documented (moves surface out of broker-core, does not add net-new).
- Update `docs/developers.md` / `docs/current-state.md` package map and `docs/issue-routing.md` (new `source:` label decision documented — either own label or a plane-level routing note).

### Out of scope

- Extracting `trading-dialectic` / `decision-dialectic` (later slices; this spec only leaves the recipe).
- Any change to receipt-contract semantics, keyring format, or stored data — this slice moves code, it does not redesign it.
- Production deploy/restart/canary unless explicitly approved.
- DB mutation/prune/migration/replay unless explicitly approved.
- Secret movement/output unless explicitly approved (the keyring file location contract stays as-is).
- Deleting or rewriting `docs/history/**` records.

## Success criteria

- [ ] `packages/broker/src/nclex-evaluation/` no longer exists; the domain lives in its own package with zero broker-internal imports (guard-enforced).
- [ ] `server.ts` NCLEX wiring is a delegation seam measured in single-digit lines (target ≤ 15) instead of inline keyring/store construction.
- [ ] Broker test suite and the moved package's suite both pass in CI parity; full release gate green; no test deleted (moved tests keep their names).
- [ ] Script budgets: broker-core count decreases or stays flat; the new package's budget is declared in the script-surface manifest.
- [ ] The extraction recipe (seam pattern, import guard, CI parity steps, budget accounting) is written into this spec's plan so the next slice can follow it without re-derivation.
- [ ] Feature-gating documented: default-off for plain brokers, env names listed, no behavior change when enabled on the existing deployment path.

## Safety and approval boundaries

### Secrets and private data

- The NCLEX keyring file is a credential-adjacent artifact. This slice must not move, copy, or log keyring material; only the existing file-path contract travels with the code. No new env names that accept raw key material.

### Human approval required for

- [ ] production deploy
- [ ] Gateway/broker/worker/service restart
- [ ] live canary/provider send
- [ ] DB mutation/prune/migration/replay
- [ ] manual Terminal Brief ACK/replay
- [ ] release/tag
- [ ] secret rotation/movement
- [ ] force push/history rewrite
- [x] none of the above — this slice is repo-internal code movement; all deliverables land as reviewed PRs.

### Broker foreground liveness

- No operator-session impact: this is build-time code organization, not runtime behavior. No new foreground work.

## Verification design

- Oracle: the existing broker test manifest + a new package CI parity lane (same pattern as attestation/policy-referee), plus `check:broker-core-dependency-isolation` extended to forbid the reverse import direction. Independent from the implementation lane because the release gate and package parity run them on fresh CI runners.
- Behavior-preservation check: moved test files keep their test names, so `npm run test -w packages/broker` result counts are comparable before/after (total count unchanged modulo moved suites).
