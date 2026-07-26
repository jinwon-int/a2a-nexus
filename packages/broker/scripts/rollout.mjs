#!/usr/bin/env node
/**
 * Rollout / preflight operator surface — single entry point for the
 * 24-tool broker-rollout-and-preflight family (a2a-nexus#1503 Wave 2).
 * Thin runner over scripts/lib/operator-dispatch.mjs; see that lib for
 * semantics. (scan:public-readiness stays a direct npm script — the
 * package CI parity lane pins it as a requiredScript.)
 *
 * Usage:
 *   node scripts/rollout.mjs --list
 *   node scripts/rollout.mjs [--no-build] <tool> [tool args...]
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runDispatcher } from "./lib/operator-dispatch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

runDispatcher({
  surfaceName: "rollout",
  manifestPath: join(HERE, "rollout-preflight-manifest.json"),
  argv: process.argv.slice(2),
});
