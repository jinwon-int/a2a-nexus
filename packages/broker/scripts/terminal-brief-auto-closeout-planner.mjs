#!/usr/bin/env node
// Read-only fail-closed automatic closeout planner.
//
// Consumes a fixture or raw payload, applies policy-mode gating, and renders
// a deterministic closeout plan. This is a source-only slice — all actions
// have executePermitted=false.
//
// The planner never merges PRs, closes issues, sends providers, ACKs terminal
// rows, mutates broker DB, restarts services, replays history, publishes
// releases, or touches secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildAutoCloseoutPlan,
  renderAutoCloseoutPlanMarkdown,
} from "../dist/core/terminal-brief-auto-closeout-planner.js";

const VALID_POLICY_MODES = new Set(["off", "draft", "comment_only", "comment_and_close"]);

function parseArgs(argv) {
  const readOption = (name) => {
    const prefix = name + "=";
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const policyMode = readOption("--policy-mode") ?? readOption("--policy") ?? "draft";
  if (!VALID_POLICY_MODES.has(policyMode)) {
    throw new Error("invalid --policy-mode: " + policyMode
      + " (valid: " + [...VALID_POLICY_MODES].join(", ") + ")");
  }
  return {
    input: readOption("--input"),
    policyMode,
    parentRoundId: readOption("--parent-round-id") ?? readOption("--parent"),
    hasGitHubToken: argv.includes("--with-token") || argv.includes("--github-token"),
    json: argv.includes("--json") || argv.includes("--format=json"),
    markdown: argv.includes("--markdown") || argv.includes("--format=markdown"),
  };
}

function parseList(value) {
  if (!value) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function sanitize(value) {
  if (typeof value !== "string") return String(value);
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted-token]")
    .replace(/\b(BROKER_EDGE_SECRET|EDGE_SECRET|TOKEN|SECRET)=\S+/gi, "$1=[redacted]")
    .replace(/\/root\/\.openclaw\/[^\s]+/g, "[openclaw-path]")
    .slice(0, 500);
}

function normalizeInput(raw, options) {
  const envelope = raw && typeof raw === "object" ? raw : {};
  // Direct planner fields
  const policyMode = options.policyMode ?? envelope.policyMode ?? "draft";
  const parentRoundId = options.parentRoundId ?? envelope.parentRoundId;
  const hasGitHubToken = options.hasGitHubToken ?? envelope.hasGitHubToken ?? false;
  const ciPassUrls = Array.isArray(envelope.ciPassUrls) ? envelope.ciPassUrls : [];
  const evidenceRevisions = envelope.evidenceRevisions && typeof envelope.evidenceRevisions === "object"
    ? envelope.evidenceRevisions
    : {};
  const operatorOverride = envelope.operatorOverride ?? "";
  // Nested finalCountInput or flat
  const finalCountInput = envelope.finalCountInput && typeof envelope.finalCountInput === "object"
    ? envelope.finalCountInput
    : envelope;
  return {
    finalCountInput: {
      parentRoundId: parentRoundId ?? finalCountInput.parentRoundId,
      expectedWorkers: finalCountInput.expectedWorkers ?? [],
      expectedTotal: finalCountInput.expectedTotal,
      finalCountSignals: Array.isArray(finalCountInput.finalCountSignals)
        ? finalCountInput.finalCountSignals
        : [],
      events: Array.isArray(finalCountInput.events)
        ? finalCountInput.events
        : [],
    },
    policyMode,
    parentRoundId,
    parentRoundTotal: finalCountInput.parentRoundTotal,
    parentRoundOrder: finalCountInput.parentRoundOrder,
    hasGitHubToken,
    ciPassUrls,
    evidenceRevisions,
    operatorOverride,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error(
      "usage: npm run terminal_brief_auto_closeout_planner --"
      + " --input fixture.json --policy-mode draft [--markdown|--json]"
    );
  }
  const raw = JSON.parse(await readFile(options.input, "utf8"));
  const plan = buildAutoCloseoutPlan(normalizeInput(raw, options));
  if (options.json && !options.markdown) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    console.log(renderAutoCloseoutPlanMarkdown(plan));
  }
  process.exit(plan.decision === "approved" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-auto-closeout-planner: " + sanitize(error.message));
  process.exit(2);
});
