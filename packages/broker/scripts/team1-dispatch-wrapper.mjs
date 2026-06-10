#!/usr/bin/env node
// Team1 deterministic dispatch wrapper.
//
// Produces a structured dispatch plan with preflight checks, deterministic task
// ids, parent/child metadata, and a sanitized JSON run record.
//
// Default: --dry-run (no task writes).
// Use --execute to confirm write operations after preflight validation.

import process from "node:process";
import { readFileSync } from "node:fs";
import {
  buildTeam1DispatchPlan,
  renderTeam1DispatchPlanMarkdown,
} from "../dist/core/team1-dispatch-wrapper.js";
import {
  buildA2AWorkModePreDispatchDecision,
  buildA2AWorkModeDecisionEvidence,
  extractA2AWorkModePreDispatchDecisionInput,
} from "../dist/core/work-mode-pre-dispatch-decision.js";

function parseArgs(argv) {
  const readOption = (name) => {
    const prefix = name + "=";
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const hasDryRun = argv.includes("--dry-run");
  const hasExecute = argv.includes("--execute");
  const hasJson = argv.includes("--json");
  const hasMarkdown = argv.includes("--markdown");
  const modelEscalationReasons = [];
  if (argv.includes("--context-heavy")) modelEscalationReasons.push("context_heavy");
  if (argv.includes("--broad-source-inspection")) modelEscalationReasons.push("broad_source_inspection");
  if (argv.includes("--context-overflow-retry")) modelEscalationReasons.push("context_overflow_retry");
  if (argv.includes("--no-change-evidence-salvage")) modelEscalationReasons.push("no_change_evidence_salvage");

  const workerModel = readOption("--worker-model");
  const workerThinking = readOption("--worker-thinking");
  const listOption = (name) => {
    const value = readOption(name);
    return value === undefined ? undefined : value.split(",").map((item) => item.trim()).filter(Boolean);
  };

  // --dry-run default: unless --execute is explicitly present, default to dry-run
  const execute = hasExecute && !hasDryRun;
  const dryRun = hasDryRun || !hasExecute;

  return {
    teamId: readOption("--team-id") ?? "team1",
    lane: Number(readOption("--lane") ?? "2"),
    worker: readOption("--worker") ?? "yukson",
    runId: readOption("--run-id") ?? "",
    parentRoundId: readOption("--parent-round-id"),
    parentRoundTotal: readOption("--parent-round-total") === undefined
      ? undefined
      : Number(readOption("--parent-round-total")),
    parentRoundOrder: readOption("--parent-round-order") === undefined
      ? undefined
      : Number(readOption("--parent-round-order")),
    dispatchWorkers: listOption("--dispatch-workers"),
    parentIssueUrl: readOption("--parent-issue") ?? "",
    childIssueUrl: readOption("--child-issue") ?? "",
    childIssue: readOption("--issue") ?? "",
    forceProModel: argv.includes("--force-pro-model"),
    modelEscalationReasons,
    dryRun,
    execute,
    noPreflight: argv.includes("--no-preflight"),
    workerCapabilityPresent: argv.includes("--worker-present") ? true
      : argv.includes("--worker-absent") ? false
      : undefined,
    workerGithubPatchRuntimeReady: argv.includes("--github-patch-ready") ? true
      : argv.includes("--github-patch-not-ready") ? false
      : undefined,
    workerModel,
    workerThinking,
    workModeDecisionPath: readOption("--work-mode-decision"),
    json: hasJson || (!hasMarkdown),
    markdown: hasMarkdown || false,
  };
}

function readWorkModeDecision(path) {
  if (!path) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const packet = parsed?.kind === "a2a-broker.work-mode-pre-dispatch-decision.packet"
    ? parsed
    : buildA2AWorkModePreDispatchDecision(extractA2AWorkModePreDispatchDecisionInput(parsed));
  const mode = packet?.recommendation?.mode;
  if (mode === "solo") {
    throw new Error("--work-mode-decision recommends solo; Team1 dispatch is blocked");
  }
  if (mode !== "team1" && mode !== "hybrid") {
    throw new Error("--work-mode-decision recommendation.mode must be team1 or hybrid");
  }
  if (packet?.recommendation?.workerDispatchAllowedByThisPacket !== false) {
    throw new Error("--work-mode-decision must be source-only with workerDispatchAllowedByThisPacket=false");
  }
  return buildA2AWorkModeDecisionEvidence(packet);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let workModeDecision;
  try {
    workModeDecision = readWorkModeDecision(options.workModeDecisionPath);
  } catch (error) {
    console.error("team1-dispatch-wrapper work-mode decision error: " + (error instanceof Error ? error.message : String(error)));
    process.exit(2);
  }
  if (options.execute && !workModeDecision) {
    console.error("team1-dispatch-wrapper work-mode decision error: --execute requires --work-mode-decision");
    process.exit(2);
  }

  if (!options.runId || !options.parentIssueUrl || !options.childIssueUrl) {
    console.error([
      "Usage: node scripts/team1-dispatch-wrapper.mjs [options]",
      "",
      "Required:",
      "  --run-id <id>          A2A run identifier",
      "  --parent-issue <url>   Parent tracker issue URL",
      "  --child-issue <url>    Lane/child issue URL",
      "",
      "Optional:",
      "  --team-id <id>         Team identifier (default: team1)",
      "  --lane <n>             Lane number 1-4 (default: 2)",
      "  --worker <name>        Worker handle (default: yukson)",
      "  --issue <ref>          Short issue ref like #848",
      "  --parent-round-id <id> Terminal Brief parent round id (default: --run-id)",
      "  --parent-round-total <n>",
      "                          Total lane/task count for the parent round",
      "  --parent-round-order <n>",
      "                          1-based lane/task order inside the parent round",
      "  --dispatch-workers <csv>",
      "                          Actual task recipients; overrides manual totals/order",
      "  --dry-run              Force dry-run mode (default unless --execute)",
      "  --execute              Opt-in to write operations (requires preflight pass)",
      "  --no-preflight         Skip worker preflight checks",
      "  --worker-present       Assume worker capability card is present",
      "  --worker-absent        Assume worker capability card is absent",
      "  --github-patch-ready   Assume worker github-propose-patch runtime is ready",
      "  --github-patch-not-ready",
      "                          Fail closed when runner doctor githubPatch is not ok",
      "  --work-mode-decision <packet.json>",
      "                          Require a pre-dispatch decision packet that",
      "                          recommends team1 or hybrid, not solo",
      "  --context-heavy        Select the approved per-task Pro model",
      "  --broad-source-inspection",
      "                          Select Pro for broad docs/source inspection lanes",
      "  --context-overflow-retry",
      "                          Select Pro when retrying after context overflow",
      "  --no-change-evidence-salvage",
      "                          Select Pro for no-change evidence salvage lanes",
      "  --worker-model <id>    Explicit allowlisted model override (e.g.,",
      "                          deepseek/deepseek-v4-pro)",
      "  --worker-thinking <level>",
      "                          Explicit thinking level override (e.g., high, max)",
      "  --force-pro-model      Select Pro with an explicit per-task override",
      "  --json                 Output JSON (default)",
      "  --markdown             Output human-readable markdown",
      "  --help, -h             Show this help message",
      "",
      "Examples:",
      "  node scripts/team1-dispatch-wrapper.mjs \\",
      "    --run-id a2a-team1-dispatch-20260520 \\",
      "    --parent-issue https://github.com/jinwon-int/a2a-broker/issues/847 \\",
      "    --child-issue https://github.com/jinwon-int/a2a-broker/issues/848 \\",
      '    --issue "#848" --worker yukson --lane 2 --markdown',
      "",
      "  node scripts/team1-dispatch-wrapper.mjs \\",
      "    --run-id a2a-team1-dispatch-20260520 \\",
      "    --parent-issue https://github.com/jinwon-int/a2a-broker/issues/847 \\",
      "    --child-issue https://github.com/jinwon-int/a2a-broker/issues/848 \\",
      "    --execute --worker-present --json",
      "",
      "  node scripts/team1-dispatch-wrapper.mjs \\",
      "    --run-id a2a-team1-dispatch-20260520 \\",
      "    --parent-issue https://github.com/jinwon-int/a2a-broker/issues/847 \\",
      "    --child-issue https://github.com/jinwon-int/a2a-broker/issues/848 \\",
      '    --issue "#848" --worker-model deepseek/deepseek-v4-pro --worker-thinking high \\',
      "    --worker-present --work-mode-decision fixtures/work-mode-pre-dispatch/team1-candidate-review.json --markdown",
    ].join("\n"));
    process.exit(2);
  }

  const roundSpec = {
    teamId: options.teamId,
    lane: options.lane,
    worker: options.worker,
    runId: options.runId,
    parentRoundId: options.parentRoundId || undefined,
    parentRoundTotal: options.parentRoundTotal,
    parentRoundOrder: options.parentRoundOrder,
    dispatchWorkers: options.dispatchWorkers,
    parentIssueUrl: options.parentIssueUrl,
    childIssueUrl: options.childIssueUrl,
    childIssue: options.childIssue || undefined,
    workerModel: options.workerModel || undefined,
    workerThinking: options.workerThinking || undefined,
    workModeDecision,
    modelEscalation: options.forceProModel || options.modelEscalationReasons.length > 0 ? {
      forcePro: options.forceProModel,
      reasons: options.modelEscalationReasons,
    } : undefined,
  };

  const config = {
    dryRun: options.dryRun,
    execute: options.execute,
    preflightEnabled: !options.noPreflight,
  };

  const plan = buildTeam1DispatchPlan(
    roundSpec,
    config,
    options.workerCapabilityPresent,
    options.workerGithubPatchRuntimeReady,
  );

  if (options.markdown) {
    console.log(renderTeam1DispatchPlanMarkdown(plan));
  } else {
    console.log(JSON.stringify(plan, null, 2));
  }

  process.exit(plan.decision.value === "blocked" ? 1 : 0);
}

try {
  main();
} catch (error) {
  console.error("team1-dispatch-wrapper error: " + (error instanceof Error ? error.message : String(error)));
  process.exit(2);
}
