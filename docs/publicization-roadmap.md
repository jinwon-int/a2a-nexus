# External publicization roadmap

This document tracks the PR-safe implementation plan for moving A2A Nexus from a quiet public alpha to an externally discoverable public alpha. It implements the source-only parts of [#1166](https://github.com/jinwon-int/a2a-nexus/issues/1166) and links them to the external-directory tracker [#1160](https://github.com/jinwon-int/a2a-nexus/issues/1160).

## Current status

Checked for the #1160/#1166 A2AD round on 2026-07-01 UTC:

- Repository visibility: public.
- Current public status: public alpha, not stable release.
- GitHub topics: empty.
- Homepage: empty.
- GitHub Releases: none.
- `main` branch protection API returned `404 Branch not protected` during the live check.
- GitHub security settings observed as disabled in repository metadata: secret scanning, push protection, and Dependabot security updates.
- External directory PRs tracked by #1160:
  - `sing1ee/a2a-directory#35`: merged at `2026-06-30T23:37:19Z`, merge commit `dcd58d5aa12769bbcd5fb35415da635624232682`.
  - `ai-boost/awesome-a2a#138`: open.
  - `pab1it0/awesome-a2a#71`: open.

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
| Public surface polish | README, SECURITY, CONTRIBUTING, issue forms, and PR template exist with public-alpha language. | Keep a concise external-reader path in README and validate local issue-form metadata. | Broad announcement/promotion. |
| Repository metadata/settings | This document records the observed gaps and proposed settings. | Keep settings as a proposal document until approved. | Mutating GitHub topics, homepage, branch protection/rulesets, security settings, or Dependabot. |
| External discoverability | `docs/external-listings.md` tracks the three directory PRs. | Keep #1160 open and update the tracker when `ai-boost#138` or `pab1it0#71` changes. | Closing #1160 before all three PRs have final outcomes. |
| Feedback/notification readiness | Public issue forms and PR template route public-safe feedback. | Use this document as the public-feedback triage boundary. | Live notification/channel checks or provider/Telegram sends. |
| Release/package readiness | Release checklist exists, and no release is published. | Treat release/package work as a future roadmap with explicit approval. | GitHub Release, tag, npm package, Docker/GHCR image, production deploy. |

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
