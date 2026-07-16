import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const bridgePath = new URL("./codex-a2a-analysis-bridge.mjs", import.meta.url).pathname;

function bridgeArgs(message) {
  return [
    "agent", "--local", "--agent", "main",
    "--session-id", "a2a-codex-analysis",
    "--message", message,
    "--model", "openai-codex/gpt-5.6-sol",
    "--thinking", "high",
    "--timeout", "60",
    "--json",
  ];
}

test("Codex A2A analysis bridge exists and is executable JavaScript", () => {
  assert.equal(existsSync(bridgePath), true);
  const check = spawnSync(process.execPath, ["--check", bridgePath], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("Codex A2A analysis bridge applies model/reasoning and returns the shared envelope", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-a2a-bridge-test-"));
  const fakeCodex = join(dir, "fake-codex.mjs");
  const configDir = join(dir, "codex-dir");
  const argsPath = join(dir, "args.json");
  const envPath = join(dir, "env.json");
  try {
    mkdirSync(configDir);
    writeFileSync(join(configDir, "auth.json"), JSON.stringify({ test: true }), { mode: 0o600 });
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const prompt = readFileSync(0, 'utf8');",
      "writeFileSync(process.env.CAPTURE_ARGS_PATH, JSON.stringify(args));",
      "writeFileSync(process.env.CAPTURE_ENV_PATH, JSON.stringify({ codexHome: process.env.CODEX_HOME, brokerSecret: process.env.BROKER_EDGE_SECRET, prefix: process.env.PREFIX, termuxVersion: process.env.TERMUX_VERSION, termuxExec: process.env.TERMUX_EXEC__PROC_SELF_EXE }));",
      "if (!prompt.includes('Do not modify files')) throw new Error('read-only prompt missing');",
      "if (!readFileSync(process.env.CODEX_HOME + '/auth.json', 'utf8').includes('test')) throw new Error('ephemeral auth missing');",
      "const analysis = { status: 'done', summary: 'Codex bridge returned strict JSON', findings: ['Codex executed the source-only prompt'], risks: [], recommendations: ['keep the read-only sandbox'], evidenceRefs: ['embedded:codex-adapter-test'] };",
      "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'test' }));",
      "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(analysis) } }));",
    ].join("\n"));
    chmodSync(fakeCodex, 0o755);

    const result = spawnSync(bridgePath, bridgeArgs("Return JSON only. Payload JSON:\n" + JSON.stringify({ sourceOnly: true, noLive: true })), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CODEX_BIN: fakeCodex,
        A2A_CODEX_ANALYSIS_CONFIG_DIR: configDir,
        CAPTURE_ARGS_PATH: argsPath,
        CAPTURE_ENV_PATH: envPath,
        BROKER_EDGE_SECRET: "must-not-reach-codex",
        PREFIX: "/data/data/com.termux/files/usr",
        TERMUX_VERSION: "unit-test",
        TERMUX_EXEC__PROC_SELF_EXE: "/data/data/com.termux/files/usr/bin/node",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0].text);
    assert.equal(payload.status, "done");
    assert.equal(payload.bridgeAdapter, "codex");
    assert.equal(payload.bridgeContractVersion, "codex-a2a-analysis.v1");
    assert.equal(payload.actualRuntimeModel, "gpt-5.6-sol");
    assert.equal(payload.requestedThinking, "high");
    assert.equal(payload.modelInheritanceMode, "explicit");

    const args = JSON.parse(readFileSync(argsPath, "utf8"));
    assert.deepEqual(args.slice(0, 2), ["exec", "--skip-git-repo-check"]);
    assert.equal(args[args.indexOf("--model") + 1], "gpt-5.6-sol");
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.includes('model_reasoning_effort="high"'));

    const childEnv = JSON.parse(readFileSync(envPath, "utf8"));
    assert.equal(childEnv.brokerSecret, undefined);
    assert.equal(childEnv.prefix, "/data/data/com.termux/files/usr");
    assert.equal(childEnv.termuxVersion, "unit-test");
    assert.equal(childEnv.termuxExec, "/data/data/com.termux/files/usr/bin/node");
    assert.notEqual(childEnv.codexHome, configDir);
    assert.equal(existsSync(childEnv.codexHome), false, "ephemeral CODEX_HOME should be removed after execution");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex A2A analysis bridge fails closed without minimal auth", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-a2a-bridge-no-auth-"));
  try {
    const result = spawnSync(bridgePath, bridgeArgs("Payload JSON:\n{}"), {
      encoding: "utf8",
      env: { ...process.env, A2A_CODEX_ANALYSIS_CONFIG_DIR: dir },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing auth\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
