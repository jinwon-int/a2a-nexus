import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { loadConfig, loadEnvFile, mergeRunnerEnvFile, validateRunnerConfig } from "./config.js";
import type { RunnerConfig } from "./types.js";

const baseEnv = {
  A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "1",
};

function extractNodeHeredoc(script: string, marker: string): string {
  const startMarker = `node <<'${marker}'\n`;
  const start = script.indexOf(startMarker);
  assert.notEqual(start, -1, `missing ${marker} start marker`);
  const bodyStart = start + startMarker.length;
  const end = script.indexOf(`\n${marker}`, bodyStart);
  assert.notEqual(end, -1, `missing ${marker} end marker`);
  return script.slice(bodyStart, end);
}

function assertNodeScriptParses(source: string): void {
  const dir = mkdtempSync(join(tmpdir(), "a2a-runner-node-check-"));
  try {
    const file = join(dir, "script.cjs");
    writeFileSync(file, source);
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type ResolverFiles = Record<string, string>;

function runResolverScript(source: string, files: ResolverFiles, env: Record<string, string> = {}): string {
  let stdout = "";
  const fakeFs = {
    readFileSync(path: string, encoding: string) {
      assert.equal(encoding, "utf8");
      if (!Object.hasOwn(files, path)) {
        const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return files[path];
    },
  };
  const script = new Script(source);
  script.runInNewContext({
    require(name: string) {
      if (name === "node:fs") return fakeFs;
      throw new Error(`unexpected require: ${name}`);
    },
    process: {
      env,
      stdout: {
        write(value: string) {
          stdout += value;
        },
      },
    },
  });
  return stdout;
}


test("public safe-default policy rejects host network unless trusted operator mode is explicit", () => {
  assert.throws(
    () => validateRunnerConfig({
      rootDir: "/tmp/a2a-runner",
      image: "node:22-bookworm-slim",
      defaultTimeoutMs: 1000,
      network: "host",
      noNewPrivileges: true,
      capDrop: [],
      trustedOperator: false,
    }),
    /public safe-default policy rejects host network; set A2A_DOCKER_RUNNER_TRUSTED_OPERATOR=1/,
  );

  assert.doesNotThrow(() => validateRunnerConfig({
    rootDir: "/tmp/a2a-runner",
    image: "node:22-bookworm-slim",
    defaultTimeoutMs: 1000,
    network: "host",
    noNewPrivileges: true,
    capDrop: [],
    trustedOperator: true,
  }));
});

test("public safe-default policy rejects privilege escalation and capability additions", () => {
  assert.throws(
    () => validateRunnerConfig({
      rootDir: "/tmp/a2a-runner",
      image: "node:22-bookworm-slim",
      defaultTimeoutMs: 1000,
      network: "bridge",
      noNewPrivileges: false,
      capDrop: [],
      trustedOperator: false,
    }),
    /public safe-default policy requires no-new-privileges/,
  );

  assert.throws(
    () => validateRunnerConfig({
      rootDir: "/tmp/a2a-runner",
      image: "node:22-bookworm-slim",
      defaultTimeoutMs: 1000,
      network: "bridge",
      noNewPrivileges: true,
      capDrop: [],
      capAdd: ["SYS_ADMIN"],
      trustedOperator: false,
    }),
    /public safe-default policy rejects added capabilities/,
  );
});

test("loadConfig keeps public safe defaults unless trusted operator mode is set", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_NETWORK: "host",
    }),
    /public safe-default policy rejects host network/,
  );

  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_ALLOW_PRIVILEGE_ESCALATION: "1",
    }),
    /public safe-default policy requires no-new-privileges/,
  );

  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_CAP_ADD: "SYS_ADMIN,NET_ADMIN",
    }),
    /public safe-default policy rejects added capabilities/,
  );

  const trusted = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_NETWORK: "host",
    A2A_DOCKER_RUNNER_ALLOW_PRIVILEGE_ESCALATION: "1",
    A2A_DOCKER_RUNNER_CAP_ADD: "SYS_ADMIN",
  });
  assert.equal(trusted.trustedOperator, true);
  assert.equal(trusted.network, "host");
  assert.equal(trusted.noNewPrivileges, false);
  assert.deepEqual(trusted.capAdd, ["SYS_ADMIN"]);
});

test("loadEnvFile parses service-style runner env files without shell execution", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-runner-env-"));
  try {
    const file = join(dir, "worker.env");
    writeFileSync(file, [
      "# comment",
      "export A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw",
      "A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR='/srv/openclaw profile'",
      'A2A_DOCKER_RUNNER_IMAGE="a2a-docker-runner-openclaw:latest"',
      'A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON=\'[{"source":"/usr/lib/node_modules","target":"/usr/lib/node_modules","readOnly":true}]\'',
      "A2A_DOCKER_RUNNER_CPUS=2 # inline comment",
    ].join("\n"));

    assert.deepEqual(loadEnvFile(file), {
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
      A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR: "/srv/openclaw profile",
      A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-openclaw:latest",
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: '[{"source":"/usr/lib/node_modules","target":"/usr/lib/node_modules","readOnly":true}]',
      A2A_DOCKER_RUNNER_CPUS: "2",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeRunnerEnvFile lets direct doctor inherit worker service GitHub patch profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-runner-env-"));
  try {
    const file = join(dir, "worker.env");
    writeFileSync(file, [
      "A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw",
      "A2A_DOCKER_RUNNER_TRUSTED_OPERATOR=1",
      "A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR=/srv/openclaw-profile",
      "A2A_DOCKER_RUNNER_IMAGE=a2a-docker-runner-openclaw:latest",
    ].join("\n"));

    const env = mergeRunnerEnvFile({
      ...baseEnv,
      A2A_OPENCLAW_MODEL: "deepseek/deepseek-v4-pro",
    }, file);
    const config = await loadConfig(env);

    assert.equal(config.commandProfile, "openclaw");
    assert.equal(config.image, "a2a-docker-runner-openclaw:latest");
    assert.equal(config.network, "host");
    assert.match(config.commandScript ?? "", /deepseek\/deepseek-v4-pro/);
    assert.deepEqual(config.extraMounts, [
      { source: "/srv/openclaw-profile", target: "/run/secrets/openclaw-dir", readOnly: true },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeRunnerEnvFile supports Hermes patch profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-runner-env-"));
  try {
    const file = join(dir, "worker.env");
    writeFileSync(file, [
      "A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=hermes",
      "A2A_DOCKER_RUNNER_TRUSTED_OPERATOR=1",
      "A2A_DOCKER_RUNNER_HERMES_CONFIG_DIR=/srv/hermes-profile",
      "A2A_DOCKER_RUNNER_IMAGE=a2a-docker-runner-hermes:latest",
    ].join("\n"));

    const env = mergeRunnerEnvFile({
      ...baseEnv,
      A2A_HERMES_MODEL: "deepseek/deepseek-v4-pro",
    }, file);
    const config = await loadConfig(env);

    assert.equal(config.commandProfile, "hermes");
    assert.equal(config.image, "a2a-docker-runner-hermes:latest");
    assert.equal(config.network, "host");
    assert.match(config.commandScript ?? "", /hermes chat/);
    assert.match(config.commandScript ?? "", /deepseek\/deepseek-v4-pro/);
    assert.deepEqual(config.hermesProfile, { configDir: "/srv/hermes-profile" });
    assert.deepEqual(config.extraMounts, [
      { source: "/srv/hermes-profile", target: "/run/secrets/hermes-dir", readOnly: true },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig treats A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT truthily, not by mere presence", async () => {
  // Truthy values skip detection and force docker (deterministic on any host).
  for (const value of ["1", "true", "yes", "on"]) {
    const config = await loadConfig({ A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: value });
    assert.equal(config.engine, "docker", `${JSON.stringify(value)} should skip detection`);
  }

  // Falsy values must NOT short-circuit to docker — they go through detection,
  // i.e. behave exactly as when the flag is absent. (Previously "0"/"false"
  // were truthy by mere presence and forced docker on podman-only hosts.)
  const resolve = async (env: Record<string, string>): Promise<string | undefined> => {
    try {
      return (await loadConfig(env)).engine;
    } catch (error) {
      return `THREW:${(error as Error).message}`;
    }
  };
  const absent = await resolve({});
  assert.equal(await resolve({ A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "0" }), absent);
  assert.equal(await resolve({ A2A_DOCKER_RUNNER_SKIP_ENGINE_DETECT: "false" }), absent);
});

test("loadConfig enforces expected patch command profile", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_EXPECTED_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-hermes:d9d7d64",
  });

  assert.equal(config.commandProfile, "hermes");
  assert.equal(config.image, "a2a-docker-runner-hermes:d9d7d64");

  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_EXPECTED_PATCH_COMMAND_PROFILE: "hermes",
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
      A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
      A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-openclaw:latest",
    }),
    /EXPECTED_PATCH_COMMAND_PROFILE=hermes requires A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=hermes/,
  );

  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_EXPECTED_PATCH_COMMAND_PROFILE: "openclaw",
    }),
    /EXPECTED_PATCH_COMMAND_PROFILE=openclaw requires A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw; got unset/,
  );
});

test("loadConfig rejects known runner image/profile family mismatches", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
      A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
      A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-openclaw:269a0ef",
    }),
    /image\/profile mismatch.*openclaw runner image.*PROFILE=hermes/,
  );

  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
      A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
      A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-hermes:d9d7d64",
    }),
    /image\/profile mismatch.*hermes runner image.*PROFILE=openclaw/,
  );
});

test("loadConfig reads bounded safe runner build metadata", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_IMAGE: "ghcr.io/jinwon-int/a2a-docker-runner:ci",
    A2A_DOCKER_RUNNER_BUILD_VERSION: "0.1.0",
    A2A_DOCKER_RUNNER_BUILD_SOURCE: "https://github.com/jinwon-int/a2a-docker-runner",
    A2A_DOCKER_RUNNER_BUILD_REVISION: "0123456789abcdef",
    A2A_DOCKER_RUNNER_BUILD_BUILT_AT: "2026-05-01T00:00:00Z",
  });

  assert.deepEqual(config.buildMetadata, {
    version: "0.1.0",
    source: "https://github.com/jinwon-int/a2a-docker-runner",
    revision: "0123456789abcdef",
    builtAt: "2026-05-01T00:00:00Z",
    image: "ghcr.io/jinwon-int/a2a-docker-runner:ci",
  });
});

test("loadConfig falls back to the runtime image when BUILD_IMAGE is blank", async () => {
  // A blank A2A_DOCKER_RUNNER_BUILD_IMAGE must fall through to the runtime
  // image; `?? ` kept the empty string, yielding image: "".
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_IMAGE: "ghcr.io/jinwon-int/a2a-docker-runner:ci",
    A2A_DOCKER_RUNNER_BUILD_VERSION: "0.1.0",
    A2A_DOCKER_RUNNER_BUILD_IMAGE: "",
  });
  assert.equal(config.buildMetadata?.image, "ghcr.io/jinwon-int/a2a-docker-runner:ci");
});

test("loadConfig drops unsafe runner build metadata values", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_BUILD_SOURCE: "/root/private/checkout",
    A2A_DOCKER_RUNNER_BUILD_REVISION: "token=ghp_" + "x".repeat(36),
    A2A_DOCKER_RUNNER_BUILD_IMAGE: "safe-image:latest\nignored-line",
  });

  assert.deepEqual(config.buildMetadata, { image: "safe-image:latest ignored-line" });
});

test("loadConfig reads OpenClaw patch command script env var", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "#!/usr/bin/env bash\nopenclaw agent --help",
  });

  assert.equal(config.commandScript, "#!/usr/bin/env bash\nopenclaw agent --help");
});

test("loadConfig defaults runner container timeout to 60 minutes", async () => {
  const config = await loadConfig(baseEnv);

  assert.equal(config.defaultTimeoutMs, 60 * 60 * 1000);
});

test("loadConfig builds first-class OpenClaw patch profile", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_OPENCLAW_AGENT_ID: "main",
    A2A_OPENCLAW_THINKING: "medium",
    A2A_OPENCLAW_TIMEOUT_SEC: "3600",
  });

  assert.match(config.commandScript ?? "", /openclaw agent/);
  assert.match(config.commandScript ?? "", /A2A_OPENCLAW_DEFAULT_MODEL='openai-codex\/gpt-5\.5'/);
  assert.match(config.commandScript ?? "", /export A2A_OPENCLAW_MODEL="\$A2A_OPENCLAW_DEFAULT_MODEL"/);
  assert.match(config.commandScript ?? "", /export A2A_OPENCLAW_THINKING='medium'/);
  assert.match(config.commandScript ?? "", /--model "\$A2A_OPENCLAW_MODEL"/);
  assert.match(config.commandScript ?? "", /--thinking "\$A2A_OPENCLAW_THINKING"/);
  assert.match(config.commandScript ?? "", /A2A_RUNNER_ALLOW_NO_CHANGES/);
  assert.match(config.commandScript ?? "", /openclaw_no_changes=allowed/);
  assert.match(config.commandScript ?? "", /OPENCLAW_EXIT="\$\{PIPESTATUS\[0\]\}"/);
  assert.match(config.commandScript ?? "", /openclaw_exit_code=/);
  assert.match(config.commandScript ?? "", /openclaw_nonzero_allowed_for_evidence_only_lane/);
  assert.match(config.commandScript ?? "", /error=openclaw_agent_failed/);
  assert.match(config.commandScript ?? "", /Done evidence\|Done comment/);
  assert.match(config.commandScript ?? "", /OPENCLAW_DISABLE_BUNDLED_PLUGINS='0'/);
  assert.equal(config.network, "host");
  assert.match(config.commandScript ?? "", /copy_file_if_exists \/run\/secrets\/openclaw-dir\/openclaw\.json/);
  assert.match(config.commandScript ?? "", /auth-profiles\.json/);
  assert.match(config.commandScript ?? "", /auth-state\.json/);
  assert.match(config.commandScript ?? "", /models\.json/);
  assert.match(config.commandScript ?? "", /A2A_SANITIZE_OPENCLAW_CONFIG/);
  assert.match(config.commandScript ?? "", /A2A_INJECT_GITHUB_TOKEN_FOR_OPENCLAW/);
  assert.match(config.commandScript ?? "", /config\.skills\.entries\["gh-issues"\]\.apiKey = token/);
  assert.match(config.commandScript ?? "", /export GITHUB_TOKEN/);
  assert.ok((config.commandScript ?? "").includes('JSON.stringify(config, null, 2) + "\\n");'));
  assert.equal((config.commandScript ?? "").includes('JSON.stringify(config, null, 2) + "\n");'), false);
  assert.match(config.commandScript ?? "", /delete config\.plugins/);
  assert.match(config.commandScript ?? "", /delete config\.channels/);
  assert.match(config.commandScript ?? "", /delete config\.surfaces/);
  assert.match(config.commandScript ?? "", /delete defaults\.silentReply/);
  assert.match(config.commandScript ?? "", /delete defaults\.silentReplyRewrite/);
  assert.match(config.commandScript ?? "", /delete defaults\.models/);
  assert.match(config.commandScript ?? "", /delete entry\.models/);
  assert.match(config.commandScript ?? "", /delete entry\.silentReply/);
  assert.match(config.commandScript ?? "", /delete entry\.silentReplyRewrite/);
  assert.match(config.commandScript ?? "", /delete defaults\.agentRuntime\.fallback/);
  assert.match(config.commandScript ?? "", /delete entry\.agentRuntime\.fallback/);
  assert.match(config.commandScript ?? "", /openai-codex/);
  assert.match(config.commandScript ?? "", /A2A_OPENCLAW_ALLOW_NPM_INSTALL_FALLBACK='0'/);
  assert.match(config.commandScript ?? "", /error=openclaw_cli_missing/);
  assert.match(config.commandScript ?? "", /openclaw_install_fallback=disabled/);
  assert.match(
    config.commandScript ?? "",
    /if \[ "\$\{A2A_OPENCLAW_ALLOW_NPM_INSTALL_FALLBACK:-0\}" = "1" \]; then[\s\S]*notice=openclaw_cli_missing_install_attempted/,
  );
  assert.match(config.commandScript ?? "", /failure_category=openclaw_cli_unavailable/);
  assert.match(config.commandScript ?? "", /openclaw_config_bytes=/);
  assert.match(config.commandScript ?? "", /A2A_SET_OPENCLAW_WORKSPACE/);
  assert.match(config.commandScript ?? "", /config\.agents\.defaults\.workspace = workspace/);
  assert.match(config.commandScript ?? "", /entry\.workspace = workspace/);
  assert.match(config.commandScript ?? "", /A2A_GUARD_OPENCLAW_SESSION_STORE/);
  assert.match(config.commandScript ?? "", /openclaw_session_store_guard/);
  assert.match(config.commandScript ?? "", /openclaw_workspace_bootstrap_leak/);
  assert.match(config.commandScript ?? "", /bootstrap_leak=/);
  assert.match(config.commandScript ?? "", /scrubbed_ignored_openclaw_bootstrap/);
  assert.match(config.commandScript ?? "", /git check-ignore -q --/);
  assert.match(config.commandScript ?? "", /git ls-files --/);
  assert.match(config.commandScript ?? "", /find_bootstrap_leaks \./);
  assert.match(config.commandScript ?? "", /BOOTSTRAP_BANNED="AGENTS\.md BOOTSTRAP\.md HEARTBEAT\.md IDENTITY\.md MEMORY\.md SOUL\.md TOOLS\.md USER\.md"/);
  assert.match(config.commandScript ?? "", /BOOTSTRAP_BANNED_DIRS="\.openclaw memory"/);
  assert.match(config.commandScript ?? "", /Files detected \(repo-relative\):/);
  assert.doesNotMatch(config.commandScript ?? "", /git status --porcelain -- \.openclaw AGENTS\.md BOOTSTRAP\.md HEARTBEAT\.md IDENTITY\.md MEMORY\.md SOUL\.md TOOLS\.md USER\.md memory/);
  assert.match(config.commandScript ?? "", /activeAgentId = process\.env\.A2A_OPENCLAW_AGENT_ID \|\| "main"/);
  assert.ok((config.commandScript ?? "").includes('warning=openclaw_session_store_guard " + warning + "\\n"'));
  assert.ok((config.commandScript ?? "").includes('error=openclaw_session_store_guard " + errors.join("; ") + "\\n"'));
  assert.doesNotMatch(config.commandScript ?? "", /warning=openclaw_session_store_guard " \+ warning \+ "\n"/);
  assert.match(config.commandScript ?? "", /empty active-agent sessions registry/);
  assert.match(config.commandScript ?? "", /empty non-active-agent sessions registry ignored/);
  assert.doesNotMatch(config.commandScript ?? "", /tar -C \/run\/secrets\/openclaw-dir/);
  assert.doesNotMatch(config.commandScript ?? "", /cp -a \/run\/secrets\/openclaw-dir \/root\/\.openclaw/);
  assert.equal(config.commandProfile, "openclaw");
  assert.deepEqual(config.openclawProfile, { allowNpmInstallFallback: false });
  assert.deepEqual(config.containedSubagents, {
    enabled: true,
    maxCount: 3,
    outputBytes: 12000,
    reasons: ["context_heavy", "broad_source_inspection", "validation_split"],
    roles: ["explorer", "implementer", "verifier"],
  });
  assert.match(config.commandScript ?? "", /contained_subagents=enabled/);
  assert.match(config.commandScript ?? "", /spawn up to 3 OpenClaw subagent/);
  assert.equal(config.commandJson, undefined);
  assert.deepEqual(config.extraMounts, [
    { source: "/root/.openclaw", target: "/run/secrets/openclaw-dir", readOnly: true },
  ]);
});

test("loadConfig allows OpenClaw contained subagents to opt out explicitly", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED: "0",
  });

  assert.deepEqual(config.containedSubagents, {
    enabled: false,
    maxCount: 0,
    outputBytes: 12000,
    reasons: ["context_heavy", "broad_source_inspection", "validation_split"],
    roles: ["explorer", "implementer", "verifier"],
  });
  assert.match(config.commandScript ?? "", /contained_subagents=disabled/);
  assert.match(config.commandScript ?? "", /Do not spawn OpenClaw subagents/);
});

test("loadConfig enables bounded contained OpenClaw subagents with explicit overrides", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED: "1",
    A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX: "3",
    A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_OUTPUT_BYTES: "20000",
    A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_REASONS: "context_heavy,validation_split",
    A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES: "explorer,verifier",
  });

  assert.deepEqual(config.containedSubagents, {
    enabled: true,
    maxCount: 3,
    outputBytes: 20000,
    reasons: ["context_heavy", "validation_split"],
    roles: ["explorer", "verifier"],
  });
  assert.match(config.commandScript ?? "", /contained_subagents=enabled/);
  assert.match(config.commandScript ?? "", /contained_subagents_max=3/);
  assert.match(config.commandScript ?? "", /spawn up to 3 OpenClaw subagent/);
  assert.match(config.commandScript ?? "", /Bound each helper evidence summary to 20000 bytes/);
  assert.match(config.commandScript ?? "", /Subagents are evidence helpers only/);
});

test("loadConfig builds first-class Hermes patch profile", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_HERMES_MODEL: "deepseek/deepseek-v4-flash",
    A2A_HERMES_TIMEOUT_SEC: "3600",
  });

  assert.equal(config.commandProfile, "hermes");
  assert.equal(config.network, "host");
  assert.match(config.commandScript ?? "", /command -v hermes/);
  assert.match(config.commandScript ?? "", /hermes --version/);
  assert.match(config.commandScript ?? "", /export HERMES_HOME=\/root\/\.hermes/);
  assert.match(config.commandScript ?? "", /copy_file_if_exists \/run\/secrets\/hermes-dir\/config\.yaml/);
  assert.match(config.commandScript ?? "", /copy_file_if_exists \/run\/secrets\/hermes-dir\/\.env/);
  assert.match(config.commandScript ?? "", /copy_file_if_exists \/run\/secrets\/hermes-dir\/auth\.json/);
  assert.match(config.commandScript ?? "", /copy_dir_if_exists \/run\/secrets\/hermes-dir\/skills/);
  assert.match(config.commandScript ?? "", /--model "\$A2A_HERMES_MODEL"/);
  assert.match(config.commandScript ?? "", /--quiet/);
  assert.match(config.commandScript ?? "", /--yolo/);
  assert.match(config.commandScript ?? "", /hermes_no_changes=allowed/);
  assert.match(config.commandScript ?? "", /BOOTSTRAP_BANNED_DIRS="\.openclaw \.hermes memory"/);
  assert.match(config.commandScript ?? "", /error=hermes_completed_without_changes/);
  assert.deepEqual(config.containedSubagents, {
    enabled: true,
    maxCount: 3,
    outputBytes: 12000,
    reasons: ["context_heavy", "broad_source_inspection", "validation_split"],
    roles: ["explorer", "verifier"],
  });
  assert.match(config.commandScript ?? "", /contained_subagents=enabled/);
  assert.match(config.commandScript ?? "", /spawn up to 3 Hermes subagent/);
  assert.deepEqual(config.hermesProfile, { configDir: "/root/.hermes" });
  assert.deepEqual(config.extraMounts, [
    { source: "/root/.hermes", target: "/run/secrets/hermes-dir", readOnly: true },
  ]);
});

test("loadConfig enables bounded contained Hermes subagents with safe enum inputs", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED: "true",
    A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX: "2",
    A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_REASONS: "broad_source_inspection,context_overflow_retry",
  });

  assert.deepEqual(config.containedSubagents, {
    enabled: true,
    maxCount: 2,
    outputBytes: 12000,
    reasons: ["broad_source_inspection", "context_overflow_retry"],
    roles: ["explorer", "verifier"],
  });
  assert.match(config.commandScript ?? "", /contained_subagents=enabled/);
  assert.match(config.commandScript ?? "", /spawn up to 2 Hermes subagent/);
  assert.match(config.commandScript ?? "", /broad_source_inspection, context_overflow_retry/);
});

test("loadConfig rejects contained subagent opt-in without OpenClaw or Hermes profile", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED: "1",
      A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "#!/usr/bin/env bash\ncodex exec hi\n",
    }),
    /contained subagents require A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=openclaw or hermes/,
  );
});

test("loadConfig rejects unsupported contained subagent values before prompt generation", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
      A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED: "1",
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX: "9",
    }),
    /A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX must be an integer between 1 and 4/,
  );

  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
      A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED: "1",
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_REASONS: "raw_transcript_dump",
    }),
    /A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_REASONS contains unsupported values/,
  );
});

test("loadConfig Hermes patch profile honors custom config dir", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_HERMES_CONFIG_DIR: "/srv/hermes-profile",
  });

  assert.deepEqual(config.extraMounts, [
    { source: "/srv/hermes-profile", target: "/run/secrets/hermes-dir", readOnly: true },
  ]);
  assert.deepEqual(config.hermesProfile, { configDir: "/srv/hermes-profile" });
});

test("Hermes patch profile defaults to the current fleet baseline model (#766)", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
  });

  assert.match(config.commandScript ?? "", /A2A_HERMES_DEFAULT_MODEL='openai-codex\/gpt-5\.5'/);
  assert.match(config.commandScript ?? "", /export A2A_HERMES_MODEL="\$A2A_HERMES_DEFAULT_MODEL"/);
  assert.doesNotMatch(config.commandScript ?? "", /A2A_HERMES_DEFAULT_MODEL='deepseek\/deepseek-v4-flash'/);
});

test("Hermes patch profile bridges task-level OpenClaw model env before legacy default (#860)", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_OPENCLAW_MODEL: "deepseek/deepseek-v4-flash",
  });

  const script = config.commandScript ?? "";
  assert.match(script, /A2A_HERMES_DEFAULT_MODEL='deepseek\/deepseek-v4-flash'/);
  assert.ok(script.includes('elif [ -n "${A2A_OPENCLAW_MODEL:-}" ]; then'));
  assert.ok(script.includes('export A2A_HERMES_MODEL="$A2A_OPENCLAW_MODEL"'));
  assert.ok(
    script.indexOf('export A2A_HERMES_MODEL="$A2A_OPENCLAW_MODEL"')
      < script.indexOf('export A2A_HERMES_MODEL="$A2A_HERMES_DEFAULT_MODEL"'),
    "task-level A2A_OPENCLAW_MODEL bridge must precede legacy default fallback",
  );
});

test("Hermes patch profile can opt into native model source without hardcoding Docker runner fallback", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_MODEL_SOURCE: "native",
  });

  assert.match(config.commandScript ?? "", /A2A_DOCKER_RUNNER_MODEL_SOURCE='native'/);
  assert.match(config.commandScript ?? "", /resolve_hermes_native_model/);
  assert.match(config.commandScript ?? "", /error=hermes_native_model_unresolved/);
  assert.match(config.commandScript ?? "", /model_source=native/);
  assert.doesNotMatch(config.commandScript ?? "", /export A2A_HERMES_MODEL='deepseek\/deepseek-v4-flash'/);
});

test("Hermes native model resolver heredoc parses and ignores unsupported flash model", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_MODEL_SOURCE: "native",
  });
  const resolver = extractNodeHeredoc(config.commandScript ?? "", "A2A_RESOLVE_HERMES_NATIVE_MODEL");

  assertNodeScriptParses(resolver);
  assert.doesNotMatch(resolver, /split\(\/\\r\?\\n\//);
  assert.match(resolver, /String\.fromCharCode\(10\)/);
  assert.match(resolver, /deepseek\/deepseek-v4-flash/);
  assert.equal(runResolverScript(resolver, {
    "/root/.hermes/.env": [
      "A2A_HERMES_MODEL=deepseek-v4-flash",
      "HERMES_MODEL=token = should-not-be-a-model",
      "MODEL=apiKey: should-not-be-a-model",
    ].join("\n"),
    "/root/.hermes/config.yaml": [
      "provider: openai",
      "model: gpt-5.5",
    ].join("\n"),
  }), "openai/gpt-5.5");
  assert.equal(runResolverScript(resolver, {
    "/root/.hermes/.env": [
      "A2A_HERMES_MODEL=deepseek/deepseek-v4-flash",
      "HERMES_MODEL=secret : should-not-be-a-model",
      "MODEL=apikey=should-not-be-a-model",
    ].join("\n"),
    "/root/.hermes/config.yaml": "model: api-key: should-not-be-a-model\n",
  }), "");
});

test("OpenClaw patch profile defaults command timeout to 60 minutes", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
  });

  assert.match(config.commandScript ?? "", /export A2A_OPENCLAW_TIMEOUT_SEC='3600'/);
});

test("loadConfig OpenClaw patch profile requires explicit opt-in for npm CLI fallback", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_OPENCLAW_ALLOW_NPM_INSTALL_FALLBACK: "1",
  });

  assert.match(config.commandScript ?? "", /A2A_OPENCLAW_ALLOW_NPM_INSTALL_FALLBACK='1'/);
  assert.match(config.commandScript ?? "", /openclaw_cli_missing_install_attempted/);
  assert.match(config.commandScript ?? "", /error=openclaw_install_failed/);
  assert.match(config.commandScript ?? "", /failure_category=openclaw_cli_unavailable/);
  assert.deepEqual(config.openclawProfile, { allowNpmInstallFallback: true });
});

test("loadConfig OpenClaw patch profile honors custom model", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_OPENCLAW_MODEL: "zai/glm-5.1",
  });

  assert.match(config.commandScript ?? "", /A2A_OPENCLAW_DEFAULT_MODEL='zai\/glm-5\.1'/);
  assert.match(config.commandScript ?? "", /export A2A_OPENCLAW_MODEL="\$A2A_OPENCLAW_DEFAULT_MODEL"/);
  assert.match(config.commandScript ?? "", /--model "\$A2A_OPENCLAW_MODEL"/);
  assert.match(config.commandScript ?? "", /const selectedModel = process\.env\.A2A_OPENCLAW_MODEL/);
  assert.match(config.commandScript ?? "", /selectedProvider/);
});

test("OpenClaw patch profile can opt into native model source without hardcoding Docker runner fallback", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_MODEL_SOURCE: "native",
  });

  assert.match(config.commandScript ?? "", /A2A_DOCKER_RUNNER_MODEL_SOURCE='native'/);
  assert.match(config.commandScript ?? "", /resolve_openclaw_native_model/);
  assert.match(config.commandScript ?? "", /error=openclaw_native_model_unresolved/);
  assert.match(config.commandScript ?? "", /model_source=native/);
  assert.doesNotMatch(config.commandScript ?? "", /export A2A_OPENCLAW_MODEL='openai-codex\/gpt-5\.5'/);
});

test("OpenClaw native model resolver heredoc parses", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_MODEL_SOURCE: "native",
  });
  const resolver = extractNodeHeredoc(config.commandScript ?? "", "A2A_RESOLVE_OPENCLAW_NATIVE_MODEL");

  assertNodeScriptParses(resolver);
  assert.match(resolver, /String\.fromCharCode\(10\)/);
  assert.equal(runResolverScript(resolver, {
    "/root/.openclaw/openclaw.json": JSON.stringify({
      agents: {
        list: [
          { id: "main", model: { primary: "apiKey = should-not-be-a-model" } },
          { id: "review", model: { primary: "deepseek/deepseek-v4-pro" } },
        ],
        defaults: { model: { primary: "openai-codex/gpt-5.5" } },
      },
    }),
  }), "openai-codex/gpt-5.5");
  assert.equal(runResolverScript(resolver, {
    "/root/.openclaw/openclaw.json": JSON.stringify({
      agents: {
        list: [{ id: "main", model: { primary: "password : should-not-be-a-model" } }],
        defaults: { model: { primary: "token=should-not-be-a-model" } },
      },
      defaults: { model: "api_key: should-not-be-a-model" },
    }),
  }), "");
});

test("loadConfig honors explicit Docker network override", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_NETWORK: "bridge",
  });

  assert.equal(config.network, "bridge");
});

test("loadConfig OpenClaw patch profile honors custom config dir", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR: "/srv/openclaw-profile",
  });

  assert.deepEqual(config.extraMounts, [
    { source: "/srv/openclaw-profile", target: "/run/secrets/openclaw-dir", readOnly: true },
  ]);
});

test("loadConfig rejects unsupported patch command profile", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "claude",
    }),
    /unsupported A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE/,
  );
});

test("loadConfig reads Codex patch command JSON env var", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["codex", "exec", "json"] }),
  });

  assert.equal(config.commandJson, '{"argv":["codex","exec","json"]}');
});

test("loadConfig rejects legacy patch command template even with allowed executors", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE: "openclaw agent --help",
    }),
    /PATCH_COMMAND_TEMPLATE is disabled/,
  );
});

test("loadConfig patch command precedence is script > json > template", async () => {
  const scriptConfig = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "codex exec script",
    A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["codex", "exec", "json"] }),
    A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE: "openclaw agent --help",
  });
  assert.equal(scriptConfig.commandScript, "codex exec script");
  assert.equal(scriptConfig.commandJson, undefined);
  assert.equal(scriptConfig.commandTemplate, undefined);

  const jsonConfig = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["codex", "exec", "json"] }),
    A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE: "openclaw agent --help",
  });
  assert.equal(jsonConfig.commandScript, undefined);
  assert.equal(jsonConfig.commandJson, '{"argv":["codex","exec","json"]}');
  assert.equal(jsonConfig.commandTemplate, undefined);
});

test("loadConfig reads extra runner mounts", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/var/lib/openclaw/codex", target: "/run/secrets/codex", readOnly: true },
      { source: "/var/tmp/a2a", target: "/scratch", readOnly: false },
    ]),
  });

  assert.deepEqual(config.extraMounts, [
    { source: "/var/lib/openclaw/codex", target: "/run/secrets/codex", readOnly: true },
    { source: "/var/tmp/a2a", target: "/scratch", readOnly: false },
  ]);
});

test("loadConfig rejects openclaw profile extra mounts without the profile mount", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
      A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
        { source: "/usr/lib/node_modules/openclaw", target: "/usr/lib/node_modules/openclaw", readOnly: true },
      ]),
    }),
    /openclaw patch profile requires a \/run\/secrets\/openclaw-dir mount/,
  );
});

test("loadConfig rejects conflicting openclaw profile mount source", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
      A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
      A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR: "/root/.openclaw-a2a-deepseek-config",
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
        { source: "/usr/lib/node_modules/openclaw", target: "/usr/lib/node_modules/openclaw", readOnly: true },
        { source: "/root/.openclaw", target: "/run/secrets/openclaw-dir", readOnly: true },
      ]),
    }),
    /source conflicts with the configured OpenClaw profile directory/,
  );
});

test("loadConfig rejects hermes profile extra mounts without the profile mount", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
      A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
        { source: "/var/tmp/a2a", target: "/scratch", readOnly: false },
      ]),
    }),
    /hermes patch profile requires a \/run\/secrets\/hermes-dir mount/,
  );
});

test("loadConfig accepts explicit openclaw profile mount source matching config dir", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "openclaw",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_OPENCLAW_CONFIG_DIR: "/root/.openclaw-a2a-deepseek-config",
    A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
      { source: "/usr/lib/node_modules/openclaw", target: "/usr/lib/node_modules/openclaw", readOnly: true },
      { source: "/root/.openclaw-a2a-deepseek-config", target: "/run/secrets/openclaw-dir", readOnly: true },
    ]),
  });

  assert.deepEqual(config.extraMounts, [
    { source: "/usr/lib/node_modules/openclaw", target: "/usr/lib/node_modules/openclaw", readOnly: true },
    { source: "/root/.openclaw-a2a-deepseek-config", target: "/run/secrets/openclaw-dir", readOnly: true },
  ]);
});

test("loadConfig rejects malformed extra runner mounts", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([{ source: "relative", target: "/x" }]),
    }),
    /source must be an absolute path/,
  );
});

test("loadConfig rejects writable agent runtime/session mounts", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
        { source: "/root/.openclaw/workspace/sessions", target: "/host-sessions", readOnly: false },
      ]),
    }),
    /writable agent runtime\/session paths are forbidden/,
  );

  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
        { source: "/var/tmp/a2a", target: "/run/secrets/openclaw-dir/agents/main/agent", readOnly: false },
      ]),
    }),
    /writable agent runtime\/session paths are forbidden/,
  );

  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
        { source: "/root/.hermes/sessions", target: "/host-hermes-sessions", readOnly: false },
      ]),
    }),
    /writable agent runtime\/session paths are forbidden/,
  );
});

test("loadConfig blocks Claude-in-Docker patch commands", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "npm install -g @anthropic-ai/claude-code\nclaude --print hello",
    }),
    /Claude-in-Docker.*not an allowed Docker patch executor/,
  );

  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["claude", "--print", "hello"] }),
    }),
    /Claude-in-Docker.*not an allowed Docker patch executor/,
  );

  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_TEMPLATE: "claude --print hello",
    }),
    /PATCH_COMMAND_TEMPLATE is disabled/,
  );
});

test("loadConfig blocks Claude credential mounts", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_EXTRA_MOUNTS_JSON: JSON.stringify([
        { source: "/root/.claude", target: "/run/secrets/claude-dir" },
      ]),
    }),
    /Claude credentials.*not allowed in Docker patch execution/,
  );
});

test("loadConfig rejects Claude-in-Docker even with the legacy opt-in flag", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_ALLOW_CLAUDE_IN_DOCKER: "1",
      A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["claude", "--print", "hello"] }),
    }),
    /not an allowed Docker patch executor|OpenClaw, Hermes, or Codex/,
  );
});

test("loadConfig rejects patch commands without an allowed agent executor", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "#!/usr/bin/env bash\ngit status",
    }),
    /allowed Docker patch executor: OpenClaw, Hermes, or Codex/,
  );
});

test("loadConfig allows OpenClaw, Hermes, and Codex Docker patch executors", async () => {
  const openclawConfig = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "#!/usr/bin/env bash\nnpm install -g openclaw\nopenclaw agent --local --message hi",
  });
  assert.match(openclawConfig.commandScript ?? "", /openclaw agent/);

  const hermesConfig = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "#!/usr/bin/env bash\nhermes chat --query hi --quiet",
  });
  assert.match(hermesConfig.commandScript ?? "", /hermes chat/);

  const codexConfig = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["bash", "-lc", "npm install -g @openai/codex && codex exec --help"] }),
  });
  assert.match(codexConfig.commandJson ?? "", /@openai\/codex/);
});

// --- pre-deploy config validation (a2a-plane#249) ---

function validConfig(overrides?: Partial<RunnerConfig>): RunnerConfig {
  return {
    rootDir: "/var/lib/openclaw-a2a/tasks",
    image: "node:22-bookworm-slim",
    engine: "docker",
    defaultTimeoutMs: 900000,
    ...overrides,
  };
}

test("validateRunnerConfig accepts valid config", () => {
  assert.doesNotThrow(() => validateRunnerConfig(validConfig()));
  assert.doesNotThrow(() => validateRunnerConfig(validConfig({ network: "bridge" })));
  assert.doesNotThrow(() => validateRunnerConfig(validConfig({ network: "host", trustedOperator: true })));
  assert.doesNotThrow(() => validateRunnerConfig(validConfig({ network: "none" })));
  assert.doesNotThrow(() => validateRunnerConfig(validConfig({ memory: "4g" })));
  assert.doesNotThrow(() => validateRunnerConfig(validConfig({ memory: "512m" })));
  assert.doesNotThrow(() => validateRunnerConfig(validConfig({ cpus: "4" })));
  assert.doesNotThrow(() => validateRunnerConfig(validConfig({ cpus: "1.5" })));
  assert.doesNotThrow(() => validateRunnerConfig(validConfig({ defaultTimeoutMs: 1 })));
});

test("validateRunnerConfig rejects empty image", () => {
  assert.throws(
    () => validateRunnerConfig(validConfig({ image: "" })),
    /runner pre-deploy config validation failed/,
  );
  assert.throws(
    () => validateRunnerConfig(validConfig({ image: "" })),
    /image must be a non-empty string/,
  );
});

test("validateRunnerConfig rejects non-absolute rootDir", () => {
  assert.throws(
    () => validateRunnerConfig(validConfig({ rootDir: "relative/path" })),
    /rootDir must be a non-empty absolute path/,
  );
  assert.throws(
    () => validateRunnerConfig(validConfig({ rootDir: "" })),
    /rootDir must be a non-empty absolute path/,
  );
});

test("validateRunnerConfig rejects unsupported network mode", () => {
  assert.throws(
    () => validateRunnerConfig(validConfig({ network: "overlay" })),
    /unsupported network mode/,
  );
  assert.throws(
    () => validateRunnerConfig(validConfig({ network: "container:foo" })),
    /unsupported network mode/,
  );
});

test("validateRunnerConfig rejects invalid memory format", () => {
  assert.throws(
    () => validateRunnerConfig(validConfig({ memory: "two gigabytes" })),
    /invalid memory limit/,
  );
  assert.throws(
    () => validateRunnerConfig(validConfig({ memory: "-2g" })),
    /invalid memory limit/,
  );
});

test("validateRunnerConfig rejects invalid pids limit", () => {
  assert.throws(
    () => validateRunnerConfig(validConfig({ pidsLimit: "zero" })),
    /invalid pids limit/,
  );
  assert.throws(
    () => validateRunnerConfig(validConfig({ pidsLimit: "0" })),
    /invalid pids limit/,
  );
});

test("validateRunnerConfig rejects invalid cpus format", () => {
  assert.throws(
    () => validateRunnerConfig(validConfig({ cpus: "two" })),
    /invalid cpus/,
  );
  assert.throws(
    () => validateRunnerConfig(validConfig({ cpus: "1.2.3" })),
    /invalid cpus/,
  );
});

test("validateRunnerConfig rejects invalid defaultTimeoutMs", () => {
  assert.throws(
    () => validateRunnerConfig(validConfig({ defaultTimeoutMs: 0 })),
    /invalid defaultTimeoutMs/,
  );
  assert.throws(
    () => validateRunnerConfig(validConfig({ defaultTimeoutMs: -100 })),
    /invalid defaultTimeoutMs/,
  );
  assert.throws(
    () => validateRunnerConfig(validConfig({ defaultTimeoutMs: NaN })),
    /invalid defaultTimeoutMs/,
  );
});

test("validateRunnerConfig reports all errors at once", () => {
  try {
    validateRunnerConfig(validConfig({
      image: "",
      rootDir: "bad",
      network: "overlay",
      memory: "bad",
      cpus: "bad",
      defaultTimeoutMs: 0,
    }));
    assert.fail("expected throw");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, /image must be a non-empty string/);
    assert.match(msg, /rootDir must be a non-empty absolute path/);
    assert.match(msg, /unsupported network mode/);
    assert.match(msg, /invalid memory limit/);
    assert.match(msg, /invalid cpus/);
    assert.match(msg, /invalid defaultTimeoutMs/);
  }
});

test("loadConfig runs pre-deploy validation on invalid network", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_NETWORK: "invalid-mode",
    }),
    /runner pre-deploy config validation failed/,
  );
});

test("loadConfig runs pre-deploy validation on invalid memory", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_MEMORY: "not-a-number",
    }),
    /runner pre-deploy config validation failed/,
  );
});
