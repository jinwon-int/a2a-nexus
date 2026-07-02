import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildHandlerResult,
  extractGitHubEvidence,
  parseRunnerOutput,
} from "./integration.js";
import type {
  HandlerResult,
  HandlerTask,
  RawRunnerOutput,
  TerminalEvidenceKind,
  TerminalEvidenceStatus,
} from "./integration.js";

interface CleanMainSmokeFixture {
  schemaVersion: "a2a.runner.readonly-nochange-clean-main-smoke.v1";
  parent: string;
  issueUrl: string;
  sourceBase: {
    repo: string;
    baseRef: "main";
    baseCommit: string;
    cleanMainRequired: true;
    generatedTmpEvidenceExcluded: true;
  };
  safetyState: {
    noProductionDeployOrRestart: true;
    noLiveProviderSend: true;
    terminalAck: "requires_operator_receipt";
    providerSendIsReceiptEvidence: false;
  };
  cases: CleanMainSmokeCase[];
}

interface CleanMainSmokeCase {
  name: string;
  task: HandlerTask;
  runnerOutput: RawRunnerOutput;
  expected: {
    handlerStatus: HandlerResult["status"];
    evidenceKind: TerminalEvidenceKind;
    terminalStatus: TerminalEvidenceStatus;
    doneCommentUrl?: string;
    blockCommentUrl?: string;
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturePath = resolve(__dirname, "..", "examples", "runner-readonly-nochange-clean-main-smoke.json");

function loadFixture(): CleanMainSmokeFixture {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as CleanMainSmokeFixture;
}

test("clean-main no-change smoke fixture is scoped to #358 and excludes generated tmp evidence", () => {
  const raw = readFileSync(fixturePath, "utf8");
  const fixture = JSON.parse(raw) as CleanMainSmokeFixture;

  assert.equal(fixture.schemaVersion, "a2a.runner.readonly-nochange-clean-main-smoke.v1");
  assert.equal(fixture.parent, "a2a-plane#506 (internal tracker, private)");
  assert.equal(fixture.issueUrl, "https://github.com/jinwon-int/a2a-docker-runner/issues/358");
  assert.deepEqual(fixture.sourceBase, {
    repo: "jinwon-int/a2a-docker-runner",
    baseRef: "main",
    baseCommit: "e3d27ed8615a2d4193bf4e1bcc41e64e9f3f7584",
    cleanMainRequired: true,
    generatedTmpEvidenceExcluded: true,
  });
  assert.deepEqual(fixture.safetyState, {
    noProductionDeployOrRestart: true,
    noLiveProviderSend: true,
    terminalAck: "requires_operator_receipt",
    providerSendIsReceiptEvidence: false,
  });
  assert.doesNotMatch(raw, /tmp\/chaos-e2e-evidence\.json/);
});

test("clean-main no-change smoke distinguishes marker-only output from terminal Done/Block evidence", () => {
  const fixture = loadFixture();
  const seenKinds = new Set<TerminalEvidenceKind>();

  for (const entry of fixture.cases) {
    const parsed = parseRunnerOutput(JSON.stringify(entry.runnerOutput));
    const evidence = extractGitHubEvidence(parsed);
    const handlerResult = buildHandlerResult(parsed, entry.task, "brokerAlpha");

    seenKinds.add(handlerResult.terminalEvidence.evidenceKind);
    assert.equal(handlerResult.status, entry.expected.handlerStatus, entry.name);
    assert.equal(handlerResult.terminalEvidence.evidenceKind, entry.expected.evidenceKind, entry.name);
    assert.equal(handlerResult.terminalEvidence.status, entry.expected.terminalStatus, entry.name);
    assert.equal(handlerResult.prUrl, undefined, `${entry.name}: read-only no-change smoke must not expose PR evidence`);

    if (entry.expected.evidenceKind === "MissingEvidence") {
      assert.equal(evidence, null, entry.name);
      assert.equal(handlerResult.doneCommentUrl, undefined, entry.name);
      assert.equal(handlerResult.blockCommentUrl, undefined, entry.name);
      assert.match(handlerResult.summary, /without PR\/Done\/Block evidence/, entry.name);
    }

    if (entry.expected.doneCommentUrl) {
      assert.equal(evidence?.outcome, "succeeded_no_changes_with_done_evidence", entry.name);
      assert.equal(handlerResult.doneCommentUrl, entry.expected.doneCommentUrl, entry.name);
      assert.equal(handlerResult.blockCommentUrl, undefined, entry.name);
      assert.deepEqual(handlerResult.risks, [], entry.name);
    }

    if (entry.expected.blockCommentUrl) {
      assert.equal(evidence?.outcome, "blocked_no_changes_with_evidence", entry.name);
      assert.equal(handlerResult.blockCommentUrl, entry.expected.blockCommentUrl, entry.name);
      assert.equal(handlerResult.doneCommentUrl, undefined, entry.name);
      assert.deepEqual(handlerResult.risks, ["PR-less validation blocked; review Block evidence"], entry.name);
    }
  }

  assert.deepEqual([...seenKinds].sort(), ["Block", "Done", "MissingEvidence"].sort());
});
