import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatClaudeHostRefreshSummary, maybeRefreshClaudeCredentialOnHost } from "./claude-host-refresh.js";
import { CLAUDE_HOST_REFRESH_STATE_FILE, evaluateClaudeCredentialWindow } from "./ops.js";
import type { RunnerConfig } from "./types.js";

// #2373: synthetic credential fixtures with obviously-fake tokens.
const FAKE_ACCESS_TOKEN = "fake-access-token-host-refresh";
const FAKE_REFRESH_TOKEN = "fake-refresh-token-host-refresh";
const TASK_TIMEOUT_MS = 30 * 60 * 1000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

/** Fake host CLI: rewrites claudeAiOauth.expiresAt in the file given as argv[1] to now + 8h. */
const REWRITE_SCRIPT = "const fs=require('fs');const p=process.argv[1];const c=JSON.parse(fs.readFileSync(p,'utf8'));"
  + "c.claudeAiOauth.expiresAt=Date.now()+8*3600*1000;fs.writeFileSync(p,JSON.stringify(c));process.stdout.write('ok');";

function writeCredentials(path: string, expiresAt: number): void {
  writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: FAKE_ACCESS_TOKEN, refreshToken: FAKE_REFRESH_TOKEN, expiresAt } }));
}

function fixture(argvFor?: string[] | ((creds: string) => string[]), overrides: { timeoutMs?: number; minIntervalMs?: number; fileMount?: boolean } = {}): { config: RunnerConfig; creds: string; rootDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "a2a-claude-host-refresh-"));
  const rootDir = join(dir, "root");
  const creds = join(dir, "host.credentials.json");
  writeCredentials(creds, Date.now() + 60_000);
  const fileMount = overrides.fileMount ?? true;
  const argv = typeof argvFor === "function" ? argvFor(creds) : argvFor;
  const config: RunnerConfig = {
    rootDir,
    image: "a2a-docker-runner-cccb:latest",
    defaultTimeoutMs: TASK_TIMEOUT_MS,
    commandProfile: "claude-code",
    ...(fileMount
      ? { extraMounts: [{ source: creds, target: "/run/secrets/claude-credentials.json", readOnly: true }] }
      : { claudeCodeProfile: { configDir: dir }, extraMounts: [{ source: dir, target: "/run/secrets/claude-dir", readOnly: true }] }),
    ...(argv
      ? { claudeHostRefresh: { argv, timeoutMs: overrides.timeoutMs ?? 30_000, minIntervalMs: overrides.minIntervalMs ?? 600_000 } }
      : {}),
  };
  if (!fileMount) writeCredentials(join(dir, ".credentials.json"), Date.now() + 60_000);
  return { config, creds, rootDir };
}

async function blockedWindow(config: RunnerConfig) {
  const window = await evaluateClaudeCredentialWindow(config, TASK_TIMEOUT_MS);
  assert.equal(window.blocked, true, "fixture credential must be inside the task window");
  return { ...window, taskTimeoutMs: TASK_TIMEOUT_MS };
}

function assertNoTokenLeak(value: unknown): void {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(FAKE_ACCESS_TOKEN), false);
  assert.equal(serialized.includes(FAKE_REFRESH_TOKEN), false);
}

test("#2373 (a) blocked window + refreshing host command => attempted, refreshed, 0600 state file", async () => {
  const { config, rootDir } = fixture((creds) => [process.execPath, "-e", REWRITE_SCRIPT, creds]);
  const window = await blockedWindow(config);
  const result = await maybeRefreshClaudeCredentialOnHost(config, window);
  assert.equal(result.attempted, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.refreshed, true);
  assert.equal(result.expiresAtBefore, window.expiresAt);
  assert.ok(result.expiresAtAfter && Date.parse(result.expiresAtAfter) > Date.now() + EIGHT_HOURS_MS - 60_000);
  assert.equal(formatClaudeHostRefreshSummary(result), "host_refresh=attempted exit=0 timed_out=false refreshed=true");
  assertNoTokenLeak(result);
  assert.equal(JSON.stringify(result).includes("\"ok\""), false, "child stdout is discarded");

  const statePath = join(rootDir, CLAUDE_HOST_REFRESH_STATE_FILE);
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.lastExitCode, 0);
  assert.equal(state.lastRefreshed, true);
  assert.ok(Number.isFinite(Date.parse(state.lastAttemptAt)));
  assert.deepEqual(Object.keys(state).sort(), ["lastAttemptAt", "lastExitCode", "lastRefreshed"]);
});

test("#2373 (b) host command that exits 0 without touching the credential => attempted, not refreshed", async () => {
  const { config, creds } = fixture([process.execPath, "-e", "process.exit(0)"]);
  const before = readFileSync(creds, "utf8");
  const result = await maybeRefreshClaudeCredentialOnHost(config, await blockedWindow(config));
  assert.equal(result.attempted, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.refreshed, false);
  assert.equal(result.expiresAtAfter, result.expiresAtBefore);
  assert.equal(readFileSync(creds, "utf8"), before);
  assert.equal(formatClaudeHostRefreshSummary(result), "host_refresh=attempted exit=0 timed_out=false refreshed=false");
});

test("#2373 (c) a second attempt inside minIntervalMs is rate_limited", async () => {
  const { config } = fixture([process.execPath, "-e", "process.exit(0)"], { minIntervalMs: 600_000 });
  const window = await blockedWindow(config);
  const nowMs = Date.now();
  const first = await maybeRefreshClaudeCredentialOnHost(config, window, nowMs);
  assert.equal(first.attempted, true);
  const second = await maybeRefreshClaudeCredentialOnHost(config, window, nowMs + 599_999);
  assert.equal(second.attempted, false);
  assert.equal(second.skippedReason, "rate_limited");
  assert.equal(second.refreshed, false);
  assert.equal(formatClaudeHostRefreshSummary(second), "host_refresh=skipped:rate_limited");
  const third = await maybeRefreshClaudeCredentialOnHost(config, window, nowMs + 600_000);
  assert.equal(third.attempted, true, "allowed again once minIntervalMs elapsed");
});

test("#2373 (d) non-zero exit is reported and not refreshed", async () => {
  const { config, rootDir } = fixture([process.execPath, "-e", "process.stderr.write('boom ' + 'sk-ant-oat01-FAKE');process.exit(3)"]);
  const result = await maybeRefreshClaudeCredentialOnHost(config, await blockedWindow(config));
  assert.equal(result.attempted, true);
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
  assert.equal(result.refreshed, false);
  assert.equal(JSON.stringify(result).includes("boom"), false, "child stderr is discarded");
  const state = JSON.parse(readFileSync(join(rootDir, CLAUDE_HOST_REFRESH_STATE_FILE), "utf8"));
  assert.equal(state.lastExitCode, 3);
  assert.equal(state.lastRefreshed, false);
});

test("#2373 (d) a hung host command is SIGKILLed at timeoutMs and reported as timed out", async () => {
  // timeoutMs below the env floor (5000) is set directly on the config to keep wall time small.
  const { config } = fixture([process.execPath, "-e", "setTimeout(()=>{},10000)"], { timeoutMs: 300 });
  const started = Date.now();
  const result = await maybeRefreshClaudeCredentialOnHost(config, await blockedWindow(config));
  assert.ok(Date.now() - started < 5_000, "killed well before the child would exit on its own");
  assert.equal(result.attempted, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, undefined);
  assert.equal(result.refreshed, false);
  assert.equal(formatClaudeHostRefreshSummary(result), "host_refresh=attempted exit=none timed_out=true refreshed=false");
});

test("#2373 a missing host command is a spawn error, not a throw", async () => {
  const { config } = fixture(["/nonexistent/a2a-claude-host-refresh-cli"]);
  const result = await maybeRefreshClaudeCredentialOnHost(config, await blockedWindow(config));
  assert.equal(result.attempted, true);
  assert.equal(result.spawnError, "ENOENT");
  assert.equal(result.refreshed, false);
  assert.match(formatClaudeHostRefreshSummary(result), /^host_refresh=attempted exit=spawn_error:ENOENT timed_out=false refreshed=false$/);
});

test("#2373 the host command gets only HOME and PATH from the runner env, no shell", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-claude-host-refresh-env-"));
  const out = join(dir, "env.json");
  const { config } = fixture([process.execPath, "-e", "require('fs').writeFileSync(process.argv[1], JSON.stringify(Object.keys(process.env)))", out]);
  process.env.A2A_HOST_REFRESH_TEST_SECRET = "must-not-leak";
  try {
    await maybeRefreshClaudeCredentialOnHost(config, await blockedWindow(config));
  } finally {
    delete process.env.A2A_HOST_REFRESH_TEST_SECRET;
  }
  const keys = JSON.parse(readFileSync(out, "utf8")) as string[];
  assert.equal(keys.includes("A2A_HOST_REFRESH_TEST_SECRET"), false);
  // Node propagates NODE_V8_COVERAGE to child processes when the test runner itself
  // runs with --experimental-test-coverage (coverage:baseline); it is injected by the
  // runtime, not passed by the runner, so it is the only extra key tolerated here.
  const passedByRunner = keys.filter((key) => key !== "NODE_V8_COVERAGE");
  assert.ok(passedByRunner.every((key) => key === "HOME" || key === "PATH"), keys.join(","));
});

test("#2373 (e) skipped when not blocked, not configured, or not a credentials file mount", async () => {
  const configured = fixture([process.execPath, "-e", "process.exit(0)"]);
  const notBlocked = await maybeRefreshClaudeCredentialOnHost(configured.config, { blocked: false, requiredUntil: new Date().toISOString(), taskTimeoutMs: TASK_TIMEOUT_MS });
  assert.deepEqual(notBlocked, { attempted: false, skippedReason: "not_blocked", refreshed: false });

  const unconfigured = fixture();
  const notConfigured = await maybeRefreshClaudeCredentialOnHost(unconfigured.config, await blockedWindow(unconfigured.config));
  assert.equal(notConfigured.attempted, false);
  assert.equal(notConfigured.skippedReason, "not_configured");
  assert.equal(formatClaudeHostRefreshSummary(notConfigured), "host_refresh=skipped:not_configured");

  const dirCopy = fixture([process.execPath, "-e", "process.exit(0)"], { fileMount: false });
  const notFileMount = await maybeRefreshClaudeCredentialOnHost(dirCopy.config, await blockedWindow(dirCopy.config));
  assert.equal(notFileMount.attempted, false);
  assert.equal(notFileMount.skippedReason, "not_file_mount");

  for (const { rootDir } of [unconfigured, dirCopy]) {
    assert.throws(() => statSync(join(rootDir, CLAUDE_HOST_REFRESH_STATE_FILE)), "skips never write the state file");
  }
});
