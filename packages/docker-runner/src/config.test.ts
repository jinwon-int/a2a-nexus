import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { buildClaudeCodePatchCommandScript, buildCodexPatchCommandScript, loadContainedSubagentsConfig, loadConfig, loadEnvFile, mergeRunnerEnvFile, projectClaudeCodeTurnBudgets, validateRunnerConfig } from "./config.js";
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

function assertBashScriptParses(source: string): void {
  const dir = mkdtempSync(join(tmpdir(), "a2a-runner-bash-check-"));
  try {
    const file = join(dir, "script.sh");
    writeFileSync(file, source);
    execFileSync("bash", ["-n", file], { stdio: "pipe" });
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




test("untrusted runner defaults deny task egress and reject GitHub token file exposure", async () => {
  const cfg = await loadConfig({
    ...baseEnv,
  });
  assert.equal(cfg.network, "none");

  assert.throws(
    () => validateRunnerConfig({
      rootDir: "/tmp/a2a-runner",
      image: "node:22-bookworm-slim",
      defaultTimeoutMs: 1000,
      network: "bridge",
      noNewPrivileges: true,
      capDrop: [],
      githubTokenFile: "/tmp/hosts.yml",
      trustedOperator: false,
    }),
    /public safe-default policy rejects GitHub token file exposure/,
  );
});

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

test("loadConfig adds an explicit deny-by-default egress allowlist layer without opening container network", async () => {
  const defaultCfg = await loadConfig({ ...baseEnv });
  assert.deepEqual(defaultCfg.egressAllowlistHosts, [], "no env means no allowed egress hosts");
  assert.equal(defaultCfg.network, "none", "analysis lanes still default to no container network");

  const cfg = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_EGRESS_ALLOWLIST_HOSTS: "api.github.com,raw.githubusercontent.com",
    A2A_DOCKER_RUNNER_EGRESS_MAX_BYTES: "4096",
    A2A_DOCKER_RUNNER_EGRESS_TIMEOUT_MS: "2500",
  });
  assert.deepEqual(cfg.egressAllowlistHosts, ["api.github.com", "raw.githubusercontent.com"]);
  assert.equal(cfg.egressMaxBytes, 4096);
  assert.equal(cfg.egressTimeoutMs, 2500);
  assert.equal(cfg.network, "none");
});

test("validateRunnerConfig rejects internal egress allowlist entries", () => {
  const base: RunnerConfig = {
    rootDir: "/tmp/a2a-runner",
    image: "node:22-bookworm-slim",
    defaultTimeoutMs: 1000,
    network: "none",
    noNewPrivileges: true,
    capDrop: [],
    trustedOperator: false,
  };
  assert.throws(
    () => validateRunnerConfig({ ...base, egressAllowlistHosts: ["localhost"] }),
    /egress allowlist rejects internal host\/IP: "localhost"/,
  );
  assert.throws(
    () => validateRunnerConfig({ ...base, egressAllowlistHosts: ["169.254.169.254"] }),
    /egress allowlist rejects internal host\/IP: "169.254.169.254"/,
  );
  assert.throws(
    () => validateRunnerConfig({ ...base, egressAllowlistHosts: ["svc.internal"] }),
    /egress allowlist rejects internal host\/IP: "svc.internal"/,
  );
  assert.throws(
    () => validateRunnerConfig({ ...base, egressAllowlistHosts: ["[::1]"] }),
    /egress allowlist rejects internal host\/IP: "\[::1\]"/,
  );
  assert.throws(
    () => validateRunnerConfig({ ...base, egressAllowlistHosts: ["example.com"] }),
    /egress allowlist host is outside the supported GitHub retrieval hosts: "example.com"/,
  );
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
    assert.equal(config.network, "bridge");
  assert.equal(config.readOnlyRootFilesystem, true);
  assert.equal(config.user, "1000:1000");
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
    assert.equal(config.network, "bridge");
  assert.equal(config.readOnlyRootFilesystem, true);
  assert.equal(config.user, "1000:1000");
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

test("mergeRunnerEnvFile supports Claude Code cccb patch profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-runner-env-"));
  try {
    const file = join(dir, "worker.env");
    writeFileSync(file, [
      "A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=cccb",
      "A2A_DOCKER_RUNNER_TRUSTED_OPERATOR=1",
      "A2A_DOCKER_RUNNER_CLAUDE_CONFIG_DIR=/srv/claude-profile",
      "A2A_DOCKER_RUNNER_IMAGE=a2a-docker-runner-cccb:latest",
    ].join("\n"));

    const env = mergeRunnerEnvFile({
      ...baseEnv,
      A2A_CLAUDE_MODEL: "sonnet",
    }, file);
    const config = await loadConfig(env);

    assert.equal(config.commandProfile, "claude-code");
    assert.equal(config.image, "a2a-docker-runner-cccb:latest");
    assert.equal(config.network, "bridge");
  assert.equal(config.readOnlyRootFilesystem, true);
    assert.equal(config.user, "1000:1000");
    assert.match(config.commandScript ?? "", /claude-a2a-patch-bridge\.mjs/);
    assert.match(config.commandScript ?? "", /A2A_CLAUDE_MODEL/);
    assert.match(config.commandScript ?? "", /export HOME=\/tmp\/claude-home/);
    assert.match(config.commandScript ?? "", /export CLAUDE_CONFIG_DIR="\$HOME\/\.claude"/);
    assert.doesNotMatch(config.commandScript ?? "", /\/root\/\.claude/);
    assert.deepEqual(config.claudeCodeProfile, {
      configDir: "/srv/claude-profile",
      turnBudgets: projectClaudeCodeTurnBudgets(env),
    });
    assert.deepEqual(config.extraMounts, [
      { source: "/srv/claude-profile", target: "/run/secrets/claude-dir", readOnly: true },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeRunnerEnvFile supports first-class Codex patch profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-runner-env-"));
  try {
    const file = join(dir, "worker.env");
    writeFileSync(file, [
      "A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=codex",
      "A2A_DOCKER_RUNNER_TRUSTED_OPERATOR=1",
      "A2A_DOCKER_RUNNER_CODEX_CONFIG_DIR=/srv/codex-profile",
      "A2A_DOCKER_RUNNER_IMAGE=a2a-docker-runner-codex:latest",
      "A2A_CODEX_MODEL=gpt-5.6-sol",
      "A2A_CODEX_REASONING_EFFORT=high",
      "A2A_CODEX_TIMEOUT_SEC=3600",
    ].join("\n"));

    const config = await loadConfig(mergeRunnerEnvFile(baseEnv, file));

    assert.equal(config.commandProfile, "codex");
    assert.equal(config.image, "a2a-docker-runner-codex:latest");
    assert.equal(config.network, "bridge");
    assert.match(config.commandScript ?? "", /codex exec/);
    assert.match(config.commandScript ?? "", /gpt-5\.6-sol/);
    assert.match(config.commandScript ?? "", /model_reasoning_effort="\$A2A_CODEX_REASONING_EFFORT"/);
    assert.match(config.commandScript ?? "", /A2A_CODEX_DEFAULT_TIMEOUT_SEC='3600'/);
    assert.match(config.commandScript ?? "", /A2A_CODEX_TIMEOUT_SEC="\$\{A2A_CODEX_TIMEOUT_SEC:-\$A2A_CODEX_DEFAULT_TIMEOUT_SEC\}"/);
    assert.doesNotMatch(config.commandScript ?? "", /A2A_CODEX_TIMEOUT_SEC="\$\{A2A_CODEX_TIMEOUT_SEC:-'3600'\}"/);
    assert.match(config.commandScript ?? "", /export CODEX_HOME=\/run\/secrets\/codex-dir/);
    assert.match(config.commandScript ?? "", /codex_config_mount_not_writable/);
    assert.doesNotMatch(config.commandScript ?? "", /\/tmp\/codex-home/);
    assert.match(config.commandScript ?? "", /--sandbox danger-full-access/);
    assert.deepEqual(config.codexProfile, { configDir: "/srv/codex-profile" });
    assert.deepEqual(config.extraMounts, [
      { source: "/srv/codex-profile", target: "/run/secrets/codex-dir", readOnly: true },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex patch profile defaults to the dedicated minimal credential directory", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "codex",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-codex:latest",
  });

  assert.deepEqual(config.codexProfile, { configDir: "/var/lib/a2a-runner/codex-dir" });
  assert.deepEqual(config.extraMounts, [
    {
      source: "/var/lib/a2a-runner/codex-dir",
      target: "/run/secrets/codex-dir",
      readOnly: true,
    },
  ]);
});

test("Codex patch profile reserves git and GitHub lifecycle work for the outer runner", () => {
  const script = buildCodexPatchCommandScript({});

  assert.match(script, /A2A_LIFECYCLE_GUARD_BIN=\/work\/a2a-codex-lifecycle-guard-bin/);
  assert.match(script, /error=a2a_runner_contract_violation command=git_\$\{1:-\}/);
  assert.match(script, /add\|commit\|push\|checkout\|switch\|reset\|merge\|rebase\|tag/);
  assert.match(script, /error=a2a_runner_contract_violation command=git_branch_mutation/);
  assert.match(script, /"pr create"\|"pr merge"\|"issue close"\|"issue comment"/);
  assert.match(script, /lifecycle_guard=enabled profile=codex/);
  assert.match(script, /The outer runner owns[\s\S]*git and GitHub lifecycle/);
  assert.match(script, /Do not run git add, git commit, git push/);
  assert.match(script, /Do not run gh pr create/);
  assert.match(script, /cat \/work\/artifacts\/prompt\.md >> \/work\/artifacts\/codex-prompt\.md/);
  assert.match(script, /- < \/work\/artifacts\/codex-prompt\.md/);
  assert.doesNotMatch(script, /- < \/work\/artifacts\/prompt\.md/);
  // codex 0.144.1 은 스칼라 `agents.*` 를 AgentRoleToml 로 읽어 기동을 거부한다.
  // 비활성은 역할 프로파일을 설치하지 않는 것으로 표현한다.
  assert.doesNotMatch(script, /agents\.enabled=false/);
  assert.doesNotMatch(script, /name = "a2a_explorer"/);
  assert.doesNotMatch(script, /model = "gpt-5\.6-luna"/);
  assertBashScriptParses(script);
});

test("Codex contained subagents route low-cost roles to Luna max and preserve upper Sol profiles", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "codex",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-codex:test",
    A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED: "1",
    A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX: "3",
    A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES: "explorer,implementer,verifier",
  });

  assert.deepEqual(config.containedSubagents, {
    enabled: true,
    maxCount: 3,
    outputBytes: 12000,
    reasons: ["context_heavy", "broad_source_inspection", "validation_split"],
    roles: ["explorer", "implementer", "verifier"],
  });
  const script = config.commandScript ?? "";
  assert.match(script, /A2A_CODEX_DEFAULT_MODEL='gpt-5\.6-sol'/);
  assert.match(script, /--model "\$A2A_CODEX_MODEL"/);
  // 활성 경로도 스칼라 `agents.*` 를 쓰면 안 된다 — codex 0.144.1 에서 `=true` 역시
  // `invalid type: boolean true, expected struct AgentRoleToml` 로 죽는 것을 실측했다.
  // 활성화는 아래 역할 프로파일 설치가 담당한다.
  assert.doesNotMatch(script, /agents\.enabled=true/);
  assert.doesNotMatch(script, /agents\.max_concurrent_threads_per_session=/);
  assert.match(script, /name = "a2a_explorer"[\s\S]*model = "gpt-5\.6-luna"[\s\S]*model_reasoning_effort = "max"/);
  assert.match(script, /name = "a2a_researcher"[\s\S]*model = "gpt-5\.6-luna"[\s\S]*model_reasoning_effort = "max"/);
  assert.match(script, /name = "a2a_implementer"[\s\S]*model = "gpt-5\.6-sol"[\s\S]*model_reasoning_effort = "high"/);
  assert.match(script, /name = "a2a_verifier"[\s\S]*model = "gpt-5\.6-sol"[\s\S]*model_reasoning_effort = "xhigh"/);
  assert.match(script, /parent Codex worker keeps its configured model and remains the only finalizer/);
  assert.match(script, /contained_subagents_explorer_model=gpt-5\.6-luna reasoning=max/);
  assert.match(script, /contained_subagents_implementer_model=gpt-5\.6-sol reasoning=high/);
  assert.match(script, /contained_subagents_verifier_model=gpt-5\.6-sol reasoning=xhigh/);
  assertBashScriptParses(script);
});

test("Codex contained subagent role allowlist controls which custom profiles are installed", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "codex",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-codex:test",
    A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED: "1",
    A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ROLES: "explorer,verifier",
  });

  const script = config.commandScript ?? "";
  assert.match(script, /name = "a2a_explorer"/);
  assert.match(script, /name = "a2a_researcher"/);
  assert.match(script, /name = "a2a_verifier"/);
  assert.doesNotMatch(script, /name = "a2a_implementer"/);
  assert.doesNotMatch(script, /Use a2a_implementer/);
  assert.doesNotMatch(script, /contained_subagents_implementer_model=/);
  assertBashScriptParses(script);
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
  const codex = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_EXPECTED_PATCH_COMMAND_PROFILE: "codex",
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "codex",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-codex:d9d7d64",
  });
  assert.equal(codex.commandProfile, "codex");

  const claudeCode = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_EXPECTED_PATCH_COMMAND_PROFILE: "claude-code",
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "cccb",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
    A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-cccb:d9d7d64",
  });
  assert.equal(claudeCode.commandProfile, "claude-code");

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
      A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-codex:d9d7d64",
    }),
    /image\/profile mismatch.*codex runner image.*PROFILE=hermes/,
  );

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

  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
      A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
      A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-cccb:d9d7d64",
    }),
    /image\/profile mismatch.*claude-code runner image.*PROFILE=hermes/,
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
  assert.equal(config.network, "bridge");
  assert.equal(config.readOnlyRootFilesystem, true);
  assert.equal(config.user, "1000:1000");
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

// codex 0.144.1 의 `agents` 는 역할 이름 → AgentRoleToml 테이블이므로 스칼라 키를
// 주면 기동 단계에서 죽는다. 러너 이미지에서 실측했다:
//   Error loading config.toml: invalid type: boolean `false`,
//     expected struct AgentRoleToml in `agents`
// disabled/enabled 두 경로 모두 재현되므로 양쪽을 다 막는다.
for (const [label, enabled, max] of [
  ["disabled", "0", "0"],
  ["enabled", "1", "2"],
] as const) {
  test(`codex command script never emits scalar agents.* overrides (${label})`, async () => {
    const config = await loadConfig({
      A2A_DOCKER_RUNNER_IMAGE: "a2a-docker-runner-codex:test",
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "codex",
      A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED: enabled,
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_MAX: max,
    });

    const script = config.commandScript ?? "";
    assert.doesNotMatch(script, /agents\.enabled=/, "agents.enabled 는 AgentRoleToml 로 해석돼 codex 기동을 깨뜨린다");
    assert.doesNotMatch(
      script,
      /agents\.max_concurrent_threads_per_session=/,
      "agents.max_concurrent_threads_per_session 도 같은 이유로 금지",
    );
  });
}

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
  assert.equal(config.network, "bridge");
  assert.equal(config.readOnlyRootFilesystem, true);
  assert.equal(config.user, "1000:1000");
  assert.match(config.commandScript ?? "", /command -v hermes/);
  assert.match(config.commandScript ?? "", /hermes --version/);
  assert.match(config.commandScript ?? "", /export HOME=\/work/);
  assert.match(config.commandScript ?? "", /export HERMES_HOME=\/work\/\.hermes/);
  assert.match(config.commandScript ?? "", /export HERMES_WORKSPACE_DIR=\/work\/hermes-agent-workspace/);
  assert.doesNotMatch(config.commandScript ?? "", /rm -rf \/root\/\.hermes/);
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

test("Hermes patch profile constrains the embedded agent to file edits only", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
  });

  const script = config.commandScript ?? "";
  assert.match(script, /A2A_LIFECYCLE_GUARD_BIN=\/work\/a2a-lifecycle-guard-bin/);
  assert.match(script, /error=a2a_runner_contract_violation command=git_\$\{1:-\}/);
  assert.match(script, /add\|commit\|push\|checkout\|switch\|reset\|merge\|rebase\|tag/);
  assert.match(script, /error=a2a_runner_contract_violation command=git_branch_mutation/);
  assert.match(script, /--show-current\|-v\|-vv/);
  assert.match(script, /error=a2a_runner_contract_violation command=gh_\$\{1:-\}_\$\{2:-\}/);
  assert.match(script, /"pr create"\|"pr merge"\|"issue close"\|"issue comment"/);
  assert.match(script, /export PATH="\$A2A_LIFECYCLE_GUARD_BIN:\$PATH"/);
  assert.match(script, /Your only job is to edit files in the repository checkout/);
  assert.match(script, /Do not create or switch branches/);
  assert.match(script, /Do not run git add, git commit, git push/);
  assert.match(script, /Do not run gh pr create/);
  assert.doesNotMatch(script, /Return Start \+ PR\/Done\/Block/);
});

test("Hermes patch profile accepts already-committed branch diffs as runner-visible changes", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
  });

  const script = config.commandScript ?? "";
  assert.match(script, /hermes_changes_visible_to_runner\(\)/);
  assert.match(script, /git status --porcelain/);
  assert.match(script, /git rev-parse --verify "origin\/\$A2A_RUNNER_BASE_BRANCH"/);
  assert.match(script, /git diff --quiet "origin\/\$A2A_RUNNER_BASE_BRANCH\.\.\.HEAD"/);
  assert.match(script, /notice=hermes_committed_changes_detected/);
  assert.match(script, /if ! hermes_changes_visible_to_runner; then/);
});

test("Hermes patch profile recovers nonzero agent exits when repository changes are visible", async () => {
  const config = await loadConfig({
    ...baseEnv,
    A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "hermes",
    A2A_DOCKER_RUNNER_TRUSTED_OPERATOR: "1",
  });

  const script = config.commandScript ?? "";
  assert.match(script, /notice=hermes_nonzero_with_visible_changes/);
  assert.match(script, /exit=\%s changes=present/);
  assert.match(script, /if hermes_changes_visible_to_runner; then/);
  assert.match(script, /else\n    printf 'error=hermes_agent_failed/);
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

test("loadConfig rejects contained subagent opt-in without a first-class patch profile", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_CONTAINED_SUBAGENTS_ENABLED: "1",
      A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "#!/usr/bin/env bash\ncodex exec hi\n",
    }),
    /contained subagents require a first-class A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE/,
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
    "/work/.hermes/.env": [
      "A2A_HERMES_MODEL=deepseek-v4-flash",
      "HERMES_MODEL=token = should-not-be-a-model",
      "MODEL=apiKey: should...el",
    ].join("\n"),
    "/work/.hermes/config.yaml": [
      "provider: openai",
      "model: gpt-5.5",
    ].join("\n"),
  }, { HERMES_HOME: "/work/.hermes" }), "openai/gpt-5.5");
  assert.equal(runResolverScript(resolver, {
    "/work/.hermes/.env": [
      "A2A_HERMES_MODEL=deepseek/deepseek-v4-flash",
      "HERMES_MODEL=secret : should-not-be-a-model",
      "MODEL=apikey=should-not-be-a-model",
    ].join("\n"),
    "/work/.hermes/config.yaml": "model: api-key: should...\n",
  }, { HERMES_HOME: "/work/.hermes" }), "");
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
      A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE: "llama",
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
    /Claude-in-Docker.*requires A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=claude-code/,
  );

  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["claude", "--print", "hello"] }),
    }),
    /Claude-in-Docker.*requires A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=claude-code/,
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
    /Claude credentials.*require A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=claude-code/,
  );
});

test("loadConfig rejects Claude-in-Docker even with the legacy opt-in flag", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_ALLOW_CLAUDE_IN_DOCKER: "1",
      A2A_DOCKER_RUNNER_PATCH_COMMAND_JSON: JSON.stringify({ argv: ["claude", "--print", "hello"] }),
    }),
    /requires A2A_DOCKER_RUNNER_PATCH_COMMAND_PROFILE=claude-code/,
  );
});

test("loadConfig rejects patch commands without an allowed agent executor", async () => {
  await assert.rejects(
    () => loadConfig({
      ...baseEnv,
      A2A_DOCKER_RUNNER_PATCH_COMMAND_SCRIPT: "#!/usr/bin/env bash\ngit status",
    }),
    /allowed Docker patch executor: OpenClaw, Hermes, Claude Code, or Codex/,
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

test("claude-code patch mode: normal non-fanout lane is agentic; deterministic and fanout stay explicit", () => {
  // The runner must carry normalized task metadata into the bridge message so
  // every implementation mode can parse repository and issue context.
  const defaultScript = buildClaudeCodePatchCommandScript({});
  assert.match(defaultScript, /export A2A_CLAUDE_CODE_PATCH_MODE=agentic\b/);
  assert.match(defaultScript, /export A2A_CLAUDE_CODE_TIMEOUT_SEC='3600'/);
  assert.doesNotMatch(defaultScript, /export A2A_CLAUDE_CODE_MAX_TURNS=/);
  assert.doesNotMatch(defaultScript, /export A2A_CLAUDE_CODE_PATCH_MAX_TURNS=/);
  assert.doesNotMatch(defaultScript, /export A2A_CLAUDE_CODE_DETERMINISTIC_MAX_TURNS=/);
  assert.doesNotMatch(defaultScript, /export A2A_CLAUDE_CODE_FANOUT_MAX_TURNS=/);
  assert.match(defaultScript, /\/work\/artifacts\/task\.json/);
  assert.match(defaultScript, /GitHub development assignment\\nRepository: %s\\nIssue: %s\\nIssue URL: %s/);
  assert.match(
    buildClaudeCodePatchCommandScript({ A2A_CLAUDE_CODE_TIMEOUT_SEC: "900" }),
    /export A2A_CLAUDE_CODE_TIMEOUT_SEC='900'/,
  );
  assert.match(
    buildClaudeCodePatchCommandScript({ A2A_CLAUDE_CODE_MAX_TURNS: "20" }),
    /export A2A_CLAUDE_CODE_MAX_TURNS='20'/,
  );
  assert.match(
    buildClaudeCodePatchCommandScript({ A2A_CLAUDE_CODE_PATCH_MAX_TURNS: "20" }),
    /export A2A_CLAUDE_CODE_PATCH_MAX_TURNS='20'/,
  );
  assert.match(
    buildClaudeCodePatchCommandScript({ A2A_CLAUDE_CODE_DETERMINISTIC_MAX_TURNS: "7" }),
    /export A2A_CLAUDE_CODE_DETERMINISTIC_MAX_TURNS='7'/,
  );
  assert.doesNotMatch(
    buildClaudeCodePatchCommandScript({ A2A_CLAUDE_CODE_MAX_TURNS: "not-a-number-with-secret-material" }),
    /not-a-number-with-secret-material|A2A_CLAUDE_CODE_MAX_TURNS=/,
  );
  // A non-"1" fanout flag stays on the normal agentic implementation lane.
  assert.match(
    buildClaudeCodePatchCommandScript({ A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED: "true" }),
    /export A2A_CLAUDE_CODE_PATCH_MODE=agentic\b/,
  );
  // Deterministic diff/apply and fanout are both explicit modes.
  assert.match(
    buildClaudeCodePatchCommandScript({ A2A_DOCKER_RUNNER_CLAUDE_CODE_PATCH_MODE: "single-shot" }),
    /export A2A_CLAUDE_CODE_PATCH_MODE=single-shot\b/,
  );
  assert.match(
    buildClaudeCodePatchCommandScript({ A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED: "1" }),
    /export A2A_CLAUDE_CODE_PATCH_MODE=fanout\b/,
  );
});

test("claude-code preflight projection exposes canonical defaults, explicit sources, and fanout cap without env contents", () => {
  const defaults = projectClaudeCodeTurnBudgets({});
  assert.equal(defaults.activePatchMode, "agentic");
  assert.deepEqual(defaults.analysis, { effectiveMaxTurns: 10, source: "canonical_default" });
  assert.deepEqual(defaults.agenticPatch, { effectiveMaxTurns: 40, source: "canonical_default" });
  assert.deepEqual(defaults.deterministicSingleShot, { effectiveMaxTurns: 6, source: "canonical_default" });
  assert.deepEqual(defaults.fanoutPatch, {
    effectiveMaxTurns: 40,
    source: "canonical_default",
    hardCap: 200,
    hardCapApplied: false,
  });

  const overridden = projectClaudeCodeTurnBudgets({
    A2A_CLAUDE_CODE_MAX_TURNS: "44",
    A2A_CLAUDE_CODE_DETERMINISTIC_MAX_TURNS: "8",
    A2A_CLAUDE_CODE_FANOUT_MAX_TURNS: "500",
    A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED: "1",
    GH_TOKEN: "must-not-be-projected",
  });
  assert.equal(overridden.activePatchMode, "fanout");
  assert.deepEqual(overridden.agenticPatch, {
    effectiveMaxTurns: 44,
    source: "explicit_override",
    overrideKey: "A2A_CLAUDE_CODE_MAX_TURNS",
  });
  assert.equal(overridden.deterministicSingleShot.effectiveMaxTurns, 8);
  assert.equal(overridden.fanoutPatch.effectiveMaxTurns, 200);
  assert.equal(overridden.fanoutPatch.hardCapApplied, true);
  assert.doesNotMatch(JSON.stringify(overridden), /must-not-be-projected|GH_TOKEN/);
});

test("contained sub-agents: claude-code enabled only when the fanout flag is 1 (Phase-2 WS4)", () => {
  // Default (flag off) — claude-code has no contained sub-agents.
  const off = loadContainedSubagentsConfig({}, "claude-code");
  assert.equal(off.enabled, false);
  assert.equal(off.maxCount, 0);
  // Opt-in via the fanout flag.
  const on = loadContainedSubagentsConfig({ A2A_DOCKER_RUNNER_CLAUDE_CODE_FANOUT_ENABLED: "1" }, "claude-code");
  assert.equal(on.enabled, true);
  assert.ok(on.maxCount >= 1 && on.maxCount <= 4);
  assert.ok(on.roles.includes("explorer"));
  // openclaw/hermes stay enabled-by-default regardless of the fanout flag (unchanged).
  assert.equal(loadContainedSubagentsConfig({}, "hermes").enabled, true);
  assert.equal(loadContainedSubagentsConfig({}, "openclaw").enabled, true);
});

test("failure log knobs default and parse from env (#1610)", async () => {
  const defaults = await loadConfig({});
  assert.equal(defaults.failureLogMaxBytes, 262144);
  assert.equal(defaults.failureLogKeep, 20);

  const tuned = await loadConfig({
    A2A_DOCKER_RUNNER_FAILURE_LOG_MAX_BYTES: "65536",
    A2A_DOCKER_RUNNER_FAILURE_LOG_KEEP: "5",
  });
  assert.equal(tuned.failureLogMaxBytes, 65536);
  assert.equal(tuned.failureLogKeep, 5);
});
