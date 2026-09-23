# Fast Lane 기본화 확장 게이트 (stage-6, #2208 / #1601)

> **Status**: 규칙 문서. 이 문서는 코드 기본값을 바꾸지 않고, 기본화
> 확장(expansion)이 통과해야 할 증거 게이트와 단계별 승인 절차를 정의한다.
> 모든 게이트는 fail-closed다 — 증거가 없거나 불충분하면 "미확인"이지
> "통과"가 아니다. Refs #1601, #2208.

## 원칙

1. **기본값 불변**: Q1 `A2A_FAST_LANE_SKIP_REVIEW_ROUND`, Q2
   `A2A_FAST_LANE_SINGLE_WORKER_FINALIZE`는 코드 기본값이 항상 off다.
   연구/스테이징 벤치 환경에서의 활성화조차 환경 변수로만 하고, 활성화
   자체가 각 단계의 승인 대상이다.
2. **단계별 승인**: 롤아웃 6단계(#1601 P3)에서 각 단계는 독립 승인
   레코드를 요구한다. 이전 단계 승인이 다음 단계를 자동 승인하지 않는다.
   승인 레코드는 #2208 코멘트로 남긴다(누가/언제/어떤 증거로 무엇을
   승인했는지).
3. **증거 기반**: 기본화 결정은 오프라인으로 재검증 가능한 아티팩트에
   근거한다. 대화, 기억, 추정은 증거가 아니다.
4. **관측 우선**: fast lane 판정/재판정은 관측적이다. laneAssignment는
   create 시점 불변이고, 재판정은 별도 `laneRejudgment`(v1: fast→full만)
   + `task.lane_rejudged` audit으로 남으며 생명주기/스케줄링을 바꾸지
   않는다.

## 증거 아티팩트

- **stage-3 outcome canary**: `packages/broker/scripts/fast-lane-outcome-canary.mjs`
  (offline). 판정 정확도, 실행/게이트 실패 분리, 재판정 방향 불변식을
  스냅샷에서 검증한다. no-live 리포트를 증거로 첨부한다.
- **stage-5 bench 재측정**: `packages/broker/scripts/fast-lane-bench-remeasure.mjs`
  (offline 게이트). 운영자가 read-only broker audit SQL(실행 실패 = claim
  증거 있음, 게이트 실패 = 한 번도 claim되지 않고 실패)로 만든
  `a2a.fast-lane-bench-measurement.v1` 아티팩트만 입력으로 받는다. 이
  스크립트는 측정을 수행하지 않는다 — 측정은 별도 승인된 운영자 단계다.
- 첨부 형식: 각 게이트 실행의 md + JSON 리포트를 #2208에 남긴다.

## 정량 게이트 (스크립트 기본 임계값)

| 게이트 | 조건 | 임계값 |
|---|---|---|
| hygiene | 닫힌 schemaVersion, environment research\|staging, 코호트 산술(terminal = succeeded+failed+canceled, failed = executionFailures+gateFailures), p50 > 0 | 위반 시 즉시 실패 |
| p50 e2e 감소 | fast p50 ≤ full p50 × (1 − 0.10) | fast/full 각 min-sample 10 이상일 때만 판정 |
| 실패율 비악화 | fast 실패율 ≤ full 실패율 + 2pp | 실행/게이트 실패 분리를 리포트에 명시 |
| solo-vs-A2A 대등 | A2A 파일럿 성공률 ≥ solo 성공률 | 각 arm min-pilot-runs 2 이상일 때만 판정 |

표본이 임계값 미만이면 해당 게이트는 "insufficient sample"로 통과 처리되지만
**개선/비악화를 주장할 수 없다** — 리포트에 그대로 표시된다. 임계값
override는 CLI 플래그로 가능하나, 기본화 승인에 쓰는 실행은 기본값 사용을
원칙으로 하고 override 시 그 사유를 승인 레코드에 적는다.

baseline 문맥: analyze p50 T1 1.6m / T2 46.9s (P0 계측).

## 단계별 경로 (롤아웃 3~6 대응)

1. **칼나리 검증(단계 3)**: stage-3 canary를 운영 스냅샷(또는 동등한
   offline 스냅샷)에 실행, 전 기준 green. 최초 운영 대상 실행은 별도 승인.
2. **플래그 활성화(단계 4)**: research/staging 벤치 환경에 한해 Q1/Q2
   활성화. 프로덕션 활성화는 이 문서의 게이트를 모두 통과한 별도 승인.
3. **벤치 재측정(단계 5)**: 위 정량 게이트 전부 충족하는
   `a2a.fast-lane-bench-measurement.v1` 아티팩트 + 게이트 리포트.
4. **단계적 기본화(단계 6)**: 1~3의 증거 + 무결점 롤아웃 계획에 대한
   별도 승인. 기본값 변경은 코드 변경 없이 운영 플래그 레벨에서 단계적
   적용하고, 각 확장 폭에 대해 게이트를 재실행한다.

## 되돌리기

- 플래그 off는 완료 동작을 byte-identically 되돌린다 (기본 off 보장).
- 오분류가 확인된 fast 태스크는 운영자 재판정 v1(fast→full만,
  `POST /tasks/:id/rejudge-lane`, `task.lane_rejudged` audit)으로 되돌린다.
- 게이트 재실행에서 비악화가 깨지면 즉시 확장 중단 + 이전 승인 단계로
  롤백하고 #2208에 실패 보고(실패 보고 템플릿은 stage-5 스크립트 no-live
  출력 참조).

## 참조

- `docs/specs/fast-lane.md` — fast lane 본 스펙 (lane 판정, 안전 경계, 롤아웃)
- `packages/broker/scripts/fast-lane-outcome-canary.mjs` (stage-3, offline)
- `packages/broker/scripts/fast-lane-bench-remeasure.mjs` (stage-5, offline 게이트)
