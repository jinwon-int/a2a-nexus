import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const bridgePath = new URL("./claude-a2a-patch-bridge.mjs", import.meta.url).pathname;

function bridgeArgs(message) {
  return [
    "agent",
    "--local",
    "--agent", "main",
    "--session-id", "a2a-claude-code-patch",
    "--message", message,
    "--model", "claude-code/default",
    "--thinking", "low",
    "--timeout", "60",
    "--json",
  ];
}

// A message that triggers PATCH intent: it mirrors the handler's patch prompt markers
// ("GitHub development assignment", '"prUrl"', "pr_opened", "open a pull request").
function patchMessage() {
  return [
    "You are A2A worker nosuk. Complete this GitHub development assignment end-to-end.",
    "Do not report success unless you opened a pull request, posted a Done comment, or posted a Block comment on GitHub.",
    'Return JSON only with: {"status":"pr_opened|blocked|done","summary":"...","prUrl":"...","blockCommentUrl":"...","doneCommentUrl":"..."}',
    "Repository: jinwon-int/example\nIssue: #42",
  ].join("\n\n");
}

// A message that triggers ANALYSIS intent (no patch markers) — same shape as the analysis bridge tests.
function analysisMessage() {
  return "Payload JSON:\n" + JSON.stringify({ mode: "analysis-only", noLive: true, sourceOnly: true });
}

function writeStubClaude(path, bodyLines) {
  writeFileSync(path, ["#!/usr/bin/env node", ...bodyLines, ""].join("\n"));
  chmodSync(path, 0o755);
}

test("patch bridge is executable JavaScript", () => {
  assert.equal(existsSync(bridgePath), true, "bridge script should exist");
  const check = spawnSync(process.execPath, ["--check", bridgePath], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("PATCH intent + stub claude returning a PR url -> envelope contains patch JSON with prUrl, exit 0", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-patch-pr-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const cwdCapturePath = join(tempDir, "claude-cwd.txt");
  const argsCapturePath = join(tempDir, "claude-args.json");
  try {
    writeStubClaude(fakeClaudePath, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.CAPTURE_CWD_PATH, process.cwd());",
      "const args = process.argv.slice(2);",
      "writeFileSync(process.env.CAPTURE_ARGS_PATH, JSON.stringify(args));",
      "const promptIndex = args.indexOf('-p');",
      "const prompt = args[promptIndex + 1];",
      "if (!prompt.includes('GitHub PATCH bridge')) throw new Error('patch hardening preamble missing');",
      "if (args[args.indexOf('--allowedTools') + 1] !== 'Bash Edit Write Read Glob Grep') throw new Error('allowedTools missing');",
      "if (args.includes('--dangerously-skip-permissions')) throw new Error('must not skip permissions');",
      "const result = {",
      "  status: 'pr_opened',",
      "  summary: 'PR 생성 완료',",
      "  prUrl: 'https://github.com/jinwon-int/example/pull/7',",
      "  branch: 'feat/x',",
      "  tests: ['node --test -> pass'],",
      "  filesChanged: ['src/x.mjs'],",
      "  risks: []",
      "};",
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(result) }));",
    ]);

    const result = spawnSync(bridgePath, bridgeArgs(patchMessage()), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_CLAUDE_CODE_MAX_TURNS: "5",
        CAPTURE_CWD_PATH: cwdCapturePath,
        CAPTURE_ARGS_PATH: argsCapturePath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.ok(Array.isArray(envelope.payloads));
    const payload = JSON.parse(envelope.payloads[0]?.text);
    assert.equal(payload.status, "pr_opened");
    assert.equal(payload.prUrl, "https://github.com/jinwon-int/example/pull/7");
    assert.equal(payload.branch, "feat/x");
    assert.deepEqual(payload.tests, ["node --test -> pass"]);
    // max-turns env override threaded through
    const args = JSON.parse(readFileSync(argsCapturePath, "utf8"));
    assert.equal(args[args.indexOf("--max-turns") + 1], "5");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("PATCH intent + stub claude returning NO evidence url -> bridge exits non-zero", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-patch-noevidence-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  try {
    writeStubClaude(fakeClaudePath, [
      "const result = { status: 'done', summary: '작업했지만 URL 없음', tests: [], filesChanged: [], risks: [] };",
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(result) }));",
    ]);
    const result = spawnSync(bridgePath, bridgeArgs(patchMessage()), {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /evidence|prUrl|doneCommentUrl|blockCommentUrl/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("PATCH intent + bootstrap-leak file reported as changed -> bridge exits non-zero (blocked)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-patch-leak-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  try {
    writeStubClaude(fakeClaudePath, [
      "const result = {",
      "  status: 'pr_opened',",
      "  summary: 'leak',",
      "  prUrl: 'https://github.com/jinwon-int/example/pull/9',",
      "  filesChanged: ['src/x.mjs', 'AGENTS.md']",
      "};",
      "console.log(JSON.stringify({ type: 'result', result: JSON.stringify(result) }));",
    ]);
    const result = spawnSync(bridgePath, bridgeArgs(patchMessage()), {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bootstrap|AGENTS\.md|blocked/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ANALYSIS intent -> bridge behaves like the analysis bridge (no regression)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-patch-analysis-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const promptPath = join(tempDir, "claude-prompt.txt");
  try {
    writeStubClaude(fakeClaudePath, [
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const prompt = args[args.indexOf('-p') + 1];",
      "writeFileSync(process.env.CAPTURE_PROMPT_PATH, prompt);",
      "if (!prompt.includes('Do not modify files')) throw new Error('read-only instruction missing');",
      "if (!prompt.includes('Return JSON only')) throw new Error('strict JSON instruction missing');",
      "const analysis = {",
      "  status: 'done',",
      "  summary: 'analysis complete via patch bridge analysis mode',",
      "  findings: ['received task prompt'],",
      "  risks: [],",
      "  recommendations: ['keep contract'],",
      "  evidenceRefs: ['embedded:analysis-mode-test']",
      "};",
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(analysis) }));",
    ]);
    const result = spawnSync(bridgePath, bridgeArgs(analysisMessage()), {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath, CAPTURE_PROMPT_PATH: promptPath },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0]?.text);
    assert.equal(payload.status, "done");
    assert.equal(payload.summary, "analysis complete via patch bridge analysis mode");
    assert.deepEqual(payload.evidenceRefs, ["embedded:analysis-mode-test"]);
    // analysis mode must NOT inject the patch preamble
    assert.match(readFileSync(promptPath, "utf8"), /Claude Code CLI-backed A2A analysis bridge/);
    assert.doesNotMatch(readFileSync(promptPath, "utf8"), /GitHub PATCH bridge/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("PATCH mode runs claude in a fresh temp dir and removes it afterward (isolation)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-patch-isolation-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const cwdCapturePath = join(tempDir, "claude-cwd.txt");
  try {
    writeStubClaude(fakeClaudePath, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.CAPTURE_CWD_PATH, process.cwd());",
      "const result = { status: 'pr_opened', summary: 'ok', prUrl: 'https://github.com/jinwon-int/example/pull/1' };",
      "console.log(JSON.stringify({ type: 'result', result: JSON.stringify(result) }));",
    ]);
    const bridgeCwd = mkdtempSync(join(tmpdir(), "claude-patch-bridge-cwd-"));
    const result = spawnSync(bridgePath, bridgeArgs(patchMessage()), {
      encoding: "utf8",
      cwd: bridgeCwd,
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath, CAPTURE_CWD_PATH: cwdCapturePath },
    });

    assert.equal(result.status, 0, result.stderr);
    const claudeCwd = readFileSync(cwdCapturePath, "utf8").trim();
    // claude ran in a fresh a2a-patch- temp dir, NOT the bridge/worker cwd.
    assert.match(claudeCwd, /a2a-patch-/, `claude cwd should be an isolated temp dir, got ${claudeCwd}`);
    assert.notEqual(claudeCwd, bridgeCwd, "claude must not run in the worker cwd");
    assert.equal(existsSync(claudeCwd), false, "isolated temp workspace must be removed afterward");

    rmSync(bridgeCwd, { recursive: true, force: true });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
