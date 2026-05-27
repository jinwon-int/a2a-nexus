# Terminal Brief Live Activation Approval Checklist

Issue: [a2a-plane#471](https://github.com/jinwon-int/a2a-plane/issues/471)
Run: `a2a-team1-terminal-brief-activation-checklist-20260527T113808KST`
Worker: yukson
Broker/finalizer: seoseo

This is the **single consolidated approval checklist** for future Terminal Brief live activation.
It references existing detailed runbooks and go/no-go matrices; it does not replace them.
All items are read-only documentation — no step in this document authorizes or performs
live activation.

## Safety Contract

- **This document does not approve live activation.**
- **Every deploy, restart, live provider send, manual ACK, replay, DB mutation, release, and credential change requires fresh explicit operator approval.**
- Provider accepted-send / message-id evidence is **send-acceptance telemetry only**, not read/visibility/Terminal ACK.
- Seoseo remains Team1 broker/finalizer of record.
- No production deploy, Gateway/broker/worker restart or reload, live provider/Telegram canary,
  production DB mutation/prune/migration, manual Terminal Brief ACK/replay, historical outbox replay,
  release/tag/npm publish, credential movement/change, secret value disclosure, repo visibility change,
  history rewrite, issue close/finalizer comment execution, or force-push without separate explicit
  operator approval.

## Prerequisite Documents

| Ref | Document | Covers |
|-----|----------|--------|
| [D1] | `packages/broker/docs/broker-docker-deployment-runbook.md` | Docker-only deploy, health check, rollback |
| [D2] | `packages/broker/docs/gateway-plugin-config-template.md` | Gateway plugin-level wiring, activation phases, rollback |
| [D3] | `packages/broker/docs/terminal-outbox-activation-runbook.md` | Outbox preflight, poll, receipt ACK separation, one-shot gate |
| [D4] | `packages/broker/docs/terminal-brief-r3-go-no-go-matrix.md` | G1–G7 activation gate matrix, approval-gated proof checklist |
| [D5] | `packages/broker/docs/terminal-brief-r4-automatic-receipt-ack-runbook.md` | Receipt vocabulary, automatic ACK contract, fuse behavior |
| [D6] | `packages/broker/docs/terminal-brief-live-readiness-go-no-go-matrix.md` | S1–S5 cross-stack validation, go/no-go by dimension |
| [D7] | `packages/broker/docs/terminal-brief-activation-report.md` | Repeatable no-live gate report, evidence flag semantics |
| [D8] | `packages/broker/docs/terminal-brief-reduced-polling-validation-matrix.md` | S1–S5 validation, no-live safety gate, broker/plugin/runner |
| [D9] | `packages/broker/docs/receipt-gated-ack-canary-runbook.md` | Receipt gated canary activation |
| [D10] | `packages/broker/docs/wake-on-task-live-canary-runbook.md` | Wake-on-Task live canary rollout and rollback |
| [D11] | `packages/broker/docs/command-center-closeout-checklist.md` | Read-only closeout verification |
| [D12] | `packages/broker/docs/docker-runner-rollout-runbook.md` | Docker runner rollout, feature flags, rollback |
| [D13] | `packages/broker/docs/terminal-brief-audit-heartbeat-stability.md` | Audit/heartbeat stability policy |

## Approval Gate Checklist

Each gate requires the operator to confirm the pass condition and record evidence
(bounded URL or redacted status) before proceeding to the next gate.

### Gate 0: Preflight — Safety State Check

**Requires: no operator approval — read-only**

| # | Check | Pass condition | Verification command |
|---|-------|---------------|---------------------|
| 0.1 | Broker health | `/health` returns `ok:true`, service=`a2a-broker` | `curl -sf http://127.0.0.1:8787/health \| jq .` |
| 0.2 | Terminal-outbox preflight (no-live) | `providerCalled=false`, `productionAckAttempted=false`, `brokerHttpRequested=false` | `npm run terminal_outbox_preflight -- --no-live --json` |
| 0.3 | Live readiness canary (no-live) | `brokerHttpRequested=false`, `providerCalled=false`, `dbMutationAttempted=false`, `terminalAckAttempted=false` | `npm run live_readiness_canary -- --no-live --json` |
| 0.4 | Activation gate report (no-live) | Renders `Block` with all gates pending | `npm run terminal_brief_activation_report -- --markdown` |
| 0.5 | Current deploy revision recorded | Image tag/SHA documented | `docker images a2a-broker --format '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}'` |
| 0.6 | Receipt/ACK boundary review | All four receipt levels distinct; accepted-send is non-ACK | See [D5] §Receipt vocabulary |
| 0.7 | Approval-sensitive operations listed | All restricted operations explicitly called out | Gate 5 below |

### Gate 1: Broker Deploy Revision — Docker-Only

**Requires: operator approval for deploy**

| # | Check | Pass condition | Source ref |
|---|-------|---------------|------------|
| 1.1 | Broker image built via Docker | Docker Compose build, no system service install | [D1] §1 |
| 1.2 | Image tag/SHA recorded | Pinned to a named revision | `docker images a2a-broker` |
| 1.3 | Environment configured | `.env` has minimum required entries, no secrets in git | [D1] §2 |
| 1.4 | Container deployed via `docker compose up -d` | Container `Up (healthy)` | [D1] §3 |
| 1.5 | Post-deploy health verified | `/health` returns expected payload with build revision | [D1] §4 |
| 1.6 | Edge secret verified (if enforced) | `401` without secret, `200` with secret | [D1] §4.2 |
| 1.7 | Docker healthcheck passes | `docker inspect` shows `healthy` | [D1] §4.3 |
| 1.8 | Terminal-outbox reachable | GET returns valid outbox response | [D1] §5 |
| 1.9 | Pre-deploy canary (no-live) passes | All no-live checks pass | [D1] §6 |
| 1.10 | No production DB mutation | Read-only verification only | [D1] Safety Gates |

### Gate 2: Gateway Plugin-Level Wiring

**Requires: operator approval for plugin config apply and Gateway restart**

| # | Check | Pass condition | Source ref |
|---|-------|---------------|------------|
| 2.1 | Plugin config prepared | `a2a-broker-adapter` config template filled with correct `baseUrl`, `requester` | [D2] Plugin Config Template |
| 2.2 | Plugin-level config only | No core Gateway config changes | [D2] Safety Gates |
| 2.3 | Phase 1 — Read-only bridge | All features disabled; plugin loads correctly | [D2] Phase 1 |
| 2.4 | Gateway restart for plugin activation | `openclaw gateway status` shows plugin loaded | [D2] Phase 1 |
| 2.5 | Phase 2 — Operator event bridge (opt-in, no notification) | `operatorEvents.enabled=true`, `notification.enabled=false` | [D2] Phase 2 |
| 2.6 | Phase 3 — Notification bridge (requires operator approval) | `notification.enabled=true` only after explicit approval | [D2] Phase 3 |
| 2.7 | Phase 4 — Wake-on-Task (opt-in) | `wakeOnTask.enabled=true` only after explicit approval | [D2] Phase 4 |
| 2.8 | Pre-apply validation | Broker healthy, outbox preflight passes, no-live canary passes | [D2] Pre-Apply Validation |
| 2.9 | Post-apply verification | Plugin loaded, broker connectivity, canary smoke passes | [D2] Post-Apply Verification |

### Gate 3: Bounded Live Canary Task

**Requires: operator approval for each live send**

| # | Check | Pass condition | Source ref |
|---|-------|---------------|------------|
| 3.1 | Fresh task defined | Newly created task ID (not reused history/backlog) | [D4] G4 |
| 3.2 | One-shot fuse verified | Repeat send with same task/key is blocked | [D4] G4; [D5] §Fuse behavior |
| 3.3 | Backlog drained or explicitly blocked | Current terminal-outbox rows are empty, receipt-confirmed, or allowlisted | [D5] §1 |
| 3.4 | Allowlist (if used) | Exact outbox/task IDs documented; no wildcards | [D4] §Approval-gated checklist |
| 3.5 | Canary task dispatched | Exactly one send attempt; provider accepted-send evidence recorded | [D4] G5 |
| 3.6 | Canary scope: one-shot only | No automated retry; manual retry requires fresh operator approval | [D4] Safety boundary |

### Gate 4: Rollback / No-Op Behavior

**Requires: no operator approval for dry-run verification**

| # | Check | Pass condition | Source ref |
|---|-------|---------------|------------|
| 4.1 | Notification bridge disable path known | Setting `notification.enabled=false` disables delivery | [D2] Rollback |
| 4.2 | Container stop/remove path known | `docker compose down` stops broker; `down -v` also removes volume | [D1] §10 |
| 4.3 | Plugin-level revert path known | Remove or disable `a2a-broker-adapter` from Gateway config | [D2] Rollback |
| 4.4 | UnACKed rows preserved | No ACK or cursor advancement from rollback | [D3] §Receipt Acknowledgment |
| 4.5 | No-live default restore verified | `operatorEvents.enabled=false`, `notification.enabled=false`, no provider send | [D5] §Enablement and restoration |
| 4.6 | Rollback exercise (dry-run) | Documented steps, no actual production revert | [D6] S3; [D4] §Rollback |
| 4.7 | Rollback decision matrix | Symptom → scope → action table referenced | [D12] §6.4 |

### Gate 5: Accepted-Send vs Read/Visibility/Terminal ACK Separation

**Requires: no operator approval — spec review**

This gate verifies the four-level receipt vocabulary is enforced everywhere:

| # | Check | Pass condition | Source ref |
|---|-------|---------------|------------|
| 5.1 | Provider accepted-send | Receipt level `provider_accepted` — NOT ACK-eligible | [D5] §Receipt vocabulary |
| 5.2 | Current-session/requester-visible | Receipt level `operator_visible` — ACK-eligible with proof | [D5] §Receipt vocabulary |
| 5.3 | Manual operator confirmation | Receipt level `operator_confirmed` — ACK-eligible with explicit approval | [D5] §Receipt vocabulary |
| 5.4 | Terminal-outbox ACK | Receipt level `receipt_confirmed` — final state, never inferred from provider send | [D5] §Receipt vocabulary |
| 5.5 | Activation report | Report renders `Block` if any receipt level is conflated | [D7] Gate semantics |
| 5.6 | Evidence projection | No evidence line promotes `providerAccepted` to ACK | [D6] S5 |

### Gate 6: Explicit Approval Gates

**Requires: operator presence — verification step**

Each of the following actions requires separate, explicit operator approval:

| # | Action | Approval required before | Source ref |
|---|--------|------------------------|------------|
| 6.1 | Broker Docker deploy | `docker compose up -d` | [D1] §3 |
| 6.2 | Gateway plugin config apply | Writing plugin config file | [D2] Phase 3 |
| 6.3 | Gateway restart/reload | `openclaw gateway restart` or equivalent | [D2] Post-Apply |
| 6.4 | Live provider/Telegram send | `notification.enabled=true` + dispatch | [D4] G4 |
| 6.5 | Manual terminal-outbox ACK | POST `/a2a/tasks/terminal-outbox/ack` | [D3] §6 |
| 6.6 | Production DB mutation | Any SQLite write outside read-only path | [D1] Safety Gates |
| 6.7 | Historical outbox replay | `reconcile_unacked=true` or batch ACK | [D3] §5 |
| 6.8 | Release/tag/npm publish | `npm publish`, `git tag`, release creation | Contract |
| 6.9 | Credential/secret change | Edge secret rotation, token update | [D1] Safety Gates |
| 6.10 | Repository visibility change | Public/private toggle, collaborator change | Contract |

### Gate 7: Verification Output

**Requires: no operator approval — read-only evidence**

| # | Check | Expected output | Command |
|---|-------|----------------|---------|
| 7.1 | Broker health | `{"ok":true,"service":"a2a-broker"}` | `curl -sf http://127.0.0.1:8787/health \| jq '{ok, service, version}'` |
| 7.2 | Docker container status | `Up (healthy)` | `docker compose ps` |
| 7.3 | Terminal-outbox preflight | `{"ok":true,"providerCalled":false,"productionAckAttempted":false,"brokerHttpRequested":false}` | `npm run terminal_outbox_preflight -- --no-live --json` |
| 7.4 | Live readiness canary (no-live) | `{"brokerHttpRequested":false,"providerCalled":false,"dbMutationAttempted":false,"terminalAckAttempted":false}` | `npm run live_readiness_canary -- --no-live --json` |
| 7.5 | Activation gate report | `Block` with gates pending; safety block present | `npm run terminal_brief_activation_report -- --markdown` |
| 7.6 | Gateway plugin status | Plugin loaded with config | `openclaw gateway status` |
| 7.7 | Worker registration | Workers `online`, `lastSeenAt` fresh | `curl -sf "http://127.0.0.1:8787/workers" \| jq .` |
| 7.8 | Receipt/ACK boundary test | Accepted-send proof non-ACK; operator-visible receipt separate | `node --test scripts/check-message-id-ack-boundary.mjs` |

### Gate 8: Risk Notes and Approval-Sensitive Blockers

| Risk | Description | Severity | Mitigation |
|------|-------------|----------|------------|
| R1 | Stale terminal-outbox rows replayed during activation | High — could send duplicate notifications | Run [D3] §1 backlog drain/replay check before Gate 3 |
| R2 | One-shot fuse not engaged; duplicate provider send | High — Telegram double-send | Confirm one-shot fuse active per [D5] §Fuse behavior |
| R3 | Config typo or accident enables notification bridge prematurely | Medium — unintended live send | Apply [D2] Phase 1 (all disabled) first; escalate phase by phase |
| R4 | Gateway restart not coordinated with broker session state | Medium — stale locks or cursor loss | Coordinate restart window; run [D3] §5 reconcile post-restart |
| R5 | Provider accepted-send treated as operator receipt | Medium — false GO | Enforce [D5] receipt vocabulary at every gate |
| R6 | Docker image drift between canary and production | Low — unreproducible activation | Pin exact image tag; record SHA in evidence |
| R7 | Runtime/bootstrap context files enter branch artifacts | Medium — PR blocked | Run hygiene scan before any PR/artifact publication |
| R8 | Cross-team parity not verified before live send | Medium — operator confusion | Require Team2 evidence aligned on receipt/ACK/rollback [D4] G9 |

## Activation Sequence (Summary)

This is the high-level operator sequence for the activation window. Each numbered
step is approval-gated where noted.

```
  ┌───────────────────────────────────────────────────────────┐
  │ Preflight (Gate 0) — no approval required                 │
  │   • Health, outbox preflight, canary, activation report   │
  │   • Record current deploy revision                        │
  └─────────────────────────────────┬─────────────────────────┘
                                    │
  ┌─────────────────────────────────▼─────────────────────────┐
  │ Gate 1: Broker Deploy — operator approval required        │
  │   • Build, configure, deploy via Docker only              │
  │   • Post-deploy health, edge secret, docker healthcheck   │
  │   • Pre-deploy no-live canary                             │
  └─────────────────────────────────┬─────────────────────────┘
                                    │
  ┌─────────────────────────────────▼─────────────────────────┐
  │ Gate 2: Gateway Plugin Wiring — approval per phase        │
  │   • Phase 1: read-only bridge (no approval)               │
  │   • Phase 2: operator events bridge (opt-in)              │
  │   • Phase 3: notification bridge (operator approval)      │
  │   • Phase 4: wake-on-task (operator approval)             │
  └─────────────────────────────────┬─────────────────────────┘
                                    │
  ┌─────────────────────────────────▼─────────────────────────┐
  │ Gate 3: Bounded Canary — operator approval for send       │
  │   • Fresh task, one-shot fuse, backlog cleared            │
  │   • Exactly one send attempt                              │
  └─────────────────────────────────┬─────────────────────────┘
                                    │
  ┌─────────────────────────────────▼─────────────────────────┐
  │ Gate 4: Rollback — no approval for dry-run verification   │
  │   • Disable bridge path, container stop, plugin revert    │
  │   • No-live default restore verified                     │
  └─────────────────────────────────┬─────────────────────────┘
                                    │
  ┌─────────────────────────────────▼─────────────────────────┐
  │ Gate 5-8: Receipt Separation, Approval Gates,             │
  │           Verification, Risk Review — no approval         │
  │   • Enforce 4-level receipt vocabulary                   │
  │   • List all approval-sensitive operations                │
  │   • Run verification commands                             │
  │   • Review risk notes and blockers                        │
  └─────────────────────────────────┬─────────────────────────┘
                                    │
  ┌─────────────────────────────────▼─────────────────────────┐
  │ Final: Post evidence                                       │
  │   • Gate status per item with bounded evidence URLs        │
  │   • Changed files list (none = read-only validation)      │
  │   • Risk notes and blocker disposition                    │
  │   • Runtime/bootstrap hygiene scan passed                  │
  └───────────────────────────────────────────────────────────┘
```

## Runtime/Bootstrap Hygiene

Before PR creation or Done evidence publication, fail closed if any OpenClaw
runtime/bootstrap context file would enter the branch diff, PR body, issue
comments, or artifact bundle. Offending paths must be reported exactly:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

Evidence must also avoid secrets, provider targets, chat IDs, raw session dumps,
private host paths, raw task payloads, and unredacted logs.

## Changed Files

| File | Change | Purpose |
|------|--------|---------|
| `packages/broker/docs/terminal-brief-live-activation-approval-checklist.md` | New | Consolidated approval checklist for issue #471 |
| `scripts/check-team1-yukson-terminal-brief-live-activation-checklist.test.mjs` | New | Validation test for the checklist document |
| `package.json` | Modified | Add `check:team1-yukson-live-activation-checklist` script entry |

## Closeout Evidence

This document is the approval checklist deliverable for issue #471. It does not
perform or approve live activation. All gates above remain `NO-GO / Waiting` for
any live action until the operator explicitly approves each gate.

- Start comment: Already posted by seoseo-ai on [#471](https://github.com/jinwon-int/a2a-plane/issues/471)
- PR: Created by the runner
- Done: This checklist documents all required coverage
- Block: N/A — no safety violation detected
