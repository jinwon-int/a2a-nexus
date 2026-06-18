# Security Policy

## Current status

This repository is in public-readiness prep. It remains private unless a separate operator-approved GitHub visibility change is executed and evidenced. The project is **alpha** — feedback and contributions are welcome when access is available, but no production readiness, stability guarantees, or security support are implied.

Broader promotion (stable release, announcements, public docs site) remains blocked on the readiness gates recorded in [`docs/public-readiness.md`](docs/public-readiness.md).

## Reporting a vulnerability

Do not open public GitHub issues for vulnerabilities. Use GitHub private vulnerability reporting for this repository when available:

https://github.com/jinwon-int/a2a-nexus/security/advisories/new

If private vulnerability reporting is unavailable, do not put vulnerability details in a public issue or PR. Open a non-sensitive maintainer-contact request or use an existing organization-approved private contact path, then share only redacted details after a maintainer provides a private route.

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
- terminal-outbox ACK/replay mutation
- creating or moving tags, GitHub Releases, npm publishes, Docker/image publication, or package publication
- secret/credential movement, rotation, or disclosure
- history rewrite or force push

Explicit operator approval must name the exact action, target repository or artifact, and rollback/no-op boundary before any exception.

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

No stable release, npm package, Docker image, repository visibility change, or production deployment is supported yet. Treat all packages in this public-readiness monorepo as alpha candidates until the compatibility matrix and promotion-readiness gates are complete.
