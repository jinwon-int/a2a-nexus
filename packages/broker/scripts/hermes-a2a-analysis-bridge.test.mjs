import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const bridgePath = new URL("./hermes-a2a-analysis-bridge.mjs", import.meta.url).pathname;

function openClawArgs(message) {
  return [
    bridgePath,
    "agent",
    "--local",
    "--agent", "main",
    "--session-id", "a2a-worker-task-analysis",
    "--message", message,
    "--model", "deepseek/deepseek-v4-flash",
    "--thinking", "low",
    "--timeout", "60",
    "--json",
  ];
}

test("Hermes A2A analysis bridge exists and is executable JavaScript", () => {
  assert.equal(existsSync(bridgePath), true, "bridge script should exist");
  const check = spawnSync(process.execPath, ["--check", bridgePath], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("Hermes A2A analysis bridge reads requested source files and returns OpenClaw envelope", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hermes-a2a-bridge-test-"));
  const repoDir = join(tempDir, "seo-web-bridge");
  const appDir = join(repoDir, "runtime", "app-src");
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");
  const promptPath = join(tempDir, "prompt.txt");

  try {
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "app_chat.py"), [
      "def render_conversation():",
      "    st.columns([7, 3])  # central chat currently controls files panel",
      "    render_files_panel()",
      "",
    ].join("\n"));

    writeFileSync(fakeHermesPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const queryIndex = args.indexOf('-q');",
      "if (queryIndex < 0) throw new Error('expected hermes chat -q prompt');",
      "const prompt = args[queryIndex + 1];",
      "writeFileSync(process.env.CAPTURE_PROMPT_PATH, prompt);",
      "if (!args.includes('-Q')) throw new Error('expected Hermes quiet mode');",
      "if (args[args.indexOf('--provider') + 1] !== 'deepseek') throw new Error('provider prefix was not forwarded');",
      "if (args[args.indexOf('--model') + 1] !== 'deepseek-v4-flash') throw new Error('model provider prefix was not stripped after provider forwarding');",
      "if (!prompt.includes('runtime/app-src/app_chat.py')) throw new Error('source path missing from prompt');",
      "if (!prompt.includes('st.columns([7, 3])')) throw new Error('source content missing from prompt');",
      "console.log(JSON.stringify({",
      "  status: 'done',",
      "  summary: '우측 파일 패널이 중앙 채팅 column에 종속되어 있다',",
      "  findings: ['render_conversation 안의 st.columns([7, 3])가 중앙 채팅과 우측 패널을 묶는다'],",
      "  risks: ['중앙 채팅 레이아웃 변경 시 파일 패널 위치가 같이 흔들린다'],",
      "  recommendations: ['별도 fixed right rail container로 분리한다'],",
      "  evidenceRefs: ['runtime/app-src/app_chat.py']",
      "}));",
      "",
    ].join("\n"));
    chmodSync(fakeHermesPath, 0o755);

    const message = [
      "You are A2A worker sogyo. Complete this read-only A2A analysis task.",
      "Task message:\nseo-web-bridge 우측 사이드바를 좌측 sidebar처럼 고정 rail로 바꿀지 판단해줘.",
      "Payload JSON:\n" + JSON.stringify({
        mode: "analysis-only",
        noLive: true,
        sourceOnly: true,
        repo: "jinwon-int/seo-web-bridge",
        path: "runtime/app-src/app_chat.py",
      }),
    ].join("\n\n");

    const result = spawnSync(process.execPath, openClawArgs(message), {
      encoding: "utf8",
      env: {
        ...process.env,
        HERMES_BIN: fakeHermesPath,
        HERMES_PROVIDER: "openai-codex",
        CAPTURE_PROMPT_PATH: promptPath,
        A2A_ANALYSIS_REPO_MAP_JSON: JSON.stringify({ "jinwon-int/seo-web-bridge": repoDir }),
        A2A_HERMES_ANALYSIS_TOOLSETS: "safe",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.ok(Array.isArray(envelope.payloads));
    const text = envelope.payloads[0]?.text;
    const payload = JSON.parse(text);
    assert.equal(payload.status, "done");
    assert.equal(payload.summary, "우측 파일 패널이 중앙 채팅 column에 종속되어 있다");
    assert.deepEqual(payload.recommendations, ["별도 fixed right rail container로 분리한다"]);

    const prompt = readFileSync(promptPath, "utf8");
    assert.match(prompt, /Read-only source bundle/);
    assert.match(prompt, /runtime\/app-src\/app_chat\.py/);
    assert.match(prompt, /st\.columns\(\[7, 3\]\)/);
    assert.doesNotMatch(prompt, /secret-value-should-not-appear/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Hermes A2A analysis bridge honors explicit analysis provider/model env (#766)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hermes-a2a-bridge-model-policy-"));
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");

  try {
    writeFileSync(fakeHermesPath, [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[args.indexOf('--provider') + 1] !== 'xai') throw new Error('analysis provider env was not honored');",
      "if (args[args.indexOf('--model') + 1] !== 'grok-4.20') throw new Error('analysis model env was not honored');",
      "console.log(JSON.stringify({status:'done',summary:'model policy ok',findings:[],risks:[],recommendations:[],evidenceRefs:[]}));",
      "",
    ].join("\n"));
    chmodSync(fakeHermesPath, 0o755);

    const message = [
      "You are A2A worker dungae. Complete this read-only A2A analysis task.",
      "Payload JSON:\n" + JSON.stringify({ mode: "analysis-only", noLive: true, sourceOnly: true }),
    ].join("\n\n");

    const result = spawnSync(process.execPath, openClawArgs(message), {
      encoding: "utf8",
      env: {
        ...process.env,
        HERMES_BIN: fakeHermesPath,
        A2A_HERMES_ANALYSIS_PROVIDER: "xai",
        A2A_HERMES_ANALYSIS_MODEL: "grok-4.20",
        A2A_HERMES_ANALYSIS_TOOLSETS: "safe",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0]?.text);
    assert.equal(payload.status, "done");
    assert.equal(payload.summary, "model policy ok");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Hermes A2A analysis bridge caps Hermes query argv below the configured prompt budget", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hermes-a2a-bridge-prompt-budget-"));
  const repoDir = join(tempDir, "a2a-broker");
  const sourceDir = join(repoDir, "src", "core");
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");
  const promptPath = join(tempDir, "prompt.txt");

  try {
    mkdirSync(sourceDir, { recursive: true });
    const largeSource = [
      "export const importantMarker = 'analysis bridge prompt budget regression';",
      "//" + "x".repeat(180_000),
    ].join("\n");
    writeFileSync(join(sourceDir, "large.ts"), largeSource);

    writeFileSync(fakeHermesPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const queryIndex = args.indexOf('-q');",
      "if (queryIndex < 0) throw new Error('expected hermes chat -q prompt');",
      "const prompt = args[queryIndex + 1];",
      "writeFileSync(process.env.CAPTURE_PROMPT_PATH, prompt);",
      "const maxBytes = Number(process.env.EXPECT_MAX_PROMPT_BYTES);",
      "if (Buffer.byteLength(prompt, 'utf8') > maxBytes) {",
      "  throw new Error(`prompt exceeded argv-safe budget: ${Buffer.byteLength(prompt, 'utf8')} > ${maxBytes}`);",
      "}",
      "if (!prompt.includes('analysis bridge prompt budget regression')) throw new Error('source marker missing from prompt');",
      "if (!prompt.includes('prompt budget')) throw new Error('prompt budget warning missing');",
      "console.log(JSON.stringify({",
      "  status: 'done',",
      "  summary: 'argv-safe prompt budget was enforced',",
      "  findings: ['Hermes query stayed under the configured byte budget'],",
      "  risks: [],",
      "  recommendations: [],",
      "  evidenceRefs: ['jinwon-int/a2a-broker:src/core/large.ts']",
      "}));",
      "",
    ].join("\n"));
    chmodSync(fakeHermesPath, 0o755);

    const message = [
      "A2AD read-only analysis for a2a-broker.",
      "Payload JSON:\n" + JSON.stringify({
        mode: "analysis-only",
        noLive: true,
        sourceOnly: true,
        repo: "jinwon-int/a2a-broker",
        path: "src/core/large.ts",
      }),
    ].join("\n\n");

    const result = spawnSync(process.execPath, openClawArgs(message), {
      encoding: "utf8",
      env: {
        ...process.env,
        HERMES_BIN: fakeHermesPath,
        CAPTURE_PROMPT_PATH: promptPath,
        EXPECT_MAX_PROMPT_BYTES: "20000",
        A2A_HERMES_ANALYSIS_MAX_PROMPT_BYTES: "20000",
        A2A_ANALYSIS_REPO_MAP_JSON: JSON.stringify({ "jinwon-int/a2a-broker": repoDir }),
        A2A_HERMES_ANALYSIS_MAX_TOTAL_BYTES: "200000",
        A2A_HERMES_ANALYSIS_MAX_FILE_BYTES: "200000",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const prompt = readFileSync(promptPath, "utf8");
    assert.ok(Buffer.byteLength(prompt, "utf8") <= 20000);
    assert.match(prompt, /prompt budget/i);
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0]?.text);
    assert.equal(payload.summary, "argv-safe prompt budget was enforced");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Hermes A2A analysis bridge derives repo and issue defaults from evidenceRefs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hermes-a2a-bridge-evidence-refs-"));
  const repoDir = join(tempDir, "a2a-broker");
  const scriptsDir = join(repoDir, "scripts");
  const srcGithubDir = join(repoDir, "src", "github");
  const docsDir = join(repoDir, "docs");
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");
  const promptPath = join(tempDir, "prompt.txt");

  try {
    mkdirSync(scriptsDir, { recursive: true });
    mkdirSync(srcGithubDir, { recursive: true });
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "a2a-broker" }) + "\n");
    writeFileSync(join(repoDir, "README.md"), "# a2a-broker\n");
    writeFileSync(join(scriptsDir, "hermes-a2a-analysis-bridge.mjs"), "// bridge marker\n");
    writeFileSync(join(scriptsDir, "hermes-a2a-analysis-bridge.test.mjs"), "// bridge test marker\n");
    writeFileSync(join(scriptsDir, "npm-scripts-inventory.mjs"), "// inventory marker\n");
    writeFileSync(join(srcGithubDir, "terminal-brief-evidence.ts"), "// github evidence marker\n");
    writeFileSync(join(srcGithubDir, "terminal-brief-evidence.test.ts"), "// github evidence test marker\n");
    writeFileSync(join(docsDir, "npm-scripts-inventory.md"), "# inventory docs\n");

    writeFileSync(fakeHermesPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const queryIndex = args.indexOf('-q');",
      "const prompt = args[queryIndex + 1];",
      "writeFileSync(process.env.CAPTURE_PROMPT_PATH, prompt);",
      "console.log(JSON.stringify({",
      "  status: 'done',",
      "  summary: 'evidenceRefs promoted to source bundle inputs',",
      "  findings: ['repo and issue defaults reached Hermes'],",
      "  risks: [],",
      "  recommendations: [],",
      "  evidenceRefs: ['jinwon-int/a2a-broker:scripts/hermes-a2a-analysis-bridge.mjs']",
      "}));",
      "",
    ].join("\n"));
    chmodSync(fakeHermesPath, 0o755);

    const message = [
      "A2A closeout task that only carries evidenceRefs.",
      "Payload JSON:\n" + JSON.stringify({
        mode: "analysis-only",
        noLive: true,
        sourceOnly: true,
        evidenceRefs: [
          "repo:jinwon-int/a2a-broker",
          "issues:#1341,#1351",
          "https://github.com/jinwon-int/a2a-broker/issues/1350",
        ],
      }),
    ].join("\n\n");

    const result = spawnSync(process.execPath, openClawArgs(message), {
      encoding: "utf8",
      env: {
        ...process.env,
        HERMES_BIN: fakeHermesPath,
        CAPTURE_PROMPT_PATH: promptPath,
        A2A_ANALYSIS_REPO_MAP_JSON: JSON.stringify({ "jinwon-int/a2a-broker": repoDir }),
        A2A_HERMES_ANALYSIS_MAX_FILES: "20",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const prompt = readFileSync(promptPath, "utf8");
    assert.match(prompt, /scripts\/hermes-a2a-analysis-bridge\.mjs/);
    assert.match(prompt, /scripts\/npm-scripts-inventory\.mjs/);
    assert.match(prompt, /src\/github\/terminal-brief-evidence\.ts/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Hermes A2A analysis bridge includes issue-specific default source files for evidence tasks", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hermes-a2a-bridge-default-paths-"));
  const repoDir = join(tempDir, "a2a-broker");
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");
  const promptPath = join(tempDir, "prompt.txt");

  try {
    for (const dir of ["scripts", "docs", join("src", "github")]) {
      mkdirSync(join(repoDir, dir), { recursive: true });
    }
    writeFileSync(join(repoDir, "package.json"), "{\"name\":\"a2a-broker\"}\n");
    writeFileSync(join(repoDir, "README.md"), "# a2a-broker\n");
    writeFileSync(join(repoDir, "LICENSE"), "MIT License\n");
    writeFileSync(join(repoDir, "scripts", "hermes-a2a-analysis-bridge.mjs"), "// bridge marker\n");
    writeFileSync(join(repoDir, "scripts", "hermes-a2a-analysis-bridge.test.mjs"), "// bridge test marker\n");
    writeFileSync(join(repoDir, "scripts", "a2a-dispatch-helper.mjs"), "// dispatch helper marker\n");
    writeFileSync(join(repoDir, "scripts", "team1-dispatch-wrapper.mjs"), "// team1 wrapper marker\n");
    writeFileSync(join(repoDir, "scripts", "npm-scripts-inventory.mjs"), "// inventory marker\n");
    writeFileSync(join(repoDir, "scripts", "terminal-brief-sidecar-integration-rehearsal.mjs"), "// sidecar rehearsal marker\n");
    writeFileSync(join(repoDir, "scripts", "terminal-brief-sidecar-dry-run-gate.mjs"), "// sidecar gate marker\n");
    writeFileSync(join(repoDir, "scripts", "orchestration-intelligence-worker-subagent-spawn-authorization-bridge.mjs"), "// orchestration marker\n");
    writeFileSync(join(repoDir, "docs", "npm-scripts-inventory.md"), "# inventory doc marker\n");
    writeFileSync(join(repoDir, "docs", "public-stable-readiness.md"), "# readiness marker\n");
    writeFileSync(join(repoDir, "src", "github", "terminal-brief-evidence.ts"), "// terminal evidence marker\n");
    writeFileSync(join(repoDir, "src", "github", "terminal-brief-evidence.test.ts"), "// terminal evidence test marker\n");
    writeFileSync(join(repoDir, "src", "github", "types.ts"), "// github types marker\n");

    writeFileSync(fakeHermesPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const prompt = args[args.indexOf('-q') + 1];",
      "writeFileSync(process.env.CAPTURE_PROMPT_PATH, prompt);",
      "for (const marker of ['bridge marker', 'inventory marker', 'terminal evidence marker', 'readiness marker']) {",
      "  if (!prompt.includes(marker)) throw new Error(`missing ${marker}`);",
      "}",
      "console.log(JSON.stringify({",
      "  status: 'done',",
      "  summary: 'issue-specific default files included',",
      "  findings: ['bridge, inventory, github evidence, and readiness files reached Hermes'],",
      "  risks: [],",
      "  recommendations: [],",
      "  evidenceRefs: ['jinwon-int/a2a-broker:scripts/hermes-a2a-analysis-bridge.mjs']",
      "}));",
      "",
    ].join("\n"));
    chmodSync(fakeHermesPath, 0o755);

    const message = [
      "A2A source-only task for #1341 #1351 #1354.",
      "Payload JSON:\n" + JSON.stringify({
        mode: "analysis-only",
        noLive: true,
        sourceOnly: true,
        repo: "jinwon-int/a2a-broker",
        issues: [1341, 1351, 1354],
        assignment: "inspect analysis bridge github evidence comments and scripts_inventory terminal_brief_sidecar license gate",
      }),
    ].join("\n\n");

    const result = spawnSync(process.execPath, openClawArgs(message), {
      encoding: "utf8",
      env: {
        ...process.env,
        HERMES_BIN: fakeHermesPath,
        CAPTURE_PROMPT_PATH: promptPath,
        A2A_ANALYSIS_REPO_MAP_JSON: JSON.stringify({ "jinwon-int/a2a-broker": repoDir }),
        A2A_HERMES_ANALYSIS_MAX_FILES: "20",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const prompt = readFileSync(promptPath, "utf8");
    assert.match(prompt, /scripts\/hermes-a2a-analysis-bridge\.mjs/);
    assert.match(prompt, /scripts\/npm-scripts-inventory\.mjs/);
    assert.match(prompt, /src\/github\/terminal-brief-evidence\.ts/);
    assert.match(prompt, /docs\/public-stable-readiness\.md/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Hermes A2A analysis bridge accepts embedded source evidence without repo-map access", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hermes-a2a-bridge-embedded-source-"));
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");
  const promptPath = join(tempDir, "prompt.txt");

  try {
    writeFileSync(fakeHermesPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const prompt = args[args.indexOf('-q') + 1];",
      "writeFileSync(process.env.CAPTURE_PROMPT_PATH, prompt);",
      "if (!prompt.includes('packages/broker/src/core/a2a-round-policy.ts')) throw new Error('embedded source path missing');",
      "if (!prompt.includes('embedded source marker for PR2')) throw new Error('embedded source content missing');",
      "console.log(JSON.stringify({",
      "  status: 'done',",
      "  summary: 'embedded source evidence reached Hermes without repo map',",
      "  findings: ['embeddedSourceEvidence was included in the read-only source bundle'],",
      "  risks: [],",
      "  recommendations: [],",
      "  evidenceRefs: ['jinwon-int/a2a-nexus:packages/broker/src/core/a2a-round-policy.ts']",
      "}));",
      "",
    ].join("\n"));
    chmodSync(fakeHermesPath, 0o755);

    const message = [
      "A2AD source-only task with embedded source evidence.",
      "Payload JSON:\n" + JSON.stringify({
        mode: "analysis-only",
        noLive: true,
        sourceOnly: true,
        repo: "jinwon-int/a2a-nexus",
        embeddedSourceEvidence: [
          {
            repo: "jinwon-int/a2a-nexus",
            path: "packages/broker/src/core/a2a-round-policy.ts",
            content: "export const embedded = 'embedded source marker for PR2';\n",
          },
        ],
      }),
    ].join("\n\n");

    const result = spawnSync(process.execPath, openClawArgs(message), {
      encoding: "utf8",
      env: {
        ...process.env,
        HERMES_BIN: fakeHermesPath,
        CAPTURE_PROMPT_PATH: promptPath,
        A2A_ANALYSIS_REPO_MAP_JSON: "{}",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const prompt = readFileSync(promptPath, "utf8");
    assert.match(prompt, /Read-only source bundle \([1-9]\d* files\)/);
    assert.match(prompt, /packages\/broker\/src\/core\/a2a-round-policy\.ts/);
    assert.match(prompt, /embedded source marker for PR2/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});


test("Hermes A2A analysis bridge preserves sourceBundle files under the prompt budget", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hermes-a2a-bridge-source-budget-"));
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");
  const promptPath = join(tempDir, "prompt.txt");

  try {
    writeFileSync(fakeHermesPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const prompt = args[args.indexOf('-q') + 1];",
      "writeFileSync(process.env.CAPTURE_PROMPT_PATH, prompt);",
      "if (!prompt.includes('Read-only source bundle (3 files):')) throw new Error('source bundle header missing');",
      "if (!prompt.includes('virtual/issue-inventory.json')) throw new Error('issue inventory missing');",
      "if (!prompt.includes('packages/broker/src/server.ts')) throw new Error('server source path missing');",
      "if (!prompt.includes('packages/broker/src/core/broker.ts')) throw new Error('broker source path missing');",
      "if (!prompt.includes('server marker survived prompt budget')) throw new Error('server source content missing');",
      "if (!prompt.includes('broker marker survived prompt budget')) throw new Error('broker source content missing');",
      "if (prompt.includes('issue inventory filler should not crowd out source sections')) throw new Error('bulky payload sourceBundle content should be summarized before Hermes');",
      "console.log(JSON.stringify({",
      "  status: 'done',",
      "  summary: 'source bundle files survived prompt budget',",
      "  findings: ['all embedded sourceBundle.files reached Hermes as source sections'],",
      "  risks: [],",
      "  recommendations: [],",
      "  evidenceRefs: ['jinwon-int/a2a-nexus:packages/broker/src/server.ts']",
      "}));",
      "",
    ].join("\n"));
    chmodSync(fakeHermesPath, 0o755);

    const bulkyIssueInventory = "issue inventory filler should not crowd out source sections\n".repeat(1000);
    const message = [
      "A2A source-only task with canonical sourceBundle.files.",
      "Payload JSON:\n" + JSON.stringify({
        mode: "analysis-only",
        noLive: true,
        sourceOnly: true,
        repo: "jinwon-int/a2a-nexus",
        sourceBundle: {
          files: [
            { path: "virtual/issue-inventory.json", content: bulkyIssueInventory },
            { path: "packages/broker/src/server.ts", content: "export const serverMarker = 'server marker survived prompt budget';\n" },
            { path: "packages/broker/src/core/broker.ts", contentText: "export const brokerMarker = 'broker marker survived prompt budget';\n" },
          ],
        },
      }),
    ].join("\n\n");

    const result = spawnSync(process.execPath, openClawArgs(message), {
      encoding: "utf8",
      env: {
        ...process.env,
        HERMES_BIN: fakeHermesPath,
        CAPTURE_PROMPT_PATH: promptPath,
        A2A_ANALYSIS_REPO_MAP_JSON: "{}",
        A2A_HERMES_ANALYSIS_MAX_FILES: "10",
        A2A_HERMES_ANALYSIS_MAX_TOTAL_BYTES: "200000",
        A2A_HERMES_ANALYSIS_MAX_FILE_BYTES: "160000",
        A2A_HERMES_ANALYSIS_MAX_PROMPT_BYTES: "60000",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const prompt = readFileSync(promptPath, "utf8");
    assert.ok(Buffer.byteLength(prompt, "utf8") <= 60000);
    assert.match(prompt, /Read-only source bundle \(3 files\):/);
    assert.match(prompt, /packages\/broker\/src\/server\.ts/);
    assert.match(prompt, /packages\/broker\/src\/core\/broker\.ts/);
    assert.match(prompt, /server marker survived prompt budget/);
    assert.match(prompt, /broker marker survived prompt budget/);
    assert.doesNotMatch(prompt, /issue inventory filler should not crowd out source sections/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});


test("Hermes A2A analysis bridge does not leak raw payload tails in summarized messages", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hermes-a2a-bridge-message-summary-"));
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");
  const promptPath = join(tempDir, "prompt.txt");

  try {
    writeFileSync(fakeHermesPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const prompt = args[args.indexOf('-q') + 1];",
      "writeFileSync(process.env.CAPTURE_PROMPT_PATH, prompt);",
      "const markerCount = prompt.split('SECRET_TAIL_MARKER_XYZ').length - 1;",
      "if (markerCount !== 1) throw new Error(`expected marker exactly once in source section, got ${markerCount}`);",
      "const originalMessageSection = prompt.split('Original worker message (source content summarized):')[1] || '';",
      "if (originalMessageSection.includes('SECRET_TAIL_MARKER_XYZ')) throw new Error('raw source leaked in summarized original message');",
      "if (/}ecret\s*=/.test(originalMessageSection)) throw new Error('summarized original message retained raw payload tail');",
      "console.log(JSON.stringify({",
      "  status: 'done',",
      "  summary: 'raw payload tails were omitted from summarized message',",
      "  findings: ['source marker appeared only in the source section'],",
      "  risks: [],",
      "  recommendations: [],",
      "  evidenceRefs: ['jinwon-int/a2a-nexus:packages/broker/src/server.ts']",
      "}));",
      "",
    ].join("\n"));
    chmodSync(fakeHermesPath, 0o755);

    const message = [
      "A2A source-only task with whitespace before payload JSON.",
      "Payload JSON:     \n\n" + JSON.stringify({
        mode: "analysis-only",
        noLive: true,
        sourceOnly: true,
        repo: "jinwon-int/a2a-nexus",
        sourceBundle: {
          files: [
            { path: "packages/broker/src/server.ts", content: "export const secret = 'SECRET_TAIL_MARKER_XYZ';\n" },
          ],
        },
      }),
      "Trailing instruction after payload JSON should remain.",
    ].join("\n\n");

    const result = spawnSync(process.execPath, openClawArgs(message), {
      encoding: "utf8",
      env: {
        ...process.env,
        HERMES_BIN: fakeHermesPath,
        CAPTURE_PROMPT_PATH: promptPath,
        A2A_ANALYSIS_REPO_MAP_JSON: "{}",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const prompt = readFileSync(promptPath, "utf8");
    assert.equal(prompt.split("SECRET_TAIL_MARKER_XYZ").length - 1, 1);
    const originalMessageSection = prompt.split("Original worker message (source content summarized):")[1] || "";
    assert.doesNotMatch(originalMessageSection, /SECRET_TAIL_MARKER_XYZ/);
    assert.match(originalMessageSection, /Trailing instruction after payload JSON should remain/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});




test("Hermes A2A analysis bridge blocks when explicit sourceBundle files cannot be projected (#960)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hermes-a2a-bridge-source-projection-block-"));
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");

  try {
    writeFileSync(fakeHermesPath, "#!/usr/bin/env node\nthrow new Error('Hermes should not run when explicit source projection fails');\n");
    chmodSync(fakeHermesPath, 0o755);

    const message = [
      "A2A source-only task with explicit but unusable sourceBundle.files.",
      "Payload JSON:\n" + JSON.stringify({
        mode: "analysis-only",
        noLive: true,
        sourceOnly: true,
        repo: "jinwon-int/a2a-nexus",
        sourceBundle: {
          files: [
            { path: "../unsafe.ts", contentText: "export const unsafe = true;\n" },
            { path: "packages/broker/src/empty.ts", contentText: "" },
          ],
        },
      }),
    ].join("\n\n");

    const result = spawnSync(process.execPath, openClawArgs(message), {
      encoding: "utf8",
      env: {
        ...process.env,
        HERMES_BIN: fakeHermesPath,
        A2A_ANALYSIS_REPO_MAP_JSON: "{}",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0]?.text);
    assert.equal(payload.status, "blocked");
    assert.match(payload.summary, /source projection/i);
    assert.match(payload.summary, /sourceBundle\.files/i);
    assert.ok(payload.risks.some((risk) => /source projection/i.test(risk)));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Hermes A2A analysis bridge fails closed when Hermes returns non-JSON", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hermes-a2a-bridge-bad-json-"));
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");
  try {
    writeFileSync(fakeHermesPath, "#!/usr/bin/env node\nconsole.log('not json');\n");
    chmodSync(fakeHermesPath, 0o755);
    const message = "Payload JSON:\n" + JSON.stringify({ mode: "analysis-only", noLive: true, sourceOnly: true });
    const result = spawnSync(process.execPath, openClawArgs(message), {
      encoding: "utf8",
      env: { ...process.env, HERMES_BIN: fakeHermesPath },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /valid JSON/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Hermes A2A analysis bridge accepts quiet final JSON even when Hermes aborts after output", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hermes-a2a-bridge-abort-after-json-"));
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");
  try {
    writeFileSync(fakeHermesPath, [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({",
      "  status: 'done',",
      "  summary: 'quiet JSON was emitted before Hermes aborted',",
      "  findings: ['stdout JSON is usable terminal evidence'],",
      "  risks: [],",
      "  recommendations: [],",
      "  evidenceRefs: ['jinwon-int/seo-web-bridge:runtime/app-src/app_chat.py']",
      "}));",
      "process.kill(process.pid, 'SIGABRT');",
      "",
    ].join("\n"));
    chmodSync(fakeHermesPath, 0o755);
    const message = "Payload JSON:\n" + JSON.stringify({ mode: "analysis-only", noLive: true, sourceOnly: true });
    const result = spawnSync(process.execPath, openClawArgs(message), {
      encoding: "utf8",
      env: { ...process.env, HERMES_BIN: fakeHermesPath },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0]?.text);
    assert.equal(payload.status, "done");
    assert.equal(payload.summary, "quiet JSON was emitted before Hermes aborted");
    assert.equal(payload.recoverySource, "abort_stdout");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Hermes A2A analysis bridge retries once when Hermes aborts before JSON", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hermes-a2a-bridge-abort-before-json-retry-"));
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");
  const attemptsPath = join(tempDir, "attempts.txt");
  try {
    writeFileSync(fakeHermesPath, [
      "#!/usr/bin/env node",
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      "const attemptsPath = process.env.FAKE_HERMES_ATTEMPTS_PATH;",
      "const attempts = existsSync(attemptsPath) ? Number(readFileSync(attemptsPath, 'utf8')) : 0;",
      "writeFileSync(attemptsPath, String(attempts + 1));",
      "if (attempts === 0) {",
      "  console.error('session_id: fake-abort-before-json');",
      "  process.kill(process.pid, 'SIGABRT');",
      "}",
      "console.log(JSON.stringify({",
      "  status: 'done',",
      "  summary: 'retry recovered after Hermes aborted before JSON',",
      "  findings: ['second attempt produced valid analysis JSON'],",
      "  risks: [],",
      "  recommendations: [],",
      "  evidenceRefs: ['jinwon-int/a2a-broker:scripts/hermes-a2a-analysis-bridge.mjs']",
      "}));",
      "",
    ].join("\n"));
    chmodSync(fakeHermesPath, 0o755);
    const message = "Payload JSON:\n" + JSON.stringify({ mode: "analysis-only", noLive: true, sourceOnly: true });
    const result = spawnSync(process.execPath, openClawArgs(message), {
      encoding: "utf8",
      env: { ...process.env, HERMES_BIN: fakeHermesPath, FAKE_HERMES_ATTEMPTS_PATH: attemptsPath },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(attemptsPath, "utf8"), "2");
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0]?.text);
    assert.equal(payload.status, "done");
    assert.equal(payload.summary, "retry recovered after Hermes aborted before JSON");
    assert.equal(payload.recoverySource, "retry_stdout");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Hermes A2A analysis bridge recovers final analysis JSON from Hermes state.db after stdout-less abort", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hermes-a2a-bridge-state-db-fallback-"));
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");
  const hermesHome = join(tempDir, ".hermes");
  const stateDbPath = join(hermesHome, "state.db");
  try {
    mkdirSync(hermesHome, { recursive: true });
    const db = new DatabaseSync(stateDbPath);
    db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL)");
    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
      "fake-saved-session",
      "assistant",
      JSON.stringify({
        status: "done",
        summary: "state db fallback recovered JSON saved before abort",
        findings: ["Hermes saved the final assistant response before stdout was lost"],
        risks: ["stdout-only evidence recovery would discard valid worker analysis"],
        recommendations: ["read the saved session response in read-only mode when SIGABRT reports a session_id"],
        evidenceRefs: ["/root/.hermes/state.db:messages"],
      }),
    );
    db.close();

    writeFileSync(fakeHermesPath, [
      "#!/usr/bin/env node",
      "console.error('session_id: fake-saved-session');",
      "process.kill(process.pid, 'SIGABRT');",
      "",
    ].join("\n"));
    chmodSync(fakeHermesPath, 0o755);

    const message = "Payload JSON:\n" + JSON.stringify({ mode: "analysis-only", noLive: true, sourceOnly: true });
    const result = spawnSync(process.execPath, openClawArgs(message), {
      encoding: "utf8",
      cwd: hermesHome,
      env: { ...process.env, HERMES_BIN: fakeHermesPath, HERMES_HOME: "", HOME: "" },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0]?.text);
    assert.equal(payload.status, "done");
    assert.equal(payload.summary, "state db fallback recovered JSON saved before abort");
    assert.equal(payload.recoverySource, "state_db");
    assert.deepEqual(payload.findings, ["Hermes saved the final assistant response before stdout was lost"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Hermes A2A analysis bridge rejects generic JSON from failed Hermes", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hermes-a2a-bridge-failed-generic-json-"));
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");
  try {
    writeFileSync(fakeHermesPath, [
      "#!/usr/bin/env node",
      "console.log(JSON.stringify({ error: 'auth failed' }));",
      "process.exit(1);",
      "",
    ].join("\n"));
    chmodSync(fakeHermesPath, 0o755);
    const message = "Payload JSON:\n" + JSON.stringify({ mode: "analysis-only", noLive: true, sourceOnly: true });
    const result = spawnSync(process.execPath, openClawArgs(message), {
      encoding: "utf8",
      env: { ...process.env, HERMES_BIN: fakeHermesPath },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Hermes exited with 1/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Hermes A2A analysis bridge fetches GitHub PR diff and metadata into the read-only source bundle", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hermes-a2a-bridge-pr-source-"));
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");
  const fakeGhPath = join(tempDir, "fake-gh.mjs");
  const promptPath = join(tempDir, "prompt.txt");
  const ghArgsPath = join(tempDir, "gh-args.jsonl");

  try {
    writeFileSync(fakeGhPath, [
      "#!/usr/bin/env node",
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(process.env.CAPTURE_GH_ARGS_PATH, JSON.stringify(process.argv.slice(2)) + '\\n');",
      "const args = process.argv.slice(2);",
      "if (args.join(' ') === 'pr diff 627 -R jinwon-int/a2a-nexus --color=never') {",
      "  process.stdout.write('diff --git a/packages/broker/scripts/hermes-a2a-analysis-bridge.mjs b/packages/broker/scripts/hermes-a2a-analysis-bridge.mjs\\n+const prSource = true;\\n');",
      "} else if (args[0] === 'pr' && args[1] === 'view' && args[2] === '627') {",
      "  process.stdout.write(JSON.stringify({ number: 627, title: 'A2A analyze task source fetch', url: 'https://github.com/jinwon-int/a2a-nexus/pull/627', changedFiles: 1 }));",
      "} else {",
      "  console.error('unexpected gh args: ' + args.join(' '));",
      "  process.exit(2);",
      "}",
      "",
    ].join("\n"));
    chmodSync(fakeGhPath, 0o755);

    writeFileSync(fakeHermesPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const prompt = args[args.indexOf('-q') + 1];",
      "writeFileSync(process.env.CAPTURE_PROMPT_PATH, prompt);",
      "if (!prompt.includes('.github/pr-627.diff')) throw new Error('PR diff virtual file missing');",
      "if (!prompt.includes('diff --git a/packages/broker/scripts/hermes-a2a-analysis-bridge.mjs')) throw new Error('PR diff content missing');",
      "if (!prompt.includes('.github/pr-627.metadata.json')) throw new Error('PR metadata virtual file missing');",
      "if (!prompt.includes('A2A analyze task source fetch')) throw new Error('PR metadata content missing');",
      "console.log(JSON.stringify({ status: 'done', summary: 'PR source reached Hermes', findings: ['diff inspected'], risks: [], recommendations: [], evidenceRefs: ['jinwon-int/a2a-nexus#.github/pr-627.diff'] }));",
      "",
    ].join("\n"));
    chmodSync(fakeHermesPath, 0o755);

    const message = [
      "A2A analyze task requiring GitHub PR source.",
      "Payload JSON:\n" + JSON.stringify({
        mode: "analysis-only",
        noLive: true,
        sourceOnly: true,
        prUrl: "https://github.com/jinwon-int/a2a-nexus/pull/627",
      }),
    ].join("\n\n");

    const result = spawnSync(process.execPath, openClawArgs(message), {
      encoding: "utf8",
      env: {
        ...process.env,
        HERMES_BIN: fakeHermesPath,
        A2A_HERMES_ANALYSIS_GITHUB_PR_BIN: fakeGhPath,
        CAPTURE_PROMPT_PATH: promptPath,
        CAPTURE_GH_ARGS_PATH: ghArgsPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0]?.text);
    assert.equal(payload.status, "done");
    assert.equal(payload.summary, "PR source reached Hermes");
    assert.equal(payload.recoverySource, "direct_stdout");
    const ghCalls = readFileSync(ghArgsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(ghCalls[0], ["pr", "diff", "627", "-R", "jinwon-int/a2a-nexus", "--color=never"]);
    assert.deepEqual(ghCalls[1].slice(0, 5), ["pr", "view", "627", "-R", "jinwon-int/a2a-nexus"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Hermes A2A analysis bridge blocks without invoking Hermes when explicit PR source is unavailable", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "hermes-a2a-bridge-pr-source-blocked-"));
  const fakeHermesPath = join(tempDir, "fake-hermes.mjs");
  const fakeGhPath = join(tempDir, "fake-gh.mjs");

  try {
    writeFileSync(fakeGhPath, [
      "#!/usr/bin/env node",
      "console.error('AUTH_VALUE_REDACTED rate limited');",
      "process.exit(1);",
      "",
    ].join("\n"));
    chmodSync(fakeGhPath, 0o755);
    writeFileSync(fakeHermesPath, "#!/usr/bin/env node\nthrow new Error('Hermes should not run when PR source is unavailable');\n");
    chmodSync(fakeHermesPath, 0o755);

    const message = [
      "A2A analyze task requiring GitHub PR source.",
      "Payload JSON:\n" + JSON.stringify({
        mode: "analysis-only",
        noLive: true,
        sourceOnly: true,
        prRepo: "jinwon-int/a2a-nexus",
        pr: 627,
      }),
    ].join("\n\n");

    const result = spawnSync(process.execPath, openClawArgs(message), {
      encoding: "utf8",
      env: {
        ...process.env,
        HERMES_BIN: fakeHermesPath,
        A2A_HERMES_ANALYSIS_GITHUB_PR_BIN: fakeGhPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /secret-value/);
    const envelope = JSON.parse(result.stdout);
    const payload = JSON.parse(envelope.payloads[0]?.text);
    assert.equal(payload.status, "blocked");
    assert.match(payload.summary, /analysis bridge blocked: GitHub PR source unavailable/);
    assert.deepEqual(payload.findings, []);
    assert.match(payload.evidenceRefs[0], /jinwon-int\/a2a-nexus#627/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
