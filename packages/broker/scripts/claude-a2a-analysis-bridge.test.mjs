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
      "You are A2A worker nosuk. Complete this read-only Claude Code adapter analysis task.",
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

    const args = JSON.parse(readFileSync(argsPath, "utf8"));
    assert.deepEqual(args.slice(0, 2), ["-p", readFileSync(promptPath, "utf8")]);
    assert.match(readFileSync(promptPath, "utf8"), /Claude Code CLI-backed A2A analysis bridge/);
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
