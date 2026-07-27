#!/usr/bin/env node
// Source-only Terminal Brief default-on final runtime mutation executor gate.
// It reviews accepted execution window approval evidence without creating
// checkpoints, executing rollback, writing config, enabling default-on,
// applying/restarting sidecars, invoking executors, spawning processes,
// sending providers, ACKing terminal rows, mutating state, restarting
// Gateway/broker, publishing releases, or moving secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate,
  extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateEvidence,
  extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions,
  renderTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateMarkdown,
} from "../dist/core/terminal-brief-sidecar-default-on/final-runtime-mutation-executor-gate.js";

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
    throw new Error("usage: npm run terminal_brief_sidecar_default_on_final_runtime_mutation_executor_gate -- --input final-runtime-mutation-executor-gate.json [--options-file options.json] [--markdown|--json]");
  }
  const rawInput = await readJsonFile(options.input);
  const evidence = extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateEvidence(rawInput);
  const gateOptions = options.optionsFile
    ? extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions(await readJsonFile(options.optionsFile))
    : extractTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateOptions(rawInput);
  const packet = buildTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGate(evidence, gateOptions);
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefSidecarDefaultOnFinalRuntimeMutationExecutorGateMarkdown(packet));
  process.exit(packet.state === "ready_for_final_runtime_mutation_executor_review" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-sidecar-default-on-final-runtime-mutation-executor-gate: " + sanitize(error.message));
  process.exit(2);
});
