# Trusted Conversation Plane — 운영 runbook (#1814 C6 / #1866)

Track: #1866 (C6) · Parent: #1814 · Spec: `docs/specs/trusted-conversation-plane/spec.md` (frozen #1861).

이 runbook은 conversation plane의 배포·재시작·resync 절차와 운영 경계를 다룬다. 모든 절차는 loopback/데모 환경과 승인된 운영 환경에서만 사용하며, production 배포·서비스 재시작·live canary·peer credential provisioning은 별도 운영자 승인이 필요하다.

## 지원 범위 (현재)

| 경로 | 상태 | 비고 |
|---|---|---|
| 동일 broker Broker↔Worker / Worker↔Worker | 지원 (#1862) | inbox poll→consume 루프, worker 서명(선택) |
| task↔conversation bridge | 지원 (#1863) | task result→bounded reply, input-required resume |
| Broker↔Broker relay (pull/push) | 지원 (#1864) | outbox cursor, peer 스코프, sender proof(앵커 설정 시) |
| cross-broker Worker↔Worker | 지원 (#1865) | 미러 reply/consume, ack lineage 수렴, resync |
| 2-broker compose 데모 | 지원 (본 runbook) | `docker-compose.two-broker.yml` |

비지원 (명시적으로 광고 금지): 범용 채팅 UI, 무제한 자율 토론, worker 직접 소켓, 전체 DB 복제, provider-send=ACK 의미론.

## 1. 배포 (loopback 데모)

```bash
# 저장소 루트에서 — 이미지 빌드 (빌드 인자는 검증된 git 사실에서)
npm run build:image -w packages/broker
# 또는 수동: export A2A_BROKER_REVISION=$(git rev-parse HEAD) A2A_BROKER_CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)

docker compose -f packages/broker/examples/docker-compose.two-broker.yml up -d
docker compose -f packages/broker/examples/docker-compose.two-broker.yml ps
# 두 서비스 모두 healthy 여야 함

curl -s http://127.0.0.1:8787/livez   # broker-alpha
curl -s http://127.0.0.1:8788/livez   # broker-beta
```

- 두 broker는 각자 별도 state volume(`broker-alpha-state`, `broker-beta-state`)을 가진다 — 상태는 절대 공유되지 않는다.
- 대화 시퀀스 권위는 대화별 `homeBrokerId`가 가진다. 상대 broker는 미러만 유지한다.

## 2. conversation 라이프사이클 (동일 broker)

```bash
# 개시 (conversationId는 브로커가 발행)
curl -s -X POST http://127.0.0.1:8787/conversations -H 'Content-Type: application/json' -d '{
  "envelope": {
    "messageId": "msg-1", "kind": "question",
    "sender": {"kind": "worker", "id": "worker-a", "homeBrokerId": "broker-alpha"},
    "recipients": [{"kind": "worker", "id": "worker-b", "homeBrokerId": "broker-alpha"}],
    "idempotencyKey": "idem-1",
    "content": {"text": "..."}
  }}'

# inbox poll — poll은 delivered까지만 (processed 아님)
curl -s "http://127.0.0.1:8787/conversations/<id>/inbox?actor=worker:worker-b:broker-alpha"

# 소비 — 증거 필수 (reply|task-result|ack)
curl -s -X POST http://127.0.0.1:8787/conversations/<id>/messages/msg-1/processed \
  -H 'Content-Type: application/json' -d '{
    "actor": {"kind":"worker","id":"worker-b","homeBrokerId":"broker-alpha"},
    "evidence": {"kind": "reply", "ref": "msg-2"}}'

# 배달 매트릭스 (offline/stale/busy 큐잉·expiry·retry 명확화)
curl -s "http://127.0.0.1:8787/conversations/<id>/delivery?actor=worker:worker-a:broker-alpha"
```

## 3. cross-broker relay 운영

- peer 스코프: `conversation:send|read|relay` (handoff:* 와 별개). 레지스트리 파일은 root-only(0600).
- outbox는 cursor 주소 로그 — 수신 broker가 자기 cursor로 pull:

```bash
curl -s "http://127.0.0.1:8787/peer/conversations/outbox?cursor=0&limit=50" \
  -H 'x-a2a-peer-broker-id: broker-beta' -H 'x-a2a-peer-secret: <secret>'
```

- push apply는 증명(앵커 설정 시)과 스코프를 먼저 검증한다. 중복 재전송은 idempotency key로 붕괴(`duplicate`).
- **시퀀스 갭 발생 시**: apply가 `409 blocked` + `expectedSequence`를 반환하면 skip하지 말고 갭 이전 커서부터 다시 pull해 순서대로 적용한다. 갭이 유실(원본 소실)이면 lineage를 다시 열어야 한다 — 부분 이력으로 미러를 seed하지 않는다(설계상 금지).

## 4. broker 재시작

- state는 state volume(JSON snapshot)에 지속된다. 재시작 후 대화·시퀀스·idempotency 테이블은 그대로 재수화된다:
  - 홈브로커 재시작 후 다음 메시지는 이전 `lastAssignedSequence+1` (갭 없음).
  - 미러/아웃박스도 스냅샷에서 재수화되며 outbox cursor는 연속된다.
- 검증: `GET /conversations/<id>?actor=...` 의 `lastAssignedSequence`가 재시작 전과 동일한지 확인.

## 5. resync (cursor 유실·장애 후)

- pull 커서를 잃으면 **cursor 0부터 다시 pull**하면 된다 — 이미 적용된 항목은 `duplicate`로 붕괴하고 유실 없이 재적용된다(at-least-once + idempotent collapse).
- 브로커 재수화(스냅샷 복구) 후에도 동일하다: outbox가 그대로 서빙되고 재적용은 붕괴한다.

## 6. 관측성

- 감사: `conversation.opened` / `conversation.message.accepted` / `conversation.message.processed` — note는 `seq=N digest=sha256:…` (본문 미기록).
- 배달 상태: `GET /conversations/<id>/delivery` (참여자만) — 수신자별 queued/delivered/processed/expired, liveness(≤30s online / ≤90s stale / >90s offline / unknown), busy(claimed·running 보유, 큐잉 비차단).
- receipt: processed 전이마다 broker countersign(`a2a.conversation-receipt.v1`, receiptDigest 포함).

## 7. 승인 경계 (핵심 요약)

- peer credential 생성·회전, 서비스 재시작, live canary, DB mutation/prune — 별도 운영자 승인.
- `A2A_CONVERSATION_WORKER_SIGNATURE_ENFORCE=1`(worker 서명 강제) 전환은 롤아웃 결정: 키 등록(`worker.metadata.conversationSigningPublicKey`)이 먼저다.
