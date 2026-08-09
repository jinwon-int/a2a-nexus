import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { validateTaskCompletionEvidence } from "./worker.js";
import type { TaskRecord } from "./core/types.js";

const handlerPath = "scripts/a2a-task-handler.mjs";
const hermesAnalysisBridgePath = "scripts/hermes-a2a-analysis-bridge.mjs";

interface GithubTaskFixture {
  id: string;
  intent: "propose_patch" | "analyze" | "verify";
  message: string;
  payload: Record<string, unknown>;
  proposalId: string;
  exchangeId: string;
}

function githubTask(overrides?: Partial<GithubTaskFixture>): GithubTaskFixture {
  return {
    id: "task-fixture-1",
    intent: "propose_patch",
    message: "generic chat/proposal lifecycle fixture",
    payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#1" },
    proposalId: "proposal-fixture-1",
    exchangeId: "exchange-fixture-1",
    ...overrides,
  };
}

function makeTaskRecord(task: GithubTaskFixture): TaskRecord {
  return {
    id: task.id,
    intent: task.intent as TaskRecord["intent"],
    requester: { id: "test-requester", role: "hub" },
    target: { id: "test-target", role: "operator" },
    message: task.message,
    payload: task.payload,
    proposalId: task.proposalId,
    exchangeId: task.exchangeId,
    status: "running" as const,
    targetNodeId: "test-target",
    assignedWorkerId: "test-worker",
    taskOrigin: "github" as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test("versioned A2A task handler exposes credential-free build metadata", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask({ intent: "analyze", payload: { mode: "analysis" } })),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.handler.name, "a2a-task-handler");
  assert.equal(payload.result.handler.version, "0.2.16");
  assert.equal(payload.result.handler.source, "repo:scripts/a2a-task-handler.mjs");
  assert.match(payload.result.handler.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(payload.result.handler.credentialFree, true);
  assert.equal(payload.result.handler.hostNeutral, true);
  assert.equal(payload.result.lifecycle.mode, "analysis");
});

test("versioned A2A task handler source does not embed credentials or host paths", () => {
  const source = readFileSync(handlerPath, "utf8");
  assert.doesNotMatch(source, /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|refresh_token)/i);
  assert.doesNotMatch(source, /\/root\//);
  assert.doesNotMatch(source, /workergamma|workerepsilon|workerbeta|workerdelta/i);
});


test("explicit all-github flag routes GitHub propose_patch tasks through docker runner", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-runner-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (process.argv[2] !== "run") throw new Error("expected run subcommand");
if (task.repo !== "owner/repo") throw new Error("expected repo mapping");
if (task.mode !== "github-propose-patch") throw new Error("expected mode propagation");
if (task.issue !== "#1") throw new Error("expected issue propagation");
if (task.issueUrl !== "https://github.com/owner/repo/issues/1") throw new Error("expected issueUrl propagation");
if (task.reportLanguage !== "ko") throw new Error("expected reportLanguage propagation");
if (task.requestedBy !== "brokeralpha-test") throw new Error("expected requestedBy propagation");
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  stdout: "https://github.com/owner/repo/pull/123",
  stderr: "",
  artifacts: ["/tmp/work-fixture/artifacts/summary.txt"],
  prUrl: "https://github.com/owner/repo/pull/123"
}));
`);

    const task = githubTask({
      payload: {
        mode: "github-propose-patch",
        repo: "owner/repo",
        issue: "#1",
        issueUrl: "https://github.com/owner/repo/issues/1",
        reportLanguage: "ko",
        requestedBy: "brokeralpha-test",
      },
    });
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.summary, "docker runner completed task-fixture-1");
    assert.equal(payload.result.output.github.prUrl, "https://github.com/owner/repo/pull/123");
    assert.equal(payload.result.output.prUrl, "https://github.com/owner/repo/pull/123");
    assert.deepEqual(payload.result.output.runner.artifacts, ["/tmp/work-fixture/artifacts/summary.txt"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("feature flag alone rejects non-plugin GitHub tasks when no bridge is configured", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask()),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_DOCKER_RUNNER_ENABLED: "1",
      A2A_DOCKER_RUNNER_BIN: "/path/that/should/not/run",
      OPENCLAW_BIN: "",
    },
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "github_executor_not_configured");
  assert.equal(payload.error.details.executorMode, "auto");
  assert.equal(payload.error.details.dockerScope, "plugin-only");
});

test("A2A_EXECUTOR_MODE=builtin refuses GitHub no-op success even with legacy docker flags", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask()),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_DOCKER_RUNNER_ENABLED: "1",
      A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
      A2A_DOCKER_RUNNER_BIN: "/path/that/should/not/run",
    },
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "github_executor_not_configured");
  assert.equal(payload.error.details.executorMode, "builtin");
});

test("A2A_EXECUTOR_MODE=docker routes GitHub propose_patch tasks without legacy gate", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-executor-docker-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (task.repo !== "owner/repo") throw new Error("expected repo mapping");
console.log(JSON.stringify({ ok: true, taskId: task.id, status: "completed", workDir: "/tmp/work-fixture", artifacts: [], prUrl: "https://github.com/owner/repo/pull/123" }));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "docker",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.github.prUrl, "https://github.com/owner/repo/pull/123");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("A2A_EXECUTOR_MODE=auto respects A2A_DOCKER_RUNNER_SCOPE=all-github", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-executor-scope-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
console.log(JSON.stringify({ ok: true, taskId: "task-fixture-1", status: "completed", workDir: "/tmp/work-fixture", artifacts: [], doneCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-123" }));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.github.doneCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-123");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("all-github auto falls back to host OpenClaw bridge when Claude Docker config is blocked", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-blocked-claude-bridge-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  const fakeOpenClawPath = join(tempDir, "fake-openclaw.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
throw new Error("docker runner should not run when Claude Docker config is blocked and bridge is configured");
`);
    writeFileSync(fakeOpenClawPath, `#!/usr/bin/env node
console.log(JSON.stringify({
  payloads: [{
    text: JSON.stringify({
      status: "blocked",
      summary: "bridge handled blocked Claude Docker config",
      blockCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-456",
      tests: ["bridge fallback fixture -> pass"],
      risks: []
    })
  }]
}));
`);
    chmodSync(fakeOpenClawPath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
        A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["claude", "--print", "hello"] }),
        A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
          { source: "/tmp/.claude", target: "/opt/claude-dir", readOnly: true },
        ]),
        OPENCLAW_BIN: fakeOpenClawPath,
        A2A_NODE_ID: "worker-bridge-fallback",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.summary, "bridge handled blocked Claude Docker config");
    assert.equal(payload.result.output.github.outcome, "blocked");
    assert.equal(payload.result.output.github.blockCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-456");
    assert.equal(payload.result.output.nodeId, "worker-bridge-fallback");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("explicit Claude-in-Docker opt-in keeps all-github tasks on docker runner", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-claude-opt-in-docker-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  const fakeOpenClawPath = join(tempDir, "fake-openclaw.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
console.log(JSON.stringify({ ok: true, taskId: "task-fixture-1", status: "completed", workDir: "/tmp/work-fixture", artifacts: [], prUrl: "https://github.com/owner/repo/pull/789" }));
`);
    writeFileSync(fakeOpenClawPath, `#!/usr/bin/env node
throw new Error("bridge should not run when Claude-in-Docker is explicitly allowed");
`);
    chmodSync(fakeOpenClawPath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_ALLOW_CLAUDE_IN_DOCKER: "1",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
        A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["claude", "--print", "hello"] }),
        OPENCLAW_BIN: fakeOpenClawPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.summary, "docker runner completed task-fixture-1");
    assert.equal(payload.result.output.github.prUrl, "https://github.com/owner/repo/pull/789");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("A2A_EXECUTOR_MODE=auto rejects plugin-only non-plugin GitHub task without OpenClaw bridge", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask()),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "auto",
      A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
      A2A_DOCKER_RUNNER_BIN: "/path/that/should/not/run",
      OPENCLAW_BIN: "",
    },
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "github_executor_not_configured");
  assert.equal(payload.error.details.executorMode, "auto");
  assert.equal(payload.error.details.dockerScope, "plugin-only");
});

test("plugin-only GitHub tasks use host OpenClaw bridge when configured", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-openclaw-bridge-test-"));
  const fakeOpenClawPath = join(tempDir, "fake-openclaw.mjs");
  try {
    writeFileSync(fakeOpenClawPath, `#!/usr/bin/env node
if (!process.argv.includes("agent")) throw new Error("expected agent subcommand");
if (!process.argv.includes("--json")) throw new Error("expected json output flag");
console.log(JSON.stringify({
  payloads: [{
    text: JSON.stringify({
      status: "pr_opened",
      summary: "bridge completed",
      prUrl: "https://github.com/owner/repo/pull/456",
      branch: "bridge-fixture",
      tests: ["fake bridge -> pass"],
      filesChanged: ["src/example.ts"],
      risks: []
    })
  }]
}));
`);
    chmodSync(fakeOpenClawPath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
        OPENCLAW_BIN: fakeOpenClawPath,
        A2A_NODE_ID: "worker-a",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.summary, "bridge completed");
    assert.equal(payload.result.output.github.outcome, "pr_opened");
    assert.equal(payload.result.output.github.prUrl, "https://github.com/owner/repo/pull/456");
    assert.equal(payload.result.output.prUrl, "https://github.com/owner/repo/pull/456");
    assert.equal(payload.result.output.branch, "bridge-fixture");
    assert.deepEqual(payload.result.output.tests, ["fake bridge -> pass"]);
    assert.deepEqual(payload.result.output.filesChanged, ["src/example.ts"]);
    assert.equal(payload.result.output.nodeId, "worker-a");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw bridge can be disabled explicitly", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask()),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "auto",
      A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
      OPENCLAW_BIN: "/path/that/should/not/run",
      A2A_OPENCLAW_BRIDGE_DISABLED: "1",
    },
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "github_executor_not_configured");
  assert.equal(payload.error.details.bridgeConfigured, false);
});



test("docker runner preserves Start marker URL alongside terminal PR evidence (#354)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-start-marker-354-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (!task.prompt.includes("Leave a Start marker")) throw new Error("expected Start marker instruction");
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  startCommentUrl: "https://github.com/owner/repo/issues/354#issuecomment-start",
  prUrl: "https://github.com/owner/repo/pull/354"
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask({ payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#354" } })),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "docker",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.startCommentUrl, "https://github.com/owner/repo/issues/354#issuecomment-start");
    assert.equal(payload.result.output.github.startCommentUrl, "https://github.com/owner/repo/issues/354#issuecomment-start");
    assert.equal(payload.result.output.prUrl, "https://github.com/owner/repo/pull/354");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner Start marker alone is not terminal evidence (#354)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-start-only-354-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
console.log(JSON.stringify({
  ok: true,
  taskId: "task-fixture-1",
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  startCommentUrl: "https://github.com/owner/repo/issues/354#issuecomment-start"
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask({ payload: { mode: "github-propose-patch", repo: "owner/repo", issue: "#354" } })),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "docker",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "docker_runner_evidence_missing");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner failures surface as handler errors", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-runner-fail-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
console.log(JSON.stringify({
  ok: false,
  taskId: "task-fixture-1",
  status: "failed",
  error: "runner fixture failed",
  artifacts: []
}));
process.exit(1);
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "docker_runner_failed");
    assert.equal(payload.error.message, "runner fixture failed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("openclaw-plugin-a2a repo requests map to the plugin runner preset", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-plugin-preset-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (task.preset !== "openclaw-plugin-a2a-dev") throw new Error("expected plugin preset");
console.log(JSON.stringify({ ok: true, taskId: task.id, status: "completed", workDir: "/tmp/work-fixture", artifacts: [], prUrl: "https://github.com/jinwon-int/openclaw-plugin-a2a/pull/1" }));
`);

    const task = githubTask();
    task.payload.repo = "jinwon-int/openclaw-plugin-a2a";
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.runner.status, "completed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ——— docker-runner contract hardening regression tests (issue #169) ———

test("docker runner timeout surfaces as structured handler error (contract #169)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-timeout-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
console.log(JSON.stringify({
  ok: false,
  taskId: "task-fixture-1",
  status: "timeout",
  error: "runner timed out after 600s",
  artifacts: []
}));
process.exit(1);
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "docker_runner_timeout");
    assert.match(payload.error.message, /timed out/);
    assert.equal(payload.error.details.exitCode, 1);
    assert.ok(payload.error.details.runnerResult, "should include runner result details");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("github issue-instruction tasks fail closed when no executor evidence path is configured", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask({ payload: { mode: "github-issue-instruction", repo: "owner/repo", issue: "#1" } })),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_DOCKER_RUNNER_ENABLED: "1",
      A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
      A2A_DOCKER_RUNNER_BIN: "/path/that/should/not/run",
    },
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "github_executor_not_configured");
  assert.equal(payload.error.details.executorMode, "builtin");
});

test("github issue-instruction runner success without evidence surfaces as docker_runner_evidence_missing", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-issue-instruction-no-evidence-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (task.mode !== "github-issue-instruction") throw new Error("expected github-issue-instruction, got " + task.mode);
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: []
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask({ payload: { mode: "github-issue-instruction", repo: "owner/repo", issue: "#1" } })),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "docker",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "docker_runner_evidence_missing");
    assert.match(payload.error.message, /docker runner completed but produced no PR\/Done\/Block evidence/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner failure surfaces OpenClaw bootstrap leak paths when runner reports them", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-bootstrap-leak-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (!task.prompt.includes("Report the exact repo-relative offending paths")) {
  throw new Error("missing bootstrap leak prompt guard");
}
console.log(JSON.stringify({
  ok: false,
  status: "blocked",
  error: "openclaw_workspace_bootstrap_leak: AGENTS.md .openclaw/workspace-state.json",
  artifacts: ["AGENTS.md", ".openclaw/workspace-state.json"]
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "docker_runner_failed");
    assert.deepEqual(payload.error.details.openclawBootstrapLeakPaths, [
      ".openclaw/workspace-state.json",
      "AGENTS.md",
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner success fails closed when evidence includes OpenClaw bootstrap paths (#522)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-bootstrap-success-leak-522-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
console.log(JSON.stringify({
  ok: true,
  taskId: "task-fixture-1",
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: ["evidence/summary.md", "AGENTS.md", ".openclaw/session.json"],
  filesChanged: ["src/server.ts", "TOOLS.md"],
  prUrl: "https://github.com/owner/repo/pull/522"
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "docker_runner_openclaw_bootstrap_leak");
    assert.deepEqual(payload.error.details.openclawBootstrapLeakPaths, [
      ".openclaw/session.json",
      "AGENTS.md",
      "TOOLS.md",
    ]);
    assert.match(payload.error.message, /refusing GitHub completion evidence/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});


test("docker runner success without evidence surfaces as docker_runner_evidence_missing (contract #169)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-no-evidence-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    // runner exits 0 and ok=true but has no prUrl / doneCommentUrl / blockCommentUrl
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: ["/tmp/work-fixture/summary.txt"]
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "docker_runner_evidence_missing");
    assert.match(payload.error.message, /docker runner completed but produced no PR\/Done\/Block evidence/);
    assert.deepEqual(payload.error.details.requiredEvidence, ["prUrl", "doneCommentUrl", "blockCommentUrl"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});


test("explicit GitHub runner commands propagate to docker runner", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-explicit-commands-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (task.intent !== "verify") throw new Error("expected verify intent propagation");
if (task.mode !== "github-verify") throw new Error("expected github-verify mode propagation");
if (task.repo !== "owner/repo") throw new Error("expected repo mapping");
if (JSON.stringify(task.commands) !== JSON.stringify(["python -m pytest -q tests"])) {
  throw new Error(` + "`expected explicit commands propagation, got ${JSON.stringify(task.commands)}`" + `);
}
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  doneCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-456"
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask({
        intent: "verify",
        payload: {
          mode: "github-verify",
          repo: "owner/repo",
          issue: "#1",
          commands: ["python -m pytest -q tests"],
        },
      })),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.doneCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-456");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("github-verify tasks route through docker runner instead of built-in generic success", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-github-verify-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (process.argv[2] !== "run") throw new Error("expected run subcommand");
if (task.intent !== "verify") throw new Error("expected verify intent propagation");
if (task.mode !== "github-verify") throw new Error("expected github-verify mode propagation");
if (task.repo !== "owner/repo") throw new Error("expected repo mapping");
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  noDiff: true,
  doneCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-789"
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask({ intent: "verify", payload: { mode: "github-verify", repo: "owner/repo", issue: "#1" } })),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.summary, "docker runner completed task-fixture-1");
    assert.equal(payload.result.lifecycle.intent, "verify");
    assert.equal(payload.result.lifecycle.mode, "github-verify");
    assert.equal(payload.result.output.doneCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-789");
    assert.doesNotMatch(payload.result.summary, /generic github-verify/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("family-wiki-readonly-audit tasks route through docker runner instead of built-in generic success", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-family-wiki-audit-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (process.argv[2] !== "run") throw new Error("expected run subcommand");
if (task.intent !== "verify") throw new Error("expected verify intent propagation");
if (task.mode !== "family-wiki-readonly-audit") throw new Error("expected family wiki mode propagation");
if (task.repo !== "jinwon-int/seoyoon-family-wiki") throw new Error("expected family wiki repo mapping");
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  noDiff: true,
  doneCommentUrl: "https://github.com/jinwon-int/seoyoon-family-wiki/issues/894#issuecomment-family-wiki-audit"
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask({
        intent: "verify",
        payload: { mode: "family-wiki-readonly-audit", repo: "jinwon-int/seoyoon-family-wiki", issue: "#894" },
      })),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.summary, "docker runner completed task-fixture-1");
    assert.equal(payload.result.lifecycle.intent, "verify");
    assert.equal(payload.result.lifecycle.mode, "family-wiki-readonly-audit");
    assert.equal(payload.result.output.doneCommentUrl, "https://github.com/jinwon-int/seoyoon-family-wiki/issues/894#issuecomment-family-wiki-audit");
    assert.doesNotMatch(payload.result.summary, /generic family-wiki-readonly-audit/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("github-libero-validation verify tasks route through docker runner with Done evidence", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-github-libero-test-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (process.argv[2] !== "run") throw new Error("expected run subcommand");
if (task.intent !== "verify") throw new Error("expected verify intent propagation");
if (task.mode !== "github-libero-validation") throw new Error("expected github-libero-validation mode propagation");
if (task.readOnlyValidation !== true) throw new Error("expected readOnlyValidation propagation");
if (task.repo !== "owner/repo") throw new Error("expected repo mapping");
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  doneCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-libero-done"
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask({ intent: "verify", payload: { mode: "github-libero-validation", repo: "owner/repo", issue: "#1" } })),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.lifecycle.intent, "verify");
    assert.equal(payload.result.lifecycle.mode, "github-libero-validation");
    assert.equal(payload.result.output.doneCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-libero-done");
    assert.doesNotMatch(payload.result.summary, /generic github-libero-validation/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker broker noop smoke has dedicated non-generic handler evidence", () => {
  const smokeTask = githubTask();
  smokeTask.id = "smoke-task-1";
  smokeTask.intent = "analyze";
  (smokeTask as unknown as { assignedWorkerId: string }).assignedWorkerId = "workergamma";
  smokeTask.payload = {
    schemaVersion: 1,
    mode: "docker-broker-noop-smoke",
    noOp: true,
    runId: "smoke-run-1",
    worker: "workergamma",
  };

  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(smokeTask),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_DOCKER_RUNNER_ENABLED: "1",
      A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
      A2A_DOCKER_RUNNER_BIN: "/path/that/should/not/run",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.summary, "docker broker noop smoke completed smoke-task-1");
  assert.equal(payload.result.lifecycle.mode, "docker-broker-noop-smoke");
  assert.equal(payload.result.output.smoke.ok, true);
  assert.equal(payload.result.output.smoke.runId, "smoke-run-1");
  assert.doesNotMatch(payload.result.summary, /generic .* accepted by versioned A2A task handler/);
});

test("evidence-missing check skips non-github tasks on built-in handler path (contract #169)", () => {
  // non-github tasks use the built-in handler path; they complete without evidence.
  const nonGhTask = githubTask();
  nonGhTask.payload.mode = "analysis";
  nonGhTask.intent = "analyze";

  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(nonGhTask),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_DOCKER_RUNNER_ENABLED: "1",
      A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
      A2A_DOCKER_RUNNER_BIN: "/path/that/should/not/run",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.result, "non-github tasks should succeed via built-in handler");
  // built-in handler summary confirms no runner was invoked (and no evidence check)
  assert.match(payload.result.summary, /accepted by versioned A2A task handler/);
});

test("docker runner prUrl output passes validateTaskCompletionEvidence (contract #169 regression)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-vtce-pr-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  prUrl: "https://github.com/owner/repo/pull/123"
}));
`);

    const task = githubTask();
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.prUrl, "https://github.com/owner/repo/pull/123");
    assert.equal(payload.result.output.github.prUrl, "https://github.com/owner/repo/pull/123");

    // regression: validateTaskCompletionEvidence must accept this output
    const evidenceError = validateTaskCompletionEvidence(
      makeTaskRecord(task),
      payload.result,
    );
    assert.equal(evidenceError, null, `should not reject prUrl evidence: ${JSON.stringify(evidenceError)}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner doneCommentUrl output passes validateTaskCompletionEvidence (contract #169 regression)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-vtce-done-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  github: { doneCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-123" }
}));
`);

    const task = githubTask();
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.doneCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-123");
    assert.equal(payload.result.output.github.doneCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-123");

    // regression: validateTaskCompletionEvidence must accept doneCommentUrl evidence
    const evidenceError = validateTaskCompletionEvidence(
      makeTaskRecord(task),
      payload.result,
    );
    assert.equal(evidenceError, null, `should not reject doneCommentUrl evidence: ${JSON.stringify(evidenceError)}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner blockCommentUrl output passes validateTaskCompletionEvidence (contract #169 regression)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-vtce-block-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  blockCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-456"
}));
`);

    const task = githubTask();
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.blockCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-456");
    assert.equal(payload.result.output.github.blockCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-456");

    // regression: validateTaskCompletionEvidence must accept blockCommentUrl evidence
    const evidenceError = validateTaskCompletionEvidence(
      makeTaskRecord(task),
      payload.result,
    );
    assert.equal(evidenceError, null, `should not reject blockCommentUrl evidence: ${JSON.stringify(evidenceError)}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner evidence-missing fails validateTaskCompletionEvidence (contract #169 regression)", () => {
  // Evidence-missing error from handler already maps to handler error,
  // but verify directly that an empty runner-style result also fails the gate
  const task = githubTask();
  const emptyResult = {
    summary: "completed with no evidence",
    handler: { name: "a2a-task-handler", version: "0.2.2" },
    lifecycle: {
      intent: task.intent,
      mode: task.payload.mode,
      taskId: task.id,
    },
    output: {
      startCommentUrl: "https://github.com/owner/repo/issues/169#issuecomment-start",
      runner: { status: "completed", artifacts: ["/work/artifacts/summary.txt"] },
      logPath: "/work/artifacts/hermes-output.txt",
    },
  };

  const evidenceError = validateTaskCompletionEvidence(makeTaskRecord(task), emptyResult);
  assert.ok(evidenceError, "should reject empty result from github-propose-patch task");
  assert.equal(evidenceError!.code, "github_completion_evidence_missing");
  assert.equal(
    (evidenceError!.details?.observedEvidence as Record<string, unknown>).startCommentUrl,
    "https://github.com/owner/repo/issues/169#issuecomment-start",
  );
  assert.deepEqual(
    (evidenceError!.details?.observedEvidence as Record<string, unknown>).runnerArtifacts,
    ["/work/artifacts/summary.txt"],
  );
  assert.equal(
    (evidenceError!.details?.observedEvidence as Record<string, unknown>).logPath,
    "/work/artifacts/hermes-output.txt",
  );
});

test("GitHub read-only validation requires Done or Block evidence but not a PR", () => {
  const task = githubTask({
    intent: "verify",
    payload: { mode: "github-verify", repo: "owner/repo", issue: "#527" },
  });
  const taskRecord = { ...makeTaskRecord(task), taskOrigin: "github" as const };

  const missingEvidenceError = validateTaskCompletionEvidence(
    taskRecord,
    { summary: "read-only validation completed", output: { runner: { status: "completed", artifacts: [] } } } as any,
  );
  assert.equal(missingEvidenceError?.code, "github_completion_evidence_missing");

  const prOnlyEvidenceError = validateTaskCompletionEvidence(
    taskRecord,
    { summary: "read-only validation completed", output: { prUrl: "https://github.com/owner/repo/pull/527" } } as any,
  );
  assert.equal(prOnlyEvidenceError?.code, "github_completion_evidence_missing");
  assert.match(prOnlyEvidenceError?.message ?? "", /Done-comment or Block-comment/);

  const doneEvidenceError = validateTaskCompletionEvidence(
    taskRecord,
    { summary: "read-only validation completed", output: { doneCommentUrl: "https://github.com/owner/repo/issues/527#issuecomment-done" } } as any,
  );
  assert.equal(doneEvidenceError, null);

  const structuredBlockError = validateTaskCompletionEvidence(
    taskRecord,
    {
      summary: "github read-only verification blocked: evidence executor is not configured",
      output: {
        analysisStatus: "blocked",
        analysisKind: "github_readonly_executor_preflight",
        blockReason: "github_readonly_executor_not_configured",
        executorMode: "auto",
        dockerScope: "plugin-only",
      },
    } as any,
  );
  assert.equal(structuredBlockError, null);
});

test("GitHub read-only review task succeeds on a review verdict without a Done/Block marker (#654)", () => {
  const task = githubTask({
    intent: "analyze",
    payload: { mode: "github-read-only-validation", repo: "owner/repo", prUrl: "https://github.com/owner/repo/pull/652" },
  });
  const taskRecord = { ...makeTaskRecord(task), taskOrigin: "github" as const };

  // Flat reviewVerdict + body reference (url) is canonical completion evidence.
  const flatVerdictError = validateTaskCompletionEvidence(
    taskRecord,
    { summary: "reviewed", output: { reviewVerdict: "approve", reviewBodyUrl: "https://github.com/owner/repo/pull/652#pullrequestreview-1" } } as any,
  );
  assert.equal(flatVerdictError, null);

  // Nested review.{verdict,bodyRef} with a non-url evidence ref also passes.
  const nestedVerdictError = validateTaskCompletionEvidence(
    taskRecord,
    { summary: "reviewed", output: { review: { verdict: "request_changes", bodyRef: "evidence://round/652/workerbeta" } } } as any,
  );
  assert.equal(nestedVerdictError, null);

  // A verdict without any body reference still fails closed.
  const verdictNoBodyError = validateTaskCompletionEvidence(
    taskRecord,
    { summary: "reviewed", output: { reviewVerdict: "comment" } } as any,
  );
  assert.equal(verdictNoBodyError?.code, "github_completion_evidence_missing");

  // A body reference with no/invalid verdict still fails closed.
  const bodyNoVerdictError = validateTaskCompletionEvidence(
    taskRecord,
    { summary: "reviewed", output: { reviewVerdict: "lgtm", reviewBodyUrl: "https://github.com/owner/repo/pull/652#issuecomment-2" } } as any,
  );
  assert.equal(bodyNoVerdictError?.code, "github_completion_evidence_missing");

  // Empty output (no verdict, no markers) still fails closed.
  const emptyError = validateTaskCompletionEvidence(
    taskRecord,
    { summary: "reviewed", output: { runner: { status: "completed", artifacts: [] } } } as any,
  );
  assert.equal(emptyError?.code, "github_completion_evidence_missing");
});

test("docker runner with multi-evidence output maps all URLs correctly (contract #169)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-multi-evidence-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: ["/tmp/work-fixture/summary.txt"],
  prUrl: "https://github.com/owner/repo/pull/10",
  doneCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-10",
  blockCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-11"
}));
`);

    const task = githubTask();
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_DOCKER_RUNNER_ENABLED: "1",
        A2A_DOCKER_RUNNER_ALL_GITHUB: "1",
        A2A_DOCKER_RUNNER_SCOPE: "all-github",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.prUrl, "https://github.com/owner/repo/pull/10");
    assert.equal(payload.result.output.doneCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-10");
    assert.equal(payload.result.output.blockCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-11");
    assert.equal(payload.result.output.github.prUrl, "https://github.com/owner/repo/pull/10");
    assert.equal(payload.result.output.github.doneCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-10");
    assert.equal(payload.result.output.github.blockCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-11");

    const evidenceError = validateTaskCompletionEvidence(
      makeTaskRecord(task),
      payload.result,
    );
    assert.equal(evidenceError, null, `multi-evidence should pass gate: ${JSON.stringify(evidenceError)}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ——— OpenClaw bridge watchdog and final-evidence safeguards (issue #193) ———

test("OpenClaw bridge SIGKILL surfaces as openclaw_bridge_timeout (issue #193 watchdog)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-bridge-kill-193-"));
  const fakeBridgePath = join(tempDir, "fake-openclaw-kill.mjs");
  try {
    writeFileSync(fakeBridgePath, `#!/usr/bin/env node
process.kill(process.pid, "SIGKILL");
`);
    chmodSync(fakeBridgePath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
        OPENCLAW_BIN: fakeBridgePath,
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "openclaw_bridge_timeout");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw bridge watchdog ETIMEDOUT surfaces as openclaw_bridge_timeout (issue #193 watchdog)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-bridge-watchdog-193-"));
  const fakeBridgePath = join(tempDir, "fake-openclaw-hang.mjs");
  try {
    writeFileSync(fakeBridgePath, `#!/usr/bin/env node
// keeps event loop alive so the watchdog must kill it
setTimeout(() => {}, 99999999);
`);
    chmodSync(fakeBridgePath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
        OPENCLAW_BIN: fakeBridgePath,
        A2A_OPENCLAW_WATCHDOG_MS: "1500",
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "openclaw_bridge_timeout");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw bridge empty output surfaces as openclaw_bridge_no_final_json (issue #193)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-bridge-nojson-193-"));
  const fakeBridgePath = join(tempDir, "fake-openclaw-empty.mjs");
  try {
    writeFileSync(fakeBridgePath, `#!/usr/bin/env node
process.stderr.write("bridge ran but produced no JSON output\\n");
`);
    chmodSync(fakeBridgePath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
        OPENCLAW_BIN: fakeBridgePath,
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "openclaw_bridge_no_final_json");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw bridge text-only output (no JSON) surfaces as openclaw_bridge_no_final_json (issue #193)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-bridge-textonly-193-"));
  const fakeBridgePath = join(tempDir, "fake-openclaw-textonly.mjs");
  try {
    writeFileSync(fakeBridgePath, `#!/usr/bin/env node
// envelope parses but inner text has no JSON
console.log(JSON.stringify({ payloads: [{ text: "I worked on it but could not finish. No structured result available." }] }));
`);
    chmodSync(fakeBridgePath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
        OPENCLAW_BIN: fakeBridgePath,
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "openclaw_bridge_no_final_json");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw bridge JSON without evidence URLs surfaces as openclaw_bridge_evidence_missing (issue #193)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-bridge-noevidence-193-"));
  const fakeBridgePath = join(tempDir, "fake-openclaw-noevidence.mjs");
  try {
    writeFileSync(fakeBridgePath, `#!/usr/bin/env node
// valid JSON in the response but no prUrl/doneCommentUrl/blockCommentUrl
console.log(JSON.stringify({ payloads: [{ text: JSON.stringify({ status: "done", summary: "work completed" }) }] }));
`);
    chmodSync(fakeBridgePath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
        OPENCLAW_BIN: fakeBridgePath,
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "openclaw_bridge_evidence_missing");
    assert.match(payload.error.message, /prUrl|doneCommentUrl|blockCommentUrl/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ——— docker-first readiness guard (issue #189) ———

test("A2A_EXECUTOR_MODE=docker without A2A_DOCKER_RUNNER_BIN returns docker_runner_not_configured (#189 readiness)", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask()),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "docker",
      A2A_DOCKER_RUNNER_BIN: "",
    },
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "docker_runner_not_configured");
  assert.equal(payload.error.details.executorMode, "docker");
  assert.deepEqual(payload.error.details.requiredEnv, ["A2A_DOCKER_RUNNER_BIN"]);
  assert.match(payload.error.message, /A2A_DOCKER_RUNNER_BIN/);
});

test("SCOPE=all-github without A2A_DOCKER_RUNNER_BIN returns docker_runner_not_configured (#189 readiness)", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(githubTask()),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "auto",
      A2A_DOCKER_RUNNER_SCOPE: "all-github",
      A2A_DOCKER_RUNNER_BIN: "",
    },
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "docker_runner_not_configured");
  assert.equal(payload.error.details.executorMode, "auto");
  assert.equal(payload.error.details.dockerScope, "all-github");
  assert.deepEqual(payload.error.details.requiredEnv, ["A2A_DOCKER_RUNNER_BIN"]);
});

// ——— docker-runner evidence metadata projection (issue #196) ———

test("docker runner output preserves repo/issue/issueUrl/nodeId/taskId trace fields (issue #196)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-trace-fields-196-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
console.log(JSON.stringify({
  ok: true,
  taskId: task.id,
  status: "completed",
  workDir: "/tmp/work-fixture",
  artifacts: [],
  prUrl: "https://github.com/owner/repo/pull/196",
  branch: "fix/issue-196",
  tests: ["npm test -- --testNamePattern handler -> pass"],
  filesChanged: ["scripts/a2a-task-handler.mjs"],
  risks: ["minor: version bump required"]
}));
`);

    const task = githubTask({
      payload: {
        mode: "github-propose-patch",
        repo: "owner/repo",
        issue: "#196",
        issueUrl: "https://github.com/owner/repo/issues/196",
      },
    });
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "docker",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
        A2A_NODE_ID: "workerepsilon-node",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.repo, "owner/repo", "repo must be in output");
    assert.equal(payload.result.output.issue, "#196", "issue must be in output");
    assert.equal(payload.result.output.issueUrl, "https://github.com/owner/repo/issues/196", "issueUrl must be in output");
    assert.equal(payload.result.output.nodeId, "workerepsilon-node", "nodeId must be in output");
    assert.equal(payload.result.output.taskId, "task-fixture-1", "taskId must be in output");
    assert.equal(payload.result.output.branch, "fix/issue-196", "branch must be projected from runner response");
    assert.deepEqual(payload.result.output.tests, ["npm test -- --testNamePattern handler -> pass"], "tests must be projected");
    assert.deepEqual(payload.result.output.filesChanged, ["scripts/a2a-task-handler.mjs"], "filesChanged must be projected");
    assert.deepEqual(payload.result.output.risks, ["minor: version bump required"], "risks must be projected");
    assert.equal(payload.result.output.prUrl, "https://github.com/owner/repo/pull/196");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});



test("docker runner explicit no-diff evidence fails closed before success (#447)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-runner-nodiff-447-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
console.log(JSON.stringify({
  ok: true,
  taskId: "task-fixture-1",
  status: "completed",
  workDir: "/tmp/work",
  artifacts: [],
  noDiff: true,
  branch: "a2a-patch-empty",
  prUrl: "https://github.com/owner/repo/pull/447"
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "docker",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "docker_runner_no_diff");
    assert.equal(payload.error.details.branch, "a2a-patch-empty");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner explicit branch mismatch fails closed (#447)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-runner-branch-mismatch-447-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
console.log(JSON.stringify({
  ok: true,
  taskId: "task-fixture-1",
  status: "completed",
  workDir: "/tmp/work",
  artifacts: [],
  expectedBranch: "a2a-patch-runner-owned",
  branch: "a2a-patch-agent-owned",
  prUrl: "https://github.com/owner/repo/pull/447"
}));
`);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "docker",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.error.code, "docker_runner_branch_mismatch");
    assert.equal(payload.error.details.expectedRunnerBranch, "a2a-patch-runner-owned");
    assert.equal(payload.error.details.actualBranch, "a2a-patch-agent-owned");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker runner output nodeId falls back to unknown-node when no node env is set (issue #196)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-nodeid-fallback-196-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
console.log(JSON.stringify({ ok: true, taskId: "task-fixture-1", status: "completed", workDir: "/tmp/work", artifacts: [], prUrl: "https://github.com/owner/repo/pull/1" }));
`);

    const env = { ...process.env };
    delete env.A2A_NODE_ID;
    delete env.NODE_ID;
    delete env.WORKER_ID;
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(githubTask()),
      encoding: "utf8",
      env: {
        ...env,
        A2A_EXECUTOR_MODE: "docker",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.nodeId, "unknown-node", "nodeId should fall back to unknown-node");
    assert.equal(payload.result.output.taskId, "task-fixture-1", "taskId must be preserved");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("plugin-only scope with unconfigured A2A_DOCKER_RUNNER_BIN does not trigger readiness guard for plugin repo (#189)", () => {
  // plugin-only is NOT a docker-first mandate — the guard should not fire;
  // the runner spawn error (or success) is handled inside runDockerRunner as before.
  const tempDir = mkdtempSync(join(tmpdir(), "handler-plugin-readiness-189-"));
  const fakeRunnerPath = join(tempDir, "fake-runner.mjs");
  try {
    writeFileSync(fakeRunnerPath, `
import { readFileSync } from "node:fs";
const taskPath = process.argv.at(-1);
const task = JSON.parse(readFileSync(taskPath, "utf8"));
if (task.preset !== "openclaw-plugin-a2a-dev") throw new Error("expected plugin preset");
console.log(JSON.stringify({ ok: true, taskId: task.id, status: "completed", workDir: "/tmp/work-fixture", artifacts: [], prUrl: "https://github.com/jinon86/openclaw-plugin-a2a/pull/2" }));
`);

    const task = githubTask();
    task.payload.repo = "jinon86/openclaw-plugin-a2a";
    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "auto",
        A2A_DOCKER_RUNNER_SCOPE: "plugin-only",
        A2A_DOCKER_RUNNER_BIN: process.execPath,
        A2A_DOCKER_RUNNER_ARGS_JSON: JSON.stringify([fakeRunnerPath]),
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.github.prUrl, "https://github.com/jinon86/openclaw-plugin-a2a/pull/2");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ─── analysis-only / read-only task mode regression tests ───

test("analysis-only mode produces Done evidence without requiring PR/patch", () => {
  const task = githubTask();
  task.intent = "analyze";
  task.payload = {
    mode: "analysis-only",
    summary: "market regime analysis complete",
    findings: ["BTC dominance rising", "ETH/BTC ratio declining"],
    risks: ["low liquidity in alt pairs"],
    artifacts: ["analysis-20260509.json"],
  };

  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(task),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "builtin",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.result, "analysis-only task should succeed");
  assert.match(payload.result.summary, /analysis-only completed/);
  assert.equal(payload.result.lifecycle.intent, "analyze");
  assert.equal(payload.result.lifecycle.mode, "analysis-only");
  assert.equal(payload.result.output.analysisSummary, "market regime analysis complete");
  assert.deepEqual(payload.result.output.findings, ["BTC dominance rising", "ETH/BTC ratio declining"]);
  assert.deepEqual(payload.result.output.risks, ["low liquidity in alt pairs"]);
  assert.deepEqual(payload.result.output.artifacts, ["analysis-20260509.json"]);
  // No PR evidence required — output must not carry prUrl or github.prUrl
  assert.equal(payload.result.output.prUrl, undefined);
  assert.equal(payload.result.output.github, undefined);
});

test("analysis-only mode with doneCommentUrl carries URL evidence", () => {
  const task = githubTask();
  task.intent = "analyze";
  task.payload = {
    mode: "analysis-only",
    summary: "research findings",
    doneCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-done",
    findings: ["signal: bullish divergence"],
  };

  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(task),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "builtin",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.result.summary, /analysis-only completed/);
  assert.equal(payload.result.output.doneCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-done");
  assert.equal(payload.result.output.analysisSummary, "research findings");
  assert.equal(payload.result.output.prUrl, undefined, "no PR URL for analysis-only");
});

test("analysis-only mode with blockCommentUrl produces Block evidence", () => {
  const task = githubTask();
  task.intent = "analyze";
  task.payload = {
    mode: "analysis-only",
    summary: "cannot complete analysis",
    blockCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-block",
    risks: ["data feed unavailable"],
  };

  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(task),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "builtin",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.result.summary, /analysis-only blocked/);
  assert.equal(payload.result.output.blockCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-block");
  assert.deepEqual(payload.result.output.risks, ["data feed unavailable"]);
  assert.equal(payload.result.output.prUrl, undefined, "no PR URL for blocked analysis");
  assert.equal(payload.result.output.doneCommentUrl, undefined, "no done URL for blocked analysis");
});

test("analysis-only mode with startCommentUrl preserves Start marker", () => {
  const task = githubTask();
  task.intent = "analyze";
  task.payload = {
    mode: "analysis-only",
    summary: "thesis analysis",
    startCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-start",
    doneCommentUrl: "https://github.com/owner/repo/issues/1#issuecomment-done",
    findings: ["regime: trending"],
  };

  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(task),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "builtin",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.output.startCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-start");
  assert.equal(payload.result.output.doneCommentUrl, "https://github.com/owner/repo/issues/1#issuecomment-done");
  assert.match(payload.result.summary, /analysis-only completed/);
});

test("analysis-only mode with read-only-analysis alias works identically", () => {
  const task = githubTask();
  task.intent = "analyze";
  task.payload = {
    mode: "read-only-analysis",
    summary: "read-only market scan",
    findings: ["no anomalies"],
    risks: [],
  };

  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(task),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "builtin",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.result.summary, /analysis-only completed/);
  assert.equal(payload.result.lifecycle.mode, "read-only-analysis");
  assert.equal(payload.result.output.analysisSummary, "read-only market scan");
});

test("no-live source-only A2A evidence task produces structured analysis output", () => {
  const task = githubTask();
  task.intent = "analyze";
  task.message = "Assess #687 worker analysis evidence quality";
  task.payload = {
    mode: "a2a-489-phase2-evidence",
    noLive: true,
    sourceOnly: true,
    role: "thesis",
    phase: "phase2",
    summary: "worker should return useful evidence",
    findings: ["generic acceptance is insufficient"],
    risks: ["false green closeout"],
    recommendations: ["emit structured analysis fields"],
    evidenceRefs: ["gh:jinwon-int/a2a-broker#687"],
  };

  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(task),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "builtin",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.doesNotMatch(payload.result.summary, /accepted by versioned A2A task handler/);
  assert.match(payload.result.summary, /analysis-only completed/);
  assert.equal(payload.result.output.analysisKind, "builtin_structured");
  assert.equal(payload.result.output.analysisSummary, "worker should return useful evidence");
  assert.equal(payload.result.output.role, "thesis");
  assert.equal(payload.result.output.phase, "phase2");
  assert.equal(payload.result.output.noLive, true);
  assert.equal(payload.result.output.sourceOnly, true);
  assert.deepEqual(payload.result.output.recommendations, ["emit structured analysis fields"]);
  assert.deepEqual(payload.result.output.evidenceRefs, ["gh:jinwon-int/a2a-broker#687"]);
});

test("source-only A2A evidence task without noLive still produces structured analysis output", () => {
  const task = githubTask();
  task.intent = "analyze";
  task.message = "Assess #810 source-only evidence quality";
  task.payload = {
    mode: "a2a-810-source-gap-evidence",
    sourceOnly: true,
    role: "evidence-review",
    summary: "worker should return useful source-only evidence",
    findings: ["generic success is insufficient"],
    risks: ["source-only work can be falsely marked done"],
    recommendations: ["route source-only analysis through structured output"],
    evidenceRefs: ["gh:jinwon-int/a2a-broker#810"],
  };

  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(task),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "builtin",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.doesNotMatch(payload.result.summary, /accepted by versioned A2A task handler/);
  assert.match(payload.result.summary, /analysis-only completed/);
  assert.equal(payload.result.output.analysisKind, "builtin_structured");
  assert.equal(payload.result.output.analysisSummary, "worker should return useful source-only evidence");
  assert.equal(payload.result.output.sourceOnly, true);
  assert.equal(payload.result.output.noLive, undefined);
  assert.deepEqual(payload.result.output.findings, ["generic success is insufficient"]);
  assert.deepEqual(payload.result.output.recommendations, ["route source-only analysis through structured output"]);
  assert.deepEqual(payload.result.output.evidenceRefs, ["gh:jinwon-int/a2a-broker#810"]);
});

test("analysis-only task can use OpenClaw analysis bridge when explicitly enabled", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-analysis-bridge-test-"));
  const fakeOpenClawPath = join(tempDir, "fake-openclaw-analysis.mjs");
  const argsPath = join(tempDir, "args.json");
  try {
    writeFileSync(fakeOpenClawPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from \"node:fs\";",
      "writeFileSync(process.env.CAPTURE_ARGS_PATH, JSON.stringify(process.argv));",
      "if (!process.argv.includes(\"agent\")) throw new Error(\"expected agent subcommand\");",
      "if (!process.argv.includes(\"--json\")) throw new Error(\"expected json output flag\");",
      "const sessionIndex = process.argv.indexOf(\"--session-id\");",
      "if (sessionIndex < 0 || process.argv[sessionIndex + 1] === \"main\") throw new Error(\"expected task-scoped session\");",
      "console.log(JSON.stringify({",
      "  payloads: [{",
      "    text: JSON.stringify({",
      "      status: \"done\",",
      "      summary: \"bridge analysis complete\",",
      "      findings: [\"worker produced substantive analysis\"],",
      "      risks: [\"requires bridge enablement\"],",
      "      recommendations: [\"keep generic fallback explicit\"],",
      "      evidenceRefs: [\"gh:jinwon-int/a2a-broker#687\"]",
      "    })",
      "  }]",
      "}));",
      "",
    ].join("\n"));
    chmodSync(fakeOpenClawPath, 0o755);

    const task = githubTask();
    task.intent = "analyze";
    task.payload = {
      mode: "analysis-only",
      summary: "fallback summary should be replaced",
      noLive: true,
      sourceOnly: true,
      strictJsonInstruction: "First byte must be {; return one RFC8259 JSON object only.",
      expectedSchema: { verdict: "PASS|BLOCK", explorerSummary: ["string"] },
      largeNoise: "x".repeat(12_000),
    };

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "builtin",
        A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
        OPENCLAW_BIN: fakeOpenClawPath,
        A2A_NODE_ID: "worker-a",
        CAPTURE_ARGS_PATH: argsPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.result.summary, /analysis bridge done/);
    assert.equal(payload.result.output.analysisKind, "analysis_bridge");
    // The worker env names no harness, so this is the default adapter label.
    // Was "openclaw"; piri since the fleet runs CCC_AGENT_PROVIDER=piri and the
    // openclaw default resolved to a binary installed nowhere. The bridge command
    // below still comes from OPENCLAW_BIN, which explicit config still wins with.
    assert.equal(payload.result.output.bridgeAdapter, "piri");
    assert.equal(payload.result.output.bridgeCommand, "fake-openclaw-analysis.mjs");
    assert.equal(payload.result.note, "read-only A2A analysis completed through analysis bridge");
    assert.equal(payload.result.output.analysisSummary, "bridge analysis complete");
    assert.deepEqual(payload.result.output.findings, ["worker produced substantive analysis"]);
    assert.deepEqual(payload.result.output.recommendations, ["keep generic fallback explicit"]);
    assert.equal(payload.result.output.nodeId, "worker-a");
    assert.equal(payload.result.output.strictJsonInstructionApplied, true);
    assert.equal(payload.result.output.promptPayloadLimit, 8000);
    assert.equal(payload.result.output.bridgeInputMode, "payload_file");
    const args = JSON.parse(readFileSync(argsPath, "utf8"));
    const promptText = args[args.indexOf("--message") + 1];
    assert.match(promptText, /Strict JSON retry discipline: First byte must be \{/);
    assert.match(promptText, /Expected JSON schema\/key summary/);
    assert.match(promptText, /A2A_ANALYSIS_PAYLOAD_FILE/);
    assert.match(promptText, /Payload JSON excerpt \(8000 chars max/);
    assert.ok(!promptText.includes("x".repeat(11_000)), "prompt must not inline the full oversized payload");
    const sessionId = args[args.indexOf("--session-id") + 1];
    assert.match(sessionId, /^a2a-worker-a-task-fixture-1-analysis$/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("analysis-only bridge posts GitHub evidence comment when explicitly enabled", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-analysis-comment-test-"));
  const fakeOpenClawPath = join(tempDir, "fake-openclaw-analysis.mjs");
  const fakeGithubServerPath = join(tempDir, "fake-github-server.mjs");
  const commentLogPath = join(tempDir, "comments.log");
  let server: ReturnType<typeof spawn> | undefined;
  try {
    writeFileSync(fakeOpenClawPath, [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({",
      "  payloads: [{",
      "    text: JSON.stringify({",
      "      status: \"done\",",
      "      summary: \"evidence comment analysis complete\",",
      "      findings: [\"source bundle contained the bridge\"],",
      "      risks: [\"comment posting must be explicit\"],",
      "      recommendations: [\"post durable GitHub evidence\"],",
      "      evidenceRefs: [\"jinwon-int/a2a-broker:scripts/a2a-task-handler.mjs\"]",
      "    })",
      "  }]",
      "}));",
      "",
    ].join("\n"));
    chmodSync(fakeOpenClawPath, 0o755);

    writeFileSync(fakeGithubServerPath, [
      "#!/usr/bin/env node",
      "import { createServer } from 'node:http';",
      "import { appendFileSync } from 'node:fs';",
      "const comments = [];",
      "const server = createServer((req, res) => {",
      "  if (req.headers.authorization !== 'Bearer test-token') { res.writeHead(401); res.end('bad auth'); return; }",
      "  if (req.url === '/repos/owner/repo/issues/1341/comments?per_page=100' && req.method === 'GET') {",
      "    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(comments)); return;",
      "  }",
      "  if (req.url === '/repos/owner/repo/issues/1341/comments' && req.method === 'POST') {",
      "    let body = ''; req.setEncoding('utf8');",
      "    req.on('data', chunk => body += chunk);",
      "    req.on('end', () => {",
      "      const parsed = JSON.parse(body);",
      "      const comment = { id: 1341001, html_url: `http://127.0.0.1:${server.address().port}/owner/repo/issues/1341#issuecomment-1341001`, body: parsed.body };",
      "      comments.push(comment); appendFileSync(process.env.COMMENT_LOG_PATH, JSON.stringify(comment) + '\\n');",
      "      res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify(comment));",
      "    }); return;",
      "  }",
      "  res.writeHead(404); res.end('not found: ' + req.method + ' ' + req.url);",
      "});",
      "server.listen(0, '127.0.0.1', () => console.log('READY ' + server.address().port));",
      "",
    ].join("\n"));
    chmodSync(fakeGithubServerPath, 0o755);

    server = spawn(process.execPath, [fakeGithubServerPath], {
      env: { ...process.env, COMMENT_LOG_PATH: commentLogPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const port = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => reject(new Error(`fake github server did not start: ${stderr}`)), 5000);
      server?.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
        const match = /READY (\d+)/.exec(stdout);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      server?.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      server?.on("exit", (code) => reject(new Error(`fake github server exited early: ${code} ${stderr}`)));
    });

    const task = githubTask();
    task.id = "analysis-comment-task";
    task.intent = "analyze";
    task.payload = {
      mode: "analysis-only",
      sourceOnly: true,
      issueUrl: "https://github.com/owner/repo/issues/1341",
      postGithubComment: true,
    };

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "builtin",
        A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
        OPENCLAW_BIN: fakeOpenClawPath,
        A2A_NODE_ID: "worker-commenter",
        A2A_POST_ANALYSIS_EVIDENCE_COMMENTS: "1",
        A2A_GITHUB_API_BASE_URL: `http://127.0.0.1:${port}`,
        GITHUB_TOKEN: "test-token",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.result.output.analysisStatus, "done");
    assert.match(payload.result.output.doneCommentUrl, /issuecomment-1341001$/);
    assert.equal(payload.result.output.githubCommentUrl, payload.result.output.doneCommentUrl);
    const [logged] = readFileSync(commentLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.match(logged.body, /<!-- a2a-analysis-evidence:analysis-comment-task:done -->/);
    assert.match(logged.body, /source bundle contained the bridge/);
    assert.match(logged.body, /post durable GitHub evidence/);
  } finally {
    server?.kill("SIGTERM");
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("analysis-only task can use Hermes-backed OpenClaw-compatible analysis bridge", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-hermes-analysis-bridge-test-"));
  const repoDir = join(tempDir, "seo-web-bridge");
  const sourceDir = join(repoDir, "runtime", "app-src");
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");
  const promptPath = join(tempDir, "hermes-prompt.txt");
  try {
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "app_chat.py"), [
      "def render_conversation():",
      "    st.columns([7, 3])",
      "    render_files_panel()",
      "",
    ].join("\n"));

    writeFileSync(fakeHermesPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from \"node:fs\";",
      "const args = process.argv.slice(2);",
      "const qIndex = args.indexOf(\"-q\");",
      "if (qIndex < 0) throw new Error(\"expected hermes chat -q\");",
      "const prompt = args[qIndex + 1];",
      "writeFileSync(process.env.CAPTURE_PROMPT_PATH, prompt);",
      "if (!prompt.includes(\"runtime/app-src/app_chat.py\")) throw new Error(\"missing source path\");",
      "if (!prompt.includes(\"st.columns([7, 3])\")) throw new Error(\"missing source content\");",
      "console.log(JSON.stringify({",
      "  status: \"done\",",
      "  summary: \"Hermes가 실제 소스 근거를 읽고 레이아웃 판단을 완료했다\",",
      "  findings: [\"runtime/app-src/app_chat.py의 st.columns([7, 3])가 파일 패널을 채팅 레이아웃에 묶는다\"],",
      "  risks: [\"wrapper-only success로 closeout하면 설계 근거가 비게 된다\"],",
      "  recommendations: [\"OPENCLAW_BIN을 hermes-a2a-analysis-bridge.mjs로 설정하고 A2A_OPENCLAW_ANALYSIS_ENABLED=1을 켠다\"],",
      "  evidenceRefs: [\"jinwon-int/seo-web-bridge:runtime/app-src/app_chat.py\"]",
      "}));",
      "",
    ].join("\n"));
    chmodSync(fakeHermesPath, 0o755);
    chmodSync(hermesAnalysisBridgePath, 0o755);

    const task = githubTask();
    task.intent = "analyze";
    task.message = "seo-web-bridge 우측 파일 패널 고정 rail 설계를 판단해줘";
    task.payload = {
      mode: "analysis-only",
      noLive: true,
      sourceOnly: true,
      repo: "jinwon-int/seo-web-bridge",
      path: "runtime/app-src/app_chat.py",
    };

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(task),
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_EXECUTOR_MODE: "builtin",
        A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
        A2A_OPENCLAW_ANALYSIS_BIN: hermesAnalysisBridgePath,
        OPENCLAW_BIN: "/path/that/must/not-run-for-analysis",
        HERMES_BIN: fakeHermesPath,
        CAPTURE_PROMPT_PATH: promptPath,
        A2A_ANALYSIS_REPO_MAP_JSON: JSON.stringify({ "jinwon-int/seo-web-bridge": repoDir }),
        A2A_HERMES_ANALYSIS_TOOLSETS: "safe",
        A2A_NODE_ID: "worker-hermes-analysis",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.match(payload.result.summary, /analysis bridge done/);
    assert.equal(payload.result.output.analysisKind, "analysis_bridge");
    assert.equal(payload.result.output.bridgeAdapter, "hermes");
    assert.equal(payload.result.output.bridgeCommand, "hermes-a2a-analysis-bridge.mjs");
    assert.equal(payload.result.note, "read-only A2A analysis completed through analysis bridge");
    assert.equal(payload.result.output.analysisSummary, "Hermes가 실제 소스 근거를 읽고 레이아웃 판단을 완료했다");
    assert.deepEqual(payload.result.output.findings, ["runtime/app-src/app_chat.py의 st.columns([7, 3])가 파일 패널을 채팅 레이아웃에 묶는다"]);
    assert.deepEqual(payload.result.output.evidenceRefs, ["jinwon-int/seo-web-bridge:runtime/app-src/app_chat.py"]);
    const prompt = readFileSync(promptPath, "utf8");
    assert.match(prompt, /Read-only source bundle/);
    assert.match(prompt, /st\.columns\(\[7, 3\]\)/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GitHub propose_patch evidence requirements are preserved when intent is not analyze", () => {
  // propose_patch with github taskOrigin still fails without executor config
  const task = githubTask();
  task.intent = "propose_patch";
  task.payload = { mode: "github-propose-patch", repo: "owner/repo", issue: "#1" };

  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(task),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "builtin",
    },
  });

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.error.code, "github_executor_not_configured");
});

test("analyze intent with unknown mode falls through to generic handler, not analysis-only", () => {
  // intent=analyze but mode is not a recognized analysis-only mode → generic handler
  const task = githubTask();
  task.intent = "analyze";
  task.payload = { mode: "unknown-mode", detail: "something" };

  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(task),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "builtin",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  // Falls through to generic handler — not analysis-only
  assert.match(payload.result.summary, /accepted by versioned A2A task handler/);
  assert.doesNotMatch(payload.result.summary, /analysis-only/);
});

function decisionDialecticPhaseTask(): GithubTaskFixture {
  return githubTask({
    id: "a2ad-parent:thesis:0",
    intent: "analyze",
    message: "decision.dialectic thesis phase for runtime bridge",
    payload: {
      mode: "analysis-only",
      contract: {
        kind: "decision.dialectic",
        version: 1,
        phase: "thesis",
        task: {
          kind: "decision.dialectic",
          version: 1,
          taskId: "a2ad-parent",
          revision: 0,
          state: "OPEN",
          meta: {
            topic: "A2AD bridge test",
            domain: "ops",
            urgency: "normal",
            openedAt: "2026-06-08T08:00:00.000Z",
            snapshotAt: "2026-06-08T08:00:00.000Z",
            expiresAt: "2026-06-08T09:00:00.000Z",
            openedBy: "hub-a",
          },
          roles: {
            thesisAgent: { agentId: "workerbeta" },
            antithesisAgent: { agentId: "workeralpha" },
            synthAgent: { agentId: "workerdelta" },
          },
          context: {
            brief: "Test brief",
            objective: "Patch parent with worker-authored thesis",
          },
        },
      },
      promptSpec: {
        phase: "thesis",
        schemaName: "decisionDialectic.thesis.v1",
        systemPrompt: "Return thesis JSON only.",
        jsonSchema: { type: "object" },
      },
      execution: {
        parentTaskId: "a2ad-parent:with-colon",
        taskId: "a2ad-parent",
        expectedRevision: 0,
        phase: "thesis",
      },
    },
  });
}

test("decision.dialectic phase task blocks instead of generic success when bridge is disabled", () => {
  const result = spawnSync(process.execPath, [handlerPath], {
    input: JSON.stringify(decisionDialecticPhaseTask()),
    encoding: "utf8",
    env: {
      ...process.env,
      A2A_EXECUTOR_MODE: "builtin",
      A2A_DECISION_DIALECTIC_BRIDGE_ENABLED: "",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.result.summary, /decision\.dialectic phase blocked/);
  assert.doesNotMatch(payload.result.summary, /accepted by versioned OpenClaw A2A handler/);
  assert.equal(payload.result.output.decisionDialectic.status, "blocked");
  assert.equal(payload.result.output.decisionDialectic.parentTaskId, "a2ad-parent:with-colon");
  assert.equal(payload.result.output.decisionDialectic.schemaName, "decisionDialectic.thesis.v1");
});

test("decision.dialectic bridge patches parent with worker-authored phase payload", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "handler-decision-dialectic-"));
  const fakeOpenClawPath = join(tempDir, "fake-openclaw-decision.mjs");
  const fakeCurlPath = join(tempDir, "curl");
  const curlArgsPath = join(tempDir, "curl-args.json");
  const curlBodyPath = join(tempDir, "curl-body.json");
  const phasePayload = {
    author: { agentId: "workerbeta" },
    submittedAt: "2026-06-08T08:15:00.000Z",
    claim: "The bridge should patch the parent task.",
    proposal: "Use decision.dialectic patch route after phase execution.",
    rationale: "Worker-authored evidence must advance the parent read model.",
    expectedBenefits: ["no generic false success"],
    evidenceRefs: ["gh:jinwon-int/a2a-broker#1325"],
    assumptions: ["broker patch route is reachable"],
    risks: ["bridge must fail closed"],
    confidence: 0.82,
  };
  try {
    writeFileSync(fakeOpenClawPath, [
      "#!/usr/bin/env node",
      "if (!process.argv.includes(\"agent\")) throw new Error(\"expected agent subcommand\");",
      "if (!process.argv.includes(\"--json\")) throw new Error(\"expected json flag\");",
      `console.log(${JSON.stringify(JSON.stringify({ payloads: [{ text: JSON.stringify(phasePayload) }] }))});`,
      "",
    ].join("\n"));
    chmodSync(fakeOpenClawPath, 0o755);
    writeFileSync(fakeCurlPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from \"node:fs\";",
      "writeFileSync(process.env.CAPTURE_CURL_ARGS_PATH, JSON.stringify(process.argv.slice(2)));",
      "let body = \"\";",
      "process.stdin.setEncoding(\"utf8\");",
      "process.stdin.on(\"data\", (chunk) => { body += chunk; });",
      "process.stdin.on(\"end\", () => {",
      "  writeFileSync(process.env.CAPTURE_CURL_BODY_PATH, body);",
      "  console.log(JSON.stringify({ contract: { state: \"THESIS_SUBMITTED\", revision: 1 } }));",
      "});",
      "",
    ].join("\n"));
    chmodSync(fakeCurlPath, 0o755);

    const result = spawnSync(process.execPath, [handlerPath], {
      input: JSON.stringify(decisionDialecticPhaseTask()),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${tempDir}:${process.env.PATH ?? ""}`,
        A2A_EXECUTOR_MODE: "builtin",
        A2A_DECISION_DIALECTIC_BRIDGE_ENABLED: "1",
        A2A_OPENCLAW_ANALYSIS_ENABLED: "1",
        OPENCLAW_BIN: fakeOpenClawPath,
        A2A_WORKER_ID: "workerbeta",
        A2A_WORKER_ROLE: "analyst",
        A2A_BROKER_URL: "http://127.0.0.1:8787",
        A2A_BROKER_EDGE_SECRET: "test-edge-secret",
        CAPTURE_CURL_ARGS_PATH: curlArgsPath,
        CAPTURE_CURL_BODY_PATH: curlBodyPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const curlArgs = JSON.parse(readFileSync(curlArgsPath, "utf8"));
    assert.equal(curlArgs.at(-1), "http://127.0.0.1:8787/tasks/a2ad-parent%3Awith-colon/decision-dialectic/patch");
    assert.ok(curlArgs.includes("x-a2a-edge-secret: test-edge-secret"));
    const receivedBody = JSON.parse(readFileSync(curlBodyPath, "utf8"));
    assert.equal(receivedBody.op, "append.thesis");
    assert.equal(receivedBody.taskId, "a2ad-parent");
    assert.equal(receivedBody.expectedRevision, 0);
    assert.equal(receivedBody.authorAgent, "workerbeta");
    assert.equal(receivedBody.payload.claim, "The bridge should patch the parent task.");
    const payload = JSON.parse(result.stdout);
    assert.match(payload.result.summary, /decision\.dialectic thesis patched parent/);
    assert.doesNotMatch(payload.result.summary, /accepted by versioned OpenClaw A2A handler/);
    assert.equal(payload.result.output.decisionDialectic.status, "patched");
    assert.equal(payload.result.output.decisionDialectic.readModelState, "THESIS_SUBMITTED");
    assert.equal(payload.result.output.decisionDialectic.readModelRevision, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("analysis-only mode passes validateTaskCompletionEvidence without PR evidence", () => {
  const task = githubTask();
  task.intent = "analyze";
  task.payload = { mode: "analysis-only", summary: "safe analysis" };

  const evidenceError = validateTaskCompletionEvidence(
    makeTaskRecord(task),
    {
      summary: "analysis-only completed: safe analysis",
      output: {
        analysisSummary: "safe analysis",
        findings: [],
        risks: [],
      },
    } as any,
  );
  // Analysis-only tasks must NOT require PR evidence
  assert.equal(evidenceError, null, `analysis-only should not require PR evidence: ${JSON.stringify(evidenceError)}`);
});

test("analysis-only mode with Done evidence passes validateTaskCompletionEvidence", () => {
  const taskFixture = githubTask();
  taskFixture.intent = "analyze";
  taskFixture.payload = { mode: "analysis-only", summary: "regime analysis", doneCommentUrl: "https://github.com/o/r/issues/1#issuecomment-1" };
  const task = makeTaskRecord(taskFixture);
  // Override taskOrigin to github to verify github-origin analysis-only tasks pass
  (task as any).taskOrigin = "github";

  const evidenceError = validateTaskCompletionEvidence(
    task,
    {
      summary: "analysis-only completed: regime analysis",
      output: {
        analysisSummary: "regime analysis",
        doneCommentUrl: "https://github.com/o/r/issues/1#issuecomment-1",
        findings: ["bullish"],
      },
    } as any,
  );
  assert.equal(evidenceError, null, `analysis-only done should pass: ${JSON.stringify(evidenceError)}`);
});
