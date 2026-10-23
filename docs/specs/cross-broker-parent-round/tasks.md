# Tasks: cross-broker 부모 라운드 2단계 (#2339)

> Language: Korean (design spec). 코드 식별자·경로는 원문(영문) 그대로 둔다.

## Preconditions

- [x] 오너 설계 결정 기록(#2339, 2026-10-22).
- [ ] spec/plan PR 머지(이 디렉터리).
- [ ] Analyze: handoff-receiver 자식 생성 경로의 `originTaskId` 유무 집계 → 앵커 결합 vs
      명시 mint 폴백 결정을 spec §1+2에 기록.

## PR-6 필드 분리
- [ ] `handoffBrokerId` 추가(request/projection/relay sender), routing·wrong_origin 검사 이전.
- [ ] 구형 packet 호환 + `legacy_origin_as_handoff` 카운터, 스냅샷 복원 키 호환.
- [ ] 계약 2종 문구, 4-case fixture 갱신, RED 로그.

## PR-5 로컬 fallback
- [x] 영구 실패 분류(부모 영구 거부 코드, `stale_replay` 제외 — spec §5 정정) → `relayFallback` row, 부모 타이틀 금지 테스트.
- [x] 쓰기 경로 `POST /a2a/tasks/terminal-outbox/relay-fallback`(원본 이벤트에서 생성), 계약 라벨 제목.
- [x] idempotent(이벤트당 1개), `relayFallbackLocal` 카운터, `/health`.

## PR-1a/1b/1c 레지스트리
- [ ] `ParentRoundRegistry` + sidecar 3지점 + hot-restart RED→GREEN.
- [ ] `POST /a2a/parent-rounds`(operator/hub, idempotent/409) + helper 배선 + 폴백 제거.
- [ ] handoff-receiver foreign 등록 + anchors(`originTaskId`).
- [ ] 판정 배선 + `missing_anchor` + `parent_resolved_via` + 항목 2 필드.
- [ ] 자기참조 `<round>-t2` → 여전히 `missing_parent` 회귀 (f).

## PR-3b 슬롯
- [ ] 늦은 `completedAt` 우선 + `superseded` 보존 + retry child 테스트.

## PR-4 sender-proof 모드
- [ ] `off|record|enforce`, record 카운터, anchor 없는 enforce startup 거부.

## 배포/전환 (별도 승인, 이 레포 PR 아님)
- [ ] 1차 배포(PR-6·5) · 2차 배포(PR-1·3b) · `record` · 7일 창 · 동시 `enforce`.
- [ ] 정식 handoff 카나리 case 2·4 → #2339 close.
