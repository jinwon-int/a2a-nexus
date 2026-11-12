// #2547: runner image retention — keep in-use + N rollback per worker, dry-run by default, fail closed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  checkRunnerImageDisk,
  isEnvBackupName,
  listEngineContainers,
  normalizeRef,
  parseImageEnv,
  planRunnerImagePrune,
  pruneRunnerImages,
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
  const rollback = plan.repositories[0].keep.find((tag) => tag.reason === "rollback");
  assert.equal(rollback?.tag, `${R}:573ca08-claude-2.1.318`);
  assert.match(rollback?.why ?? "", /previous deploy of \/etc\/default\/a2a-hermes-worker/);
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:573ca08-claude-2.1.322`, `${R}:666becb-claude-2.1.322`]);
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
  assert.deepEqual(tagsOf(plan.candidates), [`${R}:666becb-claude-2.1.322`]);
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
    const { exec, calls } = fakeEngine(IMAGES);
    const report = await run(exec, paths, { builderCache: true });
    assert.equal(report.mode, "dry-run");
    assert.deepEqual(tagsOf(report.plan.candidates), [`${R}:573ca08-claude-2.1.322`, `${R}:666becb-claude-2.1.322`]);
    assert.equal(reasonOf(report.plan, "2.1.318"), "rollback");
    assert.ok(!calls.some((args) => args[1] === "rm" || args[0] === "builder"), JSON.stringify(calls));
    assert.equal(report.removed, undefined);
    assert.deepEqual(report.builderCache.command, ["docker", "builder", "prune", "-f", "--filter", "until=72h"]);
  });
});

test("#2547 --apply removes only candidates, re-checks each id, never uses -f, records disk before/after", async () => {
  await withNode(async (paths) => {
    const { exec, calls } = fakeEngine(IMAGES);
    const report = await run(exec, paths, { apply: true, builderCache: true });
    const removed = calls.filter((args) => args[0] === "image" && args[1] === "rm");
    assert.deepEqual(removed.map((args) => args[2]).sort(), [`${R}:573ca08-claude-2.1.322`, `${R}:666becb-claude-2.1.322`]);
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
    const { exec, calls } = fakeEngine(IMAGES, { repointed: { [`${R}:666becb-claude-2.1.322`]: "sha256:new" }, rmFails: [`${R}:573ca08-claude-2.1.322`] });
    const report = await run(exec, paths, { apply: true });
    const byTag = Object.fromEntries((report.removed ?? []).map((entry) => [entry.tag, entry]));
    assert.match(byTag[`${R}:666becb-claude-2.1.322`].stderr ?? "", /skipped: tag now points at sha256:new/);
    assert.ok(!calls.some((args) => args[1] === "rm" && args[2] === `${R}:666becb-claude-2.1.322`));
    assert.equal(byTag[`${R}:573ca08-claude-2.1.322`].ok, false);
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
    const { exec, calls } = fakeEngine(IMAGES);
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

// ── doctor ───────────────────────────────────────────────────────────────────

test("#2547 doctor probe warns below 10% / 5GiB on / or the engine root, never hangs on a stuck engine", async () => {
  await withNode(async (paths) => {
    const { exec } = fakeEngine(IMAGES);
    const low: StatfsFn = async () => ({ blocks: 48, bavail: 2, bsize: GB });
    const warn = await checkRunnerImageDisk({ engine: "docker", engineReady: true, exec, ...paths, statfsFn: low, nowMs: NOW, isRoot: true, unitEnvFiles: noUnits });
    assert.equal(warn.status, "warn");
    assert.match(warn.message, /low disk: 2\.0GiB free on \//);
    assert.match(warn.message, /2 stale runner image tag\(s\)/);

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

test("#2547 CLI: images --dry-run --apply is rejected before touching the engine", async () => {
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  await assert.rejects(
    promisify(execFile)(process.execPath, [cli, "images", "--dry-run", "--apply"], { timeout: 60_000 }),
    (error: { code?: number; stderr?: string }) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr ?? "", /mutually exclusive/);
      return true;
    },
  );
});
