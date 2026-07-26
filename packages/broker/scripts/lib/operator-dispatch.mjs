#!/usr/bin/env node
/**
 * Shared operator-surface dispatcher (a2a-nexus#1503 script ratchet).
 *
 * One code path behind the per-family runners (terminal-brief.mjs,
 * orchestration.mjs, rollout.mjs): a runner supplies its family manifest
 * and this lib maps a subcommand to its wrapper script, then passes
 * argv/stdio/exit codes through unchanged. Tools marked build=true run
 * `npm run build` before dispatch (their historical npm aliases did the
 * same); --no-build skips it. Unknown tools fail closed (exit 2).
 *
 * The lib never consolidates tool logic — wrappers stay separate files
 * over the src/core engines. It only retires npm-alias surface.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function runDispatcher({ surfaceName, manifestPath, argv }) {
  const fail = (message) => {
    console.error(`${surfaceName}: ${message}`);
    process.exit(2);
  };

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const tools = manifest.tools ?? {};
  const here = dirname(manifestPath);

  const noBuild = argv.includes("--no-build");
  const positional = argv.filter((a) => a !== "--no-build");
  const [tool, ...toolArgs] = positional;

  if (!tool || tool === "--list" || tool === "list") {
    const names = Object.keys(tools).sort();
    console.log(`${surfaceName} operator tools (${names.length}) — manifest: ${manifestPath}`);
    for (const name of names) {
      console.log(`  ${name}${tools[name].build ? "" : " (no build)"}`);
    }
    process.exit(0);
  }

  const entry = tools[tool];
  if (!entry) {
    fail(
      `unknown tool: ${tool}\n` +
        `run the surface runner with \`--list\` for the ${Object.keys(tools).length} valid tool names`,
    );
  }

  // Wrapper scripts live next to the manifest (scripts/); a few historical
  // tools are compiled entry points under the package's dist/.
  const scriptPath = entry.script.startsWith("dist/")
    ? join(here, "..", entry.script)
    : join(here, entry.script);
  if (!existsSync(scriptPath)) {
    fail(`manifest entry ${tool} points at missing script: ${entry.script}`);
  }

  if (entry.build && !noBuild) {
    const build = spawnSync("npm", ["run", "build"], {
      cwd: join(here, ".."),
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
}
