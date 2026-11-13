// #2547: retention for locally stored runner images.
//
// Every runner image rollout (`docker save | ssh <node> docker load`, then one
// `A2A_DOCKER_RUNNER_IMAGE=` line swapped in the worker env file) leaves the
// previous tag behind. Nothing removed them, so a 48G node filled up on
// 2026-11-12 (root 100%, rsyslog ENOSPC) with four ~1.9GB runner tags.
//
// Rule, per runner repository: keep every image a worker or container uses,
// plus N rollback images per worker env file (default 1, from that file's
// newest backup = the previous deploy), *rollback* tags and images loaded or
// built within --min-age. Everything else in an `a2a-docker-runner*`
// repository is a removal candidate; other images are never touched.
//
// Fail-closed: dry-run is the default; --apply is refused when an in-use
// reference cannot be resolved to a local image, when /proc could not be read
// completely, or when there is no in-use evidence at all. A runner repository
// with no resolved in-use evidence is not pruned unless named with
// --repository.
//
// Security: env files and process environs carry secrets. Only `A2A_*IMAGE`
// values are parsed out of them, and engine inspect calls request only the
// fields used here (never Config.Env).
import { readdir, readFile, stat, statfs } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
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
/** Fleet rollouts take hours to days; never remove an image built or loaded more recently than this. */
export const DEFAULT_MIN_AGE_MS = 72 * 60 * 60 * 1000;
export const DEFAULT_ENV_DIR = "/etc/default";
export const DEPLOY_RECORD_DIRS_ENV = "A2A_DOCKER_RUNNER_DEPLOY_RECORD_DIRS";
/** doctor warns below either threshold. */
export const DISK_WARN_FREE_RATIO = 0.10;
export const DISK_WARN_FREE_BYTES = 5 * 1024 ** 3;
/** doctor never waits longer than this for the image inventory. */
export const DOCTOR_INVENTORY_TIMEOUT_MS = 10_000;

export interface EngineImage {
  id: string;
  repoTags: string[];
  repoDigests: string[];
  created: string;
  /** docker `Metadata.LastTagTime`: when the tag was last set locally (`docker load`/`tag`). */
  lastTagTime?: string;
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
  /** env-file refs: the file that set it. */
  file?: string;
  /** deploy records only: when the record was written (newest = most recent rollout). */
  mtimeMs?: number;
  /** deploy records only: the live env file this backup belongs to (rollback is per worker env). */
  owner?: string;
  /** deploy records only: a backup whose live file is gone — never used to pick a rollback. */
  orphan?: boolean;
}

export interface ProcScan {
  refs: ImageRef[];
  /** processes whose environ could not be read (EACCES) — live detection is incomplete. */
  unreadable: number;
  scanned: number;
  /** systemd units of the processes that carried an A2A_*IMAGE value. */
  units: string[];
}

export interface RunnerImageInventory {
  /** systemd unit → the env files it loads (EnvironmentFile=); ties a running process to its env-file worker. */
  unitEnvFiles?: Record<string, string[]>;
  engine: RunnerEngine;
  images: EngineImage[];
  containers: EngineContainer[];
  live: ProcScan;
  configured: ImageRef[];
  deployRecords: ImageRef[];
  keep: ImageRef[];
}

export type KeepReason =
  | "in-use"
  | "container"
  | "keep-flag"
  | "rollback"
  | "rollback-tag"
  | "recent"
  | "newer-than-in-use"
  | "newer-to-review"
  | "unattributed-record"
  | "unverified-repository";

export interface PlannedTag {
  tag: string;
  id: string;
  created: string;
  /** max(created, lastTagTime) — what --min-age is measured against. */
  effectiveTime: string;
  sizeBytes: number;
  reason?: KeepReason;
  /** why it is kept/removed, e.g. the deploy record that picked the rollback. */
  why?: string;
}

export interface RepositoryPlan {
  repository: string;
  /** true when a running process or live env file resolves into this repository (containers / --keep only protect). */
  inUseEvidence: boolean;
  keep: PlannedTag[];
  remove: PlannedTag[];
}

export interface RunnerImagePlan {
  keepRollback: number;
  minAgeMs: number;
  repositories: RepositoryPlan[];
  candidates: PlannedTag[];
  /**
   * Upper bound of the bytes freed: sum of the sizes of image ids whose every tag
   * is a candidate. Shared base layers are counted once per image, so the real
   * gain is usually smaller.
   */
  reclaimableBytes: number;
  /** images built after the in-use one beyond --keep-newer: kept, but listed for a manual decision (--include-newer). */
  newerToReview: string[];
  /** always true: see reclaimableBytes. */
  reclaimableIsUpperBound: true;
  /** images named only by a deploy record that matches no worker: kept, listed for a manual decision. */
  recordsToReview: string[];
  /** candidate tags whose image keeps another (non-runner or kept) tag — untag only, frees nothing. */
  untagOnly: string[];
  unresolvedRefs: ImageRef[];
  /** runner repositories left untouched because nothing proves which tag is in use. */
  skippedRepositories: string[];
  applyAllowed: boolean;
  applyRefusals: string[];
}

export interface PlanOptions {
  keepRollback?: number;
  minAgeMs?: number;
  nowMs?: number;
  /** true when the caller is root (live /proc scan is authoritative). */
  isRoot?: boolean;
  /** runner repositories to prune even without resolved in-use evidence (explicit opt-in). */
  allowRepositories?: readonly string[];
  /** images built after the in-use one kept automatically per repository (default 1: the next rollout). */
  keepNewer?: number;
  /** make the images beyond --keep-newer candidates instead of "review manually". */
  includeNewer?: boolean;
}

export const DEFAULT_KEEP_NEWER = 1;

// ── reference matching ───────────────────────────────────────────────────────

const SHORT_ID = /^[0-9a-f]{12,64}$/;

/**
 * Canonical comparison form: registry aliases dropped (`docker.io/`,
 * `index.docker.io/`, podman's `localhost/`, `library/`), `:latest` added to a
 * bare name. `name[:tag]@sha256:..` and image ids keep their digest.
 */
export function normalizeRef(ref: string): string {
  let value = ref.trim();
  if (!value) return value;
  if (value.startsWith("sha256:") || SHORT_ID.test(value)) return value;
  value = value.replace(/^(docker\.io|index\.docker\.io|localhost)\//, "").replace(/^library\//, "");
  const at = value.indexOf("@");
  const name = at >= 0 ? value.slice(0, at) : value;
  const digest = at >= 0 ? value.slice(at) : "";
  const lastSlash = name.lastIndexOf("/");
  const hasTag = name.slice(lastSlash + 1).includes(":");
  if (digest) return `${name}${digest}`;
  return hasTag ? name : `${name}:latest`;
}

export function repositoryOf(tag: string): string {
  const value = tag.split("@")[0];
  const lastSlash = value.lastIndexOf("/");
  const colon = value.indexOf(":", lastSlash + 1);
  return colon >= 0 ? value.slice(0, colon) : value;
}

export function isRunnerRepository(repository: string): boolean {
  return RUNNER_IMAGE_REPOSITORY.test(repositoryOf(normalizeRef(repository)));
}

/** True when an unresolved reference could name a runner image (so it must not be ignored). */
function couldBeRunnerImage(ref: string): boolean {
  const value = normalizeRef(ref);
  return value.startsWith("sha256:") || SHORT_ID.test(value) || isRunnerRepository(value);
}

/**
 * Every local image id a reference points at. A normalized tag can match more
 * than one image (e.g. `localhost/x:1` from a podman build and `x:1` from a
 * docker-archive load); protection must cover all of them.
 */
export function resolveRefAll(ref: string, images: readonly EngineImage[]): string[] {
  const wanted = normalizeRef(ref);
  if (!wanted) return [];
  if (wanted.startsWith("sha256:") || SHORT_ID.test(wanted) || wanted.includes("@")) {
    const id = resolveRef(ref, images);
    return id ? [id] : [];
  }
  return images.filter((image) => image.repoTags.some((tag) => normalizeRef(tag) === wanted)).map((image) => image.id);
}

/** Image id a reference points at, or undefined when no local image matches. */
export function resolveRef(ref: string, images: readonly EngineImage[]): string | undefined {
  const wanted = normalizeRef(ref);
  if (!wanted) return undefined;
  if (wanted.startsWith("sha256:") || SHORT_ID.test(wanted)) {
    const prefix = wanted.startsWith("sha256:") ? wanted : `sha256:${wanted}`;
    const matches = images.filter((image) => image.id === prefix || image.id.startsWith(prefix));
    return matches.length === 1 ? matches[0].id : undefined;
  }
  const at = wanted.indexOf("@");
  if (at >= 0) {
    const digest = wanted.slice(at + 1);
    const byDigest = images.find((image) => image.repoDigests.some((entry) => entry.endsWith(`@${digest}`)));
    if (byDigest) return byDigest.id;
    const name = wanted.slice(0, at);
    // `name:tag@digest` after `docker load` (no RepoDigests): fall back to the tag.
    if (name.slice(name.lastIndexOf("/") + 1).includes(":")) return resolveRef(name, images);
    return undefined;
  }
  return images.find((image) => image.repoTags.some((tag) => normalizeRef(tag) === wanted))?.id;
}

function effectiveMs(image: Pick<EngineImage, "created" | "lastTagTime">): number {
  const times = [image.created, image.lastTagTime]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value) && value > Date.UTC(1971, 0, 1)); // docker reports 0001-01-01 for "never"
  return times.length > 0 ? Math.max(...times) : Number.NaN;
}

// ── planning (pure) ──────────────────────────────────────────────────────────

export function planRunnerImagePrune(inventory: RunnerImageInventory, options: PlanOptions = {}): RunnerImagePlan {
  const keepRollback = options.keepRollback ?? DEFAULT_KEEP_ROLLBACK;
  const minAgeMs = options.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const nowMs = options.nowMs ?? Date.now();
  const allowRepositories = new Set((options.allowRepositories ?? []).map((repo) => repositoryOf(normalizeRef(repo))));
  const { images } = inventory;
  const byId = new Map(images.map((image) => [image.id, image]));

  // id → why it is protected (first reason wins; order = strongest first).
  const protectedIds = new Map<string, { reason: KeepReason; why: string }>();
  const unresolvedRefs: ImageRef[] = [];
  const applyRefusals: string[] = [];
  const blockingUnresolved: string[] = [];
  const protect = (refs: readonly ImageRef[], reason: KeepReason): void => {
    for (const ref of refs) {
      const ids = resolveRefAll(ref.ref, images);
      if (ids.length === 0) {
        if (!unresolvedRefs.some((seen) => seen.ref === ref.ref)) unresolvedRefs.push(ref);
        // An in-use or --keep reference we cannot map to a local image might be
        // exactly the image a candidate would delete: never guess.
        if ((reason === "keep-flag" || couldBeRunnerImage(ref.ref)) && !blockingUnresolved.includes(ref.ref)) {
          blockingUnresolved.push(ref.ref);
        }
        continue;
      }
      for (const id of ids) if (!protectedIds.has(id)) protectedIds.set(id, { reason, why: `${ref.ref} (${ref.source})` });
    }
  };
  protect(inventory.live.refs, "in-use");
  protect(inventory.configured, "in-use");
  protect(inventory.keep, "keep-flag");
  for (const container of inventory.containers) {
    const id = byId.has(container.imageId) ? container.imageId : resolveRef(container.imageRef, images);
    if (id && !protectedIds.has(id)) protectedIds.set(id, { reason: "container", why: `container ${container.name || container.id.slice(0, 12)}` });
  }

  // Workers: one per live env file; a process whose image no env file names is
  // its own worker (keyed by systemd unit, else pid). Rollback is per worker.
  interface Worker { key: string; files: Set<string>; ids: Set<string> }
  const workers = new Map<string, Worker>();
  const workerOf = (key: string): Worker => {
    const existing = workers.get(key);
    if (existing) return existing;
    const created: Worker = { key, files: new Set(), ids: new Set() };
    workers.set(key, created);
    return created;
  };
  const fileIds = new Set<string>();
  for (const ref of inventory.configured) {
    if (!ref.file) continue;
    const worker = workerOf(ref.file);
    worker.files.add(ref.file);
    for (const id of resolveRefAll(ref.ref, images)) {
      worker.ids.add(id);
      fileIds.add(id);
    }
  }
  for (const ref of inventory.live.refs) {
    const ids = resolveRefAll(ref.ref, images);
    if (ids.length === 0) continue;
    const [, pid, unit] = ref.source.match(/^pid (\d+)(?: (\S+\.service))?/) ?? [];
    // A unit whose EnvironmentFile= is a live env file is that file's worker;
    // a unit known to load none of them is a worker of its own, even on the
    // same image (e.g. Environment= in a drop-in).
    const mapping = unit ? inventory.unitEnvFiles?.[unit] : undefined;
    const ownFile = mapping?.find((file) => workers.has(file));
    if (ownFile) {
      for (const id of ids) workers.get(ownFile)?.ids.add(id);
      continue;
    }
    // Without that mapping (no unit, or not collected) a process on an env-file
    // worker's image cannot be told apart from it: treat it as that worker.
    if (mapping === undefined && ids.every((id) => fileIds.has(id))) continue;
    const worker = workerOf(unit ? `unit:${unit}` : `pid:${pid ?? ref.source}`);
    for (const id of ids) worker.ids.add(id);
  }
  const keepNewer = options.keepNewer ?? DEFAULT_KEEP_NEWER;
  const createdMs = (id: string): number => Date.parse(byId.get(id)?.created ?? "");

  // Group runner tags by (normalized) repository.
  const repoTags = new Map<string, PlannedTag[]>();
  for (const image of images) {
    for (const tag of image.repoTags) {
      const repository = repositoryOf(normalizeRef(tag));
      if (!isRunnerRepository(repository)) continue;
      const list = repoTags.get(repository) ?? [];
      const effective = effectiveMs(image);
      list.push({
        tag,
        id: image.id,
        created: image.created,
        effectiveTime: Number.isFinite(effective) ? new Date(effective).toISOString() : image.created,
        sizeBytes: image.sizeBytes,
      });
      repoTags.set(repository, list);
    }
  }

  const repositories: RepositoryPlan[] = [];
  const skippedRepositories: string[] = [];
  const newerToReview: string[] = [];
  const recordsToReview: string[] = [];
  const resolvedRecords = inventory.deployRecords
    .filter((record) => !record.orphan)
    .map((record) => ({ record, id: resolveRef(record.ref, images) }))
    .filter((entry): entry is { record: ImageRef; id: string } => Boolean(entry.id))
    .sort((a, b) => (b.record.mtimeMs ?? 0) - (a.record.mtimeMs ?? 0));
  for (const [repository, tags] of [...repoTags.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const keep: PlannedTag[] = [];
    const rest: PlannedTag[] = [];
    for (const tag of tags) {
      const guard = protectedIds.get(tag.id);
      if (guard) keep.push({ ...tag, reason: guard.reason, why: guard.why });
      else if (/rollback/i.test(normalizeRef(tag.tag).slice(repository.length + 1))) keep.push({ ...tag, reason: "rollback-tag", why: "tag name says rollback" });
      else rest.push(tag);
    }
    // Only a running process or a live env file says which tag a worker needs.
    // Containers and --keep protect their images but do not open a repository
    // for pruning, nor move the "newer than in use" line (#2550).
    const inUseIds = new Set(keep.filter((tag) => tag.reason === "in-use").map((tag) => tag.id));
    const inUseEvidence = inUseIds.size > 0;
    if (!inUseEvidence && !allowRepositories.has(repository)) {
      for (const tag of rest) keep.push({ ...tag, reason: "unverified-repository", why: "no running process or live env file uses this repository (opt in with --repository)" });
      skippedRepositories.push(repository);
      repositories.push({ repository, inUseEvidence, keep, remove: [] });
      continue;
    }

    const isRecent = (tag: PlannedTag): boolean => {
      const ageMs = nowMs - Date.parse(tag.effectiveTime);
      return !Number.isFinite(ageMs) || ageMs < minAgeMs;
    };
    const restIds = new Set(rest.map((tag) => tag.id));
    const rollback = new Map<string, string>(); // id → why
    const newestInUseMs = Math.max(...[...inUseIds].map(createdMs).filter(Number.isFinite), Number.NEGATIVE_INFINITY);

    // Rollback: N per worker of this repository, from (1) its own backups,
    // (2) deploy records without a known owner, (3) the newest non-recent image
    // built before that worker's in-use image.
    const repoWorkers = [...workers.values()]
      .filter((worker) => [...worker.ids].some((id) => inUseIds.has(id)))
      .sort((a, b) => a.key.localeCompare(b.key));
    const attributed = new Set<string>(); // owner-less records some worker of this repository could claim
    // An env file name shared by several workers (same name in different
    // directories) cannot tell whose history a deploy record is: such records
    // fill no slot and are kept for review.
    const nameCount = new Map<string, number>();
    for (const worker of workers.values()) {
      for (const name of new Set([...worker.files].map((file) => basename(file)))) nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
    }
    const ambiguousNames = new Set([...nameCount].filter(([, count]) => count > 1).map(([name]) => name));
    for (const worker of repoWorkers) {
      let picked = 0;
      const workerInUseMs = Math.max(...[...worker.ids].filter((id) => inUseIds.has(id)).map(createdMs).filter(Number.isFinite), Number.NEGATIVE_INFINITY);
      const builtBefore = (id: string): boolean => createdMs(id) < workerInUseMs;
      const restTag = (id: string): PlannedTag | undefined => rest.find((tag) => tag.id === id);
      // A rollback must be an image this worker ran before: built before its
      // in-use image. Recent images are kept anyway and never use a slot.
      const take = (id: string, why: string): void => {
        const tag = restTag(id);
        if (picked >= keepRollback || rollback.has(id) || !tag || isRecent(tag) || !builtBefore(id)) return;
        rollback.set(id, why);
        picked += 1;
      };
      // (1) its own backups
      for (const { record, id } of resolvedRecords) if (record.owner && worker.files.has(record.owner)) take(id, `previous deploy of ${record.owner} (${record.source})`);
      // (2) owner-less deploy records only when the file name is this worker's env file name (deploy-record
      //     dirs keep the original name) — never another worker's history
      const names = new Set([...worker.files].map((file) => basename(file)).filter((name) => !ambiguousNames.has(name)));
      for (const { record, id } of resolvedRecords) {
        if (record.owner || !record.file || !names.has(basename(record.file))) continue;
        attributed.add(record.source);
        take(id, `deploy record ${record.source} (for ${worker.key})`);
      }
      // (3) the newest non-recent image built before this worker's own in-use image
      const fallback = rest.filter((tag) => builtBefore(tag.id)).sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
      for (const tag of fallback) take(tag.id, `newest image built before the in-use image of ${worker.key} (no deploy record)`);
    }
    // Backups of a live env file whose worker now runs another repository (e.g.
    // a flavor switch): still that worker's rollback — keep its N newest here.
    const foreignPicked = new Map<string, number>();
    for (const { record, id } of resolvedRecords) {
      const owner = record.owner;
      if (!owner || repoWorkers.some((worker) => worker.files.has(owner))) continue;
      const tag = rest.find((candidate) => candidate.id === id);
      const count = foreignPicked.get(owner) ?? 0;
      if (!tag || rollback.has(id) || isRecent(tag) || count >= keepRollback) continue;
      rollback.set(id, `previous deploy of ${owner} (${record.source}), which now runs another repository`);
      foreignPicked.set(owner, count + 1);
    }
    // Owner-less records no worker of this repository claims: never fill a
    // slot, never deleted here — kept and listed for a manual decision.
    const unattributed = new Map<string, string>();
    for (const { record, id } of resolvedRecords) {
      if (record.owner || attributed.has(record.source) || !restIds.has(id) || rollback.has(id) || unattributed.has(id)) continue;
      const shared = record.file !== undefined && ambiguousNames.has(basename(record.file));
      unattributed.set(id, shared
        ? `named by deploy record ${record.source}, whose file name several worker env files share`
        : `named by deploy record ${record.source}, which matches no worker env file name`);
    }
    if (repoWorkers.length === 0) {
      // --repository opt-in without any worker: keep N newest non-recent images.
      const fallback = rest.filter((tag) => !isRecent(tag)).sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
      for (const tag of fallback) {
        if (rollback.size >= keepRollback) break;
        if (!rollback.has(tag.id)) rollback.set(tag.id, "newest image (opted-in repository without a worker)");
      }
    }

    // Images built at or after the in-use one: most likely the next rollout,
    // loaded but not switched to yet (the load time is unknown on podman).
    // Keep the newest --keep-newer; list the rest for a manual decision.
    const newerIds = [...new Set(rest
      .filter((tag) => !rollback.has(tag.id) && !isRecent(tag) && !unattributed.has(tag.id))
      .filter((tag) => Number.isFinite(newestInUseMs) && Date.parse(tag.created) >= newestInUseMs)
      .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))
      .map((tag) => tag.id))];
    const newerKept = new Set(newerIds.slice(0, keepNewer));
    const newerBeyond = new Set(newerIds.slice(keepNewer));

    const remove: PlannedTag[] = [];
    for (const tag of rest) {
      const why = rollback.get(tag.id);
      if (why) keep.push({ ...tag, reason: "rollback", why });
      else if (isRecent(tag)) keep.push({ ...tag, reason: "recent", why: `built/loaded ${tag.effectiveTime}` });
      else if (unattributed.has(tag.id)) {
        keep.push({ ...tag, reason: "unattributed-record", why: unattributed.get(tag.id) });
        recordsToReview.push(tag.tag);
      }
      else if (newerKept.has(tag.id)) keep.push({ ...tag, reason: "newer-than-in-use", why: `built ${tag.created}, not before the in-use image` });
      else if (newerBeyond.has(tag.id) && !options.includeNewer) {
        keep.push({ ...tag, reason: "newer-to-review", why: `built after the in-use image, beyond --keep-newer ${keepNewer}; remove with --include-newer after review` });
        newerToReview.push(tag.tag);
      } else remove.push(tag);
    }
    repositories.push({ repository, inUseEvidence, keep, remove });
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

  if (inventory.live.refs.length === 0 && inventory.configured.length === 0) {
    applyRefusals.push("no in-use runner image evidence (no process env and no env file sets A2A_*IMAGE) — refusing to delete");
  }
  if (blockingUnresolved.length > 0) {
    applyRefusals.push(`in-use or --keep reference(s) not found among local images: ${blockingUnresolved.join(", ")} — cannot prove they are not a candidate`);
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
    skippedRepositories,
    newerToReview,
    recordsToReview,
    reclaimableIsUpperBound: true,
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
  const units = new Set<string>();
  let unreadable = 0;
  let scanned = 0;
  let entries: string[] = [];
  try {
    entries = await readdir(procRoot);
  } catch {
    return { refs, unreadable: 1, scanned, units: [] };
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
    // Split on NUL only: a secret value containing "\nA2A_X_IMAGE=" must not become a key.
    const found = environ.split("\0").flatMap((pair) => (pair.includes("\n") ? [] : parseImageEnv(pair)));
    if (found.length === 0) continue;
    const unit = await readUnit(procRoot, entry);
    if (unit) units.add(unit);
    for (const { key, value } of found) refs.push({ ref: value, source: `pid ${entry}${unit ? ` ${unit}` : ""} ${key}` });
  }
  return { refs, unreadable, scanned, units: [...units].sort() };
}

async function readUnit(procRoot: string, pid: string): Promise<string | undefined> {
  try {
    const cgroup = await readFile(join(procRoot, pid, "cgroup"), "utf8");
    return cgroup.match(/([^/\s]+\.service)/)?.[1];
  } catch {
    return undefined;
  }
}

export type UnitEnvFilesFn = (unit: string) => Promise<string[]>;

/** `systemctl show -p EnvironmentFiles --value <unit>` → the env files systemd really loads. */
export const defaultUnitEnvFiles: UnitEnvFilesFn = (unit) =>
  new Promise((resolve) => {
    execFile("systemctl", ["show", "-p", "EnvironmentFiles", "--value", unit], { encoding: "utf8", timeout: 5_000 }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(String(stdout).split("\n").map((line) => line.trim().replace(/\s+\(ignore_errors=\w+\)$/, "")).filter((line) => line.startsWith("/")));
    });
  });

/**
 * `<live>.<suffix>` is a backup when the live file exists, or when the suffix
 * looks like one even though the live file is gone (an orphaned backup must
 * not be mistaken for a live env file — it would mark a dead image "in use").
 */
export function isEnvBackupName(name: string, siblings: ReadonlySet<string>): boolean {
  if (name.endsWith("~")) return true;
  if (backupOwnerName(name, siblings)) return true;
  const dot = name.indexOf(".");
  if (dot <= 0) return false;
  return looksLikeBackupSuffix(name.slice(dot + 1));
}

/** `bak-…`, `orig`, `pre-…`, `dpkg-old`, a date stamp, … — the part after `<file>.` of a backup copy. */
export function looksLikeBackupSuffix(suffix: string): boolean {
  return /(^|[.-])(bak|backup|orig|old|save|pre|prev|dpkg-old|dpkg-dist|dpkg-new|rpmsave|rpmnew)([.-]|$)|\d{8}/i.test(suffix);
}

/** The live file a backup belongs to: the longest sibling `<sibling>.<suffix>` / `<sibling>~` prefix of `name`. */
export function backupOwnerName(name: string, siblings: ReadonlySet<string>): string | undefined {
  let best: string | undefined;
  for (const sibling of siblings) {
    if (sibling === name || !sibling) continue;
    if ((name.startsWith(`${sibling}.`) || name === `${sibling}~`) && (!best || sibling.length > best.length)) best = sibling;
  }
  return best;
}

/**
 * Env files in `envDir`: live files set the configured image; backups are
 * deploy records owned by their live file (`<live>.<suffix>`), or orphaned.
 * `liveFiles` (systemd EnvironmentFile= of running workers) always count as
 * live, wherever they are and whatever their name looks like.
 */
export async function scanEnvDir(
  envDir = DEFAULT_ENV_DIR,
  liveFiles: readonly string[] = [],
): Promise<{ configured: ImageRef[]; deployRecords: ImageRef[] }> {
  const configured: ImageRef[] = [];
  const deployRecords: ImageRef[] = [];
  let names: string[] = [];
  try {
    names = await readdir(envDir);
  } catch {
    names = [];
  }
  const nameSet = new Set(names);
  const live = new Set(liveFiles.map((file) => resolve(file)));
  const seen = new Set<string>();
  const addLive = (path: string, values: Array<{ key: string; value: string }>): void => {
    for (const { key, value } of values) configured.push({ ref: value, source: `${path} ${key}`, file: path });
  };
  for (const name of names) {
    const path = join(envDir, name);
    const parsed = await readImageEnvFile(path);
    if (!parsed) continue;
    seen.add(path);
    if (live.has(path) || !isEnvBackupName(name, nameSet)) {
      addLive(path, parsed.values);
      continue;
    }
    const ownerName = backupOwnerName(name, nameSet);
    const owner = ownerName ? join(envDir, ownerName) : undefined;
    for (const { key, value } of parsed.values) {
      deployRecords.push({ ref: value, source: `${path} ${key}`, file: path, mtimeMs: parsed.mtimeMs, owner, orphan: !owner });
    }
  }
  for (const path of live) {
    if (seen.has(path)) continue;
    const parsed = await readImageEnvFile(path);
    if (parsed) addLive(path, parsed.values);
    // Its backups live next to it (`<file>.bak-…`, `<file>~`), not in envDir (#2550).
    const dir = dirname(path);
    const base = basename(path);
    let siblings: string[] = [];
    try {
      siblings = await readdir(dir);
    } catch {
      siblings = [];
    }
    for (const name of siblings) {
      if (name === base || !(name === `${base}~` || (name.startsWith(`${base}.`) && looksLikeBackupSuffix(name.slice(base.length + 1))))) continue;
      const backupPath = join(dir, name);
      if (live.has(backupPath)) continue;
      const backup = await readImageEnvFile(backupPath);
      for (const { key, value } of backup?.values ?? []) {
        deployRecords.push({ ref: value, source: `${backupPath} ${key}`, file: backupPath, mtimeMs: backup?.mtimeMs, owner: path, orphan: false });
      }
    }
  }
  return { configured, deployRecords };
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
        for (const { key, value } of parsed?.values ?? []) out.push({ ref: value, source: `${path} ${key}`, file: path, mtimeMs: parsed?.mtimeMs });
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

/** Parse tab-separated `{{json .X}}` columns; never echo engine output in errors (it may hold secrets). */
function parseJsonColumns(stdout: string, columns: number, what: string): unknown[][] {
  const rows: unknown[][] = [];
  for (const [index, line] of stdout.split("\n").entries()) {
    if (!line.trim()) continue;
    const cells = line.split("\t");
    if (cells.length < columns) throw new Error(`could not parse ${what} output (line ${index + 1}: ${cells.length} column(s), expected ${columns})`);
    try {
      rows.push(cells.slice(0, columns).map((cell) => JSON.parse(cell)));
    } catch {
      throw new Error(`could not parse ${what} output (line ${index + 1})`);
    }
  }
  return rows;
}

export async function listEngineImages(engine: RunnerEngine, exec: EngineExec = defaultEngineExec): Promise<EngineImage[]> {
  const ids = await exec(engine, ["image", "ls", "--no-trunc", "--format", "{{.ID}}"]);
  if (ids.code !== 0) throw new Error(`${engine} image ls failed (exit ${ids.code})`);
  const unique = [...new Set(ids.stdout.split("\n").map((line) => line.trim()).filter(Boolean))];
  if (unique.length === 0) return [];
  // Only the fields used here — never Config.Env.
  const fields = ["{{json .Id}}", "{{json .RepoTags}}", "{{json .RepoDigests}}", "{{json .Created}}", "{{json .Size}}"];
  if (engine === "docker") fields.push("{{json .Metadata.LastTagTime}}");
  const inspected = await exec(engine, ["image", "inspect", "--format", fields.join("\t"), ...unique]);
  if (inspected.code !== 0) throw new Error(`${engine} image inspect failed (exit ${inspected.code})`);
  return parseJsonColumns(inspected.stdout, fields.length, `${engine} image inspect`).map(([id, tags, digests, created, size, lastTag]) => ({
    id: String(id ?? ""),
    repoTags: ((tags as string[] | null) ?? []).filter((tag) => tag && !tag.includes("<none>")),
    repoDigests: (digests as string[] | null) ?? [],
    created: String(created ?? ""),
    ...(typeof lastTag === "string" && lastTag ? { lastTagTime: lastTag } : {}),
    sizeBytes: Number(size ?? 0),
  }));
}

export async function listEngineContainers(engine: RunnerEngine, exec: EngineExec = defaultEngineExec): Promise<EngineContainer[]> {
  const ids = await exec(engine, ["ps", "-a", "--no-trunc", "--format", "{{.ID}}"]);
  if (ids.code !== 0) throw new Error(`${engine} ps failed (exit ${ids.code})`);
  const unique = [...new Set(ids.stdout.split("\n").map((line) => line.trim()).filter(Boolean))];
  if (unique.length === 0) return [];
  // Only id/name/image — container inspect also carries Config.Env (task secrets).
  const format = ["{{json .Id}}", "{{json .Name}}", "{{json .Image}}", "{{json .Config.Image}}"].join("\t");
  const inspected = await exec(engine, ["container", "inspect", "--format", format, ...unique]);
  if (inspected.code !== 0) throw new Error(`${engine} container inspect failed (exit ${inspected.code})`);
  return parseJsonColumns(inspected.stdout, 4, `${engine} container inspect`).map(([id, name, image, ref]) => ({
    id: String(id ?? ""),
    name: String(name ?? "").replace(/^\//, ""),
    imageId: String(image ?? ""),
    imageRef: String(ref ?? ""),
  }));
}

export interface CollectOptions {
  engine: RunnerEngine;
  exec?: EngineExec;
  procRoot?: string;
  envDir?: string;
  deployRecordDirs?: readonly string[];
  keepRefs?: readonly string[];
  unitEnvFiles?: UnitEnvFilesFn;
  /** env files the operator named explicitly (`--env-file` / A2A_DOCKER_RUNNER_ENV_FILE): always live evidence. */
  extraLiveFiles?: readonly string[];
}

export async function collectRunnerImageInventory(options: CollectOptions): Promise<RunnerImageInventory> {
  const exec = options.exec ?? defaultEngineExec;
  const [images, containers, live, extraRecords] = await Promise.all([
    listEngineImages(options.engine, exec),
    listEngineContainers(options.engine, exec),
    scanProcessEnv(options.procRoot),
    scanDeployRecordDirs(options.deployRecordDirs ?? []),
  ]);
  const unitEnvFilesFn = options.unitEnvFiles ?? defaultUnitEnvFiles;
  const unitEnvFiles: Record<string, string[]> = {};
  for (const unit of live.units) unitEnvFiles[unit] = (await unitEnvFilesFn(unit)).map((file) => resolve(file));
  const liveFiles = [...new Set([...(options.extraLiveFiles ?? []).map((file) => resolve(file)), ...Object.values(unitEnvFiles).flat()])];
  const envDir = await scanEnvDir(options.envDir, liveFiles);
  return {
    unitEnvFiles,
    engine: options.engine,
    images,
    containers,
    live,
    configured: envDir.configured,
    deployRecords: [...envDir.deployRecords, ...extraRecords],
    keep: (options.keepRefs ?? []).map((ref) => ({ ref, source: "--keep" })),
  };
}

// ── CLI arguments ────────────────────────────────────────────────────────────

export interface ImagesArgs {
  apply: boolean;
  builderCache: boolean;
  includeNewer: boolean;
  values: Record<string, string[]>;
}

const IMAGES_BOOLEAN_FLAGS = new Set(["--apply", "--dry-run", "--builder-cache", "--include-newer"]);
const IMAGES_VALUE_FLAGS = new Set(["--keep", "--repository", "--keep-rollback", "--keep-newer", "--min-age", "--engine", "--env-dir", "--deploy-record-dir", "--env-file"]);

/**
 * Strict parser for `images` (deletion is involved, so nothing is guessed):
 * `--flag value` and `--flag=value` are accepted, a value flag without a value
 * and any unknown flag are errors, and --dry-run with --apply is an error.
 */
export function parseImagesArgs(argv: readonly string[]): ImagesArgs {
  const values: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`images: unexpected argument '${token}'`);
    const eq = token.indexOf("=");
    const name = eq >= 0 ? token.slice(0, eq) : token;
    if (IMAGES_BOOLEAN_FLAGS.has(name)) {
      if (eq >= 0) throw new Error(`images: ${name} takes no value`);
      seen.add(name);
      continue;
    }
    if (!IMAGES_VALUE_FLAGS.has(name)) throw new Error(`images: unknown flag ${name}`);
    const value = eq >= 0 ? token.slice(eq + 1) : argv[index + 1];
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`images: ${name} needs a value`);
    if (eq < 0) index += 1;
    (values[name] ??= []).push(value);
  }
  if (seen.has("--apply") && seen.has("--dry-run")) {
    throw new Error("images: --dry-run and --apply are mutually exclusive (dry-run is already the default)");
  }
  return { apply: seen.has("--apply"), builderCache: seen.has("--builder-cache"), includeNewer: seen.has("--include-newer"), values };
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
    liveUnits: string[];
    configured: ImageRef[];
    deployRecords: ImageRef[];
    containers: Array<{ name: string; imageRef: string; imageId: string }>;
  };
  plan: RunnerImagePlan;
  builderCache: { requested: boolean; command?: string[]; skipped?: string; ok?: boolean; output?: string };
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
  const planOptions: PlanOptions = {
    keepRollback: options.keepRollback,
    minAgeMs: options.minAgeMs,
    nowMs: options.nowMs,
    isRoot: options.isRoot,
    allowRepositories: options.allowRepositories,
    keepNewer: options.keepNewer,
    includeNewer: options.includeNewer,
  };
  const inventory = await collectRunnerImageInventory({ ...options, exec });
  const plan = planRunnerImagePrune(inventory, planOptions);
  const before = await diskSnapshot(options.engine, exec, options.statfsFn);
  // Builder cache: docker only, and only entries older than --min-age (all projects share it).
  const untilHours = Math.max(1, Math.round(plan.minAgeMs / 3_600_000));
  const builderCommand = ["builder", "prune", "-f", "--filter", `until=${untilHours}h`];
  const report: PruneReport = {
    mode: options.apply ? "apply" : "dry-run",
    engine: options.engine,
    rule: `keep in-use (process env, env files, containers, --keep) + ${plan.keepRollback} rollback per worker + rollback-named tags + images built/loaded within ${Math.round(plan.minAgeMs / 3_600_000)}h + ${options.keepNewer ?? DEFAULT_KEEP_NEWER} image(s) built after the in-use one (more are listed in plan.newerToReview${options.includeNewer ? " and removed: --include-newer" : ""}); only ${RUNNER_IMAGE_REPOSITORY.source} repositories a running process or live env file uses (or --repository)`,
    evidence: {
      live: inventory.live.refs,
      liveScanned: inventory.live.scanned,
      liveUnreadable: inventory.live.unreadable,
      liveUnits: inventory.live.units,
      configured: inventory.configured,
      deployRecords: inventory.deployRecords,
      containers: inventory.containers.map(({ name, imageRef, imageId }) => ({ name, imageRef, imageId })),
    },
    plan,
    builderCache: !options.builderCache
      ? { requested: false }
      : options.engine === "docker"
        ? { requested: true, command: [options.engine, ...builderCommand] }
        : { requested: true, skipped: `${options.engine} has no builder cache prune here; nothing done` },
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
  if (!recheck.applyAllowed) {
    report.plan = { ...plan, applyAllowed: false, applyRefusals: recheck.applyRefusals.map((reason) => `re-check: ${reason}`) };
    report.ok = false;
    return report;
  }
  const stillCandidates = new Set(recheck.candidates.map((tag) => `${tag.tag}@${tag.id}`));
  report.removed = [];
  for (const tag of plan.candidates) {
    if (!stillCandidates.has(`${tag.tag}@${tag.id}`)) {
      report.removed.push({ tag: tag.tag, id: tag.id, ok: false, stderr: "skipped: no longer a candidate on re-check" });
      continue;
    }
    // The tag may have been re-pointed (docker load) since: only remove the planned image.
    const current = await exec(options.engine, ["image", "inspect", "--format", "{{json .Id}}", tag.tag]);
    let currentId = "";
    try {
      currentId = current.code === 0 ? String(JSON.parse(current.stdout.trim())) : "";
    } catch {
      currentId = "";
    }
    if (currentId !== tag.id) {
      report.removed.push({ tag: tag.tag, id: tag.id, ok: false, stderr: `skipped: tag now points at ${currentId || "nothing"}` });
      continue;
    }
    // No -f: the engine refuses an image a container still references.
    const result = await exec(options.engine, ["image", "rm", tag.tag]);
    report.removed.push({ tag: tag.tag, id: tag.id, ok: result.code === 0, ...(result.code === 0 ? {} : { stderr: result.stderr.trim().slice(0, 300) }) });
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
  isRoot?: boolean;
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    // Not unref'd: a stuck engine call holds no handle of its own, so this timer
    // must keep the process alive until it fires. `finally` clears it on success.
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** #2547 doctor probe: warn-only. Low disk on / or the engine root, plus how much stale runner images would free. */
export async function checkRunnerImageDisk(options: RunnerImageDiskCheckOptions): Promise<OpsCheck> {
  const timeoutMs = options.timeoutMs ?? DOCTOR_INVENTORY_TIMEOUT_MS;
  const paths = ["/"];
  if (options.engineReady && options.engine) {
    const root = await withTimeout(engineRootDir(options.engine, options.exec), timeoutMs, "engine info").catch(() => undefined);
    if (root) paths.push(root);
  }
  const usages = (await Promise.all(paths.map((path) => diskUsage(path, options.statfsFn)))).filter((usage): usage is DiskUsage => Boolean(usage));
  if (usages.length === 0) return { status: "warn", message: "could not read free space on /" };
  const isLow = (usage: DiskUsage): boolean => usage.freeRatio < DISK_WARN_FREE_RATIO || usage.freeBytes < DISK_WARN_FREE_BYTES;
  const worst = [...usages].sort((a, b) => a.freeRatio - b.freeRatio || a.freeBytes - b.freeBytes)[0];
  const low = usages.find(isLow);
  const detail: Record<string, unknown> = {
    disks: usages.map((usage) => ({ path: usage.path, freeBytes: usage.freeBytes, freePercent: Math.round(usage.freeRatio * 1000) / 10 })),
    thresholds: { freePercent: DISK_WARN_FREE_RATIO * 100, freeBytes: DISK_WARN_FREE_BYTES },
  };
  let reclaim = "";
  if (options.engineReady && options.engine) {
    try {
      const inventory = await withTimeout(collectRunnerImageInventory({ ...options, engine: options.engine }), timeoutMs, "runner image inventory");
      const plan = planRunnerImagePrune(inventory, { nowMs: options.nowMs, isRoot: options.isRoot });
      detail.staleRunnerTags = plan.candidates.map((tag) => tag.tag);
      detail.reclaimableBytes = plan.reclaimableBytes;
      detail.reclaimableIsUpperBound = true;
      if (plan.newerToReview.length > 0) detail.newerToReview = plan.newerToReview;
      if (!plan.applyAllowed) detail.evidenceIncomplete = plan.applyRefusals;
      if (plan.candidates.length > 0) {
        const note = plan.applyAllowed ? "" : " (evidence incomplete — list is indicative only)";
        reclaim = `; ${plan.candidates.length} stale runner image tag(s), up to ${formatBytes(plan.reclaimableBytes)} reclaimable${note} — review with: a2a-docker-runner images (dry-run)`;
      }
    } catch (error) {
      detail.inventoryError = error instanceof Error ? error.message : "runner image inventory failed";
    }
  }
  const describe = (usage: DiskUsage): string => `${formatBytes(usage.freeBytes)} free on ${usage.path} (${Math.round(usage.freeRatio * 1000) / 10}%)`;
  if (low) {
    return { status: "warn", message: `low disk: ${describe(low)}, below ${DISK_WARN_FREE_RATIO * 100}% or ${formatBytes(DISK_WARN_FREE_BYTES)}${reclaim}`, detail };
  }
  return { status: "ok", message: `${describe(worst)}${reclaim}`, detail };
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
