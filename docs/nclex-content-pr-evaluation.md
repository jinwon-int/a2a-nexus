# NCLEX content PR evaluation preset (`nclex_content_pr_v1`, #1724)

`jinwon-int/nclex` 콘텐츠 PR을 12노드 누구나 출제할 수 있게 하되, 저자와 분리된
formal A2A 팀(T1↔T2 교차)이 exact-head로 평가하고 merge-ready 증거를 GitHub에
투영하는 계약. 구현: `scripts/nclex-content-pr-preset.mjs` (pure, offline).

## 상태

**default-off / source-only.** 이 모듈은 라우팅·준비 판정·코멘트 투영을 계산할
뿐 브로커/GitHub/provider를 호출하지 않는다. record/enforce 활성화, 실브로커
canary, required check 등록은 정확한 대상·rollback을 제시한 별도 승인 후 진행한다.

## 입력 계약

`repo`, `prNumber`, `baseSha`, `headSha`(40-hex), `diffHash`, `intentHash`,
`authorNodeId`, `coAuthorNodeIds?`, `caseIds`, `sourcePacketId`,
`refsManifestSha256`(64-hex), `risk`(`normal`|`high-risk`). 전부 필수 검증 —
receipt가 이 값들에 바인딩되므로 누락/형변형은 fail-closed.

## 라우팅 규칙

1. broker of record는 정확히 하나 — 팀↔브로커 불변(#633: team1→brokerAlpha,
   team2→brokerBeta)을 따른다.
2. T1 저자는 T2가, T2 저자는 T1이 기본 reviewer 팀. 팀 미배정 저자는 recusal 후
   quorum을 채울 수 있는 팀을 선택한다.
3. 저자와 `coAuthorNodeIds`는 reviewer에서 구조적으로 제척된다(도달 시
   `recusal_violation` fail-closed). reviewer는 서로 다른 노드 2명.
4. 팀 내 quorum 미달 또는 `high-risk`(quorum 3)는 cross-team으로 확대하고, 그래도
   미달이면 `insufficient_reviewers`로 실패 — self-review로 떨어지지 않는다.

## 레인

- `content_clinical`: 임상 정확성, NCJMM, 우선순위·위임·안전, 오답 변별력.
- `evidence_adversarial`: 근거-주장 정합성, 라이선스·유사도, 단서 누출,
  응시자 화면·렌더링, 게이트 재현.

예산 기본값(#1518 계약 재사용): correction generation 1, reviewer run 2.

## Receipt와 merge-ready

- receipt는 PR/headSha/diffHash/intentHash, author/reviewer, team/lane, finding,
  PASS/BLOCK을 묶는다. PR head가 바뀌면 기존 receipt는 stale로 분류돼 표결에서
  제외된다(`classifyReceipts`).
- merge-ready 조건(`evaluateMergeReadiness`): GitHub gate green + 동일 head의
  signed PASS ≥ quorum(normal 2 / high-risk 3) + blocking finding 0 +
  저자와 다른 GitHub 계정 승인 + merge conflict 없음.
- A2A reviewer는 branch를 수정·merge하지 않는다. broker/finalizer가 ready를
  판정하고 별도 GitHub 권한 계정이 보호 규칙을 우회하지 않고 squash merge한다.

## GitHub 투영 (body-free)

```text
EVALUATION node=<node> team=<T1|T2> lane=<lane> head=<40-char SHA> verdict=<PASS|BLOCK> receipt=<id>
```

prompt 원문·chain-of-thought·제한 자료 본문은 절대 포함하지 않는다.
`formatEvaluationComment`는 이 형식 외 출력을 만들 수 없다.

## 근거 패킷 경계

- GitHub에는 URL·라이선스·64자리 SHA-256 manifest만 둔다.
- 공명 `/opt/nclex-refs/`는 read-only 자료 허브. task에는 자료 ID·SHA-256·
  페이지/절·검증할 주장·라이선스 분류만 담는다.
- manifest mismatch(`refs_manifest_invalid`)와 허브/원문 접근 실패는 BLOCK.

## Signed receipt와 broker 통합 (#1724 slice 2-3)

- `scripts/nclex-content-pr-receipt.mjs`(offline 서명/검증)와 broker 측
  `packages/broker/src/nclex-evaluation/`(TS 검증)은 **같은 JCS+JWS 경로**를
  공유 — offline 모듈이 서명한 골든 receipt를 broker 검증기가 동일하게 수용함을
  테스트가 고정한다.
- Receipt는 repo/PR/base·head SHA/diffHash/intentHash/author·reviewer/team/
  lane/findings/verdict/producedAt에 바인딩되며 receipt id = canonical core의
  sha256. 바인딩 필드 변조·self-review·미등록 키는 fail-closed.
- Broker 표면은 **default-off**: `A2A_NCLEX_EVALUATION_KEYRING_FILE` 설정 시에만
  등록되고 무효 파일은 startup fail. 라우트:
  - `POST /nclex-evaluations/receipts` — operator 전용, 서명 검증 후 idempotent 저장
  - `GET /nclex-evaluations/receipts` — 목록(운영자 안전 투영만)
  - `GET /nclex-evaluations/{owner}/{repo}/{pr}/merge-ready?headSha=…&risk=…&gateGreen=…&authorDistinctApproval=…&mergeConflict=…`
    — 저장된 receipt + GitHub 사실 파라미터로 merge-ready 판정(ready/reasons)
- 저장은 broker snapshot extension에 탑재되어 재시작 후에도 복원된다.
- A2A reviewer는 branch를 수정·merge하지 않는다는 경계는 route에도 동일하게
  적용 — merge 경로는 이 표면에 존재하지 않는다.

## Fail-closed fixtures

`scripts/nclex-content-pr-preset.test.mjs`가 고정한다: self-review 불가,
head drift로 인한 stale receipt, manifest 불일치, 필드 누락/형변형,
quorum 미달, co-author recusal, comment 형식.
