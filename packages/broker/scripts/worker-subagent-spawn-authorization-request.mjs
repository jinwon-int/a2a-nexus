#!/usr/bin/env node
// Source-only worker subagent spawn authorization request draft. It renders a
// finalizer-reviewable authorization request without spawning subagents,
// dispatching broker work, invoking executors, mutating DB/TaskFlow state,
// sending providers, ACKing terminals, restarting services, or moving secrets.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildA2AWorkerSubagentSpawnAuthorizationRequest,
  extractA2AWorkerSubagentSpawnAuthorizationRequestHandoff,
  extractA2AWorkerSubagentSpawnAuthorizationRequestOptions,
  renderA2AWorkerSubagentSpawnAuthorizationRequestMarkdown,
} from "../dist/core/worker-subagent-spawn-authorization-request.js";

function readOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(name + "="));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
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
  const argv = process.argv.slice(2);
  const inputPath = readOption(argv, "--input");
  if (!inputPath) {
    throw new Error("usage: node scripts/worker-subagent-spawn-authorization-request.mjs --input fixture.json [--json]");
  }
  const raw = JSON.parse(await readFile(inputPath, "utf8"));
  const packet = buildA2AWorkerSubagentSpawnAuthorizationRequest(
    extractA2AWorkerSubagentSpawnAuthorizationRequestHandoff(raw),
    extractA2AWorkerSubagentSpawnAuthorizationRequestOptions(raw),
  );
  if (argv.includes("--json")) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderA2AWorkerSubagentSpawnAuthorizationRequestMarkdown(packet));
  process.exit(packet.state === "authorization_request_draft_ready" ? 0 : 1);
}

main().catch((error) => {
  console.error("worker-subagent-spawn-authorization-request: " + sanitize(error instanceof Error ? error.message : String(error)));
  process.exit(2);
});
