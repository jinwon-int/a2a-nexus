# Fast Lane Spec — lightweight dispatch for low-risk single-shot tasks (#1601 P3)

> **Status**: spec-first packet. This document approves no runtime change,
> deploy, broker/worker restart, or flag enablement. Implementation and
> rollout each need their own approvals.

## 목적과 근거

P0 계측(issuecomment-5045766682)과 벤치 파일럿(solo 2:0)이 보여준 것:

- 태스크의 82~94%가 **analyze 단발**(p50 e2e 46s~1.6m, 단일 워커, 읽기 중심)인데,
  현재는 단순 태스크에도 중량 세레모니(라운드/리뷰/증거/finalizer)가 실린다.
- 브로커 디스패치 자체는 p50 ~4초로 병목이 아니다(F1). 비용은 실행 주변의
  오케스트레이션과 검증 대기에 있다(F5).
- 실패율 23%의 본체는 워커 실행 품질(F6)이므로, **fast lane은 세레모니만
  줄이고 신뢰 게이트는 줄이지 않는다** — 가벼워진 완료(false success)는
  오히려 악화(#1593).

목표: 저위험 단발 태스크가 **정직함을 유지한 채** 더 적은 세레모니로
완료되도록, 브로커가 선언적으로 판정하는 경량 경로를 둔다.

## Lane 판정 (브로커, 선언적)

lane은 요청자 힌트가 아니라 **브로커가 create 시점에 판정**한다. G1 정책
엔진(#1355, T1+T2 enforce 운영 중)과 같은 축 — 판정 결과는 태스크에
기록되고 audit에 남는다.

**fast lane 조건 (전부 충족 시에만)**:

1. intent = `analyze` (read-only 계열)
2. patch/write 계열이 아님 (payload.mode가 github-propose-patch / propose-patch / patch / source-only 외 write 류가 아님)
3. 단일 워커 대상 (라운드/팬아웃 아님)
4. 정책 문서상 require_approval 대상이 아님
5. 민감 표시 아님 (sensitive, 외부 전송, credential 접근 지시 없음)

**full ceremony 유지 (하나라도 해당 시)**: propose_patch / implementation /
라운드·팬아웃 / 모바일·간헐 워커(가용성 리스크, P0 F3) / 정책이 승인을
요구하는 클래스 / 민감 표시.

`defaultAction`은 보수적으로 **full** — 판정 불가/누락 시 fast가 아니라 full.

## fast lane에서 가벼워지는 것 / 절대 가벼워지지 않는 것

| 가벼워짐 (후보) | 절대 유지 |
|---|---|
| 라운드/다중 워커 팬아웃 오버헤드 (애초 단발이므로 무) | G1 정책 enforce (create/claim deny) |
| 독립 리뷰 라운드 (분석 산출물에는 미실시, evidence-only 메모로 대체) | 수용 기준(acceptance) — completion 정직성 |
| 증거 패킷의 중량 조립 — 간이 evidence(해시+요약+결정적 digest) | redaction / provenance 서명 / provenance 검증 |
| finalizer 라운드 (fast는 verdict 웨이브 생략 후보) | finalizer verdict **무결성 검증 자체**(서명 검증은 유지, 라운드 생략 여부는 별도 결정) |
| readiness lint의 경고성 단계 | readiness fail-closed 항목 |

명시적 미결정(구현 전 결정 필요): ① finalizer 라운드 생략 범위 — verdict
서명 검증은 유지하되 독립 리뷰 라운드를 생략할지, ② 간이 evidence의 최소
필드, ③ lane 기록 필드명(`payload.lane`).

## 안전 경계

- lane 판정은 audit(`task.lane_assigned` 후보 이벤트)에 남아 우회 불가.
- fast lane 태스크도 acceptance 실패 시 실패로 기록 — **간이 완료 없음**.
- 오분류(실제로는 고위험)는 되돌릴 수 있어야 함: 운영자가 태스크를 full로
  재판정 가능.
- 모바일/간헐 노드는 fast lane 대상에서 제외 (claim 게이트는 G1 정책 연계).

## 롤아웃 (각 단계 승인)

1. 스펙 확정(본 문서) → 2. lane 판정+기록만 구현(동작 변경 없음, 섀도) →
3. 칼나리로 판정 정확도 검증 → 4. 경량화 1개씩 opt-in 플래그로 도입(기본
off) → 5. 벤치 재측정 + 실패율 비악화 확인 → 6. 단계적 기본화.

## 성공 지표

- fast lane 대상 태스크의 p50 e2e가 full 대비 유의미하게 감소 (baseline: analyze p50 T1 1.6m / T2 46.9s)
- 실패율 비악화 (실행 실패와 게이트 실패 분리 집계 — P0-2(b) 분류 준용)
- 벤치 파일럿 재측정에서 A2A 협업이 solo와 대등 이상

## 코어 다이어트 연계

P3의 다른 축(코어 슬림화)과의 관계: fast lane이 본격화되면 full-only 경로가
줄어 정리 대상이 명확해진다. 스크립트 375개 축소(#1503)는 별도 트랙으로,
**사용 증거(CI/워크플로/package.json/브로커 참조) 기반 reverse-ratchet**로
진행 — 측정 없는 삭제 금지.
