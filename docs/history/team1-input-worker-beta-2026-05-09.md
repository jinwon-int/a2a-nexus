# Team1 Roadmap Input: workerBeta (Protocol Contract & Compatibility Surface)

> Worker: `workerBeta` | Angle: protocol contract, compatibility surface, docs/API semantics, public/private boundary clarity
> Parent: #105 (a2a-plane#105, internal tracker private) | Child: #107 (a2a-plane#107, internal tracker private)
> Date: 2026-05-09

## North-Star: What A2A Nexus Should Be Responsible For

A2A Nexus owns the **shared contract vocabulary** that makes broker → worker → runner task handoff durable across integrations. Its responsibility is not to be the broker, the runner, or any particular integration — it is to define and maintain the **protocol surface** that lets those components interoperate without coupling to each other's internals.

Concretely, A2A Nexus should be the single source of truth for:

1. **Task lifecycle semantics** — the state machine (`queued → claimed → running → done|pr|blocked`) and the evidence requirements at each terminal state.
2. **Worker registration and capability schema** — the stable fields (`workerName`, `capabilities`, `policyVersion`, `lastSeenAt`, `currentTaskId`) that read models and routing decisions depend on.
3. **Terminal evidence contract** — Done/PR/Block result shapes, the ACK boundary (provider-send ≠ terminal ACK), and safety-gate attestations.
4. **Compatibility matrix** — exact source baselines for every imported component (broker, plugin, runner, contracts) with required evidence before any public claim.
5. **Public/private boundary definitions** — what fields and identifiers belong in shared contracts vs. what must stay in private operator configuration (endpoints, secrets, topology names, provider IDs).

Everything else — broker HTTP routing, Docker runner exec details, OpenClaw plugin internals — is an implementation concern. A2A Nexus's value is the **contract**, not the implementation.

## Non-Goals: What Must Stay in Private/Source Repos or Operator-Only Flow

The following are explicitly **not** in A2A Nexus's contract scope and must remain operator-private or scoped within source repositories:

| Concern | Why It Stays Out | Where It Lives |
|---|---|---|
| Broker endpoint URLs, edge secrets, auth tokens | Credential material; exposing these breaks the public boundary | Operator environment, `jinwon-int/a2a-broker` private config |
| Worker host names, local paths, Docker/Podman mount details | Host-specific topology; not portable across integrations | `jinwon-int/a2a-docker-runner` private docs |
| Live provider/Telegram send configurations | Activation surface; contract must not encode delivery channels | Operator Gateway config, not in shared contracts |
| Terminal-outbox ACK mutation logic | ACK mutation is an operator-gated action, not a protocol primitive | Broker-private implementation |
| OpenClaw runtime version coupling | OpenClaw is the reference integration, not a required runtime; contracts must not assume OpenClaw internals | `jinwon-int/openclaw-plugin-a2a` |
| Secret rotation procedures and tooling | Operational concern; belongs in operator runbooks, not protocol docs | Operator environment |
| GitHub auth mount and network mode defaults for Docker runner | Trusted-operator modes, not safe multi-tenant defaults | `jinwon-int/a2a-docker-runner` |

These boundaries must be enforced by the **public-readiness scan** (`npm run scan:public-readiness`) before any contract file is considered public-safe.

## 30/90/180-Day Roadmap

### 30 Days: Contract Hardening & Boundary Enforcement

- [ ] Formalize contract versioning: adopt a `contracts/a2a/VERSION` file and semver-ish schema (`MAJOR.MINOR`) so consumers can detect breaking changes.
- [ ] Add a contract conformance test suite under `contracts/a2a/test/` that validates broker/plugin/runner behavior against the task-lifecycle state machine and terminal evidence shapes.
- [ ] Hard-code the public/private field allowlist into `npm run scan:public-readiness` — any unrecognized field in a contract file triggers a finding.
- [ ] Document the contract extension process: how a new capability label or evidence field gets proposed, reviewed, and added without breaking existing workers.
- [ ] Audit all existing contract files for implicit OpenClaw coupling and rephrase to integration-neutral language where possible.

### 90 Days: Compatibility Surface & Integration Readiness

- [ ] Publish a `contracts/compatibility/CHANGELOG.md` separate from the repo-level changelog that records every baseline update, reasoning, and evidence link.
- [ ] Define integration conformance levels:
  - **Level 0 (Reference):** OpenClaw plugin — full lifecycle, all evidence types, ACK boundary enforced.
  - **Level 1 (Compatible):** A non-OpenClaw integration that implements task claim/run/terminal and respects the ACK boundary.
  - **Level 2 (Minimal):** A read-only consumer that observes task state and terminal evidence without mutating anything.
- [ ] Produce an integration guide (`docs/integration-guide.md`) that walks through implementing a Level 1 worker against the A2A Nexus contracts using only public-safe interfaces.
- [ ] Run a dry-run "break the contract" exercise: intentionally change a terminal evidence field, observe what breaks, and document the blast radius in the compatibility matrix.
- [ ] Resolve all `absolute-private-path` and `private-topology-term` finding classes from the redacted readiness inventory with operator-reviewed disposition.

### 180 Days: Public-Ready Contract Surface & Governance

- [ ] Complete the external secret/history scanner lane (`npm run scan:external-secrets`) with clean output from at least one supported scanner (`gitleaks` or `trufflehog`).
- [ ] Establish a contract governance model: who can approve contract changes, what evidence is required (CI pass, compatibility check, operator sign-off), and how breaking changes are communicated.
- [ ] Produce a `contracts/DEPRECATION.md` policy: how deprecated fields are marked, minimum support window (e.g., 2 minor versions), and removal criteria.
- [ ] Freeze the `contracts/a2a/` surface as `v1.0.0` candidate with all conformance tests passing and compatibility matrix rows verified against live broker/plugin/runner baselines.
- [ ] Prepare the public-facing API reference doc (`docs/api-reference.md`) extracted from contract files, with every example redacted and every placeholder clearly marked.
- [ ] Final operator review: public/private boundary audit pass with explicit sign-off on every contract file before any public visibility decision.

## Top 5 Risks, Blockers, and Gates

| # | Risk / Blocker | Severity | Gate |
|---|---|---|---|
| 1 | **Upstream `openclaw/openclaw#78261` unmerged (CONFLICTING/DIRTY).** Terminal Brief route cannot prove current-session-visible receipt until the upstream PR is resolved, merged, released, and receipt-proofed. Contract claims about the ACK boundary are untestable in production conditions until this lands. | Critical | G1: upstream merge + rollout + receipt proof |
| 2 | **External secret scanner unavailable.** `npm run scan:external-secrets` fails closed because neither `gitleaks` nor `trufflehog` is installed in the operator environment. Contract files cannot be declared public-safe without external scanner evidence. | Critical | G2: external scanner clean output |
| 3 | **Contract drift across repos.** Broker (`jinwon-int/a2a-broker`), plugin (`jinwon-int/openclaw-plugin-a2a`), and runner (`jinwon-int/a2a-docker-runner`) each evolve independently. A contract change merged in the monorepo may be out of sync with source repo implementations. | High | Conformance test suite (30-day goal) + compatibility matrix refresh on every import |
| 4 | **Implicit OpenClaw coupling in contracts.** Current contract language occasionally assumes plugin-shaped consumers (e.g., "OpenClaw operator" in canonical demo). This weakens the public claim that A2A Nexus is integration-neutral. | Medium | Contract language audit (30-day goal) + integration-neutral conformance levels (90-day goal) |
| 5 | **No contract governance model.** Without a documented process for proposing, reviewing, and approving contract changes, breaking changes can land without notice. The compatibility matrix has no enforcement mechanism. | Medium | Contract governance doc + DEPRECATION policy (180-day goal) |

## Suggested Next GitHub Epics/Issues

**Epic: Contract Hardening (tracking issue in `a2a-plane (internal tracker, private)`)**

- **Issue 1:** Add `contracts/a2a/VERSION` and semantic versioning policy
- **Issue 2:** Build contract conformance test suite (`contracts/a2a/test/`)
- **Issue 3:** Public/private field allowlist for `npm run scan:public-readiness`
- **Issue 4:** Contract extension process documentation
- **Issue 5:** Integration-neutral language audit of all contract files

**Epic: External Scanner & Boundary Audit (tracking issue in `a2a-plane (internal tracker, private)`)**

- **Issue 6:** Install and run external secret scanner (`gitleaks` or `trufflehog`) with redacted output
- **Issue 7:** Public/private boundary audit pass with operator sign-off per contract file
- **Issue 8:** Resolve `absolute-private-path` and `private-topology-term` finding classes

**Epic: Compatibility Surface (tracking issue in `a2a-plane (internal tracker, private)`)**

- **Issue 9:** Compatibility CHANGELOG with baseline update record
- **Issue 10:** Integration conformance levels document (Level 0/1/2)
- **Issue 11:** Integration guide for non-OpenClaw workers
- **Issue 12:** "Break the contract" dry-run exercise

**Epic: Contract Governance & v1.0 Freeze (tracking issue in `a2a-plane (internal tracker, private)`)**

- **Issue 13:** Contract governance model and approval process
- **Issue 14:** Deprecation policy (`contracts/DEPRECATION.md`)
- **Issue 15:** Public-facing API reference doc from contract files
- **Issue 16:** v1.0.0 contract freeze with full conformance and compatibility evidence

## If We Can Only Do One Thing Next, Do This

**Build the contract conformance test suite.** A test suite that validates the broker, plugin, and runner against the task-lifecycle state machine and terminal evidence shapes is the single highest-leverage investment. It catches contract drift before it reaches the compatibility matrix, it makes the public/private boundary auditable (tests fail if private fields leak into contract shapes), and it gives every future integration a mechanical compliance target instead of a prose document to interpret. Without it, the contracts are aspirational; with it, they are enforceable.
