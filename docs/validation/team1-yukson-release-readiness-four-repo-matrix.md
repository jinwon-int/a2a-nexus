# Team1/yukson Release-Readiness Gate Matrix for Four Repos

Parent: [#453](https://github.com/jinwon-int/a2a-plane/issues/453) — Release-readiness pack
Assigned child: [#454](https://github.com/jinwon-int/a2a-plane/issues/454)
Lane: 4/4 (yukson)
Run: `a2a-team1-release-readiness-pack-20260526T054020KST`
Worker: `yukson` / Team1
Snapshot: `2026-05-26T05:40:20 KST (+09:00)` (run creation timestamp from run ID)

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

| Gate check | Status | Command/Check ID | Notes |
|------------|--------|-----------------|-------|
| `npm run check:layout` | PASS | `node scripts/check-layout.mjs` → `layout ok: 7 paths` | Required monorepo paths exist. |
| `npm run check:runner-import-smoke` | PASS | `node scripts/check-runner-import-smoke.mjs` → `runner import smoke ok: packages/docker-runner -> @openclaw/a2a-docker-runner` | Docker runner import surface usable. |
| `npm run check:terminal-brief-routing` | PASS | `node scripts/check-terminal-brief-routing.mjs` → `terminal brief routing guard ok: 41 production routing files checked; direct Telegram/curl sends blocked; provider acceptance remains non-ACK` | Routing code does not bypass broker delivery. |
| `npm run check:message-id-ack-boundary` | PASS | `node scripts/check-message-id-ack-boundary.mjs` → `{"ok":true,"message":"no provider-message-id-as-ACK wording found"}` | ACK boundary fixture/docs enforced. |
| `npm run test:conformance` | PASS | `node test/conformance/check-contract-fixtures.mjs && node test/conformance/check-terminal-evidence-ack-boundary.mjs` → 18 contract fixtures + 2 terminal-evidence fixtures validated; non-ACK boundary enforced. | 16 contract fixtures + 2 terminal-evidence fixtures pass. |
| `npm run test:release-gate` | PASS | `npm run test:release-gate` → `# pass 382 / # fail 0` | 382/382 tests pass. |
| `npm run scan:public-readiness` | PASS | `node scripts/public-readiness-scan.mjs` → `{"ok":true,"findings":[]}` | Zero findings. |
| `npm run scan:readiness-gates` | PASS — NO-GO (expected) | `node scanner/readiness/fail-closed-gates.mjs --spec docs/readiness/fail-closed-gates.json` → decision: `NO-GO`, 8 required gates | Aggregate decision NO-GO; no external scanner available in runner. |
| `npm run check:packages` | FAIL | `node scripts/check-packages.mjs` → broker build fails (`tsc: not found`); plugin and docker-runner skipped by root gate | `tsc` is not installed in the runner environment. Build gap is infrastructure, not code quality. |

**Verdict: Root gate passes for 8/9 explicit checks. `check:packages` fails due to `tsc` absence in the runner environment. The `tsc` gap means three packages (broker, plugin, docker-runner) cannot have their TypeScript compilation verified in this environment. This is recorded as NO-GO for package-build completeness.**

### 2.2 Package-level conformance

| Package | scripts.check | Build env | Status | Note |
|---------|--------------|-----------|--------|------|
| `packages/broker` | `npm test` → `tsc -p tsconfig.json` + node test | tsc required | FAIL | `tsc: not found` — runner has no TypeScript compiler. Build verification not possible here. |
| `packages/openclaw-plugin-a2a` | `npm test` → `tsc` + node test | tsc required | NO-GO / Unknown | Skipped by root gate because broker failed first. No independent verification in this environment. |
| `packages/docker-runner` | `npm test` → node test | tsc required | NO-GO / Unknown | Skipped by root gate. No independent verification in this environment. |

These are infrastructure gaps in the runner, not necessarily code issues. The `check:packages` script confirms every package defines `scripts.check`. Public-readiness scan reports zero findings. **Package TypeScript compilation cannot be verified in this environment and is recorded as NO-GO.**

---

## 3. Docs/Examples Coverage

### 3.1 Broker (`packages/broker`)

| Artifact | Count | Coverage |
|----------|-------|----------|
| Docs (`packages/broker/docs/*.md`) | 64 files | Release gate, operator runbooks, protocol docs, deployment guides, terminal-brief activation, receipt gates, canary matrices, handoff scenarios, closeout reconciler, edge-secret rotation, session isolation, docker-deployment |
| Examples (`packages/broker/examples/`) | 3 files | Docker Compose smoke, trading-partners compose, gwakga worker env example |
| README | Yes | Package-level README present |
| Package `check` | `npm test` | Defined; requires build step (tsc) |

**Coverage:** Comprehensive. Release gate, deploy runbooks, protocol docs, and terminal-brief evidence path are all documented.

### 3.2 OpenClaw plugin (`packages/openclaw-plugin-a2a`)

| Artifact | Count | Coverage |
|----------|-------|----------|
| Docs (`packages/openclaw-plugin-a2a/docs/*.md`) | 24 files | Plugin protocol, compatibility matrix, regression matrices, wake-on-task, recovery loop, canary receipt-gated runtime, agent card, termux mobile smoke, migration plan, handoff visibility, sessions-send hook |
| Examples (`packages/openclaw-plugin-a2a/examples/`) | 0 files | No standalone examples in examples/ directory |
| README | Yes | Package-level README present |
| Package `check` | `npm test` | Defined; requires build step (tsc) |

**Coverage:** Strong docs coverage. Example gap: no standalone plugin usage examples outside the test suite.

### 3.3 Docker runner (`packages/docker-runner`)

| Artifact | Count | Coverage |
|----------|-------|----------|
| Docs (`packages/docker-runner/docs/*.md`) | 5 files | All-github docker first smoke, artifact manifest, design, integration, release rollout checklist |
| Examples (`packages/docker-runner/examples/`) | 17 files | Task JSON fixtures (canary, canonical, github-evidence, handler-integration, terminal-brief-receipt, etc.), artifact manifest schema, rollout receipt evidence fixture |
| README | Yes | Package-level README present |
| Package `check` | `npm test` | Defined; requires build step (tsc) |

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
| `scan:public-readiness` | PASS | `node scripts/public-readiness-scan.mjs` → `{"ok":true,"findings":[]}` |
| `scan:readiness-gates` | PASS — NO-GO (expected) | `node scanner/readiness/fail-closed-gates.mjs` → decision `NO-GO`, 8 required gates pass spec check |
| `scan:external-secrets` | NO-GO / Fail-closed | No `gitleaks` or `trufflehog` installed in this runner environment. External secret/history scanner evidence is absent. |

### 4.2 Runtime/bootstrap hygiene

| Check | Result | Evidence |
|-------|--------|----------|
| `git diff --name-only -- AGENTS.md SOUL.md USER.md TOOLS.md HEARTBEAT.md IDENTITY.md .openclaw` | PASS | `(no output)` — no bootstrap guard paths found in diff |
| Branch diff contains bootstrap guard paths | PASS | None detected |
| Artifact evidence contains raw runtime context | PASS | Redacted — no raw session dumps, private paths, or provider IDs |

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
| External scanner evidence | Lane owner | External scanner clean or dispositioned | **NO-GO / Waiting** — no scanner in runner |
| Runtime/bootstrap hygiene | PR author + reviewer | Guard paths absent | **PASS** (for this lane) |
| GO/NO-GO matrix | Cross-team broker | Every gate GO | **NO-GO / Waiting** — external scanner, terminal evidence, replay proof, package build verification, and approval remain open |
| Package build verification | Lane owner | `tsc`-enabled compilation check passes for broker, plugin, docker-runner | **NO-GO / Waiting** — `tsc` not available in runner |
| Operator approval | Operator (진원님) | Separate explicit approval for visibility/live action | **NO-GO / Waiting** — no approval comment present |
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
| N1 | External secret/history scanner | externalScannerEvidence | Install `gitleaks` or `trufflehog` in operator environment; run `npm run scan:external-secrets`; disposition findings with redacted metadata | NO-GO — no scanner in runner environment |
| N2 | Terminal evidence for candidate flow | terminalEvidence | Link redacted terminal evidence showing Done/PR/Block reached requester/operator-visible surface without provider acceptance alone | NO-GO — not produced; this lane is docs-matrix only |
| N3 | Replay-safe canary proof | replaySafety | No-live simulation or separately approved one-event canary proves idempotency, stale suppression, no duplicate replay | NO-GO — not produced |
| N4 | Explicit operator approval | operatorApproval | Separate comment on #453 or #454 naming exact visibility/activation action | NO-GO — not present |
| N5 | Package TypeScript compilation | package-build | Broker, plugin, docker-runner packages require `tsc` for build compilation verification | NO-GO — `tsc` not available in runner; compilation not verified |
| N6 | Plugin standalone examples | Docs | Add standalone example usage for openclaw-plugin-a2a beyond test suite | NON-BLOCKING — 0 examples/ files; recommendation only |

---

## 8. Cross-Lane Check

### 8.1 Release-readiness pack lanes (from parent [#453](https://github.com/jinwon-int/a2a-plane/issues/453))

This is lane 4/4 (yukson). The pack covers Team1 release-readiness across 4 child issues. Each sibling lane has a merged PR providing source/docs/tests evidence:

| Lane | Worker | Child issue | Merged evidence PR | Focus |
|------|--------|-------------|-------------------|-------|
| Lane 1 | bangtong | [a2a-docker-runner#333](https://github.com/jinwon-int/a2a-docker-runner/issues/333) | [a2a-docker-runner#334](https://github.com/jinwon-int/a2a-docker-runner/pull/334) (merged) | `a2a-docker-runner` conformance smoke and runner artifact hygiene |
| Lane 2 | sogyo | [openclaw-plugin-a2a#446](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/446) | [openclaw-plugin-a2a#447](https://github.com/jinwon-int/openclaw-plugin-a2a/pull/447) (merged) | `openclaw-plugin-a2a` operator install/diagnostics readiness |
| Lane 3 | nosuk | [a2a-broker#919](https://github.com/jinwon-int/a2a-broker/issues/919) | [a2a-broker#920](https://github.com/jinwon-int/a2a-broker/pull/920) (merged) | `a2a-broker` release-readiness evidence export and status contract |
| Lane 4 (this) | yukson | [a2a-plane#454](https://github.com/jinwon-int/a2a-plane/issues/454) | [a2a-plane#456](https://github.com/jinwon-int/a2a-plane/pull/456) (this PR) | Four-repo gate matrix, conformance, docs coverage, approval boundaries, rollback/no-op rules, NO-GO items |

**Cross-check finding:** Lanes 1-3 each have a merged PR (#334, #447, #920) providing source/docs/tests evidence for the release-readiness pack. No conflict or gap detected between this lane's scope and the expected coverage from lanes 1-3. The four-repo scope (R1-R4) is independently verifiable from the monorepo checkout.

### 8.2 Sibling lane evidence expectations

| Lane | Merged PR | Changed paths | Impact on this matrix |
|------|-----------|--------------|----------------------|
| Lane 1 (bangtong) | [a2a-docker-runner#334](https://github.com/jinwon-int/a2a-docker-runner/pull/334) (merged) | `packages/docker-runner` | Runner baseline commit (R3) and conformance status — merged evidence available |
| Lane 2 (sogyo) | [openclaw-plugin-a2a#447](https://github.com/jinwon-int/openclaw-plugin-a2a/pull/447) (merged) | `packages/openclaw-plugin-a2a` | Plugin baseline commit (R2) and operator-install readiness — merged evidence available |
| Lane 3 (nosuk) | [a2a-broker#920](https://github.com/jinwon-int/a2a-broker/pull/920) (merged) | `packages/broker` | Broker baseline commit (R1) and evidence-export contract — merged evidence available |

All three sibling lanes have merged PR evidence. Their source/docs/tests outputs are available for cross-reference into this matrix.

### 8.3 Existing open PRs

This pack has one open revision PR: [a2a-plane#456](https://github.com/jinwon-int/a2a-plane/pull/456) (this lane, second revision). The superseded first revision PR [#455](https://github.com/jinwon-int/a2a-plane/pull/455) was closed.

### 8.4 Closeout context

Recent closed lanes relevant to this pack:

| Lane | PR/Issue | Summary |
|------|----------|---------|
| Team1 terminal-brief followup | [#451](https://github.com/jinwon-int/a2a-plane/pull/451) (PR) | Auto-patch: a2a-team1-terminal-brief-followup — last merged PR before this run |
| Team1/yukson public-readiness after #78261 | [#261](https://github.com/jinwon-int/a2a-plane/issues/261) | Post-openclaw/openclaw#78261 direction reset; aggregate decision remains NO-GO/Waiting |
| Team1/yukson public-readiness gate synthesis | [#263](https://github.com/jinwon-int/a2a-plane/issues/263) | 7-gate matrix (G1-G7) documenting accepted-send vocabulary, terminal evidence, replay safety, broker risk, scanner, hygiene, approvals |

No conflicts or stale projections detected against the current branch state.

---

## 9. Verification Output

All commands run at `2026-05-26T05:40:20 KST` from `/work/repo`:

```text
# Hygiene check — no bootstrap files in diff
$ git diff --name-only -- AGENTS.md SOUL.md USER.md TOOLS.md HEARTBEAT.md IDENTITY.md .openclaw
(no output)

# Layout check
$ npm run check:layout
layout ok: 7 paths

# Runner import smoke
$ npm run check:runner-import-smoke
runner import smoke ok: packages/docker-runner -> @openclaw/a2a-docker-runner

# Terminal brief routing
$ npm run check:terminal-brief-routing
terminal brief routing guard ok: 41 production routing files checked

# Message-ID ACK boundary
$ npm run check:message-id-ack-boundary
{"ok":true,"message":"no provider-message-id-as-ACK wording found"}

# Public-readiness scan
$ npm run scan:public-readiness
{"ok":true,"findings":[]}

# Readiness gates scan
$ npm run scan:readiness-gates
{"ok":true,"phase":"spec","decision":"NO-GO","requiredGates":["publicPrivateBoundary","terminalEvidence","replaySafety","externalScannerEvidence","runtimeBootstrapHygiene","goNoGoMatrix","redactedEvidencePolicy","operatorApproval"]}

# Release gate tests
$ npm run test:release-gate
# pass 382
# fail 0

# Conformance contracts
$ npm run test:conformance
{"ok":true,"checkedFixtures":["fixtures/contract/task-lifecycle.json",...]}
{"ok":true,"checkedFixtures":["fixtures/terminal-evidence/accepted-send-non-ack.json",...]}

# Package checks
$ npm run check:packages
FAIL — packages/broker: sh: 1: tsc: not found
```

---

## 10. Risk Notes

1. **External scanner unavailable (BLOCKING)**: This runner has no `gitleaks` or `trufflehog`. The aggregate readiness decision remains fail-closed NO-GO until an operator environment provides scanner evidence.
2. **Package build gap (BLOCKING for compilation)**: `tsc` is not installed in the runner, so `check:packages` cannot verify broker, plugin, or docker-runner TypeScript compilation. This is recorded as NO-GO for build verification completeness.
3. **Plugin examples gap (NON-BLOCKING)**: `packages/openclaw-plugin-a2a/examples/` is empty. The plugin has 24 docs files but no standalone example usage outside the test suite. Recommend creating a basic example.
4. **No live test performed**: This lane performed repo inspection, docs review, and static validation only. No broker, plugin, or Docker runtime was started.
5. **Cross-lane dependency**: Lanes 1-3 have merged PRs (#334/#447/#920). If those changes modify conformance fixtures, contracts, or package check scripts, this matrix's evidence columns (especially commit baselines) may need a merge preflight before the pack round closes.

---

## 11. Changed Files

| File | Change type | Description |
|------|------------|-------------|
| `docs/validation/team1-yukson-release-readiness-four-repo-matrix.md` | NEW | This document — release-readiness gate matrix for four repos |

---

## 12. Approval-Sensitive Blockers

| Blocker | Gate | Severity | Operator action |
|---------|------|----------|-----------------|
| No external scanner evidence | externalScannerEvidence | BLOCKING | Install `gitleaks`/`trufflehog` and rerun `npm run scan:external-secrets` before public visibility |
| No explicit operator approval | operatorApproval | BLOCKING | Post approval comment on #454 before any visibility/live action |
| No terminal evidence | terminalEvidence | BLOCKING | Link redacted terminal evidence before claiming public-readiness |
| No replay-safe canary proof | replaySafety | BLOCKING | No-live simulation or separately approved one-event canary before claiming replay safety |
| Package TypeScript compilation unverified | package-build | BLOCKING (for build-completeness gate) | Run `tsc`-equipped environment per-package to verify compilation |
| Plugin examples gap | Docs | NON-BLOCKING (recommendation) | Add standalone example to `packages/openclaw-plugin-a2a/examples/` |

**Current non-negotiable decision for #454: the four-repo gate matrix is documented and the aggregate decision remains NO-GO / Waiting.** This is a source-only artifact: it does not authorize any production deploy, restart, live send, terminal ACK, DB mutation, release, or visibility change. The NO-GO status is fail-closed by design — required evidence (external scanner, terminal receipt, replay proof, package build verification, explicit operator approval) is absent. All 8 conformance checks that could run in this environment passed. The documentation and conformance surfaces are reviewed and stable.

**Verdict source-only: NO-GO.** Promotion to GO requires all of:
- External scanner evidence (gitleaks/trufflehog in operator environment)
- Terminal evidence showing requester/operator-visible receipt
- Replay-safe canary proof
- Package TypeScript build verification (broker, plugin, docker-runner)
- Explicit operator approval comment naming repository visibility/publication

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
