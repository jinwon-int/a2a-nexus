// #2547: retention for locally stored runner images.
//
// Every runner image rollout (`docker save | ssh <node> docker load`, then one
// `A2A_DOCKER_RUNNER_IMAGE=` line swapped in the worker env file) leaves the
// previous tag behind. Nothing removed them, so a 48G node filled up on
// 2026-11-12 (root 100%, rsyslog ENOSPC) with four ~1.9GB runner tags.
//
// Rule: per runner repository keep the tag(s) in use plus N rollback tags
// (default 1); everything else in an `a2a-docker-runner*` repository is a
// removal candidate. Other images (swift:*, python:*, node:*, ...) are never
// touched. Dry-run is the default; deletion needs --apply and is refused when
// the in-use evidence is missing or incomplete.
//
// Security: the env files scanned here carry secrets. Only `A2A_*IMAGE` values
// are parsed out of them; nothing else is read into the report.
import { readdir, readFile, stat, statfs } from "node:fs/promises";
import { join } from "node:path";
import { defaultEgressExec, type EgressExec } from "./egress-runtime.js";
import type { OpsCheck } from "./ops.js";
import type { RunnerEngine } from "./types.js";

export type EngineExec = EgressExec;
export const defaultEngineExec: EngineExec = defaultEgressExec;

/** Repository name (registry prefix allowed) of a runner image: `a2a-docker-runner` or `a2a-docker-runner-<flavor>`. */
export const RUNNER_IMAGE_REPOSITORY = /(^|\/)a2a-docker-runner(-[a-z0-9][a-z0-9._-]*)?$/;
/** Env keys whose values name an image the worker uses (A2A_DOCKER_RUNNER_IMAGE, ...). */
const IMAGE_ENV_KEY = /^A2A_[A-Z0-9_]*IMAGE$/;
export const DEFAULT_KEEP_ROLLBACK = 1;
/** Fleet rollouts take hours to days; never remove an image younger than this (the 2026-11-12 manual fleet sweep also kept 3 days). */
export const DEFAULT_MIN_AGE_MS = 72 * 60 * 60 * 1000;
export const DEFAULT_ENV_DIR = "/etc/default";
export const DEPLOY_RECORD_DIRS_ENV = "A2A_DOCKER_RUNNER_DEPLOY_RECORD_DIRS";
/** doctor warns below either threshold. */
export const DISK_WARN_FREE_RATIO = 0.10;
export const DISK_WARN_FREE_BYTES = 5 * 1024 ** 3;

export interface EngineImage {
  id: string;
  repoTags: string[];
  repoDigests: string[];
  created: string;
  sizeBytes: number;
}

export interface EngineContainer {
  id: string;
  name: string;
  imageId: string;
  imageRef: string;
}

/** An image reference together with where it was found. */
export interface ImageRef {
  ref: string;
  source: string;
  /** deploy records only: when the record was written (newest = most recent rollout). */
  mtimeMs?: number;
}

export interface ProcScan {
  refs: ImageRef[];
  /** processes whose environ could not be read (EACCES) — live detection is incomplete. */
  unreadable: number;
  scanned: number;
}

export interface RunnerImageInventory {
  engine: RunnerEngine;
  images: EngineImage[];
  containers: EngineContainer[];
  live: ProcScan;
  configured: ImageRef[];
  deployRecords: ImageRef[];
  keep: ImageRef[];
}

export type KeepReason = "in-use" | "container" | "keep-flag" | "rollback" | "rollback-tag" | "recent";

export interface PlannedTag {
  tag: string;
  id: string;
  created: string;
  sizeBytes: number;
  reason?: KeepReason;
  /** why it is kept/removed, e.g. the deploy record that picked the rollback. */
  why?: string;
}

export interface RepositoryPlan {
  repository: string;
  keep: PlannedTag[];
  remove: PlannedTag[];
}

export interface RunnerImagePlan {
  keepRollback: number;
  minAgeMs: number;
  repositories: RepositoryPlan[];
  candidates: PlannedTag[];
  /** image ids fully freed by removing the candidates (every tag is a candidate). */
  reclaimableBytes: number;
  /** candidate tags whose image keeps another (non-runner or kept) tag — untag only, frees nothing. */
  untagOnly: string[];
  unresolvedRefs: ImageRef[];
  applyAllowed: boolean;
  applyRefusals: string[];
}

export interface PlanOptions {
  keepRollback?: number;
  minAgeMs?: number;
  nowMs?: number;
  /** true when the caller is root (live /proc scan is authoritative). */
  isRoot?: boolean;
}

// ── reference matching ───────────────────────────────────────────────────────

/** `node:22` → `node:22`, `docker.io/library/node` → `node:latest`, `x@sha256:..` unchanged. */
export function normalizeRef(ref: string): string {
  let value = ref.trim();
  if (!value) return value;
  value = value.replace(/^docker\.io\//, "").replace(/^library\//, "");
  if (value.startsWith("sha256:") || value.includes("@")) return value;
  const lastSlash = value.lastIndexOf("/");
  const hasTag = value.slice(lastSlash + 1).includes(":");
  return hasTag ? value : `${value}:latest`;
}

export function repositoryOf(tag: string): string {
  const lastSlash = tag.lastIndexOf("/");
  const colon = tag.indexOf(":", lastSlash + 1);
  return colon >= 0 ? tag.slice(0, colon) : tag;
}

export function isRunnerRepository(repository: string): boolean {
  return RUNNER_IMAGE_REPOSITORY.test(repository.replace(/^docker\.io\//, ""));
}

/** Image id a reference points at, or undefined when no local image matches. */
export function resolveRef(ref: string, images: readonly EngineImage[]): string | undefined {
  const wanted = normalizeRef(ref);
  if (!wanted) return undefined;
  for (const image of images) {
    if (wanted.startsWith("sha256:") && (image.id === wanted || image.id.startsWith(wanted))) return image.id;
    if (image.repoTags.some((tag) => normalizeRef(tag) === wanted)) return image.id;
    if (wanted.includes("@") && image.repoDigests.some((digest) => normalizeRef(digest) === wanted)) return image.id;
  }
  return undefined;
}

// ── planning (pure) ──────────────────────────────────────────────────────────

export function planRunnerImagePrune(inventory: RunnerImageInventory, options: PlanOptions = {}): RunnerImagePlan {
  const keepRollback = options.keepRollback ?? DEFAULT_KEEP_ROLLBACK;
  const minAgeMs = options.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const nowMs = options.nowMs ?? Date.now();
  const { images } = inventory;
  const byId = new Map(images.map((image) => [image.id, image]));

  // id → why it is protected (first reason wins; order = strongest first).
  const protectedIds = new Map<string, { reason: KeepReason; why: string }>();
  const unresolvedRefs: ImageRef[] = [];
  const protect = (refs: readonly ImageRef[], reason: KeepReason): void => {
    for (const ref of refs) {
      const id = resolveRef(ref.ref, images);
      if (!id) {
        if (!unresolvedRefs.some((seen) => seen.ref === ref.ref)) unresolvedRefs.push(ref);
        continue;
      }
      if (!protectedIds.has(id)) protectedIds.set(id, { reason, why: `${ref.ref} (${ref.source})` });
    }
  };
  protect(inventory.live.refs, "in-use");
  protect(inventory.configured, "in-use");
  protect(inventory.keep, "keep-flag");
  for (const container of inventory.containers) {
    const id = byId.has(container.imageId) ? container.imageId : resolveRef(container.imageRef, images);
    if (id && !protectedIds.has(id)) protectedIds.set(id, { reason: "container", why: `container ${container.name || container.id.slice(0, 12)}` });
  }

  // Group runner tags by repository.
  const repoTags = new Map<string, PlannedTag[]>();
  for (const image of images) {
    for (const tag of image.repoTags) {
      const repository = repositoryOf(tag);
      if (!isRunnerRepository(repository)) continue;
      const list = repoTags.get(repository) ?? [];
      list.push({ tag, id: image.id, created: image.created, sizeBytes: image.sizeBytes });
      repoTags.set(repository, list);
    }
  }

  const repositories: RepositoryPlan[] = [];
  for (const [repository, tags] of [...repoTags.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const keep: PlannedTag[] = [];
    const rest: PlannedTag[] = [];
    for (const tag of tags) {
      const guard = protectedIds.get(tag.id);
      if (guard) keep.push({ ...tag, reason: guard.reason, why: guard.why });
      else if (/rollback/i.test(tag.tag.slice(repository.length + 1))) keep.push({ ...tag, reason: "rollback-tag", why: "tag name says rollback" });
      else rest.push(tag);
    }
    // Rollback: most recent deploy record for this repository first, then newest created.
    const keptIds = new Set(keep.map((tag) => tag.id));
    const rollbackIds: Array<{ id: string; why: string }> = [];
    const records = inventory.deployRecords
      .map((record) => ({ record, id: resolveRef(record.ref, images) }))
      .filter((entry): entry is { record: ImageRef; id: string } => Boolean(entry.id))
      .sort((a, b) => (b.record.mtimeMs ?? 0) - (a.record.mtimeMs ?? 0));
    for (const { record, id } of records) {
      if (rollbackIds.length >= keepRollback) break;
      if (keptIds.has(id) || rollbackIds.some((entry) => entry.id === id)) continue;
      if (!rest.some((tag) => tag.id === id)) continue;
      rollbackIds.push({ id, why: `deploy record ${record.source}` });
    }
    const byCreated = [...rest].sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
    for (const tag of byCreated) {
      if (rollbackIds.length >= keepRollback) break;
      if (rollbackIds.some((entry) => entry.id === tag.id)) continue;
      rollbackIds.push({ id: tag.id, why: "newest created among unused tags (no deploy record)" });
    }
    const remove: PlannedTag[] = [];
    for (const tag of rest) {
      const rollback = rollbackIds.find((entry) => entry.id === tag.id);
      const ageMs = nowMs - Date.parse(tag.created);
      if (rollback) keep.push({ ...tag, reason: "rollback", why: rollback.why });
      else if (!Number.isFinite(ageMs) || ageMs < minAgeMs) keep.push({ ...tag, reason: "recent", why: `created ${tag.created}` });
      else remove.push(tag);
    }
    repositories.push({ repository, keep, remove });
  }

  const candidates = repositories.flatMap((repo) => repo.remove);
  const candidateTags = new Set(candidates.map((tag) => tag.tag));
  const untagOnly: string[] = [];
  let reclaimableBytes = 0;
  for (const id of new Set(candidates.map((tag) => tag.id))) {
    const image = byId.get(id);
    if (!image) continue;
    if (image.repoTags.every((tag) => candidateTags.has(tag))) reclaimableBytes += image.sizeBytes;
    else untagOnly.push(...candidates.filter((tag) => tag.id === id).map((tag) => tag.tag));
  }

  const applyRefusals: string[] = [];
  if (inventory.live.refs.length === 0 && inventory.configured.length === 0) {
    applyRefusals.push("no in-use runner image evidence (no process env and no env file sets A2A_*IMAGE) — refusing to delete");
  }
  if (inventory.live.unreadable > 0) {
    applyRefusals.push(`${inventory.live.unreadable} process environ(s) unreadable — live detection incomplete; run as root`);
  } else if (options.isRoot === false) {
    applyRefusals.push("not running as root — live detection may miss other users' workers");
  }
  return {
    keepRollback,
    minAgeMs,
    repositories,
    candidates,
    reclaimableBytes,
    untagOnly,
    unresolvedRefs,
    applyAllowed: applyRefusals.length === 0,
    applyRefusals,
  };
}

// ── evidence collection ──────────────────────────────────────────────────────

/** Extract `A2A_*IMAGE` values from env-file text. Other keys are ignored on purpose (secrets). */
export function parseImageEnv(text: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!IMAGE_ENV_KEY.test(key)) continue;
    const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    if (value) out.push({ key, value });
  }
  return out;
}

/** Scan `<procRoot>/<pid>/environ` for A2A_*IMAGE (the value the running worker really uses). */
export async function scanProcessEnv(procRoot = "/proc", selfPid = process.pid): Promise<ProcScan> {
  const refs: ImageRef[] = [];
  let unreadable = 0;
  let scanned = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(procRoot);
  } catch {
    return { refs, unreadable: 1, scanned };
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === selfPid) continue;
    let environ: string;
    try {
      environ = await readFile(join(procRoot, entry, "environ"), "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") unreadable += 1;
      continue; // ENOENT/ESRCH: the process exited
    }
    scanned += 1;
    const found = parseImageEnv(environ.split("\0").join("\n"));
    if (found.length === 0) continue;
    const unit = await readUnit(procRoot, entry);
    for (const { key, value } of found) refs.push({ ref: value, source: `pid ${entry}${unit ? ` ${unit}` : ""} ${key}` });
  }
  return { refs, unreadable, scanned };
}

async function readUnit(procRoot: string, pid: string): Promise<string | undefined> {
  try {
    const cgroup = await readFile(join(procRoot, pid, "cgroup"), "utf8");
    return cgroup.match(/([^/\s]+\.service)/)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Env files in `envDir`: live files set the configured image; `<live>.<suffix>`
 * siblings (env-backups `.bak-<tag>-<stamp>` and similar) are deploy records.
 */
export async function scanEnvDir(envDir = DEFAULT_ENV_DIR): Promise<{ configured: ImageRef[]; deployRecords: ImageRef[] }> {
  const configured: ImageRef[] = [];
  const deployRecords: ImageRef[] = [];
  let names: string[] = [];
  try {
    names = await readdir(envDir);
  } catch {
    return { configured, deployRecords };
  }
  const nameSet = new Set(names);
  for (const name of names) {
    const path = join(envDir, name);
    const parsed = await readImageEnvFile(path);
    if (!parsed) continue;
    const isBackup = isEnvBackupName(name, nameSet);
    for (const { key, value } of parsed.values) {
      const ref = { ref: value, source: `${path} ${key}` };
      if (isBackup) deployRecords.push({ ...ref, mtimeMs: parsed.mtimeMs });
      else configured.push(ref);
    }
  }
  return { configured, deployRecords };
}

/**
 * `<live>.<suffix>` is a backup when the live file exists, or when the suffix
 * looks like one even though the live file is gone (an orphaned backup must
 * not be mistaken for a live env file — it would mark a dead image "in use").
 */
export function isEnvBackupName(name: string, siblings: ReadonlySet<string>): boolean {
  const dot = name.indexOf(".");
  if (dot <= 0) return false;
  if (siblings.has(name.slice(0, dot))) return true;
  return /(^|[.-])(bak|backup|orig|old|save|pre)([.-]|$)|\d{8}/i.test(name.slice(dot + 1));
}

/** Extra deploy-record dirs (e.g. env backups kept away from the live file); walked up to `maxDepth`. */
export async function scanDeployRecordDirs(dirs: readonly string[], maxDepth = 3): Promise<ImageRef[]> {
  const out: ImageRef[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < maxDepth) await walk(path, depth + 1);
      else if (entry.isFile()) {
        const parsed = await readImageEnvFile(path);
        for (const { key, value } of parsed?.values ?? []) out.push({ ref: value, source: `${path} ${key}`, mtimeMs: parsed?.mtimeMs });
      }
    }
  };
  for (const dir of dirs) await walk(dir, 0);
  return out;
}

async function readImageEnvFile(path: string): Promise<{ values: Array<{ key: string; value: string }>; mtimeMs: number } | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 1024 * 1024) return undefined;
    const values = parseImageEnv(await readFile(path, "utf8"));
    return values.length > 0 ? { values, mtimeMs: info.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

export async function listEngineImages(engine: RunnerEngine, exec: EngineExec = defaultEngineExec): Promise<EngineImage[]> {
  const ids = await exec(engine, ["image", "ls", "--no-trunc", "--format", "{{.ID}}"]);
  if (ids.code !== 0) throw new Error(`${engine} image ls failed: ${ids.stderr.trim()}`);
  const unique = [...new Set(ids.stdout.split("\n").map((line) => line.trim()).filter(Boolean))];
  if (unique.length === 0) return [];
  const inspected = await exec(engine, ["image", "inspect", ...unique]);
  if (inspected.code !== 0) throw new Error(`${engine} image inspect failed: ${inspected.stderr.trim()}`);
  return (JSON.parse(inspected.stdout) as Array<Record<string, unknown>>).map((raw) => ({
    id: String(raw.Id ?? raw.ID ?? ""),
    repoTags: ((raw.RepoTags as string[] | null) ?? []).filter((tag) => tag && !tag.includes("<none>")),
    repoDigests: (raw.RepoDigests as string[] | null) ?? [],
    created: String(raw.Created ?? ""),
    sizeBytes: Number(raw.Size ?? 0),
  }));
}

export async function listEngineContainers(engine: RunnerEngine, exec: EngineExec = defaultEngineExec): Promise<EngineContainer[]> {
  const ids = await exec(engine, ["ps", "-a", "--no-trunc", "--format", "{{.ID}}"]);
  if (ids.code !== 0) throw new Error(`${engine} ps failed: ${ids.stderr.trim()}`);
  const unique = [...new Set(ids.stdout.split("\n").map((line) => line.trim()).filter(Boolean))];
  if (unique.length === 0) return [];
  const inspected = await exec(engine, ["container", "inspect", ...unique]);
  if (inspected.code !== 0) throw new Error(`${engine} container inspect failed: ${inspected.stderr.trim()}`);
  return (JSON.parse(inspected.stdout) as Array<Record<string, unknown>>).map((raw) => ({
    id: String(raw.Id ?? ""),
    name: String(raw.Name ?? "").replace(/^\//, ""),
    imageId: String(raw.Image ?? ""),
    imageRef: String((raw.Config as { Image?: string } | undefined)?.Image ?? raw.ImageName ?? ""),
  }));
}

export interface CollectOptions {
  engine: RunnerEngine;
  exec?: EngineExec;
  procRoot?: string;
  envDir?: string;
  deployRecordDirs?: readonly string[];
  keepRefs?: readonly string[];
}

export async function collectRunnerImageInventory(options: CollectOptions): Promise<RunnerImageInventory> {
  const exec = options.exec ?? defaultEngineExec;
  const [images, containers, live, envDir, extraRecords] = await Promise.all([
    listEngineImages(options.engine, exec),
    listEngineContainers(options.engine, exec),
    scanProcessEnv(options.procRoot),
    scanEnvDir(options.envDir),
    scanDeployRecordDirs(options.deployRecordDirs ?? []),
  ]);
  return {
    engine: options.engine,
    images,
    containers,
    live,
    configured: envDir.configured,
    deployRecords: [...envDir.deployRecords, ...extraRecords],
    keep: (options.keepRefs ?? []).map((ref) => ({ ref, source: "--keep" })),
  };
}

// ── disk ─────────────────────────────────────────────────────────────────────

export interface DiskUsage {
  path: string;
  totalBytes: number;
  freeBytes: number;
  freeRatio: number;
}

export type StatfsFn = (path: string) => Promise<{ blocks: number | bigint; bavail: number | bigint; bsize: number | bigint }>;

export async function diskUsage(path: string, statfsFn: StatfsFn = statfs as unknown as StatfsFn): Promise<DiskUsage | undefined> {
  try {
    const info = await statfsFn(path);
    const bsize = Number(info.bsize);
    const totalBytes = Number(info.blocks) * bsize;
    const freeBytes = Number(info.bavail) * bsize;
    return { path, totalBytes, freeBytes, freeRatio: totalBytes > 0 ? freeBytes / totalBytes : 0 };
  } catch {
    return undefined;
  }
}

export async function engineRootDir(engine: RunnerEngine, exec: EngineExec = defaultEngineExec): Promise<string | undefined> {
  const format = engine === "docker" ? "{{.DockerRootDir}}" : "{{.Store.GraphRoot}}";
  const result = await exec(engine, ["info", "--format", format]);
  const dir = result.stdout.trim();
  return result.code === 0 && dir.startsWith("/") ? dir : undefined;
}

// ── report / apply ───────────────────────────────────────────────────────────

export interface PruneOptions extends CollectOptions, PlanOptions {
  apply?: boolean;
  builderCache?: boolean;
  statfsFn?: StatfsFn;
}

export interface PruneReport {
  mode: "dry-run" | "apply";
  engine: RunnerEngine;
  rule: string;
  evidence: {
    live: ImageRef[];
    liveScanned: number;
    liveUnreadable: number;
    configured: ImageRef[];
    deployRecords: ImageRef[];
    containers: Array<{ name: string; imageRef: string; imageId: string }>;
  };
  plan: RunnerImagePlan;
  builderCache: { requested: boolean; command?: string[]; ok?: boolean; output?: string };
  disk: { before: DiskUsage[]; after?: DiskUsage[] };
  removed?: Array<{ tag: string; id: string; ok: boolean; stderr?: string }>;
  ok: boolean;
}

async function diskSnapshot(engine: RunnerEngine, exec: EngineExec, statfsFn?: StatfsFn): Promise<DiskUsage[]> {
  const paths = ["/"];
  const root = await engineRootDir(engine, exec);
  if (root) paths.push(root);
  const out: DiskUsage[] = [];
  for (const path of paths) {
    const usage = await diskUsage(path, statfsFn);
    if (usage) out.push(usage);
  }
  return out;
}

export async function pruneRunnerImages(options: PruneOptions): Promise<PruneReport> {
  const exec = options.exec ?? defaultEngineExec;
  const planOptions: PlanOptions = { keepRollback: options.keepRollback, minAgeMs: options.minAgeMs, nowMs: options.nowMs, isRoot: options.isRoot };
  const inventory = await collectRunnerImageInventory({ ...options, exec });
  const plan = planRunnerImagePrune(inventory, planOptions);
  const before = await diskSnapshot(options.engine, exec, options.statfsFn);
  const builderCommand = ["builder", "prune", "-f"];
  const report: PruneReport = {
    mode: options.apply ? "apply" : "dry-run",
    engine: options.engine,
    rule: `keep in-use (process env, env files, containers, --keep) + ${plan.keepRollback} rollback per runner repository + rollback-named tags + images younger than ${Math.round(plan.minAgeMs / 3_600_000)}h; only ${RUNNER_IMAGE_REPOSITORY.source} repositories`,
    evidence: {
      live: inventory.live.refs,
      liveScanned: inventory.live.scanned,
      liveUnreadable: inventory.live.unreadable,
      configured: inventory.configured,
      deployRecords: inventory.deployRecords,
      containers: inventory.containers.map(({ name, imageRef, imageId }) => ({ name, imageRef, imageId })),
    },
    plan,
    builderCache: options.builderCache && options.engine === "docker"
      ? { requested: true, command: [options.engine, ...builderCommand] }
      : { requested: Boolean(options.builderCache) },
    disk: { before },
    ok: true,
  };
  if (!options.apply) return report;
  if (!plan.applyAllowed) {
    report.ok = false;
    return report;
  }
  // Re-plan right before deleting: a container started or a worker restarted
  // since the first look must win over the earlier plan.
  const recheck = planRunnerImagePrune(await collectRunnerImageInventory({ ...options, exec }), planOptions);
  const stillCandidates = new Set(recheck.candidates.map((tag) => `${tag.tag}@${tag.id}`));
  report.removed = [];
  for (const tag of plan.candidates) {
    if (!stillCandidates.has(`${tag.tag}@${tag.id}`)) {
      report.removed.push({ tag: tag.tag, id: tag.id, ok: false, stderr: "skipped: no longer a candidate on re-check" });
      continue;
    }
    // No -f: the engine refuses an image a container still references.
    const result = await exec(options.engine, ["image", "rm", tag.tag]);
    report.removed.push({ tag: tag.tag, id: tag.id, ok: result.code === 0, ...(result.code === 0 ? {} : { stderr: result.stderr.trim() }) });
  }
  if (report.builderCache.command) {
    const result = await exec(options.engine, builderCommand);
    report.builderCache.ok = result.code === 0;
    report.builderCache.output = (result.code === 0 ? result.stdout : result.stderr).trim().split("\n").slice(-1)[0];
  }
  report.disk.after = await diskSnapshot(options.engine, exec, options.statfsFn);
  report.ok = report.removed.every((entry) => entry.ok || entry.stderr?.startsWith("skipped:")) && report.builderCache.ok !== false;
  return report;
}

// ── doctor ───────────────────────────────────────────────────────────────────

export interface RunnerImageDiskCheckOptions extends Partial<CollectOptions> {
  engineReady: boolean;
  statfsFn?: StatfsFn;
  nowMs?: number;
}

/** #2547 doctor probe: warn-only. Low root disk, plus how much stale runner images would free. */
export async function checkRunnerImageDisk(options: RunnerImageDiskCheckOptions): Promise<OpsCheck> {
  const root = await diskUsage("/", options.statfsFn);
  if (!root) return { status: "warn", message: "could not read free space on /" };
  const low = root.freeRatio < DISK_WARN_FREE_RATIO || root.freeBytes < DISK_WARN_FREE_BYTES;
  const detail: Record<string, unknown> = {
    path: root.path,
    freeBytes: root.freeBytes,
    freePercent: Math.round(root.freeRatio * 1000) / 10,
    thresholds: { freePercent: DISK_WARN_FREE_RATIO * 100, freeBytes: DISK_WARN_FREE_BYTES },
  };
  let reclaim = "";
  if (options.engineReady && options.engine) {
    try {
      const inventory = await collectRunnerImageInventory({ ...options, engine: options.engine });
      const plan = planRunnerImagePrune(inventory, { nowMs: options.nowMs });
      detail.staleRunnerTags = plan.candidates.map((tag) => tag.tag);
      detail.reclaimableBytes = plan.reclaimableBytes;
      if (plan.candidates.length > 0) {
        reclaim = `; ${plan.candidates.length} stale runner image tag(s), ~${formatBytes(plan.reclaimableBytes)} reclaimable — review with: a2a-docker-runner images (dry-run)`;
      }
    } catch (error) {
      detail.inventoryError = error instanceof Error ? error.message : String(error);
    }
  }
  const free = `${formatBytes(root.freeBytes)} free on / (${detail.freePercent}%)`;
  if (low) {
    return { status: "warn", message: `low disk: ${free}, below ${DISK_WARN_FREE_RATIO * 100}% or ${formatBytes(DISK_WARN_FREE_BYTES)}${reclaim}`, detail };
  }
  return { status: "ok", message: `${free}${reclaim}`, detail };
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
}
