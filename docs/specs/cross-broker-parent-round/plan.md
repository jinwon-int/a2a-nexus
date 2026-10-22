# Implementation Plan: cross-broker 부모 라운드 2단계 (#2339)

> Language: Korean (design spec). 코드 식별자·경로는 원문(영문) 그대로 둔다.

## Linked spec

- Spec: `docs/specs/cross-broker-parent-round/spec.md`
- Issue: #2339 (오너 설계 결정 2026-10-22). 1단계: #2331(closed, `4417b6d7`).

## Size classification

- [ ] Small
- [x] Medium
- [ ] Large

Reason: 단일 레포(a2a-nexus 모노레포: broker 소스·계약·fixture) 소스 전용이지만
broker core(판정·outbox·receiver·http·store 스냅샷)와 dispatch helper를 걸치고
양 broker 동시 배포 제약이 있다. 승인민감 행위는 전부 배포 단계로 분리된다.

## Affected repos/components

- `a2a-plane`(이 레포 `contracts/`, `fixtures/contract/`, `test/conformance`):
  `handoffBrokerId` 필수화, `missing_anchor` code, 4-case fixture 확장.
- `a2a-broker`(`packages/broker`): `core/cross-broker-terminal-brief.ts`,
  `core/terminal-event-outbox.ts`, `core/cross-broker-terminal-brief-receiver.ts`,
  `core/broker.ts`(판정 배선), 신규 `core/parent-round-registry.ts`,
  `http/a2a-terminal-outbox-routes.ts`(sender-proof 모드), 신규
  `http/parent-round-routes.ts`, `core/a2a-dispatch-helper.ts` +
  `scripts/a2a-dispatch-helper.mjs`, `store.ts`(스냅샷 sidecar), `server.ts`(env).
- `a2a-docker-runner`: 변경 없음.
- harness bridges: 변경 없음.
- worker/node config: 변경 없음(소스 PR). 배포 시 `A2A_CROSS_BROKER_SENDER_PROOF_MODE`.
- Wiki/runbooks: 배포 단계에서 cross-broker 런북 갱신.

## Broker / worker / finalizer roles

- Broker of record / finalizer: T1 broker 세션 또는 오너 지정.
- Workers: 항목별 1 PR = 1 레인(세션 또는 A2A patch lane).
- Libero/validator: 다른 계정의 exact-head 리뷰(gh-pr-flow).
- Human approval owner: 오너 — 배포·모드 전환·키 배포.

## Execution lane

- [ ] Direct small change
- [x] Isolated subagent
- [ ] Broker-owned TaskFlow
- [ ] TaskFlow + A2A evidence workers
- [ ] Other:

Why this lane is safe: 소스·테스트만, 라이브 변경 없음. 각 PR이 독립 revert 가능.

## Data/control flow

```
operator/hub ─POST /a2a/parent-rounds─▶ parent broker registry (local-origin, anchors={})
      │
      └─dispatch helper --cross-broker-handoff─▶ handoff envelope(parentRoundId, originBrokerId,
                                                 parentBrokerId) ─▶ child broker
                                                   ├─ registry(foreign-handoff)  [relay 목적지]
                                                   └─ child task(originTaskId) ──┐
parent broker registry.anchors += originTaskId  ◀── (handoff create 응답) ◀───────┘
child terminal ─▶ child outbox(parent-broker-only, handoffBrokerId=child broker)
      ─relay(+senderProof)─▶ parent POST projection
            ├─ 검사: addressed==me, registry.parentBrokerId==me, handoffBrokerId==entry.handoffBrokerId,
            │        anchor ∈ entry.anchors, slot/stale, sender-proof(mode)
            └─ accepted → parent aggregate title n/N (기존 경로)
relay 영구 실패 ─▶ child local fallback row(relayFallback, 부모 타이틀 없음)
```

## Tests and validation

- Oracle independence: 계약 fixture는 구현 레인과 다른 레인이 리뷰. finalizer는
  reject code 분포(기존 phase-1 카운터)로 효과를 본다.
- Red-to-green: 각 PR에 기본 트리 FAIL 로그.
- Discovery inventory(항목 1 analyze): handoff-receiver 자식 생성 경로의
  `originTaskId` 유무, `tasks.has` 폴백 의존 fixture 목록.
- Follow-up issues: legacy `tasks.has` 제거(2주 관측 후), `enforce` 전환 롤아웃,
  과거 60건 replay(별도 승인) — 각각 이슈로 분리.
- Lane-to-PR: 아래 PR 1개 = 레인 1개.
- Unit: `packages/broker` focused(`cross-broker-terminal-brief*.test`, outbox,
  receiver, dispatch helper, store snapshot).
- Contract/conformance: `npm run test:conformance`, fixture 갱신.
- Build/lint/typecheck: `npm run check`.
- Dry-run/doctor: `/health` 진단에 registry·senderProof 카운터 노출 확인.
- Live canary: 별도 승인(양방향 case 2·4 각 1건).

## Rollout plan

Source PR order (각각 단독 PR, 머지 큐):

1. **PR-6** 필드 분리 `handoffBrokerId` + 구형 호환 카운터 + 계약 문구.
2. **PR-5** relay 영구 실패 로컬 fallback row + 카운터.
3. **PR-1a** `ParentRoundRegistry` + 스냅샷 sidecar + hot-restart 테스트(판정 배선
   없음, 동작 불변).
4. **PR-1b** mint API + dispatch helper 배선(`--parent-round-id` 폴백 제거) +
   handoff-receiver foreign 등록 + anchors.
5. **PR-1c** 판정 배선: `hasParentRound`/`parentBrokerOfRecord`/`getParentRoundRouting`
   → registry 우선, `missing_anchor`, `parent_resolved_via` 카운터, 항목 2 필드.
6. **PR-3b** 슬롯 중복 superseded.
7. **PR-4** `A2A_CROSS_BROKER_SENDER_PROOF_MODE` + record 카운터 + startup fail-closed.

Deployment gate (각각 별도 승인): PR-6·PR-5 후 양 broker 1차 배포 → PR-1a~1c·3b 후
2차 배포(양 broker 같은 revision, T2→T1 순서는 #2350 선례) → PR-4 후 `record` →
7일 창 → 동시 `enforce`.

Communication: 각 배포 후 receiver 카운터(`missing_parent`·`missing_anchor`·
`routing_mismatch`·`relayFallbackLocal`·`senderProof.*`)를 #2339에 코멘트.

## Rollback plan

- Revert path: PR 단위 revert, 역순.
- Config rollback: `A2A_CROSS_BROKER_SENDER_PROOF_MODE` → `record`/`off`(양쪽 동시).
- State cleanup: 레지스트리 sidecar는 구형 broker가 무시. fallback row는 outbox
  일반 row라 정리 불필요.
- Approval required before cleanup: outbox/cursor 조작은 전부 별도 승인.

## Closeout evidence

- Finalizer decision: 항목별 PR 머지 + 2차 배포 후 정식 handoff 카나리 case 2·4
  accepted 1건씩(별도 승인) — 이때 #2339 close.
- Evidence links: PR·머지 커밋·CI·배포 LOG·카운터 스냅샷.
- Approval-sensitive actions not performed: 각 PR 본문에 명시.
- Wiki/runbook update: 배포 단계.
