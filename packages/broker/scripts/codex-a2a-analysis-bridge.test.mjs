import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codexExecutionTelemetry } from "./lib/analysis-execution-telemetry.mjs";

const bridgePath = new URL("./codex-a2a-analysis-bridge.mjs", import.meta.url).pathname;
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

function bridgeArgs(message, model = "gpt-5.6-sol", effort = "high") {
  return [
    "agent", "--local", "--agent", "main",
    "--session-id", "a2a-codex-analysis",
    "--message", message,
    "--model", `openai-codex/${model}`,
    "--thinking", effort,
    "--timeout", "60",
    "--json",
  ];
}

test("Codex A2A analysis bridge exists and is executable JavaScript", () => {
  assert.equal(existsSync(bridgePath), true);
  const check = spawnSync(process.execPath, ["--check", bridgePath], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

for (const [model, effort] of [["gpt-5.6-sol", "high"], ["gpt-5.6-luna", "max"]]) {
test(`Codex A2A analysis bridge applies ${model}/${effort} and returns the shared envelope`, () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-a2a-bridge-test-"));
  const fakeCodex = join(dir, "fake-codex.mjs");
  const configDir = join(dir, "codex-dir");
  const argsPath = join(dir, "args.json");
  const envPath = join(dir, "env.json");
  try {
    mkdirSync(configDir);
    writeFileSync(join(configDir, "auth.json"), JSON.stringify(sourceAuth), { mode: 0o600 });
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const prompt = readFileSync(0, 'utf8');",
      "writeFileSync(process.env.CAPTURE_ARGS_PATH, JSON.stringify(args));",
      "writeFileSync(process.env.CAPTURE_ENV_PATH, JSON.stringify({ codexHome: process.env.CODEX_HOME, brokerSecret: process.env.BROKER_EDGE_SECRET, prefix: process.env.PREFIX, termuxVersion: process.env.TERMUX_VERSION, termuxExec: process.env.TERMUX_EXEC__PROC_SELF_EXE }));",
      "if (!prompt.includes('Do not modify files')) throw new Error('read-only prompt missing');",
      "const authPath = process.env.CODEX_HOME + '/auth.json';",
      "const auth = JSON.parse(readFileSync(authPath, 'utf8'));",
      "if (auth.tokens.refresh_token !== 'test-refresh-v1') throw new Error('ephemeral auth missing');",
      "auth.last_refresh = '2026-07-28T01:00:00Z';",
      "auth.tokens.access_token = 'test-access-v2';",
      "auth.tokens.id_token = 'test-id-v2';",
      "auth.tokens.refresh_token = 'test-refresh-v2';",
      "writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });",
      "const analysis = { status: 'done', summary: 'Codex bridge returned strict JSON', findings: ['Codex executed the source-only prompt'], risks: [], recommendations: ['keep the read-only sandbox'], evidenceRefs: ['embedded:codex-adapter-test'] };",
      "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'test' }));",
      "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(analysis) } }));",
    ].join("\n"));
    chmodSync(fakeCodex, 0o755);

    const result = spawnSync(bridgePath, bridgeArgs("Return JSON only. Payload JSON:\n" + JSON.stringify({ sourceOnly: true, noLive: true }), model, effort), {
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
    assert.equal(payload.actualRuntimeModel, model);
    assert.equal(payload.requestedThinking, effort);
    assert.equal(payload.modelInheritanceMode, "explicit");
    // #2403: the wrapper fingerprints itself and keeps the inner (claude) harness alongside.
    assert.equal(payload.harness.fingerprintVersion, "a2a.harness-fingerprint.v2");
    assert.equal(payload.harness.runtime, "codex");
    assert.equal(payload.harness.model, model);
    assert.match(payload.harness.bridgeFileSha256, /^[0-9a-f]{64}$/);
    assert.match(payload.harness.harnessFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(payload.harness.innerHarness?.runtime, "claude-code");
    assert.notEqual(payload.harness.harnessFingerprint, payload.harness.innerHarness?.harnessFingerprint);
    assert.equal(payload.completion?.marked, true);

    const args = JSON.parse(readFileSync(argsPath, "utf8"));
    assert.deepEqual(args.slice(0, 2), ["exec", "--skip-git-repo-check"]);
    assert.equal(args[args.indexOf("--model") + 1], model);
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.includes(`model_reasoning_effort="${effort}"`));

    const childEnv = JSON.parse(readFileSync(envPath, "utf8"));
    assert.equal(childEnv.brokerSecret, undefined);
    assert.equal(childEnv.prefix, "/data/data/com.termux/files/usr");
    assert.equal(childEnv.termuxVersion, "unit-test");
    assert.equal(childEnv.termuxExec, "/data/data/com.termux/files/usr/bin/node");
    assert.notEqual(childEnv.codexHome, configDir);
    assert.equal(existsSync(childEnv.codexHome), false, "ephemeral CODEX_HOME should be removed after execution");
    const persistedAuth = JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8"));
    assert.equal(persistedAuth.last_refresh, "2026-07-28T01:00:00Z");
    assert.equal(persistedAuth.tokens.access_token, "test-access-v2");
    assert.equal(persistedAuth.tokens.id_token, "test-id-v2");
    assert.equal(persistedAuth.tokens.refresh_token, "test-refresh-v2");
    assert.equal(persistedAuth.tokens.account_id, "test-account");
    assert.equal(statSync(join(configDir, "auth.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
}

test("Codex A2A analysis bridge rejects incompatible auth write-back", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-a2a-bridge-invalid-refresh-"));
  const fakeCodex = join(dir, "fake-codex.mjs");
  const configDir = join(dir, "codex-dir");
  try {
    mkdirSync(configDir);
    writeFileSync(join(configDir, "auth.json"), JSON.stringify(sourceAuth), { mode: 0o600 });
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const authPath = process.env.CODEX_HOME + '/auth.json';",
      "const auth = JSON.parse(readFileSync(authPath, 'utf8'));",
      "auth.tokens.account_id = 'different-account';",
      "writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });",
      "const analysis = { status: 'done', summary: 'invalid refresh', findings: [], risks: [], recommendations: [], evidenceRefs: [] };",
      "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(analysis) } }));",
    ].join("\n"));
    chmodSync(fakeCodex, 0o755);

    const result = spawnSync(bridgePath, bridgeArgs("Return JSON only. Payload JSON:\n{}"), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CODEX_BIN: fakeCodex,
        A2A_CODEX_ANALYSIS_CONFIG_DIR: configDir,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /changed protected token field account_id/);
    assert.deepEqual(JSON.parse(readFileSync(join(configDir, "auth.json"), "utf8")), sourceAuth);
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

test("Codex failure excerpt keeps stdout JSON error events when stderr only carries a warning (#2406)", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-a2a-bridge-turn-failed-"));
  const fakeCodex = join(dir, "fake-codex.mjs");
  const configDir = join(dir, "codex-dir");
  try {
    mkdirSync(configDir);
    writeFileSync(join(configDir, "auth.json"), JSON.stringify(sourceAuth), { mode: 0o600 });
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { readFileSync } from 'node:fs';",
      "readFileSync(0, 'utf8');",
      "process.stderr.write('WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir \"/tmp\"\\n');",
      "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'test' }));",
      "console.log(JSON.stringify({ type: 'turn.failed', error: { message: '{\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The requested model is not supported.\"}}' } }));",
      "process.exit(1);",
    ].join("\n"));
    chmodSync(fakeCodex, 0o755);

    const result = spawnSync(bridgePath, bridgeArgs("Payload JSON:\n{}"), {
      encoding: "utf8",
      env: { ...process.env, A2A_CODEX_BIN: fakeCodex, A2A_CODEX_ANALYSIS_CONFIG_DIR: configDir },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Codex exited with 1/);
    assert.match(result.stderr, /turn\.failed: .*The requested model is not supported/);
    assert.match(result.stderr, /stderr: WARNING: proceeding/);
    assert.match(result.stderr, /stdout: .*thread\.started/);
    assert.ok(result.stderr.indexOf("turn.failed:") < result.stderr.indexOf("stderr: WARNING"), "stdout error events come first");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #2533: the failure excerpt cuts stderr by prefix, stdout by TAIL and the
// whole message at 4000 units; none of these cuts may split a surrogate pair
// (a lone half reaches stderr as U+FFFD).
function runCodexAdapterFailure(stderrText, stdoutText) {
  const dir = mkdtempSync(join(tmpdir(), "codex-a2a-bridge-utf16-"));
  const fakeCodex = join(dir, "fake-codex.mjs");
  const configDir = join(dir, "codex-dir");
  try {
    mkdirSync(configDir);
    writeFileSync(join(configDir, "auth.json"), JSON.stringify(sourceAuth), { mode: 0o600 });
    writeFileSync(fakeCodex, [
      "#!/usr/bin/env node",
      "import { readFileSync } from 'node:fs';",
      "readFileSync(0, 'utf8');",
      `process.stderr.write(${JSON.stringify(stderrText)});`,
      `process.stdout.write(${JSON.stringify(stdoutText)});`,
      "process.exitCode = 1;",
    ].join("\n"));
    chmodSync(fakeCodex, 0o755);
    return spawnSync(bridgePath, ["-p", "analyze"], {
      encoding: "utf8",
      env: { ...process.env, A2A_CODEX_ADAPTER_MODE: "1", A2A_CODEX_BIN: fakeCodex, A2A_CODEX_ANALYSIS_CONFIG_DIR: configDir },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CODEX_LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test("#2533 Codex failure excerpt: stderr prefix cut and stdout tail cut never split a surrogate pair", () => {
  // stderr: index 1999 is a high surrogate (prefix cut at 2000).
  // stdout: 2001 units, so the 2000-unit tail would start on a low surrogate.
  const result = runCodexAdapterFailure(`${"W".repeat(1999)}😀z`, `😀${"s".repeat(1999)}`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Codex exited with 1/);
  assert.equal(result.stderr.includes("�"), false, "no replacement character from a split pair");
  assert.equal(CODEX_LONE_SURROGATE.test(result.stderr), false);
  assert.ok(result.stderr.includes(`stderr: ${"W".repeat(1999)}\nstdout: sss`), "stderr backs off one unit; the stdout tail drops the lone low half");
});

test("#2533 Codex redactSecrets 4000-unit cap never splits a surrogate pair", () => {
  // Neither stream cut splits (stderr is 1999 ASCII units, the stdout tail
  // starts on a high surrogate), so only the cap is exercised: the excerpt is
  // 4016 units, and in "Codex exited with 1: <excerpt>" the 4000-unit cap
  // lands on a high surrogate.
  const result = runCodexAdapterFailure("W".repeat(1999), "😀".repeat(1500));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Codex exited with 1/);
  assert.equal(result.stderr.includes("�"), false, "no replacement character from a split pair");
  assert.equal(CODEX_LONE_SURROGATE.test(result.stderr), false);
  const message = result.stderr.replace(/\n$/, "");
  assert.ok(message.length <= 4000, `message length ${message.length}`);
});

// #2533 review item 6: an error event with no message is quoted as its JSON,
// cut to 500 units; the cut must not split a surrogate pair.
test("#2533 Codex error-event JSON cut never splits a surrogate pair", () => {
  // '{"type":"error","pad":"' is 23 units; 476 more puts the emoji's high half at 499.
  const eventLine = JSON.stringify({ type: "error", pad: `${"p".repeat(476)}😀tail` });
  assert.equal(eventLine.charCodeAt(499) >= 0xd800 && eventLine.charCodeAt(499) <= 0xdbff, true, "fixture straddles the 500-unit cut");
  const result = runCodexAdapterFailure("", `${eventLine}\n`);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr.includes("\uFFFD"), false, "no replacement character from a split pair");
  assert.equal(CODEX_LONE_SURROGATE.test(result.stderr), false);
  assert.ok(result.stderr.includes(`error: ${eventLine.slice(0, 499)}\n`), "backs off exactly the split pair");
});

// ---------------------------------------------------------------------------
// #2518: usage telemetry. Fixture lines follow the codex-cli 0.159
// `codex exec --json` event schema (thread.started / turn.started /
// item.completed / turn.completed{usage} / turn.failed{error}); usage fields
// are input_tokens (includes cached), cached_input_tokens,
// cache_write_input_tokens, output_tokens (includes reasoning),
// reasoning_output_tokens. The stream carries no price.
// ---------------------------------------------------------------------------
const CODEX_USAGE_TURN = {
  type: "turn.completed",
  usage: { input_tokens: 24763, cached_input_tokens: 24448, cache_write_input_tokens: 0, output_tokens: 122, reasoning_output_tokens: 64 },
};

test("#2518 codexExecutionTelemetry maps exec JSONL usage onto the telemetry contract (uncached input, no cost)", () => {
  const stdout = [
    { type: "thread.started", thread_id: "t-1" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "i0", type: "reasoning", text: "thinking" } },
    { type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls", aggregated_output: "", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "i2", type: "agent_message", text: "{}" } },
    CODEX_USAGE_TURN,
    { type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 0 } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\nnot json\n";
  assert.deepEqual(codexExecutionTelemetry(stdout, 1234.7), {
    schemaVersion: "a2a.analysis-execution-telemetry.v1",
    source: "codex_exec_jsonl",
    elapsedMs: 1234,
    inputTokens: (24763 - 24448) + (1000 - 600 - 100),
    outputTokens: 172,
    cacheReadInputTokens: 24448 + 600,
    cacheCreationInputTokens: 100,
    toolCalls: 1,
  });
});

test("#2518 codexExecutionTelemetry omits tokens when no turn completed (turn.failed carries no usage)", () => {
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "t-2" }),
    JSON.stringify({ type: "turn.failed", error: { message: "The requested model is not supported." } }),
  ].join("\n");
  const telemetry = codexExecutionTelemetry(stdout, 50);
  assert.deepEqual(telemetry, { schemaVersion: "a2a.analysis-execution-telemetry.v1", source: "codex_exec_jsonl", elapsedMs: 50, toolCalls: 0 });
  assert.equal("costUsd" in telemetry, false);
  // Hostile numbers never become negative or fractional tokens.
  const hostile = codexExecutionTelemetry(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 99, output_tokens: -5 } }), 0);
  assert.equal(hostile.inputTokens, 0);
  assert.equal(hostile.cacheReadInputTokens, 10);
  assert.equal(hostile.outputTokens, 0);
});

function writeUsageFakeCodex(dir, lines, exitCode = 0) {
  const fakeCodex = join(dir, "fake-codex.mjs");
  writeFileSync(fakeCodex, [
    "#!/usr/bin/env node",
    "import { readFileSync } from 'node:fs';",
    "readFileSync(0, 'utf8');",
    ...lines.map((line) => `console.log(${JSON.stringify(typeof line === "string" ? line : JSON.stringify(line))});`),
    `process.exitCode = ${exitCode};`,
  ].join("\n"));
  chmodSync(fakeCodex, 0o755);
  return fakeCodex;
}

function runCodexBridge(dir, fakeCodex) {
  const configDir = join(dir, "codex-dir");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "auth.json"), JSON.stringify(sourceAuth), { mode: 0o600 });
  return spawnSync(bridgePath, bridgeArgs("Return JSON only. Payload JSON:\n" + JSON.stringify({ sourceOnly: true, noLive: true })), {
    encoding: "utf8",
    env: { ...process.env, A2A_CODEX_BIN: fakeCodex, A2A_CODEX_ANALYSIS_CONFIG_DIR: configDir },
  });
}

function bridgeErrorRecords(stderr) {
  return stderr.split("\n").filter((line) => line.startsWith("A2A_BRIDGE_ERROR=")).map((line) => JSON.parse(line.slice("A2A_BRIDGE_ERROR=".length)));
}

const CODEX_ANALYSIS = { status: "done", summary: "usage telemetry", findings: ["f"], risks: [], recommendations: [], evidenceRefs: ["embedded:codex-usage-test"] };

test("#2518 Codex bridge success carries the exec usage as executionTelemetry (tokens, cost unknown)", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-a2a-bridge-usage-"));
  try {
    const fakeCodex = writeUsageFakeCodex(dir, [
      { type: "thread.started", thread_id: "t" },
      { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(CODEX_ANALYSIS) } },
      CODEX_USAGE_TURN,
    ]);
    const result = runCodexBridge(dir, fakeCodex);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(JSON.parse(result.stdout).payloads[0].text);
    assert.equal(payload.executionTelemetry.source, "codex_exec_jsonl");
    assert.equal(payload.executionTelemetry.inputTokens, 315);
    assert.equal(payload.executionTelemetry.cacheReadInputTokens, 24448);
    assert.equal(payload.executionTelemetry.outputTokens, 122);
    assert.equal(payload.executionTelemetry.costUsd, undefined, "codex exposes no price");
    assert.ok(Number.isInteger(payload.executionTelemetry.elapsedMs));
    assert.equal(bridgeErrorRecords(result.stderr).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2518 Codex bridge failure carries the spent usage on one structured A2A_BRIDGE_ERROR line", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-a2a-bridge-usage-fail-"));
  try {
    const fakeCodex = writeUsageFakeCodex(dir, [
      { type: "thread.started", thread_id: "t" },
      CODEX_USAGE_TURN,
      { type: "turn.failed", error: { message: "stream disconnected before completion" } },
    ], 1);
    const result = runCodexBridge(dir, fakeCodex);
    assert.notEqual(result.status, 0);
    const records = bridgeErrorRecords(result.stderr);
    assert.equal(records.length, 1, result.stderr);
    assert.equal(records[0].code, "analysis_bridge_provider_failure");
    assert.equal(records[0].adapterClass, "codex");
    assert.equal(records[0].stage, "invoke");
    assert.equal(records[0].executionTelemetry.source, "codex_exec_jsonl");
    assert.equal(records[0].executionTelemetry.inputTokens, 315);
    assert.equal(records[0].executionTelemetry.outputTokens, 122);
    assert.match(result.stderr, /Codex exited with 1/);
    assert.match(result.stderr, /turn\.failed: stream disconnected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#2518 Codex bridge keeps the shared core's invalid-JSON classification and adds the usage to it", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-a2a-bridge-usage-badjson-"));
  try {
    const fakeCodex = writeUsageFakeCodex(dir, [
      { type: "item.completed", item: { type: "agent_message", text: "no json here at all" } },
      CODEX_USAGE_TURN,
    ]);
    const result = runCodexBridge(dir, fakeCodex);
    assert.notEqual(result.status, 0);
    const records = bridgeErrorRecords(result.stderr);
    assert.equal(records.length, 1, result.stderr);
    assert.equal(records[0].code, "analysis_bridge_invalid_json");
    assert.equal(records[0].adapterClass, "claude_code", "the inner record is kept as is");
    assert.equal(records[0].executionTelemetry.inputTokens, 315);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
