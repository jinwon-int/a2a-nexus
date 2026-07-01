# Public feedback intake and monitoring evidence

This page tracks the public-safe intake checks for [#1169](https://github.com/jinwon-int/a2a-nexus/issues/1169) and the remaining external-listing boundary for [#1160](https://github.com/jinwon-int/a2a-nexus/issues/1160).

Status: **complete for #1169 closeout**. The repository has issue-form files and local validation passes. GitHub metadata still does not report rendered templates, so the chooser/API discrepancy is recorded as a live GitHub metadata limitation. External issue/PR monitoring is active through the repository webhook path; provider/Telegram notification canaries remain outside this issue.

## 2026-07-01 evidence

Initial #1169 documentation was checked against `main` commit `ca5ba9272bd0b46c2e0dace8cfccc22cbd465519`; the live monitoring setup was verified after `main` commit `1562a3b4f137bd63614abd954c8877f12662ccc0`.

### Issue Forms

Repository contents endpoint confirmed these files on the default branch:

- `.github/ISSUE_TEMPLATE/a2a_spec_first_change.yml`
- `.github/ISSUE_TEMPLATE/bug_report.yml`
- `.github/ISSUE_TEMPLATE/feature_request.yml`
- `.github/ISSUE_TEMPLATE/readiness_task.yml`
- `.github/ISSUE_TEMPLATE/config.yml`

Repo-local validation confirms the forms are parseable and public-safe:

- form files use `description:` and `title:` fields, not legacy-only `about:` fields;
- labels referenced by forms exist in the repository label set;
- `config.yml` sets `blank_issues_enabled: false` and routes security reports to the security policy;
- `scripts/check-repo-protection-baseline.mjs` reports five template files and four renderable Issue Forms;
- `scripts/lib/public-alpha-hardening.test.mjs` covers bug, feature, security contact, and public-readiness feedback.

Live GitHub metadata still needs follow-up:

- `gh repo view --json issueTemplates,isBlankIssuesEnabled` returned `issueTemplates: []` and `isBlankIssuesEnabled: true`.
- `repos/jinwon-int/a2a-nexus/community/profile` returned `files.issue_template: null` even though the contents API can read `.github/ISSUE_TEMPLATE/*`.
- An unauthenticated browser request to `/issues/new/choose` redirected to GitHub login, so it was not a reliable live chooser render check.

Decision: do not treat the GitHub metadata response as proof that Issue Forms are absent. The default-branch files exist, repo-local validation passes, and the discrepancy is recorded as GitHub live metadata evidence rather than a repo configuration blocker.

### External issue/PR monitoring

Read-only broker health checks were performed without sending provider/Telegram canaries:

- `GET /github/webhook/health`: `ok=true`, service `github-ingestion`.
- `GET /github/poller/health`: `ok=true`, service `github-bounded-poller`, status `not_started`; bounded reconcile polling remains a separate future hardening path.
- Repository webhook list now has one active webhook for `issues`, `issue_comment`, `pull_request`, and `pull_request_review_comment` events.
- GitHub webhook ping returned `last_response.code=200`, `status=active`.
- A signed synthetic `issues` event through the webhook proxy reached broker ingestion and returned `skippedReason: "no_assignment_command"`, proving the route without creating tasks or sending provider/Telegram notifications.

Decision: #1169's monitoring activation scope is now satisfied through the active GitHub webhook path. Provider/Telegram notification canaries, bounded reconcile polling, release/publish, deploy/restart beyond the webhook proxy/Caddy setup, DB/outbox/ACK/replay mutation, and secret movement remain separately gated.

## A2AD handling round

The operator requested A2A handling for Nexus open issues. A source-only/no-live A2AD round was dispatched with lanes for issue forms, feedback monitoring, external listings, and finalizer:

- Round id: `nexus-open-issues-a2a-handle-20260701T061010Z`
- Created lanes: 4/4
- Final state: 4/4 succeeded
- Finalizer decision: `GO_WITH_CHANGES`

Important caveat: three analysis lanes reported blocked/insufficient source projection (`zero_files`), so they are not counted as substantive quorum evidence. The finalizer result plus direct operator verification supports only PR-safe documentation/comment closeout, not live monitoring activation.

Finalizer result before live setup:

> #1160 and #1169 are both processable through PR-safe documentation and issue comments, but neither should be closed now. #1160 remains open because two external directory PRs are still open. #1169 remains open because issue chooser rendering is not reliably verified and GitHub feedback monitoring is not active/proven.

Follow-up live setup completed the #1169 monitoring gap by installing and verifying an active repository webhook path.

## Issue decisions

### #1160 external listings

Keep open until all external listing PRs have final outcomes. Current state:

- `sing1ee/a2a-directory#35`: merged.
- `ai-boost/awesome-a2a#138`: open.
- `pab1it0/awesome-a2a#71`: open.

### #1169 feedback intake / monitoring

Close as completed after this evidence is merged:

1. live Issue Forms chooser/API discrepancy is documented as GitHub metadata evidence rather than a repo configuration blocker, while default-branch Issue Form files and local validation pass;
2. external issue/PR monitoring is proven active through an installed repository webhook for public feedback events, with signed ping and synthetic non-task smoke verification.

## Boundaries

This evidence does not authorize:

- release/tag/npm/Docker/GHCR publication;
- homepage/docs-site launch or broad promotion;
- production deploys, Gateway/broker/worker restarts, or live canaries;
- provider/Telegram/notification sends;
- production DB/outbox mutation, manual Terminal Brief ACK/replay, or prune/migration;
- secret/credential movement, rotation, or disclosure;
- visibility transfer/change, force push, or history rewrite.
