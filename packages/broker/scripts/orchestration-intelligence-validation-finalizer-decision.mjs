#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

import { buildOIValidationScorePacket } from "../dist/core/orchestration-intelligence-validation-scorer.js";
import { buildOIValidationFinalizerReviewPacket } from "../dist/core/orchestration-intelligence-validation-finalizer-review.js";
import { buildOIValidationOperatorReviewRequestPacket } from "../dist/core/orchestration-intelligence-validation-operator-review-request.js";
import { buildOIValidationOperatorDecisionEvidencePacket } from "../dist/core/orchestration-intelligence-validation-operator-decision-evidence.js";
import {
  buildOIValidationFinalizerDecisionPacket,
  renderOIValidationFinalizerDecisionMarkdown,
} from "../dist/core/orchestration-intelligence-validation-finalizer-decision.js";

function readOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(name + "="));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const inputPath = readOption(argv, "--input");
  const input = inputPath ? JSON.parse(await readFile(inputPath, "utf8")) : {};
  const score = input.score ?? buildOIValidationScorePacket(input.scoreInput ?? input);
  const finalizerReview =
    input.finalizerReview
    ?? buildOIValidationFinalizerReviewPacket({
      generatedAt: input.generatedAt,
      reviewer: input.reviewer,
      notes: input.finalizerReviewNotes,
      score,
    });
  const reviewRequest =
    input.reviewRequest
    ?? buildOIValidationOperatorReviewRequestPacket({
      generatedAt: input.generatedAt,
      operator: input.operator,
      notes: input.reviewRequestNotes,
      finalizerReview,
    });
  const operatorDecisionEvidence =
    input.operatorDecisionEvidence
    ?? buildOIValidationOperatorDecisionEvidencePacket({
      generatedAt: input.generatedAt,
      notes: input.operatorDecisionEvidenceNotes,
      reviewRequest,
      decisionEvidence: input.decisionEvidence,
    });
  const packet = buildOIValidationFinalizerDecisionPacket({
    generatedAt: input.generatedAt,
    runId: input.runId,
    finalizer: input.finalizer,
    notes: input.notes,
    operatorDecisionEvidence,
  });
  if (argv.includes("--json")) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderOIValidationFinalizerDecisionMarkdown(packet));
}

main().catch((error) => {
  console.error("orchestration-intelligence-validation-finalizer-decision: " + (error instanceof Error ? error.message : String(error)));
  process.exit(2);
});
