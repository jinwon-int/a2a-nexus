#!/usr/bin/env node
// Source-only Terminal Brief default-on live executor surface.
// This renders the fail-closed executor packet but never creates checkpoints,
// writes config, enables default-on, applies/restarts sidecars, invokes
// executors, spawns processes, sends providers, ACKs terminal rows, mutates
// state, restarts Gateway/broker, publishes releases, or moves secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefSidecarDefaultOnLiveExecutor,
  extractTerminalBriefSidecarDefaultOnLiveExecutorGate,
  extractTerminalBriefSidecarDefaultOnLiveExecutorOptions,
  renderTerminalBriefSidecarDefaultOnLiveExecutorMarkdown,
} from "../dist/core/terminal-brief-sidecar-default-on/live-executor.js";

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
    optionsFile: readOption("--options-file"),
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

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) {
    throw new Error("usage: npm run terminal_brief_sidecar_default_on_live_executor -- --input final-runtime-mutation-executor-gate.json [--options-file options.json] [--markdown|--json]");
  }
  const rawInput = await readJsonFile(options.input);
  const gate = extractTerminalBriefSidecarDefaultOnLiveExecutorGate(rawInput);
  const liveExecutorOptions = options.optionsFile
    ? extractTerminalBriefSidecarDefaultOnLiveExecutorOptions(await readJsonFile(options.optionsFile))
    : extractTerminalBriefSidecarDefaultOnLiveExecutorOptions(rawInput);
  const packet = buildTerminalBriefSidecarDefaultOnLiveExecutor(gate, liveExecutorOptions);
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefSidecarDefaultOnLiveExecutorMarkdown(packet));
  process.exit(packet.state === "awaiting_final_live_execution_approval" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-sidecar-default-on-live-executor: " + sanitize(error.message));
  process.exit(2);
});
