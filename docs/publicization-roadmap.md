# External publicization roadmap

This document tracks the PR-safe implementation plan for moving A2A Nexus from a quiet public alpha to an externally discoverable public alpha. It implements the source-only parts of [#1166](https://github.com/jinwon-int/a2a-nexus/issues/1166) and links them to the external-directory tracker [#1160](https://github.com/jinwon-int/a2a-nexus/issues/1160).

## Current status

Checked for the #1160/#1166 A2AD round and the follow-up operator approval on 2026-07-01 UTC:

- Repository visibility: public.
- Current public status: public alpha, not stable release.
- Operator approval for #1166 settings work: received via `1166 승인`.
- GitHub topics after approval: `a2a`, `agent-to-agent`, `agents`, `broker`, `public-alpha`, `workflow-automation`.
- Homepage after approval: intentionally empty until a public docs site or stable landing page is approved.
- GitHub Releases: none.
- `delete_branch_on_merge`: enabled after approval.
- `main` branch protection after approval:
  - require branches to be up to date before merge;
  - require status checks: `paths-filter`, `setup`, `layout`, `broker`, `docker-runner`, `plugin`, `contracts`, `docs`, `promotion-capstone`, `check`;
  - require one approving review;
  - dismiss stale approvals on new commits;
  - require linear history;
  - disallow force pushes and branch deletion.
- GitHub security settings after approval: secret scanning, push protection, and Dependabot security updates enabled where available.
- External directory PRs tracked by #1160:
  - `sing1ee/a2a-directory#35`: merged at `2026-06-30T23:37:19Z`, merge commit `dcd58d5aa12769bbcd5fb35415da635624232682`.
  - `ai-boost/awesome-a2a#138`: open.
  - `pab1it0/awesome-a2a#71`: open.
- Follow-up after the public externalization A2AD evaluation is tracked in:
  - [#1172](https://github.com/jinwon-int/a2a-nexus/issues/1172): contribution intake hardening before broader promotion;
  - [#1173](https://github.com/jinwon-int/a2a-nexus/issues/1173): clone/view traffic anomaly audit before using traffic as promotion evidence;
  - [#1174](https://github.com/jinwon-int/a2a-nexus/issues/1174): homepage/docs-site posture decision before broader public promotion.

## A2AD source-only evidence

The #1160/#1166 implementation planning round was dispatched through the broker as a source-only/no-live A2AD round:

- Round id: `nexus-open-issues-publicization-r2-20260701T030930Z`
- Broker: Seoseo broker, local source-only/no-live dispatch
- Lanes created: 4/4
  - `public-surface` → `sogyo`
  - `settings-proposal` → `nosuk`
  - `listing-tracker` → `bangtong`
  - `finalizer` → `gongyung`
- Final task state: 4/4 succeeded
- Finalizer decision: `GO_WITH_CHANGES`

Finalizer summary:

> A documentation-only minimum PR is safe to start, but neither #1160 nor #1166 should be closed by this PR. #1160 stays open until the remaining external directory PRs reach final outcomes. #1166 stays open until the gated settings/release/feedback-readiness work is either completed with explicit approval or split into separate follow-up issues.

## Workstream plan

| Workstream | Current implementation | PR-safe next step | Gated / not done here |
|---|---|---|---|
| Public surface polish | README, SECURITY, CONTRIBUTING, issue forms, and PR template exist with public-alpha language. | Keep a concise external-reader path in README and validate local issue-form metadata. GitHub API metadata may not surface Issue Forms; treat repo-local validation as necessary and track contribution-intake hardening in [#1172](https://github.com/jinwon-int/a2a-nexus/issues/1172). | Broad announcement/promotion. |
| Repository metadata/settings | #1166 settings approval was received and applied: topics, delete-branch-on-merge, main branch protection, secret scanning, push protection, and Dependabot security updates. Homepage remains blank by decision. | Monitor that required CI contexts remain stable after branch protection; decide the homepage/docs-site posture in [#1174](https://github.com/jinwon-int/a2a-nexus/issues/1174) before broader promotion. | Public docs-site homepage mutation without approval, additional rulesets, release/tag/package settings, or visibility transfer. |
| External discoverability | `docs/external-listings.md` tracks the three directory PRs. | Keep #1160 open and update the tracker when `ai-boost#138` or `pab1it0#71` changes. | Closing #1160 before all three external PRs have final outcomes. |
| Feedback/notification readiness | Public issue-form files and PR template route public-safe feedback; [public feedback intake evidence](public-feedback-intake.md) records the GitHub Issue Forms metadata discrepancy and the active GitHub webhook monitoring path for issue/PR feedback events. | #1169 is closed after live monitoring setup evidence; keep bounded reconcile polling and notification canaries as separately approved future hardening if needed. | Live provider/Telegram sends, notification canaries, broad announcement, release/publish, DB/outbox/ACK/replay mutation, or secret disclosure. |
| External traction evidence | External listing state and GitHub traffic are read-only signals. The 2026-07-01 readback showed low views but anomalously high clones, so clone counts are not yet treated as organic promotion evidence. | Audit clone/view attribution in [#1173](https://github.com/jinwon-int/a2a-nexus/issues/1173) and prefer conservative traction indicators until resolved. | Claiming organic traction or using clone spikes in public promotion before attribution is clear. |
| Release/package readiness | Release checklist exists, no release is published, and homepage remains blank until a public docs/stable landing page exists. | Keep release/package work as design-only until separately approved. | GitHub Release, tag, npm package, Docker/GHCR image, production deploy. |

## What to try first

For an outside developer evaluating the public alpha, start with local-only checks. These do not require private topology, real broker URLs, node IDs, provider IDs, production credentials, or production data.

```bash
npm ci --ignore-scripts --include=dev
npm run check
npm run check:quickstart-conformance
npm run scan:public-readiness
npm run scan:external-secrets
```

Then read the local quickstart path:

1. [Public umbrella quickstart](quickstart/public-umbrella.md)
2. [Five-minute local quickstart](quickstart.md)
3. [A2A Nexus positioning](positioning.md)
4. [External listing tracker](external-listings.md)

If a local-only quickstart step cannot be completed from public docs alone, file a public-safe issue with redacted evidence. Do not include private endpoints, provider IDs, Telegram IDs, raw session dumps, real credentials, host-local paths, or production data.

## Repository settings proposal

These are recommendations only. They are not executed by this PR and require a separate operator-approved settings task.

| Setting | Proposed value | Reason | Approval boundary |
|---|---|---|---|
| Topics | `a2a`, `agent-to-agent`, `broker`, `agents`, `workflow-automation`, `public-alpha` | Improves GitHub discoverability without changing code. | Requires repo metadata mutation approval. |
| Homepage | Keep empty until a public docs site or stable landing page exists. | Avoids implying stable product status. | Set only after docs-site/promotion approval. |
| Delete branch on merge | Enable. | Reduces branch clutter after PR-first workflow. | Requires repo settings mutation approval. |
| Branch protection / ruleset | Require PRs, at least one approving review, required CI, no force pushes. | Protects public `main`. | Requires exact ruleset approval before mutation. |
| Secret scanning / push protection | Enable where available. | Public repo safety baseline. | Requires repo/org security-setting approval. |
| Dependabot security updates | Enable where available. | Keeps public dependency surface visible. | Requires repo/org security-setting approval. |

## Repository settings applied after approval

The operator approved the #1166 settings work with `1166 승인`. The following settings were applied and verified by GitHub API readback:

| Setting | Applied value | Verification note |
|---|---|---|
| Topics | `a2a`, `agent-to-agent`, `agents`, `broker`, `public-alpha`, `workflow-automation` | `repos/jinwon-int/a2a-nexus/topics` returned the expected list. |
| Homepage | Empty | Intentional: no stable docs site / landing page approval yet. |
| Delete branch on merge | Enabled | `delete_branch_on_merge: true`. |
| Branch protection | Enabled on `main` | Requires up-to-date branches, one approval, stale-review dismissal, linear history, no force pushes, and no branch deletion. |
| Required status checks | `paths-filter`, `setup`, `layout`, `broker`, `docker-runner`, `plugin`, `contracts`, `docs`, `promotion-capstone`, `check` | Matches the CI job inventory observed for PR #1167 and main CI. |
| Secret scanning | Enabled | `security_and_analysis.secret_scanning.status: enabled`. |
| Push protection | Enabled | `security_and_analysis.secret_scanning_push_protection.status: enabled`. |
| Dependabot security updates | Enabled | Repository metadata and automated-security-fixes endpoint both confirmed enabled/accepted state. |

## Issue closeout criteria

### #1160

Keep open until all three external-directory PRs have final states:

- merged, declined/closed, or replaced by maintainer-requested follow-up;
- `docs/external-listings.md` updated with final outcome and evidence link;
- final issue comment records the outcome and remaining promotion boundary.

### #1166

Keep open until one of these is true:

1. All five workstreams are completed with evidence, including any approved settings mutations and release/package decisions; or
2. The remaining gated work is explicitly split into child issues, and #1166 is reduced to an umbrella/roadmap closeout with links to those children.

This PR intentionally does **not** perform settings mutation, release/tag/package publication, production deploy/restart, provider/Telegram sends, DB/outbox/ACK/replay mutation, secret movement, or broad promotion.
