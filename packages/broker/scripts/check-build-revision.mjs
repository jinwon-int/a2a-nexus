#!/usr/bin/env node
/**
 * Build revision preflight (a2a-nexus#1766).
 *
 * The broker image carries `org.opencontainers.image.revision` and the runtime
 * `A2A_BROKER_REVISION` env, but until this gate existed nothing tied that
 * claim to the source actually being built:
 *
 *   - source enters the image from the build context working tree
 *     (`packages/broker/Dockerfile` `COPY packages/broker/src ...`)
 *   - the revision enters from the caller's environment
 *     (`packages/broker/Dockerfile` `ARG A2A_BROKER_REVISION`)
 *
 * The only assertion was "non-empty and not the literal `unknown`", so a stale
 * `export A2A_BROKER_REVISION=...` left in a build shell became the image label
 * and the image shipped provenance that was simply false (observed 2026-08-08:
 * a live container labelled `137da55`, main -299 commits, whose `dist` provably
 * contained 08-07 code).
 *
 * This preflight compares the two facts that *are* available on the host —
 * the claimed revision and `git rev-parse HEAD` — and fails closed when they
 * disagree, or when the working tree is dirty while a clean SHA is claimed.
 *
 * ── Behaviour matrix ──────────────────────────────────────────────────────
 *
 *   git available, claim == HEAD, tree clean      -> `verified`         exit 0
 *   git available, no claim,      tree clean      -> `derived`          exit 0
 *   git available, no claim,      tree dirty      -> `dirty-unclaimed`  exit 0 (warn)
 *   git available, claim != HEAD                  -> `mismatch`         exit 1
 *   git available, claim == HEAD, tree dirty      -> `dirty`            exit 1
 *   git available, claim is not a git SHA         -> `malformed`        exit 1
 *   no git context (tarball / inside Docker)      -> `unverifiable`     exit 0 (warn)
 *   any failure + A2A_BROKER_ALLOW_UNVERIFIED_REVISION=1
 *                                                 -> `override`         exit 0 (LOUD)
 *
 * Two of those deserve their rationale in the source rather than the PR:
 *
 * `dirty-unclaimed` is a warning, not a failure, because an ordinary local
 * `npm run build` with uncommitted edits makes no provenance claim at all. The
 * derived revision is suffixed `-dirty` by `generate-build-info.mjs` instead,
 * so the build stays honest without training developers to keep the opt-out
 * permanently exported (which would defeat the whole gate).
 *
 * `unverifiable` is a warning, not a failure, because with no git context there
 * is exactly one fact and therefore no contradiction to detect. CI tarball
 * builds and the in-image `RUN npm run build` (the Dockerfile does not copy
 * `.git`) legitimately have only the caller's claim. Failing there would break
 * builds this gate cannot say anything about and would push operators onto the
 * opt-out by default. The fail-closed guarantee lives where both facts exist —
 * on the host that runs the image build.
 *
 * Safety: read-only inspection of git state plus, under `--docker-build`, a
 * `docker compose build` in the broker package directory. No release, publish,
 * deploy, credential, DB, or dispatch action is performed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
/** The broker package directory (scripts/..), also the compose project dir. */
export const packageRoot = resolve(scriptDir, "..");

export const CLAIM_ENV = "A2A_BROKER_REVISION";
export const CREATED_ENV = "A2A_BROKER_CREATED";
export const OPT_OUT_ENV = "A2A_BROKER_ALLOW_UNVERIFIED_REVISION";
export const VERIFIED_ENV = "A2A_BROKER_REVISION_VERIFIED";
export const ISSUE_URL = "https://github.com/jinwon-int/a2a-nexus/issues/1766";

/** Shortest abbreviation git itself will resolve unambiguously in practice. */
export const MIN_ABBREV = 7;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const MAX_LISTED_DIRTY_PATHS = 5;

/** A derived revision may carry the `-dirty` suffix; a claimed one may not. */
const LOG_SAFE_REVISION_RE = /^[0-9a-f]{7,40}(-dirty)?$/;
const UNLOGGABLE_REVISION = "<non-sha>";

/**
 * Gate every revision value on its way to a log sink or a child environment.
 *
 * A revision reaches this script from `process.env` / `--revision`, i.e. from
 * outside. Echoing that back verbatim is how caller-controlled text ends up in
 * operator logs, and the broker just spent #1764 establishing the opposite
 * rule: only bounded, allowlisted values are emitted. Anything that is not
 * SHA-shaped collapses to a fixed placeholder — the shape is the whole
 * diagnostic here, so nothing useful is lost.
 */
export function sanitizeRevisionForLog(value) {
  return typeof value === "string" && LOG_SAFE_REVISION_RE.test(value)
    ? value
    : UNLOGGABLE_REVISION;
}

export const FAILING_STATUSES = Object.freeze(["mismatch", "dirty", "malformed"]);

export function normalizeRevision(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * A claim matches HEAD when it is HEAD, or an unambiguous-length prefix of it.
 * `$(git rev-parse HEAD)` is the documented form, but `git rev-parse --short`
 * output must not be reported as a provenance lie.
 */
export function revisionsMatch(claimed, head) {
  const a = normalizeRevision(claimed);
  const b = normalizeRevision(head);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= MIN_ABBREV && a.length < b.length && b.startsWith(a);
}

function describeDirty(dirtyPaths) {
  const paths = Array.isArray(dirtyPaths) ? dirtyPaths : [];
  if (paths.length === 0) return "";
  const shown = paths.slice(0, MAX_LISTED_DIRTY_PATHS).join(", ");
  const rest = paths.length - Math.min(paths.length, MAX_LISTED_DIRTY_PATHS);
  return rest > 0 ? `${shown}, +${rest} more` : shown;
}

/**
 * Pure verdict. All I/O (git, env) is resolved by the caller so the decision
 * table above is directly testable.
 *
 * @returns {{ok: boolean, status: string, revision: string, verified: boolean,
 *            reason: string, suppressed?: object}}
 */
export function evaluateBuildRevision({
  claimed,
  head,
  dirty = false,
  dirtyPaths = [],
  gitAvailable = true,
  allowUnverified = false,
} = {}) {
  const verdict = coreEvaluate({ claimed, head, dirty, dirtyPaths, gitAvailable });
  if (verdict.ok || !allowUnverified) return verdict;
  return {
    ok: true,
    status: "override",
    revision: verdict.revision,
    verified: false,
    reason:
      `${OPT_OUT_ENV}=1 suppressed a fail-closed provenance check ` +
      `(${verdict.status}): ${verdict.reason}`,
    suppressed: { status: verdict.status, reason: verdict.reason },
  };
}

function coreEvaluate({ claimed, head, dirty, dirtyPaths, gitAvailable }) {
  const claim = normalizeRevision(claimed);
  const sha = normalizeRevision(head);

  // Shape is checkable without git, so check it first. Deferring this behind
  // the git-availability branch let a malformed claim ride through the
  // `unverifiable` path as ok:true, becoming the image label and the
  // --print-revision output unexamined — exactly where no git context is
  // available to catch it (the Docker build stage).
  if (claim && !SHA_RE.test(claim)) {
    return {
      ok: false,
      status: "malformed",
      revision: claim,
      verified: false,
      reason:
        `${CLAIM_ENV} is not a git commit SHA (${MIN_ABBREV}-40 lowercase hex): ` +
        `${sanitizeRevisionForLog(claim)}. Provenance must be checkable against ` +
        `the tree being built; use $(git rev-parse HEAD).`,
    };
  }

  if (!gitAvailable || !sha) {
    return {
      ok: true,
      status: "unverifiable",
      revision: claim,
      verified: false,
      reason:
        "no git context: the claimed revision cannot be checked against a tree. " +
        "Expected inside the Docker build and for CI tarball builds; " +
        "on a host checkout it means the preflight is not actually guarding anything.",
    };
  }

  if (claim) {
    if (!revisionsMatch(claim, sha)) {
      return {
        ok: false,
        status: "mismatch",
        revision: sha,
        verified: false,
        reason:
          `${CLAIM_ENV}=${claim} does not match git HEAD ${sha}. ` +
          "This is the stale-shell-export failure mode: the image would ship a " +
          "revision label that does not describe its own source.",
      };
    }
    if (dirty) {
      return {
        ok: false,
        status: "dirty",
        revision: sha,
        verified: false,
        reason:
          `working tree is dirty, so it is not ${sha}. ` +
          `A dirty tree cannot honestly claim a clean SHA. Changed: ${describeDirty(dirtyPaths)}`,
      };
    }
    return {
      ok: true,
      status: "verified",
      revision: sha,
      verified: true,
      reason: `${CLAIM_ENV} matches git HEAD ${sha} and the working tree is clean.`,
    };
  }

  if (dirty) {
    return {
      ok: true,
      status: "dirty-unclaimed",
      revision: `${sha}-dirty`,
      verified: false,
      reason:
        `no ${CLAIM_ENV} claim and the working tree is dirty; the derived revision ` +
        `is marked ${sha}-dirty rather than claiming a clean SHA. Changed: ${describeDirty(dirtyPaths)}`,
    };
  }

  return {
    ok: true,
    status: "derived",
    revision: sha,
    verified: true,
    reason: `no ${CLAIM_ENV} claim; revision derived from clean git HEAD ${sha}.`,
  };
}

/** Reads HEAD and dirtiness. Returns `{gitAvailable:false}` outside a repo. */
export function readGitContext({ cwd = packageRoot, exec = execFileSync } = {}) {
  let head = "";
  try {
    head = String(
      exec("git", ["rev-parse", "HEAD"], {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).trim();
  } catch {
    return { gitAvailable: false, head: "", dirty: false, dirtyPaths: [] };
  }
  if (!head) return { gitAvailable: false, head: "", dirty: false, dirtyPaths: [] };

  let dirtyPaths = [];
  try {
    const status = String(
      exec("git", ["status", "--porcelain", "--untracked-files=normal"], {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    dirtyPaths = status
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  } catch {
    // HEAD resolved but status did not: treat as dirty rather than assume clean.
    return { gitAvailable: true, head, dirty: true, dirtyPaths: ["<git status unavailable>"] };
  }

  return { gitAvailable: true, head, dirty: dirtyPaths.length > 0, dirtyPaths };
}

export function isOptOutEnabled(env = process.env) {
  const raw = String(env[OPT_OUT_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** Resolves git + env and returns the verdict. */
export function runPreflight({ env = process.env, cwd = packageRoot, git } = {}) {
  const context = git ?? readGitContext({ cwd });
  return evaluateBuildRevision({
    claimed: env[CLAIM_ENV],
    head: context.head,
    dirty: context.dirty,
    dirtyPaths: context.dirtyPaths,
    gitAvailable: context.gitAvailable,
    allowUnverified: isOptOutEnabled(env),
  });
}

const RULE = "=".repeat(74);

/** Human-facing report. Loud for `override`, loud for failures. */
export function formatReport(result) {
  const lines = [];
  if (result.status === "override") {
    lines.push(
      RULE,
      "  !!  BUILD REVISION PREFLIGHT OVERRIDDEN  !!",
      `  ${OPT_OUT_ENV}=1 is set.`,
      `  ${result.suppressed?.status ?? "check"}: ${result.suppressed?.reason ?? ""}`,
      "  This image's provenance is NOT verified against its source tree.",
      "  Do not ship it to production or cite its revision as evidence.",
      `  ${ISSUE_URL}`,
      RULE,
    );
    return lines.join("\n");
  }
  if (!result.ok) {
    lines.push(
      RULE,
      "  BUILD REVISION PREFLIGHT FAILED",
      `  status: ${result.status}`,
      `  ${result.reason}`,
      "",
      `  Fix the claim (unset ${CLAIM_ENV}, or set it to $(git rev-parse HEAD)),`,
      "  commit/stash the working tree, or — for a local dev build only —",
      `  re-run with ${OPT_OUT_ENV}=1 to build unverified.`,
      `  ${ISSUE_URL}`,
      RULE,
    );
    return lines.join("\n");
  }
  if (result.status === "unverifiable" || result.status === "dirty-unclaimed") {
    return `build revision preflight: WARNING (${result.status}) — ${result.reason}`;
  }
  return `build revision preflight: ok (${result.status}) revision=${sanitizeRevisionForLog(result.revision)}`;
}

function parseArgs(argv) {
  const args = {
    json: false,
    quiet: false,
    printRevision: false,
    dockerBuild: false,
    passthrough: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--quiet") args.quiet = true;
    else if (arg === "--print-revision") args.printRevision = true;
    else if (arg === "--docker-build") args.dockerBuild = true;
    else if (arg === "--") {
      args.passthrough.push(...argv.slice(i + 1));
      break;
    } else if (arg === "--help" || arg === "-h") args.help = true;
    else args.unknown = arg;
  }
  return args;
}

const USAGE = `Usage: node scripts/check-build-revision.mjs [options]

  (no options)       verify ${CLAIM_ENV} against git HEAD; non-zero on mismatch
  --json             emit the verdict as JSON on stdout
  --print-revision   print the resolved revision on stdout
  --docker-build     run the preflight, then \`docker compose build\` with the
                     verified revision (extra args after \`--\` are forwarded)
  --quiet            suppress the human-readable report on success
  --help             this text

Environment:
  ${CLAIM_ENV}                the claimed revision (optional; verified if set)
  ${CREATED_ENV}                 RFC3339 build timestamp (--docker-build fills it in)
  ${OPT_OUT_ENV}   set to 1 to build unverified (LOUD)
`;

/** RFC3339/UTC, second precision — the form the compose docs use. */
export function utcTimestamp(now = new Date()) {
  return `${now.toISOString().slice(0, 19)}Z`;
}

function dockerBuild(result, passthrough, env) {
  if (!result.revision) {
    console.error(
      "build revision preflight: cannot run docker compose build without a resolvable revision " +
        `(status=${result.status}). Set ${CLAIM_ENV} or build from a git checkout.`,
    );
    return 1;
  }
  // Not merely a logging concern: this value becomes the image label. Under
  // `override` a suppressed `malformed` verdict can still carry a non-SHA
  // revision this far, and shipping that as provenance is the very thing #1766
  // exists to stop.
  if (sanitizeRevisionForLog(result.revision) !== result.revision) {
    console.error(
      "build revision preflight: refusing to build with a revision that is not a git SHA " +
        `(status=${result.status}).`,
    );
    return 1;
  }
  const childEnv = {
    ...env,
    [CLAIM_ENV]: result.revision,
    [CREATED_ENV]: env[CREATED_ENV] || utcTimestamp(),
    [VERIFIED_ENV]: result.verified ? "true" : "false",
  };
  const argv = ["compose", "build", ...passthrough];
  console.error(
    `build revision preflight: docker ${argv.join(" ")} ` +
      `(${CLAIM_ENV}=${sanitizeRevisionForLog(childEnv[CLAIM_ENV])}, ` +
      `${VERIFIED_ENV}=${result.verified ? "true" : "false"})`,
  );
  const child = spawnSync("docker", argv, { cwd: packageRoot, stdio: "inherit", env: childEnv });
  if (child.error) {
    console.error(`build revision preflight: failed to run docker: ${child.error.message}`);
    return 1;
  }
  return child.status ?? 1;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.unknown) {
    console.error(`build revision preflight: unknown argument ${args.unknown}`);
    process.stdout.write(USAGE);
    return 2;
  }

  const result = runPreflight({ env });

  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (args.printRevision) process.stdout.write(`${sanitizeRevisionForLog(result.revision)}\n`);
  // --quiet only silences the boring success lines; failures, the override
  // banner, and the two warning statuses always reach stderr.
  const boring = result.ok && (result.status === "verified" || result.status === "derived");
  if (!args.quiet || !boring) console.error(formatReport(result));
  if (!result.ok) return 1;
  if (args.dockerBuild) return dockerBuild(result, args.passthrough, env);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
