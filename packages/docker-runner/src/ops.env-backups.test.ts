import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupServiceEnvFile,
  checkServiceEnvBackups,
  listServiceEnvBackups,
  planServiceEnvBackupRotation,
  rotateServiceEnvBackups,
} from "./ops.js";

/** #2268: fleet nodes carried 22–45 `<envFile>.{bak,rollback}-*` secret copies each with no rotation. */

const DAY = 86_400_000;
const NOW = new Date("2026-09-25T00:00:00Z").getTime();

async function fixture(): Promise<{ dir: string; envFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "a2a-env-backups-"));
  const envFile = join(dir, "a2a-hermes-worker");
  await writeFile(envFile, "A2A_DOCKER_RUNNER_ROOT=/var/lib/openclaw-a2a/tasks\n", { mode: 0o600 });
  await chmod(envFile, 0o600);
  // Four naming schemes seen on the fleet + one unrelated sibling + one directory.
  const backups: Array<[string, number]> = [
    ["a2a-hermes-worker.bak-20260616T054548Z", 100],
    ["a2a-hermes-worker.bak-09cdc698a6f8-20260702190434", 84],
    ["a2a-hermes-worker.bak-1382-worker-signing-20260706T165001+0900", 80],
    ["a2a-hermes-worker.rollback-dfb3d93-20260730T141447Z", 56],
    ["a2a-hermes-worker.bak-2267r4-20260924T221949Z", 1],
    ["a2a-hermes-worker.bak-fresh-20260924T230000Z", 0],
  ];
  for (const [name, ageDays] of backups) {
    const path = join(dir, name);
    await writeFile(path, "SECRET=x\n", { mode: 0o600 });
    await chmod(path, 0o600);
    const t = new Date(NOW - ageDays * DAY);
    await utimes(path, t, t);
  }
  await writeFile(join(dir, "openclaw-a2a-worker"), "x\n"); // different base name — not a backup
  await mkdir(join(dir, "a2a-hermes-worker.d")); // directory — skipped
  return { dir, envFile };
}

test("#2268 listServiceEnvBackups matches <base>.* regular files only, newest first, with age from mtime", async () => {
  const { envFile } = await fixture();
  const entries = await listServiceEnvBackups({ envFile, nowMs: NOW });
  assert.equal(entries.length, 6);
  assert.deepEqual(entries.map((e) => e.ageDays), [0, 1, 56, 80, 84, 100]);
  assert.ok(entries.every((e) => e.mode === "0600" && e.broadPerms === false));
  assert.ok(entries.every((e) => !e.path.endsWith("openclaw-a2a-worker") && !e.path.endsWith(".d")));
});

test("#2268 rotation plan keeps the newest N and prunes the rest only beyond max-age (0 = all beyond N)", async () => {
  const { envFile } = await fixture();
  const entries = await listServiceEnvBackups({ envFile, nowMs: NOW });

  const plan = planServiceEnvBackupRotation(entries, { keep: 2, maxAgeMs: 60 * DAY, nowMs: NOW });
  assert.deepEqual(plan.retained.map((e) => e.ageDays), [0, 1, 56]); // 56d is beyond keep but within max-age
  assert.deepEqual(plan.prune.map((e) => e.ageDays), [80, 84, 100]);

  const all = planServiceEnvBackupRotation(entries, { keep: 2, maxAgeMs: 0, nowMs: NOW });
  assert.deepEqual(all.prune.map((e) => e.ageDays), [56, 80, 84, 100]);

  const none = planServiceEnvBackupRotation(entries, { keep: 10, maxAgeMs: 0, nowMs: NOW });
  assert.deepEqual(none.prune, []);
});

test("#2268 rotateServiceEnvBackups is dry-run by default and deletes only with dryRun:false", async () => {
  const { envFile } = await fixture();
  const dry = await rotateServiceEnvBackups({ envFile, keep: 2, maxAgeMs: 60 * DAY, nowMs: NOW });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.total, 6);
  assert.equal(dry.pruned.length, 3);
  for (const path of dry.pruned) await stat(path); // still there

  const real = await rotateServiceEnvBackups({ envFile, keep: 2, maxAgeMs: 60 * DAY, nowMs: NOW, dryRun: false });
  assert.deepEqual(real.pruned, dry.pruned);
  for (const path of real.pruned) await assert.rejects(stat(path));
  assert.equal((await listServiceEnvBackups({ envFile, nowMs: NOW })).length, 3);
  await stat(envFile); // the live file is never touched
});

test("#2268 backupServiceEnvFile copies with mode 0600, refuses to overwrite, validates the tag, then rotates", async () => {
  const { envFile } = await fixture();
  const created = await backupServiceEnvFile({ envFile, tag: "deploy-abc123", keep: 3, maxAgeMs: 0, nowMs: NOW, dryRun: false });
  assert.match(created.backup, /a2a-hermes-worker\.bak-deploy-abc123-20260925T000000Z$/);
  assert.equal((await stat(created.backup)).mode & 0o777, 0o600);
  assert.equal(created.rotation.dryRun, false);
  // 7 backups existed after the copy; keep 3 → 4 pruned; the new copy has the newest mtime (now) so it is retained.
  assert.equal(created.rotation.total, 7);
  assert.equal(created.rotation.pruned.length, 4);
  assert.ok(created.rotation.retained.includes(created.backup));

  await assert.rejects(backupServiceEnvFile({ envFile, tag: "deploy-abc123", nowMs: NOW }), /EEXIST/);
  await assert.rejects(backupServiceEnvFile({ envFile, tag: "bad tag/../x", nowMs: NOW }), /invalid backup tag/);
});

test("#2268 doctor check: warn only when the rotation plan has prune candidates, fail on broad perms, ok when none", async () => {
  const { dir, envFile } = await fixture();

  // ages newest-first: 0, 1, 56, 80, 84, 100 — keep 2, max-age 60d → 80/84/100 are prune candidates.
  const beyond = await checkServiceEnvBackups({ envFile, nowMs: NOW, maxCount: 2, maxAgeMs: 60 * DAY });
  assert.equal(beyond.status, "warn");
  assert.match(beyond.message, /3 of 6 service env backups are beyond retention \(keep newest 2, then drop older than 60d\)/);
  assert.match(String(beyond.detail?.hint), /env-backups --env-file .* --keep 2 --max-age 60d --prune/);
  assert.equal(beyond.detail?.pruneCandidates, 3);

  // H4: more than `keep`, but everything beyond keep is within max-age → the rotation retains it, so no warn.
  const overCountWithinAge = await checkServiceEnvBackups({ envFile, nowMs: NOW, maxCount: 2, maxAgeMs: 365 * DAY });
  assert.equal(overCountWithinAge.status, "ok", JSON.stringify(overCountWithinAge));
  assert.equal(overCountWithinAge.detail?.pruneCandidates, 0);

  // H4: oldest is past max-age, but it is inside `keep` → retained by rotation, so no warn.
  const oldButKept = await checkServiceEnvBackups({ envFile, nowMs: NOW, maxCount: 10, maxAgeMs: 30 * DAY });
  assert.equal(oldButKept.status, "ok", JSON.stringify(oldButKept));

  const tight = await checkServiceEnvBackups({ envFile, nowMs: NOW, maxCount: 10, maxAgeMs: 365 * DAY });
  assert.equal(tight.status, "ok", JSON.stringify(tight));

  await chmod(join(dir, "a2a-hermes-worker.bak-fresh-20260924T230000Z"), 0o644);
  const broad = await checkServiceEnvBackups({ envFile, nowMs: NOW, maxCount: 10, maxAgeMs: 365 * DAY });
  assert.equal(broad.status, "fail");
  assert.match(broad.message, /readable beyond the owner/);
  assert.deepEqual((broad.detail as { broadPerms: string[] }).broadPerms.length, 1);

  const emptyDir = await mkdtemp(join(tmpdir(), "a2a-env-backups-empty-"));
  const lone = join(emptyDir, "a2a-hermes-worker");
  await writeFile(lone, "x\n");
  const none = await checkServiceEnvBackups({ envFile: lone, nowMs: NOW });
  assert.equal(none.status, "ok");
  assert.equal(none.detail?.count, 0);
});

test("#2268 H4 doctor/rotation parity: applying the hinted prune always clears the warn (fleet defaults keep 5 / 30d)", async () => {
  const { envFile } = await fixture();
  const before = await checkServiceEnvBackups({ envFile, nowMs: NOW });
  assert.equal(before.status, "warn"); // 100d is beyond keep 5 and older than 30d
  assert.equal(before.detail?.pruneCandidates, 1);

  const rotated = await rotateServiceEnvBackups({ envFile, keep: 5, maxAgeMs: 30 * DAY, nowMs: NOW, dryRun: false });
  assert.equal(rotated.pruned.length, 1);

  const after = await checkServiceEnvBackups({ envFile, nowMs: NOW });
  assert.equal(after.status, "ok", JSON.stringify(after));
  assert.equal(after.detail?.count, 5);
});
