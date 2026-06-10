# Changelog

All notable public-safe changes for **A2A Nexus** are collected here. This file is release-preparation documentation only: it does not publish packages, create tags, change repository visibility, deploy services, restart services, mutate production state, send provider messages, rotate secrets, or ACK terminal outbox records.

## v0.1.0-alpha — operator decision candidate

Status: **draft / unreleased**. Use this entry as the operator decision surface for either an initial `v0.1.0-alpha` tag or a later `v0.1.0` after every public-readiness gate closes.

### Included scope

- Sanitized A2A Nexus workspace layout for broker, adapter plugin, Docker runner, shared contracts, examples, and public-safe documentation.
- Integrated local/CI release gate through `npm run check`, including layout checks, package-local checks, public-readiness scan, and compatibility-baseline validation.
- Public-safe quickstart, canonical demo, known limitations, security policy, issue templates, and release-gate documentation.
- Compatibility contracts for task lifecycle, terminal semantics, worker registration/read-model assumptions, and broker-to-broker handoff boundaries.
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
