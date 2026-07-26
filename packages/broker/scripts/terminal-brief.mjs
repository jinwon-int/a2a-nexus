#!/usr/bin/env node
/**
 * Terminal Brief operator surface — single entry point for the 59-tool
 * terminal-brief approval family (a2a-nexus#1503 Wave 1).
 *
 * This is a dispatcher, not a consolidation of logic: each tool remains its
 * own wrapper script over the src/core terminal-brief engines, and this
 * runner only maps a subcommand to its wrapper via
 * scripts/terminal-brief-manifest.json, then passes argv/stdio/exit codes
 * through unchanged. Tools marked build=true in the manifest run
 * `npm run build` before dispatch (their historical npm aliases did the
 * same); pass --no-build to skip when dist is known fresh.
 *
 * Usage:
 *   node scripts/terminal-brief.mjs --list
 *   node scripts/terminal-brief.mjs [--no-build] <tool> [tool args...]
 *
 * Example (old → new):
 *   npm run terminal_brief_sidecar_dry_run_gate -- --input x.json
 *   npm run terminal_brief -- terminal_brief_sidecar_dry_run_gate --input x.json
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, "terminal-brief-manifest.json");

function fail(message) {
  console.error(`terminal-brief: ${message}`);
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const tools = manifest.tools ?? {};

const argv = process.argv.slice(2);
const noBuild = argv.includes("--no-build");
const positional = argv.filter((a) => a !== "--no-build");
const [tool, ...toolArgs] = positional;

if (!tool || tool === "--list" || tool === "list") {
  const names = Object.keys(tools).sort();
  console.log(`terminal-brief operator tools (${names.length}) — manifest: scripts/terminal-brief-manifest.json`);
  for (const name of names) {
    console.log(`  ${name}${tools[name].build ? "" : " (no build)"}`);
  }
  process.exit(0);
}

const entry = tools[tool];
if (!entry) {
  fail(
    `unknown tool: ${tool}\n` +
      `run \`npm run terminal_brief -- --list\` for the ${Object.keys(tools).length} valid tool names`,
  );
}

const scriptPath = join(HERE, entry.script);
if (!existsSync(scriptPath)) {
  fail(`manifest entry ${tool} points at missing script: ${entry.script}`);
}

if (entry.build && !noBuild) {
  const build = spawnSync("npm", ["run", "build"], {
    cwd: join(HERE, ".."),
    stdio: "inherit",
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 2);
  }
}

const result = spawnSync(process.execPath, [scriptPath, ...toolArgs], {
  stdio: "inherit",
});
if (result.error) {
  fail(`failed to launch ${entry.script}: ${result.error.message}`);
}
process.exit(result.status ?? 2);
