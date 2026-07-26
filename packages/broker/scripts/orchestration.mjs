#!/usr/bin/env node
/**
 * Orchestration intelligence operator surface — single entry point for the
 * 21-tool orchestration-intelligence family (a2a-nexus#1503 Wave 2). Thin
 * runner over scripts/lib/operator-dispatch.mjs; see that lib for semantics.
 *
 * Usage:
 *   node scripts/orchestration.mjs --list
 *   node scripts/orchestration.mjs [--no-build] <tool> [tool args...]
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runDispatcher } from "./lib/operator-dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

runDispatcher({
  surfaceName: "orchestration",
  manifestPath: join(HERE, "orchestration-manifest.json"),
  argv: process.argv.slice(2),
});
