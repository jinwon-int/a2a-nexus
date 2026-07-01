# Public feedback intake and monitoring evidence

This page tracks the public-safe intake checks for [#1169](https://github.com/jinwon-int/a2a-nexus/issues/1169) and the remaining external-listing boundary for [#1160](https://github.com/jinwon-int/a2a-nexus/issues/1160).

Status: **partial / follow-up still open**. The repository has issue-form files and local validation passes, but live GitHub metadata still does not report rendered templates, and the broker-side GitHub poller is not active.

## 2026-07-01 evidence

Checked against `main` commit `ca5ba9272bd0b46c2e0dace8cfccc22cbd465519`.

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

Decision: do not claim the public issue chooser is verified until a logged-in browser/session or another reliable GitHub-render path confirms it, or the API discrepancy is explicitly accepted as a GitHub metadata limitation with evidence.

### External issue/PR monitoring

Read-only broker health checks were performed without sending provider/Telegram canaries:

- `GET /github/webhook/health`: `ok=true`, service `github-ingestion`, replay counters at zero.
- `GET /github/poller/health`: `ok=true`, service `github-bounded-poller`, status `not_started`.
- Repository webhook list: empty.

Decision: the broker has GitHub ingestion health endpoints, but external issue/PR monitoring is **not proven active** because the bounded poller is `not_started` and no repository webhooks are installed. Starting a poller, adding a webhook, or sending notification/provider canaries remains a separate approval-gated live operation.

## A2AD handling round

The operator requested A2A handling for Nexus open issues. A source-only/no-live A2AD round was dispatched with lanes for issue forms, feedback monitoring, external listings, and finalizer:

- Round id: `nexus-open-issues-a2a-handle-20260701T061010Z`
- Created lanes: 4/4
- Final state: 4/4 succeeded
- Finalizer decision: `GO_WITH_CHANGES`

Important caveat: three analysis lanes reported blocked/insufficient source projection (`zero_files`), so they are not counted as substantive quorum evidence. The finalizer result plus direct operator verification supports only PR-safe documentation/comment closeout, not live monitoring activation.

Finalizer result:

> #1160 and #1169 are both processable through PR-safe documentation and issue comments, but neither should be closed now. #1160 remains open because two external directory PRs are still open. #1169 remains open because issue chooser rendering is not reliably verified and GitHub feedback monitoring is not active/proven.

## Issue decisions

### #1160 external listings

Keep open until all external listing PRs have final outcomes. Current state:

- `sing1ee/a2a-directory#35`: merged.
- `ai-boost/awesome-a2a#138`: open.
- `pab1it0/awesome-a2a#71`: open.

### #1169 feedback intake / monitoring

Keep open until both conditions are satisfied:

1. live Issue Forms chooser behavior is verified, or the GitHub API/chooser discrepancy is documented with accepted evidence;
2. external issue/PR monitoring is proven active, or a separate approved monitoring activation task installs/starts the required route and verifies it without leaking private routing details.

## Boundaries

This evidence does not authorize:

- release/tag/npm/Docker/GHCR publication;
- homepage/docs-site launch or broad promotion;
- production deploys, Gateway/broker/worker restarts, or live canaries;
- provider/Telegram/notification sends;
- production DB/outbox mutation, manual Terminal Brief ACK/replay, or prune/migration;
- secret/credential movement, rotation, or disclosure;
- visibility transfer/change, force push, or history rewrite.
