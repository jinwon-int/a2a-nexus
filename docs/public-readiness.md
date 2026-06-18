# Public Readiness Gate

## Current state

> **Public-readiness state.** `jinwon-int/a2a-nexus` remains private unless a separate operator-approved GitHub visibility change is executed and evidenced. This document records readiness evidence and blockers; it does **not** authorize a repository visibility change.
>
> Remaining **NO-GO** items below are visibility/promotion blockers until explicitly dispositioned by the operator. Stable release, announcements, public docs site, npm/Docker publication, and repository visibility changes remain separate approval-gated actions.
>
> Current active A2A coordination has moved to [a2a-plane#506](https://github.com/jinwon-int/a2a-plane/issues/506) and [`docs/current-state.md`](current-state.md). Historical issues such as `#75` and `a2a-broker#294` are closed and should not be cited as active blockers.
>
> This page records redacted review evidence only; it does not authorize deploys, service restarts, production database mutations, live provider or Telegram sends, terminal-outbox ACK mutations, secret rotation, secret disclosure, history rewrites, or force-pushes.

## Team1 P0 public preflight decision table

Updated for run `team1-a2a-public-p0-20260507T221151Z` at `2026-05-07T22:16:10Z`.

| Decision surface | Current state | Operator decision impact | Evidence |
|---|---|---|---|
| Repository visibility | **Private / not changed by this document** | **NO-GO** until explicit operator approval names the visibility action | GitHub metadata must be rechecked before any visibility execution; historical readiness docs remain gate records |
| R4 closeout lanes | Closed and merged | Candidate evidence is available for operator review, but does not override the external scanner blocker | R4 lane table below |
| External secret/history scanner | **Blocked/Waiting**: `npm run scan:external-secrets` failed closed because no supported external scanner was installed in this runner | **NO-GO/Waiting** for promotion/stable-release; install `gitleaks` or `trufflehog` in the operator environment and rerun before promotion approval | `docs/security/r4-external-scan-and-freeze.md`; local command output is redacted and contains no findings payload |
| Local public-readiness/release gate | Passed in this run | Supports operator review, but is not a substitute for the external scanner lane | `npm ci --ignore-scripts --include=dev`, `npm run check`, `npm run scan:public-readiness`, `node scripts/redacted-readiness-inventory.mjs`, and `npm run test:release-gate` |
| Runtime/bootstrap hygiene | Clear for this branch/evidence when only tracked diff files are included | Fail closed if any runtime/bootstrap path enters the branch or evidence | Guard paths: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**` |
| Public docs/SECURITY/templates/CODEOWNERS/README decision surface | Updated for public-readiness review; historical private-candidate boundaries are archived | Ready for operator review; visibility and promotion remain separately approval-gated | `README.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/*`, `.github/pull_request_template.md`, `CODEOWNERS`, this page |

Explicit state split: the documentation surface is **ready for operator review**. The repository remains **private unless a separate visibility action is approved and evidenced**. Remaining NO-GO items include visibility and promotion/stable-release blockers (external scanner, terminal evidence, operator approval for visibility/promotion).

## R3 operator review state

Team1 R3 prerequisite lanes are closed and merged:

| Lane | State | Merged PR |
|---|---|---|
| Integrated CI release gate and compatibility baselines (`#16`) | Closed | `#29` |
| Public README, quickstart, security docs, and templates (`#17`) | Closed | `#27` |
| Broker-to-broker handoff protocol (`#23`) | Closed | `#28` |
| Final closeout table (`#19`) | Closed | `#26` |

Final local validation on the candidate tree passed at `2026-05-07T14:57:00Z`:

- `npm ci --ignore-scripts --include=dev`: passed.
- `npm run check`: passed; release gate completed layout, package checks, public-readiness scan, and compatibility-baseline validation.
- `node scripts/redacted-readiness-inventory.mjs`: passed and printed redacted metadata only; total `1` finding class remained for operator disposition (`absolute-private-path` in a test fixture path, no matched value printed).
- `npm run test:release-gate`: passed `3/3`.
- GitHub repository metadata: `jinwon-int/a2a-plane` was private at the time of this validation (now public since 2026-05-27).
- Runtime/bootstrap hygiene: no tracked or unignored runtime/bootstrap context paths are entering this branch or evidence; root public-readiness scan reported no findings.

## R4 final closeout state

Team1 R4 prerequisite lanes are closed and merged:

| Lane | State | Merged PR |
|---|---|---|
| `#32` | Closed | `#38` |
| `#33` | Closed | `#36` |
| `#34` | Closed | `#37` |

Final R4 closeout decision: this was **ready for operator visibility decision** at the time. Repository visibility remains a separate approval-gated action unless executed and evidenced. Remaining R4 blockers (external scanner, promotion gates) remain visibility/promotion blockers until dispositioned.

Final closeout PR for `#35` is this task PR, with parent tracking in `#31`.

Final R4 local validation on the closeout refresh passed at `2026-05-07T20:19:47Z` unless noted:

- `npm ci --ignore-scripts --include=dev`: passed.
- `npm run scan:public-readiness`: passed with no findings.
- `npm run check`: passed; release gate completed layout, package checks, public-readiness scan, and compatibility-baseline validation.
- `node scripts/redacted-readiness-inventory.mjs`: passed with redacted metadata only; total `2` finding classes remained for operator disposition (`absolute-private-path`, `private-topology-term`) with no matched values printed.
- `npm run test:release-gate`: passed `3/3`.
- `npm run scan:external-secrets`: blocked because no supported external scanner (`gitleaks` or `trufflehog`) was installed in this runner; this remains fail-closed external scanner evidence, not a substitute scan.
- Runtime/bootstrap hygiene: no tracked or unignored `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**` paths enter this branch or evidence.

This R4 closeout refresh performed only redacted repository evidence updates and local validation. It did **not** perform any repository visibility change, release, deploy, Gateway/broker/worker restart, production database mutation, live provider/Telegram send, terminal-outbox ACK, secret rotation, secret disclosure, history rewrite, or force-push.

## Team1 P0 libero aggregate closeout framework

Issue `#44` uses the read-only `npm run libero:public-preflight-closeout -- --input <redacted-evidence.json> --markdown` framework to aggregate the required `bangtong`, `sogyo`, and `nosuk` lanes before any public visibility decision. The framework fails closed as `Waiting` when any sibling lane is still active or missing, and as `Block` when terminal lane evidence, scanner evidence, safety flags, or approval separation are unresolved.

A promotion **GO** must not be declared unless both local public-readiness and external secret/history scanner evidence are clean, and operator approval is explicitly separated from any promotion execution step. Without explicit promotion approval from 진원님, the aggregate decision remains **NO-GO** for promotion even when all lanes and scanners are clean.

> **Note:** This document was written for public-readiness while the repository is private. The NO-GO criteria below apply to **visibility and promotion/stable-release readiness** unless a separate operator approval explicitly narrows or resolves a gate.

## Post-R5 A2A dispatch synthesis (Bangtong lane)

Parent: [#75](https://github.com/jinwon-int/a2a-plane/issues/75).

R5 lanes [#76](https://github.com/jinwon-int/a2a-plane/issues/76), [#77](https://github.com/jinwon-int/a2a-plane/issues/77), [#78](https://github.com/jinwon-int/a2a-plane/issues/78), and [#79](https://github.com/jinwon-int/a2a-plane/issues/79) are closed and merged via PRs [#80](https://github.com/jinwon-int/a2a-plane/pull/80), [#81](https://github.com/jinwon-int/a2a-plane/pull/81), and [#82](https://github.com/jinwon-int/a2a-plane/pull/82).

a2a-plane R4 follow-on PRs [#92](https://github.com/jinwon-int/a2a-plane/pull/92) and [#95](https://github.com/jinwon-int/a2a-plane/pull/95) are merged.

A follow-on A2A dispatch round cross-repo synthesis (post-merge state after `openclaw-plugin-a2a#235` and `a2a-broker#433/#434`):

| Lane | Repo | Issue | PR | Status |
|---|---|---|---|---|
| Sogyo (A2A Inspector conformance gate) | `jinwon-int/openclaw-plugin-a2a` | [#234](https://github.com/jinwon-int/openclaw-plugin-a2a/issues/234) | [#235](https://github.com/jinwon-int/openclaw-plugin-a2a/pull/235) | Merged |
| Nosuk (broker lifecycle → A2A 1.0 task mapping) | `jinwon-int/a2a-broker` | [#431](https://github.com/jinwon-int/a2a-broker/issues/431) | [#434](https://github.com/jinwon-int/a2a-broker/pull/434) | Merged |
| Yukson (Worker Capability/AgentCard registry) | `jinwon-int/a2a-broker` | [#432](https://github.com/jinwon-int/a2a-broker/issues/432) | [#433](https://github.com/jinwon-int/a2a-broker/pull/433) | Merged |

**Synthesis decision (historical): NO-GO / Waiting** at the time for visibility. Visibility remains approval-gated unless a separate operator-approved action is executed and evidenced; remaining blockers are visibility/promotion/stable-release.

- All three sibling cross-repo lanes are now merged (`openclaw-plugin-a2a#235`, `a2a-broker#433`, `a2a-broker#434`). This clears the sibling-lane blocker.
- Upstream PR [openclaw/openclaw#78261](https://github.com/openclaw/openclaw/pull/78261) is closed/superseded.
- External secret scanner unavailable (fail-closed) — remains a promotion blocker.
- Explicit operator approval for public repository visibility: **required before any visibility change; not granted by this document**.
- Repository visibility remains **private unless separately approved and evidenced**. A2A terminal evidence/replay-safety proof and clean scanner evidence remain visibility/promotion blockers.
- Issue [#75](https://github.com/jinwon-int/a2a-plane/issues/75) is now closed. The remaining promotion/stable-release evidence path is tracked by the current-state wave, starting at [#506](https://github.com/jinwon-int/a2a-plane/issues/506).

Relevant cross-repo guardrail docs:
- `contracts/a2a/task-lifecycle.md` — A2A task-state mapping reference.
- `contracts/a2a/worker-registration.md` — Worker registration and capability assumptions.
- `contracts/a2a/terminal-semantics.md` — Terminal ACK boundary.
- `docs/r6-terminal-brief-openclaw-routing-synthesis.md` — R6 upstream gate and no-bypass rules.

## R10 Team1/yukson public-readiness gate synthesis for #75/#294/#497

Parent: [#75](https://github.com/jinwon-int/a2a-plane/issues/75).
Roadmap: [a2a-broker#294](https://github.com/jinwon-int/a2a-broker/issues/294).
Operational risk signal: [a2a-broker#497](https://github.com/jinwon-int/a2a-broker/issues/497).
Lane: [#263](https://github.com/jinwon-int/a2a-plane/issues/263).

Team1/yukson added a no-live gate synthesis at `docs/validation/team1-yukson-public-readiness-gate-synthesis.md`. The aggregate decision remains **NO-GO / Waiting**: provider message ids and send success are accepted-send evidence only; terminal evidence, replay-safe canary proof, scanner/readiness evidence, broker state-growth/backlog risk disposition, runtime/bootstrap artifact hygiene, and explicit operator approvals remain separate gates.

This synthesis does not authorize repository visibility changes, live provider/Telegram sends, terminal ACKs, deploys/restarts, production DB mutation, secret changes, releases, or force-pushes.

## R11 Team1/yukson #240 closeout route for #75/#94

Parent: [#75](https://github.com/jinwon-int/a2a-plane/issues/75).  
Compatibility follow-up: [#94](https://github.com/jinwon-int/a2a-plane/issues/94).  
Ecosystem/monorepo clarity lane: [#240](https://github.com/jinwon-int/a2a-plane/issues/240).  
Review lane: [#271](https://github.com/jinwon-int/a2a-plane/issues/271).

Team1/yukson added `docs/validation/team1-yukson-240-closeout-to-75-94.md` as the checklist for reviewing #240 PRs [#267](https://github.com/jinwon-int/a2a-plane/pull/267) and [#268](https://github.com/jinwon-int/a2a-plane/pull/268) before citing them from #75 or #94.

The route is deliberately narrow: #267/#268 may clarify component boundaries, migration risks, and issue/link hygiene for public-safe review. They do **not** provide terminal receipt, replay-safe canary proof, external scanner evidence, operator visibility approval, runtime readiness, live-send approval, or release approval.

## R7 public-readiness closeout refresh (post-merge)

Bangtong lane closeout refresh after merged round `a2a-plane#92/#95`, `openclaw-plugin-a2a#235`, `a2a-broker#433/#434`.

Parent: [#75](https://github.com/jinwon-int/a2a-plane/issues/75).
Roadmap: [#294](https://github.com/jinwon-int/a2a-broker/issues/294).

Local validation on this closeout refresh:

- `npm ci --ignore-scripts --include=dev`: passed.
- `npm run scan:public-readiness`: passed with no findings.
- `npm run check`: release gate passed (layout, package checks, public-readiness scan, compatibility-baseline validation).
- `npm run test:release-gate`: passed (3/3).
- `npm run scan:external-secrets`: blocked — no supported external scanner (`gitleaks` or `trufflehog`) installed in this runner; remains fail-closed.
- Runtime/bootstrap hygiene: no tracked or unignored `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**` paths enter this branch or evidence.

Decision: **NO-GO / Waiting.**

- Sibling cross-repo lanes are now merged, clearing that blocker.
- `openclaw/openclaw#78261` is closed/superseded; do not claim that this closure itself unblocks Terminal Brief or public-readiness.
- External secret scanner evidence remains unavailable (fail-closed).
- Explicit operator approval for repository visibility is still required.
- Issue [#75](https://github.com/jinwon-int/a2a-plane/issues/75) is now closed; this historical section should not be used as the active blocker list.

This closeout refresh performed redacted documentation evidence updates and local validation only. It did **not** perform any repository visibility change, release, deploy, Gateway/broker/worker restart, production database mutation, live provider/Telegram send, terminal-outbox ACK, secret rotation, secret disclosure, history rewrite, or force-push.

## R9 Preflight Refresh: Upstream Conflict Gate (Bangtong lane)

Parent: [#75](https://github.com/jinwon-int/a2a-plane/issues/75).
Roadmap: [#294](https://github.com/jinwon-int/a2a-broker/issues/294).

Historical live preflight at dispatch (`team1-a2a-public-p0-next-round`) observed `openclaw/openclaw#78261` as OPEN/CONFLICTING/DIRTY. That state is now superseded by maintainer close; no upstream maintainer action is authorized from this repository.

This historical R9 conflict-gate shape is superseded by the maintainer close. The NO-GO decision remains, but the gate is now A2A-owned terminal evidence/replay-safety/scanner/operator approval rather than an upstream merge.

### G1 Gate Refinement: Upstream Conflict State

| Field | Previous State (R8) | Current State (R9 preflight) |
|---|---|---|
| PR status | Open, unmerged | Open, unmerged |
| Mergeability | `mergeable=MERGEABLE` (assumed) | `mergeable=CONFLICTING` |
| Merge state | Clean (assumed) | `mergeStateStatus=DIRTY` |
| Required action | Wait for merge + rollout + receipt proof | Wait for **upstream conflict resolution** → merge → rollout → receipt proof |

The conflict adds a prerequisite: even if rollout and receipt proof were ready, the PR cannot merge until the conflict is resolved upstream. This does not relax or bypass any existing gate.

### Aggregate Decision

**NO-GO / Waiting.** All three gates remain NO-GO. G1 is now gated on A2A terminal evidence plus replay-safe canary proof, not upstream #78261 merge. G2 requires external scanner tooling and clean output. G3 requires explicit operator approval separated from execution. Until all three gates are GO, `#75` must remain open.

### Seoseo Evidence Collection Checklist (updated for conflict gate)

Seoseo is responsible for collecting and linking the following evidence before requesting `#75` closeout. Items marked **(new)** are added for the CONFLICTING/DIRTY preflight state.

1. **G1 evidence (terminal evidence / replay-safe gate):**
   - [ ] Confirm `openclaw/openclaw#78261` is recorded as closed/superseded, not a merge gate.
   - [ ] Link to A2A Nexus contract/test evidence that provider message id/send success is provider accepted-send evidence only.
   - [ ] Link to a replay-safe one-event canary or no-live proof showing no duplicate/stale Terminal Brief replay.
   - [ ] Link to a follow-up proof (issue/PR comment or CI log) showing manual operator receipt or explicit ACK-safe receipt before terminal ACK. Provider acceptance or `messageId` alone is insufficient.

2. **G2 evidence:**
   - [ ] Install `gitleaks` and/or `trufflehog` in the operator environment.
   - [ ] Run `npm run scan:external-secrets` and link the output (redacted).
   - [ ] If findings exist, document operator disposition for each finding class.
   - [ ] Confirm the scanner evidence postdates the last commit touching secrets-adjacent paths.

3. **G3 evidence:**
   - [ ] Link to an explicit operator (진원님) approval comment in the `#75` issue or a linked decision issue.
   - [ ] The approval text must reference repository visibility/publication explicitly (not just "docs look good" or "checks passed").
   - [ ] Approval must be separate from any automation that would execute the visibility change.

4. **Cross-check evidence (all lanes):**
   - [ ] All sibling cross-repo lanes remain merged and unregressed (`openclaw-plugin-a2a#235`, `a2a-broker#433`, `a2a-broker#434`).
   - [ ] `npm run check` passes on the tip of the candidate branch.
   - [ ] `npm run test:release-gate` passes `3/3`.
   - [ ] `npm run scan:public-readiness` reports no new findings.
   - [ ] Runtime/bootstrap hygiene confirmed: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, and `.openclaw/**` are not entering the branch or evidence.
   - [ ] Repository visibility remains private unless a separate operator-approved GitHub visibility change is executed and evidenced. This document does not grant visibility approval.

Seoseo must link each piece of evidence in a comment on `#75`. Only when all checkboxes in this checklist are satisfied and the three GO/NO-GO gates are all GO may `#75` be considered for closeout.

This preflight refresh performed redacted documentation evidence updates and local validation only. It did **not** perform any repository visibility change, release, deploy, Gateway/broker/worker restart, production database mutation, live provider/Telegram send, terminal-outbox ACK, secret rotation, secret disclosure, history rewrite, force-push, or upstream maintainer action.

---

## R8 Operator Decision Packet: Public-Readiness GO/NO-GO Matrix (Bangtong lane) [SUPERSEDED by R9 above]

Parent: [#75](https://github.com/jinwon-int/a2a-plane/issues/75).
Roadmap: [#294](https://github.com/jinwon-int/a2a-broker/issues/294).

This packet is the Team1 next-round operator decision surface for `bangtong`. It distills the three remaining public-readiness gates into a single GO/NO-GO matrix and defines exactly what evidence `seoseo` must collect before closing `#75`. All sibling cross-repo lanes are merged (`openclaw-plugin-a2a#235`, `a2a-broker#433`, `a2a-broker#434`). Do **not** mark `#75` complete unless all three gates in this matrix are met.

### GO/NO-GO Decision Matrix

| Gate | Current State | Required for GO | NO-GO Trigger |
|---|---|---|---|
| **G1: Terminal evidence / replay-safe canary proof** | **NO-GO / Waiting.** PR [#78261](https://github.com/openclaw/openclaw/pull/78261) is closed/superseded; `providerAccepted`, `accepted`, `sent`, or Telegram `messageId` remain non-ACK evidence. | A2A Nexus contract/tests show provider message id/send success is accepted-send evidence only, and a replay-safe proof shows manual/proven ACK-safe receipt before terminal ACK. | Claiming GO because #78261 closed. Treating `providerAccepted`, `accepted`, `sent`, or Telegram `messageId` as terminal ACK evidence. |
| **G2: Final external scanner evidence** | **NO-GO / Blocked.** `npm run scan:external-secrets` exits non-zero because neither `gitleaks` nor `trufflehog` is installed in the runner environment. See `docs/security/r4-external-scan-and-freeze.md`. | `npm run scan:external-secrets` exits zero with clean findings (or findings dispositioned by operator with redacted evidence). At least one supported scanner (`gitleaks` or `trufflehog`) produces a clean report. | Claiming GO without scanner output. Running a local-only substitute (`npm run scan:public-readiness`, `node scripts/redacted-readiness-inventory.mjs`) and treating it as external scanner evidence. |
| **G3: Explicit operator approval for repository visibility/publication** | **Historical state.** Repository visibility remains private unless a separate operator-approved GitHub visibility change is executed and evidenced; no approval is granted by this document. | Future visibility transfers, publication, or promotion still require explicit operator approval in a linked issue/PR comment. Approval is separate from any execution step. | Claiming GO because "docs are ready" or "all checks passed." Executing a new visibility, publication, or promotion action without explicit operator approval. |

### Aggregate Decision

**NO-GO / Waiting.** All three gates are NO-GO. G1 requires A2A terminal evidence and replay-safe canary proof. G2 requires external scanner tooling and clean output. G3 requires explicit operator approval separated from execution. Until all three gates are GO, `#75` must remain open.

### Seoseo Evidence Collection Checklist (must complete before closing `#75`)

Seoseo is responsible for collecting and linking the following evidence before requesting `#75` closeout:

1. **G1 evidence:**
   - [ ] Link to `openclaw/openclaw#78261` close/superseded decision.
   - [ ] Link to A2A Nexus contract/test evidence that provider message id/send success is accepted-send evidence only.
   - [ ] Link to a follow-up proof (issue/PR comment or CI log) showing manual operator receipt or explicit ACK-safe receipt before terminal ACK. Provider acceptance or `messageId` alone is insufficient.

2. **G2 evidence:**
   - [ ] Install `gitleaks` and/or `trufflehog` in the operator environment.
   - [ ] Run `npm run scan:external-secrets` and link the output (redacted).
   - [ ] If findings exist, document operator disposition for each finding class.
   - [ ] Confirm the scanner evidence postdates the last commit touching secrets-adjacent paths.

3. **G3 evidence:**
   - [ ] Link to an explicit operator (진원님) approval comment in the `#75` issue or a linked decision issue.
   - [ ] The approval text must reference repository visibility/publication explicitly (not just "docs look good" or "checks passed").
   - [ ] Approval must be separate from any automation that would execute the visibility change.

4. **Cross-check evidence (all lanes):**
   - [ ] All sibling cross-repo lanes remain merged and unregressed (`openclaw-plugin-a2a#235`, `a2a-broker#433`, `a2a-broker#434`).
   - [ ] `npm run check` passes on the tip of the candidate branch.
   - [ ] `npm run test:release-gate` passes `3/3`.
   - [ ] `npm run scan:public-readiness` reports no new findings.
   - [ ] Runtime/bootstrap hygiene confirmed: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, and `.openclaw/**` are not entering the branch or evidence.
   - [ ] Repository visibility remains private unless a separate operator-approved GitHub visibility change is executed and evidenced. Future visibility transfers or publication actions remain approval-gated.

Seoseo must link each piece of evidence in a comment on `#75`. Only when all checkboxes in this checklist are satisfied and the three GO/NO-GO gates are all GO may `#75` be considered for closeout.

> **Note:** These gates were defined while the repository was private. They remain visibility and promotion/stable-release gates unless a separate operator approval explicitly narrows or resolves them.

## Promotion-readiness gates (was NO-GO gates)

The parent visibility tracker [#75](https://github.com/jinwon-int/a2a-plane/issues/75) and roadmap [a2a-broker#294](https://github.com/jinwon-int/a2a-broker/issues/294) are closed historical records. Use [#506](https://github.com/jinwon-int/a2a-plane/issues/506) and [`docs/current-state.md`](current-state.md) for current A2A coordination.

- [x] License decision approved and committed: MIT. NOTICE is not required for MIT unless future third-party notices require it.
- [x] Secret and history scan clean or explicitly dispositioned with redacted evidence for operator review: root scanner passed with no findings; redacted inventory reports metadata only and keeps matched values out of evidence.
- [x] Private topology, host names, local paths, Telegram/provider IDs, and real-looking fake credentials removed from public docs/examples or dispositioned for operator review.
- [x] Broker, plugin, runner, contracts, and examples import via sanitized/squash import.
- [x] Integrated CI/local gate passes: `npm ci --ignore-scripts --include=dev`, root `npm run check`, package-local checks, unit tests through package checks, public-readiness scan, and no-live release gate.
- [x] Compatibility matrix names exact broker/plugin/runner/OpenClaw baselines and passes the compatibility-baseline checker.
- [x] Shared A2A contracts document Done/Block/PR terminal semantics, provider-send versus ACK boundaries, worker registration/read-model assumptions, and broker-to-broker handoff boundaries.
- [x] Release notes state no deploy/restart/provider send/DB mutation/terminal ACK/visibility change was performed unless explicitly approved.
- [ ] Explicit operator approval for public repository visibility — required before any visibility change; not granted by this document.
- [ ] External secret/history scanner evidence from `npm run scan:external-secrets`, or explicit Block evidence that no supported scanner was available in the operator environment. *(Promotion blocker)*
- [ ] Final promotion-readiness PR/CI evidence. *(Promotion blocker)*

## Approval-gated transition plan (historical)

The [public transition smoke plan](./public-transition-smoke-plan.md) is the pre-public visibility checklist. No visibility transition is authorized by this document. The plan also serves as a reference for future promotion steps (stable release, announcements, docs site).

Still applies regardless of visibility:
- Do not publish npm/Docker artifacts without separate approval.
- Do not deploy, restart services, mutate production data, send provider/Telegram messages, ACK terminal outbox records, rotate/disclose secrets, rewrite history, or force-push without explicit operator approval.

## R4 evidence lane

See [R4 External Scan and Release Dry-Run Freeze](./security/r4-external-scan-and-freeze.md). R4 was a dry-run evidence lane while the repository was private. Use redacted evidence, and do not publish npm/Docker artifacts or create a public release without separate approval.

## R3 closeout validation

See [R3 Closeout Validation](./r3-closeout-validation.md). At the time this was **ready for operator visibility review**. Visibility remains a separate approval-gated action unless executed and evidenced.

## R3 security disposition

See [R3 Secret / History Scan Disposition](./security/r3-secret-history-disposition.md). The root scanner has no current token-shaped or runtime/bootstrap findings. The redacted inventory still records metadata for one absolute-path-shaped test fixture; matched values are intentionally not printed. Operator review may require an external scanner before visibility approval.

## Current source repos

- `jinwon-int/a2a-broker`
- `jinwon-int/openclaw-plugin-a2a`
- `jinwon-int/a2a-docker-runner`

The original source repositories and histories are not approved for public exposure as-is. Public review is scoped to the sanitized/squash monorepo candidate only.

## Review ownership

`CODEOWNERS` now records an interim private visibility-review owner so the file is no longer an empty placeholder. This is not a public maintainer roster; replace it with the approved public maintainer team before any repository visibility change.

## License decision

Operator decision for R2 gate #6: use MIT License for the A2A monorepo candidate. Public visibility was blocked at that time; granted 2026-05-27.
