# A2A Ecosystem Guide

> **한국어 / English terms** — 외부 사용자가 A2A 4개 저장소(또는 이 저장소 안의 통합 패키지)가 어떤 책임을 갖는지 빠르게 판단할 수 있도록 정리한 안내서입니다.

A2A는 "작업을 접수하고, 격리된 워커에 넘기고, 최종 증거(PR/Done/Block)를 회수하는" broker/worker task handoff plane입니다. 현재 `a2a-plane` 체크아웃은 공개 전 검증을 위한 통합 workspace이지만, 이슈와 문서에서는 아래 4개 구성 저장소 이름이 계속 사용됩니다.

## 한눈에 보기

```text
┌─────────────────────────────────────────────────────────────┐
│ a2a-plane                                                    │
│ Operator-facing project hub: roadmap, issues, docs, gates    │
│ https://github.com/jinwon-int/a2a-plane                     │
└──────────────────────────────┬──────────────────────────────┘
                               │ creates tasks / collects evidence
┌──────────────────────────────┼──────────────────────────────┐
│ a2a-broker                    │ a2a-docker-runner            │
│ Task lifecycle + worker API   │ Isolated GitHub patch worker │
│ https://github.com/jinwon-int/a2a-broker                    │
│                               │ https://github.com/jinwon-int/a2a-docker-runner
├───────────────────────────────┴──────────────────────────────┤
│ openclaw-plugin-a2a                                           │
│ OpenClaw Gateway adapter for broker request/status/cancel     │
│ https://github.com/jinwon-int/openclaw-plugin-a2a            │
└───────────────────────────────────────────────────────────────┘
```

## 저장소별 책임

| Repository | 사용자가 찾는 것 | 책임 | 책임이 아닌 것 | 이 체크아웃의 위치 |
| --- | --- | --- | --- | --- |
| `a2a-plane` | 전체 프로젝트 방향, 공개 준비 상태, 통합 문서 | 이슈 허브, 로드맵, release/readiness gates, contracts/examples/docs | 운영 중인 broker/worker 배포 | repository root, `docs/`, `contracts/`, `examples/` |
| `a2a-broker` | task API와 worker registry를 실행하는 핵심 서비스 | task 생성/조회/취소, worker 등록/상태, terminal evidence 수집, GitHub evidence projection | 작업을 직접 실행하거나 PR을 만드는 것 | `packages/broker/` |
| `a2a-docker-runner` | GitHub 작업을 컨테이너에서 안전하게 수행하는 워커 | repo checkout, Start/PR/Done/Block evidence, artifact 수집, bootstrap/private-context leak guard | broker API 소유, 장기 운영 상태 저장 | `packages/docker-runner/` |
| `openclaw-plugin-a2a` | OpenClaw에서 A2A broker를 호출하는 통합 | OpenClaw request/status/cancel ↔ A2A broker protocol mapping, wake/event bridge | broker 자체 구현, runner 실행 환경 | `packages/openclaw-plugin-a2a/` |

## 어떤 저장소부터 보면 되나?

- **A2A를 처음 이해하려는 외부 사용자**: 이 문서 → [`README.md`](../README.md) → [`docs/quickstart.md`](quickstart.md)
- **운영자/팀 리더**: `a2a-plane` 이슈와 readiness 문서에서 작업 지시와 공개 가능 여부를 확인합니다.
- **broker를 설치하거나 API를 붙이는 개발자**: `packages/broker/README.md`와 `contracts/a2a/`를 확인합니다.
- **격리 패치 워커를 운영하는 사람**: `packages/docker-runner/README.md`를 확인하고, PR/Done/Block evidence 규칙을 따릅니다.
- **OpenClaw가 아닌 HTTP worker를 붙이는 개발자**: [docs/specs/hermes-worker-integration/spec.md](specs/hermes-worker-integration/spec.md)에서 broker-agnostic worker 등록, heartbeat, polling, evidence alias를 확인하고, [Hermes reference worker dry-run](../examples/workers/hermes-reference-worker/README.md)로 loopback smoke를 확인합니다.
- **OpenClaw Gateway 사용자**: `packages/openclaw-plugin-a2a/README.md`에서 broker 연결 설정과 안전 경계를 확인합니다.

## 기본 작업 흐름

1. `a2a-plane` 이슈가 작업 요청과 성공 조건을 정의합니다.
2. `a2a-broker`가 task를 만들고 가능한 worker에게 배정합니다.
3. `a2a-docker-runner` 같은 worker, 또는 Hermes-style HTTP worker가 격리/외부 런타임에서 작업을 수행합니다.
4. worker는 `Start` marker 후 `PR`, `Done`, 또는 `Block` evidence를 남깁니다.
5. broker와 plane 문서/이슈가 결과 URL과 artifact evidence를 모아 closeout합니다.
6. OpenClaw를 쓰는 환경에서는 `openclaw-plugin-a2a`가 Gateway와 broker 사이의 adapter 역할을 합니다.

## 모노레포 후보와 4개 저장소 이름의 관계

이 repository는 공개 전 검증을 쉽게 하기 위해 broker, runner, OpenClaw plugin, contracts, examples를 한 체크아웃에 모은 **A2A Nexus consolidation workspace**입니다. 따라서 외부 사용자는 다음처럼 읽으면 됩니다.

- GitHub/이슈/로드맵에서 말하는 4개 이름은 **역할 경계**입니다.
- 이 체크아웃 안에서는 그 역할이 `packages/*`, `contracts/`, `docs/` 경로로 매핑됩니다.
- 기존 독립 source repositories는 rollback/source-of-truth 참고용으로 남을 수 있지만, 새 공개 검증은 `main` 기준의 이 통합 workspace 문서를 우선합니다.

## 안전 경계

이 가이드는 문서 탐색용입니다. 아래 작업은 별도 운영 승인 없이는 하지 않습니다.

- repository visibility 변경
- production broker/worker/Gateway 재시작 또는 배포
- production database, queue, terminal-outbox mutation
- 실제 provider, Telegram, notification 송신
- secret disclosure, secret rotation, raw credential evidence 기록

## 로드맵 참고

> [!NOTE]
> 현재 4개 저장소 체제와 통합 workspace의 사용자 경험을 계속 정리 중입니다.
> The current topology decision ([#473](https://github.com/jinwon-int/a2a-plane/issues/473)) recommends **holding full monorepo consolidation** and keeping split implementation repos with `a2a-plane` as the stronger public umbrella. See the [topology decision record](topology-decision-record.md) for the full recommendation, reasoning, and re-entry criteria.
>
> The [monorepo architecture & cutover proof](monorepo-migration-checklist.md) is preserved as a historical reference — it will be revived if a future operator-initiated re-entry activates full consolidation.
>
> 추적 이슈: [a2a-plane#473](https://github.com/jinwon-int/a2a-plane/issues/473) · [#240](https://github.com/jinwon-int/a2a-plane/issues/240) · [#337](https://github.com/jinwon-int/a2a-plane/issues/337)

## 라이선스

각 저장소 또는 패키지의 `LICENSE` 파일을 참조하세요.
