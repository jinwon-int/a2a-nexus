# Security Policy

## Current status

This repository is GitHub-public as of 2026-05-27. The project is **alpha** — feedback and contributions are welcome, but no production readiness, stability guarantees, or security support are implied.

Broader promotion (stable release, announcements, public docs site) remains blocked on the readiness gates recorded in [`docs/public-readiness.md`](docs/public-readiness.md).

## Reporting a vulnerability

For now, report security concerns in the private issue tracker or directly to the repository maintainers using the approved private channel for this organization. Keep reports concise and redacted.

Do not include:

- real tokens, secrets, cookies, private keys, or authorization headers
- private hostnames, internal IPs, local filesystem paths, provider IDs, Telegram IDs, or raw session dumps
- production database contents or terminal-outbox payloads

If a proof of concept needs configuration, use placeholders such as `<local-dev-token>`, `<broker-url>`, and `<worker-id>`.

## Hard safety boundary

The following actions are not authorized by normal docs, issues, PRs, or local verification:

- changing repository visibility
- production deploys or Gateway/broker/worker restarts
- production database mutation
- live provider or Telegram sends
- terminal-outbox ACK mutation
- secret rotation or disclosure
- history rewrite or force push

Explicit operator approval must name the action before any exception.

## Evidence handling

Use redacted evidence only. Before opening a PR or posting task evidence, verify that the branch and artifacts do not include OpenClaw runtime/bootstrap context files:

- `AGENTS.md`
- `SOUL.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `IDENTITY.md`
- `.openclaw/**`

If any of those files would enter a branch or artifact bundle, fail closed and report the exact repo-relative paths.

## Supported versions

No public/stable version is supported yet. Treat all packages in this monorepo as alpha candidates until the compatibility matrix and promotion-readiness gates are complete.
