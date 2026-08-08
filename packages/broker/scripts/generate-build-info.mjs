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
 *
 * #1766: the revision priority above is unchanged — an explicit claim still
 * wins — but it is no longer taken on trust. Before the claim is written it is
 * run through the same evaluator as the build preflight
 * (scripts/check-build-revision.mjs), which FAILS the generation when git is
 * available and contradicts the claim, and WARNS (rather than failing) when
 * there is no git context to contradict it. Failing is right on a host
 * checkout, where both facts exist and disagreeing means the label would lie;
 * warning is right inside the Docker runtime stage and in CI tarball builds,
 * where `.git` is absent and the caller's ARG is the only fact there is.
 * When no claim is made at all, the revision now comes from that evaluator too,
 * so a dirty tree yields `<sha>-dirty` instead of silently asserting a clean SHA.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLAIM_ENV,
  VERIFIED_ENV,
  evaluateBuildRevision,
  formatReport,
  isOptOutEnabled,
  readGitContext,
} from "./check-build-revision.mjs";

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

/**
 * Resolve the revision, verifying any claim against the tree being built.
 * Exits non-zero on a contradiction git can actually prove.
 */
function getRevision(env, claimed) {
  const verdict = evaluateBuildRevision({
    claimed,
    ...readGitContext({ cwd: repoRoot }),
    allowUnverified: isOptOutEnabled(env),
  });
  if (!verdict.ok) {
    console.error(formatReport(verdict));
    process.exit(1);
  }
  if (verdict.status === "unverifiable" && String(env[VERIFIED_ENV] ?? "").trim() === "true") {
    // Inside the Docker runtime stage. There is no git here, but the host that
    // started this build already ran the preflight — say so instead of raising
    // a warning on every correct build, which is how warnings get ignored.
    console.error(`build revision: verified on the build host (${VERIFIED_ENV}=true); no git context in the image.`);
  } else if (verdict.status !== "verified" && verdict.status !== "derived") {
    console.error(formatReport(verdict));
  }
  // An explicit claim stays authoritative — it has now been checked, or is
  // uncheckable here and was already reported as such.
  return String(claimed ?? "").trim() || verdict.revision || "unknown";
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

  // `--revision` is a claim too, so it goes through the same verification
  // rather than around it.
  const info = {
    version: cli.version ?? getVersion(env),
    revision: getRevision(env, cli.revision ?? env[CLAIM_ENV]),
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
