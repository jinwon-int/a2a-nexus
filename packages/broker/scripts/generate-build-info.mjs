#!/usr/bin/env node
/**
 * Generate dist/build-info.json from git metadata and environment.
 *
 * Priority (first non-empty wins):
 *   1. Command-line --revision / --version / --built-at / --source / --runtime
 *   2. Environment variable A2A_BROKER_REVISION / A2A_BROKER_VERSION / etc.
 *   3. git rev-parse HEAD / git describe (git context only)
 *   4. package.json version
 *   5. Static fallbacks
 *
 * Designed to run:
 *   - Inside Docker build (ARG → ENV supplies the values)
 *   - In local dev (git resolves the revision)
 *   - In CI (env vars or git resolves the revision)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

function getVersion(env) {
  if (env.A2A_BROKER_VERSION) return env.A2A_BROKER_VERSION;
  try {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
    if (pkg.version) return pkg.version;
  } catch { /* fall through */ }
  return "0.1.0";
}

function getRevision(env) {
  if (env.A2A_BROKER_REVISION) return env.A2A_BROKER_REVISION;
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (sha) return sha;
  } catch { /* fall through */ }
  return "unknown";
}

function getSource() {
  return "github.com/jinwon-int/a2a-nexus";
}

function getBuiltAt(env) {
  if (env.A2A_BROKER_BUILT_AT || env.A2A_BROKER_CREATED) {
    return env.A2A_BROKER_BUILT_AT || env.A2A_BROKER_CREATED;
  }
  return new Date().toISOString();
}

function getRuntime(env) {
  if (env.A2A_BROKER_RUNTIME) return env.A2A_BROKER_RUNTIME;
  return "node";
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--revision" && argv[i + 1]) args.revision = argv[++i];
    else if (arg === "--version" && argv[i + 1]) args.version = argv[++i];
    else if (arg === "--built-at" && argv[i + 1]) args.builtAt = argv[++i];
    else if (arg === "--source" && argv[i + 1]) args.source = argv[++i];
    else if (arg === "--runtime" && argv[i + 1]) args.runtime = argv[++i];
    else if (arg === "--out" && argv[i + 1]) args.out = argv[++i];
  }
  return args;
}

function main() {
  const cli = parseArgs(process.argv.slice(2));
  const env = process.env;

  const info = {
    version: cli.version ?? getVersion(env),
    revision: cli.revision ?? getRevision(env),
    source: cli.source ?? getSource(),
    builtAt: cli.builtAt ?? getBuiltAt(env),
    runtime: cli.runtime ?? getRuntime(env),
  };

  const outPath = cli.out ?? resolve(repoRoot, "dist", "build-info.json");

  // Ensure output directory exists
  mkdirSync(dirname(outPath), { recursive: true });

  writeFileSync(outPath, JSON.stringify(info, null, 2) + "\n");
  console.error(`Generated ${outPath}`);
  console.error(`  version:  ${info.version}`);
  console.error(`  revision: ${info.revision}`);
  console.error(`  source:   ${info.source}`);
  console.error(`  builtAt:  ${info.builtAt}`);
  console.error(`  runtime:  ${info.runtime}`);
}

main();
