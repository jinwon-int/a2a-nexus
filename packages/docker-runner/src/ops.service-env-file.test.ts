import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServiceEnvFile } from "./ops.js";

/**
 * #2267: fleet nodes carried a stale CLI-default env file next to the live
 * systemd EnvironmentFile; doctor/cleanup must surface that instead of silently
 * reading the stale copy.
 */

async function fixture(): Promise<{ dir: string; stale: string; live: string }> {
  const dir = await mkdtemp(join(tmpdir(), "a2a-service-env-"));
  const stale = join(dir, "openclaw-a2a-worker");
  const live = join(dir, "a2a-hermes-worker");
  await writeFile(stale, "A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=hermes\n", "utf8");
  await writeFile(live, "A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=claude-code\n", "utf8");
  const old = new Date("2026-06-10T06:58:00Z");
  const recent = new Date("2026-09-23T06:11:00Z");
  await utimes(stale, old, old);
  await utimes(live, recent, recent);
  return { dir, stale, live };
}

test("#2267 service env file check warns when the resolved file is older than a known alternate", async () => {
  const { stale, live } = await fixture();
  const report = await checkServiceEnvFile({ envFile: stale, knownEnvFiles: [stale, live] });
  assert.equal(report.status, "warn");
  assert.match(report.message, /older than .*a2a-hermes-worker/);
  assert.match(report.message, /--env-file/);
  const newer = (report.detail as { newerAlternates: Array<{ path: string }> }).newerAlternates;
  assert.deepEqual(newer.map((alt) => alt.path), [live]);
});

test("#2267 service env file check passes when the resolved file is the newest known file", async () => {
  const { stale, live } = await fixture();
  const report = await checkServiceEnvFile({ envFile: live, knownEnvFiles: [stale, live] });
  assert.equal(report.status, "ok", JSON.stringify(report));
  const alternates = (report.detail as { alternates: Array<{ path: string }> }).alternates;
  assert.deepEqual(alternates.map((alt) => alt.path), [stale]);
});

test("#2267 service env file check warns and names the alternate when the resolved file is missing", async () => {
  const { dir, live } = await fixture();
  const missing = join(dir, "does-not-exist");
  const report = await checkServiceEnvFile({ envFile: missing, knownEnvFiles: [missing, live] });
  assert.equal(report.status, "warn");
  assert.match(report.message, /not found/);
  assert.match(report.message, new RegExp(`--env-file ${live.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("#2267 service env file check warns (without alternate hint) when nothing else is known", async () => {
  const { dir } = await fixture();
  const missing = join(dir, "does-not-exist");
  const report = await checkServiceEnvFile({ envFile: missing, knownEnvFiles: [missing] });
  assert.equal(report.status, "warn");
  assert.doesNotMatch(report.message, /--env-file/);
});
