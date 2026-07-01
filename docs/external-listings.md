# External listing tracker

This document tracks gated discoverability submissions for A2A Nexus. It is preparation only: opening external directory PRs, homepage metadata changes, release announcements, or broad promotion require operator approval and the preconditions below.

## Preconditions

- [ ] Repository visibility is public and `npm run scan:public-readiness` is green on the candidate commit.
- [ ] `npm run scan:external-secrets` has current evidence with no non-synthetic findings.
- [ ] Local quickstart and public docs path are green enough for external readers.
- [ ] Operator approval record exists for `external-promotion` if a listing PR will be opened.

## Directory targets

| Directory | Status | PR URL | Notes |
| --- | --- | --- | --- |
| `ai-boost/awesome-a2a` | prepared, not submitted | — | Broker/control-plane listing candidate. |
| `sing1ee/a2a-directory` | prepared, not submitted | — | Schema-specific entry pending maintainer format check. |
| `pab1it0/awesome-a2a` | prepared, not submitted | — | One-line listing candidate. |

## Base PR body template

> Add A2A Nexus, an operator-gated A2A task and evidence control plane for broker-managed worker registration, auditable task lifecycle evidence, source-only review bridges, isolated patch execution, and finalizer closeout reports.
>
> It complements public A2A Agent Card / JSON-RPC conventions; it is not affiliated with or endorsed by a2aproject. The repository is public alpha: production deployment, package publication, release tags, external promotion, provider sends, and visibility-related actions remain separately operator-gated.

Use only README, LICENSE, and public docs as source text. Do not include private topology, node names, endpoints, provider IDs, Telegram IDs, runtime metadata, or raw approval-channel text.
