#!/usr/bin/env node
/**
 * Terminal Brief operator surface — single entry point for the 59-tool
 * terminal-brief approval family (a2a-nexus#1503 Wave 1). Thin runner over
 * scripts/lib/operator-dispatch.mjs; see that lib for semantics.
 *
 * Usage:
 *   node scripts/terminal-brief.mjs --list
 *   node scripts/terminal-brief.mjs [--no-build] <tool> [tool args...]
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runDispatcher } from "./lib/operator-dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

runDispatcher({
  surfaceName: "terminal-brief",
  manifestPath: join(HERE, "terminal-brief-manifest.json"),
  argv: process.argv.slice(2),
});
