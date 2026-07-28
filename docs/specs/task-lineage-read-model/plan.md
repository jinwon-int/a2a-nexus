# Plan: Task Lineage Read Model

Spec: [`spec.md`](./spec.md) (a2a-nexus#1635 P1-B)

## Phase 0 — 데이터 실측 (구현 전)

- 기존 태스크 저장소에서 parentage 필드 충족률 조사: `parentTaskId` 설정 비율,
  `parentRoundId` 스탬프 비율, orphan(`parentMissing`) 실측 건수.
  spec의 계약이 실데이터 분포와 맞는지 먼저 검증한다 (측정 없이 스키마 확정 금지).
- 산출: 측정 노트 + 골든 픽스처 후보 라운드 2개 선정.

측정 노트 (2026-07-28): 최근 500개 list-projected task를 read-only로
표본 조사한 결과 Team1은 `parentTaskId=4`, `parentRoundId=0`,
`referenceTaskIds=0`; Team2는 `parentTaskId=1`, `parentRoundId=0`,
`referenceTaskIds=0`이었다. list projection이 lineage 필드를 생략할 수
있으므로 이 수치는 해당 read surface만 설명하며 durable record에 필드가
없음을 증명하지 않는다. 기존 `round-coordinator-closeout`의
`all-complete.json`, `mixed-states.json`을 두 recorded round-shaped golden
fixture 입력으로 사용한다.

## Phase 1 — 읽기 모델 코어 (순수 함수)

- `packages/broker/src/core/task-lineage-read.ts` (신규):
  태스크 레코드 컬렉션 → 부모 인덱스 → `childrenOf`, `ancestorsOf`(cycle 감지),
  `leavesOf`(필터 AND 결합). 엔진은 순수 함수, I/O 없음.
- `tasks/children` anchor 불일치 해소: closed request는 `taskId` 또는
  `parentRoundId` 중 정확히 하나만 허용한다.
- canonical ancestry는 `parentTaskId`만 사용한다. `referenceTaskIds`는
  typed child/leaf/rejoin edge이며 canonical parent를 대체하지 않는다.
- 사이클 가드: 방문 집합 기반, 감지 시 `task_lineage_cycle` 구조화 오류.
- 단위 테스트: 분기/재합류(`referenceTaskIds`)/고아/사이클 픽스처 (spec Success criteria #2).

## Phase 2 — JSON-RPC 표면

- `tasks/children`, `tasks/lineage`, `tasks/leaves` 메서드 추가 (canonical parser,
  unknown 필드 fail-closed — review-lifecycle 파서 규칙 준용).
- 페이지네이션: `limit`(기본 200, 상한 1000) + `cursor`.
- 접근 제어: 기존 태스크 read 권한과 동일 경계 (신규 권한 모델 도입 금지).

## Phase 3 — 검증/증거

- 골든 픽스처: 기록된 라운드 2개의 스탬프 자식 집합과 `tasks/children` 응답 일치 확인
  (spec Success criteria #1, #4).
- 회귀: 기존 broker 테스트 스위트 + 신규 픽스처.
- 메트릭 카운터: `task_lineage.cycle_detected`, `task_lineage.parent_missing`.

## Non-goals (반복 확인)

- 쓰기 경로/내구 테이블/재부모화 없음. ReviewLineage(review-lifecycle) 변경 없음.
- finalizer/verdict 입력으로의 사용 금지 (#1373 K3 경계 준용).
- cross-broker 집계는 별도 spec (#1504 shared-state 논의 이후).

## 롤아웃

- v1은 읽기 전용 프로젝션(요청 시 구축 또는 인메모리 인덱스). 내구 프로젝션
  테이블 승격은 운영자 승인 게이트.
