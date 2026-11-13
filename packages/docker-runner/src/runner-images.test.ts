// #2547: runner image retention — keep in-use + N rollback per worker, dry-run by default, fail closed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  checkRunnerImageDisk,
  imagesEnvFiles,
  isEnvBackupName,
  listEngineContainers,
  normalizeRef,
  parseImageEnv,
  parseImagesArgs,
  planRunnerImagePrune,
  pruneRunnerImages,
  RECORD_GAP_APPLY_LIMIT,
  resolveRef,
  scanDeployRecordDirs,
  scanEnvDir,
  scanProcessEnv,
  type EngineContainer,
  type EngineExec,
  type EngineImage,
  type ImageRef,
  type RunnerImageInventory,
  type StatfsFn,
} from "./runner-images.js";

const NOW = Date.parse("2026-11-12T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;
const R = "a2a-docker-runner-claude";
const ENV = "/etc/default/a2a-hermes-worker";

function image(id: string, tags: string[], ageDays: number, extra: Partial<EngineImage> = {}): EngineImage {
  return {
    id: `sha256:${id}`,
    repoTags: tags,
    repoDigests: [],
    created: new Date(NOW - ageDays * DAY).toISOString(),
    sizeBytes: Math.round(1.9 * GB),
    ...extra,
  };
}

// A worker-node shape: one tag in use, three older runner tags, plus non-runner images.
const IMAGES: EngineImage[] = [
  image("aaa", [`${R}:ffc530e-claude-2.1.322`], 5),
  image("bbb", [`${R}:666becb-claude-2.1.322`], 6),
  image("ccc", [`${R}:573ca08-claude-2.1.322`], 7),
  image("ddd", [`${R}:573ca08-claude-2.1.318`], 9),
  image("eee", ["swift:6.0-noble"], 30, { sizeBytes: 4 * GB }),
  image("fff", ["python:3.11"], 60),
];

const inUse = (ref = `${R}:ffc530e-claude-2.1.322`, file = ENV): { live: RunnerImageInventory["live"]; configured: ImageRef[] } => ({
  live: { refs: [{ ref, source: "pid 10 a2a-hermes-worker.service A2A_DOCKER_RUNNER_IMAGE" }], unreadable: 0, scanned: 40, units: ["a2a-hermes-worker.service"] },
  configured: [{ ref, source: `${file} A2A_DOCKER_RUNNER_IMAGE`, file }],
});

function inventory(overrides: Partial<RunnerImageInventory> = {}): RunnerImageInventory {
  return { engine: "docker", images: IMAGES, containers: [], ...inUse(), deployRecords: [], keep: [], ...overrides };
}

const record = (ref: string, owner: string | undefined, ageDays: number, extra: Partial<ImageRef> = {}): ImageRef => ({
  ref,
  source: `${owner ?? "/backups"}.bak-${ageDays}d A2A_DOCKER_RUNNER_IMAGE`,
  mtimeMs: NOW - ageDays * DAY,
  owner,
  orphan: false,
  ...extra,
});

const tagsOf = (list: Array<{ tag: string }>): string[] => list.map((entry) => entry.tag).sort();
const reasonOf = (plan: ReturnType<typeof planRunnerImagePrune>, needle: string): string | undefined =>
  plan.repositories.flatMap((repo) => repo.keep).find((tag) => tag.tag.includes(needle))?.reason;

// ── retention rule ───────────────────────────────────────────────────────────

test("#2547 keeps the in-use tag plus one rollback built before it and lists the rest", () => {
  const plan = planRunnerImagePrune(inventory(), { nowMs: NOW, isRoot: true });
  assert.equal(reasonOf(plan, "ffc530e"), "in-use");
  assert.equal(reasonOf(plan, "666becb"), "rollback");
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:573ca08-claude-2.1.318`, `${R}:573ca08-claude-2.1.322`]);
  assert.equal(plan.reclaimableBytes, 2 * Math.round(1.9 * GB));
  assert.equal(plan.applyAllowed, true);
});

test("#2547 never plans non-runner images (swift, python, node) even when old and unused", () => {
  const plan = planRunnerImagePrune(inventory(), { nowMs: NOW, isRoot: true });
  assert.deepEqual(plan.repositories.map((repo) => repo.repository), [R]);
  assert.ok(plan.candidates.every((tag) => tag.tag.startsWith(`${R}:`)));
});

test("#2547 the worker's own newest env backup picks the rollback over a newer unused tag", () => {
  const plan = planRunnerImagePrune(
    inventory({ deployRecords: [record(`${R}:573ca08-claude-2.1.322`, ENV, 20), record(`${R}:573ca08-claude-2.1.318`, ENV, 2)] }),
    { nowMs: NOW, isRoot: true },
  );
  const rollback = plan.repositories[0].keep.find((tag) => tag.reason === "rollback" && /previous deploy of/.test(tag.why ?? ""));
  assert.equal(rollback?.tag, `${R}:573ca08-claude-2.1.318`);
  assert.match(rollback?.why ?? "", /previous deploy of \/etc\/default\/a2a-hermes-worker/);
  // #2557: tags built after the recorded rollback and before the in-use one cannot be told from
  // an unrecorded switch: kept as well and reported per worker (573ca08-322 is also named by an
  // older record of the same worker, outranked by mtime).
  assert.equal(reasonOf(plan, "666becb"), "rollback");
  assert.equal(reasonOf(plan, "573ca08-claude-2.1.322"), "rollback");
  assert.equal(plan.recordGaps.length, 2);
  assert.ok(plan.recordGaps.some((gap) => /573ca08-claude-2\.1\.322.*own deploy record names it/.test(gap)));
  assert.ok(plan.recordGaps.some((gap) => /666becb.*--deploy-record-dir/.test(gap)));
  assert.deepEqual(plan.candidates, []);
});

test("#2547 two workers on the same repository each keep their own rollback (review F3)", () => {
  const second = "/etc/default/a2a-hermes-worker-secondary";
  const images = [...IMAGES, image("ggg", [`${R}:second-current`], 5)];
  const plan = planRunnerImagePrune(
    inventory({
      images,
      configured: [...inUse().configured, ...inUse(`${R}:second-current`, second).configured],
      deployRecords: [record(`${R}:573ca08-claude-2.1.318`, ENV, 1), record(`${R}:573ca08-claude-2.1.322`, second, 3)],
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "2.1.318"), "rollback");
  assert.equal(reasonOf(plan, "573ca08-claude-2.1.322"), "rollback");
  // #2557: 666becb lies between each worker's recorded rollback and its in-use image — kept once,
  // reported for both workers.
  assert.equal(reasonOf(plan, "666becb"), "rollback");
  assert.ok(plan.recordGaps.some((gap) => gap.startsWith(`${ENV}:`) && gap.includes("666becb")));
  assert.ok(plan.recordGaps.some((gap) => gap.startsWith(`${second}:`) && gap.includes("666becb")));
  assert.deepEqual(plan.candidates, []);
});

test("#2547 an orphaned backup never takes the rollback slot", () => {
  const plan = planRunnerImagePrune(
    inventory({ deployRecords: [record(`${R}:573ca08-claude-2.1.318`, undefined, 0.5, { orphan: true })] }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "666becb"), "rollback");
  assert.ok(plan.candidates.some((tag) => tag.tag.endsWith("2.1.318")));
});

test("#2547 an image referenced by any container (stopped egress proxy) is never a candidate", () => {
  const containers: EngineContainer[] = [{ id: "c1", name: "a2a-egress-proxy", imageId: "sha256:ddd", imageRef: `${R}:573ca08-claude-2.1.318` }];
  const plan = planRunnerImagePrune(inventory({ containers }), { nowMs: NOW, isRoot: true });
  assert.equal(reasonOf(plan, "2.1.318"), "container");
  assert.ok(!plan.candidates.some((tag) => tag.id === "sha256:ddd"));
});

test("#2547 min-age counts from the later of build and load time (docker load keeps Created) (review F2)", () => {
  const images = [...IMAGES, image("hhh", [`${R}:loaded-today`], 9, { lastTagTime: new Date(NOW - 0.5 * DAY).toISOString() })];
  const plan = planRunnerImagePrune(inventory({ images }), { nowMs: NOW, isRoot: true });
  assert.equal(reasonOf(plan, "loaded-today"), "recent");
  assert.ok(!plan.candidates.some((tag) => tag.tag.endsWith("loaded-today")));
});

test("#2547 fallback rollback is never a newer, not-yet-switched image (review F4)", () => {
  const images = [image("aaa", [`${R}:current`], 10), image("nnn", [`${R}:newer-unswitched`], 4), image("ooo", [`${R}:previous`], 20)];
  const plan = planRunnerImagePrune(inventory({ images, ...inUse(`${R}:current`) }), { nowMs: NOW, isRoot: true });
  assert.equal(reasonOf(plan, "previous"), "rollback");
});

test("#2547 an image built after the in-use one is never removed, even with no load time (podman) (round-2 major)", () => {
  // podman: no LastTagTime, so a 4-day-old build loaded today looks old by age alone.
  const images = [image("aaa", [`${R}:current`], 10), image("nnn", [`${R}:next-rollout`], 4), image("ooo", [`${R}:previous`], 20), image("ppp", [`${R}:ancient`], 30)];
  const plan = planRunnerImagePrune(inventory({ engine: "podman", images, ...inUse(`${R}:current`) }), { nowMs: NOW, isRoot: true });
  assert.equal(reasonOf(plan, "next-rollout"), "newer-than-in-use");
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:ancient`]);
});

test("#2547 a reference matching several image ids protects all of them (round-2 minor)", () => {
  const images = [image("aaa", [`localhost/${R}:x`], 5), image("bbb", [`${R}:x`], 5), image("ccc", [`${R}:old`], 30)];
  const plan = planRunnerImagePrune(inventory({ images, ...inUse(`${R}:x`) }), { nowMs: NOW, isRoot: true, keepRollback: 0 });
  assert.equal(plan.repositories[0].keep.filter((tag) => tag.reason === "in-use").length, 2);
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:old`]);
});

test("#2547 --keep-rollback 0, rollback-named tags and --keep refs", () => {
  const images = [...IMAGES, image("ggg", [`${R}:rollback-2.1.304`], 40), image("hhh", [`${R}:pinned`], 50)];
  const plan = planRunnerImagePrune(inventory({ images, keep: [{ ref: `${R}:pinned`, source: "--keep" }] }), { nowMs: NOW, isRoot: true, keepRollback: 0 });
  assert.equal(reasonOf(plan, "rollback-2.1.304"), "rollback-tag");
  assert.equal(reasonOf(plan, "pinned"), "keep-flag");
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:573ca08-claude-2.1.318`, `${R}:573ca08-claude-2.1.322`, `${R}:666becb-claude-2.1.322`]);
});

test("#2547 a runner repository without resolved in-use evidence is left alone unless opted in (review T2 F2)", () => {
  const codex = "a2a-docker-runner-codex";
  const images = [...IMAGES, image("c01", [`${codex}:old-1`], 30), image("c02", [`${codex}:old-2`], 40)];
  const plan = planRunnerImagePrune(inventory({ images }), { nowMs: NOW, isRoot: true });
  assert.deepEqual(plan.skippedRepositories, [codex]);
  assert.ok(!plan.candidates.some((tag) => tag.tag.startsWith(codex)));
  assert.equal(reasonOf(plan, "old-1"), "unverified-repository");
  const optIn = planRunnerImagePrune(inventory({ images }), { nowMs: NOW, isRoot: true, allowRepositories: [codex] });
  assert.deepEqual(tagsOf(optIn.candidates.filter((tag) => tag.tag.startsWith(codex))), [`${codex}:old-2`]);
});

test("#2547 an unused tag sharing its image id with a kept tag is untag-only and frees nothing", () => {
  const images = [image("aaa", [`${R}:ffc530e-claude-2.1.322`, `${R}:latest`], 5), image("zzz", [`${R}:old`, "mirror/other:1"], 10)];
  const plan = planRunnerImagePrune(inventory({ images }), { nowMs: NOW, isRoot: true, keepRollback: 0 });
  assert.ok(!plan.candidates.some((tag) => tag.tag === `${R}:latest`), "a second tag of the in-use id is kept");
  assert.deepEqual(plan.untagOnly, [`${R}:old`]);
  assert.equal(plan.reclaimableBytes, 0);
});

// ── #2550: per-worker rollback, in-use-only gate, bounded newer ─────────────

const SECOND = "/etc/default/a2a-hermes-worker-secondary";
const twoWorkers = (extra: EngineImage[] = []): EngineImage[] => [
  image("a1", [`${R}:a-current`], 5),
  image("b1", [`${R}:b-current`], 6),
  image("a0", [`${R}:a-previous`], 12),
  image("b0", [`${R}:b-previous`], 14),
  image("xx", [`${R}:stale`], 30),
  ...extra,
];
const bothInUse = (): Pick<RunnerImageInventory, "configured"> => ({
  configured: [...inUse(`${R}:a-current`).configured, ...inUse(`${R}:b-current`, SECOND).configured],
});

test("#2550 a second worker whose backup is only in --deploy-record-dir still keeps its rollback", () => {
  const plan = planRunnerImagePrune(
    inventory({
      images: twoWorkers(),
      ...bothInUse(),
      deployRecords: [record(`${R}:a-previous`, ENV, 1), record(`${R}:b-previous`, undefined, 2, { file: "/backups/runner-x/a2a-hermes-worker-secondary" })],
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "a-previous"), "rollback");
  assert.equal(reasonOf(plan, "b-previous"), "rollback");
  assert.match(plan.repositories[0].keep.find((tag) => tag.tag.endsWith("b-previous"))?.why ?? "", /deploy record .*for \/etc\/default\/a2a-hermes-worker-secondary/);
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:stale`]);
});

test("#2550 a second worker with no deploy record gets the newest image built before its own in-use image", () => {
  const plan = planRunnerImagePrune(inventory({ images: twoWorkers(), ...bothInUse(), deployRecords: [record(`${R}:a-previous`, ENV, 1)] }), { nowMs: NOW, isRoot: true });
  assert.equal(reasonOf(plan, "a-previous"), "rollback");
  assert.match(plan.repositories[0].keep.find((tag) => tag.tag.endsWith("b-previous"))?.why ?? "", /before the in-use image of \/etc\/default\/a2a-hermes-worker-secondary/);
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:stale`]);
});

test("#2550 a process-only worker (no env file names its image) gets its own rollback", () => {
  const plan = planRunnerImagePrune(
    inventory({
      images: twoWorkers(),
      live: { refs: [...inUse(`${R}:a-current`).live.refs, { ref: `${R}:b-current`, source: "pid 77 a2a-codex-worker.service A2A_DOCKER_RUNNER_IMAGE" }], unreadable: 0, scanned: 40, units: [] },
      configured: inUse(`${R}:a-current`).configured,
      deployRecords: [record(`${R}:a-previous`, ENV, 1)],
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.match(plan.repositories[0].keep.find((tag) => tag.tag.endsWith("a-previous"))?.why ?? "", /previous deploy of \/etc\/default\/a2a-hermes-worker /);
  assert.match(plan.repositories[0].keep.find((tag) => tag.tag.endsWith("b-previous"))?.why ?? "", /unit:a2a-codex-worker\.service/);
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:stale`]);
  assert.equal(plan.applyAllowed, true);
});

test("#2550 backups next to a live env file outside --env-dir are that worker's deploy records", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-images-outside-"));
  try {
    const envDir = join(root, "default");
    const other = join(root, "opt-worker");
    await mkdir(envDir);
    await mkdir(other);
    const live = join(other, "worker-b.env");
    await writeFile(live, "A2A_DOCKER_RUNNER_IMAGE=r:b-current\n");
    await writeFile(join(other, "worker-b.env.bak-20261110"), "A2A_DOCKER_RUNNER_IMAGE=r:b-previous\n");
    await writeFile(join(other, "worker-b.env.example"), "A2A_DOCKER_RUNNER_IMAGE=r:example\n"); // not a backup name
    await writeFile(join(other, "unrelated.env"), "A2A_DOCKER_RUNNER_IMAGE=r:other\n");
    const scanned = await scanEnvDir(envDir, [join(other, ".", "worker-b.env")]); // unnormalized path
    assert.deepEqual(scanned.configured.map((ref) => ref.ref), ["r:b-current"]);
    assert.deepEqual(scanned.deployRecords.map((ref) => [ref.ref, ref.owner]), [["r:b-previous", live]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#2551 review: another worker's owner-less records never fill a worker's slot (T2 F1 scenario)", () => {
  // A has no record; B's two history records are owner-less but carry B's env file name.
  const images = twoWorkers([image("bo", [`${R}:b-older`], 20)]);
  const bName = "/backups/runner-y/a2a-hermes-worker-secondary";
  const plan = planRunnerImagePrune(
    inventory({ images, ...bothInUse(), deployRecords: [record(`${R}:b-previous`, undefined, 1, { file: bName }), record(`${R}:b-older`, undefined, 10, { file: bName })] }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "a-previous"), "rollback", "A keeps its own previous image via the fallback");
  assert.equal(reasonOf(plan, "b-previous"), "rollback");
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:b-older`, `${R}:stale`]);
});

test("#2551 review: owner-less records are matched by env file name (T1 F2 scenario)", () => {
  const images = twoWorkers([image("ao", [`${R}:a-older`], 13)]);
  const deployRecords = [
    record(`${R}:a-previous`, undefined, 1, { file: "/backups/r3/a2a-hermes-worker" }),
    record(`${R}:a-older`, undefined, 4, { file: "/backups/r2/a2a-hermes-worker" }),
    record(`${R}:b-previous`, undefined, 8, { file: "/backups/r1/a2a-hermes-worker-secondary" }),
  ];
  const plan = planRunnerImagePrune(inventory({ images, ...bothInUse(), deployRecords }), { nowMs: NOW, isRoot: true });
  assert.equal(reasonOf(plan, "a-previous"), "rollback");
  assert.equal(reasonOf(plan, "b-previous"), "rollback");
  // #2557: a-older lies between B's recorded rollback and B's in-use image — kept, reported as
  // possibly A's history (A's record names it).
  assert.equal(reasonOf(plan, "a-older"), "rollback");
  assert.ok(plan.recordGaps.some((gap) => /a-older.*a record of \/etc\/default\/a2a-hermes-worker does/.test(gap)));
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:stale`]);
});

test("#2551 review: a record that matches no worker is kept and listed for review, never a rollback", () => {
  const plan = planRunnerImagePrune(
    inventory({ images: twoWorkers(), ...bothInUse(), deployRecords: [record(`${R}:stale`, undefined, 1, { file: "/backups/retired-worker" })] }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "stale"), "unattributed-record");
  assert.deepEqual(plan.recordsToReview, [`${R}:stale`]);
  assert.deepEqual(plan.candidates, []);
  assert.equal(plan.reclaimableIsUpperBound, true);
});

test("#2551 r2 review: env files sharing a name in different directories attribute no owner-less record (F1)", () => {
  const wA = "/srv/a2a/w1/worker.env";
  const wB = "/srv/a2a/w2/worker.env";
  const images = twoWorkers([image("ao", [`${R}:a-older`], 13)]);
  const deployRecords = [
    record(`${R}:a-previous`, undefined, 1, { file: "/backups/r3/worker.env" }),
    record(`${R}:a-older`, undefined, 4, { file: "/backups/r2/worker.env" }),
    record(`${R}:b-previous`, undefined, 8, { file: "/backups/r1/worker.env" }),
  ];
  const configured = [...inUse(`${R}:a-current`, wA).configured, ...inUse(`${R}:b-current`, wB).configured];
  const plan = planRunnerImagePrune(inventory({ images, configured, deployRecords }), { nowMs: NOW, isRoot: true });
  // Before: A took a-previous, B took a-older (A's history) and b-previous became a candidate.
  assert.notEqual(reasonOf(plan, "b-previous"), undefined, "B's previous image is kept");
  assert.ok(!plan.candidates.some((tag) => tag.tag.endsWith("b-previous")));
  assert.ok(!plan.repositories[0].keep.some((tag) => /^deploy record/.test(tag.why ?? "") && tag.reason === "rollback"), "no shared-name record fills a slot");
  const shared = plan.repositories[0].keep.filter((tag) => tag.reason === "unattributed-record");
  assert.ok(shared.length > 0 && shared.every((tag) => /several worker env files share/.test(tag.why ?? "")), JSON.stringify(shared));
  // All three history images are kept for review; no fallback slot is spent on them (#2551 r3).
  assert.deepEqual([...plan.recordsToReview].sort(), [`${R}:a-older`, `${R}:a-previous`, `${R}:b-previous`]);
  assert.ok(!plan.repositories[0].keep.some((tag) => tag.reason === "rollback" && /a-older|a-previous|b-previous/.test(tag.tag)), "no worker's fallback takes a shared-name record image");
  assert.deepEqual(plan.candidates, []);
});

test("#2551 r2 review: a worker that moved to another repository keeps its backup in the old one (F2)", () => {
  const codex = "a2a-docker-runner-codex";
  const images = [image("cx", [`${codex}:a-current`], 3.5), image("b1", [`${R}:b-current`], 6), image("a0", [`${R}:a-previous`], 12), image("b0", [`${R}:b-previous`], 14), image("xx", [`${R}:stale`], 30)];
  const plan = planRunnerImagePrune(
    inventory({
      images,
      live: { refs: [], unreadable: 0, scanned: 40, units: [] },
      configured: [...inUse(`${codex}:a-current`).configured, ...inUse(`${R}:b-current`, SECOND).configured],
      deployRecords: [record(`${R}:a-previous`, ENV, 5), record(`${R}:b-previous`, SECOND, 2)],
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "b-previous"), "rollback");
  assert.equal(reasonOf(plan, "a-previous"), "rollback");
  assert.match(plan.repositories.find((repo) => repo.repository === R)?.keep.find((tag) => tag.tag.endsWith("a-previous"))?.why ?? "", /now runs another repository/);
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:stale`]);
});

test("#2551 r2 review: a foreign worker keeps only its N newest backups in the old repository", () => {
  const codex = "a2a-docker-runner-codex";
  const images = [image("cx", [`${codex}:a-current`], 3.5), image("b1", [`${R}:b-current`], 6), image("a0", [`${R}:a-previous`], 12), image("b0", [`${R}:b-previous`], 14), image("a9", [`${R}:a-older`], 20), image("xx", [`${R}:stale`], 30)];
  const plan = planRunnerImagePrune(
    inventory({
      images,
      live: { refs: [], unreadable: 0, scanned: 40, units: [] },
      configured: [...inUse(`${codex}:a-current`).configured, ...inUse(`${R}:b-current`, SECOND).configured],
      deployRecords: [record(`${R}:a-previous`, ENV, 5), record(`${R}:a-older`, ENV, 9), record(`${R}:b-previous`, SECOND, 2)],
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "a-previous"), "rollback");
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:a-older`, `${R}:stale`]);
});

test("#2551 r3 review: a name shared with another repository's worker does not let a fallback take the record image (T2 F4)", () => {
  const codex = "a2a-docker-runner-codex";
  const wA = "/etc/a2a/w1/worker.env";
  const wC = "/etc/a2a/w2/worker.env";
  const images = [
    image("a1", [`${R}:a-current`], 5), image("b1", [`${R}:b-current`], 6), image("yy", [`${R}:y-unused`], 5.5),
    image("a0", [`${R}:a-previous`], 12), image("b0", [`${R}:b-previous`], 14), image("xx", [`${R}:stale`], 30), image("c1", [`${codex}:c-current`], 4),
  ];
  const configured = [...inUse(`${R}:a-current`, wA).configured, ...inUse(`${R}:b-current`, SECOND).configured, ...inUse(`${codex}:c-current`, wC).configured];
  const plan = planRunnerImagePrune(
    inventory({ images, configured, live: { refs: [], unreadable: 0, scanned: 40, units: [] }, deployRecords: [record(`${R}:a-previous`, undefined, 1, { file: "/backups/r1/worker.env" })] }),
    { nowMs: NOW, isRoot: true },
  );
  // cfca047f: A's fallback took y-unused, B's fallback took a-previous, b-previous became a candidate.
  assert.equal(reasonOf(plan, "a-previous"), "unattributed-record");
  assert.equal(reasonOf(plan, "b-previous"), "rollback");
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:stale`]);
});

test("#2551 r3 review: a fallback never takes another worker's backup, whatever the worker order", () => {
  // This worker's key sorts before ENV, so its fallback runs before ENV takes its own backup.
  const early = "/etc/default/a2a-aaa-worker";
  const images = [image("a1", [`${R}:a-current`], 5), image("e1", [`${R}:e-current`], 6), image("a0", [`${R}:a-previous`], 12), image("e0", [`${R}:e-previous`], 14), image("xx", [`${R}:stale`], 30)];
  const plan = planRunnerImagePrune(
    inventory({ images, configured: [...inUse(`${R}:a-current`).configured, ...inUse(`${R}:e-current`, early).configured], deployRecords: [record(`${R}:a-previous`, ENV, 1)] }),
    { nowMs: NOW, isRoot: true },
  );
  assert.match(plan.repositories[0].keep.find((tag) => tag.tag.endsWith("a-previous"))?.why ?? "", /previous deploy of \/etc\/default\/a2a-hermes-worker /);
  assert.match(plan.repositories[0].keep.find((tag) => tag.tag.endsWith("e-previous"))?.why ?? "", /before the in-use image of \/etc\/default\/a2a-aaa-worker/);
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:stale`]);
});

test("#2551 r3 review: an image only beyond another worker's N is still available to a fallback (no starvation)", () => {
  // A keeps a-previous; its older backup names shared-x, which is also B's real previous image.
  const images = [image("a1", [`${R}:a-current`], 5), image("b1", [`${R}:b-current`], 6), image("a0", [`${R}:a-previous`], 8), image("sx", [`${R}:shared-x`], 10), image("bo", [`${R}:b-old`], 20), image("xx", [`${R}:stale`], 30)];
  const plan = planRunnerImagePrune(
    inventory({ images, ...bothInUse(), deployRecords: [record(`${R}:a-previous`, ENV, 1), record(`${R}:shared-x`, ENV, 9)] }),
    { nowMs: NOW, isRoot: true },
  );
  assert.match(plan.repositories[0].keep.find((tag) => tag.tag.endsWith("shared-x"))?.why ?? "", /before the in-use image of \/etc\/default\/a2a-hermes-worker-secondary/);
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:b-old`, `${R}:stale`]);
});

test("#2551 r3 review: a moved worker's backup is its own, not a fallback of this repository's worker (T2 F5)", () => {
  const codex = "a2a-docker-runner-codex";
  const images = [image("cx", [`${codex}:a-current`], 3.5), image("b1", [`${R}:b-current`], 6), image("a0", [`${R}:a-previous`], 12), image("b0", [`${R}:b-previous`], 14), image("a9", [`${R}:a-older`], 20), image("xx", [`${R}:stale`], 30)];
  const plan = planRunnerImagePrune(
    inventory({
      images,
      live: { refs: [], unreadable: 0, scanned: 40, units: [] },
      configured: [...inUse(`${codex}:a-current`).configured, ...inUse(`${R}:b-current`, SECOND).configured],
      deployRecords: [record(`${R}:a-previous`, ENV, 5), record(`${R}:a-older`, ENV, 9)],
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.match(plan.repositories.find((repo) => repo.repository === R)?.keep.find((tag) => tag.tag.endsWith("a-previous"))?.why ?? "", /now runs another repository/);
  assert.match(plan.repositories.find((repo) => repo.repository === R)?.keep.find((tag) => tag.tag.endsWith("b-previous"))?.why ?? "", /before the in-use image of \/etc\/default\/a2a-hermes-worker-secondary/);
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:a-older`, `${R}:stale`]);
});

test("#2551 r3 review: an opted-in repository without a worker keeps its N newest besides a moved worker's backup (T1 F5)", () => {
  const codex = "a2a-docker-runner-codex";
  const images = [
    image("cx", [`${codex}:a-current`], 3.5),
    image("n3", [`${R}:2.1.330`], 12), image("p2", [`${R}:2.1.322`], 15), image("o1", [`${R}:2.1.318`], 20),
  ];
  const plan = planRunnerImagePrune(
    inventory({ images, live: { refs: [], unreadable: 0, scanned: 40, units: [] }, configured: inUse(`${codex}:a-current`).configured, deployRecords: [record(`${R}:2.1.322`, ENV, 10)] }),
    { nowMs: NOW, isRoot: true, allowRepositories: [R] },
  );
  assert.match(plan.repositories.find((repo) => repo.repository === R)?.keep.find((tag) => tag.tag.endsWith("2.1.322"))?.why ?? "", /now runs another repository/);
  assert.match(plan.repositories.find((repo) => repo.repository === R)?.keep.find((tag) => tag.tag.endsWith("2.1.330"))?.why ?? "", /opted-in repository without a worker/);
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:2.1.318`]);
});

test("#2551 r3 review: a backup whose live file names no runner image says so", () => {
  const images = [image("b1", [`${R}:b-current`], 6), image("a0", [`${R}:a-previous`], 12), image("b0", [`${R}:b-previous`], 14)];
  const plan = planRunnerImagePrune(
    inventory({ images, configured: inUse(`${R}:b-current`, SECOND).configured, deployRecords: [record(`${R}:a-previous`, ENV, 5), record(`${R}:b-previous`, SECOND, 2)] }),
    { nowMs: NOW, isRoot: true },
  );
  assert.match(plan.repositories[0].keep.find((tag) => tag.tag.endsWith("a-previous"))?.why ?? "", /names no running runner image/);
  assert.deepEqual(plan.candidates, []);
});

test("#2551 r2 review: an unattributed record image never takes the --keep-newer slot (F4)", () => {
  const images = [image("aaa", [`${R}:current`], 20), image("rrr", [`${R}:retired-worker`], 4), image("nnn", [`${R}:next-rollout`], 5), image("ooo", [`${R}:previous`], 25)];
  const base = inventory({ engine: "podman", images, ...inUse(`${R}:current`), deployRecords: [record(`${R}:retired-worker`, undefined, 1, { file: "/backups/retired-worker" })] });
  const plan = planRunnerImagePrune(base, { nowMs: NOW, isRoot: true });
  assert.equal(reasonOf(plan, "retired-worker"), "unattributed-record");
  assert.equal(reasonOf(plan, "next-rollout"), "newer-than-in-use");
  const include = planRunnerImagePrune(base, { nowMs: NOW, isRoot: true, includeNewer: true });
  assert.deepEqual(include.candidates, [], "--include-newer does not delete the next rollout");
});

test("#2551 review: a recent image or one built after the in-use image never uses a rollback slot (T1 F8)", () => {
  // Rolled back from N (loaded today) to O: the newest backup names N.
  const images = [
    image("ooo", [`${R}:current-o`], 10),
    image("nnn", [`${R}:rolled-back-n`], 2),
    image("ppp", [`${R}:previous-p`], 15),
    image("qqq", [`${R}:older-q`], 25),
  ];
  const plan = planRunnerImagePrune(
    inventory({ images, ...inUse(`${R}:current-o`), deployRecords: [record(`${R}:rolled-back-n`, ENV, 0.2), record(`${R}:previous-p`, ENV, 9)] }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "rolled-back-n"), "recent");
  assert.equal(reasonOf(plan, "previous-p"), "rollback");
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:older-q`]);
});

test("#2551 review: a unit whose EnvironmentFile= is a live env file is that worker; an unmapped unit is its own worker", () => {
  const images = twoWorkers();
  const liveRefs = [{ ref: `${R}:a-current`, source: "pid 10 a2a-hermes-worker.service A2A_DOCKER_RUNNER_IMAGE" }, { ref: `${R}:a-current`, source: "pid 20 a2a-shadow.service A2A_DOCKER_RUNNER_IMAGE" }];
  const plan = planRunnerImagePrune(
    inventory({
      images,
      configured: inUse(`${R}:a-current`).configured,
      live: { refs: liveRefs, unreadable: 0, scanned: 40, units: ["a2a-hermes-worker.service", "a2a-shadow.service"] },
      unitEnvFiles: { "a2a-hermes-worker.service": [ENV], "a2a-shadow.service": [] },
    }),
    { nowMs: NOW, isRoot: true },
  );
  const whys = plan.repositories[0].keep.filter((tag) => tag.reason === "rollback").map((tag) => tag.why ?? "");
  assert.equal(whys.length, 2, JSON.stringify(whys));
  assert.ok(whys.some((why) => why.includes("unit:a2a-shadow.service")));
  assert.ok(!whys.some((why) => why.includes("unit:a2a-hermes-worker.service")), "the mapped unit is merged into its env-file worker");
});

// ── #2554: own record vs unattributed, reason texts, fail-closed Created ───────

// ── #2557: an unrecorded latest switch must not push out the real previous image ──
// Field case 2026-11-13 (four worker nodes): the latest switch's backup sat in a
// directory not passed with --deploy-record-dir, so only the older 573ca08 record was seen.
const switchImages = (): EngineImage[] => [
  image("ffc", [`${R}:ffc530e-claude-2.1.322`], 5),
  image("666", [`${R}:666becb-claude-2.1.322`], 6),
  image("573", [`${R}:573ca08-claude-2.1.322`], 7),
  image("9ce", [`${R}:9ce562a-claude-2.1.322`], 4),
  image("old", [`${R}:a038bb7-claude-2.1.280`], 40),
];

test("#2557 when records fill the slot with an older image, the newest image built before the in-use one is kept too and reported", () => {
  const plan = planRunnerImagePrune(
    inventory({ images: switchImages(), ...inUse(`${R}:ffc530e-claude-2.1.322`), deployRecords: [record(`${R}:573ca08-claude-2.1.322`, undefined, 3, { file: "/root/.ccc-node/backups/meta-image-x/a2a-hermes-worker" })] }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "573ca08"), "rollback", "the record still fills the slot");
  assert.equal(reasonOf(plan, "666becb"), "rollback", "the real previous image is not a candidate");
  assert.match(plan.repositories[0].keep.find((tag) => tag.tag.includes("666becb"))?.why ?? "", /latest switch may be unrecorded/);
  assert.equal(plan.recordGaps.length, 1);
  assert.match(plan.recordGaps[0], /^\/etc\/default\/a2a-hermes-worker: .*666becb.*--deploy-record-dir/);
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:a038bb7-claude-2.1.280`]);
});

test("#2557 r1 review: an undeployed build between the real previous image and the in-use one does not push the previous out (T1 major)", () => {
  const images = [...switchImages(), image("xxx", [`${R}:x-loaded-never-deployed`], 5.5)];
  const plan = planRunnerImagePrune(
    inventory({ images, ...inUse(`${R}:ffc530e-claude-2.1.322`), deployRecords: [record(`${R}:573ca08-claude-2.1.322`, undefined, 3, { file: "/root/.ccc-node/backups/meta-image-x/a2a-hermes-worker" })] }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "x-loaded-never-deployed"), "rollback");
  assert.equal(reasonOf(plan, "666becb"), "rollback", "the real previous image is kept even with a newer undeployed build");
  assert.equal(plan.recordGaps.length, 2);
  assert.ok(plan.recordGaps.some((gap) => /x-loaded-never-deployed.*--deploy-record-dir/.test(gap)));
  assert.ok(plan.recordGaps.some((gap) => /666becb.*--deploy-record-dir/.test(gap)));
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:a038bb7-claude-2.1.280`]);
});

test("#2557 r1 review: a worker's own record outranked by mtime is reported as such, not as a missing directory", () => {
  const plan = planRunnerImagePrune(
    inventory({
      images: switchImages(),
      ...inUse(`${R}:ffc530e-claude-2.1.322`),
      deployRecords: [
        record(`${R}:573ca08-claude-2.1.322`, undefined, 1, { file: "/root/.ccc-node/backups/meta-image-x/a2a-hermes-worker" }),
        record(`${R}:666becb-claude-2.1.322`, undefined, 3, { file: "/root/a2a-nexus-local-deploy-backups/env.pre-ffc530e/a2a-hermes-worker" }),
      ],
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "666becb"), "rollback");
  assert.match(plan.repositories[0].keep.find((tag) => tag.tag.includes("666becb"))?.why ?? "", /own record was outranked/);
  assert.equal(plan.recordGaps.length, 1);
  assert.match(plan.recordGaps[0], /own deploy record names it but a record of an older image took the slot/);
  assert.doesNotMatch(plan.recordGaps[0], /--deploy-record-dir/);
});

test("#2557 r1 review: two workers sharing the gap image are both reported", () => {
  const plan = planRunnerImagePrune(
    inventory({
      images: switchImages(),
      configured: [...inUse(`${R}:ffc530e-claude-2.1.322`).configured, ...inUse(`${R}:ffc530e-claude-2.1.322`, SECOND).configured],
      deployRecords: [record(`${R}:573ca08-claude-2.1.322`, ENV, 3), record(`${R}:a038bb7-claude-2.1.280`, SECOND, 3)],
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "666becb"), "rollback");
  const gaps = plan.recordGaps.filter((gap) => gap.includes("666becb"));
  assert.equal(gaps.length, 2, JSON.stringify(plan.recordGaps));
  assert.ok(gaps.some((gap) => gap.startsWith(`${SECOND}:`) && /already kept/.test(gap)), "the second worker is reported although the first one already kept the image");
});

test("#2557 r1 review: a gap image already protected (container) is not reported; older unprotected ones in range are", () => {
  const plan = planRunnerImagePrune(
    inventory({
      images: switchImages(),
      ...inUse(`${R}:ffc530e-claude-2.1.322`),
      containers: [{ id: "k1", name: "canary", imageId: "sha256:666", imageRef: `${R}:666becb-claude-2.1.322` }],
      deployRecords: [record(`${R}:a038bb7-claude-2.1.280`, ENV, 3)],
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "666becb"), "container");
  assert.ok(!plan.recordGaps.some((gap) => gap.includes("666becb")));
  assert.equal(reasonOf(plan, "573ca08"), "rollback");
  assert.ok(plan.recordGaps.some((gap) => /573ca08.*built after its newest recorded rollback \(.*a038bb7/.test(gap)));
  assert.deepEqual(plan.candidates, []);
});

test("#2557 r1 review: an unattributed record image inside the gap is reported with its current reason", () => {
  const plan = planRunnerImagePrune(
    inventory({
      images: switchImages(),
      ...inUse(`${R}:ffc530e-claude-2.1.322`),
      deployRecords: [record(`${R}:573ca08-claude-2.1.322`, ENV, 3), record(`${R}:666becb-claude-2.1.322`, undefined, 1, { file: "/backups/retired-worker" })],
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "666becb"), "unattributed-record");
  assert.ok(plan.recordGaps.some((gap) => /666becb.*already kept: an unattributed deploy record/.test(gap)));
});

test("#2558 r2 review: two workers switching together with complete records report no gap", () => {
  const plan = planRunnerImagePrune(
    inventory({
      images: switchImages(),
      configured: [...inUse(`${R}:ffc530e-claude-2.1.322`).configured, ...inUse(`${R}:ffc530e-claude-2.1.322`, SECOND).configured],
      deployRecords: [
        record(`${R}:666becb-claude-2.1.322`, ENV, 2), record(`${R}:573ca08-claude-2.1.322`, ENV, 10),
        record(`${R}:666becb-claude-2.1.322`, SECOND, 2), record(`${R}:573ca08-claude-2.1.322`, SECOND, 10),
      ],
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.deepEqual(plan.recordGaps, [], "the second worker's newest record image is kept by the first worker — not a gap");
  assert.equal(reasonOf(plan, "666becb"), "rollback");
  assert.equal(plan.applyAllowed, true);
});

test("#2558 r2 review: an image with the same Created as the floor image is inside the range", () => {
  const images = [...switchImages(), image("twn", [`${R}:573ca08-claude-2.1.322-rebuilt`], 7)];
  const plan = planRunnerImagePrune(
    inventory({ images, ...inUse(`${R}:ffc530e-claude-2.1.322`), deployRecords: [record(`${R}:573ca08-claude-2.1.322`, ENV, 3)] }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "573ca08-claude-2.1.322-rebuilt"), "rollback");
  assert.ok(plan.recordGaps.some((gap) => gap.includes("573ca08-claude-2.1.322-rebuilt")));
});

test("#2558 r2 review: more than RECORD_GAP_APPLY_LIMIT images kept only as record gaps refuses --apply", () => {
  const between = (n: number): EngineImage[] => Array.from({ length: n }, (_, i) => image(`g${i}`, [`${R}:gap-${i}`], 6 + i * 0.5));
  const base = (n: number) => inventory({
    images: [image("ffc", [`${R}:ffc530e-claude-2.1.322`], 5), ...between(n), image("old", [`${R}:a038bb7-claude-2.1.280`], 40)],
    ...inUse(`${R}:ffc530e-claude-2.1.322`),
    deployRecords: [record(`${R}:a038bb7-claude-2.1.280`, ENV, 3)],
  });
  const three = planRunnerImagePrune(base(RECORD_GAP_APPLY_LIMIT), { nowMs: NOW, isRoot: true });
  assert.equal(three.recordGaps.length, RECORD_GAP_APPLY_LIMIT);
  assert.equal(three.applyAllowed, true);
  const four = planRunnerImagePrune(base(RECORD_GAP_APPLY_LIMIT + 1), { nowMs: NOW, isRoot: true });
  assert.equal(four.applyAllowed, false);
  assert.match(four.applyRefusals.join(" "), /4 images that no deploy record names are kept as record gaps \(more than 3\).*--deploy-record-dir/);
  assert.equal(four.recordGapImages.length, 4);
  assert.deepEqual(four.candidates, [], "the refusal changes nothing kept: all gap images stay");
});

test("#2558 r3 review: another worker's history never counts toward the refusal (workers on different cadences)", () => {
  // A rolled out daily v1→…→v7 (its own records name v2..v6); B went v1→v7 in one step.
  const images = [7, 6, 5, 4, 3, 2, 1].map((v) => image(`v${v}`, [`${R}:v${v}`], 12 - v - (v >= 6 ? 1 : 0)));
  const plan = planRunnerImagePrune(
    inventory({
      images,
      live: { refs: [], unreadable: 0, scanned: 40, units: [] },
      configured: [...inUse(`${R}:v7`).configured, ...inUse(`${R}:v7`, SECOND).configured],
      deployRecords: [
        ...[6, 5, 4, 3, 2].map((v, i) => record(`${R}:v${v}`, ENV, 1 + i)),
        record(`${R}:v1`, SECOND, 9),
      ],
    }),
    { nowMs: NOW, isRoot: true },
  );
  const bOther = plan.recordGaps.filter((gap) => gap.startsWith(`${SECOND}:`) && /a record of \/etc\/default\/a2a-hermes-worker does/.test(gap));
  assert.ok(bOther.length > RECORD_GAP_APPLY_LIMIT, JSON.stringify(plan.recordGaps));
  assert.equal(plan.applyAllowed, true, JSON.stringify(plan.applyRefusals));
});

test("#2558 r3 review: an image already kept for another worker's gap is not counted twice", () => {
  const between = Array.from({ length: RECORD_GAP_APPLY_LIMIT + 1 }, (_, i) => image(`g${i}`, [`${R}:gap-${i}`], 6 + i * 0.5));
  const plan = planRunnerImagePrune(
    inventory({
      images: [image("ffc", [`${R}:ffc530e-claude-2.1.322`], 5), ...between, image("old", [`${R}:a038bb7-claude-2.1.280`], 40)],
      live: { refs: [], unreadable: 0, scanned: 40, units: [] },
      configured: [...inUse(`${R}:ffc530e-claude-2.1.322`).configured, ...inUse(`${R}:ffc530e-claude-2.1.322`, SECOND).configured],
      deployRecords: [record(`${R}:a038bb7-claude-2.1.280`, ENV, 3), record(`${R}:a038bb7-claude-2.1.280`, SECOND, 3)],
    }),
    { nowMs: NOW, isRoot: true },
  );
  // A's record takes a038bb7; B's fallback takes gap-0; A's gap pass adds gap-1..gap-3 (3, at the
  // limit). B reports the same images as "already kept" — they must not count toward its refusal.
  assert.equal(plan.recordGapImages.length, RECORD_GAP_APPLY_LIMIT, "each image is counted once");
  assert.ok(plan.recordGaps.filter((gap) => gap.startsWith(`${SECOND}:`)).every((gap) => /already kept/.test(gap)));
  assert.ok(plan.recordGaps.length > plan.recordGapImages.length, "reports exceed unique images");
  assert.equal(plan.applyAllowed, true, JSON.stringify(plan.applyRefusals));
});

test("#2558 r3 review: an old owner backup that keeps taking the slot refuses --apply with a rotation hint", () => {
  const recordImages = Array.from({ length: RECORD_GAP_APPLY_LIMIT + 1 }, (_, i) => image(`r${i}`, [`${R}:rollout-${i}`], 6 + i * 0.5));
  const plan = planRunnerImagePrune(
    inventory({
      images: [image("ffc", [`${R}:ffc530e-claude-2.1.322`], 5), ...recordImages, image("old", [`${R}:a038bb7-claude-2.1.280`], 40)],
      ...inUse(`${R}:ffc530e-claude-2.1.322`),
      deployRecords: [
        record(`${R}:a038bb7-claude-2.1.280`, ENV, 30), // install-time .bak: an owner backup, taken first
        ...recordImages.map((img, i) => record(img.repoTags[0], undefined, 1 + i, { file: `/root/a2a-nexus-local-deploy-backups/env.pre-${i}/a2a-hermes-worker` })),
      ],
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(plan.applyAllowed, false);
  assert.match(plan.applyRefusals.join(" "), /4 images its own deploy records name are kept as record gaps.*env-backups --prune/);
  assert.doesNotMatch(plan.applyRefusals.join(" "), /--deploy-record-dir/);
});

test("#2558 r3 review: an own record image kept by a container raises the floor", () => {
  const images = [...switchImages(), image("x65", [`${R}:x-between`], 6.5)];
  const plan = planRunnerImagePrune(
    inventory({
      images,
      ...inUse(`${R}:ffc530e-claude-2.1.322`),
      containers: [{ id: "k1", name: "canary", imageId: "sha256:666", imageRef: `${R}:666becb-claude-2.1.322` }],
      deployRecords: [record(`${R}:666becb-claude-2.1.322`, ENV, 1), record(`${R}:573ca08-claude-2.1.322`, ENV, 10)],
    }),
    { nowMs: NOW, isRoot: true },
  );
  // 666becb (its newest record image, kept by the container) is the floor: x-between is older than an
  // image the worker really ran, so it is not a gap candidate for "the image it ran just before".
  assert.deepEqual(plan.recordGaps, []);
  assert.ok(plan.candidates.some((tag) => tag.tag.endsWith("x-between")));
});

test("#2557 with complete records nothing extra is kept and no gap is reported", () => {
  const plan = planRunnerImagePrune(
    inventory({
      images: switchImages(),
      ...inUse(`${R}:ffc530e-claude-2.1.322`),
      deployRecords: [
        record(`${R}:573ca08-claude-2.1.322`, undefined, 3, { file: "/root/.ccc-node/backups/meta-image-x/a2a-hermes-worker" }),
        record(`${R}:666becb-claude-2.1.322`, undefined, 2.9, { file: "/root/a2a-nexus-local-deploy-backups/env.pre-ffc530e/a2a-hermes-worker" }),
      ],
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "666becb"), "rollback");
  assert.deepEqual(plan.recordGaps, []);
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:573ca08-claude-2.1.322`, `${R}:a038bb7-claude-2.1.280`]);
});

test("#2557 --keep-rollback 0 keeps no rollback, so no safety net either", () => {
  const plan = planRunnerImagePrune(
    inventory({ images: switchImages(), ...inUse(`${R}:ffc530e-claude-2.1.322`), deployRecords: [record(`${R}:573ca08-claude-2.1.322`, undefined, 3, { file: "/root/.ccc-node/backups/meta-image-x/a2a-hermes-worker" })] }),
    { nowMs: NOW, isRoot: true, keepRollback: 0 },
  );
  assert.deepEqual(plan.recordGaps, []);
  assert.ok(plan.candidates.some((tag) => tag.tag.includes("666becb")));
});

test("#2554 a worker's own backup wins over an unattributed record naming the same image", () => {
  const plan = planRunnerImagePrune(
    inventory({
      deployRecords: [
        record(`${R}:573ca08-claude-2.1.318`, ENV, 2),
        record(`${R}:573ca08-claude-2.1.318`, undefined, 1, { file: "/backups/retired-worker" }),
      ],
    }),
    { nowMs: NOW, isRoot: true },
  );
  const kept = plan.repositories[0].keep.find((tag) => tag.tag.endsWith("2.1.318"));
  assert.equal(kept?.reason, "rollback");
  assert.match(kept?.why ?? "", /previous deploy of \/etc\/default\/a2a-hermes-worker/);
  assert.deepEqual(plan.recordsToReview, []);
  // The record took the slot (not the fallback): 666becb and 573ca08-322 are kept by the #2557
  // record-gap pass, never as a fallback pick.
  assert.match(plan.repositories[0].keep.find((tag) => tag.tag.includes("666becb"))?.why ?? "", /latest switch may be unrecorded/);
  assert.ok(!plan.repositories[0].keep.some((tag) => /no (eligible )?deploy record/.test(tag.why ?? "")), "no fallback pick");
  assert.deepEqual(plan.candidates, []);
});

test("#2554 a worker's own owner-less record (by env file name) also wins over an unattributed one", () => {
  const plan = planRunnerImagePrune(
    inventory({
      deployRecords: [
        record(`${R}:573ca08-claude-2.1.318`, undefined, 2, { file: "/backups/r1/a2a-hermes-worker" }),
        record(`${R}:573ca08-claude-2.1.318`, undefined, 1, { file: "/backups/retired-worker" }),
      ],
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "2.1.318"), "rollback");
  assert.deepEqual(plan.recordsToReview, []);
});

test("#2554 a moved worker's backup says 'another repository' only when it really runs a runner image", () => {
  const images = [...IMAGES, image("b1", [`${R}:b-current`], 6), image("a0", [`${R}:a-previous`], 12)];
  const plan = planRunnerImagePrune(
    inventory({
      images,
      live: { refs: [], unreadable: 0, scanned: 40, units: [] },
      // ENV now names a non-runner image: no runner repository runs there.
      configured: [...inUse("python:3.11").configured, ...inUse(`${R}:b-current`, SECOND).configured],
      deployRecords: [record(`${R}:a-previous`, ENV, 5)],
    }),
    { nowMs: NOW, isRoot: true },
  );
  const why = plan.repositories.find((repo) => repo.repository === R)?.keep.find((tag) => tag.tag.endsWith("a-previous"))?.why ?? "";
  assert.match(why, /names no running runner image/);
  assert.doesNotMatch(why, /another repository/);
});

test("#2554 the fallback reason tells 'no deploy record' from 'no eligible deploy record left'", () => {
  const none = planRunnerImagePrune(inventory(), { nowMs: NOW, isRoot: true });
  assert.match(none.repositories[0].keep.find((tag) => tag.reason === "rollback")?.why ?? "", /\(no deploy record\)$/);
  // The worker's only record names an image built after its in-use image: not eligible.
  const images = [...IMAGES, image("nnn", [`${R}:next-rollout`], 4)];
  const plan = planRunnerImagePrune(inventory({ images, deployRecords: [record(`${R}:next-rollout`, ENV, 1)] }), { nowMs: NOW, isRoot: true });
  const rollback = plan.repositories[0].keep.find((tag) => tag.reason === "rollback");
  assert.equal(rollback?.tag, `${R}:666becb-claude-2.1.322`);
  assert.match(rollback?.why ?? "", /\(no eligible deploy record left\)$/);
});

test("#2554 apply is refused when a worker's in-use image has no usable creation time", () => {
  const images = IMAGES.map((entry) => (entry.id === "sha256:aaa" ? { ...entry, created: "not-a-date" } : entry));
  const plan = planRunnerImagePrune(inventory({ images }), { nowMs: NOW, isRoot: true });
  assert.equal(plan.applyAllowed, false);
  assert.ok(plan.applyRefusals.some((reason) => /no usable creation time/.test(reason)), plan.applyRefusals.join("; "));
  // #2554 r2: the refused repository lists no candidate (the dry-run must not read as a delete list).
  assert.deepEqual(plan.candidates, []);
  assert.equal(plan.reclaimableBytes, 0);
  assert.equal(reasonOf(plan, "666becb"), "unverified-rollback");
});

// ── #2554 r2: minors from the #2555 review ──────────────────────────────────

test("#2554 r2 an epoch-0 or 0001-01-01 in-use Created is unknown: apply refused, nothing a candidate", () => {
  for (const created of ["1970-01-01T00:00:00Z", "0001-01-01T00:00:00Z"]) {
    const images = IMAGES.map((entry) => (entry.id === "sha256:aaa" ? { ...entry, created } : entry));
    const plan = planRunnerImagePrune(inventory({ images }), { nowMs: NOW, isRoot: true });
    assert.equal(plan.applyAllowed, false, created);
    assert.ok(plan.applyRefusals.some((reason) => /no usable creation time/.test(reason)), created);
    assert.deepEqual(plan.candidates, [], created);
  }
});

test("#2554 r2 one unknown in-use Created among a worker's in-use images refuses apply", () => {
  // The worker's env file names aaa; its unit's process runs ggg (Created unparseable).
  const images = [...IMAGES, image("ggg", [`${R}:hotfix`], 4, { created: "garbage" })];
  const plan = planRunnerImagePrune(
    inventory({
      images,
      live: { refs: [{ ref: `${R}:hotfix`, source: "pid 10 a2a-hermes-worker.service A2A_DOCKER_RUNNER_IMAGE" }], unreadable: 0, scanned: 40, units: ["a2a-hermes-worker.service"] },
      unitEnvFiles: { "a2a-hermes-worker.service": [ENV] },
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(plan.applyAllowed, false);
  assert.ok(plan.applyRefusals.some((reason) => /no usable creation time/.test(reason)), plan.applyRefusals.join("; "));
  assert.deepEqual(plan.candidates, []);
});

test("#2554 r2 --keep-rollback 0 with --include-newer needs no build order: an unknown in-use Created does not refuse", () => {
  const images = IMAGES.map((entry) => (entry.id === "sha256:aaa" ? { ...entry, created: "not-a-date" } : entry));
  const plan = planRunnerImagePrune(inventory({ images }), { nowMs: NOW, isRoot: true, keepRollback: 0, includeNewer: true });
  assert.ok(!plan.applyRefusals.some((reason) => /creation time/.test(reason)), plan.applyRefusals.join("; "));
  assert.equal(plan.applyAllowed, true);
});

// ── #2560 review (T1 nosuk / T2 jingun): sentinel Created must not move an image toward deletion ──

test("#2560 r1 a previous deploy with an epoch-0 Created named by the worker's own record stays its rollback", () => {
  const images = IMAGES.map((entry) => (entry.id === "sha256:bbb" ? { ...entry, created: "1970-01-01T00:00:00Z" } : entry));
  const plan = planRunnerImagePrune(inventory({ images, deployRecords: [record(`${R}:666becb-claude-2.1.322`, ENV, 2)] }), { nowMs: NOW, isRoot: true });
  assert.equal(reasonOf(plan, "666becb"), "rollback");
  assert.ok(!plan.candidates.some((tag) => tag.tag.includes("666becb")));
});

test("#2560 r1 a non-in-use image with a sentinel or unparseable Created is kept as unknown-build-order, never a candidate", () => {
  for (const created of ["1970-01-01T00:00:00Z", "0001-01-01T00:00:00Z", "garbage"]) {
    const images = IMAGES.map((entry) => (entry.id === "sha256:ddd" ? { ...entry, created } : entry));
    const plan = planRunnerImagePrune(inventory({ images }), { nowMs: NOW, isRoot: true });
    // An unparseable Created already reads as "recent" (unknown age); either way it is kept.
    assert.equal(reasonOf(plan, "2.1.318"), created === "garbage" ? "recent" : "unknown-build-order", created);
    assert.ok(!plan.candidates.some((tag) => tag.tag.endsWith("2.1.318")), created);
    assert.equal(plan.applyAllowed, true, created); // a known in-use image still lets the rest be pruned
  }
});

test("#2560 r1 --keep-rollback 0 with an unknown in-use Created still refuses while the newer line is active", () => {
  // A staged next rollout (built after the in-use image) must not become a candidate with apply allowed.
  const images = [...IMAGES.map((entry) => (entry.id === "sha256:aaa" ? { ...entry, created: "not-a-date" } : entry)), image("nnn", [`${R}:next-rollout`], 4)];
  const plan = planRunnerImagePrune(inventory({ images }), { nowMs: NOW, isRoot: true, keepRollback: 0 });
  assert.equal(plan.applyAllowed, false);
  assert.ok(plan.applyRefusals.some((reason) => /no usable creation time/.test(reason)), plan.applyRefusals.join("; "));
  assert.ok(!plan.candidates.some((tag) => tag.tag.includes("next-rollout")));
});

test("#2560 r1 an unattributed image also named by a worker with an unknown in-use Created says that is why", () => {
  const images = IMAGES.map((entry) => (entry.id === "sha256:aaa" ? { ...entry, created: "garbage" } : entry));
  const plan = planRunnerImagePrune(
    inventory({ images, deployRecords: [record(`${R}:573ca08-claude-2.1.322`, ENV, 3), record(`${R}:573ca08-claude-2.1.322`, undefined, 2, { file: "/backups/retired-worker" })] }),
    { nowMs: NOW, isRoot: true },
  );
  const kept = plan.repositories[0].keep.find((tag) => tag.tag.endsWith("573ca08-claude-2.1.322"));
  assert.equal(kept?.reason, "unattributed-record");
  assert.match(kept?.why ?? "", /not taken as its rollback \(its in-use creation time is unknown\)/);
});

test("#2554 r2 an own record that lost the slot but is also unattributed says whose history it is", () => {
  const plan = planRunnerImagePrune(
    inventory({
      deployRecords: [
        record(`${R}:666becb-claude-2.1.322`, ENV, 1),
        record(`${R}:573ca08-claude-2.1.322`, ENV, 3),
        record(`${R}:573ca08-claude-2.1.322`, undefined, 2, { file: "/backups/retired-worker" }),
      ],
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "666becb"), "rollback");
  const kept = plan.repositories[0].keep.find((tag) => tag.tag.endsWith("573ca08-claude-2.1.322"));
  assert.equal(kept?.reason, "unattributed-record");
  assert.match(kept?.why ?? "", /matches no worker env file name; also named by \/etc\/default\/a2a-hermes-worker's own deploy record/);
  assert.deepEqual(plan.recordsToReview, [`${R}:573ca08-claude-2.1.322`]);
});

test("#2554 r2 records naming only another repository's image leave the fallback note at 'no deploy record'", () => {
  const codex = "a2a-docker-runner-codex";
  const images = [...IMAGES, image("cx0", [`${codex}:old`], 20)];
  const plan = planRunnerImagePrune(inventory({ images, deployRecords: [record(`${codex}:old`, ENV, 2)] }), { nowMs: NOW, isRoot: true });
  const rollback = plan.repositories.find((repo) => repo.repository === R)?.keep.find((tag) => tag.reason === "rollback");
  assert.equal(rollback?.tag, `${R}:666becb-claude-2.1.322`);
  assert.match(rollback?.why ?? "", /\(no deploy record\)$/);
});

test("#2554 a relative --env-dir yields absolute paths that match live files and backup owners", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runner-images-reldir-"));
  try {
    await writeFile(join(dir, "a2a-hermes-worker"), `A2A_DOCKER_RUNNER_IMAGE=${R}:current\n`);
    await writeFile(join(dir, "a2a-hermes-worker.bak-20261101"), `A2A_DOCKER_RUNNER_IMAGE=${R}:previous\n`);
    const live = join(dir, "a2a-hermes-worker");
    const scan = await scanEnvDir(relative(process.cwd(), dir), [live]);
    assert.deepEqual(scan.configured.map((ref) => ref.file), [live]);
    assert.equal(scan.deployRecords.length, 1);
    assert.equal(scan.deployRecords[0].owner, live);
    assert.ok(isAbsolute(scan.deployRecords[0].file ?? ""));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#2554 every --env-file and A2A_DOCKER_RUNNER_ENV_FILE are live evidence; the first flag supplies settings", () => {
  assert.deepEqual(imagesEnvFiles(["/a", "/b"], "/c"), { live: ["/a", "/b", "/c"], settings: "/a" });
  assert.deepEqual(imagesEnvFiles(["/a"], "/a"), { live: ["/a"], settings: "/a" });
  assert.deepEqual(imagesEnvFiles([], "/c"), { live: ["/c"], settings: "/c" });
  assert.deepEqual(imagesEnvFiles([], "  "), { live: [], settings: undefined });
  assert.deepEqual(imagesEnvFiles([], undefined), { live: [], settings: undefined });
});

test("#2550 a repository that only a container or --keep references is skipped, not pruned", () => {
  const codex = "a2a-docker-runner-codex";
  const images = [...IMAGES, image("c01", [`${codex}:smoke`], 20), image("c02", [`${codex}:old`], 40), image("c03", [`${codex}:pinned`], 50)];
  const plan = planRunnerImagePrune(
    inventory({
      images,
      containers: [{ id: "k1", name: "codex-smoke", imageId: "sha256:c01", imageRef: `${codex}:smoke` }],
      keep: [{ ref: `${codex}:pinned`, source: "--keep" }],
    }),
    { nowMs: NOW, isRoot: true },
  );
  assert.ok(plan.skippedRepositories.includes(codex));
  assert.equal(reasonOf(plan, "codex:smoke"), "container");
  assert.equal(reasonOf(plan, "codex:old"), "unverified-repository");
  assert.ok(!plan.candidates.some((tag) => tag.tag.startsWith(codex)));
});

test("#2550 a newer container or --keep image does not move the newer-than-in-use line (review T2 F7)", () => {
  const images = [image("aaa", [`${R}:current`], 10), image("bbb", [`${R}:next-rollout`], 5), image("ccc", [`${R}:smoke`], 4), image("ooo", [`${R}:previous`], 20)];
  const plan = planRunnerImagePrune(
    inventory({ engine: "podman", images, ...inUse(`${R}:current`), containers: [{ id: "k1", name: "smoke", imageId: "sha256:ccc", imageRef: `${R}:smoke` }] }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(reasonOf(plan, "next-rollout"), "newer-than-in-use");
  assert.equal(reasonOf(plan, ":smoke"), "container");
  assert.deepEqual(plan.candidates, []);
});

test("#2550 newer-than-in-use is bounded: beyond --keep-newer is listed for review, removed only with --include-newer", () => {
  const images = [image("aaa", [`${R}:current`], 20), image("n1", [`${R}:newest`], 3.5), image("n2", [`${R}:failed-1`], 5), image("n3", [`${R}:failed-2`], 6), image("ooo", [`${R}:previous`], 25)];
  const base = inventory({ images, ...inUse(`${R}:current`) });
  const plan = planRunnerImagePrune(base, { nowMs: NOW, isRoot: true });
  assert.equal(reasonOf(plan, "newest"), "newer-than-in-use");
  assert.equal(reasonOf(plan, "failed-1"), "newer-to-review");
  assert.deepEqual([...plan.newerToReview].sort(), [`${R}:failed-1`, `${R}:failed-2`]);
  assert.deepEqual(plan.candidates, []);
  const include = planRunnerImagePrune(base, { nowMs: NOW, isRoot: true, includeNewer: true });
  assert.deepEqual(tagsOf(include.candidates), [`${R}:failed-1`, `${R}:failed-2`]);
  const zero = planRunnerImagePrune(base, { nowMs: NOW, isRoot: true, keepNewer: 0 });
  assert.equal(zero.newerToReview.length, 3);
});

test("#2550 an image with the same Created as the in-use one counts as newer (SOURCE_DATE_EPOCH builds)", () => {
  const same = new Date(NOW - 10 * DAY).toISOString();
  const images = [image("aaa", [`${R}:current`], 10, { created: same }), image("bbb", [`${R}:same-commit-next`], 10, { created: same }), image("ooo", [`${R}:previous`], 20)];
  const plan = planRunnerImagePrune(inventory({ images, ...inUse(`${R}:current`) }), { nowMs: NOW, isRoot: true });
  assert.equal(reasonOf(plan, "same-commit-next"), "newer-than-in-use");
  assert.deepEqual(plan.candidates, []);
});

// ── fail-closed reference resolution (review F1) ────────────────────────────

test("#2547 podman localhost/, tag@digest after docker load and short ids resolve to the in-use image", () => {
  const images = [image("abcdef0123456789", [`localhost/${R}:ffc530e`], 5), image("bbb", [`localhost/${R}:old`], 30)];
  assert.equal(resolveRef(`${R}:ffc530e`, images), "sha256:abcdef0123456789");
  assert.equal(resolveRef(`${R}:ffc530e@sha256:${"9".repeat(64)}`, images), "sha256:abcdef0123456789");
  assert.equal(resolveRef("abcdef012345", images), "sha256:abcdef0123456789");
  assert.equal(normalizeRef("docker.io/library/node"), "node:latest");
  assert.equal(normalizeRef("index.docker.io/x/y:1"), "x/y:1");
  const plan = planRunnerImagePrune(inventory({ images, ...inUse(`${R}:ffc530e`) }), { nowMs: NOW, isRoot: true, keepRollback: 0 });
  assert.equal(reasonOf(plan, "ffc530e"), "in-use");
  assert.deepEqual(tagsOf(plan.candidates), [`localhost/${R}:old`]);
  assert.equal(plan.applyAllowed, true);
});

test("#2547 apply is refused when an in-use runner ref or any --keep ref does not resolve", () => {
  const missing = planRunnerImagePrune(inventory({ ...inUse(`${R}:not-loaded-here`) }), { nowMs: NOW, isRoot: true });
  assert.equal(missing.applyAllowed, false);
  assert.match(missing.applyRefusals.join(" "), /not found among local images: a2a-docker-runner-claude:not-loaded-here/);
  const typo = planRunnerImagePrune(inventory({ keep: [{ ref: `${R}:ffc530x`, source: "--keep" }] }), { nowMs: NOW, isRoot: true });
  assert.equal(typo.applyAllowed, false);
  const shortId = planRunnerImagePrune(inventory({ keep: [{ ref: "0123456789ab", source: "--keep" }] }), { nowMs: NOW, isRoot: true });
  assert.equal(shortId.applyAllowed, false);
  // A non-runner image ref that is not present (e.g. a proxy image) does not block.
  const other = planRunnerImagePrune(
    inventory({ configured: [...inUse().configured, { ref: "example/egress-proxy:1", source: `${ENV} A2A_EGRESS_PROXY_IMAGE`, file: ENV }] }),
    { nowMs: NOW, isRoot: true },
  );
  assert.equal(other.applyAllowed, true);
});

test("#2547 apply is refused without in-use evidence, with unreadable /proc, or when not root", () => {
  const none = planRunnerImagePrune(inventory({ live: { refs: [], unreadable: 0, scanned: 5, units: [] }, configured: [] }), { nowMs: NOW, isRoot: true });
  assert.equal(none.applyAllowed, false);
  assert.match(none.applyRefusals.join(" "), /no in-use runner image evidence/);
  const partial = planRunnerImagePrune(inventory({ live: { ...inUse().live, unreadable: 3 } }), { nowMs: NOW, isRoot: true });
  assert.match(partial.applyRefusals.join(" "), /unreadable/);
  const notRoot = planRunnerImagePrune(inventory(), { nowMs: NOW, isRoot: false });
  assert.equal(notRoot.applyAllowed, false);
  assert.match(notRoot.applyRefusals.join(" "), /not running as root/);
});

// ── evidence collection ──────────────────────────────────────────────────────

test("#2547 parseImageEnv reads only A2A_*IMAGE keys (never other, secret-bearing values)", () => {
  const parsed = parseImageEnv([
    "GITHUB_TOKEN=ghp_secret",
    "export A2A_DOCKER_RUNNER_IMAGE=\"a2a-docker-runner-claude:x\"",
    "A2A_PIRI_RUNNER_IMAGE='a2a-docker-runner-piri:y'",
    "# A2A_DOCKER_RUNNER_IMAGE=commented",
    "A2A_DOCKER_RUNNER_IMAGE_PULL=always",
  ].join("\n"));
  assert.deepEqual(parsed, [
    { key: "A2A_DOCKER_RUNNER_IMAGE", value: "a2a-docker-runner-claude:x" },
    { key: "A2A_PIRI_RUNNER_IMAGE", value: "a2a-docker-runner-piri:y" },
  ]);
});

test("#2547 env dir: live files, owned backups, orphans, ~ / .dpkg-old, and systemd EnvironmentFile override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-images-envdir-"));
  try {
    await writeFile(join(dir, "a2a-hermes-worker"), "A2A_DOCKER_RUNNER_IMAGE=r:new\nSECRET=x\n");
    await writeFile(join(dir, "a2a-hermes-worker.bak-pre-2.1.322-20261110T000000Z"), "A2A_DOCKER_RUNNER_IMAGE=r:old\n");
    await writeFile(join(dir, "openclaw-a2a-worker.pre-analysis-bridge-20260523T221244+0900.bak"), "A2A_DOCKER_RUNNER_IMAGE=r:dead\n");
    await writeFile(join(dir, "gone-worker.dpkg-old"), "A2A_DOCKER_RUNNER_IMAGE=r:dpkg\n");
    await writeFile(join(dir, "gone-worker~"), "A2A_DOCKER_RUNNER_IMAGE=r:tilde\n");
    // a dotted live file next to a same-prefix file: only systemd can tell it is live
    await writeFile(join(dir, "a2a-worker"), "A2A_DOCKER_RUNNER_IMAGE=r:plain\n");
    await writeFile(join(dir, "a2a-worker.env"), "A2A_DOCKER_RUNNER_IMAGE=r:dotted-live\n");
    const scanned = await scanEnvDir(dir, [join(dir, "a2a-worker.env")]);
    assert.deepEqual(scanned.configured.map((ref) => ref.ref).sort(), ["r:dotted-live", "r:new", "r:plain"]);
    const records = Object.fromEntries(scanned.deployRecords.map((ref) => [ref.ref, ref]));
    assert.equal(records["r:old"].owner, join(dir, "a2a-hermes-worker"));
    assert.equal(records["r:old"].orphan, false);
    assert.equal(records["r:dead"].orphan, true);
    assert.equal(records["r:dpkg"].orphan, true);
    assert.equal(records["r:tilde"].orphan, true);
    assert.ok(!JSON.stringify(scanned).includes("SECRET"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(isEnvBackupName("a2a-hermes-worker-secondary", new Set()), false);
  // a dotted live env file keeps its own backups (owner = longest sibling prefix)
  const dotted = await mkdtemp(join(tmpdir(), "a2a-images-dotted-"));
  try {
    await writeFile(join(dotted, "a2a-worker"), "A2A_DOCKER_RUNNER_IMAGE=r:plain\n");
    await writeFile(join(dotted, "a2a-worker.env"), "A2A_DOCKER_RUNNER_IMAGE=r:live\n");
    await writeFile(join(dotted, "a2a-worker.env.bak-1"), "A2A_DOCKER_RUNNER_IMAGE=r:prev\n");
    const scannedDotted = await scanEnvDir(dotted, [join(dotted, "a2a-worker.env")]);
    assert.equal(scannedDotted.deployRecords.find((ref) => ref.ref === "r:prev")?.owner, join(dotted, "a2a-worker.env"));
  } finally {
    await rm(dotted, { recursive: true, force: true });
  }
  assert.equal(isEnvBackupName("foo.20261112", new Set()), true);
  assert.equal(isEnvBackupName("foo.prev", new Set()), true);
});

test("#2547 deploy-record dirs are walked (env backups kept away from the live file)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-images-records-"));
  try {
    await mkdir(join(dir, "runner-2.1.322-node-20261110"), { recursive: true });
    await writeFile(join(dir, "runner-2.1.322-node-20261110", "a2a-hermes-worker"), "A2A_DOCKER_RUNNER_IMAGE=r:prev\nTOKEN=t\n");
    const records = await scanDeployRecordDirs([dir]);
    assert.deepEqual(records.map((ref) => ref.ref), ["r:prev"]);
    assert.equal(records[0].owner, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("#2547 /proc scan finds the running worker's image and unit, and ignores newline-embedded keys", async () => {
  const proc = await mkdtemp(join(tmpdir(), "a2a-images-proc-"));
  try {
    await mkdir(join(proc, "100"));
    await writeFile(join(proc, "100", "environ"), ["PATH=/bin", "A2A_DOCKER_RUNNER_IMAGE=r:live", "TOKEN=t"].join("\0"));
    await writeFile(join(proc, "100", "cgroup"), "0::/system.slice/a2a-hermes-worker.service\n");
    await mkdir(join(proc, "200"));
    await writeFile(join(proc, "200", "environ"), "BLOB=line1\nA2A_FAKE_IMAGE=r:injected\0HOME=/root");
    await mkdir(join(proc, "self"));
    const scan = await scanProcessEnv(proc, 999_999);
    assert.deepEqual(scan.refs, [{ ref: "r:live", source: "pid 100 a2a-hermes-worker.service A2A_DOCKER_RUNNER_IMAGE" }]);
    assert.deepEqual(scan.units, ["a2a-hermes-worker.service"]);
    assert.equal(scan.scanned, 2);
    assert.equal(scan.unreadable, 0);
  } finally {
    await rm(proc, { recursive: true, force: true });
  }
});

test("#2547 engine output that does not parse never ends up in the error (it may carry secrets)", async () => {
  const exec: EngineExec = async (_engine, args) =>
    args[0] === "ps" ? { code: 0, stdout: "c1\n", stderr: "" } : { code: 0, stdout: "warning: GITHUB_TOKEN=ghp_leak\tnot json\tx\ty\n", stderr: "" };
  await assert.rejects(listEngineContainers("docker", exec), (error: Error) => {
    assert.match(error.message, /could not parse docker container inspect output/);
    assert.doesNotMatch(error.message, /ghp_leak/);
    return true;
  });
});

// ── prune / apply ────────────────────────────────────────────────────────────

interface FakeOptions {
  containers?: EngineContainer[];
  rmFails?: string[];
  /** tag → id reported by the per-tag inspect right before rm (simulates a re-pointed tag). */
  repointed?: Record<string, string>;
  onInfo?: () => Promise<void>;
}

/** Fake engine: records every call; answers ls/inspect/info from fixtures (tab-separated json columns). */
// #2557: tags built after the recorded rollback (2.1.318) and before the in-use image are kept by
// the record-gap pass, so the engine tests add two older tags to keep two candidates on the apply path.
const ENGINE_IMAGES: EngineImage[] = [...IMAGES, image("a03", [`${R}:a038bb7-claude-2.1.280`], 20), image("a02", [`${R}:22e57db-claude-2.1.280`], 25)];

function fakeEngine(images: EngineImage[], options: FakeOptions = {}): { exec: EngineExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: EngineExec = async (engine, args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === "image" && b === "ls") return { code: 0, stdout: images.map((img) => img.id).join("\n"), stderr: "" };
    if (a === "image" && b === "inspect" && args[3] === "{{json .Id}}") {
      const tag = args[4];
      const id = options.repointed?.[tag] ?? images.find((img) => img.repoTags.includes(tag))?.id;
      return id ? { code: 0, stdout: `${JSON.stringify(id)}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "no such image" };
    }
    if (a === "image" && b === "inspect") {
      assert.ok(!args[3].includes("Config.Env"));
      const rows = images.map((img) => {
        const cols = [img.id, img.repoTags, img.repoDigests, img.created, img.sizeBytes];
        if (engine === "docker") cols.push(img.lastTagTime ?? "0001-01-01T00:00:00Z");
        return cols.map((col) => JSON.stringify(col)).join("\t");
      });
      return { code: 0, stdout: rows.join("\n"), stderr: "" };
    }
    const containers = options.containers ?? [];
    if (a === "ps") return { code: 0, stdout: containers.map((c) => c.id).join("\n"), stderr: "" };
    if (a === "container" && b === "inspect") {
      return { code: 0, stdout: containers.map((c) => [c.id, `/${c.name}`, c.imageId, c.imageRef].map((col) => JSON.stringify(col)).join("\t")).join("\n"), stderr: "" };
    }
    if (a === "info") {
      await options.onInfo?.();
      return { code: 0, stdout: "/var/lib/docker\n", stderr: "" };
    }
    if (a === "image" && b === "rm") {
      return options.rmFails?.includes(args[2]) ? { code: 1, stdout: "", stderr: "conflict: image is being used" } : { code: 0, stdout: `Untagged: ${args[2]}\n`, stderr: "" };
    }
    if (a === "builder") return { code: 0, stdout: "Total reclaimed space: 0B\n", stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  return { exec, calls };
}

const statfsFn: StatfsFn = async () => ({ blocks: 100, bavail: 40, bsize: GB / 2 });
const noUnits = async (): Promise<string[]> => [];

async function withNode<T>(body: (paths: { envDir: string; procRoot: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "a2a-images-run-"));
  try {
    const envDir = join(root, "default");
    const procRoot = join(root, "proc");
    await mkdir(envDir);
    await mkdir(join(procRoot, "100"), { recursive: true });
    await writeFile(join(envDir, "a2a-hermes-worker"), `A2A_DOCKER_RUNNER_IMAGE=${R}:ffc530e-claude-2.1.322\n`);
    await writeFile(join(procRoot, "100", "environ"), `A2A_DOCKER_RUNNER_IMAGE=${R}:ffc530e-claude-2.1.322`);
    const backup = join(envDir, "a2a-hermes-worker.bak-pre-2.1.322-20261110T000000Z");
    await writeFile(backup, `A2A_DOCKER_RUNNER_IMAGE=${R}:573ca08-claude-2.1.318\n`);
    await utimes(backup, new Date(NOW - DAY), new Date(NOW - DAY));
    return await body({ envDir, procRoot });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const run = (exec: EngineExec, paths: { envDir: string; procRoot: string }, extra: Record<string, unknown> = {}) =>
  pruneRunnerImages({ engine: "docker", exec, ...paths, nowMs: NOW, isRoot: true, statfsFn, unitEnvFiles: noUnits, ...extra });

test("#2547 dry-run (the default) never calls image rm or builder prune", async () => {
  await withNode(async (paths) => {
    const { exec, calls } = fakeEngine(ENGINE_IMAGES);
    const report = await run(exec, paths, { builderCache: true });
    assert.equal(report.mode, "dry-run");
    assert.deepEqual(tagsOf(report.plan.candidates), [`${R}:22e57db-claude-2.1.280`, `${R}:a038bb7-claude-2.1.280`]);
    assert.equal(reasonOf(report.plan, "2.1.318"), "rollback");
    assert.ok(!calls.some((args) => args[1] === "rm" || args[0] === "builder"), JSON.stringify(calls));
    assert.equal(report.removed, undefined);
    assert.deepEqual(report.builderCache.command, ["docker", "builder", "prune", "-f", "--filter", "until=72h"]);
  });
});

test("#2547 --apply removes only candidates, re-checks each id, never uses -f, records disk before/after", async () => {
  await withNode(async (paths) => {
    const { exec, calls } = fakeEngine(ENGINE_IMAGES);
    const report = await run(exec, paths, { apply: true, builderCache: true });
    const removed = calls.filter((args) => args[0] === "image" && args[1] === "rm");
    assert.deepEqual(removed.map((args) => args[2]).sort(), [`${R}:22e57db-claude-2.1.280`, `${R}:a038bb7-claude-2.1.280`]);
    assert.ok(removed.every((args) => !args.includes("-f") && !args.includes("--force")));
    assert.equal(calls.filter((args) => args[3] === "{{json .Id}}").length, 2, "one id check per removal");
    assert.ok(!calls.some((args) => args[2]?.startsWith("swift") || args[2]?.startsWith("python")));
    assert.equal(report.ok, true);
    assert.equal(report.builderCache.ok, true);
    assert.equal(report.disk.before.length, 2);
    assert.ok(report.disk.after);
  });
});

test("#2547 --apply skips a tag re-pointed since the plan and reports an engine rm failure", async () => {
  await withNode(async (paths) => {
    const { exec, calls } = fakeEngine(ENGINE_IMAGES, { repointed: { [`${R}:a038bb7-claude-2.1.280`]: "sha256:new" }, rmFails: [`${R}:22e57db-claude-2.1.280`] });
    const report = await run(exec, paths, { apply: true });
    const byTag = Object.fromEntries((report.removed ?? []).map((entry) => [entry.tag, entry]));
    assert.match(byTag[`${R}:a038bb7-claude-2.1.280`].stderr ?? "", /skipped: tag now points at sha256:new/);
    assert.ok(!calls.some((args) => args[1] === "rm" && args[2] === `${R}:a038bb7-claude-2.1.280`));
    assert.equal(byTag[`${R}:22e57db-claude-2.1.280`].ok, false);
    assert.equal(report.ok, false);
  });
});

test("#2547 --apply stops when the re-check right before deleting is refused", async () => {
  await withNode(async (paths) => {
    // The worker env and process disappear between the plan and the re-check.
    const { exec, calls } = fakeEngine(IMAGES, {
      onInfo: async () => {
        await unlink(join(paths.envDir, "a2a-hermes-worker")).catch(() => undefined);
        await rm(join(paths.procRoot, "100"), { recursive: true, force: true });
      },
    });
    const report = await run(exec, paths, { apply: true });
    assert.equal(report.ok, false);
    assert.match(report.plan.applyRefusals.join(" "), /re-check: no in-use runner image evidence/);
    assert.ok(!calls.some((args) => args[1] === "rm"));
  });
});

test("#2547 --apply without in-use evidence deletes nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-images-empty-"));
  try {
    await mkdir(join(root, "default"));
    await mkdir(join(root, "proc"));
    const { exec, calls } = fakeEngine(IMAGES);
    const report = await run(exec, { envDir: join(root, "default"), procRoot: join(root, "proc") }, { apply: true });
    assert.equal(report.ok, false);
    assert.equal(report.plan.applyAllowed, false);
    assert.ok(!calls.some((args) => args[1] === "rm"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#2547 podman: no LastTagTime column, builder cache is reported as skipped", async () => {
  await withNode(async (paths) => {
    const { exec, calls } = fakeEngine(ENGINE_IMAGES);
    const report = await pruneRunnerImages({ engine: "podman", exec, ...paths, nowMs: NOW, isRoot: true, statfsFn, unitEnvFiles: noUnits, builderCache: true });
    const inspect = calls.find((args) => args[0] === "image" && args[1] === "inspect");
    assert.ok(inspect && !inspect[3].includes("LastTagTime"));
    assert.match(report.builderCache.skipped ?? "", /podman/);
    assert.equal(report.plan.candidates.length, 2);
  });
});

test("#2547 systemd EnvironmentFile of a running worker counts as live wherever it is", async () => {
  await withNode(async (paths) => {
    const extra = join(paths.envDir, "..", "worker.env");
    await writeFile(extra, `A2A_DOCKER_RUNNER_IMAGE=${R}:666becb-claude-2.1.322\n`);
    await writeFile(join(paths.procRoot, "100", "cgroup"), "0::/system.slice/a2a-hermes-worker-secondary.service\n");
    const { exec } = fakeEngine(IMAGES);
    const asked: string[] = [];
    const report = await run(exec, paths, { unitEnvFiles: async (unit: string) => (asked.push(unit), [extra]) });
    assert.deepEqual(asked, ["a2a-hermes-worker-secondary.service"]);
    assert.equal(reasonOf(report.plan, "666becb"), "in-use");
  });
});

test("#2547 an explicitly named env file is live evidence wherever it lives", async () => {
  await withNode(async (paths) => {
    const named = join(paths.envDir, "..", "named-worker.env");
    await writeFile(named, `A2A_DOCKER_RUNNER_IMAGE=${R}:666becb-claude-2.1.322\n`);
    const { exec } = fakeEngine(IMAGES);
    const report = await run(exec, paths, { extraLiveFiles: [named] });
    assert.equal(reasonOf(report.plan, "666becb"), "in-use");
  });
});

test("#2547 images argument parser: --flag value and --flag=value, unknown or value-less flags are errors", () => {
  const parsed = parseImagesArgs(["--keep", "a:1", "--keep=b:2", "--repository=r", "--apply", "--min-age", "0"]);
  assert.deepEqual(parsed.values["--keep"], ["a:1", "b:2"]);
  assert.deepEqual(parsed.values["--repository"], ["r"]);
  assert.equal(parsed.apply, true);
  assert.equal(parseImagesArgs([]).apply, false, "dry-run is the default");
  assert.throws(() => parseImagesArgs(["--keep"]), /--keep needs a value/);
  assert.throws(() => parseImagesArgs(["--keep", "--apply"]), /--keep needs a value/);
  assert.throws(() => parseImagesArgs(["--keep="]), /--keep needs a value/);
  assert.throws(() => parseImagesArgs(["--aply"]), /unknown flag --aply/);
  assert.throws(() => parseImagesArgs(["--apply=yes"]), /takes no value/);
  assert.throws(() => parseImagesArgs(["stray"]), /unexpected argument/);
  assert.throws(() => parseImagesArgs(["--dry-run", "--apply"]), /mutually exclusive/);
  const more = parseImagesArgs(["--env-file", "/a.env", "--env-file=/b.env", "--keep-newer", "2", "--include-newer"]);
  assert.deepEqual(more.values["--env-file"], ["/a.env", "/b.env"]);
  assert.deepEqual(more.values["--keep-newer"], ["2"]);
  assert.equal(more.includeNewer, true);
});

// ── doctor ───────────────────────────────────────────────────────────────────

test("#2547 doctor probe warns below 10% / 5GiB on / or the engine root, never hangs on a stuck engine", async () => {
  await withNode(async (paths) => {
    const { exec } = fakeEngine(ENGINE_IMAGES);
    const low: StatfsFn = async () => ({ blocks: 48, bavail: 2, bsize: GB });
    const warn = await checkRunnerImageDisk({ engine: "docker", engineReady: true, exec, ...paths, statfsFn: low, nowMs: NOW, isRoot: true, unitEnvFiles: noUnits });
    assert.equal(warn.status, "warn");
    assert.match(warn.message, /low disk: 2\.0GiB free on \//);
    assert.match(warn.message, /2 stale runner image tag\(s\), up to /);
    assert.equal(warn.detail?.recordGapReports, 2, "#2558: record gaps are visible in doctor");
    assert.equal(warn.detail?.recordGapImages, 2);
    assert.match(warn.message, /2 extra runner image\(s\) kept for 2 deploy record gap report\(s\)/);
    assert.equal(warn.detail?.reclaimableIsUpperBound, true);

    const engineRootLow: StatfsFn = async (path) => (path === "/" ? { blocks: 100, bavail: 50, bsize: GB } : { blocks: 100, bavail: 3, bsize: GB });
    const rootWarn = await checkRunnerImageDisk({ engine: "docker", engineReady: true, exec, ...paths, statfsFn: engineRootLow, nowMs: NOW, isRoot: true, unitEnvFiles: noUnits });
    assert.equal(rootWarn.status, "warn");
    assert.match(rootWarn.message, /free on \/var\/lib\/docker/);

    const fine = await checkRunnerImageDisk({ engine: "docker", engineReady: true, exec, ...paths, statfsFn, nowMs: NOW, isRoot: false, unitEnvFiles: noUnits });
    assert.equal(fine.status, "ok");
    assert.ok(fine.detail?.evidenceIncomplete, "non-root doctor marks the list indicative");

    const stuck: EngineExec = (_engine, args) => (args[0] === "info" ? exec("docker", args) : new Promise(() => undefined));
    const hung = await checkRunnerImageDisk({ engine: "docker", engineReady: true, exec: stuck, ...paths, statfsFn, timeoutMs: 50, unitEnvFiles: noUnits });
    assert.match(String(hung.detail?.inventoryError), /timed out/);

    const noEngine = await checkRunnerImageDisk({ engineReady: false, statfsFn: low });
    assert.equal(noEngine.status, "warn");
    assert.equal(noEngine.detail?.staleRunnerTags, undefined);
  });
});

// ── CLI ──────────────────────────────────────────────────────────────────────

test("#2547 CLI: --dry-run --apply and a value-less --keep are rejected before touching the engine", async () => {
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  for (const [argv, pattern] of [[["--dry-run", "--apply"], /mutually exclusive/], [["--keep", "--apply"], /--keep needs a value/]] as const) {
    await assert.rejects(
      promisify(execFile)(process.execPath, [cli, "images", ...argv], { timeout: 60_000 }),
      (error: { code?: number; stderr?: string }) => {
        assert.equal(error.code, 1);
        assert.match(error.stderr ?? "", pattern);
        return true;
      },
    );
  }
});
