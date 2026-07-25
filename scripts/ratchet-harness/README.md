# Ratchet harness — broker 테스트 스위트 실행 시간 래칫 (PoC, #1636)

이 디렉터리는 **broker 소유 보호 평가 하니스**다. 워커(래칫 루프 실행자)는
`ratchet-target.json` **만** 수정할 수 있다. 그 외 파일(`measure.mjs`,
`baseline.json`, 이 README)을 수정한 시도는 무조건 discard이며, 해시 검증이
fail-closed로 거부한다.

## 계약 요약

- **메트릭**: 고정 2페이즈 명령의 wall-clock (3회 반복, median)
  1. `npx tsc -b tsconfig.json` (packages/broker)
  2. `node --test [--test-concurrency N] dist/core/*.test.js`
- **불변 조건 (게이밍 방지)**: TAP 집계 `tests`/`pass`가 베이스라인과 동일하고
  `fail == 0`. 하나라도 다륩니다 → 무조건 discard (개선 폭 무관).
- **keep 판정**: `invariant_ok && delta_pct <= -3` (3% 이상 개선).
- **예산**: 시도당 10분 wall-clock, 총 20회, 연속 3 crash 시 halt.
- **종료**: 예산 소진 / 누적 개선 ≥15% / 연속 crash. "NEVER STOP" 아님.
- **산출물**: 자동 머지 없음. 최종 keep 상태의 diff를 일반 PR 플로우로 제출.

## 워커 write surface (유일)

`ratchet-target.json`:

```json
{
  "testConcurrency": 8,
  "nodeOptions": "--max-old-space-size=4096"
}
```

- `testConcurrency`: 정수 1..32. node `--test-concurrency`에 전달.
- `nodeOptions`: 문자열 ≤500자. 두 페이즈 모두 `NODE_OPTIONS`로 주입.
- 그 외 키/형식 위반은 하니스가 fail-closed로 거부 (crash 기록).

## 증거

매 시도는 루프 드라이버가 `attempts.jsonl`에 1행 기록한다:
`{attempt, parent_commit, patch_ref, median_ms, delta_pct, test_count,
pass_count, invariant_ok, status: keep|discard|crash, description}`.
