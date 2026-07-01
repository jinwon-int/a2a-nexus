# Team1 Roadmap Input — nosuk (2026-05-09)

**Parent issue:** #105 (a2a-plane#105, internal tracker private)
**Child issue:** #108 (a2a-plane#108, internal tracker private)
**Angle:** verification strategy, safety gates, scanner/readiness evidence, CI/test matrix, rollback/no-go criteria.

---

## North-Star: What a2a-plane Should Be Responsible For

a2a-plane is the **public, verifiable evidence surface for A2A task execution**. Its sole responsibility is to provide an operator-auditable, scanner-validated, and CI-gated monorepo that proves a task was dispatched, executed by a registered worker, and terminated with redacted Done/PR/Block evidence — without ever exposing private broker topology, worker internals, operator secrets, or raw execution dumps.

Concretely, a2a-plane owns:

- **Shared A2A contracts** (task lifecycle, terminal semantics, worker registration, compatibility matrix) as the single source of truth for public-safe integration surfaces.
- **Public-safe examples and fixtures** that demonstrate the broker→worker→evidence loop from a fresh checkout.
- **Integrated CI/test matrix** that gates every PR and branch tip on layout, package checks, public-readiness scan, compatibility-baseline validation, and external secret/history scan.
- **Redacted evidence artifacts** (PR links, check output, Block reasons) that operators can review without exposing private source repos.
- **Release-gate documentation** that defines exact GO/NO-GO criteria, rollback steps, and operator approval separation.

---

## Non-Goals: What Must Stay in Private/Source Repos or Operator-Only Flow

These **must never** land in a2a-plane, in tracked files, or in PR evidence:

| Concern | Home | Rationale |
|---|---|---|
| Broker endpoint URLs, edge secrets, worker tokens | `jinwon-int/a2a-broker` | Private topology; exposure = unauthorized task injection |
| Worker runtime configuration (node IDs, provider IDs, Telegram/Signal targets) | `jinwon-int/a2a-broker`, operator config | Provider identity correlation risk |
| Docker runner host paths, registry credentials, runtime env vars | `jinwon-int/a2a-docker-runner` | Runner sandbox escape surface |
| OpenClaw Gateway config, session keys, agent allowlists | `jinwon-int/openclaw-plugin-a2a` | Plugin-to-broker auth boundary |
| Production database contents, terminal-outbox payloads | Operator-managed infra | Data mutation audit trail |
| Raw session transcripts, internal logs, heartbeat state | Not in any repo | Runtime bootstrap hygiene |
| A2A Inspector internal conformance harness and live-send test fixtures | `jinwon-int/openclaw-plugin-a2a` | Live-send tests touch provider surfaces |
| Any file named `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or anything under `.openclaw/` | Never enters the branch | Per SECURITY.md runtime/bootstrap hygiene guard |

---

## 30 / 90 / 180-Day Roadmap

### 0–30 Days: Hardened Verification Baseline (NOW)

**Goal:** Every CI run produces auditable, scanner-backed evidence that a2a-plane is clean and the external scanner lane is no longer a blocker.

| # | Action | Deliverable |
|---|---|---|
| V1 | **Close the external scanner blocker.** Install `gitleaks` (primary) and `trufflehog` (secondary) in the CI/operator environment. Wire `npm run scan:external-secrets` into CI so it fails the gate on findings. | G2 gate flips from Blocked to GO (or clean disposition). |
| V2 | **Add a dedicated test matrix lane.** Create `.github/workflows/ci-test-matrix.yml` that runs per-package unit/smoke tests across the supported baseline combination: broker, plugin, runner. | Matrix badge in README; any regressing cell fails the gate. |
| V3 | **Add a redacted-evidence snapshot script.** `scripts/snapshot-redacted-evidence.mjs` that captures `npm run check` output, scanner disposition, and matrix results into a timestamped `evidence/` artifact. | One-command redacted evidence bundle for operator review. |
| V4 | **Document rollback and no-go criteria.** Add `docs/rollback-and-no-go.md` with exact triggers: what findings revert public-readiness, what matrix regressions block promotion, and how to execute a rollback. | Operator decision surface for regression response. |
| V5 | **Harden `.gitleaks.toml` allowlist.** Review every existing allowlist entry against the current tree; remove stale entries; add per-file annotations for any new false positives. | Allowlist is minimal and auditable. |

### 31–90 Days: CI-Gated Promotion Pipeline

**Goal:** Any operator can run a single command and receive a GO/NO-GO decision packet with linked evidence.

| # | Action | Deliverable |
|---|---|---|
| M1 | **Automated promotion evidence packet.** Evolve the snapshot script into `scripts/promotion-packet.mjs` that aggregates: public-readiness scan, external scanner output, test matrix pass/fail, compatibility-baseline check, and runtime/bootstrap hygiene — into one redacted JSON and one markdown decision table. | Single-command promotion evidence; no manual checklist assembly. |
| M2 | **Worker registration conformance test.** Add a contract-level test that validates broker→worker registration round-trips against `contracts/a2a/worker-registration.md` using only public-safe fixture data. | Regression signal if worker registration contract drifts. |
| M3 | **Terminal evidence validation test.** Add a contract-level test that validates Done/PR/Block evidence shapes against `contracts/a2a/terminal-semantics.md`. Reject any terminal evidence that includes provider-send claims as ACK. | Catches terminal-semantics violations before they reach operator review. |
| M4 | **Cross-repo drift detection.** Add a scheduled (weekly) CI job that diffs a2a-plane contract files against the corresponding source-of-truth files in `jinwon-int/a2a-broker` (read-only fetch via GitHub API) and flags drift. | Prevents silent contract divergence between public and private repos. |
| M5 | **Public-readiness scan rule registry.** Extract current `scan:public-readiness` rules into a documented, versioned rule file (`contracts/public-readiness-rules.yaml`) with rationale per rule, so new contributors understand what each rule guards. | Transparent, reviewable scan rule set. |

### 91–180 Days: Continuous Assurance and Operator Decision Surface

**Goal:** Public-readiness is a continuous property, not a one-time gate. Operators have a live decision dashboard.

| # | Action | Deliverable |
|---|---|---|
| L1 | **Continuous public-readiness monitoring.** The promotion packet runs on every push to the default branch. A per-commit status check (`public-readiness/gate`) shows green/red. Any red commit blocks promotion. | Continuous assurance; no more periodic "is it ready?" questions. |
| L2 | **Operator decision dashboard.** A single markdown file (`docs/operator-decision-dashboard.md`) auto-generated by CI on each push, showing: G1/G2/G3 state, scanner findings delta, matrix health, cross-repo drift status, and the exact command to run for promotion. | Operator decision surface is always current. |
| L3 | **Rollback automation.** `scripts/rollback.mjs` that, given a commit SHA, validates the rollback target passes all gates, produces a redacted rollback evidence packet, and leaves the operator approval step manual. | Safe, auditable rollback path; no one-command regression. |
| L4 | **External scanner rule hardening.** Based on 90 days of scanner findings and dispositions, harden `.gitleaks.toml` and add a `trufflehog` config. Document every allowlist entry with a permanent rationale linked to a GitHub issue. | Zero unexplained allowlist entries. |
| L5 | **Public beta readiness decision packet.** Produce the final pre-visibility-change evidence packet that an operator can review in under 15 minutes and issue a single explicit approval comment. | The last packet before 진원님 says GO. |

---

## Top 5 Risks / Blockers and Gates

| # | Risk | Severity | Mitigation | Gate |
|---|---|---|---|---|
| R1 | **External scanner unavailable.** `gitleaks`/`trufflehog` not installed in CI/operator env → G2 permanently blocked. | **Critical** | Install scanner tooling in CI; wire into `npm run scan:external-secrets`; fail the CI gate on scanner absence (not just on findings). | G2 must show clean or dispositioned scanner output. |
| R2 | **Upstream `openclaw/openclaw#78261` conflict unresolved.** PR is CONFLICTING/DIRTY with no maintainer action → Terminal Brief route never rolls out → G1 permanently blocked. | **High** | Cannot be resolved from a2a-nexus. Escalate via operator channel; document the exact upstream state in every promotion packet. | G1 requires merged + released + receipt proof. |
| R3 | **Contract drift between a2a-plane and private source repos.** Public contracts diverge from broker/plugin/runner source-of-truth → public evidence becomes misleading. | **High** | Weekly cross-repo drift detection CI job (M4). Flag drift as a promotion blocker. | Drift detection must pass before any promotion packet is valid. |
| R4 | **Runtime/bootstrap hygiene regression.** A future commit accidentally tracks `AGENTS.md`, `.openclaw/`, or similar → secret/history exposure in the public candidate. | **Medium** | `scan:public-readiness` already catches these; add a pre-commit hook; CI must fail immediately. | Public-readiness scan must pass with zero runtime/bootstrap findings. |
| R5 | **False GO from local-only scans.** Operator mistakes `npm run check` or `scan:public-readiness` output for external scanner evidence → G2 claimed GO without real scanner run. | **Medium** | Promotion packet script explicitly labels each scan's provenance (local vs. external). Operator dashboard shows separate G2 status with scanner name and version. | G2 evidence must include scanner binary name + version in output. |

---

## Suggested Next GitHub Epics / Issues

Epics for the `a2a-plane (internal tracker, private)` issue tracker:

1. **Epic: External Scanner Closure (G2)**
   - Install gitleaks in CI environment
   - Wire `npm run scan:external-secrets` into CI gate
   - Hard-minimize `.gitleaks.toml` allowlist
   - Document operator disposition process for any findings
   - Child issues: `#108` → scanner install, allowlist audit, CI wiring, disposition doc

2. **Epic: CI Test Matrix**
   - Per-package unit/smoke test matrix across broker + plugin + runner baselines
   - Matrix badge in README
   - Regression-on-red failure policy
   - Child issues: matrix workflow, per-package test targets, badge integration

3. **Epic: Promotion Evidence Automation**
   - Redacted evidence snapshot script
   - Promotion packet aggregator (JSON + markdown)
   - Operator decision dashboard auto-generation
   - Child issues: snapshot script, packet aggregator, dashboard template

4. **Epic: Contract Drift Detection**
   - Weekly cross-repo diff job (a2a-plane vs. a2a-broker contracts)
   - Drift-as-blocker promotion rule
   - Child issues: drift job, drift alert, promotion integration

5. **Epic: Rollback Path and No-Go Criteria**
   - `docs/rollback-and-no-go.md`
   - `scripts/rollback.mjs`
   - Rollback gate validation
   - Child issues: rollback doc, rollback script, gate integration

---

## If We Can Only Do One Thing Next, Do This

**Close the external scanner blocker (G2).** Install `gitleaks` in the CI environment, wire `npm run scan:external-secrets` into the CI gate so it fails on missing scanner (not just on findings), and produce the first clean or dispositioned scanner output. Every other roadmap item — promotion automation, drift detection, operator dashboard — depends on having real external scanner evidence. Without G2, the promotion pipeline is permanently blocked and no amount of local-gate polishing matters. The scanner is the single bottleneck between the current NO-GO/Waiting state and a credible operator visibility decision. Close it first, then build everything else on top of clean scanner evidence.

---

## Safety Confirmation

This document is **planning only**. It does not:

- Change repository visibility
- Deploy, restart, or reconfigure any broker/worker/Gateway service
- Mutate production databases or terminal-outbox records
- Send live provider, Telegram, or notification messages
- ACK terminal outbox records
- Rotate, disclose, or write secrets
- Include raw secrets, private hostnames, provider IDs, or host-private paths
- Rewrite Git history or force-push

**Public-readiness remains NO-GO.** This roadmap input is an opinion for operator review within the private candidate repository.
