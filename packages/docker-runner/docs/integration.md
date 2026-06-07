# Handler Integration

`openclaw-a2a-worker` handler (`openclaw-a2a-task-handler.mjs`) calls `a2a-docker-runner` for `github-propose-patch` / `propose_patch` tasks instead of mutating the host workspace directly.

## Hermes/Android native worker boundary

When the Docker runner receives a task with a non-Docker `workerProfile`
(e.g. `"termux-hermes"`, `"external-harness"`, or `"hermes"`), it rejects the
task early during validation with a Block outcome.  This ensures that
Hermes/Android native A2A worker tasks are never accidentally executed
inside the Docker runner.

The handler should check `workerProfile` before routing to the Docker runner
so that native Hermes tasks are dispatched to the correct runtime.

Parent: a2a-docker-runner#340
Parent: a2a-plane#464

## Architecture

```text
Broker ──claim──▶ Worker ──dispatch──▶ Handler
                                         │
                          github-propose-patch detection
                                         │
                              ┌──────────┴──────────┐
                              │  A2A_DOCKER_RUNNER   │
                              │     _ENABLED?        │
                              └──────┬──────┬────────┘
                                     │ yes  │ no
                                     ▼      ▼
                          a2a-docker-runner   Legacy openclaw agent path
                               run               (direct workspace)
                                │
                          Container sandbox
                          ┌───────────────┐
                          │ git clone      │
                          │ commands       │
                          │ artifacts/     │
                          └───────────────┘
                                │
                          RunnerResult JSON
                                │
                          HandlerResult
                                │
                          Broker report
```

## Import

The integration module exports helper functions that the handler can import:

```js
import {
  isGithubProposePatchTask,
  isEnvTruthy,
  shouldUseDockerRunnerForGithub,
  buildRunnerTaskFromHandlerPayload,
  parseRunnerOutput,
  extractGitHubEvidence,
  buildHandlerResult,
} from "a2a-docker-runner";
```

TypeScript:
```ts
import {
  isGithubProposePatchTask,
  shouldUseDockerRunnerForGithub,
  buildRunnerTaskFromHandlerPayload,
  parseRunnerOutput,
  extractGitHubEvidence,
  buildHandlerResult,
  type HandlerTask,
  type HandlerEnv,
  type HandlerResult,
} from "@openclaw/a2a-docker-runner";
```

## Handler Integration Flow

### Step 1: Detect

```js
if (isGithubProposePatchTask(task) && shouldUseDockerRunnerForGithub(task, env)) {
  return handleViaDockerRunner(task, env);
}
```

### Step 2: Build runner task

```js
const runnerTask = buildRunnerTaskFromHandlerPayload(task, env);

// runnerTask = {
//   id: "...",
//   intent: "propose_patch",
//   mode: "github-propose-patch",
//   repo: "jinwon-int/openclaw-plugin-a2a",
//   preset: "openclaw-plugin-a2a-dev",
//   issueUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/issues/42",
//   ...
// }
```

### Step 3: Execute

```js
// Write task.json
await fs.writeFile(taskPath, JSON.stringify(runnerTask));

// Spawn runner
const { stdout, stderr, code } = await spawn(
  env.A2A_DOCKER_RUNNER_BIN || "a2a-docker-runner",
  ["run", taskPath],
);

if (code !== 0) throw new Error(stderr);
```

### Step 4: Parse & build result

```js
const parsed = parseRunnerOutput(stdout);
const handlerResult = buildHandlerResult(parsed, task, nodeId);

// handlerResult = {
//   status: "pr_opened",
//   summary: "...",
//   prUrl: "https://github.com/.../pull/42",
//   ...
// }
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `A2A_DOCKER_RUNNER_ENABLED` | `0` | Master switch. Set `1`/`true`/`yes`/`on` |
| `A2A_DOCKER_RUNNER_ALL_GITHUB` | `0` | Route all github-propose-patch tasks through runner |
| `A2A_DOCKER_RUNNER_PRESET` | — | Default preset (e.g. `openclaw-plugin-a2a-dev`) |
| `A2A_DOCKER_RUNNER_BIN` | `a2a-docker-runner` | Runner binary path |
| `A2A_DOCKER_RUNNER_ARGS_JSON` | `[]` | Extra CLI args before `run` |
| `A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS` | `3600000` (60m) | Task timeout override |
| `A2A_DOCKER_RUNNER_TIMEOUT_MS` | `3600000` (60m) | Container execution timeout fallback |
| `A2A_DOCKER_RUNNER_ROOT` | `/var/lib/openclaw-a2a/tasks` | Runtime root dir |
| `A2A_DOCKER_RUNNER_IMAGE` | `node:22-bookworm-slim` | Container image |
| `A2A_DOCKER_RUNNER_GITHUB_TOKEN_FILE` | — | gh hosts.yml for container auth |
| `A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT` | — | Safe patch command script content; highest precedence, written to `/work/patch-command.sh` |
| `A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON` | — | Safe patch command JSON `{ "argv": [...], "env": {...} }`; used when script is unset |
| `A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE` | — | Legacy eval template; used only when script/json are unset |

Patch command precedence is `SCRIPT > JSON > TEMPLATE`. Prefer `SCRIPT` or
`JSON` for active targets (`bangtong`, `dungae`, `sogyo`, `nosuk`) and keep the
legacy template only for compatibility during rollout.

## Broker Claim/Heartbeat (untouched)

This integration does **not** modify:
- Broker task claim flow
- Worker heartbeat loop
- Proposal lifecycle
- Broker request/response format

The handler continues to claim → execute → report using the same broker protocol. The only change is *how* `github-propose-patch` tasks are executed inside the worker.

## Failure Modes

| Failure | Evidence |
|---|---|
| Runner binary missing | Handler throws; broker sees handler_error |
| Container fails | Runner returns `ok: false` + `error`; handler returns `status: "blocked"` |
| Timeout | Runner returns `ok: false, status: "timeout"` |
| No GitHub token | Runner can't post Block/Done comments; evidence.`blockCommentUrl` stays undefined |
| No PR generated | Runner posts Done comment; handler returns `status: "done"` |

## Active Worker Nodes

| Node | Expected integration state |
|---|---|
| bangtong | Handler imports integration; `A2A_DOCKER_RUNNER_ENABLED=1` |
| dungae | Handler imports integration; `A2A_DOCKER_RUNNER_ENABLED=1` |
| sogyo | Handler imports integration; `A2A_DOCKER_RUNNER_ENABLED=1` |
| nosuk | Handler imports integration; `A2A_DOCKER_RUNNER_ENABLED=1` |
| yukson | **Excluded** (legacy, no integration) |

## Canary Deployment

새로운 노드에 handler integration을 배포하거나 설정을 변경할 때는 **canary 태스크**로 검증한 후 전체 노드로 확장한다.

### Canary Task 실행 절차

1. **타겟 노드에 환경변수 설정**

```bash
# worker runtime 환경(systemd drop-in, Docker Compose env_file, shell export 등)
export A2A_DOCKER_RUNNER_ENABLED=1
export A2A_DOCKER_RUNNER_ALL_GITHUB=1
export A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS=120000  # canary는 2분 타임아웃
export A2A_DOCKER_RUNNER_BIN=a2a-docker-runner
```

2. **canary task.json 생성** (`examples/task.canary.json`)

```json
{
  "id": "canary-smoke-001",
  "intent": "propose_patch",
  "mode": "github-propose-patch",
  "repo": "jinwon-int/a2a-docker-runner",
  "baseBranch": "main",
  "commands": [
    "cd /work/repo && echo 'canary smoke test passed' | tee /work/artifacts/canary-result.txt",
    "cd /work/repo && npm run check 2>&1 | tee /work/artifacts/check.log"
  ],
  "issueUrl": "https://github.com/jinwon-int/a2a-docker-runner/issues/11",
  "reportLanguage": "ko",
  "requestedBy": "seoseo",
  "timeoutMs": 120000
}
```

3. **canary 실행**

```bash
a2a-docker-runner run examples/task.canary.json
```

4. **canary 성공 기준**
- Runner JSON output: `ok: true`, `status: "completed"`
- Artifacts 존재 (`canary-result.txt`, `check.log`)
- Container가 정상적으로 생성/삭제되었는지 확인

### Canary 검증 체크리스트

| 항목 | 확인 방법 | 예상 결과 |
|---|---|---|
| feature flag 감지 | `shouldUseDockerRunnerForGithub(task, env) === true` | true |
| Runner task 빌드 | 환경변수 passthrough 확인 | repo, timeoutMs, preset 정확 |
| Container 생성 | `docker ps -a` | `a2a-canary-smoke-001` 컨테이너 확인 |
| 명령 실행 | artifacts 확인 | 지정한 commands 로그 파일 생성 |
| Runner 결과 JSON | stdout JSON 파싱 | `ok: true, status: "completed"` |
| Evidence mapping | `buildHandlerResult()` 결과 | 올바른 status, summary |
| Container cleanup | `docker ps -a` | canary 컨테이너 삭제됨 |

### Canary 실패 시 대응

1. Runner 로그 확인: `cat /var/lib/openclaw-a2a/tasks/canary-smoke-001/artifacts/summary.txt`
2. Container 로그: `docker logs a2a-canary-smoke-001`
3. Artifacts 디렉토리 상태 확인
4. 공통 원인:
   - Docker/Podman 미설치 또는 데몬 미실행
   - 이미지 pull 실패 (네트워크 이슈)
   - GitHub 토큰 파일 누락 또는 권한 문제
   - 디스크 공간 부족

## CI-Safe Canary Fixture (사전 검증)

실제 Docker 컨테이너 없이 handler → runner CLI → parsing → HandlerResult mapping 전체 파이프라인을 검증하는 CI-safe 테스트다. 라이브 배포 전 `npm test`로 실행되며, Docker나 broker, GitHub API 호출이 전혀 필요하지 않다.

### Fake Runner Binary

`scripts/fake-runner.sh`가 실제 `a2a-docker-runner run <task.json>` 동작을 모사한다. `FAKE_RUNNER_MODE` 환경변수로 출력을 제어한다:

| Mode | 출력 | Exit Code | 검증 경로 |
|---|---|---|---|
| `pr` | 성공 JSON + `github.prUrl` | 0 | `HandlerResult.status === "pr_opened"` |
| `done` | 성공 JSON + `github.doneCommentUrl` | 0 | `HandlerResult.status === "done"` |
| `block` | 실패 JSON + `github.blockCommentUrl` | 1 | `HandlerResult.status === "blocked"` |
| `failure` | 타임아웃 JSON (evidence 없음) | 1 | `HandlerResult.status === "blocked"` (no evidence) |
| `malformed` | 파싱 불가능한 문자열 | 0 | `parseRunnerOutput` throws |
| `crash` | 절단된 JSON + SIGKILL | 137 | `parseRunnerOutput` throws |

### Canary 실행 (CI / 로컬)

```bash
# 전체 canary fixture 실행 (Docker 불필요)
npm run build && node --test dist/canary.test.js

# 특정 canary 모드만 수동 확인
FAKE_RUNNER_MODE=pr bash scripts/fake-runner.sh run examples/task.canary.json
```

### Canary 검증 항목

| 단계 | 검증 내용 |
|---|---|
| Phase 1 | handler payload → RunnerTask 빌드 (repo, issueUrl, timeoutMs 정확) |
| Phase 2 | fake runner spawn → stdout 파싱 → GitHubEvidence 추출 → HandlerResult 매핑 |
| Phase 3 | ALL_GITHUB=1 canary 배포 시뮬레이션 + timeout env passthrough |
| Phase 4 | Evidence precedence, artifacts 전파, runnerRaw 디버깅 필드 |
| Phase 5 | Rollback 시뮬레이션 (ENABLED=0, ALL_GITHUB unset) |

### 배포 전 검증 (Pre-Deploy Canary Recipe)

1. `npm run build` — TypeScript 컴파일 성공
2. `node --test dist/canary.test.js` — 6개 경로 전체 통과
3. `bash scripts/fake-runner.sh pr` — fake runner 단독 실행 확인
4. 위 3단계가 모두 통과해야 라이브 롤아웃 진행

## Local Development & Teardown

로컬 개발/테스트 후 남은 아티팩트를 정리하는 절차이다. `A2A_DOCKER_RUNNER_ROOT` 기본 경로는 `/var/lib/openclaw-a2a/tasks`이며, 각 태스크 실행은 `rootDir/<safeTaskId>/<runToken>/` 구조로 아티팩트를 생성한다.

### Container Cleanup

기본적으로 runner는 태스크 완료 후 컨테이너를 **삭제한다** (`--rm`). 하지만 일부 중단(crash, SIGKILL, 데몬 재시작) 시 컨테이너가 남을 수 있다. 아래 명령어로 확인/정리한다:

```bash
# 남은 a2a-runner 컨테이너 확인
docker ps -a --filter name=a2a-

# 모두 삭제
docker ps -a --filter name=a2a- -q | xargs -r docker rm -f

# Podman 사용 시
declare engine="${A2A_DOCKER_RUNNER_ENGINE:-docker}"
"$engine" ps -a --filter name=a2a-
```

### Artifact Cleanup

태스크 실행 후 생성된 아티팩트 디렉토리를 정리한다:

```bash
# rootDir 기본값 사용 시
export A2A_DOCKER_RUNNER_ROOT=${A2A_DOCKER_RUNNER_ROOT:-/var/lib/openclaw-a2a/tasks}

# 최근 7일 초과 디렉토리만 정리 (안전하게 유지할 기간 보존)
find "$A2A_DOCKER_RUNNER_ROOT" -maxdepth 1 -mindepth 1 -type d -mtime +7 -exec rm -rf {} +

# 특정 태스크 ID 정리
rm -rf "$A2A_DOCKER_RUNNER_ROOT/<safeTaskId>"
```

### Image Cleanup

로컬 테스트로 인해 pull된 베이스 이미지 (`node:22-bookworm-slim` 및 변형)가 오래되면 디스크를 차지할 수 있다:

```bash
# 사용된 a2a-runner 이미지 확인
docker images --filter reference='node:22-bookworm-slim' --filter reference='node:22-*'

# 오래된 dangling 이미지 정리
docker image prune -f
```

### Full Local Reset

개발/테스트 세션 후 완전히 초기화하려면:

```bash
# 모든 관련 컨테이너 정리
docker ps -a --filter name=a2a- -q | xargs -r docker rm -f

# 아티팩트 정리 (rootDir 확인 필요)
export A2A_DOCKER_RUNNER_ROOT=${A2A_DOCKER_RUNNER_ROOT:-/var/lib/openclaw-a2a/tasks}
rm -rf "$A2A_DOCKER_RUNNER_ROOT"/*

# dangling 이미지 정리 (선택사항)
docker image prune -f
```

### Safety Notes

- 다른 활성 작업자가 동일한 `rootDir`을 공유하지 않는지 확인한 후 정리한다.
- `find -mtime` 필터를 사용하면 최근 실행 기록을 유지할 수 있다.
- 스캐너 모듈(`scanHistory`)을 사용하면 정리 전 아카이브 번들을 먼저 생성할 수 있다 (아티팩트 매니페스트의 "Artifact retention & boundaries" 참고).
- 컨테이너 정리 시 이미 실행 중인 task가 있으면 중단될 수 있으므로, 활동 중인 worker 프로세스가 없을 때 수행한다.

## Rollback

handler integration 문제가 발생하거나 host-workspace direct execution으로 복귀해야 할 때 아래 절차를 따른다.

Broker 런타임은 이 절차의 대상이 아니다. Worker는 기존 HTTP broker endpoint와 edge-secret 설정으로 claim → execute → report를 계속 수행하며, broker가 Docker Compose로 실행되는지 systemd로 실행되는지는 runner 설정/rollback 판단에 영향을 주지 않는다.

### 즉시 Rollback (전체 비활성화)

```bash
# worker 환경변수에서 Runner 비활성화
export A2A_DOCKER_RUNNER_ENABLED=0
# 또는
export A2A_DOCKER_RUNNER_ENABLED=false

# worker 재시작 (서서가 결정)
# systemctl --user restart openclaw-a2a-worker
```

**영향**: 모든 `github-propose-patch` 태스크가 기존 host-workspace direct execution 경로로 복귀한다.

### 부분 Rollback (ALL_GITHUB만 해제)

```bash
# Runner는 유지하되, preset/repo 매칭 태스크만 Runner로 라우팅
export A2A_DOCKER_RUNNER_ENABLED=1
unset A2A_DOCKER_RUNNER_ALL_GITHUB
# 또는
export A2A_DOCKER_RUNNER_ALL_GITHUB=0
```

**영향**:
- `openclaw-plugin-a2a` repo/preset 태스크 → 계속 Runner 사용
- 그 외 모든 repo (`jinwon-int/a2a-docker-runner`, `jinwon-int/seoyoon-family-wiki` 등) → host-workspace direct execution

### Rollback 검증

```js
// 검증: 비활성화된 환경에서 shouldUseDockerRunnerForGithub(false)
const rollbackEnv = { A2A_DOCKER_RUNNER_ENABLED: "0" };
assert.equal(shouldUseDockerRunnerForGithub(task, rollbackEnv), false);
```

### Rollback 안전성

- 환경변수만 변경하면 되며, handler 코드 수정은 필요하지 않다.
- `shouldUseDockerRunnerForGithub` 함수가 `A2A_DOCKER_RUNNER_ENABLED`가 falsy이면 false를 반환하므로, 기존 task claim/heartbeat/report 플로우에 영향을 주지 않는다.
- Rollback 중에도 handler는 broker claim → execute → report 사이클을 정상적으로 유지한다.

## Feature Flag Routing Matrix

| `A2A_DOCKER_RUNNER_ENABLED` | `A2A_DOCKER_RUNNER_ALL_GITHUB` | Task Type | Route |
|---|---|---|---|
| `0` / 미설정 | any | github-propose-patch | ❌ host-workspace direct |
| `1` | `0` / 미설정 | openclaw-plugin-a2a repo/preset | ✅ Docker runner |
| `1` | `0` / 미설정 | other repo | ❌ host-workspace direct |
| `1` | `1` | any github-propose-patch | ✅ Docker runner |
| `1` | `1` | non github task (chat, propose_patch) | ❌ host-workspace direct |

## Recommended Rollout Flags

### Phase 1: Initial Canary (단일 노드)

```bash
export A2A_DOCKER_RUNNER_ENABLED=1
export A2A_DOCKER_RUNNER_ALL_GITHUB=0  # preset 매칭만
# openclaw-plugin-a2a 태스크만 Runner로 라우팅
```

### Phase 2: 확장 (활성 노드)

```bash
export A2A_DOCKER_RUNNER_ENABLED=1
export A2A_DOCKER_RUNNER_ALL_GITHUB=1  # 모든 github 태스크
# 모든 github-propose-patch 태스크를 Runner로 라우팅
```

### Phase 3: 안정화 (프로덕션)

```bash
export A2A_DOCKER_RUNNER_ENABLED=1
export A2A_DOCKER_RUNNER_ALL_GITHUB=1
export A2A_DOCKER_RUNNER_TASK_TIMEOUT_MS=3600000  # 60분
export A2A_DOCKER_RUNNER_TIMEOUT_MS=3600000       # 60분
# 전체 활성화 + 표준 타임아웃
```
