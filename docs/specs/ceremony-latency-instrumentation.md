# Ceremony Latency Instrumentation Design (#1601 F5)

> **Status**: design for measurement only. This document does not approve
> production deploys, broker/Gateway/worker restarts, credential movement,
> or any runtime change.

## 목적

#1601 P0 계측(issuecomment-5045766682)의 F5: solo 대비 A2A 갭의 상당부분이
**브로커 밖 세레모니**에 있다는 가설을 검증한다. P0는 브로커 가시 구간
(create→claim→start→terminal)만 측정했다. 본 설계는 태스크/PR의 전체
생애를 5개 단계로 분해해, 어디서 시간이 새는지 계측 가능하게 한다.

원칙: **측정이 먼저, 런타임 계측 포인트 추가는 데이터 갭이 확인된 뒤 최소로.**

## 단계 모델

| 단계 | 구간 | 현재 데이터 |
|---|---|---|
| **S1 계획 (plan)** | 웨이브/작업 결정 → broker task created | **갭** — 디스패처 로컬에만 존재 |
| **S2 디스패치 (dispatch)** | created → claimed → started | broker audit (P0 측정 완료: p50 ~4s) |
| **S3 실행 (execute)** | started → worker 결과 제출 | 부분 — broker started/succeeded + runner workDir 타임스탬프 |
| **S4 완료·검증 (finalize)** | 제출 → broker accepted → finalizer verdict | broker audit(terminal, verdict 이벤트) |
| **S5 랜딩 (land)** | verdict 통과 → PR 생성 → checks → 리뷰 승인 → merge | GitHub API (created_at, check runs, reviews, mergedAt) |

## 데이터 소스 매트릭스

| 소스 | 내용 | 접근 |
|---|---|---|
| broker audit (T1/T2 sqlite) | task.* 이벤트 타임스탬프, finalizer verdict | 읽기 전용 SQL (P0와 동일) |
| runner workDir | run.json 생성시각, artifact manifest mtime, failure-output.log | 워커 호스트 파일 |
| GitHub | PR created_at / check started+completed / review submitted / mergedAt | gh api |
| 디스패처 (wave/브리프) | 웨이브 계획 결정 시각 | **없음 — S1 측정 불가** |

## 측정 방법 — 1단계: 오프라인 조인 (런타임 변경 0)

기존 데이터만으로 S2~S5를 우선 계측한다:

1. broker audit에서 태스크 타임라인 추출 (P0 스크립트 재사용 + verdict 이벤트 추가).
2. 태스크 id ↔ PR 매핑: task payload의 branch/prUrl, 또는 PR 제목/본문의 task id 관례.
3. GitHub에서 PR 타임라인 조인 (생성→첫 체크→체크 완료→승인→머지).
4. 산출: 태스크/PR별 S2~S5 단계 시간 + 전체 e2e, p50/p95, 이상치 목록.

이 1단계만으로 "브로커 안(S2~S4) vs GitHub(S5)"의 시간 비중이 나온다 — S5가
크면 세레모니의 본체는 GitHub 플로우 대기, S4가 크면 finalizer/리뷰 대기.

## 갭과 최소 계측 포인트 (2단계, 별도 승인)

- **S1**: 디스패처가 wave 계획 확정 시각을 태스크 payload(`payload.planDecidedAt`)
  또는 생성 이벤트 노트에 기록 — 문자열 1개, 계약 영향 없음.
- **S3 내부 분해**: runner가 `run.json`에 `firstModelCallAt`/`evidenceAssemblyMs`
  타임스탬프 추가 — 실행 시간의 LLM 대기 vs 로컬 오버헤드 분리.
- **S4**: finalizer 라운드 왕복이 audit에 이미 있으면 조인, 없으면 verdict
  요청/수신 이벤트 쌍 추가 여부 결정.

## 산출물 형식

주간 집계 리포트(로컬 JSON + 요약): 단계별 p50/p95, 단계 비중 파이, 이상치
top-10, 노드/intent 분할. fast lane 대상 분류(#1601 P3)의 직접 입력:

- S2~S4가 작고 S5가 큰 레인 → GitHub 플로우 간소화가 효율 개선의 본체.
- S1/S3가 큰 레인 → 오케스트레이션/실행 경량화가 본체.

## 비목표

- 런타임 대시보드/실시간 메트릭 (오프라인 집계로 시작).
- 디스패처/러너 동작 변경 (2단계 계측 포인트도 별도 승인).
