import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { __test } from "./danso-a2a-analysis-bridge.mjs";
import {
	dansoExecutionTelemetry,
	normalizeAnalysisExecutionTelemetry,
	parseDansoStderrRecord,
} from "./lib/analysis-execution-telemetry.mjs";

const BRIDGE = resolve(import.meta.dirname, "danso-a2a-analysis-bridge.mjs");

// Fake danso: records what it was given (argv, env KEY NAMES, cwd, whether the
// session journal pre-existed) and replays one scripted outcome. Only DANSO_*
// variables survive the bridge's child-env allowlist, so the fake is driven by
// DANSO_FAKE_* knobs.
const FAKE_DANSO = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const session = at("--session");
const record = {
  argv: args,
  envKeys: Object.keys(process.env).sort(),
  credentialPresent: Boolean(process.env.ZAI_API_KEY),
  home: process.env.HOME,
  cwd: process.cwd(),
  sessionExistedAtStart: session ? fs.existsSync(session) : null,
};
if (process.env.DANSO_FAKE_RECORD) {
  fs.appendFileSync(process.env.DANSO_FAKE_RECORD, JSON.stringify(record) + "\\n");
}
if (session) fs.writeFileSync(session, "{}\\n");
const usage = JSON.stringify({ requests: 1, inputTokens: 1200, outputTokens: 340, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 1540, costUsd: 0, models: ["glm-5.3-flash"] });
const timing = JSON.stringify({ version: 1, provider_ms: 12, provider_requests: 1, retry_wait_ms: 0, tool_ms: 0, tool_calls: 0, journal_ms: 1, summary_requests: 0, startup_ms: 2 });
const tail = (category, code) => {
  if (category) process.stderr.write("DANSO_ERROR=" + JSON.stringify({ version: 1, category, exit_code: code }) + "\\n");
  process.stderr.write("DANSO_USAGE=" + usage + "\\nPIRI_USAGE=" + usage + "\\nDANSO_TIMING=" + timing + "\\n");
};
const contract = { status: "done", summary: "요약", findings: ["f1"], risks: ["r1"], recommendations: ["c1"], evidenceRefs: ["repo:x/y"], verdict: "PASS" };
switch (process.env.DANSO_FAKE_MODE || "ok") {
  case "ok": process.stdout.write(JSON.stringify(contract)); tail(); process.exit(0);
  case "prose":
    process.stdout.write("분석을 마쳤습니다. 초안 {\\"status\\":\\"draft\\"} 은 무시하세요.\\n\`\`\`json\\n" + JSON.stringify({ ...contract, summary: "최종" }) + "\\n\`\`\`\\n끝.");
    tail(); process.exit(0);
  case "no_json": process.stdout.write("JSON 없이 산문만 씁니다."); tail(); process.exit(0);
  case "bad_status": process.stdout.write(JSON.stringify({ ...contract, status: "maybe" })); tail(); process.exit(0);
  case "exit2": process.stderr.write("ZAI_API_KEY is required: environment variable not found\\n"); tail("configuration", 2); process.exit(2);
  case "exit3": process.stderr.write("provider request failed\\n"); tail("provider", 3); process.exit(3);
  case "exit124": tail("run_timeout", 124); process.exit(124);
  case "exit1": tail("mystery", 1); process.exit(1);
}
`;

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "danso-bridge-test-"));
	const cli = join(dir, "fake-danso");
	writeFileSync(cli, FAKE_DANSO, "utf8");
	chmodSync(cli, 0o755);
	const recordPath = join(dir, "record.jsonl");
	const env = {
		PATH: process.env.PATH,
		HOME: join(dir, "worker-home"),
		A2A_DANSO_CLI: cli,
		A2A_DANSO_WORK_ROOT: join(dir, "work"),
		ZAI_API_KEY: "synthetic-test-credential",
		// A worker-side secret that must never reach the danso child.
		A2A_BROKER_TOKEN: "synthetic-broker-secret",
		DANSO_FAKE_RECORD: recordPath,
	};
	const records = () => (existsSync(recordPath)
		? readFileSync(recordPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
		: []);
	return { dir, env, records, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const MESSAGE = 'Analyze. Payload JSON: {"assignment":"review the bridge","repo":"jinwon-int/a2a-nexus","review":{"required":true}}';

function runBridge(env, { message = MESSAGE, sessionId = "sess-1", extraArgs = [] } = {}) {
	return spawnSync(process.execPath, [
		BRIDGE, "agent", "--local", "--agent", "worker", "--session-id", sessionId,
		"--message", message, "--model", "glm-5.3-flash", "--thinking", "max", "--timeout", "120", "--json",
		...extraArgs,
	], { env, encoding: "utf8" });
}

function bridgeErrorOf(stderr) {
	const line = stderr.split("\n").find((item) => item.startsWith("A2A_BRIDGE_ERROR="));
	assert.ok(line, `expected A2A_BRIDGE_ERROR in stderr:\n${stderr}`);
	return JSON.parse(line.slice("A2A_BRIDGE_ERROR=".length));
}

test("success emits the OpenClaw envelope with the normalized contract and danso telemetry", () => {
	const fx = fixture();
	try {
		const result = runBridge({ ...fx.env, A2A_DANSO_EFFORT: "max" });
		assert.equal(result.status, 0, result.stderr);
		const envelope = JSON.parse(result.stdout);
		const response = JSON.parse(envelope.payloads[0].text);
		assert.equal(response.status, "done");
		assert.equal(response.verdict, "pass");
		assert.deepEqual(response.findings, ["f1"]);
		assert.equal(response.bridgeAdapter, "danso");
		assert.equal(response.bridgeContractVersion, "danso-a2a-analysis.v1");
		assert.equal(response.actualRuntimeModel, "glm-5.3-flash");
		assert.equal(response.requestedThinking, "max");
		assert.equal(response.executionTelemetry.source, "danso_cli_usage");
		assert.equal(response.executionTelemetry.modelRequests, 1);
		assert.equal(response.executionTelemetry.toolCalls, 0);
		assert.equal(response.executionTelemetry.costUsd, undefined, "danso cost is unknown, never reported as 0");
		assert.ok(normalizeAnalysisExecutionTelemetry(response.executionTelemetry));
		// #2303 item 5: content-free prompt/source byte counters ride along.
		assert.ok(Number.isInteger(response.promptView.promptBytes) && response.promptView.promptBytes > 0);
		assert.equal(response.promptView.sourceBytes, 0, "the success fixture carries no source carriers");
	} finally {
		fx.cleanup();
	}
});

test("danso runs tool-less in print mode with an isolated home and a journal outside the workspace", () => {
	const fx = fixture();
	try {
		const result = runBridge({ ...fx.env, A2A_DANSO_EFFORT: "max" });
		assert.equal(result.status, 0, result.stderr);
		const [record] = fx.records();
		const { argv } = record;
		const flag = (name) => argv[argv.indexOf(name) + 1];
		assert.ok(argv.includes("--no-tools"), "analysis lane must never advertise tools");
		assert.ok(argv.includes("-p"));
		assert.equal(flag("--provider"), "glm");
		assert.equal(flag("--model"), "glm-5.3-flash");
		assert.equal(flag("--reasoning-effort"), "max");
		assert.equal(flag("--timeout-seconds"), "120");
		assert.equal(flag("--max-turns"), "4");
		// Prompt rides last, after `--`, so a prompt starting with '-' is safe.
		assert.equal(argv.at(-2), "--");
		assert.match(argv.at(-1), /read-only A2A worker analysis bridge running under the danso harness/);
		assert.match(argv.at(-1), /top-level verdict field is REQUIRED/);
		const workspace = flag("--cwd");
		assert.equal(resolve(record.cwd), resolve(workspace));
		const rel = relative(workspace, flag("--session"));
		assert.ok(rel.startsWith(".."), "danso requires the session journal outside the workspace");
		assert.notEqual(record.home, fx.env.HOME, "node-local danso/Pi context must not load");
		assert.ok(record.home.startsWith(fx.env.A2A_DANSO_WORK_ROOT));
	} finally {
		fx.cleanup();
	}
});

test("the danso child gets an allowlisted environment: credential yes, worker secrets no", () => {
	const fx = fixture();
	try {
		const result = runBridge({ ...fx.env, DANSO_GLM_ENDPOINT: "coding", LANG: "C.UTF-8" });
		assert.equal(result.status, 0, result.stderr);
		const [record] = fx.records();
		assert.equal(record.credentialPresent, true);
		assert.ok(!record.envKeys.includes("A2A_BROKER_TOKEN"));
		assert.ok(!record.envKeys.some((key) => key.startsWith("A2A_")), record.envKeys.join(","));
		assert.ok(record.envKeys.includes("DANSO_GLM_ENDPOINT"));
		assert.ok(record.envKeys.includes("LANG"));
	} finally {
		fx.cleanup();
	}
});

test("a reused session id never resumes the previous journal", () => {
	const fx = fixture();
	try {
		assert.equal(runBridge(fx.env, { sessionId: "same" }).status, 0);
		assert.equal(runBridge(fx.env, { sessionId: "same" }).status, 0);
		const records = fx.records();
		assert.equal(records.length, 2);
		assert.deepEqual(records.map((item) => item.sessionExistedAtStart), [false, false]);
	} finally {
		fx.cleanup();
	}
});

test("the last contract-shaped JSON object is taken from a prose/fenced answer", () => {
	const fx = fixture();
	try {
		const result = runBridge({ ...fx.env, DANSO_FAKE_MODE: "prose" });
		assert.equal(result.status, 0, result.stderr);
		const response = JSON.parse(JSON.parse(result.stdout).payloads[0].text);
		assert.equal(response.summary, "최종");
	} finally {
		fx.cleanup();
	}
});

test("an answer without a contract-shaped object fails honestly as invalid_json", () => {
	for (const mode of ["no_json", "bad_status"]) {
		const fx = fixture();
		try {
			const result = runBridge({ ...fx.env, DANSO_FAKE_MODE: mode });
			assert.equal(result.status, 1, mode);
			const error = bridgeErrorOf(result.stderr);
			assert.equal(error.code, "analysis_bridge_invalid_json", mode);
			assert.equal(error.failureShape, "provider_or_model_failure");
			assert.equal(error.adapterClass, "danso");
			assert.equal(error.executionTelemetry.source, "danso_cli_usage");
		} finally {
			fx.cleanup();
		}
	}
});

test("danso exit codes map onto the structured bridge failure classes", () => {
	const cases = [
		["exit2", "analysis_bridge_invocation_invalid", "handler_artifact_failure", "configuration", 2],
		["exit3", "analysis_bridge_provider_failure", "provider_or_model_failure", "provider", 3],
		["exit124", "analysis_bridge_timeout", "provider_or_model_failure", "run_timeout", 124],
		["exit1", "analysis_bridge_internal_error", "provider_or_model_failure", "other", 1],
	];
	for (const [mode, code, failureShape, category, exitCode] of cases) {
		const fx = fixture();
		try {
			const result = runBridge({ ...fx.env, DANSO_FAKE_MODE: mode });
			assert.equal(result.status, 1, mode);
			const error = bridgeErrorOf(result.stderr);
			assert.equal(error.code, code, mode);
			assert.equal(error.failureShape, failureShape, mode);
			assert.equal(error.dansoErrorCategory, category, mode);
			assert.equal(error.dansoExitCode, exitCode, mode);
			assert.equal(error.dansoProvider, "glm");
			// Structured DANSO_* records are not relayed as the human message.
			assert.ok(!/^DANSO_USAGE=/m.test(result.stderr), mode);
		} finally {
			fx.cleanup();
		}
	}
});

test("preflight failures stop before danso is spawned", () => {
	const cases = [
		[{ ZAI_API_KEY: "" }, "analysis_bridge_credential_unavailable"],
		[{ A2A_DANSO_PROVIDER: "kimi" }, "analysis_bridge_invocation_invalid"],
		[{ A2A_DANSO_EFFORT: "ludicrous" }, "analysis_bridge_invocation_invalid"],
		[{ A2A_DANSO_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "x", A2A_DANSO_EFFORT: "high" }, "analysis_bridge_invocation_invalid"],
		[{ A2A_DANSO_PROVIDER: "openai-codex", DANSO_CHATGPT_AUTH_FILE: "/nonexistent/auth.json" }, "analysis_bridge_credential_unavailable"],
		[{ A2A_DANSO_CLI: "/nonexistent/danso" }, "analysis_bridge_invocation_invalid"],
	];
	for (const [overrides, code] of cases) {
		const fx = fixture();
		try {
			const result = runBridge({ ...fx.env, ...overrides });
			assert.equal(result.status, 1, JSON.stringify(overrides));
			const error = bridgeErrorOf(result.stderr);
			assert.equal(error.code, code, JSON.stringify(overrides));
			assert.equal(error.stage, "preflight");
			assert.equal(fx.records().length, 0, "danso must not run after a failed preflight");
			assert.ok(!result.stderr.includes("synthetic-test-credential"), "credential values are never logged");
		} finally {
			fx.cleanup();
		}
	}
});

// #2332: danso rejects prompts above 65536 bytes before any model request, so
// a configured budget above that limit must be clamped instead of letting the
// oversized prompt reach danso and fail with modelRequests=0.
test("a prompt budget override above danso's 65536-byte limit is clamped (#2332)", () => {
	const fx = fixture();
	try {
		const big = `Analyze. Payload JSON: {"assignment":"${"가".repeat(25_000)}","repo":"jinwon-int/a2a-nexus"}`;
		const result = runBridge({ ...fx.env, A2A_DANSO_ANALYSIS_MAX_PROMPT_BYTES: "400000" }, { message: big });
		assert.equal(result.status, 0, result.stderr);
		const [record] = fx.records();
		const promptArg = record.argv.at(-1);
		assert.ok(Buffer.byteLength(promptArg, "utf8") <= 65536, "prompt fits danso's limit");
		assert.match(promptArg, /truncated by danso-a2a-analysis-bridge prompt budget: originalBytes=\d+ maxBytes=65536\./);
	} finally {
		fx.cleanup();
	}
});

test("resolveDansoMaxPromptBytes defaults to danso's limit and only lets overrides lower it (#2332)", () => {
	assert.equal(__test.resolveDansoMaxPromptBytes({}), 65536);
	assert.equal(__test.resolveDansoMaxPromptBytes({ A2A_DANSO_ANALYSIS_MAX_PROMPT_BYTES: "98304" }), 65536);
	assert.equal(__test.resolveDansoMaxPromptBytes({ A2A_DANSO_ANALYSIS_MAX_PROMPT_BYTES: "20000" }), 20000);
	const prompt = __test.applyDansoPromptBudget("x".repeat(70 * 1024), {});
	assert.ok(Buffer.byteLength(prompt, "utf8") <= 65536);
	assert.match(prompt, /maxBytes=65536\.\]$/);
	const small = __test.applyDansoPromptBudget("y".repeat(30_000), { A2A_DANSO_ANALYSIS_MAX_PROMPT_BYTES: "20000" });
	assert.ok(Buffer.byteLength(small, "utf8") <= 20000);
	assert.match(small, /maxBytes=20000\.\]$/);
});

test("the prompt carries each source file's content exactly once (#2301)", () => {
	const content = "const canary2301 = 'unique-source-line';\n".repeat(30);
	const payload = {
		mode: "analysis-only",
		sourceOnly: true,
		repo: "jinwon-int/a2a-nexus",
		sourceBundle: { files: [{ repo: "jinwon-int/a2a-nexus", path: "src/x.mjs", content }] },
	};
	const json = JSON.stringify(payload, null, 2);
	const message = `Complete this task.\n\nPayload JSON (full; ${json.length} chars):\n${json}\n\nTask message:\nreview src/x.mjs`;
	const sourceBundle = { files: [{ repo: "jinwon-int/a2a-nexus", path: "src/x.mjs", content, truncated: false }], warnings: [] };
	const prompt = __test.buildDansoPrompt({ message, payload, sourceBundle, flags: {}, model: "glm-5.3-flash", effort: "high" });
	assert.equal(prompt.split("unique-source-line").length - 1, 30, "content appears once, in the source section only");
	assert.match(prompt, /Task payload JSON \(source content summarized/);
	assert.match(prompt, /Original worker message \(source content summarized\)/);
	assert.match(prompt, /"hasContent": true/);
	assert.match(prompt, /Task message:\nreview src\/x\.mjs/);
	assert.ok(Buffer.byteLength(prompt, "utf8") < 3 * Buffer.byteLength(content, "utf8") + 4096, "prompt is bounded by one content copy plus scaffolding");
});

// #2303 items 1-2+4: object-form and nested carriers used to leak their
// content through the payload section and the worker message; the handler
// label kept the original payload size after the rewrite.
test("the prompt keeps object-form and nested carriers summarized too (#2303)", () => {
	const content = "const canary2303 = 'nested-object-form-line';\n".repeat(30);
	const payload = {
		mode: "analysis-only",
		sourceOnly: true,
		repo: "jinwon-int/a2a-nexus",
		sourceFiles: { files: [{ repo: "jinwon-int/a2a-nexus", path: "obj.md", content }] },
		task: { sourceEvidence: [{ repo: "jinwon-int/a2a-nexus", path: "nested.md", content }] },
	};
	const json = JSON.stringify(payload, null, 2);
	const message = `Complete this task.\n\nPayload JSON (full; ${json.length} chars):\n${json}\n\nTask message:\nreview`;
	const prompt = __test.buildDansoPrompt({ message, payload, sourceBundle: { files: [], warnings: [] }, flags: {}, model: "glm-5.3-flash", effort: "high" });
	assert.equal(prompt.split("nested-object-form-line").length - 1, 0, "object-form and nested carriers leak no content");
	assert.match(prompt, /Payload JSON \(summarized; \d+ chars\):/, "worker-message label rewritten to the summarized size");
	assert.ok(!prompt.includes(`(full; ${json.length} chars)`), "stale original-size label gone");
	assert.match(prompt, /"contentOmitted": "source content omitted here/);
});

test("the default prompt budget keeps oversized tasks within danso's prompt limit", () => {
	const fx = fixture();
	try {
		const big = `${MESSAGE}\n${"가".repeat(38_000)}`;
		const result = runBridge(fx.env, { message: big });
		assert.equal(result.status, 0, result.stderr);
		const [record] = fx.records();
		assert.ok(Buffer.byteLength(record.argv.at(-1), "utf8") <= 65536);
		assert.match(record.argv.at(-1), /truncated by danso-a2a-analysis-bridge prompt budget/);
	} finally {
		fx.cleanup();
	}
});

test("timeouts above danso's short-mode maximum are clamped to 3600s", () => {
	const fx = fixture();
	try {
		const result = spawnSync(process.execPath, [
			BRIDGE, "agent", "--session-id", "t", "--message", MESSAGE, "--timeout", "99999", "--json",
		], { env: fx.env, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		const { argv } = fx.records()[0];
		assert.equal(argv[argv.indexOf("--timeout-seconds") + 1], "3600");
	} finally {
		fx.cleanup();
	}
});

test("a declared-required payload carrier that is unreadable fails closed (#2023 parity)", () => {
	const fx = fixture();
	try {
		const result = runBridge(fx.env, { message: `${MESSAGE}\nA2A_PAYLOAD_CARRIER_REQUIRED=/nonexistent/payload.json` });
		assert.equal(result.status, 1);
		assert.equal(bridgeErrorOf(result.stderr).code, "analysis_payload_carrier_missing");
		assert.equal(fx.records().length, 0);
	} finally {
		fx.cleanup();
	}
});

test("resolveDansoConfig defaults to glm / glm-5.3-flash / high and lets *_ANALYSIS_* win", () => {
	assert.deepEqual(
		(({ provider, model, effort, credentialEnv }) => ({ provider, model, effort, credentialEnv }))(__test.resolveDansoConfig({})),
		{ provider: "glm", model: "glm-5.3-flash", effort: "high", credentialEnv: "ZAI_API_KEY" },
	);
	const config = __test.resolveDansoConfig({
		A2A_DANSO_MODEL: "generic", A2A_DANSO_ANALYSIS_MODEL: "analysis-pin",
		A2A_DANSO_EFFORT: "low", A2A_DANSO_ANALYSIS_EFFORT: "MAX",
	});
	assert.equal(config.model, "analysis-pin");
	assert.equal(config.effort, "max");
	assert.equal(__test.resolveDansoConfig({ A2A_DANSO_PROVIDER: "anthropic" }).effort, "", "anthropic takes no effort");
	assert.throws(() => __test.resolveDansoConfig({ A2A_DANSO_PROVIDER: "pi" }), /unsupported danso provider/);
});

test("extractContractJson prefers the whole answer, then the last contract-shaped object", () => {
	assert.equal(__test.extractContractJson('{"status":"blocked","summary":"s"}').status, "blocked");
	assert.equal(
		__test.extractContractJson('{"status":"done","summary":"first"} then {"status":"done","summary":"second"}').summary,
		"second",
	);
	// Braces inside strings do not confuse the scanner.
	assert.equal(__test.extractContractJson('x {"status":"done","summary":"a } b { c"} y').summary, "a } b { c");
	assert.throws(() => __test.extractContractJson(""), /empty final answer/);
	assert.throws(() => __test.extractContractJson('{"summary":"no status"}'), /no contract-shaped JSON/);
});

test("parseDansoStderrRecord trusts exactly one record and never guesses", () => {
	assert.deepEqual(parseDansoStderrRecord('noise\nPIRI_USAGE={"requests":2}\n', "PIRI_USAGE"), { requests: 2 });
	assert.equal(parseDansoStderrRecord('PIRI_USAGE={"requests":2}\nPIRI_USAGE={"requests":3}', "PIRI_USAGE"), undefined);
	assert.equal(parseDansoStderrRecord("PIRI_USAGE=not-json", "PIRI_USAGE"), undefined);
	assert.equal(parseDansoStderrRecord("", "PIRI_USAGE"), undefined);
	const telemetry = dansoExecutionTelemetry('PIRI_USAGE={"requests":2}\nPIRI_USAGE={"requests":3}', 5);
	assert.equal(telemetry.modelRequests, undefined, "duplicated usage is dropped, not double-counted");
	assert.equal(telemetry.elapsedMs, 5);
});

test("dansoErrorCategory bounds unknown categories", () => {
	assert.equal(__test.dansoErrorCategory('DANSO_ERROR={"version":1,"category":"sandbox","exit_code":2}'), "sandbox");
	assert.equal(__test.dansoErrorCategory('DANSO_ERROR={"version":1,"category":"<script>","exit_code":2}'), "other");
	assert.equal(__test.dansoErrorCategory("nothing"), undefined);
});
