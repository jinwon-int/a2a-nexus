# A2A Nexus Promotion Announcement Draft

A2A Nexus is still an alpha, feedback-welcome project. The repository remains private unless a separate operator-approved GitHub visibility change is executed and evidenced; broader promotion (stable release, public docs site, npm/Docker publication, announcements) remains blocked on the promotion-readiness gates in [`docs/public-readiness.md`](./public-readiness.md). Do not post announcements from task automation.

## Short Korean copy

A2A Nexus은 OpenClaw 작업을 브로커와 워커로 안전하게 나누어 실행하고, `Done` / `Block` / PR 링크 같은 터미널 증거를 모으는 알파 단계 프로젝트입니다. 아직 프로덕션용이 아니며, 접근 권한이 있는 검토자의 설계·문서·안전 경계 피드백과 사용 사례 제안을 환영합니다. 공개 전에는 보안/히스토리 스캔과 운영자 승인 게이트를 반드시 통과합니다.

## Short English copy

A2A Nexus is an alpha project for routing OpenClaw tasks through a broker/worker flow and collecting terminal evidence such as `Done`, `Block`, or PR links. It is not production-ready yet, and feedback on the design, docs, and safety boundaries is welcome. The repository remains private unless a separate operator-approved GitHub visibility change is executed and evidenced; visibility change and broader promotion both require clean readiness evidence and explicit operator approval.

## Repository surface recommendations

These are GitHub repository settings, not code changes. Apply them only through an approved repository-settings action:

- **Name:** `A2A Nexus`
- **Description:** `Alpha broker/worker task plane for OpenClaw with terminal evidence collection.`
- **Homepage:** leave blank until a public documentation site exists.
- **Topics:** `a2a-plane`, `a2a`, `openclaw`, `broker`, `worker`, `task-runner`, `alpha`, `agent-tools`.

## Announcement safety checklist

Before any announcement is posted:

- Keep the product name as A2A Nexus in announcement drafts, repository metadata, and public copy.
- Keep the tone alpha/feedback-welcome; do not imply production readiness.
- Confirm `docs/public-readiness.md` records the current private/public-readiness state and keeps visibility, promotion, release, and publication gates separate.
- Confirm external secret/history scanner evidence is clean or explicitly dispositioned.
- Confirm promotion authorization is separate from any execution step.
- Do not include private endpoints, host paths, provider IDs, tokens, raw transcripts, or production evidence.
