# Result-Provenance Countersigning — Deploy Runbook (#1389)

브로커가 worker result provenance 를 countersign 하는 배포에서, **enforcement 코드가
signer key/env 보다 먼저 컨테이너에 도달**해 worker 제출이 실패하는 배포-순서 갭
(#1382 rollout 중 한 브로커 노드에서 관측된 사례) 을 예방하기 위한 운영 문서.

## 1. Posture flag

`A2A_RESULT_PROVENANCE_COUNTERSIGN` 로 countersigning 자세를 명시한다. signer key 는
agent-card 서명과 동일한 `AGENT_CARD_SIGNING_KEY_FILE` (+ `AGENT_CARD_SIGNING_KID`) 를
쓴다.

| Value | Startup | Worker `result.provenance` 처리 |
|---|---|---|
| `enforce` | **key 없으면 startup 실패 (loud)** | worker 서명 검증 후 반드시 countersign |
| `auto` (default) | key 유무와 무관하게 기동 | key 있으면 countersign, 없으면 **un-countersigned 로 통과** (worker 제출을 절대 실패시키지 않음) |
| `off` | 기동 | provenance 를 **손대지 않고 통과** (verify/countersign 모두 skip — kill switch) |

비어 있지 않은 인식 불가 값(예: `sometimes`) 은 조용한 fallback 이 아니라 **loud config
error** 로 기동을 막는다.

### 왜 이렇게 나누는가

- `auto` 기본값은 **code-vs-env skew 가 worker 제출을 반쯤-깨는 상태를 원천 차단**한다.
  새 빌드가 signer env 없이 배포돼도 provenance 제출은 un-countersigned 로 통과하고,
  나중에 key 가 도착하면 자동으로 countersign 이 재개된다. (agent-card 가 key 없으면
  unsigned 로 serving 되는 것과 동일한 스탠스.)
- `enforce` 는 "모든 provenance 결과가 반드시 countersign 돼야 한다" 를 보장하고 싶을 때
  쓴다. 이때 갭은 **per-task 실패가 아니라 startup 실패**로 앞당겨져, 배포 시점에 즉시
  드러난다.
- `off` 는 provenance 처리 자체가 문제를 일으킬 때의 즉시 복구 레버다.

## 2. Redeploy verification checklist (proposal #2)

`enforce` 로 운영하려면, cutover 전에 **컨테이너 내부**에서 signer env + key 를 확인한다.
컨테이너 env 는 create 시점에 고정되므로 plain restart 로는 갱신되지 않는다 — env/key
변경 시에는 반드시 **force-recreate** 한다.

1. 새 컨테이너에 signer env 가 있는지: `AGENT_CARD_SIGNING_KEY_FILE`, (선택)
   `AGENT_CARD_SIGNING_KID`, 그리고 의도한 `A2A_RESULT_PROVENANCE_COUNTERSIGN` 값.
2. key 파일이 컨테이너 안에서 **runtime user 로 읽기 가능**한지 (mode/owner).
3. `enforce` 인데 key 가 없으면 컨테이너가 startup 에서 loud 하게 죽는다 — 이 실패는
   의도된 preflight 다. env/key 를 채우고 다시 recreate 한다.
4. cutover 후, provenance 를 담은 worker 완료 1건이 broker countersignature 를 달고
   성공하는지 확인한다.

> `enforce` 를 쓰지 않는다면 이 체크리스트는 필수가 아니다 — `auto` 는 key 가 아직
> 없어도 worker 제출을 실패시키지 않는다.

## 3. Deferred: graceful drain on redeploy (proposal #3)

컨테이너 recreation 마다 worker poll/heartbeat 소켓이 끊겨(`other side closed` /
`ECONNRESET`) 재시도 backoff → 픽업 지연이 fleet-wide 로 관측된다. 짧은 drain/notice
로 in-flight 제출이 닫히는 소켓에 도달하지 않게 하는 것은 별도 인프라 작업으로 남긴다
(이 런북 범위 밖).

## 4. Tests

`src/server-worker-signature-route-gate.test.ts` 가 세 자세를 모두 고정한다: `enforce`
startup guard(키 없음→throw, 키 있음→기동), 인식 불가 값→config error, `auto` pass-through
(no countersig, worker 서명 보존), `off` kill switch.
