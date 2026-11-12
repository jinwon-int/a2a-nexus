// #2547: runner image retention — keep in-use + N rollback, dry-run by default.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  checkRunnerImageDisk,
  isEnvBackupName,
  normalizeRef,
  parseImageEnv,
  planRunnerImagePrune,
  pruneRunnerImages,
  resolveRef,
  scanEnvDir,
  scanProcessEnv,
  type EngineContainer,
  type EngineExec,
  type EngineImage,
  type RunnerImageInventory,
  type StatfsFn,
} from "./runner-images.js";

const NOW = Date.parse("2026-11-12T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;

function image(id: string, tags: string[], ageDays: number, sizeGb = 1.9): EngineImage {
  return { id: `sha256:${id}`, repoTags: tags, repoDigests: [], created: new Date(NOW - ageDays * DAY).toISOString(), sizeBytes: Math.round(sizeGb * GB) };
}

const R = "a2a-docker-runner-claude";
// The 2026-11-12 worker-node shape: one in use, three older runner tags, plus non-runner images.
const IMAGES: EngineImage[] = [
  image("aaa", [`${R}:ffc530e-claude-2.1.322`], 2),
  image("bbb", [`${R}:666becb-claude-2.1.322`], 3.5),
  image("ccc", [`${R}:573ca08-claude-2.1.322`], 4),
  image("ddd", [`${R}:573ca08-claude-2.1.318`], 9),
  image("eee", ["swift:6.0-noble"], 30, 4.1),
  image("fff", ["python:3.11"], 60, 1.0),
];

function inventory(overrides: Partial<RunnerImageInventory> = {}): RunnerImageInventory {
  return {
    engine: "docker",
    images: IMAGES,
    containers: [],
    live: { refs: [{ ref: `${R}:ffc530e-claude-2.1.322`, source: "pid 10 a2a-hermes-worker.service A2A_DOCKER_RUNNER_IMAGE" }], unreadable: 0, scanned: 40 },
    configured: [{ ref: `${R}:ffc530e-claude-2.1.322`, source: "/etc/default/a2a-hermes-worker A2A_DOCKER_RUNNER_IMAGE" }],
    deployRecords: [],
    keep: [],
    ...overrides,
  };
}

const tagsOf = (list: Array<{ tag: string }>): string[] => list.map((entry) => entry.tag).sort();

test("#2547 keeps the in-use tag plus one rollback (newest created when no deploy record) and lists the rest", () => {
  const plan = planRunnerImagePrune(inventory(), { nowMs: NOW, isRoot: true });
  const repo = plan.repositories.find((entry) => entry.repository === R);
  assert.ok(repo);
  assert.deepEqual(
    repo.keep.map((tag) => [tag.tag, tag.reason]).sort(),
    [[`${R}:666becb-claude-2.1.322`, "rollback"], [`${R}:ffc530e-claude-2.1.322`, "in-use"]].sort(),
  );
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:573ca08-claude-2.1.318`, `${R}:573ca08-claude-2.1.322`]);
  assert.equal(plan.reclaimableBytes, 2 * Math.round(1.9 * GB));
  assert.equal(plan.applyAllowed, true);
});

test("#2547 never plans non-runner images (swift, python, node) even when old and unused", () => {
  const plan = planRunnerImagePrune(inventory(), { nowMs: NOW, isRoot: true });
  assert.deepEqual(plan.repositories.map((repo) => repo.repository), [R]);
  assert.ok(plan.candidates.every((tag) => tag.tag.startsWith(`${R}:`)));
});

test("#2547 a deploy record (env backup) picks the rollback over a newer unused tag", () => {
  const plan = planRunnerImagePrune(
    inventory({
      deployRecords: [
        { ref: `${R}:573ca08-claude-2.1.322`, source: "/etc/default/a2a-hermes-worker.bak-old", mtimeMs: NOW - 20 * DAY },
        { ref: `${R}:573ca08-claude-2.1.318`, source: "/etc/default/a2a-hermes-worker.bak-pre-2.1.322", mtimeMs: NOW - 2 * DAY },
      ],
    }),
    { nowMs: NOW, isRoot: true },
  );
  const rollback = plan.repositories[0].keep.find((tag) => tag.reason === "rollback");
  assert.equal(rollback?.tag, `${R}:573ca08-claude-2.1.318`);
  assert.match(rollback?.why ?? "", /deploy record .*bak-pre-2\.1\.322/);
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:573ca08-claude-2.1.322`, `${R}:666becb-claude-2.1.322`]);
});

test("#2547 an image referenced by any container (stopped egress proxy) is never a candidate", () => {
  const containers: EngineContainer[] = [{ id: "c1", name: "a2a-egress-proxy", imageId: "sha256:ddd", imageRef: `${R}:573ca08-claude-2.1.318` }];
  const plan = planRunnerImagePrune(inventory({ containers }), { nowMs: NOW, isRoot: true });
  const kept = plan.repositories[0].keep.find((tag) => tag.id === "sha256:ddd");
  assert.equal(kept?.reason, "container");
  assert.ok(!plan.candidates.some((tag) => tag.id === "sha256:ddd"));
});

test("#2547 --keep-rollback 0, recent images, rollback-named tags and --keep refs", () => {
  const images = [
    ...IMAGES,
    image("ggg", [`${R}:rollback-2.1.304`], 40),
    image("hhh", [`${R}:pinned`], 50),
  ];
  const plan = planRunnerImagePrune(
    inventory({ images, keep: [{ ref: `${R}:pinned`, source: "--keep" }] }),
    { nowMs: NOW, isRoot: true, keepRollback: 0 },
  );
  const reasons = Object.fromEntries(plan.repositories[0].keep.map((tag) => [tag.tag, tag.reason]));
  assert.equal(reasons[`${R}:rollback-2.1.304`], "rollback-tag");
  assert.equal(reasons[`${R}:pinned`], "keep-flag");
  assert.equal(reasons[`${R}:ffc530e-claude-2.1.322`], "in-use");
  // 666becb is 3.5 days old (> 72h) → candidate once no rollback is kept.
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:573ca08-claude-2.1.318`, `${R}:573ca08-claude-2.1.322`, `${R}:666becb-claude-2.1.322`]);
  const young = planRunnerImagePrune(inventory(), { nowMs: NOW, isRoot: true, keepRollback: 0, minAgeMs: 4.5 * DAY });
  assert.equal(young.repositories[0].keep.find((tag) => tag.tag.includes("666becb"))?.reason, "recent");
});

test("#2547 an unused tag sharing its image id with a kept tag is untag-only and frees nothing", () => {
  const images = [image("aaa", [`${R}:ffc530e-claude-2.1.322`, `${R}:latest`], 2), image("zzz", [`${R}:old`, "mirror/other:1"], 10)];
  const plan = planRunnerImagePrune(inventory({ images }), { nowMs: NOW, isRoot: true, keepRollback: 0 });
  assert.ok(!plan.candidates.some((tag) => tag.tag === `${R}:latest`), "a second tag of the in-use id is kept");
  assert.deepEqual(plan.untagOnly, [`${R}:old`]);
  assert.equal(plan.reclaimableBytes, 0);
});

test("#2547 apply is refused without in-use evidence or with unreadable /proc", () => {
  const none = planRunnerImagePrune(inventory({ live: { refs: [], unreadable: 0, scanned: 5 }, configured: [] }), { nowMs: NOW, isRoot: true });
  assert.equal(none.applyAllowed, false);
  assert.match(none.applyRefusals.join(" "), /no in-use runner image evidence/);
  const partial = planRunnerImagePrune(inventory({ live: { refs: [], unreadable: 3, scanned: 5 } }), { nowMs: NOW, isRoot: false });
  assert.equal(partial.applyAllowed, false);
  assert.match(partial.applyRefusals.join(" "), /unreadable/);
});

test("#2547 reference normalisation and resolution", () => {
  assert.equal(normalizeRef("docker.io/library/node"), "node:latest");
  assert.equal(normalizeRef("registry:5000/a2a-docker-runner-claude"), "registry:5000/a2a-docker-runner-claude:latest");
  assert.equal(resolveRef(`${R}:ffc530e-claude-2.1.322`, IMAGES), "sha256:aaa");
  assert.equal(resolveRef("sha256:ccc", IMAGES), "sha256:ccc");
  assert.equal(resolveRef(`${R}:missing`, IMAGES), undefined);
});

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

test("#2547 env dir: live files are configured, siblings and orphaned backups are deploy records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "a2a-images-envdir-"));
  try {
    await writeFile(join(dir, "a2a-hermes-worker"), "A2A_DOCKER_RUNNER_IMAGE=r:new\nSECRET=x\n");
    await writeFile(join(dir, "a2a-hermes-worker.bak-pre-2.1.322-20261110T000000Z"), "A2A_DOCKER_RUNNER_IMAGE=r:old\n");
    // live file gone, backup left behind (seen on a fleet node 2026-11-12)
    await writeFile(join(dir, "openclaw-a2a-worker.pre-analysis-bridge-20260523T221244+0900.bak"), "A2A_DOCKER_RUNNER_IMAGE=r:dead\n");
    await writeFile(join(dir, "unrelated"), "FOO=bar\n");
    const scanned = await scanEnvDir(dir);
    assert.deepEqual(scanned.configured.map((ref) => ref.ref), ["r:new"]);
    assert.deepEqual(scanned.deployRecords.map((ref) => ref.ref).sort(), ["r:dead", "r:old"]);
    assert.ok(!JSON.stringify(scanned).includes("SECRET"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(isEnvBackupName("a2a-hermes-worker-secondary", new Set()), false);
  assert.equal(isEnvBackupName("foo.20261112", new Set()), true);
});

test("#2547 /proc scan finds the image a running worker actually uses and its unit", async () => {
  const proc = await mkdtemp(join(tmpdir(), "a2a-images-proc-"));
  try {
    await mkdir(join(proc, "100"));
    await writeFile(join(proc, "100", "environ"), ["PATH=/bin", "A2A_DOCKER_RUNNER_IMAGE=r:live", "TOKEN=t"].join("\0"));
    await writeFile(join(proc, "100", "cgroup"), "0::/system.slice/a2a-hermes-worker.service\n");
    await mkdir(join(proc, "200"));
    await writeFile(join(proc, "200", "environ"), "HOME=/root");
    await mkdir(join(proc, "self"));
    const scan = await scanProcessEnv(proc, 999_999);
    assert.deepEqual(scan.refs, [{ ref: "r:live", source: "pid 100 a2a-hermes-worker.service A2A_DOCKER_RUNNER_IMAGE" }]);
    assert.equal(scan.scanned, 2);
    assert.equal(scan.unreadable, 0);
  } finally {
    await rm(proc, { recursive: true, force: true });
  }
});

/** Fake engine: records every call; answers ls/inspect/info from fixtures. */
function fakeEngine(images: EngineImage[], containers: EngineContainer[] = []): { exec: EngineExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: EngineExec = async (_engine, args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === "image" && b === "ls") return { code: 0, stdout: images.map((img) => img.id).join("\n"), stderr: "" };
    if (a === "image" && b === "inspect") {
      return { code: 0, stdout: JSON.stringify(images.map((img) => ({ Id: img.id, RepoTags: img.repoTags, RepoDigests: [], Created: img.created, Size: img.sizeBytes }))), stderr: "" };
    }
    if (a === "ps") return { code: 0, stdout: containers.map((c) => c.id).join("\n"), stderr: "" };
    if (a === "container" && b === "inspect") {
      return { code: 0, stdout: JSON.stringify(containers.map((c) => ({ Id: c.id, Name: `/${c.name}`, Image: c.imageId, Config: { Image: c.imageRef } }))), stderr: "" };
    }
    if (a === "info") return { code: 0, stdout: "/var/lib/docker\n", stderr: "" };
    if (a === "image" && b === "rm") return { code: 0, stdout: `Untagged: ${args[2]}\n`, stderr: "" };
    if (a === "builder") return { code: 0, stdout: "Total reclaimed space: 0B\n", stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected ${args.join(" ")}` };
  };
  return { exec, calls };
}

const statfsFn: StatfsFn = async () => ({ blocks: 100, bavail: 40, bsize: 1024 ** 3 / 2 });

async function withEnvAndProc<T>(body: (paths: { envDir: string; procRoot: string }) => Promise<T>): Promise<T> {
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

test("#2547 dry-run (the default) never calls image rm or builder prune", async () => {
  await withEnvAndProc(async ({ envDir, procRoot }) => {
    const { exec, calls } = fakeEngine(IMAGES);
    const report = await pruneRunnerImages({ engine: "docker", exec, envDir, procRoot, nowMs: NOW, isRoot: true, builderCache: true, statfsFn });
    assert.equal(report.mode, "dry-run");
    assert.deepEqual(tagsOf(report.plan.candidates), [`${R}:573ca08-claude-2.1.322`, `${R}:666becb-claude-2.1.322`]);
    assert.equal(report.plan.repositories[0].keep.find((tag) => tag.reason === "rollback")?.tag, `${R}:573ca08-claude-2.1.318`);
    assert.ok(!calls.some((args) => args[1] === "rm" || args[0] === "builder"), JSON.stringify(calls));
    assert.equal(report.removed, undefined);
    assert.deepEqual(report.builderCache.command, ["docker", "builder", "prune", "-f"]);
  });
});

test("#2547 --apply removes only candidates, without -f, and records disk before/after", async () => {
  await withEnvAndProc(async ({ envDir, procRoot }) => {
    const { exec, calls } = fakeEngine(IMAGES);
    const report = await pruneRunnerImages({ engine: "docker", exec, envDir, procRoot, nowMs: NOW, isRoot: true, apply: true, statfsFn });
    const removed = calls.filter((args) => args[0] === "image" && args[1] === "rm");
    assert.deepEqual(removed.map((args) => args[2]).sort(), [`${R}:573ca08-claude-2.1.322`, `${R}:666becb-claude-2.1.322`]);
    assert.ok(removed.every((args) => !args.includes("-f") && !args.includes("--force")));
    assert.ok(!calls.some((args) => args[2]?.startsWith("swift") || args[2]?.startsWith("python")));
    assert.equal(report.ok, true);
    assert.equal(report.disk.before.length, 2);
    assert.ok(report.disk.after);
  });
});

test("#2547 --apply without in-use evidence deletes nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "a2a-images-empty-"));
  try {
    await mkdir(join(root, "default"));
    await mkdir(join(root, "proc"));
    const { exec, calls } = fakeEngine(IMAGES);
    const report = await pruneRunnerImages({ engine: "docker", exec, envDir: join(root, "default"), procRoot: join(root, "proc"), nowMs: NOW, isRoot: true, apply: true, statfsFn });
    assert.equal(report.ok, false);
    assert.equal(report.plan.applyAllowed, false);
    assert.ok(!calls.some((args) => args[1] === "rm"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("#2547 doctor probe warns below 10% / 5GiB free and names reclaimable runner tags", async () => {
  await withEnvAndProc(async ({ envDir, procRoot }) => {
    const { exec } = fakeEngine(IMAGES);
    const low: StatfsFn = async () => ({ blocks: 48, bavail: 2, bsize: 1024 ** 3 });
    const warn = await checkRunnerImageDisk({ engine: "docker", engineReady: true, exec, envDir, procRoot, statfsFn: low, nowMs: NOW });
    assert.equal(warn.status, "warn");
    assert.match(warn.message, /low disk: 2\.0GiB free/);
    assert.match(warn.message, /2 stale runner image tag\(s\)/);
    const fine = await checkRunnerImageDisk({ engine: "docker", engineReady: true, exec, envDir, procRoot, statfsFn, nowMs: NOW });
    assert.equal(fine.status, "ok");
    const noEngine = await checkRunnerImageDisk({ engineReady: false, statfsFn: low });
    assert.equal(noEngine.status, "warn");
    assert.equal(noEngine.detail?.staleRunnerTags, undefined);
  });
});
