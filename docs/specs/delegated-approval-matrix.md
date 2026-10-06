# 하부위임전결 규정 (플릿 공통): 전결표 L0–L3 + 2지점 집행 (#2317)

> Language: Korean (design spec). 코드 식별자·경로는 원문(영문) 그대로 둔다.
>
> **Status: Draft — 비준 대기 (awaiting ratification).** 이 문서는 #2317 의
> Phase 0 산출물인 사양 문서다. 오너 결정(2026-10-06)에 따라 비준은 이 사양
> PR 을 검토하는 방식으로 하며, **이 문서가 머지되기 전에는 집행 코드(브로커·
> 개별 에이전트 2지점)를 착수하지 않는다.** 이 문서는 런타임 동작, 기본값,
> 라이브 브로커 설정을 바꾸지 않으며 어떤 승인도 부여하지 않는다.
> Size: Medium (docs-only spec). Refs #2317, ccc-node#2137, #2322.

## 1. 문제

운영자(사람)의 승인 대기가 A2A 작업과 플릿 개별 에이전트 작업의 주요
병목이다. 회사의 하부위임전결 규정처럼, 사전에 정한 **전결표**에 해당하는
결정은 상위(hub) 에이전트가 판단·승인하고, 전결표에 없는(=위임되지 않은)
중요한 결정만 사람이 결재하도록 한다.

현재 코드는 오히려 반대 방향의 문제를 갖고 있다. 브로커의 승인권은
`hub = operator` 로 뭉뚱그려져 있고 위험 등급 구분이 없다. 따라서 이 사양은
**신규 권한 부여가 아니라, 현재 뭉뚱그려진 승인권을 등급별 전결표로
축소·명시화**하는 작업이다.

## 2. 현재 상태 (근거)

이슈 본문은 main `cd77567`(2026-10-04) 기준으로 작성되었다. 아래 위치는
이 PR 의 기준인 `origin/main` `33c4892`(2026-10-06) 에서 다시 확인한 값이다.
#2322 머지로 줄 번호가 이동한 항목은 이슈 원문 위치를 함께 적는다.

| 항목 | 위치 (main `33c4892`) | 관찰 |
|---|---|---|
| 승인 플로 | `packages/broker/src/core/broker-task-approval.ts:53` `approveTask` | `blocked → approved → queued` 재개 + approval 레코드(`approvalId`/`approvedBy`/`actorRole`, :76–:79). 승인권 판정은 :58(approve), :123(reject-approval) 에서 `isPrivilegedTaskApprover` 호출 |
| 승인권자 판정 | `packages/broker/src/core/policy.ts:150` `isPrivilegedTaskApprover` | `role === "operator" \|\| role === "hub"` — **hub 와 operator 가 동등**, 위험 등급 구분 없음 |
| 승인 필요 판정 | `packages/broker/src/core/policy.ts:140` `isTaskApprovalRequired` | `DANGEROUS_TASK_INTENTS`(:95, `apply_local_change`·`promote_to_live`·`rollback_live`) · `liveImpact` · `targetEnvironment=live` · `requiresApproval` |
| HTTP 경로 | `packages/broker/src/http/tasks-decision-routes.ts:61` `readActorGatedBody` (이슈 원문 :99) | `enforceRequesterIdentity` 일 때만(:70) 인증 신원·hub/operator 역할 대조. 기본 on: `packages/broker/src/server.ts:343` `ENFORCE_REQUESTER_IDENTITY !== "0"` (이슈 원문 :340) |
| 승인자 자격증명 바인딩 (#2322) | `tasks-decision-routes.ts:116` `readApproverDecisionBody`, `server.ts:349` | opt-in `A2A_APPROVER_ROLE_BINDING` = `off`(기본) \| `enforce`. `enforce` 시 서명 키 소유자 == requester, 키 레코드가 `roles` 를 명시적으로 선언해야 승인 가능 (`request-security.ts:1001`–`:1026` `a2a_signature_approver_*`) |
| 서명 키 역할 제한 | `packages/broker/src/core/request-security.ts:514` | `a2a_signature_role_denied` — 키 레지스트리 `roles` 제한 |
| 보류 상태의 의미 중첩 | `packages/broker/src/core/types.ts:43` `TaskStatus`, :52–:55 주석 | `blocked` 는 "operator 승인 대기로 parking" 이라는 단일 의미만 정의됨 — 실행 금지 자리표시자 보류와 구분하는 상태/플래그 없음 |
| 실행 모드 초안 | `packages/broker/docs/operator-approval-request.md:59`–`:62` | `autonomous` / `operator_notify` / `operator_approval_gated` / `operator_review_gated` (source-only 초안) |
| 승인 기록 스펙 | `docs/specs/approval-record.md`, `fixtures/approvals/approval-record.schema.json` | `approverRole: const "operator"`, `action` enum 19종 |
| 역할 라벨 | `packages/broker/src/core/types.ts:2` `A2APartyRole` | `hub`·`operator`·`orchestrator` 등 8종. 브로커 내부 서비스 actor 도 `operator` 라벨을 쓴다(예: `broker-stale-task-requeue.ts:196`, `delegated-runtime.ts:264`, 둘 다 cancel 경로) — 라벨만으로 사람/에이전트를 구분할 수 없다는 관찰을 보강 |

### 2.1 Phase 0 조사 결과 (T2 브로커, 2026-10-05 KST, read-only)

#2317 코멘트(2026-10-04 UTC) 기록. 라이브 DB 를 read-only 스냅샷으로 조회했고
라이브 DB/설정은 변경하지 않았다. 이 PR 작성 시 재측정하지 않았다.

| 항목 | 결과 |
|---|---|
| `ENFORCE_REQUESTER_IDENTITY` 실효값 | `1` (on) |
| 감사 이벤트 보존 범위 | 2026-08-20 ~ 2026-10-04, 2,199건 |
| `task.approve` / `task.reject-approval` 이벤트 | **0건** |
| `policyContext.requiresApproval=true` 태스크 | **0 / 285** |
| intent 분포 | `analyze` 203 · `propose_patch` 43 · `skills_intake_revise` 35 · `verify` 4 (dangerous/live intent 0) |
| requester 역할 분포 | `operator` 283 · `orchestrator` 2 · `hub` 0 |

해석(이슈 기록 그대로):

1. 브로커 승인 플로는 T2 에서 실사용 0 이다. 현재 사람 승인 병목은 브로커가
   아니라 **개별 에이전트 측(PR 머지 등, ccc-node#2137)** 에 있다. 따라서
   Phase 1 섀도 대상은 PR 머지 승인으로 잡는다.
2. 에이전트 디스패처가 `operator` 역할로 요청하고 있어, 역할만으로 사람과
   에이전트를 구분할 수 없다. 이것이 §6 선행 조건 (a)(b) 의 근거다.

T1 브로커 조사에서는 `requiresApproval` + `blocked` 가 실제 승인 요청이 아니라
실행 금지용 부모 자리표시자(카나리·no-live 실험 부모, 디버그 레코드) 보류
용도로도 쓰이고 있음이 확인되었다(5건, 2026-05~06 생성). 이것이 §6 선행
조건 (c) 의 근거다. T1 전체 조사 체크박스는 아직 미완이다(§10 Q8).

## 3. 전결표 v0

이슈 #2317 "제안: 전결표 v0" 를 그대로 옮긴다. 등급·값을 추가하거나 바꾸지
않는다.

| 등급 | 결정 주체 | 예시 | 기존 모드 매핑 |
|---|---|---|---|
| **L0 자율** | 실무 에이전트 | 조사·분석, 브랜치 작업, PR 생성, 이슈 코멘트 | `autonomous` |
| **L1 상위전결 + 사후보고** | hub 에이전트 | docs/test-only PR 머지(exact-head CI green + 독립 리뷰), Wiki PR 머지, 이슈 트리아지/close, 워커 재시도·재배정 | `autonomous` + 일일 다이제스트 |
| **L2 상위전결 + 사전통지** | hub 에이전트, 이의창 경과 후 집행 | 비라이브 repo 코드 PR 머지, 비라이브 config 변경 | `operator_notify` |
| **L3 사람 결재** | operator | secrets · release/publish · DB/outbox/ACK/replay · 핫픽스 · provider send · broker/Gateway 재시작(TM-2134 영구정책) · cross-broker(T1↔T2) · **전결표 자체 변경** | `operator_approval_gated` / `operator_review_gated` |

- approval-record `action` enum 19종은 전부 **L3 고정**으로 시작한다(v0 에서
  하향 없음).
- 전결표에 열거되지 않은 결정은 위임되지 않은 것이며 L3 로 취급한다
  (원칙 1 의 fail-closed 와 동일).

## 4. 설계 원칙 (비준 요청 대상)

1. **분류는 행위 속성 기준·결정론적** — 가역성 / 영향 범위(로컬·플릿·외부) /
   외부성. 요청 에이전트의 자기신고 등급은 쓰지 않고, 브로커가 intent·target·
   변경 경로로 판정한다. **판정 불가·애매 → 상향(fail-closed)**.
2. **자기전결 금지** — 승인 actor ≠ 요청 actor(및 그 부모 태스크의 requester).
   가능하면 다른 노드/모델.
3. **쪼개기 방지** — 동일 이슈/에픽 단위 누적 한도 초과 시 상향.
4. **승인 입력 구조화** — hub 의 판단 입력은 CI 결과·exact-head SHA·diff 통계·
   변경 경로 등 구조화 증거로 제한한다. 하위 산출물 원문(untrusted) 직접 투입
   금지(프롬프트 인젝션 경로 차단).
5. **사후 통제** — 전결 승인 일람 일일 다이제스트(운영 채널), 표본 사후 재검토,
   **즉시 전결권 회수 kill switch**(env/config 1개로 L1·L2 → L3 전환).
6. **경계 고정** — T2 hub 는 T1 태스크 전결 불가(cross-broker = L3). 전결표
   변경은 항상 L3.
7. **강제 지점은 브로커 코드** — 프롬프트/런북 규정만으로는 불충분하다.
   `isPrivilegedTaskApprover(actor)` → `canApprove(actor, task, tier)` 형태로
   등급 인지형 판정, approval 레코드에 `tier`·`delegationRuleId` 기록,
   approval-record 스키마 `approverRole` 을 `operator | hub(delegated)` 로
   확장하되 L3 action 은 `operator` 고정.

## 5. 범위: 플릿 공통 — 단일 정본 + 2지점 집행

2026-10-05 오너 결정: 전결표는 A2A 브로커 태스크뿐 아니라 **플릿 개별 에이전트
작업에도 동일하게 적용**한다.

### 5.1 단일 정본

- 전결표의 정본은 **이 문서(`docs/specs/delegated-approval-matrix.md`) 하나**다.
  브로커와 ccc-node 모두 이것을 읽는다. 사본을 두지 않는다.
- 정본 변경은 전결표 자체 변경이므로 항상 L3(원칙 6).

### 5.2 집행 지점 2곳

| # | 집행 지점 | 형태 | 추적 |
|---|---|---|---|
| 1 | 브로커 | `isPrivilegedTaskApprover` → 등급 인지형 `canApprove(actor, task, tier)`. approval 레코드에 `tier`·`delegationRuleId` 기록 | #2317 (이 사양 머지 후 별도 PR) |
| 2 | 개별 에이전트 | 승인 실행 스크립트(`gh-pr-flow` `approve-via-relay.sh` 등)가 **브로커 결재 영수증**을 검증. PreToolUse 가드는 재도입하지 않는다(TM-1306, ccc-node PR #576 존중) | ccc-node#2137 — 2026-10-06 확인 시 **OPEN** ("design(approval): 하부위임전결 개별 에이전트 집행 — 브로커 결재 영수증 검증 (a2a-nexus#2317 하위)") |

### 5.3 결재 태스크와 영수증

- 개별 에이전트의 L1/L2 결정은 소속 팀 브로커(T1 / T2)에 **결재 태스크**로
  올리고, hub 가 판정하며, 브로커가 서명 영수증을 발급한다. 영수증 필드:
  `approvalId` · `tier` · `delegationRuleId` · `target` · exact-head · 만료.
- 결재 경로·감사·kill switch·다이제스트를 브로커로 일원화한다.

### 5.4 적용 경계

- **대화형 vs 부재** — 오너가 현재 대화에서 직접 지시·승인한 건은 전결 대상이
  아니다. 전결은 백그라운드/cron/자율 진행 결정에만 적용한다.
- **브로커 불통 = L3 상향**(fail-closed).
- **hub 노드 자기결재 차단** — 요청 노드가 hub 노드(T1 hub / T2 hub)이면 타 팀
  hub 또는 사람으로 라우팅하거나 자격증명을 분리한다. 세부는 ccc-node#2137
  (구체 우회 경로는 §10 Q6).

## 6. Phase 0 선행 조건

전결(L1/L2)을 실제로 개방하기 전에 다음 세 가지가 충족되어야 한다. 이 PR 은
조건을 정의만 하며, 어느 것도 구현·활성화하지 않는다.

### (a) 역할 ↔ 자격증명 바인딩

- 요청 헤더의 역할 주장만으로는 승인(특히 L3) 불가. 역할은 인증된 자격증명에
  바인딩되어야 한다.
- 코드 측 기반은 머지된 #2322(`f584bdb`): opt-in `A2A_APPROVER_ROLE_BINDING`
  (`off` 기본 | `enforce`). `enforce` 에서는 approve / reject-approval 에 대해
  서명 키 소유자 == requester, 키 레코드의 명시적 `roles` 에 주장 역할 포함,
  body `actor` == 서명 requester 를 요구한다. `hub`/`operator` 는 여전히
  `isPrivilegedTaskApprover` 에서 동등하며, 이를 분리하는 것이 전결 등급 작업이다.
- 에이전트 디스패처는 `operator` 가 아닌 별도 역할(`orchestrator`/`hub` 등)로
  이관한다 — 시점은 §10 Q7.
- **미결**: 전결 개방(Phase 2) 의 전제로 `enforce` 를 필수로 할지 — §10 Q10.

### (b) L3 = 사람 전용 자격증명

- L3 승인은 에이전트 프로세스가 접근할 수 없는 경로에 보관된 사람 전용
  자격증명으로만 가능해야 한다. 이 문서는 자격증명 위치·값을 기록하지 않는다
  (취급 규칙만 기록).

### (c) 보류(parking) 와 승인 대기 상태 분리

- 실행 금지 자리표시자 보류와 승인 대기를 **별도 상태/플래그로 분리**한다.
  승인 대기열·전결 판정·다이제스트·만료(TTL)·사람 통지는 **승인 대기만**
  대상으로 한다. 승인 게이트를 보류 용도로 재사용하면 대기열이 오염되어 위
  설계들이 오탐을 낸다.
- 현재 `TaskStatus` 의 `blocked` 는 두 용도를 구분하지 못한다(§2 표).
- 기존 자리표시자 5건(T1, 2026-05~06 생성)은 현재 무해하므로 **변경하지 않고
  유지**한다(운영자 결정 2026-10-05). 상태 분리 하드닝 시 함께 정리하며, 그
  정리는 DB 변경이므로 별도 승인 대상이다.

## 7. 단계안

| Phase | 내용 | 진입 조건 |
|---|---|---|
| **0 (이 문서)** | 전결표 v0 + 분류 규칙 + 원칙 비준. 산출물 = 이 문서 (+ 분류 fixture, §10 Q11) | — |
| **1 섀도 모드** | hub 가 전결 판정만 기록, 실제 승인은 기존대로 사람. 사람 결정과의 일치율·상향률 측정. 우선 대상은 PR 머지 승인(§2.1 해석 1) | 이 사양 머지. 기간 확정 시 #2317 에 KST 절대 종료일시 코멘트 (§10 Q5) |
| **2 L1 한정 개방** | docs/test-only PR 머지부터 실전결 | kill switch 검증 후. §6 선행 조건 충족 |
| **3** | L2 확대 여부 재판정 | Phase 2 결과 검토 |

## 8. 비범위 (Non-goals)

- PreToolUse 가드 재도입.
- 런타임 코드 변경(`canApprove`, 스키마 확장, 상태 분리, 영수증 검증 포함) —
  이 사양 머지 후 별도 PR·승인.
- 라이브 브로커 설정 변경·재시작(`A2A_APPROVER_ROLE_BINDING` 활성화, 키
  프로비저닝 포함).
- 기존 fresh-approval 게이트(RB-35·TM-2134) 완화.
- 기존 자리표시자 5건의 변경·정리.
- 전결표 v0 에 없는 등급·값의 신설, approval-record `action` 의 L3 하향.
- 이 문서는 어떤 개별 행위에 대한 승인도 부여하지 않는다.

## 9. 안전·승인 경계

- **비밀정보**: 이 문서와 후속 PR 은 자격증명 값·위치, 사설 엔드포인트, IP,
  토큰, 개인 채널 ID 를 기록하지 않는다. 취급 규칙만 기록한다.
- **사람 승인 필요(이 PR 에서 수행하지 않음)**: production deploy, Gateway/
  broker/worker 재시작, live canary/provider send, DB 변경/prune/migration/
  replay, Terminal Brief ACK/replay, release/tag, secret 이동, force push.
- **검증 설계(후속 구현 PR)**: 분류 fixture 를 오라클로 삼아 `canApprove`
  RED→GREEN 증거를 제출한다. 분류 오라클은 구현 레인과 독립이어야 한다
  (constitution §7·§8).
- **롤백**: 이 PR 은 문서만 추가하므로 revert 로 충분하다. 후속 집행 단계의
  롤백은 kill switch(L1·L2 → L3) 이다.

## 10. Open questions for the owner (비준 전 결정 필요)

이슈가 값을 지정하지 않은 항목이다. 이 문서는 값을 임의로 정하지 않는다.
비준 시 각 항목의 값 또는 "후속 결정" 여부를 정해야 한다.

| # | 질문 | 이슈 상의 근거 |
|---|---|---|
| Q1 | **L2 이의창 길이** — 사전통지 후 집행까지 대기 시간(그리고 이의 제기 채널·방법) | 전결표 L2 "이의창 경과 후 집행" |
| Q2 | **쪼개기 방지 누적 한도 값** — 동일 이슈/에픽 단위 한도(건수·diff 규모·기간 등 측정 기준과 값) | 원칙 3 |
| Q3 | **kill switch env/config 이름**과 위치(브로커·ccc-node 공통 여부), 기본값 | 원칙 5 |
| Q4 | **결재 영수증 만료** — 유효 기간, exact-head 변경 시 무효화 규칙 | §5.3 영수증 "만료" |
| Q5 | **Phase 1 섀도 종료일** — KST 절대 종료일시, 및 Phase 2 진입 판정 기준(일치율·상향률 임계값) | 단계안 Phase 1 |
| Q6 | **hub 노드 자기결재 우회 경로** — 타 팀 hub 라우팅 / 사람 라우팅 / 자격증명 분리 중 무엇을 기본으로 할지. 타 팀 hub 라우팅은 cross-broker(L3, 원칙 6) 와 충돌하지 않는지 | §5.4, ccc-node#2137 |
| Q7 | **디스패처 `operator` → `orchestrator` 이관 시점** — Phase 1 이전 필수인지, Phase 2 이전인지 | §2.1 해석 2, #2322 Analyze notes |
| Q8 | **T1 조사 미완 체크박스(2026-10-04)** — T1 브로커 동일 조사(`task.approve` actorRole 분포, `ENFORCE_REQUESTER_IDENTITY` 실효값 등)를 비준 전 필수로 할지. 같은 코멘트의 "개별 에이전트 측 PR 승인 요청 빈도(기준선)" 도 미완 | #2317 코멘트 2026-10-04 "남은 확인" |
| Q9 | **문서 형식 컨벤션** — 단일 파일(이 PR) 유지 vs `docs/specs/<name>/` 의 `spec.md`/`plan.md`/`tasks.md` 디렉터리. 이 PR 은 이슈·오너 결정이 지정한 경로(단일 파일, 브로커·ccc-node 가 읽는 단일 정본)를 따랐다. `docs/specs/` 에는 두 형식이 모두 존재한다 | §5.1, `docs/spec-templates/README.md` (Medium = spec + plan) |
| Q10 | **`A2A_APPROVER_ROLE_BINDING=enforce` 필수화 여부** — 전결 개방 전 라이브 브로커에서 `enforce` 를 필수 전제로 할지(현재 기본 `off`) | §6 (a), #2322 |
| Q11 | **분류 fixture 범위** — 이슈 단계안은 Phase 0 산출물에 "분류 fixture" 를 포함하나, 오너 결정(2026-10-06)의 사양 PR 범위에는 명시되지 않았다. 이 PR 에 포함하지 않았다. 별도 PR 로 할지, 비준 전 필수인지 | 단계안 Phase 0 vs 2026-10-06 결정 |

## 11. 참조

- #2317 — 이 사양의 이슈 (본문, 2026-10-04 조사·요구사항 코멘트, 2026-10-06
  진행 방식 결정)
- #2322 (MERGED, `f584bdb`) — opt-in `A2A_APPROVER_ROLE_BINDING`
- jinwon-int/ccc-node#2137 (OPEN) — 개별 에이전트 집행: 브로커 결재 영수증 검증
- #1480 (CLOSED) a2a-policy-referee, #1488 (CLOSED) a2a-escrow-proof
- `docs/specs/approval-record.md`, `fixtures/approvals/approval-record.schema.json`
- `packages/broker/docs/operator-approval-request.md`
- `docs/a2a-constitution.md` §5 Approval boundaries are explicit
- 운영 위키 RB-35(A2A Broker Operating Rules §3), TM-2134(broker/Gateway 재시작
  영구 fresh-approval), TM-1306 — 비공개 운영 위키, 본문은 이 레포에 복제하지 않음
