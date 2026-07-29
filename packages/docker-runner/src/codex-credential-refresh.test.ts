import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanupCodexCredentialRuntime,
  commitCodexCredentialRefresh,
  prepareCodexCredentialRuntime,
  validateCodexAuthRefreshCandidate,
  withCodexCredentialRuntime,
} from "./codex-credential-refresh.js";
import type { RunnerConfig } from "./types.js";

const sourceAuth = {
  OPENAI_API_KEY: null,
  auth_mode: "chatgpt",
  last_refresh: "2026-07-28T00:00:00Z",
  tokens: {
    access_token: "test-access-v1",
    account_id: "test-account",
    id_token: "test-id-v1",
    refresh_token: "test-refresh-v1",
  },
};

function refreshedAuth() {
  return {
    ...sourceAuth,
    last_refresh: "2026-07-28T01:00:00Z",
    tokens: {
      ...sourceAuth.tokens,
      access_token: "test-access-v2",
      id_token: "test-id-v2",
      refresh_token: "test-refresh-v2",
    },
  };
}

test("validates only token rotation and last_refresh changes", () => {
  assert.doesNotThrow(() => validateCodexAuthRefreshCandidate(
    Buffer.from(JSON.stringify(sourceAuth)),
    Buffer.from(JSON.stringify(refreshedAuth())),
  ));

  assert.throws(() => validateCodexAuthRefreshCandidate(
    Buffer.from(JSON.stringify(sourceAuth)),
    Buffer.from(JSON.stringify({
      ...refreshedAuth(),
      tokens: { ...refreshedAuth().tokens, account_id: "different-account" },
    })),
  ), /changed protected token field account_id/);

  assert.throws(() => validateCodexAuthRefreshCandidate(
    Buffer.from(JSON.stringify(sourceAuth)),
    Buffer.from(JSON.stringify({ ...refreshedAuth(), unexpected: true })),
  ), /changed credential schema/);
});

test("uses a task-scoped writable clone and atomically commits a compatible refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-codex-refresh-test-"));
  const configDir = join(root, "codex-dir");
  mkdirSync(configDir);
  writeFileSync(join(configDir, "auth.json"), JSON.stringify(sourceAuth), { mode: 0o600 });
  writeFileSync(join(configDir, "config.toml"), "model = \"gpt-5.6-sol\"\n", { mode: 0o600 });

  const config: RunnerConfig = {
    rootDir: join(root, "runner"),
    image: "a2a-docker-runner-codex:test",
    defaultTimeoutMs: 1000,
    commandProfile: "codex",
    codexProfile: { configDir },
    extraMounts: [{ source: configDir, target: "/run/secrets/codex-dir", readOnly: true }],
  };

  const runtime = await prepareCodexCredentialRuntime(configDir, "root");
  try {
    assert.notEqual(runtime.runtimeDir, configDir);
    assert.deepEqual(
      JSON.parse(readFileSync(join(runtime.runtimeDir, "auth.json"), "utf8")),
      sourceAuth,
    );
    const executionConfig = withCodexCredentialRuntime(config, runtime);
    assert.deepEqual(executionConfig.extraMounts, [{
      source: runtime.runtimeDir,
      target: "/run/secrets/codex-dir",
      readOnly: false,
    }]);

    writeFileSync(join(runtime.runtimeDir, "auth.json"), JSON.stringify(refreshedAuth()), { mode: 0o600 });
    writeFileSync(join(runtime.runtimeDir, "config.toml"), "model = \"untrusted-change\"\n", { mode: 0o600 });
    assert.equal(await commitCodexCredentialRefresh(runtime), true);

    assert.deepEqual(
      JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8")),
      refreshedAuth(),
    );
    assert.equal(readFileSync(join(configDir, "config.toml"), "utf8"), "model = \"gpt-5.6-sol\"\n");
    assert.equal(statSync(join(configDir, "auth.json")).mode & 0o777, 0o600);
  } finally {
    await cleanupCodexCredentialRuntime(runtime);
    assert.equal(existsSync(runtime.runtimeDir), false);
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects incompatible runtime auth without replacing the source", async () => {
  const root = mkdtempSync(join(tmpdir(), "a2a-codex-refresh-invalid-"));
  const configDir = join(root, "codex-dir");
  mkdirSync(configDir);
  writeFileSync(join(configDir, "auth.json"), JSON.stringify(sourceAuth), { mode: 0o600 });
  const runtime = await prepareCodexCredentialRuntime(configDir, undefined);
  try {
    const invalid = {
      ...refreshedAuth(),
      tokens: { ...refreshedAuth().tokens, account_id: "different-account" },
    };
    writeFileSync(join(runtime.runtimeDir, "auth.json"), JSON.stringify(invalid), { mode: 0o600 });
    await assert.rejects(commitCodexCredentialRefresh(runtime), /changed protected token field account_id/);
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8")), sourceAuth);
  } finally {
    await cleanupCodexCredentialRuntime(runtime);
    rmSync(root, { recursive: true, force: true });
  }
});
