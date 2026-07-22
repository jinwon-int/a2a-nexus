#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildA2AWorkerSubagentEvidenceAssembly,
  extractA2AWorkerSubagentEvidenceAssemblyInput,
  renderA2AWorkerSubagentEvidenceAssemblyMarkdown,
} from "a2a-attestation";

function readOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(name + "="));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const inputPath = readOption(argv, "--input");
  if (!inputPath) throw new Error("usage: node scripts/worker-subagent-evidence-assembly.mjs --input fixture.json [--json]");
  const raw = JSON.parse(await readFile(inputPath, "utf8"));
  const packet = buildA2AWorkerSubagentEvidenceAssembly(extractA2AWorkerSubagentEvidenceAssemblyInput(raw));
  if (argv.includes("--json")) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderA2AWorkerSubagentEvidenceAssemblyMarkdown(packet));
}

main().catch((error) => {
  console.error("worker-subagent-evidence-assembly: " + (error instanceof Error ? error.message : String(error)));
  process.exit(2);
});
