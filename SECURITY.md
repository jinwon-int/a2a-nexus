# Security Policy

## Current status

This repository is public and remains an **alpha** project. Public visibility means the code, docs, issues, and PRs are readable by the public; it does not imply production readiness, stability guarantees, stable release support, package publication, or permission to use production infrastructure.

Broader promotion (stable release, announcements, public docs site, package/image publication, production deployment, and live operations) remains blocked on the readiness gates recorded in [`docs/public-readiness.md`](docs/public-readiness.md) and separate explicit operator approval.

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

- transferring repository ownership/visibility or making another visibility change
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


## Dependency update monitoring

Dependabot monitors both GitHub Actions and the npm workspace lockfile. npm dependency updates arrive as reviewed PRs; minor and patch updates may be grouped, while major updates stay separate. The dependency advisory gate is warn-only in this alpha stage: it summarizes `npm audit --omit=dev --json` output when registry access is available, warns on high/critical production advisories, and skips with a reason when the audit endpoint is unavailable. Enforcement can be tightened only after observing noise and recording a separate cutoff decision.

## Supported versions

No stable release, npm package, Docker image, or production deployment is supported yet. Treat all packages in this public alpha monorepo as alpha candidates until the compatibility matrix and promotion-readiness gates are complete.
