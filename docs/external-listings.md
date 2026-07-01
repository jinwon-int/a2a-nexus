# External listing tracker

This file tracks the operator-approved discoverability workflow for A2A Nexus. External directory submissions are public communications and remain operator-gated.

Scope split:

- [#1160](https://github.com/jinwon-int/a2a-nexus/issues/1160) remains the external directory listing tracker until all three directory PRs have final outcomes.
- [#1166](https://github.com/jinwon-int/a2a-nexus/issues/1166) tracked broader external publicization readiness through the approved settings closeout.
- Follow-up public externalization hardening was split into focused trackers: contribution intake [#1172](https://github.com/jinwon-int/a2a-nexus/issues/1172), clone/view traffic audit [#1173](https://github.com/jinwon-int/a2a-nexus/issues/1173), and homepage/docs-site posture [#1174](https://github.com/jinwon-int/a2a-nexus/issues/1174). Their PR-safe closeout evidence lives in [Public externalization follow-up closeout evidence](public-externalization-followups.md), while #1160 stays open for external directory outcomes. The PR-safe roadmap lives in [External publicization roadmap](publicization-roadmap.md).

## Preconditions before external PRs

- [x] Operator explicitly approves the external listing wave. Approved 2026-07-01 KST via operator message: `승인`.
- [x] Latest `main` passes `npm run scan:public-readiness`.
- [x] Latest `main` passes `npm run scan:external-secrets` or an equivalent operator-run secret scan. The accepted findings were synthetic fixture findings only.
- [x] README positioning and conformance evidence are current.
- [x] PR bodies are reviewed for private topology, node IDs, endpoints, Telegram/provider IDs, and secret-like strings.

## Directory targets

| Directory | Status | Planned category | PR URL | Notes |
|---|---|---|---|---|
| `ai-boost/awesome-a2a` | open | Broker / control-plane | <https://github.com/ai-boost/awesome-a2a/pull/138> | PR opened from `jinon86`; existing unrelated `NEXUS` PR #34 was not reused. |
| `sing1ee/a2a-directory` | merged | A2A broker runtime | <https://github.com/sing1ee/a2a-directory/pull/35> | Merged 2026-06-30T23:37:19Z, merge commit `dcd58d5aa12769bbcd5fb35415da635624232682`. |
| `pab1it0/awesome-a2a` | open | Broker / control-plane | <https://github.com/pab1it0/awesome-a2a/pull/71> | README developer-tools listing. |

## Public-safe PR body base

> A2A Nexus is a fleet-level, operator-gated A2A task/evidence control plane. It complements the public A2A protocol/SDK layer with broker-managed worker registration, auditable task lifecycle evidence, source-only review bridges, and finalizer-oriented closeout reports. It is not affiliated with or endorsed by a2aproject; compatibility work is tracked in-repo and remains alpha.

Do not include private deployment topology, live broker URLs, node names, tokens, internal ports, Telegram/provider IDs, or production runtime metadata in external submissions.
