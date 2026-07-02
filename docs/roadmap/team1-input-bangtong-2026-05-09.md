# Team1 roadmap input — workerGamma

**Worker:** `workerGamma`
**Angle:** implementation ergonomics, public repo developer experience, release/PR evidence, what should be demo-ready first
**Parent:** #105 (a2a-plane#105, internal tracker private)
**Child:** #106 (a2a-plane#106, internal tracker private)
**Date:** 2026-05-09

---

## North-star

`a2a-plane` is the **public, developer-accessible reference plane for A2A task handoff**. It should own:

- The **broker contract** (task lifecycle, worker registry, status, terminal evidence) as a versioned, documented, stable interface.
- A **reference broker implementation** that anyone can clone, install (`npm ci --ignore-scripts --include=dev`), and run locally with a single command.
- The **Docker runner worker** as the canonical public example of an isolated, safe GitHub-patch worker.
- **Shared A2A contracts** (`contracts/a2a/`) that define task shape, terminal semantics (`PR`/`Done`/`Block`), and status transitions.
- A **five-minute quickstart** that works from a fresh checkout without operator-only infrastructure.

The public value proposition: someone reads the README, clones the repo, runs the quickstart, and sees a task flow from broker → worker → terminal evidence in under five minutes. Everything else is scaffolding around that experience.

---

## Non-goals

These must stay in **private/source repos or operator-only flows**:

| Area | Why it stays private |
|---|---|
| Production broker topology and routing keys | Contains hostnames, team identifiers, secret material |
| OpenClaw Gateway canary adapter internals | Lives inside the Gateway runtime; not a public artifact |
| Docker runner GitHub auth mounts and network configs | Trusted-operator modes, not safe multi-tenant defaults |
| Live provider/Telegram send paths | Require operator credentials and production channel config |
| Terminal-outbox ACK mutation logic | Production state machine; public docs describe semantics only |
| Historical commit histories from `a2a-broker`, `openclaw-plugin-a2a`, `a2a-docker-runner` | Sanitized squash imports only; raw histories contain private paths |
| Operator decision logs and redacted evidence dumps | Operator-only; public repo gets sanitized summaries |

---

## 30 / 90 / 180-day roadmap

### 0–30 days: demo-able loop

**Goal:** A new developer clones, installs, and sees a task complete end-to-end in under five minutes — with no operator intervention.

**Deliverables:**

- [ ] **Working `npm run start:local` for the broker** with a loopback-only HTTP listener and an in-memory worker registry.
- [ ] **Public-safe dummy/echo worker** (`npm run worker:echo`) that accepts any task and returns `Done` evidence.
- [ ] **Quickstart walk-through verified end-to-end** from a clean checkout (the `docs/quickstart.md` steps must pass without manual fixes).
- [ ] **CI gate that exercises the quickstart flow** (`npm run test:smoke` or equivalent) using only the dummy worker — no live sends, no auth.
- [ ] **Single merged PR** with the smoke-test CI lane as the capstone of this phase.

**Exit gate:** `npm run test:smoke` passes in CI on every push.

### 30–90 days: developer ergonomics baseline

**Goal:** External contributors can understand the codebase, run checks locally, and contribute a focused patch without asking an operator for help.

**Deliverables:**

- [ ] **Architecture decision records (ADRs)** in `docs/adr/` for the three key design choices:
  1. Why broker ↔ worker communication is HTTP/JSON-RPC rather than a message queue.
  2. Why the Docker runner is the canonical worker example (and what other worker shapes are possible).
  3. Why terminal evidence is `PR`/`Done`/`Block` (and what each means at the contract level).
- [ ] **`CONTRIBUTING.md`** with a clear patch workflow: fork, branch, `npm run check`, open PR, redacted evidence.
- [ ] **Broker API reference** (auto-generated or hand-written) in `docs/broker-api.md` covering task create, status poll, cancel, and worker registration.
- [ ] **Worker contract spec** in `contracts/a2a/worker.md` defining the interface a worker must satisfy.
- [ ] **Compatibility matrix** (`contracts/compatibility/matrix.md`) extended with this release baseline.
- [ ] **Release checklist** (`docs/release-checklist.md`) updated to include the smoke-test gate.

**Exit gate:** An external contributor following `CONTRIBUTING.md` can open a passing PR without operator guidance.

### 90–180 days: multi-worker, evidence quality, and release cadence

**Goal:** The plane supports multiple worker types with clear isolation, terminal evidence is auditable, and there is a documented release cadence.

**Deliverables:**

- [ ] **Second public worker example** (e.g., a no-live code-review lint worker) demonstrating that workers are pluggable without touching broker internals.
- [ ] **Worker isolation contract** — each worker declares its capabilities (`githubPatch`, `lintOnly`, `echo`) and the broker enforces capability gating.
- [ ] **Evidence chain** — every `PR`/`Done`/`Block` result links back to the originating task and the worker run ID for auditability.
- [ ] **Release process doc** (`docs/release-process.md`) covering semver for broker contracts, changelog generation, and release notes.
- [ ] **GitHub issue/epic templates** refined from real usage patterns in the 0–90 day period.
- [ ] **Public-readiness re-evaluation** against the updated `docs/public-readiness.md` gate table.

**Exit gate:** Two independent worker implementations coexist, a third-party developer can add a worker without broker changes, and every terminal result is traceable to source.

---

## Top 5 risks / blockers and gates

| # | Risk | Severity | Mitigation / Gate |
|---|---|---|---|
| 1 | **Quickstart does not work from a fresh checkout** — missing scripts, broken dependencies, or undocumented setup steps kill the first-impression developer experience. | 🔴 Critical | Gate: `npm run test:smoke` must pass in CI from a clean `npm ci --ignore-scripts --include=dev` on every push. No manual steps. |
| 2 | **External secret/history scanner remains uninstalled** — public-readiness stays NO-GO indefinitely because `npm run scan:external-secrets` fails closed. | 🔴 Critical | Gate: Install `gitleaks` or `trufflehog` in the operator CI environment before the 90-day mark. The public visibility decision is blocked without this. |
| 3 | **Broker contract churn breaks workers** — changes to task shape, status semantics, or terminal evidence format without versioning cause silent incompatibility. | 🟠 High | Gate: `contracts/a2a/` gets a versioned schema (JSON Schema or TypeScript types). CI validates that the broker and all bundled workers satisfy the contract. |
| 4 | **Docker runner auth assumptions leak into public docs** — examples or error messages that reference operator-only paths, tokens, or hostnames create a false impression that those are required. | 🟠 High | Gate: Public-readiness scan (`npm run scan:public-readiness`) must stay clean. Every example must use placeholders (`${PLACEHOLDER}` or `http://127.0.0.1`). |
| 5 | **OpenClaw coupling perception** — external developers treat A2A Nexus as "the OpenClaw broker" rather than an independent plane that OpenClaw happens to integrate with first. | 🟡 Medium | Gate: README, docs, and quickstart must introduce A2A Nexus first, OpenClaw second (as "first/reference integration"). Every doc must make this separation clear. |

---

## Suggested next GitHub epics / issues

1. **Epic: Five-minute quickstart gate** — umbrella for `npm run start:local`, `npm run worker:echo`, `npm run test:smoke`, and the CI lane. This is the single most important thing to ship.
2. **Epic: Developer contribution path** — `CONTRIBUTING.md`, ADRs, broker API reference, worker contract spec.
3. **Issue: External secret scanner installation** — track the operator-side installation of `gitleaks` or `trufflehog` so `npm run scan:external-secrets` passes. This is a dependency for public visibility.
4. **Issue: Worker capability contract** — define and enforce the `capabilities` field on worker registration so the broker can route tasks to qualified workers.
5. **Issue: Evidence chain audit field** — add `parentTaskId` and `workerRunId` to terminal evidence payloads.
6. **Epic: Second reference worker** — build and document a second worker (e.g., lint-only worker) to prove the plane is multi-worker.
7. **Issue: Release process and semver for contracts** — formalize how `contracts/a2a/` versions map to broker and worker compatibility.

---

## If we can only do one thing next, do this

**Ship the five-minute quickstart with a CI smoke-test gate.** Right now, the quickstart doc exists but references commands (`npm run start:local`, `npm run worker:echo`) that are not yet present or verified. The single highest-leverage action is to make those commands real, wire them into CI, and ensure that anyone who clones the repo can run a complete broker → worker → terminal-evidence loop without operator help, without live sends, and without guessing. Every other deliverable — ADRs, multi-worker support, release cadence — builds on the assumption that the basic loop works from a clean checkout. If the quickstart doesn't work, nothing else matters.
