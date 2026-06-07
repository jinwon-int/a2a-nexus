#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildOIWorkerSubagentSpawnAuthorizationBridgePacket,
  renderOIWorkerSubagentSpawnAuthorizationBridgeMarkdown,
} from "../dist/core/orchestration-intelligence-worker-subagent-spawn-bridge.js";
import {
  buildA2AWorkerSubagentSpawnAuthorizationRequest,
  extractA2AWorkerSubagentSpawnAuthorizationRequestHandoff,
  extractA2AWorkerSubagentSpawnAuthorizationRequestOptions,
} from "../dist/core/worker-subagent-spawn-authorization-request.js";

function readOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(name + "="));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const inputPath = readOption(argv, "--input");
  if (!inputPath) {
    throw new Error(
      "usage: node scripts/orchestration-intelligence-worker-subagent-spawn-authorization-bridge.mjs --input fixture.json [--json]",
    );
  }
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const v1AuthorizationRequest =
    input.v1AuthorizationRequest
    ?? input.authorizationRequest
    ?? buildA2AWorkerSubagentSpawnAuthorizationRequest(
      extractA2AWorkerSubagentSpawnAuthorizationRequestHandoff(input),
      extractA2AWorkerSubagentSpawnAuthorizationRequestOptions(input),
    );
  const packet = buildOIWorkerSubagentSpawnAuthorizationBridgePacket(v1AuthorizationRequest, {
    now: input.generatedAt,
    operatorTarget: input.operatorTarget,
    targetRepo: input.targetRepo,
    targetIssueNumber: input.targetIssueNumber,
    approvalWindowMinutes: input.approvalWindowMinutes,
    workerSpawnApprovalDecisionEvidence: input.workerSpawnApprovalDecisionEvidence,
  });
  if (argv.includes("--json")) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderOIWorkerSubagentSpawnAuthorizationBridgeMarkdown(packet));
  process.exit(packet.state === "bridge_ready" ? 0 : 1);
}

main().catch((error) => {
  console.error(
    "orchestration-intelligence-worker-subagent-spawn-authorization-bridge: "
    + (error instanceof Error ? error.message : String(error)),
  );
  process.exit(2);
});
