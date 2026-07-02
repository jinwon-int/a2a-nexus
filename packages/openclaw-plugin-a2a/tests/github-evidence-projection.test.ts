import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  projectGitHubEvidenceForTerminalBrief,
  projectGitHubEvidenceLedgerForTerminalBrief,
  redactGitHubEvidenceText,
} from "../dist/src/github-evidence-projection.js";

const RUN = "a2a-terminal-brief-github-evidence-20260511T000448Z";

function baseInput(overrides = {}) {
  return {
    runId: RUN,
    repo: "jinwon-int/plugin-a2a",
    issueNumber: 259,
    taskId: "5c64a53e-2a1e-4475-a6e5-9f718124384b",
    worker: "workerBeta",
    commentUrl: "https://github.com/jinwon-int/plugin-a2a/issues/259#issuecomment-1",
    summary: "[a2a:Done] rendered GitHub evidence for Terminal Brief",
    ...overrides,
  };
}

describe("projectGitHubEvidenceForTerminalBrief", () => {
  it("renders GitHub comment evidence as Terminal Brief context without ACK/approval", () => {
    const projection = projectGitHubEvidenceForTerminalBrief(baseInput());

    assert.equal(projection.schema, "a2a.terminal-brief.github-evidence.projection.v1");
    assert.equal(projection.marker, "Done");
    assert.equal(projection.status, "done");
    assert.match(projection.terminalBriefLine, /GitHub evidence:Done/);
    assert.match(projection.terminalBriefLine, /non-ACK\/non-approval/);
    assert.deepEqual(projection.boundary, {
      githubComment: "evidence_ledger_only",
      terminalAck: false,
      readReceipt: false,
      visibilityProof: false,
      operatorApproval: false,
      liveProviderSend: false,
    });
  });

  it("prefers PR marker when a PR URL is present", () => {
    const projection = projectGitHubEvidenceForTerminalBrief(
      baseInput({
        prUrl: "https://github.com/jinwon-int/plugin-a2a/pull/260",
        summary: "implementation opened",
      }),
    );

    assert.equal(projection.marker, "PR");
    assert.equal(projection.status, "pr_opened");
    assert.equal(projection.evidenceUrls.pullRequest, "https://github.com/jinwon-int/plugin-a2a/pull/260");
  });

  it("redacts token-shaped strings and private/context paths", () => {
    const syntheticToken = ["ghp", "deadbeefDEADBEEF1234567890"].join("_");
    const redacted = redactGitHubEvidenceText(
      `token=${syntheticToken} Authorization: Bearer secret-value-1234567890 /work/repo/AGENTS.md /home/runner/private.log`,
    );

    assert.doesNotMatch(redacted, /ghp_/);
    assert.doesNotMatch(redacted, /secret-value/);
    assert.doesNotMatch(redacted, /\/work\/repo/);
    assert.doesNotMatch(redacted, /AGENTS\.md/);
    assert.match(redacted, /REDACTED/);
  });

  it("redacts all OpenClaw runtime context file names from text", () => {
    const contextFiles = "AGENTS.md SOUL.md USER.md TOOLS.md HEARTBEAT.md IDENTITY.md MEMORY.md";
    const redacted = redactGitHubEvidenceText(
      `Context file references: ${contextFiles} in /tmp/openclaw-agent-workspace`,
    );

    // Every context-file reference must be redacted
    assert.doesNotMatch(redacted, /AGENTS\.md/);
    assert.doesNotMatch(redacted, /SOUL\.md/);
    assert.doesNotMatch(redacted, /USER\.md/);
    assert.doesNotMatch(redacted, /TOOLS\.md/);
    assert.doesNotMatch(redacted, /HEARTBEAT\.md/);
    assert.doesNotMatch(redacted, /IDENTITY\.md/);
    assert.doesNotMatch(redacted, /MEMORY\.md/);
    assert.match(redacted, /REDACTED:context-file/g);
  });

  it("redacts runtime workspace paths", () => {
    const redacted = redactGitHubEvidenceText(
      "Workspace: /tmp/openclaw-agent-workspace/memory/2026-05-26.md" +
      " Agent: /root/.openclaw/agents/main/sessions/abc.jsonl" +
      " Config: /root/.openclaw/gateway.yaml",
    );

    assert.doesNotMatch(redacted, /\/tmp\/openclaw-agent-workspace/);
    assert.match(redacted, /REDACTED:path/g);
  });

  it("uses a stable dedupe key across exact replays", () => {
    const first = projectGitHubEvidenceForTerminalBrief(baseInput());
    const replay = projectGitHubEvidenceForTerminalBrief(baseInput());

    assert.equal(first.dedupeKey, replay.dedupeKey);
    assert.equal(first.terminalBriefLine, replay.terminalBriefLine);
  });

  it("rejects non-GitHub evidence URLs", () => {
    assert.throws(
      () => projectGitHubEvidenceForTerminalBrief(baseInput({ commentUrl: "https://example.com/comment" })),
      /commentUrl must be a GitHub issue or pull request URL/,
    );
  });
});

describe("projectGitHubEvidenceLedgerForTerminalBrief", () => {
  it("aggregates PR/Done/Block/Start counts for one run", () => {
    const ledger = projectGitHubEvidenceLedgerForTerminalBrief([
      baseInput({ marker: "Start", summary: "Start" }),
      baseInput({ marker: "PR", prUrl: "https://github.com/jinwon-int/plugin-a2a/pull/260" }),
      baseInput({ marker: "Block", summary: "Block: no live send" }),
      baseInput({ marker: "Done", summary: "Done" }),
    ]);

    assert.equal(ledger.runId, RUN);
    assert.equal(ledger.counts.Start, 1);
    assert.equal(ledger.counts.PR, 1);
    assert.equal(ledger.counts.Block, 1);
    assert.equal(ledger.counts.Done, 1);
    assert.equal(ledger.terminalBriefLines.length, 4);
    assert.equal(ledger.boundary.operatorApproval, false);
  });

  it("fails closed when mixed run IDs are supplied", () => {
    assert.throws(
      () => projectGitHubEvidenceLedgerForTerminalBrief([baseInput(), baseInput({ runId: "other-run" })]),
      /ledger inputs must share one runId/,
    );
  });
});
