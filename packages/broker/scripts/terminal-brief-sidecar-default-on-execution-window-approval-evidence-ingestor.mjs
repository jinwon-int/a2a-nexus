#!/usr/bin/env node
// Source-only Terminal Brief default-on execution window approval evidence
// ingestor. It classifies visibility and approval evidence without sending
// requests, granting/executing approval, creating checkpoints, writing config,
// enabling default-on, applying sidecars, invoking executors, spawning
// processes, sending providers, ACKing terminals, mutating state, restarting
// Gateway/broker, publishing, or moving secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestor,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidence,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions,
  extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceRequestDraft,
  renderTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceMarkdown,
} from "../dist/core/terminal-brief-sidecar-default-on/execution-window-approval-evidence-ingestor.js";

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
    evidenceFile: readOption("--evidence-file"),
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
    throw new Error("usage: npm run terminal_brief_sidecar_default_on_execution_window_approval_evidence_ingestor -- --input execution-window-approval-evidence.json [--evidence-file evidence.json] [--options-file options.json] [--markdown|--json]");
  }
  const rawInput = await readJsonFile(options.input);
  const requestDraft = extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceRequestDraft(rawInput);
  const evidenceInput = options.evidenceFile ? await readJsonFile(options.evidenceFile) : rawInput;
  const optionsInput = options.optionsFile ? await readJsonFile(options.optionsFile) : rawInput;
  const packet = buildTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestor(
    requestDraft,
    extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidence(evidenceInput),
    extractTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceIngestorOptions(optionsInput),
  );
  if (options.json && !options.markdown) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderTerminalBriefSidecarDefaultOnExecutionWindowApprovalEvidenceMarkdown(packet));
  process.exit(packet.state === "accepted" ? 0 : 1);
}

main().catch((error) => {
  console.error("terminal-brief-sidecar-default-on-execution-window-approval-evidence-ingestor: " + sanitize(error.message));
  process.exit(2);
});
