import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CLAUDE_MODEL_TELEMETRY_CONTRACT } from "./lib/claude-model-telemetry.mjs";

const bridgePath = new URL("./claude-a2a-analysis-bridge.mjs", import.meta.url).pathname;
const patchBridgePath = new URL("./claude-a2a-patch-bridge.mjs", import.meta.url).pathname;

function bridgeArgs(message) {
  return [
    "agent",
    "--local",
    "--agent", "main",
    "--session-id", "a2a-claude-code-analysis",
    "--message", message,
    "--model", "claude-code/default",
    "--thinking", "low",
    "--timeout", "60",
    "--json",
  ];
}

function sha256Prefix(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function signedSnapshotFixture(overrides = {}) {
  const content = overrides.content ?? "# signed Claude bridge source\nconst claudeSnapshotGrounding = true;\n";
  return {
    schemaVersion: "a2a.retrieval.snapshot.v1",
    canonicalization: "rfc8785-jcs-v1",
    source: "github",
    repo: "jinwon-int/a2a-nexus",
    requestedRef: "838e58a7587d0f352cc1d19e6a0c5edae9903251",
    resolvedRef: "838e58a7587d0f352cc1d19e6a0c5edae9903251",
    path: "packages/broker/README.md",
    fetchedAt: "2026-07-06T00:00:00.000Z",
    byteLen: Buffer.byteLength(content, "utf8"),
    contentHash: sha256Prefix(content),
    content,
    signature: { protected: "signed-header", signature: "signed-body" },
    ...overrides,
  };
}

test("Claude Code A2A analysis bridge exists and is executable JavaScript", () => {
  assert.equal(existsSync(bridgePath), true, "bridge script should exist");
  const check = spawnSync(process.execPath, ["--check", bridgePath], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("both Claude bridges consume one shared model-telemetry contract", () => {
  for (const path of [bridgePath, patchBridgePath]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /from "\.\/lib\/claude-model-telemetry\.mjs"/);
    assert.match(source, /\battachClaudeModelTelemetry\(/);
    assert.match(source, /\bclaudeInvocationModelTelemetry\(/);
  }
  assert.deepEqual(CLAUDE_MODEL_TELEMETRY_CONTRACT.fields, [
    "bridgeAdapter",
    "requestedModel",
    "requestedThinking",
    "actualRuntimeModel",
    "modelInheritanceMode",
    "claudeModelArgumentApplied",
    "modelInheritanceNote",
  ]);
});

test("Claude Code A2A analysis bridge calls claude -p and returns OpenClaw envelope", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-bridge-test-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const argsPath = join(tempDir, "claude-args.json");
  const promptPath = join(tempDir, "claude-prompt.txt");

  try {
    writeFileSync(fakeClaudePath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "writeFileSync(process.env.CAPTURE_ARGS_PATH, JSON.stringify(args));",
      "const promptIndex = args.indexOf('-p');",
      "if (promptIndex < 0) throw new Error('expected claude -p prompt');",
      "const prompt = args[promptIndex + 1];",
      "writeFileSync(process.env.CAPTURE_PROMPT_PATH, prompt);",
      "if (args[args.indexOf('--output-format') + 1] !== 'json') throw new Error('expected --output-format json');",
      "if (args[args.indexOf('--max-turns') + 1] !== '3') throw new Error('expected max turns env override');",
      "if (!prompt.includes('Return JSON only')) throw new Error('strict JSON instruction missing');",
      "if (!prompt.includes('Do not modify files')) throw new Error('read-only instruction missing');",
      "if (!prompt.includes('sourceOnly')) throw new Error('task payload missing from prompt');",
      "const analysis = {",
      "  status: 'done',",
      "  summary: 'Claude adapter returned strict analysis JSON',",
      "  findings: ['claude -p received the broker-packaged task prompt'],",
      "  risks: ['non-interactive Claude auth must be verified before live switch'],",
      "  recommendations: ['use this bridge behind the existing A2A worker handler contract'],",
      "  evidenceRefs: ['embedded:claude-code-adapter-test']",
      "};",
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(analysis), num_turns: 2, duration_ms: 1234, total_cost_usd: 0.012, usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10 } }));",
      "",
    ].join("\n"));
    chmodSync(fakeClaudePath, 0o755);

    const message = [
      "You are A2A worker workeralpha. Complete this read-only Claude Code adapter analysis task.",
      "Payload JSON:\n" + JSON.stringify({ mode: "analysis-only", noLive: true, sourceOnly: true }),
    ].join("\n\n");

    const result = spawnSync(bridgePath, bridgeArgs(message), {
      encoding: "utf8",
      env: {
        ...process.env,
        // Hermetic: a worker host sets these for real, and this case asserts the
        // *unpinned* default (no --model). Inheriting them made the assertion
        // depend on where the suite happened to run.
        A2A_CLAUDE_MODEL: "",
        A2A_CLAUDE_EFFORT: "",
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_CLAUDE_CODE_MAX_TURNS: "3",
        CAPTURE_ARGS_PATH: argsPath,
        CAPTURE_PROMPT_PATH: promptPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.ok(Array.isArray(envelope.payloads));
    const payload = JSON.parse(envelope.payloads[0]?.text);
    assert.equal(payload.status, "done");
    assert.equal(payload.summary, "Claude adapter returned strict analysis JSON");
    assert.deepEqual(payload.evidenceRefs, ["embedded:claude-code-adapter-test"]);
    assert.equal(payload.bridgeAdapter, "claude_code");
    assert.equal(payload.bridgeContractVersion, "claude-a2a-analysis.v1");
    assert.equal(payload.requestedModel, "claude-code/default");
    assert.equal(payload.requestedThinking, "low");
    assert.equal(payload.actualRuntimeModel, undefined);
    assert.equal(payload.modelInheritanceMode, "metadata_only");
    assert.equal(payload.claudeModelArgumentApplied, false);
    assert.match(payload.modelInheritanceNote, /did not pass --model.*actual runtime model is unknown/);
    assert.deepEqual(payload.executionTelemetry, {
      schemaVersion: "a2a.analysis-execution-telemetry.v1",
      source: "claude_cli_envelope",
      elapsedMs: 1234,
      modelRequests: 2,
      inputTokens: 100,
      outputTokens: 40,
      cacheReadInputTokens: 10,
      costUsd: 0.012,
    });

    const args = JSON.parse(readFileSync(argsPath, "utf8"));
    assert.deepEqual(args.slice(0, 2), ["-p", readFileSync(promptPath, "utf8")]);
    assert.equal(args[args.indexOf("--allowedTools") + 1], "Read Glob Grep");
    assert.equal(args[args.indexOf("--disallowedTools") + 1], "Bash Edit Write NotebookEdit WebFetch WebSearch");
    assert.equal(args.includes("--model"), false, "Claude bridge should not pass A2A worker model as a raw Claude --model value");
    assert.match(readFileSync(promptPath, "utf8"), /Claude Code CLI-backed A2A analysis bridge/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Claude Code A2A analysis bridge injects signed retrieval snapshots without widening tool policy (#1378 K2 wave2)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-bridge-snapshot-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const argsPath = join(tempDir, "claude-args.json");
  const promptPath = join(tempDir, "claude-prompt.txt");
  const payloadPath = join(tempDir, "payload.json");
  const snapshot = signedSnapshotFixture();

  try {
    writeFileSync(payloadPath, JSON.stringify({
      mode: "analysis-only",
      noLive: true,
      sourceOnly: true,
      sourceBundle: { files: [] },
      sourceProjectionPolicy: { requiredPaths: ["packages/broker/README.md"] },
      retrievalSnapshots: [snapshot],
    }));
    writeFileSync(fakeClaudePath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "writeFileSync(process.env.CAPTURE_ARGS_PATH, JSON.stringify(args));",
      "const prompt = args[args.indexOf('-p') + 1];",
      "writeFileSync(process.env.CAPTURE_PROMPT_PATH, prompt);",
      "if (!prompt.includes('<untrusted_external_data ')) throw new Error('untrusted snapshot wrapper missing from Claude prompt');",
      "if (!prompt.includes('packages/broker/README.md')) throw new Error('snapshot path missing from Claude prompt');",
      "if (!prompt.includes('claudeSnapshotGrounding')) throw new Error('snapshot content missing from Claude prompt');",
      "const analysis = { status: 'done', summary: 'snapshot projected into Claude prompt', findings: ['snapshot source consumed'], risks: [], recommendations: ['keep Read Glob Grep only'], evidenceRefs: ['jinwon-int/a2a-nexus:packages/broker/README.md'] };",
      "console.log(JSON.stringify({ type: 'result', result: JSON.stringify(analysis) }));",
      "",
    ].join("\n"));
    chmodSync(fakeClaudePath, 0o755);

    const result = spawnSync(bridgePath, bridgeArgs("Payload JSON:\n" + JSON.stringify({ mode: "analysis-only", noLive: true, sourceOnly: true })), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_CLAUDE_CODE_MAX_TURNS: "3",
        A2A_ANALYSIS_PAYLOAD_FILE: payloadPath,
        A2A_CLAUDE_CODE_ALLOWED_TOOLS: "Bash WebFetch WebSearch",
        CAPTURE_ARGS_PATH: argsPath,
        CAPTURE_PROMPT_PATH: promptPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0]?.text);
    assert.equal(payload.status, "done");
    assert.equal(payload.summary, "snapshot projected into Claude prompt");
    const args = JSON.parse(readFileSync(argsPath, "utf8"));
    assert.equal(args[args.indexOf("--allowedTools") + 1], "Read Glob Grep");
    assert.equal(args[args.indexOf("--disallowedTools") + 1], "Bash Edit Write NotebookEdit WebFetch WebSearch");
    assert.match(readFileSync(promptPath, "utf8"), /<untrusted_external_data /);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Claude Code A2A analysis bridge does not pass broker/API secret env vars to child claude", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-bridge-env-whitelist-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const envCapturePath = join(tempDir, "child-env.json");
  try {
    writeFileSync(fakeClaudePath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.CAPTURE_ENV_PATH, JSON.stringify(process.env));",
      "const analysis = { status: 'done', summary: 'env captured', findings: [], risks: [], recommendations: [], evidenceRefs: [] };",
      "console.log(JSON.stringify({ type: 'result', result: JSON.stringify(analysis) }));",
      "",
    ].join("\n"));
    chmodSync(fakeClaudePath, 0o755);
    const result = spawnSync(bridgePath, bridgeArgs("Payload JSON:\n" + JSON.stringify({ mode: "analysis-only" })), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        CAPTURE_ENV_PATH: envCapturePath,
        EDGE_SECRET: "edge-secret-must-not-reach-child",
        A2A_EDGE_SECRET: "a2a-edge-secret-must-not-reach-child",
        GITHUB_TOKEN: "github-token-must-not-reach-child",
        Authorization: "Bearer must-not-reach-child",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const childEnv = JSON.parse(readFileSync(envCapturePath, "utf8"));
    assert.equal(childEnv.EDGE_SECRET, undefined);
    assert.equal(childEnv.A2A_EDGE_SECRET, undefined);
    assert.equal(childEnv.GITHUB_TOKEN, undefined);
    assert.equal(childEnv.Authorization, undefined);
    assert.equal(childEnv.CAPTURE_ENV_PATH, envCapturePath, "test capture env remains available");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Claude Code A2A analysis bridge extracts analysis JSON from Claude message.content text", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-bridge-message-content-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  try {
    writeFileSync(fakeClaudePath, [
      "#!/usr/bin/env node",
      "const analysis = {",
      "  status: 'done',",
      "  summary: 'Claude nested message content carried strict JSON',",
      "  findings: ['nested content parsed'],",
      "  risks: [],",
      "  recommendations: ['keep Claude Code output traversal recursive'],",
      "  evidenceRefs: ['claude-code:message.content']",
      "};",
      "console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(analysis) }] } }));",
      "",
    ].join("\n"));
    chmodSync(fakeClaudePath, 0o755);
    const message = "Payload JSON:\n" + JSON.stringify({ mode: "analysis-only", noLive: true, sourceOnly: true });
    const result = spawnSync(bridgePath, bridgeArgs(message), {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0]?.text);
    assert.equal(payload.status, "done");
    assert.equal(payload.summary, "Claude nested message content carried strict JSON");
    assert.deepEqual(payload.findings, ["nested content parsed"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Claude Code A2A analysis bridge recovers substantive Claude prose result", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-bridge-prose-result-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  try {
    writeFileSync(fakeClaudePath, [
      "#!/usr/bin/env node",
      "const prose = '서윤패밀리는 내부 운영 커널로 수렴하고 진원인터내셔널은 HUG 신용관리 증거 패킷부터 제품화해야 합니다. 근거: A2A evidence lane과 승인 경계가 이미 강점입니다.';",
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: prose, session_id: 'claude-session-123' }));",
      "",
    ].join("\n"));
    chmodSync(fakeClaudePath, 0o755);
    const message = "Payload JSON:\n" + JSON.stringify({ mode: "analysis-only", noLive: true, sourceOnly: true });
    const result = spawnSync(bridgePath, bridgeArgs(message), {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0]?.text);
    assert.equal(payload.status, "done");
    assert.match(payload.summary, /서윤패밀리/);
    assert.deepEqual(payload.findings, [
      "서윤패밀리는 내부 운영 커널로 수렴하고 진원인터내셔널은 HUG 신용관리 증거 패킷부터 제품화해야 합니다. 근거: A2A evidence lane과 승인 경계가 이미 강점입니다.",
    ]);
    assert.equal(payload.recoverySource, "claude_result_text");
    assert.deepEqual(payload.evidenceRefs, ["claude-code:result"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Claude Code A2A analysis bridge fails closed on generic Claude JSON", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-bridge-generic-json-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  try {
    writeFileSync(fakeClaudePath, [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ type: 'result', result: JSON.stringify({ error: 'auth failed' }) }));",
      "",
    ].join("\n"));
    chmodSync(fakeClaudePath, 0o755);
    const message = "Payload JSON:\n" + JSON.stringify({ mode: "analysis-only", noLive: true, sourceOnly: true });
    const result = spawnSync(bridgePath, bridgeArgs(message), {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid Claude analysis JSON schema|valid analysis JSON/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Issue #1129 — process-tree timeout / session isolation tests
// ---------------------------------------------------------------------------

test("timeout kills the whole child process group (grandchildren do not outlive the bridge)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-tree-kill-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const grandchildPidFile = join(tempDir, "grandchild.pid");
  try {
    // This fake claude spawns a background child that writes its PID to a file
    // and then sleeps. If the bridge only kills the direct child and not the
    // process group, the grandchild outlives the bridge.
    writeFileSync(fakeClaudePath, [
      "#!/usr/bin/env node",
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const pidFile = process.env.GRANDCHILD_PID_FILE;",
      "// Spawn a child that writes its PID and sleeps for a long time.",
      "const gc = spawn('sh', ['-c', 'echo $$ > ' + pidFile + '; sleep 60'], { stdio: 'ignore' });",
      "// Direct child waits forever (will be killed by bridge timeout).",
      "setTimeout(() => {}, 60000);",
    ].join("\n"));
    chmodSync(fakeClaudePath, 0o755);

    const message = "Payload JSON:\n" + JSON.stringify({ mode: "analysis-only", noLive: true });
    const result = spawnSync(bridgePath, [
      "agent",
      "--local",
      "--agent", "main",
      "--session-id", "a2a-tree-kill-test",
      "--message", message,
      "--model", "claude-code/default",
      "--thinking", "low",
      "--timeout", "2",
      "--json",
    ], {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath, GRANDCHILD_PID_FILE: grandchildPidFile },
    });

    // Bridge must exit non-zero on timeout.
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /timed out|timeout/i, "bridge should report a timeout");

    // If the grandchild wrote its PID, check that the process is dead.
    if (existsSync(grandchildPidFile)) {
      const pid = Number(readFileSync(grandchildPidFile, "utf8").trim());
      if (pid > 0) {
        // Signal 0 checks if the process exists (doesn't actually send a signal).
        try {
          process.kill(pid, 0);
          assert.fail("grandchild process " + pid + " survived the bridge timeout — process tree not killed");
        } catch {
          // Expected: process does not exist (ESRCH).
        }
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("session-scoped workspace uses session-id to isolate task sessions", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-session-scope-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const cwdCaptureA = join(tempDir, "cwd-session-a.txt");
  const cwdCaptureB = join(tempDir, "cwd-session-b.txt");
  try {
    // Fake claude that just records its cwd and exits.
    writeFileSync(fakeClaudePath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.CAPTURE_CWD_PATH, process.cwd());",
      "const analysis = {",
      "  status: 'done',",
      "  summary: 'session scoping test',",
      "  findings: [],",
      "  risks: [],",
      "  recommendations: [],",
      "  evidenceRefs: []",
      "};",
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(analysis) }));",
    ].join("\n"));
    chmodSync(fakeClaudePath, 0o755);

    const message = "Payload JSON:\n" + JSON.stringify({ mode: "analysis-only" });

    // Session A: explicit session-id "task-alpha"
    const resultA = spawnSync(bridgePath, [
      "agent",
      "--local",
      "--agent", "main",
      "--session-id", "task-alpha",
      "--message", message,
      "--model", "claude-code/default",
      "--thinking", "low",
      "--timeout", "60",
      "--json",
    ], {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath, CAPTURE_CWD_PATH: cwdCaptureA },
    });
    assert.equal(resultA.status, 0, resultA.stderr);

    // Session B: explicit session-id "task-beta"
    const resultB = spawnSync(bridgePath, [
      "agent",
      "--local",
      "--agent", "main",
      "--session-id", "task-beta",
      "--message", message,
      "--model", "claude-code/default",
      "--thinking", "low",
      "--timeout", "60",
      "--json",
    ], {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath, CAPTURE_CWD_PATH: cwdCaptureB },
    });
    assert.equal(resultB.status, 0, resultB.stderr);

    const cwdA = readFileSync(cwdCaptureA, "utf8").trim();
    const cwdB = readFileSync(cwdCaptureB, "utf8").trim();

    // Each session must get its own temp directory, not sharing one.
    assert.notEqual(cwdA, cwdB, "different session ids must produce different isolated workspaces");

    // The workspace must contain the session-id segment.
    assert.match(cwdA, /a2a-analysis-task-alpha/);
    assert.match(cwdB, /a2a-analysis-task-beta/);

    // Workspaces must be cleaned up after use.
    assert.equal(existsSync(cwdA), false, "session workspace A must be cleaned up after execution");
    assert.equal(existsSync(cwdB), false, "session workspace B must be cleaned up after execution");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Claude Code A2A analysis bridge closes stdin and keeps stdout in failure excerpts (#1337 ENV1)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-bridge-fail-test-"));
  const fakeClaudePath = join(tempDir, "fake-claude-fail.mjs");

  try {
    writeFileSync(fakeClaudePath, [
      "#!/usr/bin/env node",
      "import { readFileSync } from 'node:fs';",
      "// With stdin spawned as 'ignore' this returns immediately (EOF from /dev/null).",
      "// With a regression back to an open never-written pipe, this blocks until the",
      "// bridge watchdog fires, so the assertions below would fail on the timeout path.",
      "const stdinData = readFileSync(0, 'utf8');",
      "if (stdinData !== '') throw new Error('expected empty stdin');",
      "process.stderr.write('Warning: no stdin data received, proceeding without it.\\n');",
      "process.stdout.write('real failure detail: model bridge auth exploded\\n');",
      "process.exit(1);",
      "",
    ].join("\n"));
    chmodSync(fakeClaudePath, 0o755);

    const result = spawnSync(bridgePath, [
      "agent",
      "--local",
      "--agent", "main",
      "--session-id", "a2a-fail-excerpt",
      "--message", "failure excerpt regression fixture",
      "--model", "claude-code/default",
      "--thinking", "low",
      "--timeout", "10",
      "--json",
    ], {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath },
    });

    assert.notEqual(result.status, 0, "bridge must fail when claude exits non-zero");
    assert.match(result.stderr, /exited with 1/, "failure must surface the child exit code, not a timeout");
    assert.match(result.stderr, /Warning: no stdin data received/, "stderr stream must be preserved");
    assert.match(
      result.stderr,
      /real failure detail: model bridge auth exploded/,
      "stdout stream must be preserved alongside stderr so warnings cannot mask the real cause",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Operator-configured runtime model / effort (#1671 follow-up)
//
// The bridge must never let the broker-supplied namespace string ("claude-code/
// default") choose the Claude model, but it must apply a model the *operator*
// pinned on the node. Before this, the pinned value survived only as telemetry,
// so submitted evidence could name a model the run never used while the real
// model silently followed the node's global Claude Code default.
// ---------------------------------------------------------------------------

function runAnalysisBridgeCapturingArgs({ env = {}, taskModel = "claude-code/default" } = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-bridge-runtime-flags-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const argsPath = join(tempDir, "claude-args.json");
  try {
    writeFileSync(fakeClaudePath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.CAPTURE_ARGS_PATH, JSON.stringify(process.argv.slice(2)));",
      "const analysis = { status: 'done', summary: 'runtime flags captured', findings: [], risks: [], recommendations: [], evidenceRefs: [] };",
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(analysis) }));",
      "",
    ].join("\n"));
    chmodSync(fakeClaudePath, 0o755);

    const args = bridgeArgs("Analyse the packaged task.\n\nPayload JSON:\n{\"mode\":\"analysis-only\"}");
    args[args.indexOf("--model") + 1] = taskModel;

    const result = spawnSync(bridgePath, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        // Hermetic: the worker host itself sets these, so never inherit them.
        A2A_CLAUDE_MODEL: "",
        A2A_CLAUDE_EFFORT: "",
        A2A_CLAUDE_CODE_RUNTIME_MODEL: "",
        CLAUDE_CODE_EFFORT_LEVEL: "",
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        CAPTURE_ARGS_PATH: argsPath,
        ...env,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return {
      childArgs: JSON.parse(readFileSync(argsPath, "utf8")),
      payload: JSON.parse(JSON.parse(result.stdout).payloads[0].text),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

test("operator-pinned A2A_CLAUDE_MODEL is applied as a Claude --model argument and reported truthfully", () => {
  const { childArgs, payload } = runAnalysisBridgeCapturingArgs({
    env: { A2A_CLAUDE_MODEL: "claude-sonnet-5" },
  });

  assert.equal(childArgs[childArgs.indexOf("--model") + 1], "claude-sonnet-5");
  assert.equal(payload.appliedModel, "claude-sonnet-5");
  assert.equal(payload.actualRuntimeModel, "claude-sonnet-5");
  assert.equal(payload.claudeModelArgumentApplied, true);
  assert.equal(payload.modelInheritanceMode, "cli_argument");
  assert.match(payload.modelInheritanceNote, /passed an explicit --model argument/);
});

test("broker-namespace task model still cannot choose the Claude model", () => {
  const { childArgs, payload } = runAnalysisBridgeCapturingArgs({ taskModel: "claude-code/default" });

  assert.equal(childArgs.includes("--model"), false);
  assert.equal(payload.claudeModelArgumentApplied, false);
  assert.equal(payload.modelInheritanceMode, "metadata_only");
  assert.equal(payload.appliedModel, undefined);
});

test("exact GLM provider selector reaches Claude --model and runtime telemetry", () => {
  const { childArgs, payload } = runAnalysisBridgeCapturingArgs({ taskModel: "glm-5.2[1m]" });

  assert.equal(childArgs[childArgs.indexOf("--model") + 1], "glm-5.2[1m]");
  assert.equal(payload.appliedModel, "glm-5.2[1m]");
  assert.equal(payload.actualRuntimeModel, "glm-5.2[1m]");
  assert.equal(payload.claudeModelArgumentApplied, true);
  assert.equal(payload.modelInheritanceMode, "cli_argument");
});

test("a non-Claude task model does not suppress the operator-pinned model", () => {
  const { childArgs } = runAnalysisBridgeCapturingArgs({
    taskModel: "minimax-m3",
    env: { A2A_CLAUDE_MODEL: "claude-sonnet-5" },
  });

  assert.equal(childArgs[childArgs.indexOf("--model") + 1], "claude-sonnet-5");
});

test("A2A_CLAUDE_EFFORT is applied as --effort only for known levels", () => {
  const applied = runAnalysisBridgeCapturingArgs({ env: { A2A_CLAUDE_EFFORT: "xhigh" } });
  assert.equal(applied.childArgs[applied.childArgs.indexOf("--effort") + 1], "xhigh");
  assert.equal(applied.payload.appliedEffort, "xhigh");

  const rejected = runAnalysisBridgeCapturingArgs({ env: { A2A_CLAUDE_EFFORT: "turbo" } });
  assert.equal(rejected.childArgs.includes("--effort"), false);
  assert.equal(rejected.payload.appliedEffort, undefined);
});

test("CLAUDE_CODE_EFFORT_LEVEL alone never emits --effort (opt-in guard for older Claude CLIs)", () => {
  const { childArgs } = runAnalysisBridgeCapturingArgs({
    env: { CLAUDE_CODE_EFFORT_LEVEL: "xhigh" },
  });

  assert.equal(
    childArgs.includes("--effort"),
    false,
    "emitting --effort must stay an explicit A2A_CLAUDE_EFFORT opt-in so a worker on an older Claude CLI cannot break on upgrade",
  );
});

test("telemetry reports only the applied model as actual and flags declaration mismatches", () => {
  const mismatched = runAnalysisBridgeCapturingArgs({
    env: { A2A_CLAUDE_CODE_RUNTIME_MODEL: "claude-sonnet-5", A2A_CLAUDE_MODEL: "claude-opus-4-8" },
  });
  assert.equal(mismatched.payload.actualRuntimeModel, "claude-opus-4-8");
  assert.equal(mismatched.payload.appliedModel, "claude-opus-4-8");
  assert.equal(mismatched.payload.declaredRuntimeModelMatchesApplied, false);

  const aligned = runAnalysisBridgeCapturingArgs({
    env: { A2A_CLAUDE_CODE_RUNTIME_MODEL: "claude-sonnet-5", A2A_CLAUDE_MODEL: "claude-sonnet-5" },
  });
  assert.equal(aligned.payload.declaredRuntimeModelMatchesApplied, true);

  const declarationOnly = runAnalysisBridgeCapturingArgs({
    env: { A2A_CLAUDE_CODE_RUNTIME_MODEL: "claude-sonnet-5" },
  });
  assert.equal(declarationOnly.payload.actualRuntimeModel, undefined);
  assert.equal(declarationOnly.payload.claudeModelArgumentApplied, false);
  assert.equal(declarationOnly.payload.modelInheritanceMode, "metadata_only");
});

// ---------------------------------------------------------------------------
// Issue #1725 finding 1 — structured invalid-JSON failure contract
// ---------------------------------------------------------------------------

function stubClaude(tempDir, lines) {
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  writeFileSync(fakeClaudePath, ["#!/usr/bin/env node", ...lines, ""].join("\n"));
  chmodSync(fakeClaudePath, 0o755);
  return fakeClaudePath;
}

function bridgeFailureRecord(stderr) {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith("A2A_BRIDGE_ERROR="))
    .pop();
  assert.ok(line, `expected an A2A_BRIDGE_ERROR line in stderr: ${stderr}`);
  return JSON.parse(line.slice("A2A_BRIDGE_ERROR=".length));
}

test("bridge extracts fenced analysis JSON (regression fixture: fenced output)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-bridge-fenced-"));
  try {
    const fakeClaudePath = stubClaude(tempDir, [
      "const analysis = { status: 'done', summary: 'fenced JSON recovered', findings: ['fence stripped'], risks: [], recommendations: [], evidenceRefs: ['claude-code:fenced'] };",
      "console.log(JSON.stringify({ type: 'result', result: '```json\\n' + JSON.stringify(analysis) + '\\n```' }));",
    ]);
    const result = spawnSync(bridgePath, bridgeArgs("Payload JSON:\n" + JSON.stringify({ sourceOnly: true })), {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath },
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(JSON.parse(result.stdout).payloads[0]?.text);
    assert.equal(payload.status, "done");
    assert.equal(payload.summary, "fenced JSON recovered");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bridge extracts the envelope from noisy stdout (regression fixture: stdout noise)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-bridge-noise-"));
  try {
    const fakeClaudePath = stubClaude(tempDir, [
      "const analysis = { status: 'done', summary: 'noisy stdout recovered', findings: ['noise skipped'], risks: [], recommendations: [], evidenceRefs: ['claude-code:noisy'] };",
      "process.stdout.write('noise: warming up the model...\\n');",
      "process.stdout.write(JSON.stringify({ type: 'result', result: JSON.stringify(analysis) }) + '\\n');",
      "process.stdout.write('noise: shutting down\\n');",
    ]);
    const result = spawnSync(bridgePath, bridgeArgs("Payload JSON:\n" + JSON.stringify({ sourceOnly: true })), {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath },
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(JSON.parse(result.stdout).payloads[0]?.text);
    assert.equal(payload.summary, "noisy stdout recovered");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bridge contract: broad source bundle projects into the prompt (no provider)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-bridge-broad-bundle-"));
  const payloadPath = join(tempDir, "payload.json");
  try {
    writeFileSync(payloadPath, JSON.stringify({
      mode: "analysis-only",
      sourceOnly: true,
      sourceBundle: {
        files: [1, 2, 3].map((n) => ({
          repo: "jinwon-int/a2a-nexus",
          path: `packages/broker/src/file-${n}.mjs`,
          contentText: `<untrusted_external_data source="test">export const file${n} = ${n};</untrusted_external_data>`,
        })),
      },
    }), "utf8");
    const fakeClaudePath = stubClaude(tempDir, [
      "const prompt = process.argv[process.argv.indexOf('-p') + 1];",
      "for (const marker of ['file-1.mjs', 'file-2.mjs', 'file-3.mjs', 'end source 3']) {",
      "  if (!prompt.includes(marker)) throw new Error('broad bundle marker missing: ' + marker);",
      "}",
      "const analysis = { status: 'done', summary: 'broad bundle consumed', findings: ['3 source carriers'], risks: [], recommendations: [], evidenceRefs: ['jinwon-int/a2a-nexus:packages/broker/src/file-1.mjs'] };",
      "console.log(JSON.stringify({ type: 'result', result: JSON.stringify(analysis) }));",
    ]);
    const result = spawnSync(bridgePath, bridgeArgs("Payload JSON:\n" + JSON.stringify({ mode: "analysis-only" })), {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath, A2A_ANALYSIS_PAYLOAD_FILE: payloadPath },
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(JSON.parse(result.stdout).payloads[0]?.text);
    assert.equal(payload.summary, "broad bundle consumed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bridge bounds a broad source prompt below the Linux single-argument limit", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-bridge-prompt-budget-"));
  const payloadPath = join(tempDir, "payload.json");
  try {
    writeFileSync(payloadPath, JSON.stringify({
      mode: "analysis-only",
      sourceOnly: true,
      sourceBundle: {
        files: [{
          repo: "jinwon-int/a2a-nexus",
          path: "packages/broker/src/oversized-fixture.mjs",
          contentText: "x".repeat(180 * 1024),
        }],
      },
    }), "utf8");
    const fakeClaudePath = stubClaude(tempDir, [
      "const prompt = process.argv[process.argv.indexOf('-p') + 1];",
      "if (Buffer.byteLength(prompt, 'utf8') > 96 * 1024) throw new Error('prompt budget exceeded');",
      "if (!prompt.includes('truncated by claude-a2a-analysis-bridge prompt budget')) throw new Error('truncation marker missing');",
      "const analysis = { status: 'done', summary: 'oversized prompt bounded', findings: [], risks: [], recommendations: [], evidenceRefs: ['prompt-budget:test'] };",
      "console.log(JSON.stringify({ type: 'result', result: JSON.stringify(analysis) }));",
    ]);
    const result = spawnSync(bridgePath, bridgeArgs("Payload JSON:\n" + JSON.stringify({ mode: "analysis-only" })), {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath, A2A_ANALYSIS_PAYLOAD_FILE: payloadPath },
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(JSON.parse(result.stdout).payloads[0]?.text);
    assert.equal(payload.summary, "oversized prompt bounded");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bridge contract: compact source bundle projects into the prompt (no provider)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-bridge-compact-bundle-"));
  const payloadPath = join(tempDir, "payload.json");
  try {
    writeFileSync(payloadPath, JSON.stringify({
      mode: "analysis-only",
      sourceOnly: true,
      sourceBundle: {
        files: [{
          repo: "jinwon-int/a2a-nexus",
          path: "packages/broker/README.md",
          contentText: "<untrusted_external_data source=\"test\">compact fixture</untrusted_external_data>",
        }],
      },
    }), "utf8");
    const fakeClaudePath = stubClaude(tempDir, [
      "const prompt = process.argv[process.argv.indexOf('-p') + 1];",
      "if (!prompt.includes('compact fixture')) throw new Error('compact bundle content missing');",
      "if (prompt.includes('end source 2')) throw new Error('compact bundle must carry exactly one source');",
      "const analysis = { status: 'done', summary: 'compact bundle consumed', findings: ['1 source carrier'], risks: [], recommendations: [], evidenceRefs: ['jinwon-int/a2a-nexus:packages/broker/README.md'] };",
      "console.log(JSON.stringify({ type: 'result', result: JSON.stringify(analysis) }));",
    ]);
    const result = spawnSync(bridgePath, bridgeArgs("Payload JSON:\n" + JSON.stringify({ mode: "analysis-only" })), {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath, A2A_ANALYSIS_PAYLOAD_FILE: payloadPath },
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(JSON.parse(result.stdout).payloads[0]?.text);
    assert.equal(payload.summary, "compact bundle consumed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bridge fails closed on schema-invalid JSON with a bounded structured record", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-bridge-schema-invalid-"));
  try {
    const fakeClaudePath = stubClaude(tempDir, [
      "console.log(JSON.stringify({ type: 'result', num_turns: 26, duration_ms: 1234567, result: JSON.stringify({ not: 'analysis' }) }));",
    ]);
    const carrierStats = {
      taskReceipt: { files: 2, bytes: 4096 },
      payloadFile: { files: 2, bytes: 4096 },
      payloadFileBytes: 4096,
      lossyRecoveryUsed: false,
    };
    const result = spawnSync(bridgePath, bridgeArgs("Payload JSON:\n" + JSON.stringify({ sourceOnly: true })), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_ANALYSIS_SOURCE_CARRIER_STATS: JSON.stringify(carrierStats),
      },
    });
    assert.notEqual(result.status, 0, "schema-invalid output must fail closed");
    assert.match(result.stderr, /did not contain valid analysis JSON/, "human-readable message is preserved");
    const record = bridgeFailureRecord(result.stderr);
    assert.equal(record.code, "analysis_bridge_invalid_json");
    assert.equal(record.stage, "extract");
    assert.equal(record.failureShape, "schema_invalid");
    assert.equal(record.adapterClass, "claude_code");
    assert.equal(record.bridgeContractVersion, "claude-a2a-analysis.v1");
    assert.equal(record.structuredOutputMode, "cli_json_output");
    assert.equal(record.turnsUsed, 26, "Claude envelope telemetry must survive into the failure record");
    assert.equal(record.elapsedMs, 1234567);
    assert.deepEqual(record.sourceCarrierStats, carrierStats, "source counts must pass through bounded");
    assert.ok(record.excerpt.length <= 500, "excerpt stays bounded");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bridge classifies provider error text without accepting it as evidence", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-bridge-error-text-"));
  try {
    const fakeClaudePath = stubClaude(tempDir, [
      "console.log(JSON.stringify({ type: 'result', num_turns: 3, duration_ms: 42000, result: 'Error: rate limit exceeded while contacting provider, please retry later.' }));",
    ]);
    const result = spawnSync(bridgePath, bridgeArgs("Payload JSON:\n" + JSON.stringify({ sourceOnly: true })), {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath },
    });
    assert.notEqual(result.status, 0, "provider error text must fail closed, not become prose evidence");
    const record = bridgeFailureRecord(result.stderr);
    assert.equal(record.code, "analysis_bridge_invalid_json");
    assert.equal(record.failureShape, "provider_error_text");
    assert.equal(record.turnsUsed, 3);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bridge fails closed on array-only output with a structured record", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-a2a-bridge-array-only-"));
  try {
    const fakeClaudePath = stubClaude(tempDir, [
      "console.log(JSON.stringify([{ note: 'not an envelope' }]));",
    ]);
    const result = spawnSync(bridgePath, bridgeArgs("Payload JSON:\n" + JSON.stringify({ sourceOnly: true })), {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath },
    });
    assert.notEqual(result.status, 0, "array-only output must fail closed");
    const record = bridgeFailureRecord(result.stderr);
    assert.equal(record.code, "analysis_bridge_invalid_json");
    assert.equal(record.stage, "extract");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
