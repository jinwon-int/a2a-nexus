# Release and package readiness

This page is a PR-safe readiness plan for [#1180](https://github.com/jinwon-int/a2a-nexus/issues/1180). It prepares an eventual release/package decision without creating a GitHub Release, tag, npm package, Docker image, GHCR image, deployment, or homepage metadata change.

<!-- TCK-READINESS:START -->
## Official A2A TCK compatibility snapshot

Compatibility posture: **A2A 1.0-compatible broker alpha profile**. This is a measured alpha snapshot, not a certification or full-conformance claim.

| Official TCK measurement | Result |
| --- | ---: |
| Overall compatibility | 98.5% |
| Agent Card | 6/6 |
| JSON-RPC | 78/94 |
| Promoted sub-category: `jsonrpc-error-codes-and-errorinfo` | 12/13 |
| Promoted sub-category: `jsonrpc-task-not-found-and-invalid-task` | 7/7 |
| Promoted sub-category: `jsonrpc-artifact-message-projection` | 9/9 |
| Promoted sub-category: `jsonrpc-streaming-subscribe-ordering` | 9/9 |
| Promoted sub-category: `jsonrpc-version-negotiation` | 4/4 |

Source: [tck-measurement workflow run 30234563387](https://github.com/jinwon-int/a2a-nexus/actions/runs/30234563387), measured `2026-07-27`. Canonical ledgers: `packages/broker/docs/tck-history.json` and `packages/broker/docs/tck-failing-categories.json`.

The full official TCK remains a non-gating measurement lane. Only sub-categories marked `promoted` in the classification ledger are represented as blocking PR gates.
<!-- TCK-READINESS:END -->

## Readiness vs publication

| Area | Design/readiness work allowed here | Actual publication action |
|---|---|---|
| GitHub Release | Document candidate criteria, evidence links, known limitations, and rollback notes. | Requires separate explicit operator approval. |
| Git tag | Document versioning policy and candidate commit requirements. | Requires separate explicit operator approval. |
| npm package | Audit package contents and install smoke expectations. | Requires separate explicit operator approval and package-owner decision. |
| Docker / GHCR | Document image boundary, Dockerfile audit needs, and scan expectations. | Requires separate explicit operator approval. |
| Deployment | Document that public repo visibility is not production readiness. | Requires separate explicit operator approval and rollout plan. |

## Candidate evidence checklist

Before any `v0.1.0-alpha`, GitHub Release, tag, npm package, Docker image, or GHCR publication is considered, record evidence for the exact candidate commit:

- [ ] candidate commit SHA and branch/PR URL;
- [ ] `npm ci --ignore-scripts --include=dev` from a clean checkout;
- [ ] `npm run check`;
- [ ] `npm run smoke:quickstart` when the local environment supports the full quickstart smoke;
- [ ] `npm run check:markdown-links`;
- [ ] `npm run scan:public-readiness`;
- [ ] `npm run scan:external-secrets`, with only synthetic fixture findings accepted;
- [ ] package contents audit for any selected package surface;
- [ ] license and NOTICE review;
- [ ] public API / compatibility boundary review;
- [ ] product-boundary / split-candidate evidence when the candidate moves a Nexus primitive into a feature repository;
- [ ] known limitations and rollback/deprecation expectations.

## Split-candidate evidence before extraction

Before any feature repository is created or any Nexus primitive is extracted into a product package, record the G0 evidence from [Product boundaries and extraction contract](product-boundaries.md):

- [ ] candidate repository owner/name and proposed package name;
- [ ] candidate CLI names, exported modules, artifact type, and package contents inventory;
- [ ] exact Nexus commit SHA, contract file(s), fixture(s), verifier(s), and conformance test(s) used as the upstream source;
- [ ] dependency direction: product repo consumes a pinned Nexus contract; Nexus core does not import or require the product runtime;
- [ ] local source-only verification command output from a disposable checkout;
- [ ] public-readiness and external-secret scan results, with only accepted synthetic fixture findings;
- [ ] compatibility note for future contract drift, deprecation, and rollback;
- [ ] explicit non-authorization for repository creation, tag/release, npm/Docker/GHCR publication, homepage metadata, deploy/restart, live broker policy changes, provider sends, DB/outbox/ACK/replay/prune/migration, and credential movement.

Split-candidate evidence is still design/readiness evidence. It does not authorize publication or live operation.

## Automated candidate evidence packet

Use this command to build the source-only candidate evidence packet for the current checkout:

```bash
node scripts/build-release-candidate-evidence.mjs --out-dir artifacts/release-candidate
```

The command writes:

- `artifacts/release-candidate/evidence.json`
- `artifacts/release-candidate/summary.md`

The generated directory is ignored by Git by default so operators can regenerate it for a specific candidate SHA without accidentally committing local evidence. The packet records the candidate SHA/branch, root package metadata, package contents audit for workspace packages, validation commands that still need fresh execution, known limitations, and rollback notes.

Safety boundary: the evidence builder is source-only. It does **not** run `npm ci`, `npm run check`, quickstart smoke, public-readiness scans, external secret scans, `npm pack`, release/tag creation, npm/Docker/GHCR publication, deployment, broker/Gateway/worker restart, provider or Telegram send, DB/outbox/ACK/replay/prune/migration mutation, secret movement, repository visibility change, history rewrite, or force push.

To inspect a narrower package surface, repeat `--package`:

```bash
node scripts/build-release-candidate-evidence.mjs \
  --package packages/broker \
  --package packages/docker-runner \
  --package packages/openclaw-plugin-a2a
```

The package contents audit uses workspace `package.json` files plus tracked-file inventory. It intentionally avoids `npm pack` because pack lifecycle hooks could execute package scripts; actual package publication remains separately approval-gated.

## Package contents audit

For any candidate package/image surface, the release issue or PR must show:

- which workspace or image is being considered;
- what files would be included;
- what files are explicitly excluded;
- confirmation that no runtime config, `.env`, private operator notes, raw session dumps, tokens, provider IDs, Telegram IDs, production data, or host-local paths are included;
- install or run smoke output from a disposable environment.

## Versioning and stability tiers

Until an operator-approved release plan exists, all packages remain private and unreleased. Version numbers in package manifests are source-state markers, not publication approval.

### SemVer during 0.x

- Breaking changes during `0.x` require a minor bump candidate (`0.MINOR.0`) and a CHANGELOG entry before any tag/release proposal.
- Compatible features may use a minor bump candidate; fixes and documentation-only changes may use a patch candidate.
- The default policy is lockstep candidate versions across broker, plugin, and runner until a package-owner decision records independent versioning.

### Stability tiers

| Tier | Surface | Promise |
| --- | --- | --- |
| Public alpha | README, quickstart, architecture, contribution entry points, public docs, local-only examples | Feedback welcome; no production or support guarantee. |
| Contract candidate | `contracts/a2a/`, compatibility fixtures, public JSON schemas | Changes require compatibility notes and regression tests. |
| Experimental/internal | broker worker internals, historical validation fixtures, round-specific scripts, live-ops runbooks | May change without compatibility promise; do not present as public API. |

### CHANGELOG and bump triggers

A release proposal must update `CHANGELOG.md` when it changes public docs, contracts, package exports, CLI behavior, worker/broker API behavior, or safety policy. The proposal must cite local gates and any approval record.

## Versioning policy stub

Until a maintainer approves a release plan, use this conservative policy:

- `v0.1.0-alpha.N` means public-alpha feedback only, no stability guarantee;
- `v0.1.0` requires a separate operator decision that the quickstart, compatibility notes, known limitations, and package contents are stable enough for a first tagged release;
- all later versions must link to release evidence and known limitations;
- deprecation or rollback notes must be public-safe and must not expose private deployment state.

## Required approval language

Actual GitHub Release creation, tag creation, npm publication, Docker build/push, GHCR push, production deploy, provider/Telegram send, DB/outbox/ACK/replay mutation, secret movement, homepage metadata mutation, visibility change, history rewrite, or force push is **not authorized** by this document.

Those actions require a separate explicit operator-approved task with its own verification and closeout evidence.

## Related docs

- [Existing release checklist](release-checklist.md)
- [Public alpha landing draft](public-alpha-landing.md)
- [Public architecture](architecture.md)
- [Product boundaries and extraction contract](product-boundaries.md)
- [External publicization roadmap](publicization-roadmap.md)
