# Public-Readiness GO/NO-GO Note (#919 / #922)

> **Historical note:** this GO/NO-GO record was written before the public flip. Repository visibility was later approved and executed in [#953](https://github.com/jinwon-int/a2a-nexus/issues/953) at SHA `33da866af9869281605d283220b0bddd3cda11fd`. The remaining NO-GO boundary applies to stable promotion, release/tag/npm/Docker/GHCR publication, production deploy/restart, DB/outbox mutation, provider send, secret movement, history rewrite, and future ownership/visibility transfer.
>
> **Aggregate decision at the time: NO-GO for visibility change and promotion.**
> Technical readiness evidence is recorded below. This note did **not** authorize
> repository visibility change, npm/Docker publication, GitHub release/tag,
> production deploy, broker/worker restart, database mutation, provider/Telegram
> send, terminal ACK/replay, secret movement, history rewrite, or force-push.
> Each of those actions requires separate explicit operator approval.

## Decision Matrix

This note closes the measurement gaps tracked in [#919](https://github.com/jinwon-int/a2a-nexus/issues/919)
(roadmap: public readiness gate closeout before promotion, refs #915) and
[#922](https://github.com/jinwon-int/a2a-nexus/issues/922) (public-readiness gate implementation wave).
All evidence below was collected on branch `a2a-patch-20260619-*-broker-beta-public-readiness-gate-worker-zeta`
at commit `0718352`; no visibility, publication, or promotion action has been performed.

| Gate | Status | Evidence |
|---|---|---|
| External secret/history scanner | **GO** (clean) | `gitleaks 8.30.1` ran `npm run scan:external-secrets` → 0 findings, exit 0. Config: `.gitleaks.toml`. Command shape documented below. |
| External harness conformance | **GO** | `check:external-harness-conformance` runs in core release-gate tier (inventory: `docs/ops/release-gate-step-inventory.json`). `npm run check` passes. `docs/quickstart.md` and `docs/external-harness-quickstart.md` audited — complete, non-truncated, loopback-only URLs, no-live language, non-ACK boundaries intact. |
| Runtime/bootstrap hygiene | **GO** | Branch diff excludes all deny paths (`AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `.openclaw/**`). No OpenClaw runtime/bootstrap files in working tree. |
| Operator approval for visibility | **NO-GO** | No explicit operator approval for repository visibility change exists. Required before any visibility or promotion action. |
| Promotional actions (deploy, publish, release) | **NO-GO** | Not executed, not authorized. Blocked by operator approval gate. |

## External Scanner Command Shape

Supported scanner: `gitleaks` (≥8.x). Installed via the operator environment's package
manager (e.g., `brew install gitleaks`, `go install github.com/gitleaks/gitleaks/v8@latest`,
or the [GitHub release binary](https://github.com/gitleaks/gitleaks/releases)).

Single-command scan (operator CI):

```bash
npm run scan:external-secrets
```

This invokes `scripts/external-secret-scan.mjs`, which:

1. Redacts all matched secret values with `--redact` — findings contain `"Secret": "REDACTED"`.
2. Allowlists `dist/` directories, test file paths, synthetic scenario codes, and `grantEvidenceAccepted=` literals via `.gitleaks.toml`.
3. Fails closed (exit 1) when no supported external scanner is installed.
4. Prints redacted metadata only; never emits raw secret values.

To run the scan natively without npm:

```bash
gitleaks detect --source . --redact --no-banner --verbose --no-git --config .gitleaks.toml --report-format json --report-path .tmp/gitleaks-external-secret-scan.json --exit-code 0
```

## External Secret Scan Disposition (this run)

```
external scan: gitleaks-filesystem
scanned ~12.8 MB in 1.23s
no leaks found
gitleaks ok: 0 finding(s), 0 allowlisted test/dist finding(s)
external secret/history scan ok
```

**Disposition: CLEAN — 0 findings, 0 redacted.** Evidence postdates the last
commit touching secrets-adjacent paths (`0718352`).

## Quickstart / External Harness Audit

- `docs/quickstart.md` (200 lines) — Complete. Covers prerequisites, smoke check,
  broker/worker/OpenClaw plugin setup, health verification, no-live task submission,
  teardown, safety checklist, and links to the external harness quickstart.
- `docs/external-harness-quickstart.md` (136 lines) — Complete. Covers safety
  boundary, no-live checks, fixture (`fixtures/external-harness/no-live-conformance.json`),
  worker lifecycle contract, Terminal Brief adapter contract, final count/broker
  closeout notes (refs `a2a-broker#689`, `a2a-broker#690`), required local gate,
  and public evidence checklist.
- All URLs are loopback (`http://127.0.0.1`) or GitHub issue links. No private
  endpoints, provider identifiers, or live production paths.
- Provider accepted/sent evidence is explicitly labeled non-ACK in both documents.

## Release Gate Inventory Verification

`check:external-harness-conformance` lives in the `core` tier of
`docs/ops/release-gate-step-inventory.json` and runs on every `npm run check`
(ordinary release gate path). The external harness no-live fixture
(`fixtures/external-harness/no-live-conformance.json`) and related docs are
validated during the run. No changes to the inventory are needed — the gate is
properly represented and CI-backed.

## Technical Readiness vs Approval-Gated Actions

**Technical readiness (GO):**
- External secret/history scanner: clean, gitleaks verified.
- External harness conformance: gate represented in release-gate inventory, all checks pass.
- Quickstart/external-harness docs: complete, non-truncated, safe for public review.
- Runtime/bootstrap hygiene: no deny-path files in branch or evidence.

**Approval-gated (NO-GO until explicit operator approval):**
- Repository visibility change (public/private toggle)
- npm package publication
- Docker/ghcr image publication
- GitHub release or tag creation
- Production broker/worker/Gateway deploy or restart
- Production database mutation, migration, or replay
- Live provider, Telegram, Hermes, or OpenClaw message send
- Terminal outbox ACK or replay
- Secret rotation, disclosure, or credential movement
- History rewrite or force-push
- Public announcement, docs site launch, or stable-release declaration

**This note confirms measurement readiness. It does not grant execution authority.**
Promotion and visibility actions remain separately approval-gated and must be
executed only with explicit operator approval in a linked issue/PR comment.
