# Public alpha hardening evidence (#1163)

This page records the public-alpha hardening slice opened after the first external directory listing merged. It is a redacted, public-safe closeout record for [#1163](https://github.com/jinwon-int/a2a-nexus/issues/1163), not approval for release, deployment, publication, repository settings mutation, or broad promotion.

## Scope

Goal: make A2A Nexus easy for an outside developer to evaluate from public repository material alone.

In scope:

- document and run a fresh clone smoke from a clean temporary checkout;
- verify the README quickstart path using public docs only;
- reconcile stale now-public wording without weakening release/tag/publish/deploy gates;
- ensure issue templates cover bug, feature, security contact, and public-readiness feedback;
- review repo settings/protection follow-up and keep mutation separate;
- keep external listing status linked from `docs/external-listings.md` and [#1160](https://github.com/jinwon-int/a2a-nexus/issues/1160).

Out of scope without separate explicit approval:

- production deploys, Gateway/broker/worker restarts, or live canaries;
- provider/Telegram/notification sends;
- production DB migration, prune, replay, terminal-outbox mutation, or ACK;
- release/tag creation, npm package publish, Docker/image publication, or package-publication metadata changes;
- secret/credential movement, rotation, or disclosure;
- repository settings mutation, branch-protection/ruleset changes, ownership transfer, or another visibility change;
- broad social/media promotion.

## Fresh clone smoke

Run from a clean temporary checkout of the candidate branch or merged commit:

```bash
npm ci --ignore-scripts --include=dev
npm run check
npm run test:conformance
npm run scan:public-readiness
npm run scan:external-secrets
```

Run record for this #1163 slice:

- checkout: `/tmp/a2a-nexus-1163-fresh-clone-latest/repo`
- command source: `git clone --depth 1 --branch feat/public-alpha-hardening-1163 https://github.com/jinwon-int/a2a-nexus.git repo`
- HEAD: `adb83a0d67ed04f3b6de3c768695d29ec0679040`
- started: `2026-07-01T09:26:47+09:00`
- completed: `2026-07-01T09:27:26+09:00`

| Command | Result | Public-safe disposition |
|---|---|---|
| `npm ci --ignore-scripts --include=dev` | exit `0` | Lockfile-respecting dependency install succeeded without lifecycle scripts; npm reported `added 15 packages` and `found 0 vulnerabilities`. |
| `npm run check` | exit `0` | Release gate selected `30/49` default steps and ended with `release gate ok`. |
| `npm run test:conformance` | exit `0` | Contract/conformance fixtures ended with `conformance ok: 10 checks`. |
| `npm run scan:public-readiness` | exit `0` | Public-readiness scanner returned `{ "ok": true, "findings": [] }`. |
| `npm run scan:external-secrets` | exit `0` | Direct scan reported `23 finding(s), 23 exact synthetic fixture finding(s)` and `external secret/history scan ok`; disposition: synthetic fixture findings only. |

The external secret scanner disposition is intentionally phrased so it does not require private operator knowledge: the allowed findings are synthetic fixture records checked into the repository for scanner regression coverage, not live credentials or operator environment data. Matched secret values are not copied into this public evidence record.

## README quickstart verification

The public docs path is:

1. read `README.md` → `Five-minute local quickstart`;
2. follow `docs/quickstart.md` with loopback-only broker URL `http://127.0.0.1:8787`;
3. use placeholder-only configuration and local fixtures;
4. run `npm run check` and `npm run check:quickstart-conformance` as documented verification.

This path must not require private broker URLs, private node IDs, provider IDs, Telegram IDs, production data, or operator-specific host paths.

## Wording reconciliation

The repository is already public alpha. Public-facing promotional copy must say that directly while preserving every stronger gate:

- public repository visibility does not imply stable release support;
- promotion/announcement, public docs site, release/tag, npm/Docker publication, production deployment, live operations, future visibility transfer, and repo settings changes remain separately approval-gated;
- no production or secret-bearing evidence is copied into public docs.

Historical readiness records may retain older private-state wording only when clearly labeled historical/superseded. Current announcement copy must not say that `a2a-nexus` remains private.

## Issue template coverage

Current public feedback surfaces:

| Feedback type | Surface | Expected handling |
|---|---|---|
| Bug | `.github/ISSUE_TEMPLATE/bug_report.yml` | Public-safe local reproduction and redacted evidence. |
| Feature | `.github/ISSUE_TEMPLATE/feature_request.yml` | Public-safe use case, proposal, boundaries, and verification. |
| Security | `.github/ISSUE_TEMPLATE/config.yml` contact link + `SECURITY.md` | Direct reporters away from public vulnerability details and toward GitHub private vulnerability reporting. |
| Public-readiness | `.github/ISSUE_TEMPLATE/readiness_task.yml` | Tracks readiness or promotion-readiness gates without authorizing release/deploy/settings mutation. |

`blank_issues_enabled: false` remains intentional so public feedback enters a template or the security/support contact links.

## Repo settings/protection checklist

Read-only review scope for #1163:

- confirm the current repository protection baseline is represented by file-backed checks where possible;
- keep branch protection/ruleset/CODEOWNERS enforcement/settings mutation out of this issue;
- if a mutation is needed, create a separately approved settings-change task that names the exact setting, target repository, rollback/no-op boundary, and verification path.

No repo settings mutation is performed by this hardening record.

## External listing status

`docs/external-listings.md` remains the tracker for the operator-approved external directory wave.

- First merged external listing: `sing1ee/a2a-directory` [#35](https://github.com/sing1ee/a2a-directory/pull/35).
- Remaining open listing PRs at the start of #1163: `ai-boost/awesome-a2a` [#138](https://github.com/ai-boost/awesome-a2a/pull/138) and `pab1it0/awesome-a2a` [#71](https://github.com/pab1it0/awesome-a2a/pull/71).
- Parent listing tracker: [#1160](https://github.com/jinwon-int/a2a-nexus/issues/1160).

## A2A evidence

Formal broker-alpha broker A2AD source-only/no-live rounds were dispatched for #1163. The useful finalizer lane identified two concrete requirements before closeout:

- stale current promotional wording must be reconciled now that the repository is public;
- a general feature request template is needed so bug, feature, security, and public-readiness feedback all have public-safe routes.

Some analysis lanes returned `sourceProjection.quality=zero_files`; those blocked lane outputs are not counted as substantive source review consensus, but they are retained as evidence that source-projection quality must be checked before treating A2AD analysis as quorum evidence.

Recorded broker evidence:

- initial round: `a2a-nexus-1163-public-alpha-20260701T001259Z`
  - `docs-public-state`, `fresh-clone-smoke`, and `issue-template-security` lanes returned blocked zero-file source-projection findings;
  - `finalizer-risk` returned `GO_WITH_CHANGES` and required 1:1 evidence mapping plus settings mutation split-out.
- retry round: `a2a-nexus-1163-public-alpha-r2-20260701T001527Z`
  - `public-wording` and `smoke-templates` again showed zero-file source-projection quality;
  - `finalizer` listed the exact closeout evidence needed before closing #1163.
- embedded-source finalizer round: `a2a-nexus-1163-public-alpha-r3-20260701T001804Z`
  - `public-hardening-review` was blocked because issue/README excerpts alone were insufficient for full acceptance;
  - `closeout-finalizer` completed and confirmed the stale promotion wording plus missing feature-template gap, while preserving source-only/no-live boundaries.

## Closeout checklist

- [x] Fresh clone smoke command results are attached to #1163 and summarized here.
- [x] README quickstart path is verified using public docs only.
- [x] Promotion copy no longer claims the repository remains private.
- [x] Feature request template exists and keeps approval-sensitive actions gated.
- [x] Repo settings changes, if any, are split into a separately approved task.
- [x] `docs/external-listings.md` and #1160 remain linked as listing evidence.
