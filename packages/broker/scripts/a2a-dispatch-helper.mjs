#!/usr/bin/env node
// Common A2A dispatch helper.
//
// Produces a source-only dispatch plan with parent round metadata populated
// before task creation. Default: dry-run (no task writes).

import process from "node:process";
import { readFileSync } from "node:fs";
import {
  buildA2ADispatchPlan,
  renderA2ADispatchPlanMarkdown,
} from "../dist/core/a2a-dispatch-helper.js";
import {
  buildA2AWorkModePreDispatchDecision,
  buildA2AWorkModeDecisionEvidence,
  extractA2AWorkModePreDispatchDecisionInput,
} from "../dist/core/work-mode-pre-dispatch-decision.js";

function readOption(argv, name) {
  const prefix = name + "=";
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function numberOption(argv, name) {
  const value = readOption(argv, name);
  return value === undefined ? undefined : Number(value);
}

function listOption(argv, name) {
  const value = readOption(argv, name);
  if (value === undefined) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const hasDryRun = argv.includes("--dry-run");
  const hasExecute = argv.includes("--execute");
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    json: argv.includes("--json") || !argv.includes("--markdown"),
    markdown: argv.includes("--markdown"),
    spec: {
      teamId: readOption(argv, "--team-id") ?? "common",
      lane: numberOption(argv, "--lane") ?? numberOption(argv, "--parent-round-order") ?? 1,
      worker: readOption(argv, "--worker") ?? "",
      runId: readOption(argv, "--run-id") ?? "",
      parentIssueUrl: readOption(argv, "--parent-issue") ?? "",
      childIssueUrl: readOption(argv, "--child-issue") ?? "",
      childIssue: readOption(argv, "--issue") || undefined,
      parentRoundId: readOption(argv, "--parent-round-id") || undefined,
      parentRoundTotal: numberOption(argv, "--parent-round-total"),
      parentRoundOrder: numberOption(argv, "--parent-round-order"),
      assignmentCount: numberOption(argv, "--assignment-count"),
      dispatchWorkers: listOption(argv, "--dispatch-workers"),
      brokerOfRecordId: readOption(argv, "--broker-of-record-id") || undefined,
      originBrokerId: readOption(argv, "--origin-broker-id") || undefined,
      operatorFacingOwner: readOption(argv, "--operator-facing-owner") || undefined,
      readOnlyAudit: argv.includes("--read-only-audit"),
      allowNoChanges: argv.includes("--allow-no-changes"),
      readOnlyValidation: argv.includes("--read-only-validation"),
      crossBrokerHandoff: argv.includes("--cross-broker-handoff")
        ? {
            parentRoundId: readOption(argv, "--handoff-parent-round-id") || readOption(argv, "--parent-round-id") || undefined,
            originBrokerId: readOption(argv, "--handoff-origin-broker-id") || undefined,
            handoffBrokerId: readOption(argv, "--handoff-broker-id") || undefined,
            originTaskId: readOption(argv, "--handoff-origin-task-id") || undefined,
            childWorkerId: readOption(argv, "--handoff-child-worker-id") || readOption(argv, "--worker") || undefined,
          }
        : undefined,
    },
    workModeDecisionPath: readOption(argv, "--work-mode-decision"),
    config: {
      dryRun: hasDryRun || !hasExecute,
      execute: hasExecute && !hasDryRun,
    },
  };
}

function usage() {
  return [
    "Usage: node scripts/a2a-dispatch-helper.mjs [options]",
    "",
    "Required:",
    "  --team-id <team1|team2|common>",
    "  --worker <name>",
    "  --run-id <id>",
    "  --parent-issue <url>",
    "  --child-issue <url>",
    "",
    "Parent round metadata:",
    "  --parent-round-id <id>       Defaults to --run-id",
    "  --parent-round-total <n>     Required for common unless --assignment-count is present",
    "  --parent-round-order <n>     Defaults to --lane",
    "  --assignment-count <n>       Derive parentRoundTotal for common/ad-hoc dispatch",
    "  --dispatch-workers <csv>     Actual task recipients; overrides manual totals/order",
    "",
    "Cross-broker routing:",
    "  --broker-of-record-id <id>",
    "  --origin-broker-id <id>",
    "  --operator-facing-owner <parent|child|local>",
    "  --cross-broker-handoff",
    "  --handoff-broker-id <id>",
    "  --handoff-child-worker-id <id>",
    "",
    "Evidence-only/read-only lanes:",
    "  --read-only-audit",
    "  --allow-no-changes",
    "  --read-only-validation",
    "  --work-mode-decision <packet.json>",
    "                              Require a pre-dispatch decision packet that",
    "                              recommends team1 or hybrid, not solo",
    "",
    "Mode/output:",
    "  --dry-run                    Default; no task writes",
    "  --execute                    Plan write-mode actions after validation",
    "  --json                       Default",
    "  --markdown",
    "",
    "Example:",
    "  node scripts/a2a-dispatch-helper.mjs \\",
    "    --team-id team2 --worker dungae --lane 6 \\",
    "    --run-id a2a-cross-team-20260602T130000Z \\",
    "    --parent-round-total 8 --parent-round-order 6 \\",
    "    --parent-issue https://github.com/jinwon-int/a2a-broker/issues/1032 \\",
    "    --child-issue https://github.com/jinwon-int/a2a-broker/issues/1206 \\",
    "    --broker-of-record-id seoseo --origin-broker-id seoseo \\",
    "    --operator-facing-owner parent --cross-broker-handoff --handoff-broker-id gwakga \\",
    "    --allow-no-changes --read-only-validation \\",
    "    --work-mode-decision fixtures/work-mode-pre-dispatch/team1-candidate-review.json --markdown",
  ].join("\n");
}

function readWorkModeDecision(path) {
  if (!path) return undefined;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const packet = parsed?.kind === "a2a-broker.work-mode-pre-dispatch-decision.packet"
    ? parsed
    : buildA2AWorkModePreDispatchDecision(extractA2AWorkModePreDispatchDecisionInput(parsed));
  const mode = packet?.recommendation?.mode;
  if (mode === "solo") {
    throw new Error("--work-mode-decision recommends solo; dispatch helper is blocked");
  }
  if (mode !== "team1" && mode !== "hybrid") {
    throw new Error("--work-mode-decision recommendation.mode must be team1 or hybrid");
  }
  if (packet?.recommendation?.workerDispatchAllowedByThisPacket !== false) {
    throw new Error("--work-mode-decision must be source-only with workerDispatchAllowedByThisPacket=false");
  }
  return buildA2AWorkModeDecisionEvidence(packet);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage());
  process.exit(0);
}
let workModeDecision;
try {
  workModeDecision = readWorkModeDecision(options.workModeDecisionPath);
} catch (error) {
  console.error("a2a-dispatch-helper work-mode decision error: " + (error instanceof Error ? error.message : String(error)));
  process.exit(2);
}
if (options.config.execute && (options.spec.teamId === "team1" || options.spec.teamId === "common") && !workModeDecision) {
  console.error("a2a-dispatch-helper work-mode decision error: --execute requires --work-mode-decision for team1/common dispatch");
  process.exit(2);
}
if (!options.spec.worker || !options.spec.runId || !options.spec.parentIssueUrl || !options.spec.childIssueUrl) {
  console.error(usage());
  process.exit(2);
}
if (workModeDecision) {
  options.spec.workModeDecision = workModeDecision;
}

const plan = buildA2ADispatchPlan(options.spec, options.config);
if (options.markdown) {
  console.log(renderA2ADispatchPlanMarkdown(plan));
} else {
  console.log(JSON.stringify(plan, null, 2));
}
process.exit(plan.decision.value === "blocked" ? 1 : 0);
