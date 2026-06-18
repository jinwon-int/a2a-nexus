# Security Policy

## Supported versions

`plugin-a2a` is an **alpha** plugin package (unpublished, `"private": true`). Only the latest commit on `main` is supported for security reports.

| Release line | Status |
| --- | --- |
| `0.1.x` (main) | Alpha — security reports accepted |

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

This package is part of a public-readiness alpha monorepo, but vulnerability details must remain private. Report vulnerabilities through the parent project's private reporting channel when available, or open a non-sensitive maintainer-contact request without vulnerability details.

Include:
- A clear description of the vulnerability
- Steps to reproduce (or a proof of concept)
- The affected component (plugin, broker client, notification path, etc.)
- Whether the issue is exploitable from a public/non-public surface

The maintainers will acknowledge within 5 business days and provide a timeline for triage and remediation.

## Scope

This policy covers:
- `plugin-a2a` plugin code (TypeScript source, config schema, exports)
- The plugin's broker-client HTTP surface
- The operator-notification receipt-runtime boundary
- The public-stable readiness defaults (no-live-send, no-terminal-ACK)

Out of scope:
- The standalone `a2a-broker` service
- The `a2a-docker-runner` service
- OpenClaw core internals
- Third-party dependencies (report those upstream)

## Disclosure

This is an unpublished alpha plugin package. Do not publicly disclose vulnerabilities before the maintainers confirm a fix is available.

## Safety invariants

The plugin's security model rests on these invariants:
1. No live Telegram/notification delivery without explicit operator approval
2. No terminal-outbox ACK from provider/gateway send success alone
3. No production deploy, restart, or DB mutation without operator approval
4. Edge secrets and broker URLs must remain placeholder-only in public docs

If you find a path that bypasses any of these invariants, treat it as a high-severity finding.
