# Feature Spec: cross-broker 부모 라운드 2단계 — 부모 판정 재설계 + 보류 항목 (#2339)

> Language: Korean (design spec). 코드 식별자·경로·reject code는 원문(영문) 그대로 둔다.
>
> **Status: Draft — 오너 설계 결정(2026-10-22, #2339 코멘트)을 사양으로 옮긴 문서.**
> 이 문서는 런타임 동작·기본값·라이브 브로커 설정을 바꾸지 않으며 어떤 승인도
> 부여하지 않는다. 구현은 `plan.md`의 PR 순서대로, 양 broker 배포는 항목마다
> 별도 승인이다. Size: Medium (단일 레포, 소스 전용, 6개 항목 PR).
> Refs #2339, #2331(1단계, closed), #2336(3a), contracts
> `contracts/a2a/parent-terminal-brief-aggregation.md`,
> `contracts/a2a/broker-handoff-protocol.md`.

## Problem

cross-broker Terminal Brief projection이 구조적으로 `missing_parent`로 끝난다
(#2331 조사: T2 terminal-outbox 829건 중 parent-owned 60건 전부 미투영).

- 부모 판정이 **태스크 ID 기준**이다. `broker.ts`의
  `hasParentRound: (parentRoundId) => this.tasks.has(parentRoundId)`. 실제 팀
  라운드는 `X-t1:<worker>` 태스크들을 payload `parentRoundId=X-t1`로 묶는데
  `X-t1`이라는 태스크는 없다. 브로커에는 부모 라운드를 발급(mint)하는 API나
  저장소가 없다.
- dispatch helper가 `--handoff-parent-round-id`가 없으면 `--parent-round-id`로
  대체해 **자기 라운드를 부모로 지정**한다. 받는 broker는 payload의 "부모는 X"
  주장을 그대로 받는다.
- 1단계(#2331, `4417b6d7`, 2026-10-06 양 broker 반영)는 노드 ID가 소유자가 되는
  것과 unknown owner를 막았다(`originBrokerId` 기본값 = 받는 broker, known
  broker 검증, `notificationOwnershipFallback.reason=unknown_owner_broker`).
  그러나 **정식 handoff 경로를 포함해 부모 broker에서 projection이 accepted되는
  운영 경로는 아직 없다**(handoff-receiver는 자식 쪽에만 태스크를 만든다).
- 프로젝션 요청의 `originBrokerId`는 코드 주석상 "Broker that produced the
  child Terminal Brief"(= handoff broker)인데, 계약상 `originBrokerId`는 "부모
  라운드를 mint한 broker"다. 같은 필드가 두 뜻으로 쓰인다.
- sender-proof는 trust anchor 파일이 있으면 enforce, 없으면 검사 생략의 2상태라
  "필수"로 가는 중간 단계(record)가 없다.
- 계약 routing gate 5("relay 실패 시 로컬 운영자 알림으로 fallback")가 구현돼
  있지 않다.

## 오너 설계 결정 (2026-10-22)

| 항목 | 결정 |
|---|---|
| 1. 부모 판정 재설계 | **L1 owner/origin 분리 + foreign 분류 + L2 `originTaskId` 앵커 결합**(기본안). "origin broker 전용 명시 mint 레코드"는 앵커 결합이 handoff-receiver 흐름과 맞지 않을 때의 폴백. 어느 쪽이든 **payload만으로 라운드를 만들 수 없어야 한다.** |
| 2. helper `teamScope`·`initiatingBrokerId` | 항목 1과 같은 PR 묶음에서 resolver 레지스트리 배선과 함께 반영(단독 효과 0). |
| 3b. `parentRoundOrder` 슬롯 중복 | "같은 슬롯은 더 늦은 `completedAt`이 우선". retry child(`…-t2r2`) 회귀 테스트. |
| 4. sender-proof pinning | **필수(enforce)**. 도입은 record(위반을 카운터로만 기록) → 양 broker 동시 enforce. enforce 전환은 별도 승인. |
| 5. 계약 L34 로컬 fallback 알림 | 구현 승인. |
| 6. `originBrokerId` / `handoffBrokerId` 분리 | 구현 승인. |

실행 순서: **6 → 5 → (1+2) → 3b → 4.**

## User / operator stories

- As an operator, 다른 팀 broker에 넘긴 자식 레인이 끝나면 **내가 라운드를 시작한
  broker**에서 `A2A Terminal Brief 완료: <worker>(<n>/<N>)` 한 줄을 받고 싶다.
  지금은 그 알림이 `missing_parent`로 조용히 사라진다.
- As a broker/finalizer, 부모 라운드가 **누가 언제 mint했는지**를 레코드로 갖고,
  foreign handoff 라운드와 로컬 라운드를 구분해 projection을 판정하고 싶다.
- As a maintainer, `originBrokerId`가 계약과 코드에서 같은 뜻이기를 원한다.
- As a security reviewer, 피어 broker가 보낸 projection이 **그 broker의 키로 서명된
  요청**임을 enforce하고 싶되, 한쪽만 켜서 상대 broker의 전달을 끊고 싶지는 않다.

## 설계

### 6. 필드 분리 (`originBrokerId` vs `handoffBrokerId`)

- `CrossBrokerTerminalBriefProjectionRequest`/`Projection`에 **`handoffBrokerId`**(자식
  Terminal Brief를 만든/relay하는 broker)를 추가한다. `originBrokerId`는 계약 의미
  (부모 라운드를 mint한 broker)로만 쓴다.
- routing 검증은 `handoffBrokerId`로 한다: `routing.handoffBrokerId !==
  normalized.handoffBrokerId` → `routing_mismatch`. `wrong_origin`의 "origin must differ
  from receiving broker" 검사는 `handoffBrokerId`로 옮긴다(origin은 받는 broker와 같을
  수 있다 — v0 `parentBrokerId == originBrokerId`).
- 호환: `handoffBrokerId`가 없는 구형 packet은 `originBrokerId`를 producer로 읽고
  receiver 카운터 `legacy_origin_as_handoff`를 올린다(거부하지 않음). sender
  (`cross-broker-terminal-brief-receiver.ts` relay)는 두 필드를 모두 채운다.
- record key는 `parentRoundId::handoffBrokerId::<child>`로 바꾸되, 복원
  (`restore`/`normalizeRecord`)에서 구형 레코드(`handoffBrokerId` 없음)는
  `originBrokerId`로 키를 유지한다(스냅샷 호환, #2337 교훈).

### 5. relay 실패 로컬 fallback 알림 (계약 routing gate 5)

> **정정 (2026-10-23, PR-5 구현 시 오너 결정).** 처음 안은 "기존 receiver
> 설정값(재시도 횟수·백오프·TTL)으로 영구 실패를 판정하고 새 knob는 만들지
> 않는다"였다. 그런데 receiver에는 재시도 횟수·TTL 설정이 없다. 있는 것은 poll
> 간격·최대 백오프뿐이고, 일시 실패는 cursor를 멈춘 채 무기한 재시도한다.
> 그대로 구현하면 동작이 없는 PR이 되므로 아래처럼 바꿨다. 제목도 처음 안의
> "unknown-total 자식 단건 제목"은 `terminal-brief-core-contract.md`의 no-local-send
> 규칙("Terminal Brief relay failure"로 명시, 부모 라운드 brief처럼 보이면 안 됨)과
> 충돌하므로 계약 쪽을 따른다.

- **영구 실패 기준**: 부모 broker가 이미 "영구 거부"로 분류한 ack 코드
  (`PERMANENT_DESTINATION_REJECT_CODES`) 중 `stale_replay`를 뺀 것 — `missing_parent`,
  `routing_mismatch`, `wrong_origin`, `bad_request`, `missing_dispatch_metadata`,
  `terminal_ack_forbidden`. 부모가 그 brief를 기록하지 않았다는 뜻이라 운영자는
  아무것도 받지 못한다. `stale_replay`는 부모가 이미 더 새 projection을 가진 경우라
  제외한다. 새 knob는 없다. 일시 실패(전송 오류·5xx·unauthorized)는 지금처럼 cursor를
  멈추고 재시도한다.
- **쓰기 경로**: receiver는 별도 프로세스이므로 자기(자식) broker의 새 라우트
  `POST /a2a/tasks/terminal-outbox/relay-fallback`을 부른다. 본문은
  `{ sourceEventId, lastErrorCode, lastErrorReason?, attempts? }`뿐이고, row는 broker가
  보유 중인 원본 이벤트로 만든다(relay가 내용을 주입할 수 없음). 인증은 terminal-outbox
  subscribe와 같다(hub/operator, peer `handoff:status` verify-if-present). 응답:
  201 `created`, 200 `replayed`, 404 `source_not_found`(보존 기간 경과), 409
  `not_relayed`(parent-broker-only 이벤트가 아님 — 이미 로컬로 알림된 brief).
- **row 모양**: 원본 이벤트에서 `notificationOwnership`·`crossBrokerHandoff`·
  `parentRoundId`·`run`·`parentRoundTotal/Order/Progress`를 모두 뺀다. 그래서 부모
  라운드 제목(`n/N`)이 생길 수 없고 relay가 이 row를 다시 집지도 않는다. `brokerOfRecordId`는
  자식 broker. 본문 `relayFallback: { scope: "local-fallback", reason:
  "permanent_destination_reject", attempts, lastErrorCode, lastErrorReason?,
  parentRoundId, parentBrokerId, sourceEventId }`. `scope`는 처음 안처럼
  `notificationOwnership.scope`에 두지 않고 `relayFallback` 안에 둔다(기존
  `parent-broker-only` 소비자 의미를 바꾸지 않기 위해).
- **제목**: `A2A Terminal Brief relay failure: <worker> (<lastErrorCode>)`, 80자 이내
  (worker 라벨을 자름). 코드는 `[a-z0-9_]{1,32}`만 허용하고 나머지는 `unknown`.
- **idempotent**: outbox id `terminal:` + `fallback:<sourceEventId>`. 같은 이벤트는 몇
  번을 다시 보내도 row 1개(cursor 되감기·재시도 포함, 첫 거부 코드 유지).
- **fallback 쓰기 실패**: 404/409에 라우트 자체 status가 실려 오면 영구로 보고
  `relayFallbackFailed`에 남긴 뒤 cursor를 넘긴다. 그 밖의 실패(5xx, 전송 오류, 라우트가
  없는 구형 broker의 404)는 `blocked`(`relay_fallback_http_<status>`)로 cursor를 멈춰
  재시도한다. 따라서 **broker를 receiver보다 먼저(또는 같이) 배포**해야 한다.
- relay 성공 시 fallback은 없다(기존대로 suppressed).
- **카운터**: receiver poll 요약에 `relayFallbackLocal`(새로 만든 row)·
  `relayFallbackReplayed`·`relayFallbackFailed`. `/health`의
  `crossBrokerTerminalBriefs.relayFallbackLocal`(프로세스 시작 후 누적; 같은 블록에
  PR-6의 `legacyOriginAsHandoff`·`explicitHandoffBroker`도 노출).
- **배포 영향**: PR-1(레지스트리) 반영 전에는 cross-broker 자식 brief가 부모에서 전부
  `missing_parent`로 끝나므로, 배포 직후부터 그 brief마다 자식 broker에 로컬 fallback
  알림이 하나씩 생긴다. 지금 조용히 사라지는 알림이 보이게 되는 것이 의도한 효과다.

### 1+2. 부모 라운드 레지스트리 (owner/origin 분리 + foreign 분류 + `originTaskId` 앵커)

**레지스트리.** 브로커에 `ParentRoundRegistry`를 둔다. 항목:

```
parentRoundId, originBrokerId, parentBrokerId, initiatingBrokerId, teamScope,
handoffBrokerId?, parentRoundTotal?, kind: "local-origin" | "foreign-handoff",
mintedAt, mintedBy: { requesterId, role }, anchors: Set<originTaskId>
```

**mint 경로(2개뿐).**

1. **local-origin**: 이 broker에서 라운드를 시작하는 dispatch. 명시 API
   `POST /a2a/parent-rounds`(operator/hub 역할, `ENFORCE_REQUESTER_IDENTITY` 적용,
   idempotent: 같은 `parentRoundId`+같은 메타 → 200 replayed, 다른 메타 → 409).
   `a2a-dispatch-helper.{mjs,ts}`는 `--cross-broker-handoff`일 때 이 API를 먼저
   호출하고 응답의 `parentRoundId`를 자식 payload에 싣는다. **`--parent-round-id`
   폴백은 제거**(1단계에서 이미 handoff parentRoundId 누락·자기참조·`originTaskId`
   부재를 차단함; 그 차단은 유지).
2. **foreign-handoff**: handoff envelope(`broker-handoff-protocol.md` §Parent Terminal
   Brief metadata — `parentRoundId`·`originBrokerId`·`parentBrokerId` 모두 필수)를
   받은 destination broker가 자식 태스크를 만들면서 등록. 이 항목은 **projection
   수신용이 아니라 relay 목적지 판정용**이다(자식 쪽은 projection을 받지 않는다).

**payload만으로는 만들 수 없다.** `POST /tasks`의 `parentRoundId`·`crossBrokerHandoff`
는 레지스트리를 **참조**할 뿐 생성하지 않는다. 레지스트리에 없는
`parentRoundId`를 가진 cross-broker 자식은 1단계 규칙대로 `[cross_broker_handoff_parent]`
blocker로 거부한다. 레지스트리에 있는 경우 `anchors`에 `originTaskId`를 추가한다.

**부모 판정.**

```
hasParentRound(id)      = registry.has(id) && registry.get(id).kind === "local-origin"
                          || tasks.has(id)                      // legacy, 제거 예정
parentBrokerOfRecord(id)= registry.get(id)?.parentBrokerId ?? tasks.get(id)?.brokerOfRecord
getParentRoundRouting   = registry 항목(teamScope, initiatingBrokerId)로
                          resolveTerminalBriefParentOriginRoute(); 없으면 payload 폴백
```

projection 수락 조건(기존 검사에 추가): 레지스트리 항목이 있고
`entry.parentBrokerId == 받는 broker`, `request.handoffBrokerId == entry.handoffBrokerId`,
그리고 `request.childTaskId` 또는 `request.originTaskId`가 **`entry.anchors`에 있을 때**
accepted. 앵커가 비어 있는 항목(자식을 아직 안 보냄)에 온 projection은
`missing_anchor`(새 reject code)로 거부 — 미래 `completedAt` 선점 공격(L2 반론)을
막는다. `routing_mismatch`는 이제 실제로 동작한다(항목 2).

**legacy `tasks.has` 유지 기간.** 레지스트리 도입 PR에서는 `tasks.has` 폴백을 남기고
receiver 카운터 `parent_resolved_via: registry | legacy_task`를 기록한다. 플릿에서
`legacy_task`가 0인 상태로 2주가 지나면(별도 오너 결정) 폴백을 제거한다.

**스냅샷.** 레지스트리는 hot-restart 안전해야 한다: `store.ts` 스냅샷 sidecar와
`readHotRuntimeSnapshot`·`saveSnapshot` hint 세 곳 모두 등록(#2337에서 receipt가 빠져
재시작 후 유실된 전례). 재시작 회귀 테스트 필수.

**폴백 설계(기록용).** 앵커 결합이 handoff-receiver 흐름과 맞지 않는 경우(예: 자식
태스크가 origin task 없이 생성되는 경로가 남아 있을 때)에는 "origin broker 전용
명시 mint 레코드"만으로 판정한다 — 즉 `anchors` 검사를 빼고 `kind === local-origin`
+ `handoffBrokerId` 일치만 본다. 이 결정은 spec 분석 단계(plan §Analyze)에서 내린다.

### 3b. `parentRoundOrder` 슬롯 중복

- 같은 `(parentRoundId, handoffBrokerId, parentRoundOrder)`에 **다른 child 식별자**의
  projection이 오면: 새 `completedAt`이 기존보다 **늦으면** 수락하고 기존 레코드를
  `superseded: { by: <newKey>, at }`로 표시해 보존(감사용, 집계에서는 제외), 같거나
  이르면 `stale_replay`(기존 코드).
- retry child(`<round>-t2r2`)가 같은 슬롯을 쓰는 회귀 테스트: r2가 늦게 끝나면 r2가
  집계·타이틀 numerator에 쓰이고, r1은 superseded.
- 같은 child 식별자의 재전송은 기존 `duplicate_replay`/`stale_replay` 규칙 그대로.

### 4. sender-proof 필수화

- 새 설정 `A2A_CROSS_BROKER_SENDER_PROOF_MODE = off | record | enforce`.
  - `off`(현재 기본): anchor 파일 없음과 동일, 검사 생략.
  - `record`: anchor 파일로 검증하되 실패는 **거부하지 않고** receiver 카운터
    `senderProof: { verified, missing, invalid, unpinnedBroker }`와 `/health`에 기록.
  - `enforce`: 현재 "anchor 있음" 동작(거부).
- 기존 "anchor 파일 설정 = enforce" 의미는 유지하되, 모드가 명시되면 모드가 우선.
  anchor 파일 없이 `enforce`면 startup에서 fail-closed(#1504 §4 "invalid shared-state
  grade" 선례와 같은 방식).
- 롤아웃: 양 broker `record`(별도 승인) → 카운터가 `missing=0, invalid=0`인 창
  7일(절대 종료일시는 롤아웃 이슈에 코멘트) → 양 broker **동시** `enforce`(별도 승인).
  한쪽만 enforce면 상대 broker의 전달이 끊기므로 금지(plan §Rollout).

## Scope

### In scope

- 위 6개 항목의 소스·테스트·fixture·계약 문구(`contracts/a2a/*.md`에 `handoffBrokerId`
  필수화와 `missing_anchor` reject code 추가).
- receiver/health 카운터와 `docs/operators.md` 운영 절차 한 절.

### Out of scope

- 과거 60건(#2331)의 cursor 되감기·replay — 별도 승인.
- 양 broker 배포·재시작, `record`/`enforce` 전환, trust anchor 키 생성·배포 — 항목마다
  별도 승인.
- 노드 → broker 직접 dispatch가 parent-round 신호를 넣는 경로의 폐지(1단계 규칙으로
  이미 로컬 소유로 떨어진다).
- 플러그인(`openclaw-plugin-a2a`) 쪽 relay 변경 — 필요하면 별도 이슈.

## Success criteria

- [ ] (6) 계약·코드·테스트에서 `originBrokerId`는 mint origin, `handoffBrokerId`는
      producer. 구형 packet은 `legacy_origin_as_handoff` 카운터와 함께 수락.
- [ ] (5) 부모 영구 거부(`stale_replay` 제외) → 자식 broker 로컬 fallback row 1개,
      부모 타이틀 없음, 계약 라벨 제목. 성공 경로 → fallback 0. 재시도·되감기에도 1개.
- [ ] (1+2) 정식 handoff 4-case fixture(계약 표)에서 case 2·4의 자식 projection이
      부모 broker에서 **accepted**. 자기참조 `<round>-t2` projection은 여전히
      `missing_parent`(1단계 회귀 (f) 유지). payload만 있는 태스크는 레지스트리를
      만들지 못한다. 앵커 없는 항목에 온 projection은 `missing_anchor`.
- [ ] (1) 레지스트리 hot-restart 회귀 테스트(RED→GREEN) 통과.
- [ ] (3b) retry child 슬롯 회귀 테스트: 늦은 r2 우선, r1 superseded 보존.
- [ ] (4) `record` 모드에서 invalid proof가 거부되지 않고 카운터만 오름, `enforce`에서
      거부, anchor 없는 `enforce`는 startup 거부.
- [ ] `npm run check` green, `test/conformance` 계약 fixture 갱신.

## Safety and approval boundaries

### Secrets and private data

trust anchor 공개키 PEM과 sender 개인키는 fixture에서 테스트 전용 키만 쓴다. 실제
키·브로커 호스트명·노드 식별자는 소스·테스트·문서에 넣지 않는다(public-readiness
scan `internal-node-identifier` fail).

### Human approval required for

- [x] Gateway/broker/worker/service restart (양 broker 배포, 항목마다)
- [x] DB mutation/prune/migration/replay (과거 60건 replay는 범위 밖·별도)
- [x] secret rotation/movement (trust anchor 키 생성·배포)
- [x] `record`/`enforce` 모드 전환
- [ ] production deploy, live canary/provider send, manual Terminal Brief ACK/replay,
      release/tag, force push — 이 사양이 요구하지 않음

### Broker foreground liveness

구현은 항목별 단독 PR(워커 레인 또는 세션)로, broker 세션은 리뷰·finalizer만.

## Verification design

- 오라클: 계약 fixture(`fixtures/contract/terminal-brief-parent-origin-routing.json` 확장)
  + 브로커 단위 테스트. 구현 레인과 다른 레인/계정이 fixture 리뷰.
- RED→GREEN: 각 PR 본문에 기본 트리에서 새 테스트가 실패하는 로그 첨부(계약/게이트
  레인 규칙).
- 항목 1 분석 단계: handoff-receiver의 자식 생성 경로가 `originTaskId`를 항상 싣는지
  확인(`manifest.sourceTaskId` 부재 케이스 집계). 부재가 있으면 폴백 설계 채택.

## Evidence contract

PR마다: 변경 파일/함수, 테스트 명령·결과, CI, 계약 변경 diff, 호환성 메모(구형
packet·스냅샷), 수행하지 않은 승인민감 행위, 후속 이슈.

## Rollback / failure handling

- 소스는 PR revert. 레지스트리 스냅샷 sidecar는 구형 broker가 무시하므로 롤백 안전.
- `handoffBrokerId` 없는 구형 relay가 남아 있어도 호환 경로로 수락되므로 한쪽 broker만
  롤백해도 전달은 끊기지 않는다(단, `enforce` 상태에서는 양쪽을 함께 되돌린다).
- 실패 지표: receiver 카운터에서 `missing_parent`가 줄지 않거나 `missing_anchor`가
  정식 handoff에서 발생, `/health` 레지스트리 복원 실패.

## Wiki/runbook follow-up

운영 위키 cross-broker 런북에 mint API·모드 전환 절차·카운터 읽는 법 추가(배포 시).
