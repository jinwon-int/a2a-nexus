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
  | "unverified-repository"
  | "unverified-rollback"
  | "unknown-build-order";

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
  /**
   * Workers whose deploy records filled the rollback slot with an older image
   * while the newest image built before their in-use image is named by none of
   * them — the latest switch may be unrecorded (e.g. its backup sits in a
   * directory not passed with --deploy-record-dir). That image is kept as well.
   */
  recordGaps: string[];
  /** tags kept only because of a record gap (unique images the gap pass added). */
  recordGapImages: string[];
  /** tags kept only because their creation time carries no build order (sentinel / unparseable): review by hand. */
  unknownOrderToReview: string[];
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

/** More images than this kept only as record gaps for one worker refuses --apply (#2558). */
export const RECORD_GAP_APPLY_LIMIT = 3;
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

/** Times at or before this carry no order: docker's 0001-01-01 "never" and epoch-0 reproducible builds. */
const CREATED_FLOOR_MS = Date.UTC(1971, 0, 1);

function effectiveMs(image: Pick<EngineImage, "created" | "lastTagTime">): number {
  const times = [image.created, image.lastTagTime]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value) && value > CREATED_FLOOR_MS); // docker reports 0001-01-01 for "never"
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
  // Build order matters whenever a rollback is kept or the newer-than-in-use
  // line protects a staged rollout (kept up to --keep-newer even with
  // --include-newer, the rest listed for review without it); only then may an
  // unknown Created block (#2560 review r1-r3).
  const needOrder = keepRollback > 0 || keepNewer > 0 || !options.includeNewer;
  // Same floor as effectiveMs: docker's 0001-01-01 and a SOURCE_DATE_EPOCH=0
  // build (1970-01-01) carry no build order, so they count as unknown (#2554).
  const createdMs = (id: string): number => {
    const ms = Date.parse(byId.get(id)?.created ?? "");
    return Number.isFinite(ms) && ms > CREATED_FLOOR_MS ? ms : Number.NaN;
  };
  const runsOtherRunner = (file: string): boolean =>
    [...(workers.get(file)?.ids ?? [])].some((id) => byId.get(id)?.repoTags.some((tag) => isRunnerRepository(tag)) ?? false);

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
  const recordGaps: string[] = [];
  const recordGapImages: string[] = [];
  // One entry per image id: a tag of the same image in a second runner
  // repository must not count the image twice (#2559).
  const recordGapImageIds = new Set<string>();
  const unknownOrderToReview: string[] = [];
  const resolvedRecords = inventory.deployRecords
    .filter((record) => !record.orphan)
    .map((record) => ({ record, id: resolveRef(record.ref, images) }))
    .filter((entry): entry is { record: ImageRef; id: string } => Boolean(entry.id))
    .sort((a, b) => (b.record.mtimeMs ?? 0) - (a.record.mtimeMs ?? 0));
  // An env file name shared by several workers (same name in different
  // directories, any repository) cannot tell whose history an owner-less deploy
  // record is: such records fill no slot and are kept for review.
  const nameCount = new Map<string, number>();
  for (const worker of workers.values()) {
    for (const name of new Set([...worker.files].map((file) => basename(file)))) nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
  }
  const ambiguousNames = new Set([...nameCount].filter(([, count]) => count > 1).map(([name]) => name));
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
    // (2) deploy records without a known owner that carry its env file name,
    // (3) the newest non-recent image built before that worker's in-use image
    // not already kept for another reason (#2551 r3: a fallback must never use
    // a slot on an image kept anyway and push out the worker's own previous).
    const repoWorkers = [...workers.values()]
      .filter((worker) => [...worker.ids].some((id) => inUseIds.has(id)))
      .sort((a, b) => a.key.localeCompare(b.key));
    const nameOwner = new Map<string, Worker>(); // unambiguous env file name → its worker of this repository
    for (const worker of repoWorkers) {
      for (const file of worker.files) if (!ambiguousNames.has(basename(file))) nameOwner.set(basename(file), worker);
    }
    const recordWorker = (record: ImageRef): Worker | undefined => {
      const owner = record.owner;
      if (owner) return repoWorkers.find((worker) => worker.files.has(owner));
      return record.file ? nameOwner.get(basename(record.file)) : undefined;
    };
    const restTag = (id: string): PlannedTag | undefined => rest.find((tag) => tag.id === id);
    // A rollback must be an image the worker ran before: built before its
    // in-use image. Recent images are kept anyway and never use a slot.
    const inUseMsOf = new Map(repoWorkers.map((worker) => [worker, Math.max(...[...worker.ids].filter((id) => inUseIds.has(id)).map(createdMs).filter(Number.isFinite), Number.NEGATIVE_INFINITY)]));
    const builtBefore = (worker: Worker, id: string): boolean => createdMs(id) < (inUseMsOf.get(worker) ?? Number.NEGATIVE_INFINITY);
    // Backups of a live env file that is no worker of this repository (its
    // worker moved to another repository, e.g. a flavor switch): still that
    // file's rollback — keep its N newest here, before any worker's fallback.
    const foreignPicked = new Map<string, number>();
    for (const { record, id } of resolvedRecords) {
      const owner = record.owner;
      if (!owner || recordWorker(record)) continue;
      const tag = restTag(id);
      const count = foreignPicked.get(owner) ?? 0;
      if (!tag || rollback.has(id) || isRecent(tag) || count >= keepRollback) continue;
      // "another repository" only when the owner's env file really resolves to
      // a runner image elsewhere; an unresolved or non-runner reference says so (#2554).
      rollback.set(id, runsOtherRunner(owner)
        ? `previous deploy of ${owner} (${record.source}), which now runs another repository`
        : `previous deploy of ${owner} (${record.source}), whose env file names no running runner image`);
      foreignPicked.set(owner, count + 1);
    }
    // Owner-less records no worker of this repository can claim (no env file
    // name matches, or several workers share it): never fill a slot, never
    // deleted here — kept and listed for a manual decision.
    const unattributed = new Map<string, string>();
    for (const { record, id } of resolvedRecords) {
      if (record.owner || recordWorker(record) || !restIds.has(id) || rollback.has(id) || unattributed.has(id)) continue;
      const shared = record.file !== undefined && ambiguousNames.has(basename(record.file));
      unattributed.set(id, shared
        ? `named by deploy record ${record.source}, whose file name several worker env files share`
        : `named by deploy record ${record.source}, which matches no worker env file name`);
    }
    // Two passes so no worker order matters: first every worker's own records
    // (1) its backups, (2) owner-less records carrying its env file name; then
    // (3) each worker's fallback — the newest non-recent image built before its
    // in-use image that is not already kept for another reason (a record image
    // kept as someone's rollback or as unattributed never uses this slot).
    const picked = new Map<Worker, number>();
    const fallbackPicks = new Map<Worker, string>(); // the image a worker's fallback (pass 3) took as its rollback
    // `fromRecord`: the worker's own deploy record names this image. An
    // unattributed record pointing at the same image does not outrank it — the
    // worker's real previous deploy is its rollback, not a review item (#2554).
    // Only a fallback pick must leave unattributed record images alone.
    const take = (worker: Worker, id: string, why: string, fromRecord: boolean): void => {
      const tag = restTag(id);
      const count = picked.get(worker) ?? 0;
      // A worker's own record proves the image was a previous deploy even when
      // its Created carries no order (sentinel / unparseable) (#2560 review).
      const orderProvenByRecord = fromRecord && !Number.isFinite(createdMs(id));
      if (count >= keepRollback || rollback.has(id) || (!fromRecord && unattributed.has(id)) || !tag || isRecent(tag) || (!builtBefore(worker, id) && !orderProvenByRecord)) return;
      rollback.set(id, why);
      // The final rendering checks rollback first; the delete matters to the
      // "also named by …" pass below, so a taken record image never reads "not taken".
      unattributed.delete(id);
      // An order-unknown image is kept as the record says, but uses no slot and
      // is no safety-net floor: the slot (and the floor) still go to an ordered
      // record or the fallback, so the real previous image is never pushed out (#2560 r2).
      if (orderProvenByRecord) {
        rollback.set(id, `${why} — build order unknown, kept without using a rollback slot`);
        return;
      }
      picked.set(worker, count + 1);
      if (!fromRecord) fallbackPicks.set(worker, id);
    };
    const hadOwnRecords = new Set<Worker>();
    const repoImageIds = new Set(tags.map((tag) => tag.id));
    for (const worker of repoWorkers) {
      const own = resolvedRecords.filter((entry) => recordWorker(entry.record) === worker);
      // Only records naming an image of this repository make the fallback note
      // "no eligible deploy record left" (a flavor switch's backups do not, #2554).
      if (own.some((entry) => repoImageIds.has(entry.id))) hadOwnRecords.add(worker);
      for (const { record, id } of own) if (record.owner) take(worker, id, `previous deploy of ${record.owner} (${record.source})`, true);
      for (const { record, id } of own) if (!record.owner) take(worker, id, `deploy record ${record.source} (for ${worker.key})`, true);
    }
    let rollbackUnknown = false;
    const unknownWorkers = new Set<Worker>();
    for (const worker of repoWorkers) {
      // A worker with ANY in-use image of unknown creation time (unparseable,
      // or a sentinel) cannot tell which image it ran before: refuse --apply,
      // and report nothing of this repository as a candidate (#2554). Only
      // when build order matters (needOrder: a rollback slot or the newer line).
      const unknownInUse = [...worker.ids].filter((id) => inUseIds.has(id) && !Number.isFinite(createdMs(id)));
      if (needOrder && unknownInUse.length > 0) {
        unknownWorkers.add(worker);
        applyRefusals.push(`in-use image of ${worker.key} in ${repository} has no usable creation time — cannot ${keepRollback > 0 ? "pick its rollback" : "tell a staged rollout (newer-than-in-use line) apart"}`);
        rollbackUnknown = true;
        continue;
      }
      const fallback = rest.filter((tag) => builtBefore(worker, tag.id)).sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
      const note = hadOwnRecords.has(worker) ? "no eligible deploy record left" : "no deploy record";
      for (const tag of fallback) take(worker, tag.id, `newest image built before the in-use image of ${worker.key} (${note})`, false);
    }
    // A worker's own record that was not taken (slot full, or not eligible)
    // while an unmatched record names the same image: still kept for review,
    // but say whose history it also is, not "matches no worker" alone (#2554).
    for (const { record, id } of resolvedRecords) {
      const owner = recordWorker(record);
      const why = unattributed.get(id);
      if (!owner || !why || why.includes(`also named by ${owner.key}'s own deploy record ${record.source}`)) continue;
      const cause = unknownWorkers.has(owner) ? "its in-use creation time is unknown" : "slot full, or not built before its in-use image";
      unattributed.set(id, `${why}; also named by ${owner.key}'s own deploy record ${record.source}, not taken as its rollback (${cause})`);
    }
    // (4) Safety net (#2557): records name only the switches that left a backup
    // in a scanned directory, ordered by file mtime. When a worker's records
    // took its slot, every image built after the newest of those record picks
    // and before its in-use image may be the one it ran just before (an
    // unrecorded switch, a record outranked by mtime, or a loaded but never
    // deployed build in between — they cannot be told apart). Keep every such
    // unprotected non-recent image and report it per worker. With complete,
    // well-ordered records that range is empty: nothing extra, no gap.
    if (keepRollback > 0) {
      // Floors use what passes 1-3 kept, so no worker's gap additions move
      // another worker's floor (the result does not depend on worker order).
      const keptBeforeGaps = new Set(rollback.keys());
      for (const worker of repoWorkers) {
        if (!Number.isFinite(inUseMsOf.get(worker) ?? Number.NaN)) continue;
        const ownIds = new Set(resolvedRecords.filter((entry) => recordWorker(entry.record) === worker).map((entry) => entry.id));
        // The floor is the newest image the worker's own records name that is
        // kept anyway: kept by passes 1-3 (its own records, or another worker's
        // rollback), protected (container, --keep, in use elsewhere) or recent.
        // Workers switching together share their record images, so a second
        // worker's records must not count as "missing" (#2558 r2).
        const repoIds = new Set(tags.map((tag) => tag.id));
        const keptAnyway = (id: string): boolean => {
          const restEntry = restTag(id);
          return keptBeforeGaps.has(id) || restEntry === undefined || isRecent(restEntry);
        };
        const floorIds = [...ownIds].filter((id) => repoIds.has(id) && builtBefore(worker, id) && keptAnyway(id));
        // Records that name only order-unknown images give no floor: then every
        // ordered image built before the in-use one is in range (#2560 r3). Judged
        // by the worker's own records, not by which worker took the image first:
        // a second worker sharing that record gets the same open range (#2554).
        const unknownPicks = [...ownIds].filter((id) => repoIds.has(id) && !Number.isFinite(createdMs(id)) && keptBeforeGaps.has(id));
        if (floorIds.length === 0 && unknownPicks.length === 0) continue;
        const openFloor = floorIds.length === 0;
        const floorMs = floorIds.length > 0 ? Math.max(...floorIds.map(createdMs)) : Number.NEGATIVE_INFINITY;
        const floorTag = floorIds.length > 0
          ? tags.find((tag) => tag.id === floorIds.find((id) => createdMs(id) === floorMs))?.tag ?? "its recorded rollback"
          : `${tags.find((tag) => tag.id === unknownPicks[0])?.tag ?? "its recorded rollback"} (build order unknown)`;
        const seen = new Set<string>();
        const range = rest
          .filter((tag) => !floorIds.includes(tag.id) && createdMs(tag.id) >= floorMs && builtBefore(worker, tag.id) && !isRecent(tag))
          .sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
        let unrecordedAdded = 0; // kept although no record of any worker names it
        let outrankedAdded = 0; // kept although the worker's own record names it (slot lost to an older record)
        for (const tag of range) {
          if (seen.has(tag.id)) continue;
          seen.add(tag.id);
          // The worker's own fallback pick is its rollback, not a gap: no report
          // line, so the gap report count is not inflated (#2554).
          if (fallbackPicks.get(worker) === tag.id) continue;
          // An own record image in the range was eligible but lost to the slot limit.
          const outranked = ownIds.has(tag.id);
          const other = outranked ? undefined : resolvedRecords.find((entry) => entry.id === tag.id && recordWorker(entry.record) && recordWorker(entry.record) !== worker);
          // "Already kept" means kept by passes 1-3 (or unattributed), never by
          // another worker's gap pass: the count, the refusal and the wording do
          // not depend on the order the workers are visited in (#2559).
          const already = keptBeforeGaps.has(tag.id) ? rollback.get(tag.id) : unattributed.has(tag.id) ? "an unattributed deploy record" : undefined;
          const cause = outranked
            ? "its own deploy record names it but a record of an older image took the slot (records are taken owner backups first, then by file mtime)"
            : other
              ? `none of its deploy records names it; a record of ${recordWorker(other.record)?.key} does — it may be that worker's history`
              : openFloor
                ? "none of its deploy records names it, and the image its records do name has no usable creation time — any older image may be the one it ran before"
                : "none of its deploy records names it — check that every directory holding its env backups is passed with --deploy-record-dir";
          if (!already) {
            // A gap image two workers share keeps the first worker's wording; both count it.
            if (!rollback.has(tag.id)) {
              rollback.set(tag.id, openFloor
                ? `built before the in-use image of ${worker.key}, whose records name only ${floorTag} — its previous deploy cannot be told apart; kept besides the records`
                : `built after ${floorTag} (the newest image ${worker.key}'s records keep) and before its in-use image — ${outranked ? "its own record was outranked" : "the latest switch may be unrecorded"}; kept besides the records`);
            }
            if (!recordGapImageIds.has(tag.id)) {
              recordGapImageIds.add(tag.id);
              recordGapImages.push(tag.tag);
            }
            if (outranked) outrankedAdded += 1;
            else if (!other) unrecordedAdded += 1;
          }
          recordGaps.push(openFloor
            ? `${worker.key}: ${tag.tag} was built before its in-use image and its deploy records name only ${floorTag}; ${cause}${already ? ` (already kept: ${already})` : " — kept"}`
            : `${worker.key}: ${tag.tag} was built after its newest recorded rollback (${floorTag}) and before its in-use image; ${cause}${already ? ` (already kept: ${already})` : " — kept"}`);
        }
        // Bound the accumulation: a floor stuck on an old record keeps one more
        // image per rollout. Past the limit, stop --apply so the cause gets
        // fixed instead of the disk filling up again (#2547). Images another
        // worker's records name are that worker's history and never count:
        // workers on different rollout cadences are normal (#2558 r3).
        if (unrecordedAdded > RECORD_GAP_APPLY_LIMIT) {
          applyRefusals.push(openFloor
            ? `${worker.key} in ${repository}: ${unrecordedAdded} images that no deploy record names are kept as record gaps (more than ${RECORD_GAP_APPLY_LIMIT}) — its deploy records name only ${floorTag}, so its previous deploy cannot be told apart from older builds; review plan.unknownOrderToReview and replace the record that names it`
            : `${worker.key} in ${repository}: ${unrecordedAdded} images that no deploy record names are kept as record gaps (more than ${RECORD_GAP_APPLY_LIMIT}) — its deploy records look incomplete; pass every directory holding its env backups with --deploy-record-dir`);
        }
        if (outrankedAdded > RECORD_GAP_APPLY_LIMIT) {
          applyRefusals.push(`${worker.key} in ${repository}: ${outrankedAdded} images its own deploy records name are kept as record gaps (more than ${RECORD_GAP_APPLY_LIMIT}) — an older record keeps taking its rollback slot (owner backups are taken first); rotate its old env backups (env-backups --prune)`);
        }
      }
    }
    if (repoWorkers.length === 0) {
      // --repository opt-in without any worker: keep N newest non-recent images
      // besides those already kept for a record (counted on their own).
      let optInPicked = 0;
      const fallback = rest.filter((tag) => !isRecent(tag)).sort((a, b) => Date.parse(b.created) - Date.parse(a.created));
      for (const tag of fallback) {
        if (optInPicked >= keepRollback) break;
        if (rollback.has(tag.id) || unattributed.has(tag.id)) continue;
        rollback.set(tag.id, "newest image (opted-in repository without a worker)");
        optInPicked += 1;
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
      if (why) {
        keep.push({ ...tag, reason: "rollback", why });
        if (!Number.isFinite(createdMs(tag.id))) unknownOrderToReview.push(tag.tag);
      }
      else if (isRecent(tag)) keep.push({ ...tag, reason: "recent", why: `built/loaded ${tag.effectiveTime}` });
      else if (unattributed.has(tag.id)) {
        keep.push({ ...tag, reason: "unattributed-record", why: unattributed.get(tag.id) });
        recordsToReview.push(tag.tag);
      }
      else if (rollbackUnknown) keep.push({ ...tag, reason: "unverified-rollback", why: `an in-use image of this repository has no usable creation time — ${keepRollback > 0 ? "its rollback" : "a staged rollout"} cannot be told apart, so nothing here is a candidate` });
      else if (needOrder && !Number.isFinite(createdMs(tag.id))) {
        keep.push({ ...tag, reason: "unknown-build-order", why: `creation time ${tag.created || "missing"} carries no build order (0001-01-01, epoch-0 or unparseable) — it may be a previous deploy or a staged rollout` });
        unknownOrderToReview.push(tag.tag);
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
    recordGaps,
    recordGapImages,
    unknownOrderToReview,
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
  // A relative --env-dir must give the same absolute paths the live file set
  // (resolved) and the backup owners are compared against (#2554).
  envDir = resolve(envDir);
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

/**
 * Env files of `images`: every `--env-file` and `A2A_DOCKER_RUNNER_ENV_FILE` are live
 * evidence (a flag does not hide the env var's file, #2554); the first `--env-file`,
 * else the env var, supplies CLI settings (undefined → the CLI default).
 */
export function imagesEnvFiles(flagFiles: readonly string[], envVarFile: string | undefined): { live: string[]; settings: string | undefined } {
  const fromEnv = envVarFile?.trim() || undefined;
  const live = [...new Set([...flagFiles, ...(fromEnv ? [fromEnv] : [])])];
  return { live, settings: flagFiles[0] ?? fromEnv };
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
      if (plan.recordGaps.length > 0) {
        detail.recordGapReports = plan.recordGaps.length;
        detail.recordGapImages = plan.recordGapImages.length;
      }
      if (plan.unknownOrderToReview.length > 0) detail.unknownOrderToReview = plan.unknownOrderToReview.length;
      if (!plan.applyAllowed) detail.evidenceIncomplete = plan.applyRefusals;
      if (plan.candidates.length > 0) {
        const note = plan.applyAllowed ? "" : " (evidence incomplete — list is indicative only)";
        reclaim = `; ${plan.candidates.length} stale runner image tag(s), up to ${formatBytes(plan.reclaimableBytes)} reclaimable${note} — review with: a2a-docker-runner images (dry-run)`;
      }
      if (plan.recordGaps.length > 0) {
        const kept = plan.recordGapImages.length > 0 ? `${plan.recordGapImages.length} extra runner image(s) kept for ` : "";
        reclaim += `; ${kept}${plan.recordGaps.length} deploy record gap report(s) — review plan.recordGaps in: a2a-docker-runner images (dry-run)`;
      }
      if (plan.unknownOrderToReview.length > 0) reclaim += `; ${plan.unknownOrderToReview.length} runner image tag(s) kept because their creation time carries no build order — review plan.unknownOrderToReview in: a2a-docker-runner images (dry-run)`;
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
