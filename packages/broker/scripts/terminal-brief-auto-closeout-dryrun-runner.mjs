#!/usr/bin/env node
// Source-only dry-run runner around TerminalBriefAutoCloseoutPlanner.
//
// Wraps the fail-closed automatic closeout planner with deterministic
// source-only dry-run semantics. Always runs in "draft" policy mode,
// forces executePermitted=false on all actions, and emits a typed packet
// with plan, rendered markdown, and safety boundary.
//
// This runner never performs GitHub comment/close, provider send,
// terminal ACK/replay, DB mutation, restart, deploy, release, or
// secret movement.
//
// Usage:
//   npm run terminal_brief_auto_closeout_dryrun_runner -- --input fixture.json [--markdown|--json]

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildAutoCloseoutDryRunRunner,
  extractAutoCloseoutDryRunRunnerInput,
  extractAutoCloseoutDryRunRunnerOptions,
  renderAutoCloseoutDryRunRunnerMarkdown,
} from "../dist/core/terminal-brief-auto-closeout-dryrun-runner.js";

function parseArgs(argv) {
  const readOption = (name) => {
    const prefix = name + "=";
    const inline = argv.find((arg) => arg.startsWith(prefix));
    if (inline) return inline.slice(prefix.length);
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    input: readOption("--input"),
    json: argv.includes("--json") || argv.includes("--format=json"),
    markdown: argv.includes("--markdown") || argv.includes("--format=markdown"),
  };
}

function sanitize(value) {
  if (typeof value !== "string") return String(value);
  return value
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, "[redacted-token]")
    .replace(/\b(BROKER_EDGE_SECRET|EDGE_SECRET|TOKEN|SECRET)=\S+/gi, "$1=[redacted]")
    .replace(/\/root\/\.openclaw\/[^\s]+/g, "[openclaw-path]")
    .slice(0, 500);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error(
      "usage: npm run terminal_brief_auto_closeout_dryrun_runner --"
      + " --input fixture.json [--markdown|--json]"
    );
  }
  const raw = JSON.parse(await readFile(options.input, "utf8"));
  const input = extractAutoCloseoutDryRunRunnerInput(raw);
  const runnerOptions = extractAutoCloseoutDryRunRunnerOptions(raw);

  // Merge explicit CLI overrides from input
  const mergedOptions = {
    ...runnerOptions,
    ...(raw.runId ? { runId: raw.runId } : {}),
    ...(raw.now ? { now: raw.now } : {}),
  };

  const packet = buildAutoCloseoutDryRunRunner(input, mergedOptions);

  if (options.json && !options.markdown) {
    console.log(JSON.stringify(packet, null, 2));
  } else {
    console.log(renderAutoCloseoutDryRunRunnerMarkdown(packet));
  }
  process.exit(packet.state === "plan_ready" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-auto-closeout-dryrun-runner: " + sanitize(error.message));
  process.exit(2);
});
