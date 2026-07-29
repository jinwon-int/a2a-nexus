# Fast Lane Spec — lightweight dispatch for low-risk single-shot tasks (#1601 P3)

> **Status**: the create-time v1 shadow classifier and durable recording
> contract are implemented source-only. Shadow mode changes no task behavior.
> Canary, flag enablement, lightweight execution, and rollout remain
> incomplete and require separate approval. Refs #1601.

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

1. intent = `analyze`.
2. `payload.mode`가 닫힌 v1 집합 `analysis-only`,
   `read-only-analysis`, `analyze-only` 중 하나이고, structured
   patch/write/implementation/source-mutation 표시와 충돌하지 않는다.
3. 대상과 assigned worker가 같은 단일 워커이고, round/fanout/multi-worker/
   parent-round/delegated team·workflow 표시가 없다.
4. 등록된 워커가 `workerMode: "persistent"`를 명시한다. 기존 호환 기본값으로
   workerMode가 생략된 워커는 정상 실행되지만 shadow 판정은 `full`이다.
5. create-time G1 판정이 명시적으로 `allow`이다. 정책 문서가 없어 판정이
   없는 기존 호환 경로도 정상 실행되지만 shadow 판정은 `full`이다.
6. 승인 필요, 민감, live, 외부 전송, credential 접근 structured 표시가 없다.

**full ceremony 유지 (하나라도 해당 시)**: propose_patch / implementation /
라운드·팬아웃 / 모바일·간헐 워커(가용성 리스크, P0 F3) / 정책이 승인을
요구하는 클래스 / 민감 표시.

`defaultAction`은 보수적으로 **full** — 판정 불가/누락 시 fast가 아니라 full.
free-form `message`나 다른 prose는 판정 입력으로 읽거나 추론하지 않는다.

## v1 shadow 기록 계약

브로커는 새 태스크의 top-level `TaskRecord.laneAssignment`에 다음 닫힌
형식을 기록한다. `CreateTaskRequest`에는 이 authoritative 필드가 없다.
`evaluatedAt`은 결정성 있는 fixture와 replay 비교를 위해 v1에 넣지 않는다.

```json
{
  "version": "fast-lane.v1",
  "mode": "shadow",
  "decision": "fast",
  "reasonCodes": ["all_fast_conditions_met"]
}
```

- `decision`은 `fast | full`이다.
- `reasonCodes`는 비어 있지 않다. fast에는
  `all_fast_conditions_met` 하나만 들어간다.
- full은 아래 닫힌 코드 집합에서 해당 코드를 고정된 평가 순서로 모두
  기록한다. raw mode, worker id, policy rule/reason, message, payload 값은
  기록하지 않는다.
- requester가 top-level 또는 payload에 lane/shadow 필드를 넣어도 브로커
  field를 작성할 수 없다. top-level 값은 broker 결과로 덮어쓰고, payload
  값은 authoritative 입력으로 사용하지 않으며 판정은 full이다.

| reason code | v1 의미 |
|---|---|
| `all_fast_conditions_met` | 모든 fast 조건 충족 |
| `requester_lane_facts_present` | requester lane/shadow key 존재 |
| `intent_not_analyze` | intent가 정확히 analyze가 아님 |
| `mode_missing` | payload.mode 누락, 비문자열, 빈 문자열 |
| `mode_not_read_only_analysis` | mode가 닫힌 read-only 집합 밖 |
| `write_or_implementation_marker_present` | write/patch/implementation/source-mutation 표시 또는 반대되는 read-only 표시 |
| `worker_assignment_conflict` | target/assigned worker 불일치 또는 판정 불가 |
| `round_marker_present` | top-level/payload round·parent-round 표시 |
| `fanout_marker_present` | fanout 표시 |
| `multi_worker_marker_present` | workers/participants/lanes 등 다중 워커 표시 |
| `delegated_workflow_marker_present` | parent task, team, workflow, delegation, subagent, cross-broker/finalizer 표시 |
| `worker_mode_missing` | 등록 workerMode가 없음 |
| `worker_not_persistent` | 등록 workerMode가 persistent가 아님 |
| `policy_decision_missing` | create-time G1 판정이 없음 |
| `policy_decision_unknown` | 닫힌 G1 action 밖의 알 수 없는 판정 |
| `policy_requires_approval` | G1 action이 require_approval |
| `policy_denied` | G1 action이 deny (warn mode에서만 task row 생성) |
| `approval_marker_present` | request policyContext가 승인 필요를 표시 |
| `sensitive_marker_present` | structured sensitive 표시 |
| `live_marker_present` | structured live 표시 또는 알 수 없는 environment |
| `external_send_marker_present` | structured external/provider-send 표시 |
| `credential_access_marker_present` | structured credential/secret-access 표시 |

v1은 exact structured key만 본다. orchestration key는 값이 `false`여도 key
존재 자체가 ceremony 증거이므로 full이다. 위험 key는 literal `false`만
비위험으로 해석하고 null/object/string 등 알 수 없는 값은 full이다.
`sourceOnly`, `source_only`, `readOnlyValidation`, `noGitHubWrites`,
`noMutation`, `noLive` 같은 반대 방향 safety key는 literal `true`만
비위험으로 해석한다. environment는 `research | staging`만 비-live로
해석한다. exact key 목록은 broker-owned pure classifier가 계약의 실행
원본이며 테스트가 각 그룹을 고정한다.

## audit와 정책 순서

성공한 신규 create는 `task.created` 직후 정확히 한 번
`task.lane_assigned`를 append한다. note는 위 laneAssignment JSON만 담는
bounded secret-safe 값이다. 그 뒤 warn-mode deny라면 기존
`task.policy_warned`가 기록된다.

- idempotent create replay는 기존 record를 그대로 반환하고 lane audit을
  다시 쓰지 않는다.
- enforce-mode G1 deny는 기존대로 create 전에 거부된다. task record와
  lane audit은 없고 기존 `task.policy_denied`만 남는다.
- require_approval은 기존대로 blocked task를 만들며 lane decision은 full이다.
- 정책 문서 없음, legacy workerMode 없음, legacy task의 laneAssignment 없음은
  모두 호환된다. 기존 record에 retroactive 판정/audit을 만들지 않는다.

## fast lane에서 가벼워지는 것 / 절대 가벼워지지 않는 것

| 가벼워짐 (후보) | 절대 유지 |
|---|---|
| 라운드/다중 워커 팬아웃 오버헤드 (애초 단발이므로 무) | G1 정책 enforce (create/claim deny) |
| 독립 리뷰 라운드 (분석 산출물에는 미실시, evidence-only 메모로 대체) | 수용 기준(acceptance) — completion 정직성 |
| 증거 패킷의 중량 조립 — 간이 evidence(해시+요약+결정적 digest) | redaction / provenance 서명 / provenance 검증 |
| finalizer 라운드 (fast는 verdict 웨이브 생략 후보) | finalizer verdict **무결성 검증 자체**(서명 검증은 유지, 라운드 생략 여부는 별도 결정) |
| readiness lint의 경고성 단계 | readiness fail-closed 항목 |

명시적 미결정: ① finalizer 라운드 생략 범위 — verdict 서명 검증은
유지하되 독립 리뷰 라운드를 생략할지, ② 간이 evidence의 최소 필드.
lane 기록 필드는 이 slice에서 broker-owned top-level
`TaskRecord.laneAssignment`로 결정되었고 requester-owned `payload.lane`은
계약에서 제외되었다.

## 안전 경계

- lane 판정은 audit `task.lane_assigned`에 남아 우회 불가.
- fast lane 태스크도 acceptance 실패 시 실패로 기록 — **간이 완료 없음**.
- 오분류(실제로는 고위험)는 되돌릴 수 있어야 함: 운영자가 태스크를 full로
  재판정 가능.
- 모바일/간헐 노드는 fast lane 대상에서 제외 (claim 게이트는 G1 정책 연계).

현재 shadow 결과는 status, assignment, claim, acceptance, evidence,
provenance, finalizer, policy enforcement, scheduling, execution 중 어느 것도
변경하지 않는다. 운영자 재판정 UI/API와 lightweight 동작은 아직 구현되지
않았다.

## 롤아웃 (각 단계 승인)

1. 스펙 확정(완료) → 2. lane 판정+기록만 구현(완료, 동작 변경 없음,
섀도) → 3. 칼나리로 판정 정확도 검증(미실시) → 4. 경량화 1개씩 opt-in
플래그로 도입(미구현, 기본 동작 변경 없음) → 5. 벤치 재측정 + 실패율
비악화 확인 → 6. 단계적 기본화.

## 성공 지표

- fast lane 대상 태스크의 p50 e2e가 full 대비 유의미하게 감소 (baseline: analyze p50 T1 1.6m / T2 46.9s)
- 실패율 비악화 (실행 실패와 게이트 실패 분리 집계 — P0-2(b) 분류 준용)
- 벤치 파일럿 재측정에서 A2A 협업이 solo와 대등 이상

## 코어 다이어트 연계

P3의 다른 축(코어 슬림화)과의 관계: fast lane이 본격화되면 full-only 경로가
줄어 정리 대상이 명확해진다. 스크립트 375개 축소(#1503)는 별도 트랙으로,
**사용 증거(CI/워크플로/package.json/브로커 참조) 기반 reverse-ratchet**로
진행 — 측정 없는 삭제 금지.
