import { constants } from "node:fs";
import { access, mkdir, readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import type { RunnerConfig, RunnerEngine } from "./types.js";
import { DEFAULT_PROFILE_MOUNT_PATH, validateOpenClawProfileReadiness } from "./openclaw-profile-readiness.js";
import type { OpenClawProfileReadinessInput } from "./openclaw-profile-readiness.js";

export type OpsStatus = "ok" | "warn" | "fail" | "skip";

export interface OpsCheck {
  status: OpsStatus;
  message: string;
  detail?: Record<string, unknown>;
}

export interface DoctorReport {
  ok: boolean;
  engine: RunnerEngine;
  runnerRevision: OpsCheck;
  docker: OpsCheck;
  podman: OpsCheck;
  taskRoot: OpsCheck;
  secretMount: OpsCheck;
  extraMounts: OpsCheck;
  /** #1809 preflight: secret-mount readability under the container user + cap-drop contract. */
  secretMountReadability: OpsCheck;
  baseImage: OpsCheck;
  githubPatch: OpsCheck;
  /** Deploy-marker validation: checks whether the deployed revision matches an expected deploy marker. */
  deployMarker?: OpsCheck;
}

export interface InstallReport {
  ok: boolean;
  created: string[];
  taskRoot: OpsCheck;
  secretMount: OpsCheck;
}

export interface CleanupOptions {
  rootDir: string;
  ttlMs: number;
  dryRun?: boolean;
  nowMs?: number;
}

export interface CleanupReport {
  ok: boolean;
  dryRun: boolean;
  rootDir: string;
  ttlMs: number;
  removed: string[];
  candidates: string[];
  skipped: string[];
}

export interface GitHubPatchReadinessOptions {
  engine?: RunnerEngine;
  openclawProfileProbe?: (config: RunnerConfig, engine: RunnerEngine) => OpenClawProfileReadinessInput;
  hermesProfileProbe?: (config: RunnerConfig, engine: RunnerEngine) => HermesProfileReadinessInput;
  claudeCodeProfileProbe?: (config: RunnerConfig, engine: RunnerEngine) => ClaudeCodeProfileReadinessInput;
  codexProfileProbe?: (config: RunnerConfig, engine: RunnerEngine) => CodexProfileReadinessInput;
}

interface HermesProfileReadinessInput {
  cliOnPath: boolean;
  cliPath?: string;
  cliVersionOk: boolean;
  cliVersion?: string;
  profileMountExists: boolean;
  expectedMountPath: string;
  configFiles: string[];
  errors: string[];
}

interface ClaudeCodeProfileReadinessInput {
  cliOnPath: boolean;
  cliPath?: string;
  cliVersionOk: boolean;
  cliVersion?: string;
  profileMountExists: boolean;
  expectedMountPath: string;
  bridgeExists: boolean;
  bridgePath: string;
  errors: string[];
}

interface CodexProfileReadinessInput {
  cliOnPath: boolean;
  cliPath?: string;
  cliVersionOk: boolean;
  cliVersion?: string;
  profileMountExists: boolean;
  expectedMountPath: string;
  authFileExists: boolean;
  errors: string[];
}

/**
 * Clean up expired run-token directories under Round 3 nested task roots.
 *
 * Round 3 structure: <rootDir>/<safeTaskId>/<runToken>/...
 * - Each runToken directory contains task.json, run.json, artifacts/, etc.
 * - A run is expired when its age >= ttlMs (preferring run.json.createdAt over mtime).
 * - Individual expired run dirs are removed even when sibling runs are still active.
 * - A task root (safeTaskId) is only removed when all its run dirs have been
 *   removed and no other entries remain.
 * - Non-directory entries at any level are skipped.
 * - Malformed/missing-root conditions are handled gracefully.
 *
 * The function never performs destructive cleanup on paths outside rootDir.
 */
export async function cleanup(options: CleanupOptions): Promise<CleanupReport> {
  const rootDir = resolve(options.rootDir);
  const nowMs = options.nowMs ?? Date.now();
  const dryRun = options.dryRun ?? false;
  const removed: string[] = [];
  const candidates: string[] = [];
  const skipped: string[] = [];

  let taskRoots: string[];
  try {
    taskRoots = await readdir(rootDir);
  } catch {
    return { ok: true, dryRun, rootDir, ttlMs: options.ttlMs, removed, candidates, skipped };
  }

  for (const entry of taskRoots) {
    const taskRoot = join(rootDir, entry);
    const taskRootInfo = await stat(taskRoot).catch(() => undefined);
    if (!taskRootInfo?.isDirectory()) {
      skipped.push(taskRoot);
      continue;
    }

    const { expiredDirs, recentDirs, skippedDirs } = await evaluateTaskRoot(
      taskRoot,
      options.ttlMs,
      nowMs,
    );

    // Report non-run entries (including malformed) as skipped
    for (const skippedDir of skippedDirs) {
      skipped.push(skippedDir);
    }

    // Recent runs are always skipped
    for (const recent of recentDirs) {
      skipped.push(recent);
    }

    // Expired run dirs are candidates for removal
    for (const expired of expiredDirs) {
      candidates.push(expired);
      if (!dryRun) {
        await rm(expired, { recursive: true, force: true });
        removed.push(expired);
      }
    }

    // After removing expired runs, check if task root is empty and can be pruned.
    // Only prune if there were no recent/skipped entries (task root has no
    // active content).
    if (expiredDirs.length > 0 && recentDirs.length === 0 && skippedDirs.length === 0) {
      // In dry-run mode the expired dirs still exist on disk, so we check
      // whether all remaining entries are exactly the expired run dirs.
      if (dryRun) {
        const remaining = await readdir(taskRoot).catch(() => [] as string[]);
        const expiredNames = new Set(expiredDirs.map((d) => d.split("/").pop()!));
        if (remaining.length > 0 && remaining.every((name) => expiredNames.has(name))) {
          candidates.push(taskRoot);
        }
      } else {
        const remaining = await readdir(taskRoot).catch(() => [] as string[]);
        if (remaining.length === 0) {
          candidates.push(taskRoot);
          // Non-recursive rmdir: if a run dir is created concurrently between
          // the readdir check and removal, this fails with ENOTEMPTY instead
          // of recursively deleting the freshly-started run.
          try {
            await rmdir(taskRoot);
            removed.push(taskRoot);
          } catch {
            // A concurrent run repopulated the task root; leave it in place.
          }
        }
      }
    }
  }

  return { ok: true, dryRun, rootDir, ttlMs: options.ttlMs, removed, candidates, skipped };
}

/**
 * Evaluate run-token directories inside a single task root.
 *
 * Returns three lists:
 * - expiredDirs: run dirs whose age >= ttlMs
 * - recentDirs: run dirs whose age < ttlMs
 * - skippedDirs: non-directory entries or malformed entries inside the task root
 */
async function evaluateTaskRoot(
  taskRoot: string,
  ttlMs: number,
  nowMs: number,
): Promise<{
  expiredDirs: string[];
  recentDirs: string[];
  skippedDirs: string[];
}> {
  const expiredDirs: string[] = [];
  const recentDirs: string[] = [];
  const skippedDirs: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(taskRoot);
  } catch {
    return { expiredDirs, recentDirs, skippedDirs };
  }

  for (const entry of entries) {
    const runDir = join(taskRoot, entry);
    const info = await stat(runDir).catch(() => undefined);
    if (!info?.isDirectory()) {
      skippedDirs.push(runDir);
      continue;
    }

    // Prefer run.json.createdAt for age calculation; fall back to mtime.
    const ageMs = await runAgeMs(runDir, nowMs, info.mtimeMs);
    if (ageMs < ttlMs) {
      recentDirs.push(runDir);
    } else {
      expiredDirs.push(runDir);
    }
  }

  return { expiredDirs, recentDirs, skippedDirs };
}

/**
 * Calculate the age of a run directory in milliseconds.
 *
 * Prefers the `createdAt` field from run.json (ISO timestamp) when available.
 * Falls back to directory mtimeMs when run.json is missing or unreadable.
 */
async function runAgeMs(runDir: string, nowMs: number, mtimeMsFallback: number): Promise<number> {
  try {
    const runJsonPath = join(runDir, "run.json");
    const content = await readFile(runJsonPath, "utf8");
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.createdAt === "string") {
      const createdAtMs = new Date(parsed.createdAt).getTime();
      if (!isNaN(createdAtMs)) {
        return nowMs - createdAtMs;
      }
    }
  } catch {
    // fall through to mtime fallback
  }
  return nowMs - mtimeMsFallback;
}

export async function doctor(config: RunnerConfig): Promise<DoctorReport> {
  const runnerRevision = await checkDeployedRevision();
  const docker = checkEngine("docker");
  const podman = checkEngine("podman");
  const configuredEngine = config.engine;
  const engine = configuredEngine && (configuredEngine === "docker" ? docker : podman).status === "ok"
    ? configuredEngine
    : docker.status === "ok"
      ? "docker"
      : "podman";
  const taskRoot = await checkTaskRoot(config.rootDir);
  const secretMount = await checkSecretMount(config.githubTokenFile);
  const extraMounts = await checkExtraMounts(config);
  const secretMountReadability = await checkSecretMountContainerReadability(config);
  const baseImage = (engine === "docker" ? docker : podman).status === "ok"
    ? checkBaseImage(engine, config.image)
    : { status: "fail" as const, message: "no container engine available for base image check", detail: { image: config.image } };
  const githubPatch = checkGitHubPatchReadiness(config, { engine });
  const engineReady = docker.status === "ok" || podman.status === "ok";
  const checks = [runnerRevision, taskRoot, secretMount, extraMounts, secretMountReadability, baseImage, githubPatch];

  // Deploy-marker is optional: only checked when buildMetadata.revision is provided.
  let deployMarker: OpsCheck | undefined;
  if (config.buildMetadata?.revision) {
    deployMarker = await checkDeployMarker(config.buildMetadata.revision);
    checks.push(deployMarker);
  }

  return {
    ok: engineReady && checks.every((check) => check.status !== "fail"),
    engine,
    runnerRevision,
    docker,
    podman,
    taskRoot,
    secretMount,
    extraMounts,
    secretMountReadability,
    baseImage,
    githubPatch,
    ...(deployMarker ? { deployMarker } : {}),
  };
}

export async function checkDeployedRevision(cwd = process.cwd(), upstreamRef = "origin/main"): Promise<OpsCheck> {
  const version = await readPackageVersion(cwd);
  const insideWorkTree = git(cwd, ["rev-parse", "--is-inside-work-tree"]);

  if (insideWorkTree.status !== 0 || insideWorkTree.stdout.trim() !== "true") {
    return {
      status: version ? "warn" : "fail",
      message: version
        ? "runner version is available but deployed git revision is not inspectable"
        : "runner deployed revision is not inspectable",
      detail: compactRevisionDetail({ version, summaryStatus: version ? "WARN" : "FAIL", reason: "not a git checkout" }),
    };
  }

  const fullLocalSha = normalizeSha(git(cwd, ["rev-parse", "HEAD"]).stdout.trim());
  const localSha = fullLocalSha?.slice(0, 12);
  const branch = git(cwd, ["branch", "--show-current"]).stdout.trim() || "detached";

  // Compute dirty flag, but exclude .deploy-source-sha as an expected
  // deployment marker — it records the deployed SHA and should not trigger
  // a misleading dirty-worktree warning.
  const porcelainAll = git(cwd, ["status", "--porcelain"]).stdout;
  const porcelainLines = porcelainAll.split("\n").filter((l) => l.trim().length > 0);
  const realChanges = porcelainLines.filter((l) => !l.includes(".deploy-source-sha"));
  const dirty = realChanges.length > 0;

  // Detect .deploy-source-sha as a deployment marker.
  const deploySourceShaStatus = porcelainLines.find((l) => l.includes(".deploy-source-sha"));
  const deploymentMarker = deploySourceShaStatus !== undefined;

  const upstreamSha = await resolveUpstreamMainSha(cwd, upstreamRef);

  const reasons: string[] = [];
  if (!localSha) reasons.push("local SHA unavailable");
  if (dirty) reasons.push("dirty worktree");
  if (branch !== "main") reasons.push(`branch is ${branch}`);
  if (upstreamSha && fullLocalSha && upstreamSha.full !== fullLocalSha) reasons.push("local revision differs from upstream main");
  if (!upstreamSha) reasons.push("upstream main unavailable");

  const status: OpsStatus = !localSha ? "fail" : reasons.length ? "warn" : "ok";
  const summaryStatus = status === "ok" ? "PASS" : status === "warn" ? "WARN" : "FAIL";

  return {
    status,
    message: status === "ok"
      ? "runner deployed revision matches upstream main"
      : "runner deployed revision needs operator review",
    detail: compactRevisionDetail({
      version,
      localSha,
      localFullSha: fullLocalSha,
      upstreamMainSha: upstreamSha?.short,
      upstreamMainFullSha: upstreamSha?.full,
      branch,
      dirty,
      deploymentMarker,
      summaryStatus,
      reason: reasons.join("; ") || undefined,
    }),
  };
}

/**
 * Check whether the deployed revision matches an expected deploy marker.
 *
 * A deploy marker is a specific git revision (full or short SHA) that a rollout
 * target should be running after a deploy. This check validates that the local
 * checkout is on the expected revision, which is useful for pre-rollout doctor
 * verification and refresh safety evidence.
 *
 * When the checkout is not a git worktree or the local SHA cannot be determined,
 * the check fails closed (status "fail") because the deploy marker cannot be
 * verified.
 */
export async function checkDeployMarker(
  expectedRevision: string,
  cwd = process.cwd(),
): Promise<OpsCheck> {
  const version = await readPackageVersion(cwd);
  const insideWorkTree = git(cwd, ["rev-parse", "--is-inside-work-tree"]);

  if (insideWorkTree.status !== 0 || insideWorkTree.stdout.trim() !== "true") {
    return {
      status: "fail",
      message: "deploy marker not inspectable: not a git checkout",
      detail: {
        expectedRevision,
        version,
        summary: `FAIL runner=${version ? `v${version}` : "unknown"} expected=${expectedRevision}`,
        reason: "not a git checkout",
      },
    };
  }

  const fullLocalSha = normalizeSha(git(cwd, ["rev-parse", "HEAD"]).stdout.trim());
  const localSha = fullLocalSha?.slice(0, 12);
  const branch = git(cwd, ["branch", "--show-current"]).stdout.trim() || "detached";
  const dirty = git(cwd, ["status", "--porcelain"]).stdout.trim().length > 0;

  if (!fullLocalSha) {
    return {
      status: "fail",
      message: "deploy marker not inspectable: local SHA unavailable",
      detail: {
        expectedRevision,
        version,
        branch,
        dirty,
        summary: `FAIL runner=${version ? `v${version}` : "unknown"} expected=${expectedRevision}`,
        reason: "local SHA unavailable",
      },
    };
  }

  // Accept an exact match or any abbreviated-SHA prefix (git --short defaults
  // to 7 chars, so a strict 12-char comparison rejected valid 7-char markers).
  const marker = expectedRevision.toLowerCase();
  const markerIsShaPrefix = /^[0-9a-f]{7,40}$/.test(marker);
  const matches = fullLocalSha === marker || (markerIsShaPrefix && fullLocalSha.startsWith(marker));

  const status: OpsStatus = matches ? "ok" : "fail";
  const summaryStatus = status === "ok" ? "PASS" : "FAIL";

  return {
    status,
    message: matches
      ? "deployed revision matches deploy marker"
      : "deployed revision does not match deploy marker",
    detail: {
      version,
      localSha,
      localFullSha: fullLocalSha,
      expectedRevision,
      expectedRevisionShort: marker.slice(0, 12),
      branch,
      dirty,
      summary: `${summaryStatus} runner=${version ? `v${version}` : "unknown"} local=${localSha ?? "unknown"} expected=${marker.slice(0, 12)}`,
      ...(matches ? {} : { reason: "local revision is different from deploy marker" }),
    },
  };
}

export async function install(config: RunnerConfig): Promise<InstallReport> {
  const created: string[] = [];
  const root = resolve(config.rootDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  created.push(root);
  const taskRoot = await checkTaskRoot(root);
  const secretMount = await checkSecretMount(config.githubTokenFile);
  return { ok: taskRoot.status !== "fail" && secretMount.status !== "fail", created, taskRoot, secretMount };
}

function checkEngine(engine: RunnerEngine): OpsCheck {
  const version = spawnSync(engine, ["--version"], { encoding: "utf8" });
  if (version.status !== 0) return { status: "fail", message: `${engine} is not available` };
  return { status: "ok", message: `${engine} is available`, detail: { version: version.stdout.trim() } };
}

async function checkTaskRoot(rootDir: string): Promise<OpsCheck> {
  const root = resolve(rootDir);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await access(root, constants.R_OK | constants.W_OK | constants.X_OK);
    const info = await stat(root);
    return { status: "ok", message: "task root is accessible", detail: { path: root, mode: `0${(info.mode & 0o777).toString(8)}` } };
  } catch (error) {
    return { status: "fail", message: "task root is not accessible", detail: { path: root, error: errorMessage(error) } };
  }
}

async function checkSecretMount(githubTokenFile?: string): Promise<OpsCheck> {
  if (!githubTokenFile) return { status: "skip", message: "no secret file configured" };
  const path = resolve(githubTokenFile);
  try {
    await access(path, constants.R_OK);
    const info = await stat(path);
    const writableByGroupOrOther = (info.mode & 0o022) !== 0;
    if (writableByGroupOrOther) {
      return { status: "warn", message: "secret file is readable but permissions are broader than recommended", detail: { path, mode: `0${(info.mode & 0o777).toString(8)}`, mount: ":ro" } };
    }
    return { status: "ok", message: "secret file is readable and will be mounted read-only", detail: { path, mode: `0${(info.mode & 0o777).toString(8)}`, mount: ":ro" } };
  } catch (error) {
    return { status: "fail", message: "configured secret file is not readable", detail: { path, error: errorMessage(error) } };
  }
}

// #1809: `--cap-drop ALL` (or DAC_OVERRIDE) removes CAP_DAC_OVERRIDE, so the
// container user cannot bypass permission bits even as root. A secret mount
// owned by a different uid without group/others read is therefore unreadable
// inside the container — the fleet trap that surfaced as misleading
// `piri_config_mount_missing` / `start_comment_failed` errors (#1802).
const DAC_SENSITIVE_CAP_DROPS = new Set(["all", "dac_override", "dac_read_search"]);

export function dropsDacOverride(capDrop?: string[]): boolean {
  return (capDrop ?? []).some((entry) => DAC_SENSITIVE_CAP_DROPS.has(entry.trim().toLowerCase().replace(/^cap_/, "")));
}

/** Resolve `--user` (uid[:gid]) to numbers. "root" maps to 0. Undefined when unresolvable. */
export function parseContainerUserRef(user?: string): { uid: number; gid?: number } | undefined {
  const raw = user?.trim();
  if (!raw) return undefined;
  if (raw === "root") return { uid: 0 };
  const [uidPart, gidPart] = raw.split(":");
  const uid = Number(uidPart);
  if (!Number.isSafeInteger(uid) || uid < 0) return undefined;
  if (gidPart === undefined) return { uid };
  const gid = Number(gidPart);
  if (!Number.isSafeInteger(gid) || gid < 0) return undefined;
  return { uid, gid };
}

function pathReadabilityForContainerUser(
  info: { mode: number; uid: number; gid: number },
  container: { uid: number; gid?: number },
  isDirectory: boolean,
): { readable: boolean; via: "owner" | "group" | "others" | "none" } {
  const ownerRead = (info.mode & 0o400) !== 0;
  const groupRead = (info.mode & 0o040) !== 0;
  const othersRead = (info.mode & 0o004) !== 0;
  const ownerExec = (info.mode & 0o100) !== 0;
  const groupExec = (info.mode & 0o010) !== 0;
  const othersExec = (info.mode & 0o001) !== 0;
  const needsExec = isDirectory;
  if (container.uid === info.uid) {
    return { readable: ownerRead && (!needsExec || ownerExec), via: "owner" };
  }
  if (container.gid !== undefined && container.gid === info.gid) {
    return { readable: groupRead && (!needsExec || groupExec), via: "group" };
  }
  return { readable: othersRead && (!needsExec || othersExec), via: "others" };
}

export interface SecretMountReadabilityEntry {
  source: string;
  target?: string;
  kind: "github_token" | "profile_mount";
  type: "file" | "directory";
  ownerUid: number;
  ownerGid: number;
  mode: string;
  readable: boolean;
  via: "owner" | "group" | "others" | "none";
}

const SECRET_MOUNT_READABILITY_SCAN_ENTRY_LIMIT = 64;

/**
 * Preflight (#1809): under a DAC_OVERRIDE-dropping cap-drop, verify every
 * profile secret-mount source (and, for directories, their direct children)
 * is readable by the configured container user BEFORE a task fails inside the
 * container with an unrelated-looking error. Keep `--cap-drop ALL`; the fix is
 * ownership alignment (e.g. `A2A_DOCKER_RUNNER_USER=1000:1000` matching a
 * uid1000-owned profile dir), not capability relaxation.
 */
export async function checkSecretMountContainerReadability(config: RunnerConfig): Promise<OpsCheck> {
  const sources: Array<{ source: string; target?: string; kind: "github_token" | "profile_mount" }> = [];
  if (config.githubTokenFile) {
    sources.push({ source: config.githubTokenFile, target: "/run/secrets/gh-hosts.yml", kind: "github_token" });
  }
  for (const mount of config.extraMounts ?? []) {
    sources.push({ source: mount.source, target: mount.target, kind: "profile_mount" });
  }

  if (sources.length === 0) {
    return { status: "skip", message: "no secret mounts configured", detail: { reason: "no_github_token_or_extra_mounts" } };
  }
  if (!dropsDacOverride(config.capDrop)) {
    return {
      status: "skip",
      message: "cap-drop keeps CAP_DAC_OVERRIDE; secret-mount owner mismatch is not fatal",
      detail: { capDrop: config.capDrop ?? [] },
    };
  }

  // Runner images have no USER directive, so an unset --user runs as root (uid 0).
  const userRef = parseContainerUserRef(config.user);
  const containerUser = userRef ?? { uid: 0 };
  const detail: Record<string, unknown> = {
    containerUser: config.user ?? "root (image default; --user not set)",
    containerUid: containerUser.uid,
    ...(containerUser.gid !== undefined ? { containerGid: containerUser.gid } : {}),
    capDrop: config.capDrop ?? [],
  };
  if (!userRef) detail.userAssumed = true;
  if (!/^[0-9]+(:[0-9]+)?$|^root$/.test(config.user?.trim() ?? "")) {
    return {
      status: "warn",
      message: "container user is not a numeric uid[:gid]; cannot statically verify secret-mount readability",
      detail: { ...detail, remediation: "set A2A_DOCKER_RUNNER_USER to an explicit uid[:gid] (for example 1000:1000) so doctor can verify mounts" },
    };
  }

  const entries: SecretMountReadabilityEntry[] = [];
  const problems: string[] = [];
  const statErrors: string[] = [];

  const inspect = async (absolute: string, target: string | undefined, kind: "github_token" | "profile_mount") => {
    const info = await stat(absolute).catch((error: unknown) => {
      statErrors.push(`${absolute}: ${errorMessage(error)}`);
      return null;
    });
    if (!info) return;
    const isDirectory = info.isDirectory();
    const verdict = pathReadabilityForContainerUser(
      { mode: info.mode, uid: info.uid, gid: info.gid },
      containerUser,
      isDirectory,
    );
    entries.push({
      source: absolute,
      ...(target ? { target } : {}),
      kind,
      type: isDirectory ? "directory" : "file",
      ownerUid: info.uid,
      ownerGid: info.gid,
      mode: `0${(info.mode & 0o777).toString(8)}`,
      readable: verdict.readable,
      via: verdict.via,
    });
    if (!verdict.readable) {
      problems.push(`${absolute} (owner ${info.uid}:${info.gid}, mode 0${(info.mode & 0o777).toString(8)}) is unreadable by container user ${config.user?.trim() || "root(assumed)"}`);
    }
    if (isDirectory) {
      const children = await readdir(absolute).catch(() => [] as string[]);
      for (const child of children.slice(0, SECRET_MOUNT_READABILITY_SCAN_ENTRY_LIMIT)) {
        await inspect(join(absolute, child), undefined, kind);
      }
    }
  };

  for (const source of sources) {
    await inspect(resolve(source.source), source.target, source.kind);
  }

  detail.entries = entries;
  if (statErrors.length > 0) {
    detail.statErrors = statErrors;
    return { status: "fail", message: "secret mount source cannot be inspected", detail };
  }
  if (problems.length > 0) {
    detail.unreadable = problems;
    detail.remediation = "align ownership: set A2A_DOCKER_RUNNER_USER to the secret owner (e.g. 1000:1000) or grant group/others read; keep --cap-drop ALL (#1809)";
    return {
      status: "fail",
      message: `secret mounts unreadable by the container user under cap-drop (${problems.length} path${problems.length === 1 ? "" : "s"})`,
      detail,
    };
  }
  return { status: "ok", message: "secret mounts are readable by the container user under the configured cap-drop", detail };
}

export async function checkExtraMounts(config: RunnerConfig): Promise<OpsCheck> {
  const mounts = config.extraMounts ?? [];
  if (!mounts.length) return { status: "skip", message: "no extra mounts configured" };

  const checked: Array<Record<string, unknown>> = [];
  for (const mount of mounts) {
    const source = resolve(mount.source);
    try {
      await access(source, constants.R_OK);
      const info = await stat(source);
      checked.push({
        source,
        target: mount.target,
        readOnly: mount.readOnly !== false,
        mode: `0${(info.mode & 0o777).toString(8)}`,
        type: info.isDirectory() ? "directory" : "file",
      });
    } catch (error) {
      return {
        status: "fail",
        message: "configured extra mount is not readable",
        detail: { source, target: mount.target, error: errorMessage(error) },
      };
    }
  }

  return { status: "ok", message: "extra mounts are readable", detail: { mounts: checked } };
}

export function checkGitHubPatchReadiness(config: RunnerConfig, options: GitHubPatchReadinessOptions = {}): OpsCheck {
  if (config.commandProfile === "openclaw") {
    return checkOpenClawProfilePatchReadiness(config, options);
  }
  if (config.commandProfile === "hermes") {
    return checkHermesProfilePatchReadiness(config, options);
  }
  if (config.commandProfile === "claude-code") {
    return checkClaudeCodeProfilePatchReadiness(config, options);
  }
  if (config.commandProfile === "codex") {
    return checkCodexProfilePatchReadiness(config, options);
  }

  if (config.commandScript) {
    return {
      status: "ok",
      message: "GitHub patch execution is ready via commandScript",
      detail: { path: "/work/patch-command.sh", safe: true, eval: false },
    };
  }

  if (config.commandJson) {
    try {
      const parsed = JSON.parse(config.commandJson) as { argv?: unknown };
      if (!Array.isArray(parsed.argv) || parsed.argv.length === 0 || !parsed.argv.every((arg) => typeof arg === "string")) {
        return {
          status: "fail",
          message: "GitHub patch commandJson must contain a non-empty string argv array",
          detail: { env: "A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON", safe: false },
        };
      }
      return {
        status: "ok",
        message: "GitHub patch execution is ready via commandJson",
        detail: { path: "/work/patch-command.sh", safe: true, eval: false, argvCount: parsed.argv.length },
      };
    } catch (error) {
      return {
        status: "fail",
        message: "GitHub patch commandJson is not valid JSON",
        detail: { env: "A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON", error: errorMessage(error) },
      };
    }
  }

  if (config.commandTemplate) {
    return {
      status: "fail",
      message: "GitHub patch execution blocks legacy commandTemplate eval path; use OpenClaw, Hermes, or Codex via commandScript or commandJson",
      detail: { env: "A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE", safe: false, eval: true, allowedExecutors: ["openclaw", "hermes", "codex"] },
    };
  }

  return {
    status: "fail",
    message: "GitHub patch execution is blocked: no patch command configured",
    detail: {
      missing: ["A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT", "A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON"],
      fallback: "missing command yields Block evidence; it must not be reported as Done",
    },
  };
}

function checkHermesProfilePatchReadiness(config: RunnerConfig, options: GitHubPatchReadinessOptions): OpsCheck {
  if (!config.commandScript) {
    return {
      status: "fail",
      message: "GitHub patch execution is blocked: Hermes profile selected without a generated commandScript",
      detail: { profile: "hermes", safe: false, eval: false },
    };
  }

  const engine = options.engine ?? config.engine ?? "docker";
  const probeInput = options.hermesProfileProbe
    ? options.hermesProfileProbe(config, engine)
    : probeHermesProfileInContainer(config, engine);
  const checks = [
    { kind: "hermes_cli_resolved", passed: probeInput.cliOnPath && Boolean(probeInput.cliPath) },
    { kind: "hermes_cli_version_ok", passed: probeInput.cliVersionOk && Boolean(probeInput.cliVersion) },
    { kind: "hermes_profile_mount_present", passed: probeInput.profileMountExists },
  ];
  const failureCategory = classifyHermesProfileFailure(probeInput);
  const detail: Record<string, unknown> = {
    path: "/work/patch-command.sh",
    profile: "hermes",
    safe: true,
    eval: false,
    containedSubagents: describeContainedSubagents(config),
    failureCategory,
    summary: buildHermesProfileSummary(probeInput, failureCategory),
    checks,
    configFiles: probeInput.configFiles,
  };

  if (failureCategory === "ok") {
    return {
      status: "ok",
      message: "GitHub patch execution is ready via Hermes profile",
      detail,
    };
  }

  detail.provisioningPaths = [
    "preferred: pre-bake Hermes Agent into the runner base image (docker/hermes-runner.Dockerfile)",
    "set A2A_DOCKER_RUNNER_HERMES_CONFIG_DIR and mount a host dir containing Hermes config/auth files",
    "use A2A_DOCKER_RUNNER_IMAGE=a2a-docker-runner-hermes:<runner-sha>",
  ];
  return {
    status: "fail",
    message: "GitHub patch execution is blocked: Hermes profile runtime is not ready",
    detail,
  };
}


function checkClaudeCodeProfilePatchReadiness(config: RunnerConfig, options: GitHubPatchReadinessOptions): OpsCheck {
  if (!config.commandScript) {
    return {
      status: "fail",
      message: "GitHub patch execution is blocked: Claude Code profile selected without a generated commandScript",
      detail: { profile: "claude-code", safe: false, eval: false },
    };
  }

  const engine = options.engine ?? config.engine ?? "docker";
  const probeInput = options.claudeCodeProfileProbe
    ? options.claudeCodeProfileProbe(config, engine)
    : probeClaudeCodeProfileInContainer(config, engine);
  const checks = [
    { kind: "claude_cli_resolved", passed: probeInput.cliOnPath && Boolean(probeInput.cliPath) },
    { kind: "claude_cli_version_ok", passed: probeInput.cliVersionOk && Boolean(probeInput.cliVersion) },
    { kind: "claude_profile_mount_present", passed: probeInput.profileMountExists },
    { kind: "claude_patch_bridge_present", passed: probeInput.bridgeExists },
  ];
  const failureCategory = classifyClaudeCodeProfileFailure(probeInput);
  const detail: Record<string, unknown> = {
    path: "/work/patch-command.sh",
    profile: "claude-code",
    safe: true,
    eval: false,
    containedSubagents: describeContainedSubagents(config),
    turnBudgets: config.claudeCodeProfile?.turnBudgets,
    failureCategory,
    summary: buildClaudeCodeProfileSummary(probeInput, failureCategory),
    checks,
    bridgePath: probeInput.bridgePath,
  };

  if (failureCategory === "ok") {
    return {
      status: "ok",
      message: "GitHub patch execution is ready via Claude Code profile",
      detail,
    };
  }

  detail.provisioningPaths = [
    "preferred: pre-bake Claude Code into the runner base image (docker/claude-code-runner.Dockerfile)",
    "set A2A_DOCKER_RUNNER_CLAUDE_CONFIG_DIR and mount a host dir containing minimal Claude Code auth/config files",
    "use A2A_DOCKER_RUNNER_IMAGE=a2a-docker-runner-cccb:<runner-sha>",
  ];
  return {
    status: "fail",
    message: "GitHub patch execution is blocked: Claude Code profile runtime is not ready",
    detail,
  };
}

function checkCodexProfilePatchReadiness(config: RunnerConfig, options: GitHubPatchReadinessOptions): OpsCheck {
  if (!config.commandScript) {
    return {
      status: "fail",
      message: "GitHub patch execution is blocked: Codex profile selected without a generated commandScript",
      detail: { profile: "codex", safe: false, eval: false },
    };
  }

  const engine = options.engine ?? config.engine ?? "docker";
  const probeInput = options.codexProfileProbe
    ? options.codexProfileProbe(config, engine)
    : probeCodexProfileInContainer(config, engine);
  const checks = [
    { kind: "codex_cli_resolved", passed: probeInput.cliOnPath && Boolean(probeInput.cliPath) },
    { kind: "codex_cli_version_ok", passed: probeInput.cliVersionOk && Boolean(probeInput.cliVersion) },
    { kind: "codex_profile_mount_present", passed: probeInput.profileMountExists },
    { kind: "codex_auth_file_present", passed: probeInput.authFileExists },
  ];
  const failureCategory = classifyCodexProfileFailure(probeInput);
  const detail: Record<string, unknown> = {
    path: "/work/patch-command.sh",
    profile: "codex",
    safe: true,
    eval: false,
    failureCategory,
    summary: buildCodexProfileSummary(probeInput, failureCategory),
    checks,
  };

  if (failureCategory === "ok") {
    return {
      status: "ok",
      message: "GitHub patch execution is ready via Codex profile",
      detail,
    };
  }

  detail.provisioningPaths = [
    "preferred: pre-bake Codex CLI into the runner base image (docker/codex-runner.Dockerfile)",
    "set A2A_DOCKER_RUNNER_CODEX_CONFIG_DIR and mount a minimal host dir containing auth.json",
    "use A2A_DOCKER_RUNNER_IMAGE=a2a-docker-runner-codex:<runner-sha>",
  ];
  return {
    status: "fail",
    message: "GitHub patch execution is blocked: Codex profile runtime is not ready",
    detail,
  };
}

function checkOpenClawProfilePatchReadiness(config: RunnerConfig, options: GitHubPatchReadinessOptions): OpsCheck {
  if (!config.commandScript) {
    return {
      status: "fail",
      message: "GitHub patch execution is blocked: OpenClaw profile selected without a generated commandScript",
      detail: { profile: "openclaw", safe: false, eval: false },
    };
  }

  const engine = options.engine ?? config.engine ?? "docker";
  const probeInput = options.openclawProfileProbe
    ? options.openclawProfileProbe(config, engine)
    : probeOpenClawProfileInContainer(config, engine);
  const outcome = validateOpenClawProfileReadiness(probeInput);
  const fallback = config.openclawProfile?.allowNpmInstallFallback === true;
  const detail: Record<string, unknown> = {
    path: "/work/patch-command.sh",
    profile: "openclaw",
    safe: true,
    eval: false,
    containedSubagents: describeContainedSubagents(config),
    fallback: fallback ? "explicit_npm_install" : "disabled",
    failureCategory: outcome.failureCategory,
    summary: outcome.summary,
    checks: outcome.checks.map((check) => ({ kind: check.kind, passed: check.passed })),
  };
  if (!outcome.ok && !fallback) {
    detail.provisioningPaths = [
      "preferred: pre-bake the OpenClaw CLI into the runner base image (e.g. RUN npm install -g openclaw)",
      "alternative: set A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR and mount a host dir containing openclaw.json + credentials",
      "escape-hatch: set A2A_OPENCLAW_ALLOW_NPM_INSTALL_FALLBACK=1 to allow per-task npm install (requires network)",
    ];
  }

  if (outcome.ok) {
    return {
      status: "ok",
      message: "GitHub patch execution is ready via OpenClaw profile",
      detail,
    };
  }

  if (fallback) {
    return {
      status: "warn",
      message: "OpenClaw profile probe failed, but explicit npm install fallback is enabled",
      detail,
    };
  }

  return {
    status: "fail",
    message: "GitHub patch execution is blocked: OpenClaw profile runtime is not ready",
    detail,
  };
}

function describeContainedSubagents(config: RunnerConfig): Record<string, unknown> {
  const policy = config.containedSubagents ?? {
    enabled: false,
    maxCount: 0,
    outputBytes: 12000,
    reasons: [],
    roles: [],
  };
  return {
    enabled: policy.enabled,
    maxCount: policy.maxCount,
    outputBytes: policy.outputBytes,
    reasons: policy.reasons,
    roles: policy.roles,
    boundary: "same Docker task workspace; helper evidence only; one final worker answer",
  };
}

function probeHermesProfileInContainer(config: RunnerConfig, engine: RunnerEngine): HermesProfileReadinessInput {
  const args = [
    "run",
    "--rm",
    "--network",
    config.network ?? "bridge",
    "--entrypoint",
    "sh",
  ];

  for (const mount of config.extraMounts ?? []) {
    const mode = mount.readOnly === false ? "rw" : "ro";
    args.push("-v", mount.source + ":" + mount.target + ":" + mode);
  }

  args.push(config.image, "-lc", HERMES_PROFILE_PROBE_SCRIPT);

  const result = spawnSync(engine, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });

  if (result.status !== 0) {
    return {
      cliOnPath: false,
      cliVersionOk: false,
      profileMountExists: false,
      expectedMountPath: HERMES_PROFILE_MOUNT_PATH,
      configFiles: [],
      errors: [boundedProbeError(result.status, result.error)],
    };
  }

  const values = parseProbeKeyValues(result.stdout ?? "");
  const cliPath = boundedProbeValue(values.get("cli_path"), 200);
  const cliVersion = boundedProbeValue(values.get("cli_version"), 100);
  const configFiles = (boundedProbeValue(values.get("config_files"), 300) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    cliOnPath: Boolean(cliPath),
    cliPath,
    cliVersionOk: values.get("cli_version_ok") === "1" && Boolean(cliVersion),
    cliVersion,
    profileMountExists: values.get("profile_mount_exists") === "1",
    expectedMountPath: HERMES_PROFILE_MOUNT_PATH,
    configFiles,
    errors: [],
  };
}

function classifyHermesProfileFailure(input: HermesProfileReadinessInput): string {
  if (!input.cliOnPath) return "hermes_cli_unavailable";
  if (!input.cliVersionOk) return "hermes_version_failed";
  if (!input.profileMountExists) return "hermes_profile_unavailable";
  return "ok";
}

function buildHermesProfileSummary(input: HermesProfileReadinessInput, failureCategory: string): string {
  const parts = [
    "failureCategory=" + failureCategory,
    "cli=" + (input.cliPath ?? "missing"),
    "version=" + (input.cliVersion ?? "missing"),
    "mount=" + (input.profileMountExists ? input.expectedMountPath : "missing"),
  ];
  if (input.configFiles.length) parts.push("files=" + input.configFiles.join(","));
  if (input.errors.length) parts.push("errors=" + input.errors.slice(0, 3).join("; "));
  return parts.join(" ");
}


function probeClaudeCodeProfileInContainer(config: RunnerConfig, engine: RunnerEngine): ClaudeCodeProfileReadinessInput {
  const args = [
    "run",
    "--rm",
    "--network",
    config.network ?? "bridge",
    "--entrypoint",
    "sh",
  ];

  for (const mount of config.extraMounts ?? []) {
    const mode = mount.readOnly === false ? "rw" : "ro";
    args.push("-v", mount.source + ":" + mount.target + ":" + mode);
  }

  args.push(config.image, "-lc", CLAUDE_CODE_PROFILE_PROBE_SCRIPT);

  const result = spawnSync(engine, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });

  if (result.status !== 0) {
    return {
      cliOnPath: false,
      cliVersionOk: false,
      profileMountExists: false,
      expectedMountPath: CLAUDE_CODE_PROFILE_MOUNT_PATH,
      bridgeExists: false,
      bridgePath: CLAUDE_CODE_PATCH_BRIDGE_PATH,
      errors: [boundedProbeError(result.status, result.error)],
    };
  }

  const values = parseProbeKeyValues(result.stdout ?? "");
  const cliPath = boundedProbeValue(values.get("cli_path"), 200);
  const cliVersion = boundedProbeValue(values.get("cli_version"), 100);
  return {
    cliOnPath: Boolean(cliPath),
    cliPath,
    cliVersionOk: values.get("cli_version_ok") === "1" && Boolean(cliVersion),
    cliVersion,
    profileMountExists: values.get("profile_mount_exists") === "1",
    expectedMountPath: CLAUDE_CODE_PROFILE_MOUNT_PATH,
    bridgeExists: values.get("bridge_exists") === "1",
    bridgePath: boundedProbeValue(values.get("bridge_path"), 240) ?? CLAUDE_CODE_PATCH_BRIDGE_PATH,
    errors: [],
  };
}

function classifyClaudeCodeProfileFailure(input: ClaudeCodeProfileReadinessInput): string {
  if (!input.cliOnPath) return "claude_cli_unavailable";
  if (!input.cliVersionOk) return "claude_version_failed";
  if (!input.profileMountExists) return "claude_profile_unavailable";
  if (!input.bridgeExists) return "claude_patch_bridge_missing";
  return "ok";
}

function buildClaudeCodeProfileSummary(input: ClaudeCodeProfileReadinessInput, failureCategory: string): string {
  const parts = [
    "failureCategory=" + failureCategory,
    "cli=" + (input.cliPath ?? "missing"),
    "version=" + (input.cliVersion ?? "missing"),
    "mount=" + (input.profileMountExists ? input.expectedMountPath : "missing"),
    "bridge=" + (input.bridgeExists ? input.bridgePath : "missing"),
  ];
  if (input.errors.length) parts.push("errors=" + input.errors.slice(0, 3).join("; "));
  return parts.join(" ");
}

function probeCodexProfileInContainer(config: RunnerConfig, engine: RunnerEngine): CodexProfileReadinessInput {
  const args = [
    "run",
    "--rm",
    "--network",
    config.network ?? "bridge",
    "--entrypoint",
    "sh",
  ];

  for (const mount of config.extraMounts ?? []) {
    const mode = mount.readOnly === false ? "rw" : "ro";
    args.push("-v", mount.source + ":" + mount.target + ":" + mode);
  }

  args.push(config.image, "-lc", CODEX_PROFILE_PROBE_SCRIPT);

  const result = spawnSync(engine, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });

  if (result.status !== 0) {
    return {
      cliOnPath: false,
      cliVersionOk: false,
      profileMountExists: false,
      expectedMountPath: CODEX_PROFILE_MOUNT_PATH,
      authFileExists: false,
      errors: [boundedProbeError(result.status, result.error)],
    };
  }

  const values = parseProbeKeyValues(result.stdout ?? "");
  const cliPath = boundedProbeValue(values.get("cli_path"), 200);
  const cliVersion = boundedProbeValue(values.get("cli_version"), 100);
  return {
    cliOnPath: Boolean(cliPath),
    cliPath,
    cliVersionOk: values.get("cli_version_ok") === "1" && Boolean(cliVersion),
    cliVersion,
    profileMountExists: values.get("profile_mount_exists") === "1",
    expectedMountPath: CODEX_PROFILE_MOUNT_PATH,
    authFileExists: values.get("auth_file_exists") === "1",
    errors: [],
  };
}

function classifyCodexProfileFailure(input: CodexProfileReadinessInput): string {
  if (!input.cliOnPath) return "codex_cli_unavailable";
  if (!input.cliVersionOk) return "codex_version_failed";
  if (!input.profileMountExists) return "codex_profile_unavailable";
  if (!input.authFileExists) return "codex_auth_unavailable";
  return "ok";
}

function buildCodexProfileSummary(input: CodexProfileReadinessInput, failureCategory: string): string {
  const parts = [
    "failureCategory=" + failureCategory,
    "cli=" + (input.cliPath ?? "missing"),
    "version=" + (input.cliVersion ?? "missing"),
    "mount=" + (input.profileMountExists ? input.expectedMountPath : "missing"),
    "auth=" + (input.authFileExists ? "present" : "missing"),
  ];
  if (input.errors.length) parts.push("errors=" + input.errors.slice(0, 3).join("; "));
  return parts.join(" ");
}

function probeOpenClawProfileInContainer(config: RunnerConfig, engine: RunnerEngine): OpenClawProfileReadinessInput {
  const args = [
    "run",
    "--rm",
    "--network",
    config.network ?? "bridge",
    "--entrypoint",
    "sh",
  ];

  for (const mount of config.extraMounts ?? []) {
    const mode = mount.readOnly === false ? "rw" : "ro";
    args.push("-v", mount.source + ":" + mount.target + ":" + mode);
  }

  args.push(config.image, "-lc", OPENCLAW_PROFILE_PROBE_SCRIPT);

  const result = spawnSync(engine, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 256 * 1024,
  });

  if (result.status !== 0) {
    return {
      cliOnPath: false,
      cliVersionOk: false,
      profileMountExists: false,
      expectedMountPath: DEFAULT_PROFILE_MOUNT_PATH,
      errors: [boundedProbeError(result.status, result.error)],
    };
  }

  const values = parseProbeKeyValues(result.stdout ?? "");
  const cliPath = boundedProbeValue(values.get("cli_path"), 200);
  const cliVersion = boundedProbeValue(values.get("cli_version"), 100);
  return {
    cliOnPath: Boolean(cliPath),
    cliPath,
    cliVersionOk: values.get("cli_version_ok") === "1" && Boolean(cliVersion),
    cliVersion,
    profileMountExists: values.get("profile_mount_exists") === "1",
    expectedMountPath: DEFAULT_PROFILE_MOUNT_PATH,
    configFileExists: values.get("config_file_exists") === "1",
    compactionModel: boundedProbeValue(values.get("compaction_model"), 160),
    compactionProvider: boundedProbeValue(values.get("compaction_provider"), 80),
    compactionProviderPresent: values.get("compaction_provider_present") === "1",
    compactionModelDefined: values.get("compaction_model_defined") === "1",
    configProbeError: boundedProbeValue(values.get("config_probe_error"), 180),
    errors: [],
  };
}

const HERMES_PROFILE_MOUNT_PATH = "/run/secrets/hermes-dir";
const CLAUDE_CODE_PROFILE_MOUNT_PATH = "/run/secrets/claude-dir";
const CODEX_PROFILE_MOUNT_PATH = "/run/secrets/codex-dir";
const CLAUDE_CODE_PATCH_BRIDGE_PATH = "/opt/a2a-broker/scripts/claude-a2a-patch-bridge.mjs";

const HERMES_PROFILE_PROBE_SCRIPT = [
  "set -u",
  "cli_path=\"$(command -v hermes 2>/dev/null || true)\"",
  "cli_version=\"\"",
  "cli_version_ok=0",
  "if [ -n \"$cli_path\" ]; then",
  "  cli_version=\"$(hermes --version 2>/dev/null | head -n 1 || true)\"",
  "  if [ -n \"$cli_version\" ]; then",
  "    cli_version_ok=1",
  "  fi",
  "fi",
  "profile_mount_exists=0",
  "config_files=\"\"",
  "if [ -d " + HERMES_PROFILE_MOUNT_PATH + " ]; then",
  "  profile_mount_exists=1",
  "  for file in config.yaml .env auth.json honcho.json; do",
  "    if [ -f " + HERMES_PROFILE_MOUNT_PATH + "/$file ]; then",
  "      config_files=\"${config_files}${config_files:+,}$file\"",
  "    fi",
  "  done",
  "fi",
  "printf 'cli_path=%s\\n' \"$cli_path\"",
  "printf 'cli_version_ok=%s\\n' \"$cli_version_ok\"",
  "printf 'cli_version=%s\\n' \"$cli_version\"",
  "printf 'profile_mount_exists=%s\\n' \"$profile_mount_exists\"",
  "printf 'config_files=%s\\n' \"$config_files\"",
].join("\n");


const CLAUDE_CODE_PROFILE_PROBE_SCRIPT = [
  "set -u",
  "cli_path=\"$(command -v claude 2>/dev/null || true)\"",
  "cli_version=\"\"",
  "cli_version_ok=0",
  "if [ -n \"$cli_path\" ]; then",
  "  cli_version=\"$(claude --version 2>/dev/null | head -n 1 || true)\"",
  "  if [ -n \"$cli_version\" ]; then",
  "    cli_version_ok=1",
  "  fi",
  "fi",
  "profile_mount_exists=0",
  "if [ -d " + CLAUDE_CODE_PROFILE_MOUNT_PATH + " ]; then",
  "  profile_mount_exists=1",
  "fi",
  "bridge_path=" + CLAUDE_CODE_PATCH_BRIDGE_PATH,
  "bridge_exists=0",
  "if [ -f \"$bridge_path\" ]; then",
  "  bridge_exists=1",
  "fi",
  "printf 'cli_path=%s\\n' \"$cli_path\"",
  "printf 'cli_version_ok=%s\\n' \"$cli_version_ok\"",
  "printf 'cli_version=%s\\n' \"$cli_version\"",
  "printf 'profile_mount_exists=%s\\n' \"$profile_mount_exists\"",
  "printf 'bridge_exists=%s\\n' \"$bridge_exists\"",
  "printf 'bridge_path=%s\\n' \"$bridge_path\"",
].join("\n");

const CODEX_PROFILE_PROBE_SCRIPT = [
  "set -eu",
  "cli_path=$(command -v codex 2>/dev/null || true)",
  "printf 'cli_path=%s\\n' \"$cli_path\"",
  "if [ -n \"$cli_path\" ]; then",
  "  cli_version=$(codex --version 2>/dev/null | head -n 1 || true)",
  "  printf 'cli_version=%s\\n' \"$cli_version\"",
  "  if [ -n \"$cli_version\" ]; then printf 'cli_version_ok=1\\n'; else printf 'cli_version_ok=0\\n'; fi",
  "else",
  "  printf 'cli_version=\\ncli_version_ok=0\\n'",
  "fi",
  "if [ -d " + CODEX_PROFILE_MOUNT_PATH + " ]; then printf 'profile_mount_exists=1\\n'; else printf 'profile_mount_exists=0\\n'; fi",
  "if [ -f " + CODEX_PROFILE_MOUNT_PATH + "/auth.json ]; then printf 'auth_file_exists=1\\n'; else printf 'auth_file_exists=0\\n'; fi",
].join("\n");

const OPENCLAW_PROFILE_PROBE_SCRIPT = [
  "set -u",
  "cli_path=\"$(command -v openclaw 2>/dev/null || true)\"",
  "cli_version=\"\"",
  "cli_version_ok=0",
  "if [ -n \"$cli_path\" ]; then",
  "  cli_version=\"$(openclaw --version 2>/dev/null | head -n 1 || true)\"",
  "  if [ -n \"$cli_version\" ]; then",
  "    cli_version_ok=1",
  "  fi",
  "fi",
  "profile_mount_exists=0",
  "if [ -d " + DEFAULT_PROFILE_MOUNT_PATH + " ]; then",
  "  profile_mount_exists=1",
  "fi",
  "config_file_exists=0",
  "compaction_model=\"\"",
  "compaction_provider=\"\"",
  "compaction_provider_present=0",
  "compaction_model_defined=0",
  "config_probe_error=\"\"",
  "if [ -f " + DEFAULT_PROFILE_MOUNT_PATH + "/openclaw.json ]; then",
  "  config_file_exists=1",
  "  config_probe_output=/tmp/a2a-openclaw-config-probe.out",
  "  if node >\"$config_probe_output\" 2>/tmp/a2a-openclaw-config-probe.err <<'A2A_CONFIG_PROBE'",
  "const fs = require('fs');",
  "const path = '" + DEFAULT_PROFILE_MOUNT_PATH + "/openclaw.json';",
  "const config = JSON.parse(fs.readFileSync(path, 'utf8'));",
  "const model = config?.agents?.defaults?.compaction?.model;",
  "const compactionModel = typeof model === 'string' ? model : '';",
  "const provider = compactionModel.includes('/') ? compactionModel.split('/')[0] : '';",
  "const providers = config?.models?.providers && typeof config.models.providers === 'object'",
  "  ? Object.keys(config.models.providers)",
  "  : [];",
  "const models = config?.agents?.defaults?.models && typeof config.agents.defaults.models === 'object'",
  "  ? config.agents.defaults.models",
  "  : {};",
  "const safe = (value) => String(value ?? '').replace(/[\\r\\n=]/g, ' ').slice(0, 160);",
  "console.log('compaction_model=' + safe(compactionModel));",
  "console.log('compaction_provider=' + safe(provider));",
  "console.log('compaction_provider_present=' + (provider && providers.includes(provider) ? '1' : '0'));",
  "console.log('compaction_model_defined=' + (!compactionModel || Object.prototype.hasOwnProperty.call(models, compactionModel) ? '1' : '0'));",
  "A2A_CONFIG_PROBE",
  "  then",
  "    while IFS='=' read -r key value; do",
  "      case \"$key\" in",
  "        compaction_model) compaction_model=\"$value\" ;;",
  "        compaction_provider) compaction_provider=\"$value\" ;;",
  "        compaction_provider_present) compaction_provider_present=\"$value\" ;;",
  "        compaction_model_defined) compaction_model_defined=\"$value\" ;;",
  "      esac",
  "    done <\"$config_probe_output\"",
  "  else",
  "    config_probe_error=\"$(head -c 180 /tmp/a2a-openclaw-config-probe.err 2>/dev/null | tr '\\n\\r' '  ' || true)\"",
  "  fi",
  "fi",
  "printf 'cli_path=%s\\n' \"$cli_path\"",
  "printf 'cli_version_ok=%s\\n' \"$cli_version_ok\"",
  "printf 'cli_version=%s\\n' \"$cli_version\"",
  "printf 'profile_mount_exists=%s\\n' \"$profile_mount_exists\"",
  "printf 'config_file_exists=%s\\n' \"$config_file_exists\"",
  "printf 'compaction_model=%s\\n' \"$compaction_model\"",
  "printf 'compaction_provider=%s\\n' \"$compaction_provider\"",
  "printf 'compaction_provider_present=%s\\n' \"$compaction_provider_present\"",
  "printf 'compaction_model_defined=%s\\n' \"$compaction_model_defined\"",
  "printf 'config_probe_error=%s\\n' \"$config_probe_error\"",
].join("\n");

export function parseProbeKeyValues(output: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    values.set(line.slice(0, index), line.slice(index + 1));
  }
  return values;
}

function boundedProbeValue(value: string | undefined, limit: number): string | undefined {
  const normalized = value?.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= limit ? normalized : normalized.slice(0, limit);
}

function boundedProbeError(status: number | null, error: Error | undefined): string {
  if (error) return (error.name + ": " + error.message).slice(0, 300);
  return "container probe exited with status " + (status ?? "unknown");
}

function git(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 5000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function readPackageVersion(cwd: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

async function resolveUpstreamMainSha(cwd: string, upstreamRef: string): Promise<{ full: string; short: string } | undefined> {
  const remote = upstreamRef.includes("/") ? upstreamRef.slice(0, upstreamRef.indexOf("/")) : "origin";
  const remoteHead = git(cwd, ["ls-remote", "--heads", remote, "main"]);
  const match = /(^|\n)([0-9a-f]{40})\s+refs\/heads\/main(?:\n|$)/i.exec(remoteHead.stdout);
  if (match) {
    const full = match[2].toLowerCase();
    return { full, short: full.slice(0, 12) };
  }

  const localRef = git(cwd, ["rev-parse", upstreamRef]);
  const localRefSha = normalizeSha(localRef.stdout.trim());
  if (localRefSha) return { full: localRefSha, short: localRefSha.slice(0, 12) };
  return undefined;
}

function normalizeSha(value: string): string | undefined {
  return /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : undefined;
}

function compactRevisionDetail(input: {
  version?: string;
  localSha?: string;
  localFullSha?: string;
  upstreamMainSha?: string;
  upstreamMainFullSha?: string;
  branch?: string;
  dirty?: boolean;
  /** True when .deploy-source-sha was detected as an expected deployment marker. */
  deploymentMarker?: boolean;
  summaryStatus: "PASS" | "WARN" | "FAIL";
  reason?: string;
}): Record<string, unknown> {
  const branch = input.branch ?? "unknown";
  const dirty = input.dirty ?? false;
  const deploymentMarker = input.deploymentMarker ?? false;
  const summary = [
    input.summaryStatus,
    `runner=${input.version ? `v${input.version}` : "unknown"}`,
    `local=${input.localSha ?? "unknown"}`,
    `upstreamMain=${input.upstreamMainSha ?? "unknown"}`,
    `branch=${branch}`,
    `dirty=${dirty ? "yes" : "no"}`,
    ...(deploymentMarker ? ["deploy-source-sha=present"] : []),
  ].join(" ");

  return {
    version: input.version,
    localSha: input.localSha,
    localFullSha: input.localFullSha,
    upstreamMainSha: input.upstreamMainSha,
    upstreamMainFullSha: input.upstreamMainFullSha,
    branch,
    dirty,
    ...(deploymentMarker ? { deploymentMarker } : {}),
    summary,
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function checkBaseImage(engine: RunnerEngine, image: string): OpsCheck {
  const inspect = spawnSync(engine, ["image", "inspect", image], { encoding: "utf8" });
  if (inspect.status === 0) return { status: "ok", message: "base image is present locally", detail: { image } };
  const pull = spawnSync(engine, ["pull", "--quiet", image], { encoding: "utf8" });
  if (pull.status === 0) return { status: "ok", message: "base image pull succeeded", detail: { image } };
  return { status: "fail", message: "base image is not ready", detail: { image, stderr: pull.stderr.trim() || inspect.stderr.trim() } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
