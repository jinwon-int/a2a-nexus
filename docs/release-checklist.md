# A2A Nexus v0.1.0 Release Checklist

This checklist prepares evidence for an initial `v0.1.0-alpha` or `v0.1.0` operator decision for **A2A Nexus**. It is safe documentation only. Do not create a tag, publish a release, change repository visibility, deploy, restart services, mutate production state, send provider messages, rotate secrets, rewrite history, force-push, or ACK terminal outbox records while completing this checklist.

For the public-alpha packaging decision model, see [Release and package readiness](release-readiness.md). That document distinguishes readiness planning from actual GitHub Release, tag, npm, Docker, or GHCR publication.

## Candidate commit

- [ ] Record the exact candidate commit SHA.
- [ ] Confirm the branch/PR contains no OpenClaw runtime/bootstrap files: `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `IDENTITY.md`, or `.openclaw/**`.
- [ ] Confirm evidence is redacted and contains no secrets, private endpoints, provider IDs, Telegram IDs, raw session dumps, production data, or host-specific private paths.

## Multi-PR round merge preflight

Before merging a round with more than one PR, build the exact intended merge train locally and run the integrated gate. This catches cross-PR fixture/contract drift that individual PR CI cannot see.

- [ ] List the intended PR merge order and confirm every PR is individually green.
- [ ] Run `npm run round:merge-preflight -- <pr> [<pr> ...]` using that exact order, or add `--run "npm run check && npm run test:release-gate"` when the round changes release-gate tests.
- [ ] Record the successful preflight command and output in the parent issue before merging the first PR.
- [ ] If the preflight fails, stop the merge train and fix the integration gap in a PR before any round PR is merged.

## CI and local gates

- [ ] GitHub Actions `ci` passes for the exact candidate commit: `a2a-plane (internal tracker, private)actions/workflows/ci.yml`.
- [ ] Fresh local install passes: `npm ci --ignore-scripts --include=dev`.
- [ ] Root release gate passes: `npm run check`.
- [ ] Release-gate regression tests pass: `npm run test:release-gate`.
- [ ] Public-readiness scan passes: `npm run scan:public-readiness`.
- [ ] External secret/history scan passes: `npm run scan:external-secrets`, or the operator records explicit fail-closed Block evidence if no supported scanner is available.

## Clone smoke

- [ ] Clone the candidate into a fresh directory without copying private runtime config, local runtime files, or secrets.
- [ ] Run `npm ci --ignore-scripts --include=dev` and `npm run check` from that fresh checkout.
- [ ] Follow `docs/quickstart.md` only with local placeholder values and no production broker, Gateway, worker, provider, or Telegram integration.
- [ ] Confirm README links, package metadata, examples, and docs render under the A2A Nexus public name without private-source references.

## Docs and release notes

- [ ] Review `README.md`, `CHANGELOG.md`, `docs/release-gate.md`, `docs/history/public-readiness.md`, and `docs/known-limitations.md` for current status.
- [ ] Ensure compatibility baselines in `contracts/compatibility/matrix.md` are exact and current.
- [ ] Keep unresolved blockers listed in `docs/history/public-readiness.md`; do not convert Block/NO-GO evidence into Done evidence.

## Final operator gate

- [ ] Operator explicitly chooses `v0.1.0-alpha` or `v0.1.0`.
- [ ] Operator explicitly approves any repository visibility change as a separate decision.
- [ ] Operator explicitly approves any tag/release creation after all required evidence is linked.
- [ ] If publication is desired later, create a separate approval and checklist for npm/Docker artifacts.
