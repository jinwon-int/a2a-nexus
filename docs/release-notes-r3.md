# R3 Release Notes Draft

Status: public GitHub repository (since 2026-05-27). Historical release notes from the private-readiness phase.

## R3 focus

- Secret/history scan and redacted disposition.
- Sanitized/squash imports for broker, OpenClaw plugin, and Docker runner packages.
- External-user README, quickstart, security docs, and issue templates.
- Integrated CI/release gate and exact compatibility baselines.
- Canonical demo and known limitations.

## Safety statement

R3 documentation and import work does not authorize public visibility changes, production deploys, Gateway restarts, production DB mutations, live provider/Telegram sends, terminal-outbox ACK mutation, secret rotation, secret disclosure, history rewrite, or force push.

## Release gate

A public release candidate requires:

1. Clean or dispositioned secret/history scan.
2. Public-safe docs/examples with no private topology or real-looking credentials.
3. Passing root and package-local checks.
4. Compatibility matrix with exact baselines.
5. Operator approval explicitly naming the visibility change.
