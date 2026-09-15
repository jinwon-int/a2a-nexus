# NCLEX content PR evaluation preset (`nclex_content_pr_v1`, #1724)

> 에이전트 진입 경로: 이 문서의 명령·검증·승인 경계를 적용하기 전에 먼저
> [agent manual](agent-manual.md)을 읽는다. 이 페이지는 #1724 도메인 계약
> 참조이지 사용 매뉴얼이 아니다. 문서 색인: [docs/README.md](README.md).

`jinwon-int/nclex` 콘텐츠 PR을 12노드 누구나 출제할 수 있게 하되, 저자와 분리된
formal A2A 팀(T1↔T2 교차)이 exact-head로 평가하고 merge-ready 증거를 GitHub에
투영하는 계약. 구현: `scripts/nclex-content-pr-preset.mjs`(pure, offline
프리셋)와 도메인 패키지 `packages/nclex-evaluation`(npm명
`a2a-nclex-evaluation`; 서명 receipt 계약, receipt 스토어, keyring 적재,
merge-ready 투영).

## 상태

순수 프리셋과 브로커 런타임을 구분한다. 프리셋은 라우팅·준비 판정·코멘트
투영을 계산하며 브로커/GitHub/provider를 호출하지 않는다. 도메인 패키지는
브로커에서도 사용하는 런타임 코드다.

- **로컬 소스 검증** — 순수 프리셋, 서명 도구, 도메인 패키지는 테스트용
  키와 임시 파일로 검증할 수 있다. 운영 브로커나 운영 키링은 필요 없다.
- **브로커 라우트는 기본 미등록** —
  `options.nclexEvaluationKeyringFile ?? A2A_NCLEX_EVALUATION_KEYRING_FILE ?? ""`
  결과를 trim한 값이 비어 있으면 `/nclex-evaluations/*` 라우트를 등록하지 않는다.
  비어 있지 않으면 시작 시 키링 파일을 읽는다. 판독 불가나 로더의 구조 검증에
  실패한 입력은 시작을 실패시킨다. 로더는 키 ID와 공개키 문자열 형식을 확인하며,
  모든 PEM의 암호학적 유효성을 시작 시 검증하는 것은 아니다. 서명은 제출 시 검증한다.
  별도의 NCLEX `record`/`enforce` boolean 옵션은 없다.
- **소스·과거 테스트와 운영 증거** — 로컬 검증이나 과거 T2 제출 기록은 현재
  T1/T2 라우트 활성화, 독립 평가 정족수, canary 수용의 증거가 아니다.
  키링 구성, 실브로커 평가 및 required-check 등록은 별도 운영 절차와 수용 근거가
  필요하다. #1724의 잔여 운영 증거는 이 문서 수정만으로 충족되지 않는다.

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
- merge-ready 투영(`evaluateMergeReadiness`)은 호출자가 제공한 GitHub gate,
  계정 승인, 충돌 여부와 동일 head의 signed PASS 레코드 수(normal 2 /
  high-risk 3), blocking finding을 사용한다. GitHub 상태를 직접 조회하거나
  검증하지 않으며, PASS 레코드 수만으로 서로 다른 reviewer의 정족수를
  증명하지 않는다. 라우팅 규칙의 독립 reviewer 구성과 실제 GitHub 사실은
  finalizer가 별도 증거로 확인해야 한다.
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

- `scripts/nclex-content-pr-receipt.mjs`(offline 서명/검증)와 도메인 패키지
  `packages/nclex-evaluation/src/`(npm명 `a2a-nclex-evaluation`, TS 검증)는
  **같은 JCS+JWS 경로**를 공유 — offline 모듈이 서명한 골든 receipt를 broker
  검증기가 동일하게 수용함을 테스트가 고정한다. 이 도메인은 #1601 첫 슬라이스에서
  broker core에서 추출됐고 구 경로 `packages/broker/src/nclex-evaluation/`는
  삭제됐다. broker 측 접점은 `packages/broker/src/server.ts`(키링 적재, snapshot
  extension, 라우트 등록)와 `packages/broker/src/http/nclex-evaluation-routes.ts`
  (라우트 위임 seam)뿐이며, broker가 이 패키지를 import하는 방향만 존재한다.
- Receipt는 repo/PR/base·head SHA/diffHash/intentHash/author·reviewer/team/
  lane/findings/verdict/producedAt에 바인딩되며 receipt id = canonical core의
  sha256. 바인딩 필드 변조·self-review·미등록 키는 fail-closed.
- Broker 표면은 **default-off**: `A2A_NCLEX_EVALUATION_KEYRING_FILE` 설정 시에만
  등록되고 판독·구조 검증 실패는 startup fail. 라우트:
  - `POST /nclex-evaluations/receipts` — operator 전용, 서명 검증 후 idempotent 저장
  - `GET /nclex-evaluations/receipts` — requester identity enforcement가 켜져 있으면
    hub/operator/analyst/researcher 역할을 요구한다. 본문을 제외한 선택 필드 목록만 반환한다
  - `GET /nclex-evaluations/{owner}/{repo}/{pr}/merge-ready?headSha=…&risk=…&gateGreen=…&authorDistinctApproval=…&mergeConflict=…`
    — 같은 읽기 역할 조건으로 저장된 receipt + 호출자 제공 GitHub 사실
    파라미터를 투영한다(ready/reasons). GitHub 조회·병합은 수행하지 않는다
- 저장은 broker snapshot extension에 탑재되어 재시작 후에도 복원된다.
- A2A reviewer는 branch를 수정·merge하지 않는다는 경계는 route에도 동일하게
  적용 — merge 경로는 이 표면에 존재하지 않는다.

## 로컬 검증 (현행 소스 기준)

저장소 루트에서 지원 Node 버전(`package.json`, >=22.5)과 설치된 의존성으로
실행한다. 새 checkout이면 먼저 `npm ci --ignore-scripts`를 실행한다.
테스트는 테스트 키·임시 키링과 로컬 HTTP 서버를 사용하며 운영 브로커,
운영 키링, provider 호출, GitHub 쓰기를 요구하지 않는다.

순수 프리셋·오프라인 도구와 도메인 패키지:

```bash
node --test scripts/nclex-content-pr-preset.test.mjs
node --test scripts/nclex-content-pr-receipt.test.mjs
npm run check -w packages/nclex-evaluation
npm run test -w packages/nclex-evaluation
```

브로커 라우트 위임 seam(이 명령은 seam을 검증할 뿐 라우트 활성화가 아니다 —
등록은 실행 시점에 keyring 설정이 있을 때만 일어난다):

```bash
npm run build:tests -w packages/broker
node --test packages/broker/dist/http/nclex-evaluation-routes.test.js
```

문서 링크 게이트와 PR 게이트:

```bash
node scripts/check-markdown-links.mjs
npm run check
```

## Fail-closed fixtures

`scripts/nclex-content-pr-preset.test.mjs`가 고정한다: self-review 불가,
head drift로 인한 stale receipt, manifest 불일치, 필드 누락/형변형,
quorum 미달, co-author recusal, comment 형식.
