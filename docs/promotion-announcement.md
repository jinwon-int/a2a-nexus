# A2A Nexus Promotion Announcement Draft

A2A Nexus is a public alpha, feedback-welcome project. The repository is publicly readable, but broader promotion (stable release, public docs site launch, npm/Docker publication, announcements, production deployment, or live operations) remains blocked on the promotion-readiness gates in [`docs/history/public-readiness.md`](history/public-readiness.md) and separate explicit operator approval. Do not post announcements from task automation.

## Short Korean copy

A2A Nexus는 OpenClaw 작업을 브로커와 워커로 안전하게 나누어 실행하고, `Done` / `Block` / PR 링크 같은 터미널 증거를 모으는 공개 알파 단계 프로젝트입니다. 아직 프로덕션용이나 안정 릴리스가 아니며, 설계·문서·안전 경계 피드백과 사용 사례 제안을 환영합니다. 더 넓은 프로모션, 안정 릴리스, 패키지/이미지 배포, 공개 문서 사이트 런칭, 프로덕션 배포는 별도 게이트와 명시적 운영자 승인이 필요합니다.

## Short English copy

A2A Nexus is a public alpha project for routing OpenClaw tasks through a broker/worker flow and collecting terminal evidence such as `Done`, `Block`, or PR links. It is not production-ready yet, and feedback on the design, docs, and safety boundaries is welcome. Stable release, broader promotion, package/image publication, public docs site launch, production deployment, live operations, and any future visibility transfer remain separately approval-gated.

## Repository surface recommendations

These are GitHub repository settings, not code changes. Apply them only through an approved repository-settings action:

- **Name:** `A2A Nexus`
- **Description:** `Public alpha broker/worker task plane for OpenClaw with terminal evidence collection.`
- **Homepage:** leave blank until a public documentation site exists.
- **Topics:** `a2a-plane`, `a2a`, `openclaw`, `broker`, `worker`, `task-runner`, `alpha`, `agent-tools`.

## Announcement safety checklist

Before any announcement is posted:

- Keep the product name as A2A Nexus in announcement drafts, repository metadata, and public copy.
- Keep the tone public alpha / feedback-welcome; do not imply production readiness.
- Confirm `docs/history/public-readiness.md` records the current public-alpha state and keeps visibility transfer, promotion, release, publication, deployment, and live-operation gates separate.
- Confirm external secret/history scanner evidence is clean or explicitly dispositioned in a public-safe way.
- Confirm promotion authorization is separate from any execution step.
- Do not include private endpoints, host paths, provider IDs, tokens, raw transcripts, or production evidence.
