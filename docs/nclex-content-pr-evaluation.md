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

`verifyRefsManifest`(#1724 갭 b)는 선언된 `refsManifestSha256`를 실제 refs
manifest 값에 바인딩한다. manifest를 RFC 8785(JCS)로 정규화해 SHA-256
64-hex(소문자)를 계산하고 — signed receipt id와 같은 canonical-JSON 규약 —
선언값과 다르면 `refs_manifest_invalid` fail-closed다. 키 순서와 공백은 digest를
바꾸지 않고 배열 순서는 바꾸며, manifest는 JSON object/array만 수용하고 정규화
불가 값도 같은 원인으로 실패한다. 반환값은 검증된 입력과 재계산 digest로, 이후
라우팅에 재검증 없이 연결된다.

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

레인 kind는 위 두 종으로 계약 고정돼 있다. 고위험 quorum 3은 두 kind를 입력
순서대로 순환 배정하므로 세 번째 레인은 `content_clinical`을 재사용한다 — 이는
의도된 설계다. 독립성은 kind 고유성이 아니라 서로 다른 reviewer 구조 강제와
cross-team 확대로 보장되며, `laneId`가 reviewer 노드 ID를 포함하므로 kind가
겹쳐도 세 레인은 고유하게 식별된다(#1724 갭 (c) 문서화).

예산 기본값(#1518 계약 재사용): correction generation 1, reviewer run 2.

## Receipt와 merge-ready

- receipt는 PR/headSha/diffHash/intentHash, author/reviewer, team/lane, finding,
  PASS/BLOCK을 묶는다. PR head가 바뀌면 기존 receipt는 stale로 분류돼 표결에서
  제외된다(`classifyReceipts`).
- merge-ready 투영(offline `evaluateMergeReadiness`, 런타임 `projectMergeReady`)은
  호출자가 제공한 GitHub gate, 계정 승인, 충돌 여부, blocking finding과 함께 두
  개의 정족수 축을 보고한다. `freshPassCount`는 동일 head의 signed PASS 레코드
  수(normal 2 / high-risk 3, 기존 `insufficient_fresh_signed_pass` 원인 유지)이고,
  #1724에서 추가된 `distinctReviewerCount`는 그 레코드 안에서 서로 다른 declared
  `reviewerNodeId`의 수다. distinct 수가 정족수 미달이면 가산 원인
  `insufficient_independent_reviewers:n/quorum`을 낸다. GitHub 상태를 직접
  조회하거나 검증하지 않는다.
- 표결 규칙(#1724): 공백 아닌 문자열 `reviewerNodeId`(`trim()` 적용)만 한 표로
  세고, 서로 다른 `receiptId`/`producedAt`/`lane`/`team`은 두 번째 표를 만들지
  않는다. 노드 ID 비교는 대소문자 구별이며 근거 없는 alias 정규화는 하지 않는다.
  결측·비문자열 identity는 String 강제 변환하지 않고 무시하고, `receiptId`·
  `keyId`·`team`·`lane`을 대체 키로 쓰지 않는다.
- 경계: 이 정족수는 선언된 노드 ID의 distinct 수일 뿐이다. 키↔노드 귀속(provenance),
  레지스트리 허용 목록, 저자/공동저자 recusal 완전성, 임상·fleet 수용은 증명하지
  않는다. 실제 GitHub 사실과 독립 reviewer 구성의 최종 확인은 finalizer가 별도
  증거로 확인해야 한다.
- A2A reviewer는 branch를 수정·merge하지 않는다. broker/finalizer가 ready를
  판정하고 별도 GitHub 권한 계정이 보호 규칙을 우회하지 않고 squash merge한다.

## GitHub 투영 (body-free)

```text
EVALUATION node=<node> team=<T1|T2> lane=<lane> head=<40-char SHA> verdict=<PASS|BLOCK> receipt=<id>
```

prompt 원문·chain-of-thought·제한 자료 본문은 절대 포함하지 않는다.
`formatEvaluationComment`는 이 형식 외 출력을 만들 수 없다.

check-run 투영(`formatEvaluationCheckRun`, `scripts/nclex-content-pr-preset.mjs`)은
**formatter only**다. GitHub check-run 생성 API에 넘길 payload 객체만 반환하며
GitHub를 호출하지 않는다. 그 payload를 실제로 게시하거나 required check로
등록하는 일은 별도 승인 대상이다.

- 입력: exact `headSha`(40-hex 소문자), merge-ready read model(`evaluateMergeReadiness`
  또는 런타임 `projectMergeReady` 결과), 선택적으로 `formatEvaluationComment`와 같은
  필드의 evaluation 목록.
- 출력: `name`(`nclex_content_pr_v1` 고정), `head_sha`, `status: "completed"`,
  `conclusion`, `output.title`, `output.summary`.
- conclusion 매핑: `ready` → `success`, `blocking_findings:*` 원인이 있으면 `failure`,
  그 밖의 미충족(정족수 대기, gate 미통과, 승인 누락, 충돌) → `neutral`.
- body-free: summary는 `MERGE_READY ready=… quorum=… freshPass=… distinctReviewers=…
  stale=… reasons=…` 한 줄과 위 `EVALUATION …` 줄만 담는다. finding note·
  evidenceRef·prompt·제한 자료 본문은 입력 슬롯이 없다. 안정된 원인 코드 형식이
  아닌 reason은 `check_run_invalid`로 거부한다.
- exact head: 다른 head를 가리키는 evaluation은 `check_run_head_mismatch`로
  fail-closed다. head가 바뀌면 이전 PASS는 stale이므로 새 head의 conclusion은
  `success`가 될 수 없다.

## 근거 패킷 경계

- GitHub에는 URL·라이선스·64자리 SHA-256 manifest만 둔다.
- 공명 `/opt/nclex-refs/`는 read-only 자료 허브. task에는 자료 ID·SHA-256·
  페이지/절·검증할 주장·라이선스 분류만 담는다.
- manifest mismatch(`refs_manifest_invalid`)와 허브/원문 접근 실패는 BLOCK.
  #1724 갭 b부터 선언 `refsManifestSha256`는 형식 검증을 넘어 실값과 대조된다:
  `refsManifestDigestSha256`(JCS 정규화 sha256 64-hex)와 불일치하면 같은
  `refs_manifest_invalid`로 BLOCK된다. 64-hex 형식 적합만으로는 참조 manifest의
  무결성을 증명하지 못한다.
- restricted/factcheck-only 원문 전체를 task artifact·PR comment·receipt에 넣지
  않는다. receipt finding의 자유 텍스트 필드는 offline 모듈과 브로커 검증기에서
  같은 규칙으로 제한되고, 위반하면 `receipt_restricted_artifact`로 fail-closed다.
  빌드 시점과 검증 시점 모두 적용되므로 이 규칙을 우회해 서명한 receipt도 수용되지
  않는다.
  - `note`: trim 후 최대 280자(code point), 한 줄. 개행·CR·탭 등 제어 문자와
    U+2028/U+2029를 거부한다.
  - `evidenceRef`: trim 후 최대 160자인 참조 형식 `[namespace:]id[#locator]`.
    `namespace`는 `[a-z][a-z0-9-]{0,31}`, `id`는 `[A-Za-z0-9][A-Za-z0-9._/-]{0,127}`,
    `locator`(페이지/절)는 `[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}`이다.
    `sha256:` namespace는 소문자 64-hex만 허용한다. 예: `packet:p.12`, `pharm-01#p.12`,
    `sha256:<64-hex>#p.212-214`. 공백이 든 문장, URL, 개행은 거부된다.
  - 이 제한은 구조적 상한이다. 짧은 문구의 의미까지 판정하지는 않으므로 reviewer는
    여전히 자료 ID·SHA-256·페이지/절만 인용해야 한다. 이미 저장된 receipt에는
    소급 적용되지 않는다(아래 롤백 절 참조).

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
- Broker 표면은 **default-off**: 위 상태 절의 옵션/환경변수 우선순위로
  결정된 키링 경로가 비어 있지 않을 때만 등록된다. 판독·구조 검증 실패는
  startup fail. 라우트:
  - `POST /nclex-evaluations/receipts` — operator 전용, 서명 검증 후 idempotent 저장
  - `GET /nclex-evaluations/receipts` — requester identity enforcement가 켜져 있으면
    hub/operator/analyst/researcher 역할을 요구한다. 본문을 제외한 선택 필드 목록만 반환한다
  - `GET /nclex-evaluations/{owner}/{repo}/{pr}/merge-ready?headSha=…&risk=…&gateGreen=…&authorDistinctApproval=…&mergeConflict=…`
    — 같은 읽기 역할 조건으로 저장된 receipt + 호출자 제공 GitHub 사실
    파라미터를 투영한다(ready/reasons). GitHub 조회·병합은 수행하지 않는다
- 저장은 broker snapshot extension에 탑재되어 재시작 후에도 복원된다.
- A2A reviewer는 branch를 수정·merge하지 않는다는 경계는 route에도 동일하게
  적용 — merge 경로는 이 표면에 존재하지 않는다.

## Review lineage 부착 (#2362, #2274 scorecard)

T2 리뷰 레인을 review lineage에 묶으면, 리뷰어 워커가 끝날 때 서명된 review-report를 보냅니다(#2351). 이렇게 쌓인 기록이 #2274 scorecard의 실제 terminal lineage가 됩니다. NCLEX 콘텐츠 PR은 다음 규칙으로 붙입니다.

- **단위**: lineage 1개 = (PR, 역할) 1개입니다. lineage는 리뷰어 한 명의 흐름을 전제합니다(`review-lifecycle/lifecycle.ts`). 첫 `pass`에 열린 blocking finding이 없으면 `passed`로 끝나고, 이후 보고는 `report_out_of_state`가 됩니다. 그래서 같은 head의 병렬 역할 레인(`content_clinical`, `evidence_adversarial`, `high_risk_safety`)은 **lineage를 공유하면 안 됩니다**.
- **고정 intent**: `scripts/lib/nclex-lineage-spec.mjs`가 head와 무관한 입력만으로 spec을 만듭니다. 입력은 PR 번호, 역할, PR 본문 8필드 계약(`TASK_ID`…`RISK_CLASS`)입니다. lineageId는 결정적으로 정합니다(`nclex-pr<N>-<role>`). NCLEX 자체 `intentContract`(head 의존)는 그대로 둡니다.
- **절차** (`A2A_EDGE_SECRET`는 env로만 넘깁니다)
  1. 첫 head를 dispatch하기 전에 역할마다 spec을 만들고 lineage를 생성합니다.
     ```bash
     node scripts/lib/nclex-lineage-spec.mjs --pr 624 --role content_clinical \
       --base <base.sha> --head <head.sha> --body-file pr-body.md --repo /path/to/nclex \
       --broker-url <T2 broker> --requester-id <operator id> --out spec-content-clinical.json
     node scripts/lib/review-lineage-client.mjs create --spec spec-content-clinical.json \
       --out lineage-pr624-content-clinical.json --dry-run   # 확인 후 --dry-run 제거
     ```
  2. 해당 역할 레인에 `reviewLineageRecord: <record 경로>`를 적고 `a2a-dispatch-round.mjs`로 보냅니다(#2359가 `payload.reviewLineage`를 채움). 레인 하나에는 record 하나만 씁니다.
  3. 수정으로 새 head가 오면 lineage를 새로 만들지 않습니다. 같은 record로 `correct --record <record> --generation-ref <수정 커밋/코멘트 ref> --head <new head> --repo <checkout>`를 실행한 뒤 재리뷰 레인에 같은 record를 씁니다.
- **bind하지 않는 경우**: 같은 (PR, head, 역할)에서 **이미 review-report가 나간 뒤의 재실행**은 bind하지 않습니다. 다시 bind하면 reviewer run이 부풀어 예산 데이터가 왜곡됩니다. 인프라 실패로 보고가 없었던 재실행은 같은 record로 bind해도 됩니다. 리뷰어 워커를 바꿔야 하면 operator가 `replace-reviewer --record <record> --decision-ref <ref>`로 기록합니다(예산은 초기화되지 않음).
- **확인**: 워커 로그의 `"event":"review_lineage_report"` 줄(outcome `reported|skipped|rejected|failed`)과 `GET /review-lineages/<lineageId>`로 확인합니다.
- **범위 밖**: broker 다중 리뷰어 quorum, enforce 모드, `DEFAULT_LINEAGE_BUDGET` 변경, T1 확대는 각각 별도 승인 대상입니다.

## 롤백 / 비활성화

이 절은 절차 설명일 뿐 실행 승인이 아니다. 운영 브로커에서 환경변수 변경,
재시작, 키링 파일 수정, 상태 파일/DB 백업·편집 중 무엇이든 실행하려면 정확한 대상과
rollback을 제시하고 별도 승인을 받은 운영자 작업으로 진행한다.

- **끄기**: 브로커 환경에서 `A2A_NCLEX_EVALUATION_KEYRING_FILE`을 제거하고(공백만
  있는 값도 미설정과 같다), 서버 옵션 `nclexEvaluationKeyringFile`도 넘기지 않은 채
  브로커를 재시작한다. 키링 경로는 시작 시 한 번만 읽으므로 런타임 토글이나 hot
  reload는 없다. 재시작 후에는 `/nclex-evaluations/*` 라우트, receipt 스토어,
  snapshot extension이 모두 등록되지 않는다. 프리셋 스크립트는 원래 브로커와 무관하므로
  끌 대상이 없다.
- **이미 저장된 receipt**: 비활성화가 receipt를 즉시 지우지는 않지만, 꺼진 동안에는
  적재·조회·투영되지 않는다. 또한 snapshot extension이 없으면 브로커가 쓰는 snapshot에
  `nclexEvaluationReceipts` 필드가 포함되지 않는다. 따라서 이후 snapshot 쓰기에서 기존
  receipt가 보존된다고 가정하지 않는다. 보존이 필요하면 끄기 전에 상태 파일/DB를
  백업한다(별도 승인 대상). 다시 켜면 그때 로드된 snapshot에 남아 있는 행만 복원된다.
  복원된 행은 서명을 재검증하지 않으며, 이후 추가된 수용 규칙(예:
  `receipt_restricted_artifact`)도 소급 적용되지 않는다. head가 바뀌면 그 receipt는
  stale이 되어 표결에서 빠진다.
- **키 퇴역**: 키링 파일 `{ "keys": { "<kid>": "<spki pem>" } }`에서 해당 kid를 지우고
  브로커를 재시작한다. 이후 그 kid로 서명된 제출은 `receipt_key_unknown`으로 거부된다.
  로더는 빈 `keys`를 거부해 시작을 실패시키므로, 마지막 키를 퇴역하려면 위의 끄기
  절차를 쓴다. 이미 저장된 receipt는 재검증하지 않으므로 퇴역한 키로 서명된 receipt도
  같은 head에서 계속 표결에 들어간다. 키 유출 등으로 그 표를 무효화해야 하면 저장 상태에서
  해당 receipt를 제거해야 하는데, 이는 DB/snapshot 편집(prune)이므로 별도 승인 대상이다.
- **소스 롤백**: 이 기능은 기본 꺼짐이고 source-only이므로 관련 커밋을 revert하면
  된다. check-run formatter는 아무것도 게시하지 않으므로 GitHub 측에서 되돌릴 상태가 없다.

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

`npm run test -w packages/nclex-evaluation`은 receipt-contract 테스트와
#1724 distinct-reviewer 정족수를 고정하는 `merge-ready` 도메인 테스트를 모두
실행한다.

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
quorum 미달, co-author recusal, comment 형식, check-run 투영(body-free, exact
head, conclusion 매핑, head 불일치 fail-closed), 그리고 #1724 distinct-reviewer
정족수 — 동일 reviewer의 다른 receipt 메타데이터는 1표, whitespace 중복은
축소, 대소문자 차이는 별개 노드, 결측/비문자열 identity 미포함(강제 변환
없음, receiptId/team/lane 폴백 없음), stale·unsigned·BLOCK 무표, 원시
`freshPassCount` 보존, 중복 reviewer의 blocking finding 거부권 유지.

restricted artifact fixture는 `scripts/nclex-content-pr-receipt.test.mjs`와
`packages/nclex-evaluation/src/receipt-contract.test.ts`가 같은 벡터 표로 고정한다.
대상은 280자 초과·여러 줄·제어 문자가 든 note, 문장·URL·대문자/짧은 sha256 형태의
evidenceRef, 160자 경계다. 규칙을 우회해 서명한 excerpt receipt는 검증 시
`receipt_restricted_artifact`로 거부되고, 선언되지 않은 finding 필드는 서명 core에
들어가지 않는다. 패키지 테스트는 offline 모듈을 직접 import해 두 검증기의 상한·문법
상수와 벡터별 판정이 같은지도 확인한다.
