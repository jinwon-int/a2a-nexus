import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildFanoutSubagentPrompt, describeHunkHeaderMismatches, diagnoseHunkHeaderCounts } from "./claude-a2a-patch-bridge.mjs";

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


function writeDiffClaudeStubWithTrailingProse(path, diffText, trailingProse) {
  const diffJson = JSON.stringify(diffText);
  const proseJson = JSON.stringify(trailingProse);
  const script = [
    "#!/usr/bin/env node",
    "import { writeFileSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "const idx = args.indexOf('-p');",
    "const prompt = args[idx + 1];",
    "if (process.env.CAPTURE_PROMPT_PATH) writeFileSync(process.env.CAPTURE_PROMPT_PATH, prompt);",
    "const diff = " + diffJson + ";",
    "const wrapped = '```diff\\n' + diff + '\\n```\\n\\n' + " + proseJson + ";",
    "const envelope = { type: 'result', subtype: 'success', result: wrapped };",
    "process.stdout.write(JSON.stringify(envelope));",
    "",
  ].join("\n");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

test("SINGLE-SHOT: a diff that patches a markdown file containing code fences still applies", () => {
  // Regression: the fence pattern was not anchored to line starts, so the code
  // fences the patched markdown file carries as unified-diff context/added lines
  // (" ```bash", "+```") terminated the lazy match. "latest wins" then picked a
  // fragment with no diff header and the raw-text fallback swallowed the closing
  // fence, which git apply rejected as `corrupt patch at line N`. Observed live
  // on a documentation propose_patch task.
  const tempDir = mkdtempSync(join(tmpdir(), "claude-singleshot-fenced-"));
  const { workSeed } = setupLocalFakeOrigin(tempDir);
  const fakeGitPath = join(tempDir, "fake-git.mjs");
  const fakeGhPath = join(tempDir, "fake-gh.mjs");
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  try {
    // Seed a markdown file whose body contains fenced code blocks.
    writeFileSync(join(workSeed, "guide.md"), [
      "# Guide",
      "",
      "Set it via:",
      "",
      "```bash",
      "EXISTING=1",
      "```",
      "",
    ].join("\n"));
    execFileSync("git", ["-C", workSeed, "add", "-A"]);
    execFileSync("git", ["-C", workSeed, "commit", "-m", "add guide"], { stdio: "ignore" });
    execFileSync("git", ["-C", workSeed, "push", "origin", "main"], { stdio: "ignore" });

    writeFakeGitStub(fakeGitPath);
    writeFakeGhStub(fakeGhPath);

    // The diff keeps the file's own fences as context and adds new fenced lines.
    const fencedDiff = [
      "diff --git a/guide.md b/guide.md",
      "--- a/guide.md",
      "+++ b/guide.md",
      "@@ -3,5 +3,11 @@",
      " Set it via:",
      " ",
      " ```bash",
      " EXISTING=1",
      " ```",
      "+",
      "+Also:",
      "+",
      "+```bash",
      "+ADDED=1",
      "+```",
    ].join("\n");
    // Real model output continues past the closing fence. That trailing prose is
    // what the raw-text fallback swallowed into the patch body once the fence
    // match had failed, which is the observed `corrupt patch` failure.
    writeDiffClaudeStubWithTrailingProse(
      fakeClaudePath,
      fencedDiff,
      "Applied the documentation update as requested.",
    );

    const message = singleShotMessage().replace(
      'Declared write-set: ["hello.txt"]',
      'Declared write-set: ["guide.md"]',
    );
    const result = spawnSync(bridgePath, bridgeArgs(message), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_CLAUDE_CODE_GIT_BIN: fakeGitPath,
        A2A_CLAUDE_CODE_GH_BIN: fakeGhPath,
        A2A_CLAUDE_CODE_PATCH_MODE: "single-shot",
        FAKE_GIT_SEED_PATH: workSeed,
        FAKE_GH_PR_URL: "https://github.com/jinwon-int/a2a-nexus/pull/1643",
        REAL_GIT_BIN: "git",
        REAL_GH_BIN: "gh",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(JSON.parse(result.stdout).payloads[0].text);
    assert.equal(payload.status, "pr_opened", JSON.stringify(payload).slice(0, 400));
    assert.equal(payload.claudeCalls, 1, "a well-formed diff must not need a corrective retry");
    assert.ok(payload.filesChanged.some((f) => f.endsWith("guide.md")));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});


function writeRecordingGitStub(path) {
  const script = [
    "#!/usr/bin/env node",
    "import { spawnSync } from 'node:child_process';",
    "import { appendFileSync, cpSync, rmSync } from 'node:fs';",
    "const args = process.argv.slice(2);",
    "if (process.env.CAPTURE_GIT_ARGS_PATH) appendFileSync(process.env.CAPTURE_GIT_ARGS_PATH, JSON.stringify(args) + '\\n');",
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

test("SINGLE-SHOT: the bridge configures a commit identity in its own workspace", () => {
  // Regression: the bridge commits inside its own clone. The docker runner
  // configures /work/repo, not that workspace, and the container has neither a
  // global git config nor the host's GIT_AUTHOR_* variables, so git fell back to
  // auto-detection and died with "Author identity unknown" after the patch had
  // already applied. Assert the identity is set explicitly rather than relying on
  // ambient config, which happens to exist on developer hosts but not in the
  // container.
  const tempDir = mkdtempSync(join(tmpdir(), "claude-singleshot-identity-"));
  const { workSeed } = setupLocalFakeOrigin(tempDir);
  const fakeGitPath = join(tempDir, "fake-git.mjs");
  const fakeGhPath = join(tempDir, "fake-gh.mjs");
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const gitArgsPath = join(tempDir, "git-args.jsonl");
  try {
    writeRecordingGitStub(fakeGitPath);
    writeFakeGhStub(fakeGhPath);
    writeDiffClaudeStub(fakeClaudePath, [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-hello world",
      "+hello world (identity test)",
    ].join("\n"));

    const result = spawnSync(bridgePath, bridgeArgs(singleShotMessage()), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_CLAUDE_CODE_GIT_BIN: fakeGitPath,
        A2A_CLAUDE_CODE_GH_BIN: fakeGhPath,
        A2A_CLAUDE_CODE_PATCH_MODE: "single-shot",
        FAKE_GIT_SEED_PATH: workSeed,
        FAKE_GH_PR_URL: "https://github.com/jinwon-int/a2a-nexus/pull/1644",
        CAPTURE_GIT_ARGS_PATH: gitArgsPath,
        REAL_GIT_BIN: "git",
        REAL_GH_BIN: "gh",
        GIT_COMMITTER_NAME: "seoseo-ai",
        GIT_COMMITTER_EMAIL: "seoseo-ai@users.noreply.github.com",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const invocations = readFileSync(gitArgsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const configs = invocations.filter((a) => a[0] === "config");
    const commitIdx = invocations.findIndex((a) => a[0] === "commit");

    assert.deepEqual(
      configs.find((a) => a[1] === "user.email"),
      ["config", "user.email", "seoseo-ai@users.noreply.github.com"],
    );
    assert.deepEqual(configs.find((a) => a[1] === "user.name"), ["config", "user.name", "seoseo-ai"]);
    const lastConfigIdx = invocations.map((a) => a[0]).lastIndexOf("config");
    assert.ok(lastConfigIdx < commitIdx, "identity must be configured before the commit");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SINGLE-SHOT: commit identity falls back to the docker runner identity", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-singleshot-identity-default-"));
  const { workSeed } = setupLocalFakeOrigin(tempDir);
  const fakeGitPath = join(tempDir, "fake-git.mjs");
  const fakeGhPath = join(tempDir, "fake-gh.mjs");
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const gitArgsPath = join(tempDir, "git-args.jsonl");
  try {
    writeRecordingGitStub(fakeGitPath);
    writeFakeGhStub(fakeGhPath);
    writeDiffClaudeStub(fakeClaudePath, [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-hello world",
      "+hello world (default identity)",
    ].join("\n"));

    const env = {
      ...process.env,
      A2A_CLAUDE_CODE_BIN: fakeClaudePath,
      A2A_CLAUDE_CODE_GIT_BIN: fakeGitPath,
      A2A_CLAUDE_CODE_GH_BIN: fakeGhPath,
      A2A_CLAUDE_CODE_PATCH_MODE: "single-shot",
      FAKE_GIT_SEED_PATH: workSeed,
      FAKE_GH_PR_URL: "https://github.com/jinwon-int/a2a-nexus/pull/1645",
      CAPTURE_GIT_ARGS_PATH: gitArgsPath,
      REAL_GIT_BIN: "git",
      REAL_GH_BIN: "gh",
    };
    delete env.GIT_AUTHOR_NAME;
    delete env.GIT_AUTHOR_EMAIL;
    delete env.GIT_COMMITTER_NAME;
    delete env.GIT_COMMITTER_EMAIL;

    const result = spawnSync(bridgePath, bridgeArgs(singleShotMessage()), { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);

    const invocations = readFileSync(gitArgsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const configs = invocations.filter((a) => a[0] === "config");
    // Matches the identity the docker runner sets for /work/repo, so a commit
    // through either path is attributable to the same actor.
    assert.deepEqual(
      configs.find((a) => a[1] === "user.email"),
      ["config", "user.email", "a2a-runner@openclaw.ai"],
    );
    assert.deepEqual(configs.find((a) => a[1] === "user.name"), ["config", "user.name", "A2A Docker Runner"]);
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

test("ANALYSIS: CLAUDE_CODE_EFFORT_LEVEL reaches the isolated Claude child", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-analysis-effort-env-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const effortCapturePath = join(tempDir, "claude-effort.txt");
  try {
    writeStubClaude(fakeClaudePath, [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.CAPTURE_EFFORT_PATH, process.env.CLAUDE_CODE_EFFORT_LEVEL || '');",
      "const analysis = { status: 'done', summary: 'effort passthrough', findings: [], risks: [], recommendations: [], evidenceRefs: [] };",
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(analysis) }));",
    ]);
    const result = spawnSync(bridgePath, bridgeArgs(analysisMessage()), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        CLAUDE_CODE_EFFORT_LEVEL: "xhigh",
        CAPTURE_EFFORT_PATH: effortCapturePath,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(effortCapturePath, "utf8"), "xhigh");
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

test("buildFanoutSubagentPrompt encodes the fanout policy when advertised, empty otherwise (Phase-2 WS4)", () => {
  assert.equal(buildFanoutSubagentPrompt({}), "");
  assert.equal(buildFanoutSubagentPrompt({ A2A_CONTAINED_SUBAGENTS_ENABLED: "1", A2A_CONTAINED_SUBAGENTS_MAX: "0" }), "");
  const p = buildFanoutSubagentPrompt({
    A2A_CONTAINED_SUBAGENTS_ENABLED: "1",
    A2A_CONTAINED_SUBAGENTS_MAX: "3",
    A2A_CONTAINED_SUBAGENTS_ROLES: "explorer,implementer,verifier",
    A2A_CONTAINED_SUBAGENTS_OUTPUT_BYTES: "12000",
  });
  assert.ok(p.includes("up to 3"));
  assert.ok(p.includes("Task tool"));
  assert.ok(p.includes("single finalizer"));
  assert.ok(p.includes("explorer,implementer,verifier"));
  assert.ok(/never emit secrets/i.test(p));
  assert.ok(/Zero sub-agents is always valid/.test(p));
});

test("buildFanoutSubagentPrompt points authorized helpers at the mounted context brief (Phase-2 WS5)", () => {
  const prompt = buildFanoutSubagentPrompt({
    A2A_CONTAINED_SUBAGENTS_ENABLED: "1",
    A2A_CONTAINED_SUBAGENTS_MAX: "2",
    A2A_SUBAGENT_CONTEXT_BRIEF: "/work/artifacts/context-brief.md",
  });
  assert.match(prompt, /Read the shared redacted context brief at \/work\/artifacts\/context-brief\.md/);
});

test("fanout mode runs the agentic patch with Task tool + spawn prompt + fanout max-turns (Phase-2 WS3/WS4)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-fanout-"));
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const argsCapturePath = join(tempDir, "claude-args.json");
  try {
    writeStubClaude(fakeClaudePath, [
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "writeFileSync(process.env.CAPTURE_ARGS_PATH, JSON.stringify(args));",
      "if (args[args.indexOf('--allowedTools') + 1] !== 'Task Bash Edit Write Read Glob Grep') throw new Error('fanout must add Task to allowedTools');",
      "const ap = args[args.indexOf('--append-system-prompt') + 1] || '';",
      "if (!ap.includes('Task tool') || !ap.includes('single finalizer') || !ap.includes('subagentReport')) throw new Error('fanout spawn/report prompt missing');",
      "const result = { status: 'pr_opened', summary: 'ok', prUrl: 'https://github.com/jinwon-int/example/pull/42', filesChanged: ['src/x.mjs'], subagentReport: { count: 1, entries: [{ role: 'verifier', id: 'helper-1', writeSet: [], status: 'complete', output: 'checked TOKEN=runtime-synthetic' }] } };",
      "console.log(JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify(result) }));",
    ]);

    const result = spawnSync(bridgePath, bridgeArgs(patchMessage()), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_PATCH_MODE: "fanout",
        A2A_CONTAINED_SUBAGENTS_ENABLED: "1",
        A2A_CONTAINED_SUBAGENTS_MAX: "3",
        A2A_CONTAINED_SUBAGENTS_ROLES: "explorer,implementer,verifier",
        A2A_CLAUDE_CODE_FANOUT_MAX_TURNS: "50",
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        CAPTURE_ARGS_PATH: argsCapturePath,
      },
    });

    assert.match(result.stderr ?? "", /A2A_CLAUDE_CODE_PATCH_MODE=fanout: agentic patch with sub-agent orchestration/);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(JSON.parse(result.stdout).payloads[0].text);
    assert.equal(payload.prUrl, "https://github.com/jinwon-int/example/pull/42");
    assert.equal(payload.subagentReport.count, 1);
    assert.equal(payload.subagentReport.entries[0].id, "helper-1");
    assert.match(payload.subagentReport.entries[0].output, /TOKEN=runtime-synthetic/);
    const args = JSON.parse(readFileSync(argsCapturePath, "utf8"));
    assert.equal(args[args.indexOf("--allowedTools") + 1], "Task Bash Edit Write Read Glob Grep");
    assert.equal(args[args.indexOf("--max-turns") + 1], "50");
    assert.ok(args.includes("--append-system-prompt"));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// --- hunk header count diagnosis (a2a-nexus#1642 canary5) ------------------
//
// canary5 emitted a hunk body of 9 old / 55 new lines under `@@ -78,6 +78,44 @@`.
// git rejected the whole patch with "patch does not apply", which says nothing
// about counts, so the corrective retry flew blind and reproduced the defect.
//
// The bridge DIAGNOSES this and hands the model the numbers. It deliberately does
// NOT rewrite the header: a recomputed count is derived from the body, so it can
// only certify the body against itself. The declared count is the sole signal that
// does not come from the body, which is what turns a truncated hunk or a wrong
// start offset into a loud failure instead of a silent partial or misplaced commit.

test("diagnoseHunkHeaderCounts reports the canary5 miscount with both sides", () => {
  const pre = ["Or via `X`:", "", "```", "X='{\"a\":1}'", "```", ""];
  const adds = Array.from({ length: 46 }, (_, i) => `added ${i + 1}`);
  const post = ["## Enrollment Health", "", "Enrollment health tracks workers."];
  const body = [
    "--- a/doc.md",
    "+++ b/doc.md",
    "@@ -78,6 +78,44 @@ WORKER_MODE=mobile",
    ...pre.map((l) => ` ${l}`),
    ...adds.map((l) => `+${l}`),
    ...post.map((l) => ` ${l}`),
  ].join("\n");

  const mismatches = diagnoseHunkHeaderCounts(body);

  assert.equal(mismatches.length, 1);
  assert.deepEqual(mismatches[0], {
    index: 0,
    file: "doc.md",
    header: "@@ -78,6 +78,44 @@",
    declaredOld: 6,
    actualOld: 9,
    declaredNew: 44,
    actualNew: 55,
  });
});

test("diagnoseHunkHeaderCounts reports nothing for a correct header", () => {
  const body = [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,3 +1,4 @@",
    " one",
    "+two",
    " three",
    " four",
  ].join("\n");

  assert.deepEqual(diagnoseHunkHeaderCounts(body), []);
});

test("diagnoseHunkHeaderCounts treats an omitted count as 1", () => {
  // `@@ -1 +1 @@` is the canonical git form for a single-line hunk.
  const body = [
    "diff --git a/hello.txt b/hello.txt",
    "index ce01362..6b0f5f6 100644",
    "--- a/hello.txt",
    "+++ b/hello.txt",
    "@@ -1 +1 @@",
    "-hello world",
    "+hello world (patched)",
  ].join("\n");

  assert.deepEqual(diagnoseHunkHeaderCounts(body), []);
});

test("diagnoseHunkHeaderCounts counts deletions, blank context and every hunk", () => {
  const body = [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,1 +1,1 @@",
    " keep",
    "",
    "-drop",
    "+add",
    "@@ -20,9 +20,9 @@ section",
    " ctx",
    "-gone",
    "",
  ].join("\n");

  const mismatches = diagnoseHunkHeaderCounts(body);

  assert.equal(mismatches.length, 2);
  // hunk 1: context "keep" + blank context + 1 deletion / + 1 addition
  assert.equal(mismatches[0].actualOld, 3);
  assert.equal(mismatches[0].actualNew, 3);
  // hunk 2 body is " ctx" + "-gone"; the final "" is the trailing EOL.
  assert.equal(mismatches[1].actualOld, 2);
  assert.equal(mismatches[1].actualNew, 1);
});

test("diagnoseHunkHeaderCounts ignores the no-newline marker", () => {
  const body = [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,1 +1,2 @@",
    " one",
    "+two",
    "\\ No newline at end of file",
    "",
  ].join("\n");

  assert.deepEqual(diagnoseHunkHeaderCounts(body), []);
});

test("diagnoseHunkHeaderCounts is inert on non-diff input", () => {
  for (const input of ["", null, undefined, "no hunks here"]) {
    assert.deepEqual(diagnoseHunkHeaderCounts(input), []);
  }
});

test("diagnoseHunkHeaderCounts does not mistake a deleted '-- ' line for a file header", () => {
  // Deleting a line whose content starts with "-- " emits `--- <content>`, which is
  // textually a file header. "-- " is the line-comment token in SQL, Lua, Haskell
  // and Ada, and this bridge patches whatever repository the task names. Truncating
  // the body there would report a mismatch on a header that is in fact correct.
  const body = [
    "diff --git a/m.sql b/m.sql",
    "index 7c1077c..954c691 100644",
    "--- a/m.sql",
    "+++ b/m.sql",
    "@@ -1,3 +1,3 @@",
    " SELECT 1;",
    "--- old comment",
    "+-- new comment",
    " SELECT 2;",
  ].join("\n");

  assert.deepEqual(diagnoseHunkHeaderCounts(body), [], "a correct header must not be flagged");
});

test("diagnoseHunkHeaderCounts does not mistake an added '++ ' line for a file header", () => {
  const body = [
    "--- a/n.txt",
    "+++ b/n.txt",
    "@@ -1,1 +1,3 @@",
    " keep",
    "+++ added marker",
    "+tail",
  ].join("\n");

  assert.deepEqual(diagnoseHunkHeaderCounts(body), []);
});

test("describeHunkHeaderMismatches renders both sides and warns about truncation", () => {
  const body = [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,2 +1,2 @@",
    "-l1",
    "+L1",
    " l2",
    " l3",
  ].join("\n");

  const hint = describeHunkHeaderMismatches(body);

  assert.match(hint, /a\.txt `@@ -1,2 \+1,2 @@` declares 2 old \/ 2 new but the hunk body carries 3 old \/ 3 new/);
  assert.match(hint, /cut short mid-edit/);
});

test("describeHunkHeaderMismatches is empty when every header agrees", () => {
  const body = ["--- a/a.txt", "+++ b/a.txt", "@@ -1,1 +1,2 @@", " one", "+two"].join("\n");
  assert.equal(describeHunkHeaderMismatches(body), "");
});

// A claude stub that captures the SECOND (corrective) prompt so a test can assert
// what diagnosis the retry was actually given.
function writeRetryPromptCapturingClaudeStub(path, firstDiff, secondDiff, promptCapturePath) {
  const script = [
    "#!/usr/bin/env node",
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const capture = " + JSON.stringify(promptCapturePath) + ";",
    "const args = process.argv.slice(2);",
    "const prompt = args[args.indexOf('-p') + 1];",
    "let count = existsSync(capture + '.count') ? Number(readFileSync(capture + '.count', 'utf8')) : 0;",
    "count += 1;",
    "writeFileSync(capture + '.count', String(count));",
    "if (count === 2) writeFileSync(capture, prompt);",
    "const diff = count === 1 ? " + JSON.stringify(firstDiff) + " : " + JSON.stringify(secondDiff) + ";",
    "const wrapped = '```diff\\n' + diff + '\\n```';",
    "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: wrapped }));",
    "",
  ].join("\n");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

// End-to-end proof for a2a-nexus#1642. The bridge must NOT rewrite the model's
// header — it must tell the model exactly what is wrong so the one corrective
// retry is informed instead of blind. git's own error never mentions counts,
// which is why canaries 1, 4 and 5 all died here.
test("SINGLE-SHOT: a miscounted hunk header is diagnosed into the corrective prompt -> prUrl", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-singleshot-hunkdiag-"));
  const { workSeed } = setupLocalFakeOrigin(tempDir);
  const fakeGitPath = join(tempDir, "fake-git.mjs");
  const fakeGhPath = join(tempDir, "fake-gh.mjs");
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  const retryPromptPath = join(tempDir, "retry-prompt.txt");
  try {
    writeFakeGitStub(fakeGitPath);
    writeFakeGhStub(fakeGhPath);
    // The seed's files are single-line, and `git apply` is lenient about counts
    // when a hunk runs to EOF with no trailing context. Give the hunk trailing
    // context so git enforces the header, as it did on the real canary.
    writeFileSync(join(workSeed, "hello.txt"), "hello world\nb\nc\nd\ne\n");
    execFileSync("git", ["-C", workSeed, "add", "-A"]);
    execFileSync("git", ["-C", workSeed, "commit", "-m", "multi-line seed"], { stdio: "ignore" });
    execFileSync("git", ["-C", workSeed, "push", "origin", "main"], { stdio: "ignore" });

    const header = (old, nw) => `@@ -1,${old} +1,${nw} @@`;
    const hunkBody = [" hello world", "-b", "+B", "+B2", " c", " d", " e"];
    const fileHeader = [
      "diff --git a/hello.txt b/hello.txt",
      "index 1111111..2222222 100644",
      "--- a/hello.txt",
      "+++ b/hello.txt",
    ];
    // Body is complete; the header undercounts it (canary5's shape).
    const miscounted = [...fileHeader, header(3, 3), ...hunkBody].join("\n");
    const corrected = [...fileHeader, header(5, 6), ...hunkBody].join("\n");
    writeRetryPromptCapturingClaudeStub(fakeClaudePath, miscounted, corrected, retryPromptPath);

    const result = spawnSync(bridgePath, bridgeArgs(singleShotMessage()), {
      encoding: "utf8",
      env: {
        ...process.env,
        A2A_CLAUDE_CODE_BIN: fakeClaudePath,
        A2A_CLAUDE_CODE_GIT_BIN: fakeGitPath,
        A2A_CLAUDE_CODE_GH_BIN: fakeGhPath,
        A2A_CLAUDE_CODE_PATCH_MODE: "single-shot",
        FAKE_GIT_SEED_PATH: workSeed,
        FAKE_GH_PR_URL: "https://github.com/jinwon-int/a2a-nexus/pull/1642",
        REAL_GIT_BIN: "git",
        REAL_GH_BIN: "gh",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(JSON.parse(result.stdout).payloads[0].text);
    assert.equal(payload.status, "pr_opened");
    assert.equal(payload.prUrl, "https://github.com/jinwon-int/a2a-nexus/pull/1642");
    assert.equal(payload.claudeCalls, 2, "the retry is used — informed, not skipped");

    // The whole point: the retry was told the counts, which git never reports.
    const retryPrompt = readFileSync(retryPromptPath, "utf8");
    assert.match(retryPrompt, /Hunk header line counts do not match/);
    assert.match(retryPrompt, /declares 3 old \/ 3 new but the hunk body carries 5 old \/ 6 new/);
    assert.match(result.stderr, /hunk_header_mismatch=1/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// The bridge must never alter the model's bytes. This pins the CRITICAL regression
// found in review: `--- <content>` produced by deleting a line that starts with
// "-- " (SQL/Lua/Haskell comments) was mistaken for a file header, and an earlier
// design rewrote the header and broke a patch that git accepted verbatim.
test("SINGLE-SHOT: a valid diff whose body contains diff-like lines is applied verbatim", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "claude-singleshot-verbatim-"));
  const { workSeed } = setupLocalFakeOrigin(tempDir);
  const fakeGitPath = join(tempDir, "fake-git.mjs");
  const fakeGhPath = join(tempDir, "fake-gh.mjs");
  const fakeClaudePath = join(tempDir, "fake-claude.mjs");
  try {
    writeFakeGitStub(fakeGitPath);
    writeFakeGhStub(fakeGhPath);
    writeFileSync(join(workSeed, "hello.txt"), "SELECT 1;\n-- old comment\nSELECT 2;\n");
    execFileSync("git", ["-C", workSeed, "add", "-A"]);
    execFileSync("git", ["-C", workSeed, "commit", "-m", "sql seed"], { stdio: "ignore" });
    execFileSync("git", ["-C", workSeed, "push", "origin", "main"], { stdio: "ignore" });

    // Deleting `-- old comment` emits `--- old comment`, textually a file header.
    // The header below is CORRECT; real `git apply` accepts this verbatim.
    const validDiff = [
      "diff --git a/hello.txt b/hello.txt",
      "index 7c1077c..954c691 100644",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1,3 +1,3 @@",
      " SELECT 1;",
      "--- old comment",
      "+-- new comment",
      " SELECT 2;",
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
        FAKE_GH_PR_URL: "https://github.com/jinwon-int/a2a-nexus/pull/1655",
        REAL_GIT_BIN: "git",
        REAL_GH_BIN: "gh",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(JSON.parse(result.stdout).payloads[0].text);
    assert.equal(payload.status, "pr_opened");
    assert.equal(payload.claudeCalls, 1);
    assert.doesNotMatch(result.stderr, /hunk_header_mismatch=/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// --- the diagnosis must never be confidently wrong ---------------------------
//
// The hint goes straight into the corrective prompt. A wrong number is worse than
// no number: it tells the model to "recount" a header that is already correct and
// points the retry away from the real failure. These cases were found by review —
// each is a diff real `git apply` ACCEPTS, or a header that is genuinely correct.

test("diagnoseHunkHeaderCounts stays silent on a blank line between file sections", () => {
  // The standard multi-file shape an LLM emits. git accepts it; counting the
  // separator as context inflated hunk 1 and flagged a correct header.
  const body = [
    "--- a/f1",
    "+++ b/f1",
    "@@ -1,1 +1,1 @@",
    "-a",
    "+A",
    "",
    "--- a/f2",
    "+++ b/f2",
    "@@ -1,1 +1,1 @@",
    "-b",
    "+B",
  ].join("\n");

  assert.deepEqual(diagnoseHunkHeaderCounts(body), []);
});

test("diagnoseHunkHeaderCounts stays silent on a blank line before a diff --git section", () => {
  const body = [
    "diff --git a/f1 b/f1",
    "--- a/f1",
    "+++ b/f1",
    "@@ -1,1 +1,1 @@",
    "-a",
    "+A",
    "",
    "diff --git a/f2 b/f2",
    "--- a/f2",
    "+++ b/f2",
    "@@ -1,1 +1,1 @@",
    "-b",
    "+B",
  ].join("\n");

  assert.deepEqual(diagnoseHunkHeaderCounts(body), []);
});

test("diagnoseHunkHeaderCounts stays silent when a body line is unclassifiable", () => {
  // A line with no valid prefix means the scan is no longer a count. Reporting
  // the partial tally would contradict a header that may well be correct.
  const body = [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,5 +1,5 @@",
    " one",
    "garbage with no diff prefix",
    "-two",
    "+TWO",
  ].join("\n");

  assert.deepEqual(diagnoseHunkHeaderCounts(body), []);
});

test("diagnoseHunkHeaderCounts still reports a real miscount in a multi-file diff", () => {
  const body = [
    "--- a/f1",
    "+++ b/f1",
    "@@ -1,1 +1,1 @@",
    "-a",
    "+A",
    "--- a/f2",
    "+++ b/f2",
    "@@ -1,9 +1,9 @@",
    " k",
    "-b",
    "+B",
  ].join("\n");

  const mismatches = diagnoseHunkHeaderCounts(body);

  assert.equal(mismatches.length, 1, "only the genuinely wrong hunk is reported");
  assert.equal(mismatches[0].file, "f2");
  assert.equal(mismatches[0].declaredOld, 9);
  assert.equal(mismatches[0].actualOld, 2);
});

test("describeHunkHeaderMismatches names the file so the retry is not left counting hunks", () => {
  const body = [
    "--- a/docs/x.md",
    "+++ b/docs/x.md",
    "@@ -78,6 +78,44 @@",
    " c1",
    " c2",
    "+a1",
    "+a2",
  ].join("\n");

  const hint = describeHunkHeaderMismatches(body);

  assert.match(hint, /docs\/x\.md `@@ -78,6 \+78,44 @@` declares 6 old \/ 44 new/);
});

test("diagnoseHunkHeaderCounts handles CRLF bodies without inventing a mismatch", () => {
  const body = [
    "--- a/a.txt\r",
    "+++ b/a.txt\r",
    "@@ -1,3 +1,3 @@\r",
    " one\r",
    "-two\r",
    "+TWO\r",
    " three\r",
  ].join("\n");

  assert.deepEqual(diagnoseHunkHeaderCounts(body), []);
});

// --- the silence guard must not swallow real miscounts ----------------------
//
// Abandoning a hunk's diagnosis is right when the evidence is genuinely ambiguous
// and wrong otherwise: it hands the corrective retry nothing on a diff git just
// rejected, which is the blind retry #1642 exists to fix.

test("diagnoseHunkHeaderCounts still reports when the last body line is whitespace-only context", () => {
  // " " prefix + "   " content. A file separator is empty, never space-padded, so
  // this is not ambiguous and must count as ordinary context.
  const body = [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,9 +1,9 @@",
    " one",
    "-two",
    "+TWO",
    "    ",
  ].join("\n");

  const mismatches = diagnoseHunkHeaderCounts(body);

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].actualOld, 3);
});

test("diagnoseHunkHeaderCounts stays silent on a correct header with a trailing blank line", () => {
  // Extraction does not guarantee a body free of trailing formatting slop. Counting
  // a stray final blank inflates both sides by one and would hand the corrective
  // retry a confident wrong number for a header that is in fact correct.
  const body = [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,4 +1,4 @@",
    " one",
    "-two",
    "+TWO",
    " three",
    " four",
    "",
  ].join("\n");

  assert.deepEqual(diagnoseHunkHeaderCounts(body), []);
});

test("diagnoseHunkHeaderCounts counts a blank before the same file's next hunk", () => {
  // A separator by definition has a file section after it, so a blank followed by
  // another `@@` of the same file is an ordinary context line — not ambiguous.
  const body = [
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,9 +1,9 @@",
    " one",
    "-two",
    "+TWO",
    "",
    "@@ -50,9 +50,9 @@",
    " x",
    "-y",
    "+Y",
  ].join("\n");

  const mismatches = diagnoseHunkHeaderCounts(body);

  assert.ok(mismatches.length > 0, "the blank must be counted, not treated as a separator");
  assert.equal(mismatches[0].actualOld, 3);
});

test("diagnoseHunkHeaderCounts unquotes a core.quotePath filename", () => {
  // git's default core.quotePath wraps non-ASCII paths in quotes with octal escapes.
  const body = [
    '--- "a/\\355\\225\\234\\352\\270\\200.txt"',
    '+++ "b/\\355\\225\\234\\352\\270\\200.txt"',
    "@@ -1,9 +1,9 @@",
    " a",
    "-b",
    "+B",
  ].join("\n");

  assert.equal(diagnoseHunkHeaderCounts(body)[0].file, "한글.txt");
});

test("diagnoseHunkHeaderCounts attributes a deletion hunk to the deleted file", () => {
  // `+++ /dev/null` names no file, so only the old side identifies it. Carrying the
  // previous section's name over would put a confidently wrong path in the hint.
  const body = [
    "--- a/f1",
    "+++ b/f1",
    "@@ -1,1 +1,1 @@",
    "-a",
    "+A",
    "--- a/f2",
    "+++ /dev/null",
    "@@ -1,5 +0,0 @@",
    "-b",
  ].join("\n");

  const mismatches = diagnoseHunkHeaderCounts(body);

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].file, "f2");
});

test("diagnoseHunkHeaderCounts attributes a creation hunk to the created file", () => {
  const body = [
    "--- /dev/null",
    "+++ b/n.txt",
    "@@ -0,0 +1,9 @@",
    "+a",
    "+b",
  ].join("\n");

  const mismatches = diagnoseHunkHeaderCounts(body);

  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].file, "n.txt");
});

test("diagnoseHunkHeaderCounts does not let a '+++ ' body line rename later hunks", () => {
  const body = [
    "--- a/f1",
    "+++ b/f1",
    "@@ -1,1 +1,2 @@",
    " k",
    "+++ marker",
    "@@ -20,9 +20,9 @@",
    " z",
    "-y",
  ].join("\n");

  const mismatches = diagnoseHunkHeaderCounts(body);

  assert.ok(mismatches.length > 0, "the loop below is vacuous if nothing is reported");
  for (const m of mismatches) {
    assert.equal(m.file, "f1", "attribution must not follow a body line");
  }
});

test("diagnoseHunkHeaderCounts leaves --no-prefix paths intact", () => {
  // Only strip a//b/ when BOTH sides carry them, so a directory literally named
  // "b/" in a --no-prefix diff is not truncated to "uild/x.js".
  const body = [
    "--- b/build/x.js",
    "+++ b/build/x.js",
    "@@ -1,9 +1,9 @@",
    " k",
    "-y",
    "+Y",
  ].join("\n");

  assert.equal(diagnoseHunkHeaderCounts(body)[0].file, "b/build/x.js");
});
