# External listing tracker

This file prepares the discoverability workflow for A2A Nexus without opening external PRs. External directory submissions are public communications and remain operator-gated.

## Preconditions before external PRs

- [ ] Operator explicitly approves the external listing wave.
- [ ] Latest `main` passes `npm run scan:public-readiness`.
- [ ] Latest `main` passes `npm run scan:external-secrets` or an equivalent operator-run secret scan.
- [ ] README positioning and conformance evidence are current.
- [ ] PR bodies are reviewed for private topology, node IDs, endpoints, Telegram/provider IDs, and secret-like strings.

## Directory targets

| Directory | Status | Planned category | PR URL | Notes |
|---|---|---|---|---|
| `ai-boost/awesome-a2a` | not opened | Broker / control-plane | N/A | Requires operator approval. |
| `sing1ee/a2a-directory` | not opened | A2A broker runtime | N/A | Requires schema review and operator approval. |
| `pab1it0/awesome-a2a` | not opened | Broker / control-plane | N/A | Requires operator approval. |

## Public-safe PR body base

> A2A Nexus is a fleet-level, operator-gated A2A task/evidence control plane. It complements the public A2A protocol/SDK layer with broker-managed worker registration, auditable task lifecycle evidence, source-only review bridges, and finalizer-oriented closeout reports. It is not affiliated with or endorsed by a2aproject; compatibility work is tracked in-repo and remains alpha.

Do not include private deployment topology, live broker URLs, node names, tokens, internal ports, Telegram/provider IDs, or production runtime metadata in external submissions.
