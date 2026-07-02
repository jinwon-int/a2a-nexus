import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const bridgePath = new URL("./claude-a2a-analysis-bridge.mjs", import.meta.url).pathname;

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

test("Claude Code A2A analysis bridge exists and is executable JavaScript", () => {
  assert.equal(existsSync(bridgePath), true, "bridge script should exist");
  const check = spawnSync(process.execPath, ["--check", bridgePath], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
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
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(analysis) }));",
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
    assert.equal(payload.modelInheritanceMode, "metadata_only");
    assert.equal(payload.claudeModelArgumentApplied, false);
    assert.match(payload.modelInheritanceNote, /does not pass it as a Claude CLI --model argument/);

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
