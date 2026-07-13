import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
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
    "You are A2A worker workeralpha. Complete this GitHub development assignment end-to-end.",
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
    assert.equal(payload.bridgeContractVersion, "claude-a2a-patch.v1");
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
  const argsPath = join(tempDir, "claude-args.json");
  try {
    writeStubClaude(fakeClaudePath, [
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "writeFileSync(process.env.CAPTURE_ARGS_PATH, JSON.stringify(args));",
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
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        CAPTURE_ARGS_PATH: argsPath,
        CAPTURE_PROMPT_PATH: promptPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0]?.text);
    assert.equal(payload.status, "done");
    assert.equal(payload.summary, "analysis complete via patch bridge analysis mode");
    assert.deepEqual(payload.evidenceRefs, ["embedded:analysis-mode-test"]);
    const args = JSON.parse(readFileSync(argsPath, "utf8"));
    assert.equal(args[args.indexOf("--allowedTools") + 1], "Read Glob Grep");
    assert.equal(args[args.indexOf("--disallowedTools") + 1], "Bash Edit Write NotebookEdit WebFetch WebSearch");
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

// ---------------------------------------------------------------------------
// SINGLE-SHOT deterministic harness tests (issue #1020)
// ---------------------------------------------------------------------------

// Mirrors the handler's prompt so parseTaskContext can find Repository:/Issue: lines.
function singleShotMessage() {
  return [
    "You are A2A worker workeralpha. Complete this GitHub development assignment end-to-end.",
    "Do not report success unless you opened a pull request, posted a Done comment, or posted a Block comment on GitHub.",
    "Return JSON only with: {\"status\":\"pr_opened|blocked|done\",\"summary\":\"...\",\"prUrl\":\"...\",\"blockCommentUrl\":\"...\",\"doneCommentUrl\":\"...\"}",
    "Repository: jinwon-int/a2a-nexus",
    "Issue: #1020",
    "Issue URL: https://github.com/jinwon-int/a2a-nexus/issues/1020",
    "Declared write-set: [\"hello.txt\"]",
  ].join("\n\n");
}

// Set up a real local bare repo + working clone with an initial commit.
// The fake git stub will cp -r from the working clone during `git clone`,
// and the working clone's `origin` remote points at the bare repo so
// `git push origin HEAD:<branch>` succeeds end-to-end in the test.
function setupLocalFakeOrigin(parentDir) {
  const originBare = join(parentDir, "origin.git");
  const workSeed = join(parentDir, "origin-work");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", originBare], { stdio: "ignore" });
  execFileSync("git", ["clone", originBare, workSeed], { stdio: "ignore" });
  execFileSync("git", ["-C", workSeed, "config", "user.email", "a2a-test@example.com"]);
  execFileSync("git", ["-C", workSeed, "config", "user.name", "A2A Test"]);
  writeFileSync(join(workSeed, "hello.txt"), "hello world\n");
  writeFileSync(join(workSeed, "README.md"), "# test\n");
  execFileSync("git", ["-C", workSeed, "add", "-A"]);
  execFileSync("git", ["-C", workSeed, "commit", "-m", "initial"], { stdio: "ignore" });
  execFileSync("git", ["-C", workSeed, "push", "origin", "main"], { stdio: "ignore" });
  return { originBare, workSeed };
}

// Write a fake `git` binary. Handles `clone` via cp -r from a seed; everything
// else delegates to the real `git` (resolved via REAL_GIT_BIN env).
function writeFakeGitStub(path) {
  const script = [
    "#!/usr/bin/env node",
    "import { spawnSync } from 'node:child_process';",
    "import { cpSync, rmSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "const sub = args[0];",
    "if (sub === 'clone') {",
    "  const dir = args[args.length - 1];",
    "  const seed = process.env.FAKE_GIT_SEED_PATH;",
    "  if (!seed) { console.error('FAKE_GIT_SEED_PATH not set'); process.exit(2); }",
    "  rmSync(dir, { recursive: true, force: true });",
    "  cpSync(seed, dir, { recursive: true });",
    "  process.exit(0);",
    "}",
    "const realGit = process.env.REAL_GIT_BIN || 'git';",
    "const res = spawnSync(realGit, args, { cwd: process.cwd(), encoding: 'utf8', stdio: 'inherit' });",
    "process.exit(res.status ?? 1);",
    "",
  ].join("\n");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

// Write a fake `gh` binary. Handles `pr create` by printing a fake URL;
// `repo clone` delegates to the bridge's A2A_CLAUDE_CODE_GIT_BIN. Everything
// else is forwarded to the real `gh` (resolved via REAL_GH_BIN env).
function writeFakeGhStub(path) {
  const script = [
    "#!/usr/bin/env node",
    "import { spawnSync } from 'node:child_process';",
    "const args = process.argv.slice(2);",
    "const sub = args[0];",
    "if (sub === 'repo' && args[1] === 'clone') {",
    "  const sep = args.indexOf('--');",
    "  const before = sep >= 0 ? args.slice(2, sep) : args.slice(2);",
    "  const repo = before[0];",
    "  const dir = before[1];",
    "  const realGit = process.env.A2A_CLAUDE_CODE_GIT_BIN || 'git';",
    "  const res = spawnSync(realGit, ['clone', '--depth=1', '--branch', 'main', `https://github.com/${repo}.git`, dir], { encoding: 'utf8' });",
    "  process.exit(res.status ?? 1);",
    "}",
    "if (sub === 'pr' && args[1] === 'create') {",
    "  const url = process.env.FAKE_GH_PR_URL || 'https://github.com/jinwon-int/a2a-nexus/pull/42';",
    "  process.stdout.write(url + '\\n');",
    "  process.exit(0);",
    "}",
    "const realGh = process.env.REAL_GH_BIN || 'gh';",
    "const res = spawnSync(realGh, args, { encoding: 'utf8', stdio: 'inherit' });",
    "process.exit(res.status ?? 1);",
    "",
  ].join("\n");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

// Fake claude that returns a single fenced diff block in its stdout (any
// surrounding JSON envelope is fine — the bridge scans for the fence).
function writeDiffClaudeStub(path, diffText) {
  const diffJson = JSON.stringify(diffText);
  // Emulate `claude --output-format json` shape: the diff is the value of the
  // `result` field as a real string with literal newlines. The bridge walks
  // the JSON envelope to recover the diff.
  const script = [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "const idx = args.indexOf('-p');",
    "const prompt = args[idx + 1];",
    "if (process.env.CAPTURE_PROMPT_PATH) writeFileSync(process.env.CAPTURE_PROMPT_PATH, prompt);",
    "if (process.env.CAPTURE_ARGS_PATH) writeFileSync(process.env.CAPTURE_ARGS_PATH, JSON.stringify(args));",
    "const diff = " + diffJson + ";",
    "const wrapped = '```diff\\n' + diff + '\\n```';",
    "const envelope = { type: 'result', subtype: 'success', result: wrapped };",
    "process.stdout.write(JSON.stringify(envelope));",
    "",
  ].join("\n");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

// Fake claude that returns different diffs on the 1st vs 2nd call. Used to
// exercise the corrective-retry path (first call's diff fails `git apply --check`).
function writeCorrectiveRetryClaudeStub(path, firstDiff, secondDiff, callCountPath) {
  const firstJson = JSON.stringify(firstDiff);
  const secondJson = JSON.stringify(secondDiff);
  const script = [
    "#!/usr/bin/env node",
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "let count = 0;",
    "if (existsSync(" + JSON.stringify(callCountPath) + ")) {",
    "  count = Number(readFileSync(" + JSON.stringify(callCountPath) + ", 'utf8'));",
    "}",
    "count += 1;",
    "writeFileSync(" + JSON.stringify(callCountPath) + ", String(count));",
    "const diff = count === 1 ? " + firstJson + " : " + secondJson + ";",
    "const wrapped = '```diff\\n' + diff + '\\n```';",
    "const envelope = { type: 'result', subtype: 'success', result: wrapped };",
    "process.stdout.write(JSON.stringify(envelope));",
    "",
  ].join("\n");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

test("SINGLE-SHOT happy path: 1 claude call, valid diff, deterministic plumbing -> prUrl", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-singleshot-happy-"));
  const { workSeed } = setupLocalFakeOrigin(tempDir);
  const fakeGitPath = join(tempDir, "fake-git.mjs");
  const fakeGhPath = join(tempDir, "fake-gh.mjs");
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const promptCapturePath = join(tempDir, "captured-prompt.txt");
  const argsCapturePath = join(tempDir, "captured-args.json");
  try {
    writeFakeGitStub(fakeGitPath);
    writeFakeGhStub(fakeGhPath);
    const validDiff = [
      "diff --git a/hello.txt b/hello.txt",
      "index ce01362..6b0f5f6 100644",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-hello world",
      "+hello world (patched by single-shot)",
    ].join("\n");
    writeDiffClaudeStub(fakeClaudePath, validDiff);

    const result = spawnSync(bridgePath, bridgeArgs(singleShotMessage()), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_CLAUDE_CODE_GIT_BIN: fakeGitPath,
        A2A_CLAUDE_CODE_GH_BIN: fakeGhPath,
        A2A_CLAUDE_CODE_PATCH_MODE: "single-shot",
        FAKE_GIT_SEED_PATH: workSeed,
        FAKE_GH_PR_URL: "https://github.com/jinwon-int/a2a-nexus/pull/1020",
        CAPTURE_PROMPT_PATH: promptCapturePath,
        CAPTURE_ARGS_PATH: argsCapturePath,
        REAL_GIT_BIN: "git",
        REAL_GH_BIN: "gh",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0].text);
    assert.equal(payload.status, "pr_opened");
    assert.equal(payload.prUrl, "https://github.com/jinwon-int/a2a-nexus/pull/1020");
    assert.equal(payload.claudeCalls, 1, "happy path should only call claude once");
    assert.ok(payload.branch && payload.branch.startsWith("a2a/single-shot-"));
    assert.ok(Array.isArray(payload.filesChanged));
    assert.ok(payload.filesChanged.some((f) => f.endsWith("hello.txt")));

    // The captured prompt must use the single-shot harness contract, not the legacy one.
    const capturedPrompt = readFileSync(promptCapturePath, "utf8");
    assert.match(capturedPrompt, /DETERMINISTIC SINGLE-SHOT MODE/);
    assert.match(capturedPrompt, /Repository: jinwon-int\/a2a-nexus/);
    assert.match(capturedPrompt, /Issue: #1020/);
    // A small read-only tool budget (default 6 turns) lets claude inspect the
    // checked-out repo and emit an applying diff; single-shot is preserved by the
    // bridge owning all git plumbing (still one primary claude call).
    const args = JSON.parse(readFileSync(argsCapturePath, "utf8"));
    assert.equal(args[args.indexOf("--max-turns") + 1], "6");
    assert.equal(args[args.indexOf("--tools") + 1], "Read Grep Glob");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SINGLE-SHOT corrective retry: first diff fails git apply --check, second diff applies -> prUrl with 2 calls", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-singleshot-retry-"));
  const { workSeed } = setupLocalFakeOrigin(tempDir);
  const fakeGitPath = join(tempDir, "fake-git.mjs");
  const fakeGhPath = join(tempDir, "fake-gh.mjs");
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const callCountPath = join(tempDir, "call-count.txt");
  try {
    writeFakeGitStub(fakeGitPath);
    writeFakeGhStub(fakeGhPath);

    // First diff references a non-existent file -> `git apply --check` will reject.
    const firstDiff = [
      "diff --git a/no-such-file.txt b/no-such-file.txt",
      "index 0000000..ce01362 100644",
      "--- a/no-such-file.txt",
      "+++ b/no-such-file.txt",
      "@@ -0,0 +1 @@",
      "+leaked",
    ].join("\n");
    // Second diff modifies the existing hello.txt -> applies cleanly.
    const secondDiff = [
      "diff --git a/hello.txt b/hello.txt",
      "index ce01362..6b0f5f6 100644",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-hello world",
      "+hello world (corrected on retry)",
    ].join("\n");
    writeCorrectiveRetryClaudeStub(fakeClaudePath, firstDiff, secondDiff, callCountPath);

    const result = spawnSync(bridgePath, bridgeArgs(singleShotMessage()), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_CLAUDE_CODE_GIT_BIN: fakeGitPath,
        A2A_CLAUDE_CODE_GH_BIN: fakeGhPath,
        A2A_CLAUDE_CODE_PATCH_MODE: "single-shot",
        FAKE_GIT_SEED_PATH: workSeed,
        FAKE_GH_PR_URL: "https://github.com/jinwon-int/a2a-nexus/pull/1021",
        REAL_GIT_BIN: "git",
        REAL_GH_BIN: "gh",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const callCount = Number(readFileSync(callCountPath, "utf8"));
    assert.equal(callCount, 2, "corrective retry must call claude exactly twice");
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0].text);
    assert.equal(payload.status, "pr_opened");
    assert.equal(payload.claudeCalls, 2, "payload must reflect 2 claude calls");
    assert.equal(payload.prUrl, "https://github.com/jinwon-int/a2a-nexus/pull/1021");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SINGLE-SHOT NO_DIFF response -> bridge exits non-zero (blocked)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-singleshot-nodiff-"));
  const { workSeed } = setupLocalFakeOrigin(tempDir);
  const fakeGitPath = join(tempDir, "fake-git.mjs");
  const fakeGhPath = join(tempDir, "fake-gh.mjs");
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const callCountPath = join(tempDir, "call-count.txt");
  try {
    writeFakeGitStub(fakeGitPath);
    writeFakeGhStub(fakeGhPath);
    writeStubClaude(fakeClaudePath, [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "let n = existsSync(" + JSON.stringify(callCountPath) + ") ? Number(readFileSync(" + JSON.stringify(callCountPath) + ", 'utf8')) : 0;",
      "n += 1;",
      "writeFileSync(" + JSON.stringify(callCountPath) + ", String(n));",
      "const inner = JSON.stringify({ status: 'pr_opened', summary: 'no diff' });",
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: inner }));",
    ]);

    const result = spawnSync(bridgePath, bridgeArgs(singleShotMessage()), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_CLAUDE_CODE_GIT_BIN: fakeGitPath,
        A2A_CLAUDE_CODE_GH_BIN: fakeGhPath,
        A2A_CLAUDE_CODE_PATCH_MODE: "single-shot",
        FAKE_GIT_SEED_PATH: workSeed,
        REAL_GIT_BIN: "git",
        REAL_GH_BIN: "gh",
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no diff/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SINGLE-SHOT bootstrap-leak diff -> bridge exits non-zero (blocked)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-singleshot-leak-"));
  const { workSeed } = setupLocalFakeOrigin(tempDir);
  const fakeGitPath = join(tempDir, "fake-git.mjs");
  const fakeGhPath = join(tempDir, "fake-gh.mjs");
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  try {
    writeFakeGitStub(fakeGitPath);
    writeFakeGhStub(fakeGhPath);
    // Diff creates USER.md -> expanded bootstrap-leak guard must block the commit.
    const leakedDiff = [
      "diff --git a/USER.md b/USER.md",
      "new file mode 100644",
      "index 0000000..ce01362",
      "--- /dev/null",
      "+++ b/USER.md",
      "@@ -0,0 +1 @@",
      "+leaked user context",
    ].join("\n");
    writeDiffClaudeStub(fakeClaudePath, leakedDiff);

    const result = spawnSync(bridgePath, bridgeArgs(singleShotMessage()), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_CLAUDE_CODE_GIT_BIN: fakeGitPath,
        A2A_CLAUDE_CODE_GH_BIN: fakeGhPath,
        A2A_CLAUDE_CODE_PATCH_MODE: "single-shot",
        FAKE_GIT_SEED_PATH: workSeed,
        REAL_GIT_BIN: "git",
        REAL_GH_BIN: "gh",
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /bootstrap|USER\.md|blocked/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SINGLE-SHOT out-of-scope diff -> bridge exits non-zero before PR", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-singleshot-scope-"));
  const { workSeed } = setupLocalFakeOrigin(tempDir);
  const fakeGitPath = join(tempDir, "fake-git.mjs");
  const fakeGhPath = join(tempDir, "fake-gh.mjs");
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  try {
    writeFakeGitStub(fakeGitPath);
    writeFakeGhStub(fakeGhPath);
    const outOfScopeDiff = [
      "diff --git a/README.md b/README.md",
      "index 8b13789..f00cafe 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-# test",
      "+# changed outside declared scope",
    ].join("\n");
    writeDiffClaudeStub(fakeClaudePath, outOfScopeDiff);

    const result = spawnSync(bridgePath, bridgeArgs(singleShotMessage()), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_CLAUDE_CODE_GIT_BIN: fakeGitPath,
        A2A_CLAUDE_CODE_GH_BIN: fakeGhPath,
        A2A_CLAUDE_CODE_PATCH_MODE: "single-shot",
        FAKE_GIT_SEED_PATH: workSeed,
        REAL_GIT_BIN: "git",
        REAL_GH_BIN: "gh",
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside declared write-set|README\.md/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SINGLE-SHOT missing Repository: in message -> bridge exits non-zero with clear error", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-singleshot-norepo-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  try {
    const messageNoRepo = [
      "You are A2A worker workeralpha. Complete this GitHub development assignment end-to-end.",
      "Repository is missing from this message.",
      "Issue: #42",
    ].join("\n\n");

    const result = spawnSync(bridgePath, bridgeArgs(messageNoRepo), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_CLAUDE_CODE_PATCH_MODE: "single-shot",
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Repository/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SINGLE-SHOT with default A2A_CLAUDE_CODE_PATCH_MODE unset -> legacy agentic path is used (no regression)", () => {
  // The 6 original tests already exercise the legacy path. This test pins the
  // contract that "no env var" still means the legacy runClaudePatch path runs,
  // not the new single-shot path. We assert by inspecting the prompt the
  // stub claude receives: legacy uses the GitHub PATCH bridge preamble, not
  // DETERMINISTIC SINGLE-SHOT MODE.
  const tempDir = mkdtempSync(join(tmpdir(), "claude-singleshot-default-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const promptCapturePath = join(tempDir, "captured-prompt.txt");
  try {
    writeStubClaude(fakeClaudePath, [
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "writeFileSync(process.env.CAPTURE_PROMPT_PATH, args[args.indexOf('-p') + 1]);",
      "const result = { status: 'pr_opened', summary: 'legacy path', prUrl: 'https://github.com/jinwon-int/a2a-nexus/pull/9' };",
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(result) }));",
    ]);

    const result = spawnSync(bridgePath, bridgeArgs(patchMessage()), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        CAPTURE_PROMPT_PATH: promptCapturePath,
        // Intentionally NOT setting A2A_CLAUDE_CODE_PATCH_MODE.
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const capturedPrompt = readFileSync(promptCapturePath, "utf8");
    assert.match(capturedPrompt, /GitHub PATCH bridge/, "legacy path should use the 1019 preamble");
    assert.doesNotMatch(capturedPrompt, /DETERMINISTIC SINGLE-SHOT MODE/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Issue #1129 — process-tree timeout / session isolation tests
// ---------------------------------------------------------------------------

test("ANALYSIS intent timeout kills the whole child process group", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-patch-tree-kill-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const grandchildPidFile = join(tempDir, "grandchild.pid");
  try {
    writeStubClaude(fakeClaudePath, [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const pidFile = process.env.GRANDCHILD_PID_FILE;",
      "const gc = spawn('sh', ['-c', 'echo $$ > ' + pidFile + '; sleep 60'], { stdio: 'ignore' });",
      "setTimeout(() => {}, 60000);",
    ]);
    // Use a short timeout (2s) to trigger the timeout path quickly.
    const result = spawnSync(bridgePath, [
      "agent",
      "--local",
      "--agent", "main",
      "--session-id", "a2a-patch-tree-kill-analysis",
      "--message", analysisMessage(),
      "--model", "claude-code/default",
      "--thinking", "low",
      "--timeout", "2",
      "--json",
    ], {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath, GRANDCHILD_PID_FILE: grandchildPidFile },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /timed out|timeout/i);
    if (existsSync(grandchildPidFile)) {
      const pid = Number(readFileSync(grandchildPidFile, "utf8").trim());
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          assert.fail("grandchild survived the bridge timeout");
        } catch { /* expected */ }
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("PATCH intent timeout kills the whole child process group", () => {
  // Tests the legacy agentic path (default without single-shot env).
  const tempDir = mkdtempSync(join(tmpdir(), "claude-patch-legacy-tree-kill-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const grandchildPidFile = join(tempDir, "grandchild.pid");
  try {
    writeStubClaude(fakeClaudePath, [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      "const pidFile = process.env.GRANDCHILD_PID_FILE;",
      "const gc = spawn('sh', ['-c', 'echo $$ > ' + pidFile + '; sleep 60'], { stdio: 'ignore' });",
      "const result = { status: 'pr_opened', summary: 'ok', prUrl: 'https://github.com/jinwon-int/example/pull/1' };",
      "console.log(JSON.stringify({ type: 'result', result: JSON.stringify(result) }));",
      "setTimeout(() => {}, 60000);",
    ]);
    // Use a very short timeout to force the timeout code path.
    const result = spawnSync(bridgePath, [
      "agent",
      "--local",
      "--agent", "main",
      "--session-id", "a2a-patch-tree-kill-legacy",
      "--message", patchMessage(),
      "--model", "claude-code/default",
      "--thinking", "low",
      "--timeout", "2",
      "--json",
    ], {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath, GRANDCHILD_PID_FILE: grandchildPidFile },
    });
    assert.notEqual(result.status, 0);
    if (existsSync(grandchildPidFile)) {
      const pid = Number(readFileSync(grandchildPidFile, "utf8").trim());
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          assert.fail("grandchild survived the patch bridge timeout");
        } catch { /* expected */ }
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("session-scoped workspace uses session-id in patch mode for task isolation", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-patch-session-scope-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const cwdCaptureA = join(tempDir, "cwd-patch-a.txt");
  const cwdCaptureB = join(tempDir, "cwd-patch-b.txt");
  try {
    writeStubClaude(fakeClaudePath, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.CAPTURE_CWD_PATH, process.cwd());",
      "const result = { status: 'pr_opened', summary: 'ok', prUrl: 'https://github.com/jinwon-int/example/pull/1' };",
      "console.log(JSON.stringify({ type: 'result', result: JSON.stringify(result) }));",
    ]);

    // Session "task-alpha"
    const resA = spawnSync(bridgePath, [
      "agent",
      "--local",
      "--agent", "main",
      "--session-id", "task-alpha",
      "--message", patchMessage(),
      "--model", "claude-code/default",
      "--thinking", "low",
      "--timeout", "60",
      "--json",
    ], {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath, CAPTURE_CWD_PATH: cwdCaptureA },
    });
    assert.equal(resA.status, 0, resA.stderr);

    // Session "task-beta"
    const resB = spawnSync(bridgePath, [
      "agent",
      "--local",
      "--agent", "main",
      "--session-id", "task-beta",
      "--message", patchMessage(),
      "--model", "claude-code/default",
      "--thinking", "low",
      "--timeout", "60",
      "--json",
    ], {
      encoding: "utf8",
      env: { ...process.env, A2A_CLAUDE_CODE_BIN: fakeClaudePath, CAPTURE_CWD_PATH: cwdCaptureB },
    });
    assert.equal(resB.status, 0, resB.stderr);

    const cwdA = readFileSync(cwdCaptureA, "utf8").trim();
    const cwdB = readFileSync(cwdCaptureB, "utf8").trim();

    assert.notEqual(cwdA, cwdB, "different session ids must produce different isolated workspaces");
    assert.match(cwdA, /a2a-patch-task-alpha/);
    assert.match(cwdB, /a2a-patch-task-beta/);

    // Session workspace must be cleaned up after use.
    assert.equal(existsSync(cwdA), false, "session workspace A must be cleaned up");
    assert.equal(existsSync(cwdB), false, "session workspace B must be cleaned up");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---- Explicit Claude model passthrough (#1508) ----

function modelCaptureStub() {
  return [
    "import { writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "writeFileSync(process.env.CAPTURE_ARGS_PATH, JSON.stringify(args));",
    "const result = {",
    "  status: 'pr_opened',",
    "  summary: 'ok',",
    "  prUrl: 'https://github.com/jinwon-int/example/pull/9',",
    "  branch: 'feat/model',",
    "  tests: [],",
    "  filesChanged: [],",
    "  risks: []",
    "};",
    "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(result) }));",
  ];
}

test("PATCH: A2A_CLAUDE_MODEL=claude-sonnet-5 -> spawned claude argv includes --model claude-sonnet-5 (#1508)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-patch-model-env-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const argsCapturePath = join(tempDir, "claude-args.json");
  try {
    writeStubClaude(fakeClaudePath, modelCaptureStub());
    const result = spawnSync(bridgePath, bridgeArgs(patchMessage()), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_CLAUDE_MODEL: "claude-sonnet-5",
        CAPTURE_ARGS_PATH: argsCapturePath,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(argsCapturePath, "utf8"));
    const modelIndex = args.indexOf("--model");
    assert.notEqual(modelIndex, -1, "claude argv must include --model when A2A_CLAUDE_MODEL is claude-shaped");
    assert.equal(args[modelIndex + 1], "claude-sonnet-5");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("PATCH: non-Claude A2A_CLAUDE_MODEL (legacy leftover) is ignored -> no --model in claude argv (#1508)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-patch-model-legacy-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const argsCapturePath = join(tempDir, "claude-args.json");
  try {
    writeStubClaude(fakeClaudePath, modelCaptureStub());
    const result = spawnSync(bridgePath, bridgeArgs(patchMessage()), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_CLAUDE_MODEL: "openai-codex/gpt-5.5",
        CAPTURE_ARGS_PATH: argsCapturePath,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(argsCapturePath, "utf8"));
    assert.equal(args.indexOf("--model"), -1,
      "legacy non-Claude identifiers must NOT reach claude argv (mounted config default keeps deciding)");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("PATCH: informational flags --model claude-code/default stays ignored (provider-style id, no regression) (#1508)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-patch-model-flag-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const argsCapturePath = join(tempDir, "claude-args.json");
  try {
    writeStubClaude(fakeClaudePath, modelCaptureStub());
    // bridgeArgs() already passes --model claude-code/default (host-lane informational value).
    const result = spawnSync(bridgePath, bridgeArgs(patchMessage()), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        CAPTURE_ARGS_PATH: argsCapturePath,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(argsCapturePath, "utf8"));
    assert.equal(args.indexOf("--model"), -1,
      "provider-style flags.model must not be forwarded to claude argv");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ANALYSIS: A2A_CLAUDE_MODEL=sonnet alias -> spawned claude argv includes --model sonnet (#1508)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-analysis-model-env-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const argsCapturePath = join(tempDir, "claude-args.json");
  try {
    writeStubClaude(fakeClaudePath, [
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "writeFileSync(process.env.CAPTURE_ARGS_PATH, JSON.stringify(args));",
      "const analysis = {",
      "  status: 'done',",
      "  summary: 'model alias passthrough analysis',",
      "  findings: [],",
      "  risks: [],",
      "  recommendations: [],",
      "  evidenceRefs: ['embedded:model-alias-test']",
      "};",
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(analysis) }));",
    ]);
    const result = spawnSync(bridgePath, bridgeArgs(analysisMessage()), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_CLAUDE_MODEL: "sonnet",
        CAPTURE_ARGS_PATH: argsCapturePath,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(argsCapturePath, "utf8"));
    const modelIndex = args.indexOf("--model");
    assert.notEqual(modelIndex, -1, "analysis claude argv must include --model for alias values");
    assert.equal(args[modelIndex + 1], "sonnet");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SINGLE-SHOT: A2A_CLAUDE_MODEL=claude-sonnet-5 -> claude argv includes --model (docker runner path) (#1508)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-singleshot-model-"));
  const { workSeed } = setupLocalFakeOrigin(tempDir);
  const fakeGitPath = join(tempDir, "fake-git.mjs");
  const fakeGhPath = join(tempDir, "fake-gh.mjs");
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const argsCapturePath = join(tempDir, "captured-args.json");
  try {
    writeFakeGitStub(fakeGitPath);
    writeFakeGhStub(fakeGhPath);
    const validDiff = [
      "diff --git a/hello.txt b/hello.txt",
      "index ce01362..6b0f5f6 100644",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-hello world",
      "+hello world (patched by single-shot)",
    ].join("\n");
    writeDiffClaudeStub(fakeClaudePath, validDiff);

    const result = spawnSync(bridgePath, bridgeArgs(singleShotMessage()), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_CLAUDE_CODE_GIT_BIN: fakeGitPath,
        A2A_CLAUDE_CODE_GH_BIN: fakeGhPath,
        A2A_CLAUDE_CODE_PATCH_MODE: "single-shot",
        A2A_CLAUDE_MODEL: "claude-sonnet-5",
        FAKE_GIT_SEED_PATH: workSeed,
        FAKE_GH_PR_URL: "https://github.com/jinwon-int/a2a-nexus/pull/1021",
        CAPTURE_ARGS_PATH: argsCapturePath,
        REAL_GIT_BIN: "git",
        REAL_GH_BIN: "gh",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0].text);
    assert.equal(payload.status, "pr_opened");
    const args = JSON.parse(readFileSync(argsCapturePath, "utf8"));
    const modelIndex = args.indexOf("--model");
    assert.notEqual(modelIndex, -1, "single-shot claude argv must include --model when A2A_CLAUDE_MODEL is claude-shaped");
    assert.equal(args[modelIndex + 1], "claude-sonnet-5");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("fanout mode is recognized and routes to single-shot for now (Phase-2 WS1)", () => {
  // patch-intent message with NO Repository: line -> reaches runPatchMode, and
  // single-shot's own repo guard fires early (no git/network needed).
  const result = spawnSync(bridgePath, bridgeArgs("Please open a pull request implementing the fix."), {
    encoding: "utf8",
    env: { ...process.env, A2A_CLAUDE_CODE_PATCH_MODE: "fanout" },
  });
  // The fanout branch emits this notice before delegating to single-shot...
  assert.match(result.stderr ?? "", /A2A_CLAUDE_CODE_PATCH_MODE=fanout: sub-agent orchestration not yet wired/);
  // ...and single-shot's no-repo guard then fires, proving it ran the single-shot path.
  assert.match(result.stderr ?? "", /single-shot patch mode requires Repository/);
});
