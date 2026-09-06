# Security Policy

## Current status

This repository is public and remains an **alpha** project. Public visibility means the code, docs, issues, and PRs are readable by the public; it does not imply production readiness, stability guarantees, stable release support, package publication, or permission to use production infrastructure.

Broader promotion (stable release, announcements, public docs site, package/image publication, production deployment, and live operations) remains blocked on the readiness gates recorded in [`docs/history/public-readiness.md`](docs/history/public-readiness.md) and separate explicit operator approval.

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

## Bounded review-lineage source boundary

`A2A_REVIEW_LINEAGE_MODE` remains `off` by default, and `enforce` is
unsupported. When separately activated in record mode, authoritative
review-lineage mutations are closed to exact routes and trusted identities.
Lineage create, operator cancel, and committed correction-generation recording
require an authenticated requester with the exact `operator` role. Review
reports require the Ed25519 worker registry and the dedicated
`review-lineage.report` scope.

For correction generation, request JSON cannot select authority, namespace,
issuer, producer ID, or source-event ID. Trusted code assigns semantic
`correction_controller` authority, and the canonical parser/store require the
exact pre-correction subject and `correction_pending` state. This route records
an already committed head only; it does not accept patch bytes, run a fixer,
auto-push output, or infer evidence from task results, logs, prose, retries,
completion, or finalizer state.

The source event, canonical lineage result, and idempotency ledger share one
transaction. Minimized source metadata must not contain raw generation/report
references, actor identities, changed paths, receipt/finding prose, patch or
fixer output, prompts, provider payloads, or credentials.


## Dependency update monitoring

Dependabot monitors both GitHub Actions and the npm workspace lockfile. npm dependency updates arrive as reviewed PRs; minor and patch updates may be grouped, while major updates stay separate.

The dependency advisory gate (`scripts/check-dependency-advisories.mjs`, a release-gate step run by the `check` job) is **enforcing**: it summarizes `npm audit --omit=dev --json` output when registry access is available and **fails** on high/critical production advisories. Low, moderate, and info advisories never fail. When the audit endpoint is unavailable the gate still skips with a reason rather than failing closed, because an offline runner is not evidence of a vulnerability.

The gate was warn-only until issue #2050. It was armed because auto-merge only requires the CI check run to report `conclusion == 'success'`, so a warn-only exit 0 allowed a PR carrying high/critical advisories to land unattended. Arming was done against a measured baseline of `high=0 critical=0`, so no open PR was turned red by the change.

A high/critical advisory that cannot be fixed immediately is accepted by adding an entry to `ADVISORY_ALLOWLIST` in `scripts/check-dependency-advisories.mjs`. Every entry requires an advisory id (GHSA id, numeric `npm audit` source, or the `pkg:<name>` pseudo-id), a `reason`, and an `expires` date. An expired entry stops waiving and the gate fails again, so an accepted risk cannot be accepted forever by default. Adding an entry is a reviewed decision recorded in the diff, not a way to unblock CI.

## Supported versions

No stable release, npm package, Docker image, or production deployment is supported yet. Treat all packages in this public alpha monorepo as alpha candidates until the compatibility matrix and promotion-readiness gates are complete.
