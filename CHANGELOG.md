# Changelog

All notable public-safe changes for **A2A Nexus** are collected here. This file is release-preparation documentation only: it does not publish packages, create tags, change repository visibility, deploy services, restart services, mutate production state, send provider messages, rotate secrets, or ACK terminal outbox records.

## Unreleased

No unreleased changes yet.

## v0.1.0-alpha — 2026-07-05

Status: **release candidate prepared for operator-approved tag/release**. This entry is the release-note source for the initial `v0.1.0-alpha` tag. npm, Docker/GHCR publication, repository visibility changes, production deployment, provider sends, and database/outbox mutations remain out of scope unless separately approved.

### Added — supply-chain hardening for CI workflows (#1228)

- Every GitHub Actions workflow now declares a minimal top-level `permissions:` block (OpenSSF Scorecard Token-Permissions); `ci.yml` defaults to `contents: read` with job-level widening only where needed. Enforced fail-closed by the core release-gate step `workflow-permissions` (`scripts/check-workflow-permissions.mjs`).
- CodeQL SAST workflow (`.github/workflows/codeql.yml`) scans `javascript-typescript` on every pull request, on `main` pushes, and weekly; findings surface as code-scanning alerts.
- External GitHub Actions references are pinned to full commit SHAs with source tag comments, enforced by the core `workflow-action-pinning` gate (`scripts/check-workflow-action-pinning.mjs`).

### Changed — docker-runner trusted-lane defaults (behavior change, #1204/#1209)

- The trusted-operator default network dropped from `host` to `bridge`. Untrusted lanes keep `none`. Trusted workers that relied on host networking must opt in explicitly with `A2A_DOCKER_RUNNER_NETWORK=host`.
- Trusted lanes now default to a read-only root filesystem (`--read-only` plus a bounded `noexec,nosuid` `/tmp` tmpfs) and a non-root container user (`--user 1000:1000`). Escape hatches: `A2A_DOCKER_RUNNER_READ_ONLY_ROOTFS=0`, `A2A_DOCKER_RUNNER_USER=root`. Full matrix and migration note: [`packages/docker-runner/docs/trusted-operator-hardening.md`](packages/docker-runner/docs/trusted-operator-hardening.md).

### Added — broker runtime robustness (#1204)

- Broker entrypoint installs `unhandledRejection`/`uncaughtException` handlers with structured logging and graceful-shutdown reuse.
- Process-local security limits (replay cache, rate limiter) are documented in [`packages/broker/docs/process-local-security-limits.md`](packages/broker/docs/process-local-security-limits.md); restarts reset both and horizontal scaling needs a shared store.

### Included scope

- Sanitized A2A Nexus workspace layout for broker, adapter plugin, Docker runner, shared contracts, examples, and public-safe documentation.
- Integrated local/CI release gate through `npm run check`, including layout checks, package-local checks, public-readiness scan, and compatibility-baseline validation.
- Public-safe quickstart, canonical demo, known limitations, security policy, issue templates, and release-gate documentation.
- Compatibility contracts for task lifecycle, terminal semantics, worker registration/read-model assumptions, and broker-to-broker handoff boundaries.
- Acceptance contracts, Definition-of-Ready linting, scope-drift/readback guardrails, and terminal evidence semantics used to keep delegated work reviewable before merge.
- Round quality and evidence scorecard gates, including weak-dialectic health signals and source-projection/readback checks for A2A/A2AD review lanes.
- Release evidence paths for redacted public-readiness and external secret/history scan disposition.

### Required pre-tag evidence

- GitHub Actions `ci` workflow passes on the exact release candidate commit.
- `npm ci --ignore-scripts --include=dev` passes from a clean checkout.
- `npm run check` passes from the same checkout.
- `npm run scan:public-readiness` passes with no runtime/bootstrap or secret-shaped findings.
- `npm run scan:external-secrets` passes with a supported scanner, or an operator records explicit fail-closed Block evidence.
- Clone smoke validates the public-safe quickstart/docs from a fresh checkout with no private configuration copied in.

### Operator decision points

- Choose the tag name: `v0.1.0-alpha` for the first promotion candidate, or `v0.1.0` only after the operator decides the repository is public/release ready.
- Explicitly approve any repository visibility change separately from tag/release creation.
- Keep npm/Docker publication out of scope unless a later operator approval names those artifacts and registries.
