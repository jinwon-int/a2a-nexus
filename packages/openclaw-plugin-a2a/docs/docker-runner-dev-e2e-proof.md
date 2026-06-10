# a2a-docker-runner 개발 E2E proof

이 문서는 `plugin-a2a` 개발 작업이 `a2a-docker-runner`의 clean checkout 환경에서 설치, 테스트, evidence artifact 생성까지 이어지는지 검증하는 plugin-side runbook/fixture이다.

## Runner preset

반드시 runner preset `plugin-a2a-dev`를 사용한다.

```json
{
  "runnerPreset": "plugin-a2a-dev",
  "repository": "jinwon-int/plugin-a2a",
  "checkout": "clean",
  "commands": ["npm ci", "npm test"],
  "artifact": "runner-result.json"
}
```

## Clean container 검증 절차

1. `a2a-docker-runner`가 작업별 빈 디렉터리에 `jinwon-int/plugin-a2a`를 fresh clone 한다.
2. preset은 기존 node workspace, host `node_modules`, OpenClaw session dump, local secret 파일을 mount하지 않는다.
3. 컨테이너 안에서 아래 명령을 순서대로 실행한다.

```bash
npm ci
npm test
```

4. runner는 stdout/stderr 원문 전체 대신 요약과 exit code 중심의 `runner-result.json` artifact를 보관한다. 토큰, raw private path, session dump는 artifact에 포함하지 않는다.

## Evidence fixture: runner-evidence-split-20260430

이 이슈에서 고정하는 canary evidence는 다음 조건을 만족해야 한다.

- Runner: `a2a-docker-runner`
- Preset: `plugin-a2a-dev`
- Checkout: clean per-task checkout
- Commands: `npm ci && npm test`
- Expected terminal result: success / exit code `0`
- Observed canary: Sogyo clean private clone + `npm ci` + `npm test` smoke passed
- Round: `runner-evidence-split-20260430`

로컬 재검증 결과(노숙, 컨테이너 런타임은 없음):

```text
npm ci -> ok
npm test -> ok, tests 676, pass 676, fail 0
```

> 참고: 노숙 실행 환경에는 Docker CLI가 없어 runner 자체를 로컬에서 재실행하지 못했다. 이 문서/fixture는 plugin repo가 runner preset과 artifact contract를 추적하도록 고정하고, 실제 clean container 실행 evidence는 `a2a-docker-runner`의 `plugin-a2a-dev` preset run result로 연결한다.

## Runner result artifact contract

Plugin-side monitoring/status는 runner artifact를 아래 additive contract로 받을 수 있어야 한다. 새 필드는 추가 가능하지만 기존 필드 의미를 바꾸면 안 된다.

```ts
type DockerRunnerResultArtifact = {
  schemaVersion: "a2a-docker-runner.result.v1";
  runnerPreset: "plugin-a2a-dev";
  repository: "jinwon-int/plugin-a2a";
  checkout: "clean";
  commitSha: string;
  round?: "runner-evidence-split-20260430" | string;
  commands: Array<{
    command: "npm ci" | "npm test" | string;
    exitCode: number;
    durationMs?: number;
    summary?: string;
  }>;
  status: "passed" | "failed" | "blocked";
  artifactUrl?: string;
  createdAt: string;
};
```

### Plugin monitoring/status 연결 규칙

- `status: "passed"`이고 `npm ci`, `npm test`가 모두 `exitCode: 0`이면 plugin monitoring에는 `runnerEvidence.status = "completed"`로 노출한다.
- `status: "failed"` 또는 command exit code non-zero이면 `runnerEvidence.status = "failed"`와 실패 command summary를 노출한다.
- `status: "blocked"`이면 `runnerEvidence.status = "blocked"`와 blocker summary를 노출한다.
- `runnerPreset`, `repository`, `commitSha`, `artifactUrl`, `round`는 `a2a.monitor.status`나 동등한 status projection에서 drilldown metadata로 보존한다.
- artifact ingestion은 additive-tolerant 해야 하며, 알 수 없는 필드는 무시하되 secret-like 값은 status/audit summary에 출력하지 않는다.

## Docker Runner branch mismatch / no-diff terminal evidence

Docker Runner가 GitHub 저장소를 clean clone하고 패치 브랜치를 생성한 후,
해당 브랜치에 `main`(또는 base ref) 대비 실질적인 diff가 없는 경우
(예: 빈 커밋, reset-only, 잘못된 base ref, no-diff clone),
runner는 다음 조건으로 terminal evidence를 남겨야 한다:

- terminal marker는 **Block**이어야 한다 (Done이나 generic success 아님).
- Block reason text는 `No commits between main and <branch>` 형식을 포함해야 한다.
- 복구 가능한 branch URL은 marker text 안에 온전히 보존해야 한다.
- plugin-side receipt는 이 evidence를 actionable branch-mismatch/no-diff Block으로
  분류하고, generic success로 처리하지 않아야 한다.

### Evidence format (expected)

```text
**Block** No commits between main and worker-alpha/issue-242
branch: worker-alpha/issue-242
status: no-diff
```

### Plugin receipt contract

- `parseWorkerStatusMarker`는 `**Block**` marker를 `WorkerStatusBlockEvent`로 파싱한다.
- `payload.reason`에 `No commits between main and ...` 텍스트가 온전히 보존된다.
- `detectMarker`는 marker line을 인식하고, `parseBlockMarker`는 본문을 reason으로 추출한다.
- 실패한 Done marker (failure indicator `no commits between` 포함)는 `success: false`로 분류된다.
- proposal bridge는 Block event를 `ProposalState.BLOCKED`로 매핑하며, APPLIED/APPLY_SUCCEEDED로 처리하지 않는다.
- canonical GitHub payload (`intent=propose_patch`, `payload.mode=github-propose-patch`, repo, issueNumber, issueUrl)은 변경 없이 보존된다.

## PR 체크리스트

- [ ] `docs/docker-runner-dev-e2e-proof.md`가 `plugin-a2a-dev` preset을 명시한다.
- [ ] `npm ci && npm test` clean container command evidence를 포함한다.
- [ ] runner result artifact를 plugin-side monitoring/status에 연결하는 contract note를 포함한다.
- [ ] Docker Runner branch mismatch / no-diff terminal evidence contract를 포함한다.
- [ ] `npm test`가 이 fixture를 검사한다.
