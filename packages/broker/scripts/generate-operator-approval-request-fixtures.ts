#!/usr/bin/env npx -y tsx
/**
 * Generate fixture inputs and expected outputs for operator approval request (#990).
 *
 * Usage:
 *   npx tsx scripts/generate-operator-approval-request-fixtures.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const FIXTURE_DIR = join(REPO_ROOT, "fixtures", "operator-approval-request");

const NOW = "2026-06-01T12:00:00.000Z";

async function main() {
  mkdirSync(FIXTURE_DIR, { recursive: true });

  const { classifyTaskComplexity } = await import(
    join(REPO_ROOT, "src/core/task-complexity-classifier.ts")
  );
  const { buildComplexityOrchestrationRecommendation } = await import(
    join(REPO_ROOT, "src/core/complexity-orchestration-recommendation.ts")
  );
  const { buildFinalizerApprovalEnvelopeDraft } = await import(
    join(REPO_ROOT, "src/core/complexity-finalizer-approval-envelope-draft.ts")
  );
  const { buildComplexityExecutionPlanDraft } = await import(
    join(REPO_ROOT, "src/core/complexity-execution-plan-draft.ts")
  );
  const { buildComplexityExecutionPlanPreflightSeal } = await import(
    join(REPO_ROOT, "src/core/complexity-execution-plan-preflight-seal.ts")
  );
  const {
    buildOperatorApprovalRequestFromPreflightSeal,
    renderOperatorApprovalRequestMarkdown,
  } = await import(
    join(REPO_ROOT, "src/core/operator-approval-request.ts")
  );

  const SCENARIOS = [
    {
      name: "simple-autonomous",
      input: { intent: "analyze", targetEnvironment: "research" },
    },
    {
      name: "moderate-sequential",
      input: { intent: "backfill", targetEnvironment: "staging" },
    },
    {
      name: "complex-parallel",
      input: { intent: "propose_patch", targetEnvironment: "research" },
    },
    {
      name: "critical-blocked",
      input: {
        intent: "promote_to_live",
        targetEnvironment: "live",
        policyContext: { requiresApproval: true, liveImpact: true },
      },
    },
  ];

  for (const scenario of SCENARIOS) {
    const opts = { now: NOW };
    const classification = classifyTaskComplexity(scenario.input);
    const recommendation = buildComplexityOrchestrationRecommendation(classification, opts);
    const envelope = buildFinalizerApprovalEnvelopeDraft(recommendation, opts);
    const plan = buildComplexityExecutionPlanDraft(envelope, opts);
    const seal = buildComplexityExecutionPlanPreflightSeal(plan, opts);
    const request = buildOperatorApprovalRequestFromPreflightSeal(seal, opts);

    const planPath = join(FIXTURE_DIR, `${scenario.name}-plan.json`);
    writeFileSync(planPath, JSON.stringify(plan, null, 2) + "\n");
    console.log(`Wrote: ${planPath}`);

    const sealPath = join(FIXTURE_DIR, `${scenario.name}-preflight-seal.json`);
    writeFileSync(sealPath, JSON.stringify(seal, null, 2) + "\n");
    console.log(`Wrote: ${sealPath}`);

    const requestPath = join(FIXTURE_DIR, `${scenario.name}-request.json`);
    writeFileSync(requestPath, JSON.stringify(request, null, 2) + "\n");
    console.log(`Wrote: ${requestPath}`);

    const markdownPath = join(FIXTURE_DIR, `${scenario.name}-request.md`);
    writeFileSync(markdownPath, renderOperatorApprovalRequestMarkdown(request));
    console.log(`Wrote: ${markdownPath}`);
  }

  console.log("\nAll fixtures generated.");
}

main().catch((err) => {
  console.error("Fixture generation failed:", err);
  process.exitCode = 1;
});
