/**
 * Canonical package-level PR review check for fresh clones/worktrees
 * (a2a-nexus#638): reviewers hit "Cannot find module 'node:test'"-style
 * TypeScript resolution failures when running tsc in a worktree that never
 * had its dependencies installed — a harness/setup failure that looks like
 * PR breakage. This script makes the review check deterministic:
 *
 *   1. verify dependencies are installed (node_modules + @types/node);
 *      install with `npm ci` when missing (skippable via --no-install)
 *   2. build the requested workspaces
 *   3. run the requested workspace test suites
 *
 * Usage:
 *   npm run review:check                 # broker (default workspace)
 *   npm run review:check -- --workspace a2a-broker --workspace a2a-docker-runner
 *   npm run review:check -- --no-install # fail loudly instead of npm ci
 *
 * Exit code is non-zero when any step fails (fail-closed) and each step's
 * outcome is summarized so a failed review check states WHICH stage broke.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_WORKSPACES = ["a2a-broker"];

export function parseArgs(argv) {
  const options = { workspaces: [], install: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--workspace" || arg === "-w") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--workspace requires a value");
      }
      options.workspaces.push(value);
      i += 1;
    } else if (arg === "--no-install") {
      options.install = false;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.workspaces.length === 0) {
    options.workspaces = [...DEFAULT_WORKSPACES];
  }
  return options;
}

function run(label, command, args, results) {
  const started = Date.now();
  const proc = spawnSync(command, args, { stdio: "inherit" });
  const ok = proc.status === 0;
  results.push({ label, ok, durationMs: Date.now() - started });
  return ok;
}

export function dependenciesInstalled(rootDir) {
  // @types/node is the dependency whose absence produces the misleading
  // "Cannot find module 'node:test'" tsc failure from the incident.
  return (
    existsSync(resolve(rootDir, "node_modules")) &&
    existsSync(resolve(rootDir, "node_modules", "@types", "node"))
  );
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`review:check: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }

  const results = [];
  if (!dependenciesInstalled(process.cwd())) {
    if (!options.install) {
      console.error(
        "review:check: dependencies are not installed in this worktree (node_modules/@types/node missing). " +
          "Run `npm ci` first or drop --no-install. Without it, tsc fails with misleading " +
          "\"Cannot find module 'node:test'\" errors that look like PR breakage.",
      );
      process.exit(1);
    }
    if (!run("npm ci", "npm", ["ci"], results)) {
      summarize(results);
      process.exit(1);
    }
  }

  for (const workspace of options.workspaces) {
    if (!run(`build ${workspace}`, "npm", ["run", "build", "--workspace", workspace], results)) {
      break;
    }
    if (!run(`test ${workspace}`, "npm", ["test", "--workspace", workspace], results)) {
      break;
    }
  }

  summarize(results);
  process.exit(results.every((step) => step.ok) ? 0 : 1);
}

function summarize(results) {
  console.log("\nreview:check summary");
  for (const step of results) {
    console.log(`  ${step.ok ? "PASS" : "FAIL"}  ${step.label} (${Math.round(step.durationMs / 1000)}s)`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
