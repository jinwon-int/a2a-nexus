// #2315: broker-side recognition of the docker-runner `danso` patch profile —
// the pre-claim extra-mounts readiness preflight and the heartbeat progress
// scan. No docker, provider, or network access.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { A2ABrokerWorker } from "./broker-worker-client.js";
import {
  isProtectedDockerRunnerMountPath,
  normalizeDockerRunnerPatchProfile,
  validateDockerRunnerExtraMountsReadiness,
} from "./docker-runner-mounts-preflight.js";
import type { BrokerWorkerConfig } from "../worker.js";

test("danso is a recognized docker-runner patch profile; unknown names stay unrecognized", () => {
  assert.equal(normalizeDockerRunnerPatchProfile("danso"), "danso");
  assert.equal(normalizeDockerRunnerPatchProfile(" Danso_CLI "), "danso");
  assert.equal(normalizeDockerRunnerPatchProfile("dansoo"), undefined);
  // Existing mappings are unchanged.
  assert.equal(normalizeDockerRunnerPatchProfile("cccb"), "claude-code");
  assert.equal(normalizeDockerRunnerPatchProfile("piri"), undefined);
});

test("danso extra mounts preflight requires /run/secrets/danso-dir from the configured source", () => {
  const mounts = (entries: unknown[]) => JSON.stringify(entries);
  assert.throws(
    () => validateDockerRunnerExtraMountsReadiness({
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "danso",
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: mounts([{ source: "/srv/scratch", target: "/scratch" }]),
    }),
    /danso patch profile requires a \/run\/secrets\/danso-dir mount/,
  );
  assert.throws(
    () => validateDockerRunnerExtraMountsReadiness({
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "danso",
      A2A_DOCKER_RUNNER_DANSO_CONFIG_DIR: "/srv/danso-glm",
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: mounts([{ source: "/srv/other", target: "/run/secrets/danso-dir", readOnly: true }]),
    }),
    /\/run\/secrets\/danso-dir source conflicts with the configured danso profile directory/,
  );
  assert.doesNotThrow(() => validateDockerRunnerExtraMountsReadiness({
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "danso",
    A2A_DOCKER_RUNNER_DANSO_CONFIG_DIR: "/srv/danso-glm",
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: mounts([{ source: "/srv/danso-glm", target: "/run/secrets/danso-dir", readOnly: true }]),
  }));
  assert.throws(
    () => validateDockerRunnerExtraMountsReadiness({
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "danso",
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: mounts([{ source: "/root/.config/danso", target: "/run/secrets/danso-dir", readOnly: false }]),
    }),
    /writable agent runtime\/session paths are forbidden/,
  );
  for (const path of ["/root/.config/danso", "/home/worker/.config/danso/glm.env", "/run/secrets/danso-dir"]) {
    assert.equal(isProtectedDockerRunnerMountPath(path), true, path);
  }
  assert.equal(isProtectedDockerRunnerMountPath("/root/.config/dansox"), false);
});

function makeWorker(): A2ABrokerWorker {
  const config: BrokerWorkerConfig = {
    brokerUrl: "http://broker.test",
    requesterKind: "node",
    pollIntervalMs: 5_000,
    heartbeatIntervalMs: 30_000,
    handlerTimeoutMs: 60_000,
    worker: {
      nodeId: "workerbeta",
      role: "analyst",
      capabilities: {
        canAnalyze: false,
        canBackfill: false,
        canPatchWorkspace: true,
        canPromoteLive: false,
        workspaceIds: ["test"],
        environments: ["research" as const],
      },
    },
    userAgent: "test-agent",
    handler: async () => ({}),
  };
  const fetchImpl = async () => new Response(JSON.stringify({ nodeId: "workerbeta" }), { status: 200 });
  return new A2ABrokerWorker(config, { fetchImpl: fetchImpl as never });
}

test("heartbeat progress scan reads the danso patch lane's danso-progress.jsonl", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-danso-progress-"));
  const saved = { runner: process.env.A2A_DOCKER_RUNNER_ROOT, piri: process.env.A2A_PIRI_WORK_ROOT };
  try {
    const artifacts = join(root, "tasks", "danso-task-1", "run-abc", "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const progress = join(artifacts, "danso-progress.jsonl");
    writeFileSync(progress, '{"type":"danso_message_completed","version":1}\n');
    const mtime = new Date("2026-10-04T01:02:03.000Z");
    utimesSync(progress, mtime, mtime);
    process.env.A2A_DOCKER_RUNNER_ROOT = join(root, "tasks");
    process.env.A2A_PIRI_WORK_ROOT = join(root, "no-piri-root");

    const inner = makeWorker() as unknown as { scanTaskProgressAt(taskId: string): Promise<string | undefined> };
    assert.equal(await inner.scanTaskProgressAt("danso-task-1"), mtime.toISOString());
    assert.equal(await inner.scanTaskProgressAt("other-task"), undefined);
  } finally {
    if (saved.runner === undefined) delete process.env.A2A_DOCKER_RUNNER_ROOT;
    else process.env.A2A_DOCKER_RUNNER_ROOT = saved.runner;
    if (saved.piri === undefined) delete process.env.A2A_PIRI_WORK_ROOT;
    else process.env.A2A_PIRI_WORK_ROOT = saved.piri;
    rmSync(root, { recursive: true, force: true });
  }
});
