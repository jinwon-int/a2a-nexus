# Bounded PR Review Lifecycle — Record-Mode Activation Approval Packet

> **Snapshot date:** 2026-08-06 (KST)
> **Parent:** [a2a-nexus#1518](https://github.com/jinwon-int/a2a-nexus/issues/1518)
> **Spec packet:** `docs/specs/bounded-pr-review-lifecycle/` (merged through Phase 0–18, last PRs #1685/#1686)
> **Status:** execution packet only — `recordModeActivation = PACKET_READY / Waiting scoped approval`. Nothing in this document has been activated.

## Summary

The bounded PR review lifecycle is fully implemented behind
`A2A_REVIEW_LINEAGE_MODE` (`off` default; `record` observational; `enforce`
rejected loudly at startup). Phases 0–18 delivered the spec packet, JSON
schemas, the pure lifecycle engine, durable store, five authenticated
mutation sources, read-only projections, and conformance coverage — all with
the mode `off` in every environment.

This packet requests a **separately scoped operator approval** to set
`A2A_REVIEW_LINEAGE_MODE=record` on the fleet brokers, so the ≥30 real
terminal-lineage scorecard (tasks.md Phase 7) can collect evidence. Without
record mode there is no real-lineage data, and the scorecard floor stays
`insufficient_evidence` by design.

```text
recordModeActivation = PACKET_READY / Waiting scoped approval
settingsChanged      = false
enforceMode          = NOT requested — `enforce` stays rejected at startup
```

## What record mode changes — and what it does not

Record mode is **observational**. Per `docs/operators.md` and the merged
implementation:

- It persists bounded PR review lineage telemetry and serves the read-only
  projections `GET /review-lineages` and `GET /review-lineages/{lineageId}`.
- It accepts the five authenticated mutation sources (`POST /review-lineages`,
  `.../operator-cancel`, `.../review-report`, `.../correction-generation`,
  `.../reviewer-replacement`) under their merged authority rules (operator
  role for operator-scoped sources; Ed25519 signature + `review-lineage.report`
  key scope for review reports).
- It does **not** change task completion, retry, approval, finalizer verdict,
  review-evidence, or dispatch behavior. The generic task/result/error/log
  paths are detached by construction (Phase 18 closeout criterion, verified).
- Public projections omit the frozen contract, full ledger, raw receipts, and
  diff hashes.
- `A2A_REVIEW_LINEAGE_MODE=enforce` (or any unknown value) fails broker
  startup loudly — this cannot be enabled by a typo.

## Live read-only posture (2026-08-06 KST)

- Repository: `jinwon-int/a2a-nexus`, branch `main` @ `66110f8285bbe1e7e2458433110563d7c422429a`
- Open PRs: 0
- Mode default in code and `.env.example`: `off`
- Broker fleet (실행 시점에 Family Wiki로 live 재확인; 공개 문서에는 노드명을 싣지 않는다):
  - Team1 broker of record 1대
  - Team2 broker of record 1대
- 모든 브로커는 현재 `A2A_REVIEW_LINEAGE_MODE` 미설정(=`off`)으로 간주 — 실행 전 단계에서 각 브로커의 unit/env를 live 확인해 확정한다.

## Requested approval scope (정확한 대상)

1. **대상**: Team2 broker of record 1대 먼저(canary), 관측 기간 후 Team1 broker of record.
2. **변경**: 브로커 서비스 env에 `A2A_REVIEW_LINEAGE_MODE=record` 추가. 코드/패키지/DB 스키마 변경 없음.
3. **재시작**: 각 브로커 서비스 1회 재시작(env 적용). 그 외 서비스·게이트웨이·워커 무건드림.
4. **기간**: 최소 30 real terminal lineage가 수집될 때까지(예상 수 주). 종료 후 scorecard readback 별도 보고.

명시적으로 요청하지 **않는** 것: `enforce` 전환, ruleset/브랜치 보호 변경, DB migration/prune/ACK/replay, provider send, deploy/배포, 배포 이미지 변경, 다른 서비스 재시작.

## Execution plan (승인 후, 단계별 확인 포함)

1. Live 재확인: 양 브로커의 현재 env(모드 미설정 확인), 서비스 상태, 디스크 여유.
2. **T2 broker**: env 파일 백업(타임스탬프 suffix) → `A2A_REVIEW_LINEAGE_MODE=record` 추가 → 브로커 재시작 → 부트 로그에 mode 파싱 에러 없음 확인 → `GET /review-lineages` 200 + 빈 목록 확인.
3. Canary 관측(최소 24시간): 기존 지표 무변경(작업 완료/재시도/5xx 비율) + lineage projection 정상.
4. **T1 broker**: 동일 절차.
5. 양쪽 활성 후 테스트 lineage 1건을 정상 라운드에서 자연 발생시켜 기록 경로 검증(합성 주입 아님).

## Observation plan

- 주간 1회 `GET /review-lineages` 스냅샷: lifecycle 상태 분포, terminal reason 분포, correction generation 수, finding churn.
- 스토리지: canonical lineage 테이블과 snapshot 크기 증가율 — retention 정책 범위 내인지 확인(기존 hot-table diagnostics로 관측 가능).
- 회귀 감시: 태스크 완료율, `handler_exit_nonzero` 비율, `/health` 200 유지, 평균 응답 시간 — record 모드 도입 전 baseline 대비.
- Scorecard: ≥30 real terminal lineage 도달 시 `scripts` scorecard로 readback — elapsed time, generation count, reviewer-run/replacement, finding churn, repeated-signature hits, drift/goalpost 거부, terminal reason. advisory-only, 30/100 샘플 floor 규칙 준수.

## Rollback

- 언제든: env에서 `A2A_REVIEW_LINEAGE_MODE=record` 제거(또는 `off`) → 브로커 재시작 → 즉시 `off` 시맨틱 복귀. 이미 기록된 lineage row는 읽기 전용 잔존(런타임 동작에 무영향); 물리 삭제는 별도 승인.
- 부트 실패 시: env 백업본으로 즉시 원복 + 재시작(각 브로커 독립, 상대 브로커 무영향).
- canary(T2)에서 이상 징후 시 T1 활성화를 진행하지 않고 본 패킷에 결과를 기록 후 중단.

## Safety boundaries

이 패킷은 승인되어도 다음을 승인하지 않는다: production deploy/이미지 변경, Gateway/worker 재시작, live canary/provider send, DB migration·outbox·ACK·replay·prune, release/tag/publish, secret 이동, visibility 변경, history rewrite/force push, GitHub ruleset 변경, `enforce` 모드 전환. Scorecard readback 후 `enforce` 기본값 논의는 별도 운영자 결정이다.

## Approval record

- Operator decision: **GO (T2 broker canary first)** — 2026-08-06 KST, 오너 승인("활성화 진행")
- Approved scope / date / approver: 패킷 §Requested approval scope 그대로 / 2026-08-06 / operator
- Execution log:
  - 2026-08-06 ~17:35 KST — **T2 broker 완료**: override 백업(`.bak-20260806-recordmode`) → `A2A_REVIEW_LINEAGE_MODE: record` 추가 → compose 재생성 → healthy, 부트 에러 0, `GET /review-lineages` 200(count 0), `/health` 200. 24시간 canary 관측 시작.
  - T1 broker: _(canary 관측 후 진행 여부 결정 — 미실행)_
