#!/usr/bin/env node
// Build a source-only A2A Dialectic Lite finalizer guard packet.
// Ordinary A2A defaults to light dialectic review; explicit strong a2ad rounds
// can set roundMode=explicit_strong_a2ad in the input JSON.
//
// Usage:
//   npm run build
//   node scripts/a2a-dialectic-lite-finalizer.mjs --input round.json [--json]
//
// The guard fails closed when the dialectic synthesis has not been compared
// against at least one ordinary alternative, or when the selected path has no
// rationale.

import { readFile } from "node:fs/promises";
import process from "node:process";

import {
  buildA2ADialecticLiteFinalizerPacket,
  renderA2ADialecticLiteFinalizerMarkdown,
} from "../dist/core/a2a-dialectic-lite-finalizer.js";

function readOption(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(name + "="));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function has(argv, name) {
  return argv.includes(name);
}

function usage() {
  return [
    "Usage: node scripts/a2a-dialectic-lite-finalizer.mjs --input FILE [--json]",
    "",
    "Builds a source-only finalizer guard packet for A2A Dialectic Lite.",
    "The packet is non-ready unless dialectic synthesis competes with ordinary alternatives and the selected path has a rationale.",
  ].join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  if (has(argv, "--help") || has(argv, "-h")) {
    console.log(usage());
    process.exit(0);
  }

  const inputPath = readOption(argv, "--input");
  if (!inputPath) {
    console.error("Error: --input FILE is required");
    console.error(usage());
    process.exit(2);
  }

  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const packet = buildA2ADialecticLiteFinalizerPacket(input);
  if (has(argv, "--json")) console.log(JSON.stringify(packet, null, 2));
  else console.log(renderA2ADialecticLiteFinalizerMarkdown(packet));

  process.exit(packet.state === "ready_for_finalizer_decision" ? 0 : 1);
}

main().catch((error) => {
  console.error("a2a-dialectic-lite-finalizer: " + (error instanceof Error ? error.message : String(error)));
  process.exit(2);
});
