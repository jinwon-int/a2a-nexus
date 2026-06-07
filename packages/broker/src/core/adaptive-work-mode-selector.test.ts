import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildA2AAdaptiveSelectorRecord,
  extractA2AAdaptiveSelectorInput,
  renderA2AAdaptiveSelectorMarkdown,
} from "./adaptive-work-mode-selector.js";

const NOW = "2026-06-07T14:10:00.000Z";

function fixture(name: string) {
  return JSON.parse(readFileSync(`fixtures/adaptive-work-mode-selector/${name}.json`, "utf8"));
}

test("short answer stays solo", () => {
  const record = buildA2AAdaptiveSelectorRecord({ ...fixture("short-answer"), now: NOW });

  assert.equal(record.decision.workMode, "solo");
  assert.equal(record.decision.fallbackMode, "solo");
  assert.equal(record.decision.estimatedOutputSize, "small");
  assert.equal(record.dispatchAllowedByThisRecord, false);
});

test("single repo code patch uses a2a_direct rather than heavy modes", () => {
  const record = buildA2AAdaptiveSelectorRecord({ ...fixture("single-repo-code-patch"), now: NOW });

  assert.equal(record.decision.workMode, "a2a_direct");
  assert.equal(record.decision.needsEvidence, true);
  assert.equal(record.decision.roleSplit.includes("execute"), true);
  assert.equal(record.decision.roleSplit.includes("validate"), false);
});

test("PR with tests and validation uses one-worker hybrid fanout", () => {
  const record = buildA2AAdaptiveSelectorRecord({ ...fixture("pr-tests-validation"), now: NOW });

  assert.equal(record.decision.workMode, "a2a_hybrid");
  assert.equal(record.decision.fallbackMode, "a2a_direct");
  assert.equal(record.decision.roleSplit.includes("implement"), true);
  assert.equal(record.decision.roleSplit.includes("validate"), true);
});

test("multi-node evidence task uses broker-level team mode", () => {
  const record = buildA2AAdaptiveSelectorRecord({ ...fixture("multi-node-evidence"), now: NOW });

  assert.equal(record.decision.workMode, "a2a_team");
  assert.equal(record.decision.estimatedOutputSize, "large");
  assert.equal(record.decision.needsDurableState, true);
});

test("explicit decision debate uses a2ad", () => {
  const record = buildA2AAdaptiveSelectorRecord({ ...fixture("decision-debate"), now: NOW });

  assert.equal(record.decision.workMode, "a2ad");
  assert.equal(record.decision.roleSplit.includes("thesis"), true);
  assert.equal(record.decision.roleSplit.includes("antithesis"), true);
  assert.equal(record.decision.roleSplit.includes("synthesis"), true);
});

test("approval-gated live action blocks heavy modes even with large signals", () => {
  const record = buildA2AAdaptiveSelectorRecord({
    now: NOW,
    task: { taskId: "live-change", taskClass: "ops_closeout" },
    signals: {
      expectedOutputSize: "large",
      needsEvidence: true,
      needsValidation: true,
      needsDurableState: true,
      roleSeparable: true,
      approvalGatedLiveAction: true,
    },
  });

  assert.equal(record.decision.workMode, "solo");
  assert.equal(record.decision.blockers.includes("approval_required_for_live_or_external_action"), true);
});

test("extractor accepts snake_case envelope and markdown is explicit about no dispatch", () => {
  const input = extractA2AAdaptiveSelectorInput({
    adaptive_work_mode_selector: {
      now: NOW,
      task: {
        task_id: "snake-case",
        task_class: "single_repo_patch",
      },
      signals: {
        needs_evidence: true,
        needs_durable_state: true,
        needs_pr_or_artifact: true,
      },
      finalizer_owner: "seoseo",
    },
  });
  const record = buildA2AAdaptiveSelectorRecord(input);
  const markdown = renderA2AAdaptiveSelectorMarkdown(record);

  assert.equal(record.generatedAt, NOW);
  assert.equal(record.decision.workMode, "a2a_direct");
  assert.equal(record.decision.finalizerOwner, "seoseo");
  assert.equal(markdown.includes("No worker dispatch"), true);
  assert.equal(markdown.includes("dispatchAllowedByThisRecord**: false"), true);
});
