# Ratchet lane PoC report — #1636 (2026-07-26, soonwook)

## Result

**11 attempts, 3 keep / 7 discard / 1 crash. Final retained:
`{"testConcurrency": 12}` → 8,460ms → 7,947ms (-6.06%), invariant green.**

| 판정 기준 (#1636) | 결과 |
|---|---|
| 기술 성공: 규약대로 완주, 판정=하니스 출력 100% 일치 | ✅ 11회 완주 (예산 20 이내, plateau 조기 halt) |
| 가치 성공: ≥5% 개선 1건 이상 | ✅ -6.06% (testConcurrency=12) |
| 제품화 go/no-go | **조건부 go** — 계약은 검증됨, surface 확장 필요 (하단) |

## Attempt curve (median-of-3, ms)

| attempt | target | median | vs baseline | verdict |
|---|---|---|---|---|
| 1 | {} (control) | 8,347 | -1.34% | discard (control) |
| 2 | c=8 | 8,161 | -3.53% | **keep** |
| 3 | c=16 | 7,957 | -5.95% | **keep** |
| 4 | c=32 | 8,445 | -0.18% | discard (oversubscription) |
| 5 | c=16 + old-space 8GB | 7,958 | -5.93% | discard (noise) |
| 6 | c=16 + no-turbo-fan | — | — | **crash** (NODE_OPTIONS disallow, fail-closed 정상) |
| 7 | c=24 | 8,267 | -2.28% | discard |
| 8 | c=12 | 7,947 | **-6.06%** | **keep** (동 시간대 최저 리소스, simplicity rule) |
| 9 | c=12 + semi-space 64MB | 7,943 | -6.11% | discard (noise) |
| 10 | c=14 | 8,040 | -4.96% | discard |
| 11 | c=10 | 7,860 | -7.09% | **discard — invariant FAIL** |

Final confirm at retained state: 7,996ms (-5.48%), invariant green.

## 계약이 증명한 것 (교훈 3건)

1. **불변 조건이 속도를 이겼다 (attempt 11)**: c=10은 측정상 가장 빨랐지만
   3회 중 1회 non-green(flaky)이 발생해 invariant FAIL → discard. "가장 빠른
   수치"가 아니라 "신뢰 가능하게 green인 가장 빠른 수치"만 keep되는 구조가
   실제로 작동했다. flaky 대상 테스트 식별은 별도 후속 필요 (이번 측정에서는
   개별 테스트 ID를 보존하지 못함 — 하니스 개선점).
2. **Crash 경로 작동 (attempt 6)**: NODE_OPTIONS 비허용 플래그가 빌드
   페이즈에서 fail-closed로 잡혀 crash 기록 후 revert. 하니스 우회 불가 확인.
3. **게이밍 없는 탐색**: 전 시도 tests=2849/pass=2849 동일 (attempt 11의
   1회 제외). keep된 개선은 순수 실행 파라미터 조정분.

## 환경 게이밍 리스크 (채택 전제)

- 본 결과는 **vps6 8코어/22GB 단일 호스트** 측정. c=12가 CI 러너(코어 수
  상이)에서도 이득인지는 미검증. 채택 시 게이트 명령에 `--test-concurrency`
  를 **하드코드하지 말고** CI env로 주입하는 형태를 권장. 최종 PR은 CI
  매트릭스 통과 필수이며 래칫 수치는 힌트로만 취급 (#1636 계약 원문).

## 제품화 제안 (후속 spec 시)

1. **Surface 확장 v2**: tsconfig whitelist 키(incremental 등), 테스트 샤딩
   runner. 단 flaky 테스트 식별을 위해 per-run TAP 보존 + failing test ID
   추출을 하니스에 추가할 것.
2. **Flaky 회계**: attempt 11 같은 1/3 non-green을 "flaky"로 분류하고 재측정
   1회 허용 여부를 계약에 명시 (현재는 무조건 discard = 가장 보수적).
3. **게이트 통합**: 래칫 레인을 broker 태스크 타입으로 — 메트릭 등록,
   write-surface 선언, 예산 필드, 불변 조건 DSL.

## Evidence

- `attempts.jsonl` (11행, keep/discard/crash 전량)
- `baseline.json` (sha256 pinned: 4f982b6b…61e9, measure.mjs 내장 해시와
  대조 검증)
- retained state: `ratchet-target.json` = `{"testConcurrency": 12}`
