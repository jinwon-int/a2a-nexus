import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
	__test,
} from "./piri-a2a-patch-bridge.mjs";

const BRIDGE = resolve(import.meta.dirname, "piri-a2a-patch-bridge.mjs");

function runBridge(args, env) {
	return spawnSync(process.execPath, [BRIDGE, ...args], {
		env: { ...process.env, ...env },
		encoding: "utf8",
		timeout: 20000,
	});
}

function patchMessage({ repo = "jinwon-int/a2a-nexus", issue = "1886" } = {}) {
	return [
		"You are A2A worker bangtong. Complete this GitHub development assignment end-to-end.",
		"Do not report success unless you opened a pull request, posted a Done comment, or posted a Block comment on GitHub.",
		'{"status":"pr_opened|blocked|done","prUrl":"..."}',
		`Repository: ${repo}`,
		`Issue: #${issue}`,
		`Issue URL: https://github.com/${repo}/issues/${issue}`,
	].join("\n");
}

function writeExecutable(path, body) {
	writeFileSync(path, body, { mode: 0o755 });
	chmodSync(path, 0o755);
}

test("isPatchIntent detects handler github-propose-patch prompts", () => {
	assert.equal(__test.isPatchIntent(patchMessage()), true);
	assert.equal(__test.isPatchIntent("Analyze this PR only"), false);
});

test("parseTaskContext reads repo and issue", () => {
	assert.deepEqual(__test.parseTaskContext(patchMessage({ repo: "acme/r", issue: "9" })), {
		repo: "acme/r",
		issueNumber: "9",
	});
});

test("buildPiriPatchPrompt forbids git commit/push and gh pr create", () => {
	const prompt = __test.buildPiriPatchPrompt("task");
	assert.match(prompt, /Do NOT run git commit/);
	assert.match(prompt, /gh pr create/);
	assert.match(prompt, /----- BROKER TASK -----\ntask/);
});

test("analysis intent fails closed with structured error", () => {
	const result = runBridge(
		["agent", "--local", "--json", "--message", "read-only analysis only", "--timeout", "5"],
		{},
	);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /A2A_BRIDGE_ERROR=/);
	assert.match(result.stderr, /patch_bridge_wrong_intent/);
});

test("missing repository fails closed", () => {
	const result = runBridge(
		["agent", "--local", "--json", "--message", "open a pull request without a repo line", "--timeout", "5"],
		{ A2A_PIRI_CONFIG_DIR: "/tmp/missing-piri-config" },
	);
	assert.equal(result.status, 2);
	assert.match(result.stderr, /patch_bridge_invalid_task/);
});

test("missing piri auth fails closed without leaking file contents", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-patch-noauth-"));
	try {
		const result = runBridge(
			["agent", "--local", "--json", "--message", patchMessage(), "--timeout", "5"],
			{ A2A_PIRI_CONFIG_DIR: dir },
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /piri credential file does not exist/);
		assert.doesNotMatch(result.stderr, /sk-|xai-|eyJ/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("happy path: fake piri edits a file, fake git/gh open a PR", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-patch-ok-"));
	try {
		const configDir = join(dir, "cfg");
		mkdirSync(join(configDir, "agent"), { recursive: true });
		writeFileSync(join(configDir, "agent", "auth.json"), '{"kimi-coding":{"type":"api_key"}}\n', { mode: 0o600 });

		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		writeExecutable(
			join(binDir, "piri"),
			`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync("changed.txt", "ok\\n");
process.stdout.write("edited changed.txt\\n");
`,
		);
		writeExecutable(
			join(binDir, "gh"),
			`#!/usr/bin/env bash
if [ "$1" = "repo" ]; then
  mkdir -p "$4"
  printf 'cloned\\n' > "$4/README.md"
  exit 0
fi
if [ "$1" = "pr" ]; then
  echo "https://github.com/jinwon-int/a2a-nexus/pull/1886"
  exit 0
fi
exit 1
`,
		);
		writeExecutable(
			join(binDir, "git"),
			`#!/usr/bin/env bash
case "$3" in
  checkout) exit 0 ;;
  status) printf ' M changed.txt\\n'; exit 0 ;;
  add|commit|push) exit 0 ;;
esac
# gh clone helper may call git; ignore
exit 0
`,
		);

		const result = runBridge(
			["agent", "--local", "--json", "--message", patchMessage(), "--timeout", "5", "--session-id", "s1"],
			{
				PATH: `${binDir}:${process.env.PATH}`,
				A2A_PIRI_CLI: join(binDir, "piri"),
				A2A_PIRI_CONFIG_DIR: configDir,
			},
		);
		assert.equal(result.status, 0, result.stderr);
		const envelope = JSON.parse(result.stdout);
		const payload = JSON.parse(envelope.payloads[0].text);
		assert.equal(payload.status, "pr_opened");
		assert.equal(payload.prUrl, "https://github.com/jinwon-int/a2a-nexus/pull/1886");
		assert.equal(payload.bridgeAdapter, "piri");
		assert.deepEqual(payload.filesChanged, ["changed.txt"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("bootstrap leak is blocked", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-patch-leak-"));
	try {
		const configDir = join(dir, "cfg");
		mkdirSync(join(configDir, "agent"), { recursive: true });
		writeFileSync(join(configDir, "agent", "auth.json"), "{}\n", { mode: 0o600 });
		const binDir = join(dir, "bin");
		mkdirSync(binDir, { recursive: true });
		writeExecutable(join(binDir, "piri"), "#!/usr/bin/env bash\nexit 0\n");
		writeExecutable(
			join(binDir, "gh"),
			`#!/usr/bin/env bash
if [ "$1" = "repo" ]; then mkdir -p "$4"; echo x > "$4/README.md"; exit 0; fi
exit 1
`,
		);
		writeExecutable(
			join(binDir, "git"),
			`#!/usr/bin/env bash
[ "$3" = "status" ] && { printf ' M AGENTS.md\\n'; exit 0; }
exit 0
`,
		);
		const result = runBridge(
			["agent", "--local", "--json", "--message", patchMessage(), "--timeout", "5"],
			{
				PATH: `${binDir}:${process.env.PATH}`,
				A2A_PIRI_CLI: join(binDir, "piri"),
				A2A_PIRI_CONFIG_DIR: configDir,
			},
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /patch_bridge_bootstrap_leak/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("normalizePatchResponse fills contract fields", () => {
	const normalized = __test.normalizePatchResponse({
		status: "pr_opened",
		summary: "ok",
		prUrl: "https://github.com/x/y/pull/1",
		filesChanged: ["a.ts"],
	});
	assert.equal(normalized.bridgeContractVersion, "piri-a2a-patch.v1");
	assert.equal(normalized.bridgeAdapter, "piri");
	assert.deepEqual(normalized.tests, []);
});

function handlerShapedMessage(payloadExtra = {}) {
	return [
		"You are A2A worker gongyung. Complete this GitHub development assignment end-to-end.",
		`Repository: jinwon-int/a2a-fanout-sandbox`,
		`Issue: #1`,
		`Issue URL: https://github.com/jinwon-int/a2a-fanout-sandbox/issues/1`,
		`Payload JSON:\n${JSON.stringify({ mode: "github-propose-patch", repo: "jinwon-int/a2a-fanout-sandbox", acceptance: { command: ["grep", "-qi", "disposable", "README.md"], expectExitCode: 0, timeoutMs: 10000 }, ...payloadExtra }, null, 2)}`,
	].join("\n\n");
}

test("parseAcceptanceSpec extracts the acceptance spec from a handler-shaped prompt", () => {
	const spec = __test.parseAcceptanceSpec(handlerShapedMessage());
	assert.deepEqual(spec, {
		command: ["grep", "-qi", "disposable", "README.md"],
		expectExitCode: 0,
		timeoutMs: 10000,
	});
});

test("parseAcceptanceSpec applies contract defaults and rejects malformed shapes", () => {
	const defaults = __test.parseAcceptanceSpec(
		handlerShapedMessage({ acceptance: { command: ["true"] } }),
	);
	assert.deepEqual(defaults, { command: ["true"], expectExitCode: 0, timeoutMs: 120000 });

	assert.equal(__test.parseAcceptanceSpec("no payload marker here"), null);
	assert.equal(
		__test.parseAcceptanceSpec(handlerShapedMessage({ acceptance: { command: [] } })),
		null,
	);
	assert.equal(
		__test.parseAcceptanceSpec(handlerShapedMessage({ acceptance: { command: ["true"], expectExitCode: "zero" } })),
		null,
	);
	// Truncated payload JSON (jsonForPrompt budget) must fail open to null.
	assert.equal(
		__test.parseAcceptanceSpec(`${handlerShapedMessage()}\n... [truncated 99999 chars]`),
		null,
	);
});

test("runAcceptanceInClone executes in the clone cwd and reports a smoke verdict", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-patch-accept-"));
	try {
		writeFileSync(join(dir, "README.md"), "This repository is disposable.\n");
		const passing = __test.runAcceptanceInClone({
			spec: { command: ["grep", "-qi", "disposable", "README.md"], expectExitCode: 0, timeoutMs: 10000 },
			cloneDir: dir,
			env: process.env,
		});
		assert.equal(passing.verdict, "pass");
		assert.equal(passing.kind, "smoke");
		assert.equal(passing.acceptanceContext, "piri-host-patch-clone");
		assert.equal(passing.metrics.exitCode, 0);

		const failing = __test.runAcceptanceInClone({
			spec: { command: ["grep", "-qi", "absent", "README.md"], expectExitCode: 0, timeoutMs: 10000 },
			cloneDir: dir,
			env: process.env,
		});
		assert.equal(failing.verdict, "fail");
		// Exit code for a no-match grep differs by grep build (GNU: 1 no-match /
		// 2 file error; toybox: 1) — assert the failure note shape, not the code.
		assert.match(failing.note, /acceptance failed \(exit [0-9]+, expected 0\): grep -qi absent README\.md/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("normalizePatchResponse passes the bridge acceptance verdict through", () => {
	const normalized = __test.normalizePatchResponse({
		status: "pr_opened",
		summary: "ok",
		acceptance: { kind: "smoke", verdict: "pass", metrics: { acceptance: true } },
	});
	assert.equal(normalized.acceptance.verdict, "pass");

	const without = __test.normalizePatchResponse({ status: "pr_opened", summary: "ok" });
	assert.equal(without.acceptance, undefined);
});
