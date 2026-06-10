import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { routeA2AIntent } from "./a2a-intent-router.js";

describe("routeA2AIntent", () => {
  it("routes explicit Korean A2A execution requests into code-enforced A2A lane", () => {
    const result = routeA2AIntent("이 작업은 a2a 통해서 진행하자");

    assert.equal(result.executionContext, "a2a_required");
    assert.equal(result.mode, "a2a");
    assert.equal(result.directExecutionAllowed, false);
    assert.equal(result.requiresWorkerEvidence, true);
    assert.equal(result.requiresFinalizer, true);
    assert.equal(result.confidence, "high");
    assert.ok(result.reasons.includes("explicit-a2a"));
  });

  it("routes explicit A2AD requests into strong dialectic lane", () => {
    const result = routeA2AIntent("이 설계는 A2AD로 봐. finalizer 판단까지 필요해.");

    assert.equal(result.executionContext, "a2a_required");
    assert.equal(result.mode, "a2ad");
    assert.equal(result.directExecutionAllowed, false);
    assert.ok(result.reasons.includes("explicit-a2ad"));
    assert.ok(result.reasons.includes("finalizer"));
  });

  it("detects worker delegation phrasing even without literal A2A", () => {
    const result = routeA2AIntent("worker들한테 맡겨서 증거 모으고 최종 판단하자");

    assert.equal(result.executionContext, "a2a_required");
    assert.equal(result.mode, "a2a");
    assert.equal(result.confidence, "medium");
    assert.ok(result.reasons.includes("worker-execution"));
  });

  it("detects Team1 Korean scope with execution verb", () => {
    const result = routeA2AIntent("1팀으로 검토 진행하고 finalizer가 판단해줘");

    assert.equal(result.executionContext, "a2a_required");
    assert.equal(result.teamScope, "team1");
    assert.equal(result.directExecutionAllowed, false);
    assert.ok(result.reasons.includes("team-scope:team1"));
  });

  it("detects cross-team scope", () => {
    const result = routeA2AIntent("1팀+2팀 같이 A2A 라운드로 돌려");

    assert.equal(result.executionContext, "a2a_required");
    assert.equal(result.teamScope, "cross-team");
    assert.equal(result.mode, "a2a");
  });

  it("honors structured round mode fields", () => {
    const result = routeA2AIntent({
      message: "operator request",
      roundMode: "explicit_strong_a2ad",
      teamScope: "team2",
    });

    assert.equal(result.executionContext, "a2a_required");
    assert.equal(result.mode, "a2ad");
    assert.equal(result.teamScope, "team2");
    assert.ok(result.reasons.includes("round-mode:a2ad"));
  });

  it("does not trigger on URL-only or documentation-only A2A mentions", () => {
    const urlOnly = routeA2AIntent("참고 링크: https://github.com/jinwon-int/a2a-nexus/issues/555");
    const codeOnly = routeA2AIntent("문서 안 a2a 문자열이 보이는지 확인해줘");
    const inlineCode = routeA2AIntent("`a2a`라는 토큰을 README에 언급한다");

    assert.equal(urlOnly.executionContext, "none");
    assert.equal(urlOnly.directExecutionAllowed, true);
    assert.equal(codeOnly.executionContext, "none");
    assert.equal(inlineCode.executionContext, "none");
  });

  it("keeps ordinary direct requests outside A2A lane", () => {
    const result = routeA2AIntent("이 파일만 직접 읽고 요약해줘");

    assert.equal(result.executionContext, "none");
    assert.equal(result.mode, "none");
    assert.equal(result.directExecutionAllowed, true);
    assert.equal(result.requiresWorkerEvidence, false);
    assert.equal(result.requiresFinalizer, false);
  });
});
