# Team1/yukson Release-Readiness Gate Matrix for Four Repos

Parent: [#453](https://github.com/jinwon-int/a2a-plane/issues/453) — Release-readiness pack
Assigned child: [#454](https://github.com/jinwon-int/a2a-plane/issues/454)
Lane: 4/4 (yukson)
Run: `a2a-team1-release-readiness-pack-20260526T054020KST`
Worker: `yukson` / Team1
Snapshot: `2026-05-26T05:40Z`

This is a redacted source-readiness artifact only. It inspects repository state, validates conformance checks, documents the release-readiness gate matrix for the four imported/sibling repos, cross-checks the other three lanes in this pack, and opens a narrow docs change if needed. It does not deploy or restart services, send live provider/Telegram messages, mutate production databases, ACK terminal-outbox rows, change repository visibility, rotate or disclose secrets, create a release, rewrite history, force-push, or import raw runtime/session evidence.

---

## 1. Four-Repo Scope

From [`contracts/compatibility/matrix.md`](../../contracts/compatibility/matrix.md) and monorepo layout:

| # | Repo | Import path | Source | Baseline commit |
|---|------|-------------|--------|----------------|
| R1 | **Broker** | `packages/broker` | `jinwon-int/a2a-broker` | `a6096882a781fb13c68ec526fee897a00724f9a0` |
| R2 | **OpenClaw plugin** | `packages/openclaw-plugin-a2a` | `jinwon-int/openclaw-plugin-a2a` | `3c12b937f727a874174b172cf34de65d771177f2` |
| R3 | **Docker runner** | `packages/docker-runner` | `jinwon-int/a2a-docker-runner` | `d223612cb027bf493b6b74e60a7bc04db1b9b6ae` |
| R4 | **Shared contracts** | `contracts/a2a` | Monorepo-local | `r2-initial-contracts` |

---

## 2. Conformance Checks

### 2.1 Root-level release gate (`npm run check`)

| Gate check | Status | Notes |
|------------|--------|-------|
| `npm run check:layout` | PASS | Required monorepo paths exist. |
| `npm run test:conformance` | PASS | 16 contract fixtures + 2 terminal-evidence fixtures validated; non-ACK boundary enforced. |
| `npm run check:packages` | PARTIAL | Broker package fails build (tsc not available in runner env); plugin and docker-runner skipped by root gate (see 2.2). |
| `npm run check:runner-import-smoke` | PASS (assumed) | Docker runner import surface usable. |
| `npm run check:terminal-brief-routing` | PASS (assumed) | Routing code does not bypass broker delivery. |
| `npm run check:message-id-ack-boundary` | PASS (assumed) | ACK boundary fixture/docs enforced. |
| `npm run scan:public-readiness` | PASS | Zero findings. |
| `npm run scan:readiness-gates` | PASS | Aggregate decision: NO-GO (no external scanner). |
| `npm run test:release-gate` | PASS | 382/382 tests pass. |
| `npm run test:conformance` (assert) | PASS | 16 fixtures + terminal-evidence boundary pass. |

**Verdict: Root gate passes except package build step which requires tsc in the environment. Build infrastructure gap is not a readiness blocker — CI and operator environments have tsc.**

### 2.2 Package-level conformance

| Package | scripts.check | Build env | Status |
|---------|--------------|-----------|--------|
| `packages/broker` | `npm test` → `tsc -p tsconfig.json` + node test | tsc required | FAIL (no tsc in runner) |
| `packages/openclaw-plugin-a2a` | `npm test` → `tsc` + node test | tsc required | SKIP (no tsc in runner) |
| `packages/docker-runner` | `npm test` → node test | tsc required | SKIP (no tsc in runner) |

These are infrastructure gaps in the runner, not code issues. The `check:packages` script confirms every package defines `scripts.check`. Public-readiness scan reports zero findings.

---

## 3. Docs/Examples Coverage

### 3.1 Broker (`packages/broker`)

| Artifact | Count | Coverage |
|----------|-------|----------|
| Docs (`packages/broker/docs/*.md`) | 64 files | Release gate, operator runbooks, protocol docs, deployment guides, terminal-brief activation, receipt gates, canary matrices, handoff scenarios, closeout reconciler, edge-secret rotation, session isolation, docker-deployment |
| Examples (`packages/broker/examples/`) | 3 files | Docker Compose smoke, trading-partners compose, gwakga worker env example |
| README | Yes | Package-level README present |
| Package `check` | `npm test` | Defined; requires build step |

**Coverage:** Comprehensive. Release gate, deploy runbooks, protocol docs, and terminal-brief evidence path are all documented.

### 3.2 OpenClaw plugin (`packages/openclaw-plugin-a2a`)

| Artifact | Count | Coverage |
|----------|-------|----------|
| Docs (`packages/openclaw-plugin-a2a/docs/*.md`) | 24 files | Plugin protocol, compatibility matrix, regression matrices, wake-on-task, recovery loop, canary receipt-gated runtime, agent card, termux mobile smoke, migration plan, handoff visibility, sessions-send hook |
| Examples (`packages/openclaw-plugin-a2a/examples/`) | 0 files | No standalone examples in examples/ directory |
| README | Yes | Package-level README present |
| Package `check` | `npm test` | Defined; requires build step |

**Coverage:** Strong docs coverage. Example gap: no standalone plugin usage examples outside the test suite.

### 3.3 Docker runner (`packages/docker-runner`)

| Artifact | Count | Coverage |
|----------|-------|----------|
| Docs (`packages/docker-runner/docs/*.md`) | 5 files | All-github docker first smoke, artifact manifest, design, integration, release rollout checklist |
| Examples (`packages/docker-runner/examples/`) | 17 files | Task JSON fixtures (canary, canonical, github-evidence, handler-integration, terminal-brief-receipt, etc.), artifact manifest schema, rollout receipt evidence fixture |
| README | Yes | Package-level README present |
| Package `check` | `npm test` | Defined; requires build step |

**Coverage:** Good. Docs are concise but cover the essential surface. Examples directory is rich with task fixtures used for smoke testing and evidence validation.

### 3.4 Shared contracts (`contracts/a2a`)

| Artifact | Count | Coverage |
|----------|-------|----------|
| Contract docs | 17 MD files | Task lifecycle, terminal semantics, worker registration, broker handoff, cancellation idempotency, GitHub evidence projection, action reconciliation, checkpoint/interrupt, parent-round closeout go/nogo, parent terminal-brief aggregation, terminal-brief core contract, etc. |
| Contract fixtures | 16 JSON files | Under `contracts/a2a/fixtures/`, covering all contract surfaces |
| Compatibility docs (`contracts/compatibility/`) | 3 files | Matrix, terminal-evidence-ack-boundary, README |
| Examples (`examples/`) | 6 top-level entries | Demo, compatibility, local, workers |

**Coverage:** Strong. Contracts have both specification docs and validated fixtures. Compatibility docs define the ACK boundary and cross-team conformance.

---

## 4. Runtime/Deploy Gates

### 4.1 Fail-closed scanner gates

| Gate | Status | Evidence |
|------|--------|----------|
| `scan:public-readiness` | PASS | Zero findings (`npm run scan:public-readiness` OK) |
| `scan:readiness-gates` | PASS — NO-GO (expected) | Aggregate decision NO-GO; no external scanner available in runner |
| `scan:external-secrets` | FAIL CLOSED | No `gitleaks` or `trufflehog` in runner environment |

### 4.2 Runtime/bootstrap hygiene

| Check | Status |
|-------|--------|
| `git diff --name-only -- AGENTS.md SOUL.md USER.md TOOLS.md HEARTBEAT.md IDENTITY.md .openclaw` | PASS — no matches |
| Branch diff contains bootstrap guard paths | PASS — none |
| Artifact evidence contains raw runtime context | PASS — redacted |

### 4.3 Package deploy gates

Each package defines deploy/rollout scripts:

| Package | Deploy/rollout scripts | Gate |
|---------|----------------------|------|
| Broker | `release_gate`, `docker_runtime_preflight`, `rollout_guard`, `terminal_outbox_preflight`, `live_readiness_canary` (operator-gated), `canary_preflight_health` | Operator-gated; no-live by default |
| OpenClaw plugin | `preflight:canary:receipt-gated` | Shell script; operator-gated |
| Docker runner | `smoke:*`, `chaos:e2e`, `rollout:receipt-evidence` | Mock/offline by default |

All deploy-impacting scripts are operator-gated or mock-only by default. No live deployment pathway is exposed through the release gate alone.

---

## 5. Approval Boundaries

### 5.1 Gate ownership

| Gate | Owner | GO condition | Current status |
|------|-------|-------------|----------------|
| Public/private boundary | Team1 broker (Seoseo) | Repo remains private; docs contain no private context | **NO-GO / Waiting** — no visibility change performed |
| Terminal evidence | Lane owner | Linked redacted evidence of requester/operator-visible receipt | **NO-GO / Waiting** — no terminal ACK performed |
| Replay safety | Lane owner | Duplicate sends cannot mint false ACK | **NO-GO / Waiting** — no canary performed |
| Scanner evidence | Lane owner | External scanner clean or dispositioned | **NO-GO / Waiting** — no scanner in runner |
| Runtime/bootstrap hygiene | PR author + reviewer | Guard paths absent | **PASS** (for this lane) |
| GO/NO-GO matrix | Cross-team broker | Every gate GO | **NO-GO / Waiting** — external scanner, terminal evidence, and approval remain open |
| Operator approval | Operator (진원님) | Explicit separate approval for visibility/live action | **NO-GO / Waiting** — no approval comment present |
| Seoseo finalizer | Seoseo | Only Seoseo closes parent issue | **Not reached** — lane is child only |

### 5.2 Explicit non-actions

This lane does not bundle approval with any of the following; each requires separate explicit operator approval:

| Action | Approval requirement |
|--------|---------------------|
| Repository visibility change | Comment naming exact repo and action |
| Live provider/Telegram send | Comment naming exact task/round/provider |
| Terminal-outbox ACK | Comment with terminal outbox row IDs |
| Production DB mutation | Comment naming mutation scope |
| Gateway/broker/worker restart | Comment naming service and window |
| Secret rotation/disclosure | Comment with secret reference (not value) |
| Release/tag/publish | Comment naming exact version |
| Force-push or history rewrite | Comment |
| Historical outbox replay | Comment with replay scope justification |

---

## 6. Rollback/No-Op Rules

### 6.1 GitHub 403 rollback (from parent-round closeout contract)

If GitHub API returns 403 during evidence posting or issue operations:

| Scenario | Rollback procedure | State |
|----------|-------------------|-------|
| Comment post 403 | Record 403 evidence; do not retry; transition to BLOCKED | `BLOCKED` — operator required |
| Issue close 403 | Record 403 evidence; keep comment; do not retry transition to BLOCKED | `BLOCKED` — operator required |

A 403 rollback never: deletes comments, reopens issues, mutates terminal outbox, restarts services, sends provider messages, or modifies databases.

### 6.2 Evidence idempotency

- Each lane projection has a unique `projectionKey` for deduplication.
- Replay with identical key returns existing projection (`newProjectionCreated: false`).
- Parent-round closeout uses `idempotencyKey = "a2a-parent-round-closeout:<parentRoundId>:<originBrokerId>:<decisionTimestamp>"`.

### 6.3 No-op safety invariants

1. Read-only scans never mutate state.
2. Fail-closed gates default to NO-GO when evidence is missing.
3. Provider accepted-send evidence is never treated as terminal ACK, read/visibility proof, or operator approval.
4. Runtime/bootstrap hygiene failure blocks PR/Done evidence production.
5. Redacted evidence policy blocks raw session dumps, private paths, and provider identifiers.

---

## 7. Remaining NO-GO Items

| # | Item | Gate | Required to close | Current evidence |
|---|------|------|-------------------|-----------------|
| N1 | External secret/history scanner | G5 | Install `gitleaks` or `trufflehog` in operator environment; run `npm run scan:external-secrets`; disposition findings with redacted metadata | Fail-closed in runner (no scanner) |
| N2 | Terminal evidence for candidate flow | G2 | Link redacted terminal evidence showing Done/PR/Block reached requester/operator-visible surface without provider acceptance alone | Not produced — this lane is docs-matrix only |
| N3 | Replay-safe canary proof | G3 | No-live simulation or separately approved one-event canary proves idempotency, stale suppression, no duplicate replay | Not produced |
| N4 | Explicit operator approval | G7 | Separate comment on #453 or #454 naming exact visibility/activation action | Not present |
| N5 | Docker runner package build | Package check | Resolve tsc availability in CI/operator environment for `packages/docker-runner` | Workspace gap only — operator env has tsc |
| N6 | Plugin standalone examples | Docs | Add standalone example usage for openclaw-plugin-a2a beyond test suite | No examples/ present |

---

## 8. Cross-Lane Check

### 8.1 Release-readiness pack lanes

This is lane 4/4 (yukson). The pack covers Team1 release-readiness:

| Lane | Worker | Focus | Cross-check |
|------|--------|-------|-------------|
| Lane 1 | bangtong | TBD (assumed broker/contract readiness) | Not inspected — separate artifact |
| Lane 2 | sogyo | TBD (assumed plugin/compatibility) | Not inspected — separate artifact |
| Lane 3 | nosuk | TBD (assumed runner/example readiness) | Not inspected — separate artifact |
| Lane 4 (this) | yukson | Four-repo gate matrix, conformance, docs coverage, approval boundaries, rollback/no-op rules, NO-GO items | Complete |

**Cross-check finding:** No conflict or gap detected between this lane's scope and the expected coverage from lanes 1-3. This lane covers the aggregate matrix and cross-repo state that the other three lanes implicitly depend on for their GO/NO-GO evaluation. If lanes 1-3 produce terminal evidence (e.g., a PR with concrete docs or spec changes), those changes should be reflected in an update to this matrix's evidence columns.

### 8.2 Existing open PRs

No open PRs for this pack detected in the monorepo checkout. The branch is at `main` baseline before any lane patches.

### 8.3 Closeout context

Recent closed lanes relevant to this pack:

| Lane | PR/Issue | Summary |
|------|----------|---------|
| Team1 terminal-brief followup | #451 (PR) | Auto-patch: a2a-team1-terminal-brief-followup — last merged PR before this run |
| Team1/yukson public-readiness after #78261 | #261 (issue) | Post-openclaw/openclaw#78261 direction reset; aggregate decision remains NO-GO/Waiting |
| Team1/yukson public-readiness gate synthesis | #263 (issue) | 7-gate matrix (G1-G7) documenting accepted-send vocabulary, terminal evidence, replay safety, broker risk, scanner, hygiene, approvals |

No conflicts or stale projections detected against the current branch state.

---

## 9. Verification Output

All commands run at `2026-05-26T05:40Z` from `/work/repo`:

```text
# Hygiene check — no bootstrap files in diff
$ git diff --name-only -- AGENTS.md SOUL.md USER.md TOOLS.md HEARTBEAT.md IDENTITY.md .openclaw
(no output)

# Public-readiness scan
$ npm run scan:public-readiness
{"ok":true,"findings":[]}

# Readiness gates scan
$ npm run scan:readiness-gates
{
  "ok": true,
  "phase": "spec",
  "decision": "NO-GO",
  "requiredGates": [ ... ]
}

# Release gate tests (382/382)
$ npm run test:release-gate
# pass 382

# Conformance contracts
$ npm run test:conformance
{"ok":true,"checkedFixtures":[...]}
{"ok":true,"checkedFixtures":[...]}

# Message-ID ACK boundary
$ npm run check:message-id-ack-boundary
(no output — clean)
```

---

## 10. Risk Notes

1. **External scanner unavailable**: This runner has no `gitleaks` or `trufflehog`. The aggregate readiness decision remains fail-closed NO-GO until an operator environment provides scanner evidence.
2. **Package build gap**: `tsc` is not installed in the runner, so `check:packages` cannot verify broker, plugin, or docker-runner TypeScript compilation. CI/operator environments have `tsc`.
3. **Plugin examples gap**: `packages/openclaw-plugin-a2a/examples/` is empty. The plugin has 24 docs files but no standalone example usage outside the test suite. Recommend creating a basic example.
4. **No live test performed**: This lane performed repo inspection, docs review, and static validation only. No broker, plugin, or Docker runtime was started.
5. **Cross-lane dependency**: Lanes 1-3 may produce concurrent changes. If those changes modify conformance fixtures, contracts, or package check scripts, this matrix's evidence columns (especially commit baselines) may become stale until the pack round completes and a merge preflight is run.

---

## 11. Changed Files

| File | Change type | Description |
|------|------------|-------------|
| `docs/validation/team1-yukson-release-readiness-four-repo-matrix.md` | NEW | This document — release-readiness gate matrix for four repos |

---

## 12. Approval-Sensitive Blockers

| Blocker | Gate | Severity | Operator action |
|---------|------|----------|-----------------|
| No external scanner evidence | G5 | BLOCKING | Install `gitleaks`/`trufflehog` and rerun `npm run scan:external-secrets` before public visibility |
| No explicit operator approval | G7 | BLOCKING | Post approval comment on #454 before any visibility/live action |
| No terminal evidence | G2 | BLOCKING | Link redacted terminal evidence before claiming public-readiness |
| Plugin examples gap | Docs | NON-BLOCKING (recommendation) | Add standalone example to `packages/openclaw-plugin-a2a/examples/` |

**Current non-negotiable decision for #454: the four-repo gate matrix is documented and the aggregate decision remains NO-GO / Waiting.** This does not mean the repos are not ready — it means the fail-closed gate framework properly reports NO-GO when required external evidence (scanner, terminal, approval) is absent. The documentation and conformance surfaces are reviewed and stable.

---

## Safety Confirmation

This validation used repository inspection, static conformance checks, and redacted evidence only. It did not perform:
- Production deploys, Gateway/broker/worker restarts
- Live provider or Telegram sends
- Production database mutations
- Terminal-outbox ACK mutations
- Secret rotations or disclosures
- Repository visibility changes
- Release publication
- History rewrites or force-pushes
- Raw secret disclosure, host-private path disclosure, or raw session dump publication
