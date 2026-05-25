# Team1/yukson Release-Blocker Proof Matrix for Four Repos

Parent: [#458](https://github.com/jinwon-int/a2a-plane/issues/458) — Release-blocker proof pack
Assigned child: [#459](https://github.com/jinwon-int/a2a-plane/issues/459)
Lane: 4/4 (yukson)
Run: `a2a-team1-release-blocker-proof-pack-20260526T0628KST`
Worker: `yukson` / Team1
Snapshot: `2026-05-26T06:28:00 KST (+09:00)` (run creation timestamp from run ID)

Predecessor: [`team1-yukson-release-readiness-four-repo-matrix.md`](./team1-yukson-release-readiness-four-repo-matrix.md) — release-readiness gate matrix produced by earlier pack.

This is a redacted source-proof artifact only. It inspects repository state, validates conformance checks, documents release-blocker proof coverage—scanner evidence, replay safety, package/build verification, requester-visible evidence, terminal ACK boundaries, approval gates, rollback/no-op rules, and remaining GO/NO-GO decision points—cross-checks the other three lanes in this pack, and opens a narrow docs change if needed. It does not deploy or restart services, send live provider/Telegram messages, mutate production databases, ACK terminal-outbox rows, change repository visibility, rotate or disclose secrets, create a release, rewrite history, force-push, or import raw runtime/session evidence.

---

## 1. Four-Repo Scope

From [`contracts/compatibility/matrix.md`](../../contracts/compatibility/matrix.md) and monorepo layout (carried forward from the release-readiness matrix):

| # | Repo | Import path | Source | Baseline commit |
|---|------|-------------|--------|----------------|
| R1 | **Broker** | `packages/broker` | `jinwon-int/a2a-broker` | `a6096882a781fb13c68ec526fee897a00724f9a0` |
| R2 | **OpenClaw plugin** | `packages/openclaw-plugin-a2a` | `jinwon-int/openclaw-plugin-a2a` | `3c12b937f727a874174b172cf34de65d771177f2` |
| R3 | **Docker runner** | `packages/docker-runner` | `jinwon-int/a2a-docker-runner` | `d223612cb027bf493b6b74e60a7bc04db1b9b6ae` |
| R4 | **Shared contracts** | `contracts/a2a` | Monorepo-local | `r2-initial-contracts` |

---

## 2. Proof Coverage Matrix

The release-readiness pack identified NO-GO items N1–N6. This pack targets source-backed proofs for each. The table below documents what evidence exists in the current repo, what is reproducible in the runner, and what remains operator-gated.

### 2.1 Scanner Evidence (N1 — external secret/history scanner)

| Evidence type | Status | Details |
|---------------|--------|---------|
| Internal public-readiness scan | PASS — 0 findings | `node scripts/public-readiness-scan.mjs` → `{"ok":true,"findings":[]}`. Scans for private domain refs, secret-key file patterns, provider identifiers, and raw session/shell dumps across repo files. |
| External scanner availability | NO-GO | `node scripts/external-secret-scan.mjs` → blocked: no `gitleaks` or `trufflehog` installed in the runner environment. The scanner script intentionally fails closed instead of substituting local checks. |
| `.gitleaks.toml` configuration | PRESENT | At repo root — the config file exists but no scanner binary is available in this environment. |
| Fail-closed gate spec requirement | DOCUMENTED | `docs/readiness/fail-closed-gates.json` gate `externalScannerEvidence`: blocked when "External scanner evidence is absent or unavailable". |
| Operator workaround | REQUIRED | Operator installs `gitleaks` or `trufflehog` in their environment, checks out the candidate tree/history, runs `npm run scan:external-secrets`, and dispositions findings with redacted metadata. |

**Proof verdict: NO-GO.** External scanner evidence cannot be produced in the runner environment. The repo has the gitleaks config fixture, the scanner script, and a fail-closed gate spec. Operator action remains the blocker.

### 2.2 Replay Safety (N2 — replay-safe canary proof)

| Evidence type | Status | Details |
|---------------|--------|---------|
| Contract fixtures for replay safety | PRESENT — 4 fixtures | `live-canary-replay-approval-boundary.json`, `second-worker-replay-trace.json`, `cancellation-idempotency.json`, `terminal-evidence.json` define replay-safe surfaces for closeout, terminal evidence, and approval boundaries. |
| Terminal evidence fixture with non-ACK boundary | VALIDATED | `fixtures/terminal-evidence/accepted-send-non-ack.json` has scenario `replay-safe` and documents that identical retries with the same `projectionKey` return existing projection. |
| Terminal evidence fixture with GitHub comment projection | VALIDATED | `fixtures/terminal-evidence/github-comment-projection.json`: manifestBound=true, idempotent=true, replaySafe=true, terminalAck=false. |
| Round-merge preflight script | PASS | `node scripts/round-merge-preflight.mjs` (included in `test:release-gate`). |
| Replay safety gate in fail-closed spec | DOCUMENTED | `docs/readiness/fail-closed-gates.json` gate `replaySafety`: blocked when "Replay-safety proof for terminal evidence is missing, stale, or disputed". |
| Running replay-safe simulation in runner | NO-GO | Replay-safety proof requires a no-live simulation or separately approved one-event canary. The runner environment has no live broker, outbox, or provider connectivity. The contract fixtures validate the _design_ but not runtime replay behavior. |

**Proof verdict: NO-GO.** Contract fixtures document idempotent replay-safe design. Runtime replay-safe simulation requires a broker runtime (no-live) which is outside this runner environment. Can be dispositioned as NO-GO/Waiting for broker replay evidence from lane 3.

### 2.3 Package/Build Verification (N5 — TypeScript compilation)

| Evidence type | Status | Details |
|---------------|--------|---------|
| All three packages define `scripts.check` | PASS | Broker: `npm test` (build + node test). Plugin: `npm test` (build + node test). Docker-runner: `npm test` (build + node test). |
| `check:packages` script | FAIL | `node scripts/check-packages.mjs` → broker build fails: `sh: 1: tsc: not found`. Plugin and docker-runner skipped by root gate after broker failure. |
| `tsc` availability | NOT INSTALLED | Node.js v22.22.2 is present but `typescript` compiler is not installed. No `node_modules/.bin/tsc` or global `tsc`. |
| JS-based conformance tests | PASS — 382/382 | `test:release-gate` runs 382 JS-based conformance tests. All pass. These test scanner scripts, contract fixtures, libero preflight, action reconciliation, baselines, etc. |
| Node-based test runner tests | PRESENT | Broker: 2972+ line test suite, plugin: 3018+ line test suite, runner: 2089+ line test suite — all require `tsc` build step first. |
| Workaround for build verification | REQUIRED | Operator runs `npm install` on a host with `tsc` available, then `npm run check:packages`. OR uses `npx tsc` with network access in the runner. |

**Proof verdict: NO-GO.** Build compilation cannot complete without TypeScript in the runner. JS-level conformance tests all pass. Package-level tests require a TypeScript build step that depends on `tsc`.

### 2.4 Terminal/Requester-Visible Evidence (N2 terminal evidence gate)

| Evidence type | Status | Details |
|---------------|--------|---------|
| Terminal evidence contract | VALIDATED | `test/conformance/check-terminal-evidence-ack-boundary.mjs` validates accepted-send-non-ack and github-comment-projection fixtures. Non-ACK scenarios: `provider-message-id-is-accepted-send-only`, `sent-status-with-message-id-is-still-non-ack`. ACK-safe receipt scenarios: `manual-operator-receipt-is-ack-safe`, `current-session-visible-receipt-is-ack-safe`. |
| Provider message-ID boundary | ENFORCED | `node scripts/check-message-id-ack-boundary.mjs` → `{"ok":true,"message":"no provider-message-id-as-ACK wording found"}`. Scans docs, fixtures, contracts for wording that conflates provider message ID with terminal ACK. |
| Routing guard | PASS | `node scripts/check-terminal-brief-routing.mjs` → `41 production routing files checked; direct Telegram/curl sends blocked; provider acceptance remains non-ACK`. |
| Terminal evidence for this lane | NOT PRODUCED | This lane is source/docs proof only. No terminal evidence packet was generated because no live/no-live flow runs in the a2a-plane runner. Requester-visible evidence would be the PR/issue comment itself (acknowledged operator-visible receipt). |

**Proof verdict: NO-GO.** The contract design enforces the terminal evidence / acceptance boundary correctly. Conformance tests pass. No terminal evidence _for a candidate flow_ was produced by this lane because the lane is archival/documentation only. Requester-visible proof for this pack is the Start comment and subsequent PR/issue comments on the child issues.

### 2.5 Terminal ACK Boundaries

| ACK type | Allowed | Evidence | Source |
|----------|---------|----------|--------|
| Provider accepted-send / message ID | NO (never ACK) | Scanned docs: 0 occurrences of conflated wording | `check:message-id-ack-boundary` |
| Sent-status with message-id | NO (non-ACK) | Fixture: `sent-status-with-message-id-is-still-non-ack` | `check-terminal-evidence-ack-boundary` |
| Manual operator receipt | YES (ACK-safe) | Fixture: `manual-operator-receipt-is-ack-safe` | Same |
| Current-session-visible receipt | YES (ACK-safe) | Fixture: `current-session-visible-receipt-is-ack-safe` | Same |
| GitHub comment projection | NO (terminalAck: false) | `fixtures/terminal-evidence/github-comment-projection.json`: `terminalAck: false` | Same |
| Direct Telegram/curl send | BLOCKED by routing guard | 41 routing files reviewed: direct sends blocked | `check:terminal-brief-routing` |

**Proof verdict: DESIGN VERIFIED.** All conformance checks pass. The terminal ACK boundary is enforced at the contract, fixture, docs, and routing level.

### 2.6 Approval Gates

From [`docs/readiness/fail-closed-gates.json`](../../docs/readiness/fail-closed-gates.json):

| Gate | Required for GO | Status in this lane | Evidence |
|------|-----------------|---------------------|----------|
| `publicPrivateBoundary` | YES | **NO-GO / Waiting** — repo remains private | Repo metadata shows private. No visibility change performed. |
| `terminalEvidence` | YES | **NO-GO / Waiting** — no candidate-flow terminal evidence | Start comment + this document provide requester-visible receipt, but no terminal evidence packet for a candidate flow. |
| `replaySafety` | YES | **NO-GO / Waiting** — no runtime replay simulation | Contract fixtures validate design; runtime replay requires broker environment. |
| `externalScannerEvidence` | YES | **NO-GO / Waiting** — no scanner binary in runner | `.gitleaks.toml` present; `gitleaks`/`trufflehog` unavailable. |
| `runtimeBootstrapHygiene` | YES | **PASS** — guard paths clean | `git diff --name-only` against bootstrap deny paths: empty. |
| `goNoGoMatrix` | YES | **DOCUMENTED** — this document | Each gate has owner, status, evidence, and timestamp. |
| `redactedEvidencePolicy` | YES | **PASS** — evidence is redacted/source-only | No raw secrets, private paths, provider IDs, terminal ACK mutations, or raw session dumps in evidence. |
| `operatorApproval` | YES | **NO-GO / Waiting** — no explicit operator approval | No approval comment on #459 naming visibility/publication action. |

Aggregate: **NO-GO** (fail-closed default). 2/8 gates PASS; 5/8 are NO-GO/Waiting; 1/8 (goNoGoMatrix) is DOCUMENTED but not GO until all required gates are GO.

### 2.7 Rollback/No-Op Rules

Carried forward from the release-readiness matrix. These rules apply identically:

**GitHub 403 rollback** — If GitHub API returns 403 during evidence posting or issue operations, record 403 evidence, do not retry, transition to BLOCKED. Never deletes comments, reopens issues, mutates terminal outbox, restarts services, sends provider messages, or modifies databases.

**Evidence idempotency** — Each lane projection uses a `projectionKey` and replay with identical key returns existing projection. Idempotency is fixture-verified for GitHub comment projections.

**No-op safety invariants**:
1. Read-only scans never mutate state.
2. Fail-closed gates default to NO-GO when evidence is missing.
3. Provider accepted-send evidence is never treated as terminal ACK, read/visibility proof, or operator approval.
4. Runtime/bootstrap hygiene failure blocks PR/Done evidence production.
5. Redacted evidence policy blocks raw session dumps, private paths, and provider identifiers.

### 2.8 Remaining GO/NO-GO Decision Points

| # | Item | Gate | Required to close | Current status | Operator action |
|---|------|------|-------------------|----------------|-----------------|
| B1 | External secret/history scanner | `externalScannerEvidence` | Install `gitleaks`/`trufflehog`; run `npm run scan:external-secrets`; disposition findings | **NO-GO** — scanner unavailable in runner | Run in operator environment |
| B2 | Replay-safe proof | `replaySafety` | No-live broker simulation or approved one-event canary proving idempotency, stale suppression | **NO-GO** — contract fixtures validate design; runtime replay requires broker | Lane 3 (nosuk, a2a-broker#921) expected to provide replay evidence |
| B3 | Terminal evidence for candidate flow | `terminalEvidence` | Link redacted terminal evidence showing requester/operator-visible receipt for a candidate flow | **NO-GO** — this lane produces only source/docs evidence | Combined from all 4 lane outputs after this pack closes |
| B4 | Package build verification | `package-build` (subsumed into gate spec) | `tsc`-equipped environment; `npm run check:packages` passes for broker, plugin, docker-runner | **NO-GO** — `tsc` unavailable | Run in operator or build environment; or add `npx tsc` to runner |
| B5 | Explicit operator approval | `operatorApproval` | Separate comment on #458 or #459 naming exact visibility/publication action | **NO-GO** — no approval comment | Post approval comment |
| B6 | Public/private boundary | `publicPrivateBoundary` | Repo remains private; docs contain no private context | **NO-GO / Waiting** — no visibility change performed | Only when operator approves |
| B7 | All 8 gates GO | `goNoGoMatrix` | Every required gate GO | **NO-GO** — 5/8 gates are NO-GO/Waiting | Resolve each gate |

---

## 3. Cross-Lane Check

### 3.1 Release-blocker proof pack lanes (from parent [#458](https://github.com/jinwon-int/a2a-plane/issues/458))

| Lane | Worker | Child issue | Start comment | Focus |
|------|--------|-------------|---------------|-------|
| Lane 1 | bangtong | [a2a-docker-runner#335](https://github.com/jinwon-int/a2a-docker-runner/issues/335) | [✔ posted](https://github.com/jinwon-int/a2a-docker-runner/issues/335) (seoseo-ai) | Runner package build verification and redacted artifact proof |
| Lane 2 | sogyo | [openclaw-plugin-a2a#448](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/448) | [✔ posted](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/448) (seoseo-ai) | Plugin diagnostics, package smoke, and visibility proof |
| Lane 3 | nosuk | [a2a-broker#921](https://github.com/jinwon-int/a2a-broker/issues/921) | [✔ posted](https://github.com/jinwon-int/a2a-broker/issues/921) (seoseo-ai) | Broker replay-safe/idempotency proof and scanner evidence export |
| Lane 4 (this) | yukson | [a2a-plane#459](https://github.com/jinwon-int/a2a-plane/issues/459) | [✔ posted](https://github.com/jinwon-int/a2a-plane/issues/459) (seoseo-ai) | Cross-repo proof matrix and GO/NO-GO checklist |

All four Start comments were posted by `seoseo-ai` (Team1 broker/finalizer) within the same minute. No sibling lane has closed or produced a PR yet at the time of this lane's execution.

**Cross-check finding:** Lanes 1–3 each specialize in one package repo and are expected to produce targeted proofs:
- Lane 1 (bangtong, docker-runner) → package build verification for R3; artifact hygiene.
- Lane 2 (sogyo, plugin) → operator-visible diagnostics and package/install smoke for R2.
- Lane 3 (nosuk, broker) → replay-safe/idempotency proof and scanner evidence export for R1.

This lane (4) provides the cross-cutting proof matrix covering all four repos, conformance checks, approval gates, and rollback rules. No overlap or conflict detected with expected sibling lane scope.

### 3.2 Predecessor release-readiness pack closeout

The predecessor pack (`a2a-team1-release-readiness-pack-20260526T054020KST`) closed with merged PRs:

| Lane | PR | Status |
|------|----|--------|
| Lane 1 (bangtong) | [a2a-docker-runner#334](https://github.com/jinwon-int/a2a-docker-runner/pull/334) | MERGED |
| Lane 2 (sogyo) | [openclaw-plugin-a2a#447](https://github.com/jinwon-int/openclaw-plugin-a2a/pull/447) | MERGED |
| Lane 3 (nosuk) | [a2a-broker#920](https://github.com/jinwon-int/a2a-broker/pull/920) | MERGED |
| Lane 4 (yukson) | [a2a-plane#457](https://github.com/jinwon-int/a2a-plane/pull/457) | MERGED |

The NO-GO items documented in the predecessor matrix (N1–N6) are the exact targets this pack is designed to address. The predecessor matrix remains the authoritative source for the baseline state; this document provides the proof-depth assessment.

---

## 4. Verification Output

All commands run from `/work/repo` at run time:

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

# Terminal brief routing guard
$ npm run check:terminal-brief-routing
terminal brief routing guard ok: 41 production routing files checked; direct Telegram/curl sends blocked

# Message-ID ACK boundary
$ npm run check:message-id-ack-boundary
{"ok":true,"message":"no provider-message-id-as-ACK wording found"}

# Public-readiness scan (internal)
$ npm run scan:public-readiness
{"ok":true,"findings":[]}

# Fail-closed readiness gates (spec check — no input)
$ npm run scan:readiness-gates
{"ok":true,"phase":"spec","decision":"NO-GO","requiredGates":[
  "publicPrivateBoundary","terminalEvidence","replaySafety",
  "externalScannerEvidence","runtimeBootstrapHygiene",
  "goNoGoMatrix","redactedEvidencePolicy","operatorApproval"
]}

# External secret scanner
$ npm run scan:external-secrets
external secret/history scan blocked: no supported external scanner found.

# Release gate tests (JS conformance — 382 pass)
$ npm run test:release-gate
# pass 382
# fail 0

# Conformance contract fixtures + terminal evidence boundary
$ npm run test:conformance
{"ok":true,"checkedFixtures":["fixtures/contract/task-lifecycle.json",...,"fixtures/contract/adapter-receipt-capability.json"]}
{"ok":true,"checkedFixtures":["fixtures/terminal-evidence/accepted-send-non-ack.json","fixtures/terminal-evidence/github-comment-projection.json"]}

# Package checks (tsc gap confirmed)
$ npm run check:packages
FAIL — packages/broker: sh: 1: tsc: not found

# GitHub issue/comments — Start posted on #459
Start comment URL: https://github.com/jinwon-int/a2a-plane/issues/459#issuecomment-4537357237

# Sibling lane Start comments verified:
# Lane 1: https://github.com/jinwon-int/a2a-docker-runner/issues/335
# Lane 2: https://github.com/jinwon-int/openclaw-plugin-a2a/issues/448
# Lane 3: https://github.com/jinwon-int/a2a-broker/issues/921
```

---

## 5. Risk Notes

1. **External scanner unavailable (BLOCKING)**: No `gitleaks` or `trufflehog` in runner. The `.gitleaks.toml` config exists but cannot be exercised. Fail-closed by design in scanner script and gate spec.
2. **Package build gap (BLOCKING for compilation)**: `tsc` not installed. Three TypeScript packages (broker, plugin, docker-runner) cannot be build-verified. All JS-level (382) conformance tests pass.
3. **No runtime replay proof (BLOCKING)** : Contract fixtures validate idempotent/replay-safe design; runtime replay requires a broker environment outside this lane. Lane 3 (nosuk) may provide this.
4. **No live/no-lite terminal evidence produced**: This lane is source/doc/proof only. Requester-visible evidence for this pack is the issue comments and PR. Candidate-flow terminal evidence is out of scope for the a2a-plane repo and requires lane 1–3 broker-level output.
5. **Cross-lane dependency**: This pack's aggregate GO/NO-GO requires all four lane outputs. At this snapshot, no sibling lane has produced a PR. The proof matrix captures the expected evidence items from each lane but cannot validate them until PRs are merged.
6. **Terminal ACK boundary design is robust**: Conformance tests, routing guard, message-ID boundary, and contract fixtures all enforce the distinction between accepted-send and terminal ACK. This is the strongest proof signal in this lane.

---

## 6. Changed Files

| File | Change type | Description |
|------|------------|-------------|
| `docs/validation/team1-yukson-release-blocker-proof-matrix.md` | NEW | This document — release-blocker proof matrix for four repos: scanner evidence, replay safety, package/build verification, requester-visible evidence, terminal ACK boundaries, approval gates, rollback/no-op rules, and remaining GO/NO-GO decision points |

---

## 7. Approval-Sensitive Blockers

| Blocker | Gate | Severity | Operator action |
|---------|------|----------|-----------------|
| No external scanner output | `externalScannerEvidence` | BLOCKING | Install `gitleaks`/`trufflehog` and run `npm run scan:external-secrets` before public visibility claim |
| No runtime replay-safe simulation | `replaySafety` | BLOCKING | Deploy no-live broker simulation or separately approved one-event canary (expected from lane 3) |
| No candidate-flow terminal evidence | `terminalEvidence` | BLOCKING | Link redacted terminal evidence showing requester/operator-visible receipt for candidate flow |
| Package TypeScript compilation unverified | `package-build` | BLOCKING (for build-completeness) | Run `npm run check:packages` in `tsc`-equipped environment |
| No explicit operator approval | `operatorApproval` | BLOCKING | Post approval comment on #459 naming exact visibility/publication action |
| Repo visibility unchanged | `publicPrivateBoundary` | BLOCKING (for public transition) | Operator-controlled; not part of this lane's scope |
| Go/No-Go matrix incomplete | `goNoGoMatrix` | BLOCKING | Wait for all 4 lane PRs, then re-evaluate aggregate gate status |

**Current aggregate decision: NO-GO / Waiting.** This is the expected fail-closed posture for a source-proof artifact. The proof matrix is documented and each NO-GO item has a named gate, current status, and required operator action. The terminal ACK boundary design is validated by multiple independent conformance checks. The remaining blockers are external (scanner binary, TypeScript compiler, broker runtime, operator approval) and require operator or sibling lane action.

**Verdict source-only: NO-GO.** Promotion to GO requires all of:
- External scanner evidence (gitleaks/trufflehog output with clean findings or operator-dispositioned findings)
- Replay-safe broker simulation (or approved one-event canary, expected from nosuk lane 3)
- Terminal evidence for a candidate flow showing requester/operator-visible receipt
- Package TypeScript build verification (broker, plugin, docker-runner) in a tsc-equipped environment
- Explicit operator approval comment on #459 or #458
- All 8 fail-closed gates transition to GO

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
