# Release and package readiness

This page is a PR-safe readiness plan for [#1180](https://github.com/jinwon-int/a2a-nexus/issues/1180). It prepares an eventual release/package decision without creating a GitHub Release, tag, npm package, Docker image, GHCR image, deployment, or homepage metadata change.

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
- [ ] known limitations and rollback/deprecation expectations.

## Package contents audit

For any candidate package/image surface, the release issue or PR must show:

- which workspace or image is being considered;
- what files would be included;
- what files are explicitly excluded;
- confirmation that no runtime config, `.env`, private operator notes, raw session dumps, tokens, provider IDs, Telegram IDs, production data, or host-local paths are included;
- install or run smoke output from a disposable environment.

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
- [External publicization roadmap](publicization-roadmap.md)
