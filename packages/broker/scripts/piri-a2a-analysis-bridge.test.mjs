import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { __test } from "./piri-a2a-analysis-bridge.mjs";

const BRIDGE = resolve(import.meta.dirname, "piri-a2a-analysis-bridge.mjs");

function makeConfigDir(dir) {
	const configDir = join(dir, "cfg");
	mkdirSync(join(configDir, "agent"), { recursive: true });
	writeFileSync(join(configDir, "agent", "auth.json"), "{}\n", { mode: 0o600 });
	return configDir;
}

function makeFakeDocker(dir, behavior) {
	const bin = join(dir, "fake-docker.mjs");
	writeFileSync(bin, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
const behavior = ${JSON.stringify(behavior)};
if (behavior.argsFile) writeFileSync(behavior.argsFile, JSON.stringify(process.argv.slice(2)));
const workMount = process.argv.slice(2).find((arg) => arg.endsWith(":/work"));
if (workMount && Array.isArray(behavior.progressLines)) {
  const workDir = workMount.slice(0, -":/work".length);
  mkdirSync(workDir + "/artifacts", { recursive: true });
  writeFileSync(workDir + "/artifacts/piri-progress.jsonl", behavior.progressLines.join("\\n") + "\\n");
}
if (behavior.stdout) process.stdout.write(behavior.stdout);
if (behavior.stderr) process.stderr.write(behavior.stderr);
process.exit(behavior.exitCode ?? 0);
`);
	chmodSync(bin, 0o755);
	return bin;
}

function runBridge(args, env) {
	return spawnSync(process.execPath, [BRIDGE, ...args], {
		env: { ...process.env, ...env },
		encoding: "utf8",
		timeout: 20000,
	});
}

function sampleMessage(payload) {
	return `Task message:\nAnalyze the thing\n\nPayload JSON:\n${JSON.stringify(payload, null, 2)}`;
}

test("extractPayload parses the Payload JSON section", () => {
	const payload = __test.extractPayload(sampleMessage({ repo: "jinwon-int/a2a-nexus", issue: "#1745" }));
	assert.equal(payload.repo, "jinwon-int/a2a-nexus");
	assert.equal(payload.issue, "#1745");
	assert.deepEqual(__test.extractPayload("no payload here"), {});
});

test("payloadFromStructuredEnv prefers the full payload file (excerpt-mode dispatch)", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-payload-file-"));
	try {
		const file = join(dir, "payload.json");
		writeFileSync(file, JSON.stringify({ repo: "jinwon-int/a2a-nexus", paths: ["a.ts"] }));
		const payload = __test.payloadFromStructuredEnv({ A2A_ANALYSIS_PAYLOAD_FILE: file });
		assert.equal(payload.repo, "jinwon-int/a2a-nexus");
		assert.equal(__test.payloadFromStructuredEnv({}), undefined);
		assert.throws(() => __test.payloadFromStructuredEnv({ A2A_ANALYSIS_PAYLOAD_FILE: join(dir, "missing.json") }), /does not exist/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("collectSourceBundle inlines #1880 contentRef detach files from the payload dir (#1891)", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-contentref-"));
	try {
		const splitDir = join(dir, "payload-files");
		mkdirSync(splitDir, { recursive: true });
		writeFileSync(join(splitDir, "000-case-a.ts"), "const detached = 1;\n");
		writeFileSync(join(splitDir, "001-case-b.ts"), "const detachedB = 2;\n");
		const payloadFile = join(dir, "payload.json");
		writeFileSync(payloadFile, JSON.stringify({ repo: "embedded" }));
		const payload = {
			sourceBundle: {
				files: [
					{ path: "cases/a.ts", contentRef: { path: join(splitDir, "000-case-a.ts"), bytes: 19, field: "content" } },
					{ path: "cases/b.ts", contentRef: { path: join(splitDir, "001-case-b.ts"), bytes: 20, field: "content" } },
				],
			},
		};
		const bundle = __test.collectSourceBundle(payload, { A2A_ANALYSIS_PAYLOAD_FILE: payloadFile });
		assert.equal(bundle.files.length, 2);
		assert.equal(bundle.files[0].repo, "embedded");
		assert.equal(bundle.files[0].path, "cases/a.ts");
		assert.equal(bundle.files[0].content, "const detached = 1;\n");
		assert.equal(bundle.files[1].content, "const detachedB = 2;\n");
		assert.deepEqual(bundle.warnings, []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("collectSourceBundle refuses contentRef paths outside the payload dir (#1891 fail-closed)", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-contentref-outside-"));
	try {
		const outside = join(dir, "outside.txt");
		writeFileSync(outside, "secret");
		const payloadDir = join(dir, "bridge");
		mkdirSync(payloadDir, { recursive: true });
		const payloadFile = join(payloadDir, "payload.json");
		writeFileSync(payloadFile, "{}");
		const payload = {
			sourceBundle: { files: [{ path: "x.ts", contentRef: { path: outside, bytes: 6, field: "content" } }] },
		};
		assert.throws(
			() => __test.collectSourceBundle(payload, { A2A_ANALYSIS_PAYLOAD_FILE: payloadFile }),
			/escapes the payload directory/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("collectSourceBundle fails fast when a contentRef file is missing (#1891)", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-contentref-missing-"));
	try {
		const payloadFile = join(dir, "payload.json");
		writeFileSync(payloadFile, "{}");
		const payload = {
			sourceBundle: { files: [{ path: "gone.ts", contentRef: { path: join(dir, "payload-files", "000-gone.ts"), bytes: 1, field: "content" } }] },
		};
		assert.throws(
			() => __test.collectSourceBundle(payload, { A2A_ANALYSIS_PAYLOAD_FILE: payloadFile }),
			/contentRef file is unreadable/,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("collectSourceBundle refuses contentRef without the payload-file carrier (#1891)", () => {
	const payload = {
		sourceBundle: { files: [{ path: "x.ts", contentRef: { path: "/tmp/anywhere.txt", bytes: 1, field: "content" } }] },
	};
	assert.throws(() => __test.collectSourceBundle(payload, {}), /requires the payload-file carrier/);
});

test("collectSourceBundle applies the per-file byte cap to detached content (#1891)", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-contentref-cap-"));
	try {
		const splitDir = join(dir, "payload-files");
		mkdirSync(splitDir, { recursive: true });
		writeFileSync(join(splitDir, "000-big.ts"), "x".repeat(4096));
		const payloadFile = join(dir, "payload.json");
		writeFileSync(payloadFile, "{}");
		const payload = {
			sourceBundle: { files: [{ path: "big.ts", contentRef: { path: join(splitDir, "000-big.ts"), bytes: 4096, field: "content" } }] },
		};
		const bundle = __test.collectSourceBundle(payload, {
			A2A_ANALYSIS_PAYLOAD_FILE: payloadFile,
			A2A_PIRI_ANALYSIS_MAX_FILE_BYTES: "1024",
		});
		assert.equal(bundle.files.length, 1);
		assert.equal(bundle.files[0].truncated, true);
		assert.equal(bundle.files[0].bytes, 4096);
		assert.equal(Buffer.byteLength(bundle.files[0].content, "utf8"), 1024);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("collectSourceBundle prefers inline content over contentRef (#1891)", () => {
	const payload = {
		sourceBundle: {
			files: [{ path: "a.ts", content: "inline wins", contentRef: { path: "/nonexistent/000-a.ts", bytes: 11, field: "content" } }],
		},
	};
	const bundle = __test.collectSourceBundle(payload, {});
	assert.equal(bundle.files.length, 1);
	assert.equal(bundle.files[0].content, "inline wins");
});

test("unreadable contentRef fails closed before any docker invocation (#1891)", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-contentref-flow-"));
	try {
		const payloadFile = join(dir, "payload.json");
		writeFileSync(payloadFile, JSON.stringify({
			sourceBundle: { files: [{ path: "gone.ts", contentRef: { path: join(dir, "payload-files", "000-gone.ts"), bytes: 1, field: "content" } }] },
		}));
		const result = runBridge(
			["agent", "--local", "--agent", "t", "--session-id", "s", "--message", "review", "--model", "m", "--thinking", "high", "--json"],
			{ A2A_ANALYSIS_PAYLOAD_FILE: payloadFile },
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /contentRef/);
		assert.equal(result.stdout.trim(), "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildPiriPrompt embeds source bundle and schema instruction", () => {
	const prompt = __test.buildPiriPrompt({
		message: "msg",
		payload: { repo: "x/y" },
		sourceBundle: { files: [{ repo: "x/y", path: "a.ts", content: "const a = 1;", truncated: false }], warnings: ["w1"] },
		flags: { "session-id": "s1" },
		model: "kimi-coding/k3",
		thinking: "high",
	});
	assert.match(prompt, /output schema/);
	assert.match(prompt, /### x\/y:a\.ts/);
	assert.match(prompt, /const a = 1;/);
	assert.match(prompt, /- w1/);
});

test("buildPiriPrompt requires a top-level verdict for review tasks", () => {
	const prompt = __test.buildPiriPrompt({
		message: "review",
		payload: { review: { required: true } },
		sourceBundle: { files: [], warnings: [] },
		flags: {},
		model: "kimi-coding/k3",
		thinking: "high",
	});
	assert.match(prompt, /top-level verdict field is REQUIRED/);
});

test("normalizeResponse enforces the operative contract shape", () => {
	const ok = __test.normalizeResponse({
		status: "done",
		summary: "s",
		findings: ["f"],
		risks: [],
		recommendations: ["r"],
		evidenceRefs: ["#1"],
		verdict: "BLOCK",
		confidence: "high", // dropped
	});
	assert.deepEqual(ok, { status: "done", summary: "s", findings: ["f"], risks: [], recommendations: ["r"], evidenceRefs: ["#1"], verdict: "fail" });
	assert.throws(() => __test.normalizeResponse({ status: "maybe", summary: "s" }), /done\|blocked/);
});

test("piri output schema permits the independent review verdict carrier", () => {
	const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../docker-runner/docker/piri-analysis-output.schema.json"), "utf8"));
	assert.deepEqual(schema.properties.verdict.enum, ["pass", "fail", "PASS", "BLOCK"]);
});

test("full flow emits the OpenClaw envelope around schema-valid piri output", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-bridge-"));
	try {
		const contract = { status: "done", summary: "분석 완료", findings: ["f1"], risks: [], recommendations: ["r1"], evidenceRefs: ["#1745"], verdict: "PASS" };
		const docker = makeFakeDocker(dir, {
			argsFile: join(dir, "docker-args.json"),
			stdout: `${JSON.stringify(contract)}\n`,
			progressLines: [
				JSON.stringify({ type: "turn_start" }),
				JSON.stringify({ type: "tool_execution_start", tool: "read" }),
				JSON.stringify({ type: "turn_start" }),
				JSON.stringify({ type: "marker", marker: "output_schema_retry" }),
				// jinwon-int/piri#14 terminal usage marker: its request count
				// covers the schema-retry round-trip the turn count misses.
				JSON.stringify({
					type: "marker",
					marker: "usage",
					requests: 3,
					inputTokens: 1200,
					outputTokens: 340,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 1540,
					costUsd: 0.0042,
					models: ["kimi-coding/k3"],
				}),
			],
		});
		const workRoot = join(dir, "tasks");
		const configDir = makeConfigDir(dir);
		const child = runBridge(
			["agent", "--local", "--session-id", "sess-1", "--message", sampleMessage({ embeddedSourceEvidence: [{ path: "a.ts", content: "x" }] }), "--model", "m", "--thinking", "t", "--timeout", "30", "--json"],
			{ A2A_PIRI_DOCKER_BIN: docker, A2A_PIRI_WORK_ROOT: workRoot, A2A_PIRI_CONFIG_DIR: configDir },
		);
		assert.equal(child.status, 0, child.stderr);
		const envelope = JSON.parse(child.stdout);
		const response = JSON.parse(envelope.payloads[0].text);
		assert.deepEqual(response, {
			...contract,
			verdict: "pass",
			bridgeAdapter: "piri",
			bridgeContractVersion: "piri-a2a-analysis.v1",
			requestedModel: "m",
			requestedThinking: "t",
			actualRuntimeModel: "kimi-coding/k3",
			modelInheritanceMode: "bridge_env_pin",
			executionTelemetry: response.executionTelemetry,
		});
		assert.equal(response.bridgeAdapter, "piri");
		assert.equal(response.requestedModel, "m");
		assert.equal(response.actualRuntimeModel, "kimi-coding/k3");
		assert.equal(response.modelInheritanceMode, "bridge_env_pin");
		assert.equal(response.executionTelemetry.source, "piri_progress_file");
		assert.equal(response.executionTelemetry.modelRequests, 3);
		assert.equal(response.executionTelemetry.toolCalls, 1);
		assert.equal(response.executionTelemetry.schemaRetries, 1);
		assert.equal(response.executionTelemetry.inputTokens, 1200);
		assert.equal(response.executionTelemetry.outputTokens, 340);
		assert.equal(response.executionTelemetry.costUsd, 0.0042);
		// prompt file landed in the host workdir for the run
		const promptFile = join(workRoot, "sess-1", "prompt.md");
		assert.equal(existsSync(promptFile), true);
		assert.match(readFileSync(promptFile, "utf8"), /output schema/);
		const dockerArgs = JSON.parse(readFileSync(join(dir, "docker-args.json"), "utf8"));
		assert.ok(dockerArgs.includes(`${join(configDir, "agent", "auth.json")}:/work/piri-home/.piri/agent/auth.json:ro`));
		assert.doesNotMatch(dockerArgs.join(" "), /run\/secrets\/piri-dir|cp -a/);
		assert.equal(existsSync(join(workRoot, "sess-1", "piri-home", ".piri", "agent", "auth.json")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("schema exhaustion (piri exit 4) maps to a structured provider_or_model_failure", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-bridge-"));
	try {
		const docker = makeFakeDocker(dir, { exitCode: 4, stderr: "--output-schema not satisfied after 3 attempt(s)\n" });
		const configDir = makeConfigDir(dir);
		const child = runBridge(
			["agent", "--local", "--message", sampleMessage({}), "--timeout", "30", "--json"],
			{ A2A_PIRI_DOCKER_BIN: docker, A2A_PIRI_WORK_ROOT: join(dir, "tasks"), A2A_PIRI_CONFIG_DIR: configDir },
		);
		assert.equal(child.status, 1);
		const line = child.stderr.split("\n").find((l) => l.startsWith("A2A_BRIDGE_ERROR="));
		const detail = JSON.parse(line.slice("A2A_BRIDGE_ERROR=".length));
		assert.equal(detail.code, "analysis_bridge_schema_unsatisfied");
		assert.equal(detail.stage, "validate");
		assert.equal(detail.failureShape, "provider_or_model_failure");
		assert.equal(detail.adapterClass, "piri");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("failure records carry execution telemetry, model fields, and source counts (#1725/#1815)", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-bridge-"));
	try {
		const docker = makeFakeDocker(dir, {
			exitCode: 4,
			stderr: "--output-schema not satisfied after 3 attempt(s)\n",
			progressLines: [
				JSON.stringify({ ts: "t", type: "turn_start" }),
				JSON.stringify({ ts: "t", type: "marker", marker: "output_schema_retry", attempt: 1, maxAttempts: 3, errors: ["/ : Unexpected property"] }),
				JSON.stringify({ ts: "t", type: "marker", marker: "output_schema_retry", attempt: 2, maxAttempts: 3, errors: ["/status: Expected union value"] }),
				JSON.stringify({ ts: "t", type: "marker", marker: "usage", requests: 4, inputTokens: 10, outputTokens: 5 }),
			],
		});
		const configDir = makeConfigDir(dir);
		const child = runBridge(
			["agent", "--local", "--message", sampleMessage({}), "--model", "kimi-coding/k3", "--thinking", "low", "--timeout", "30", "--json"],
			{
				A2A_PIRI_DOCKER_BIN: docker,
				A2A_PIRI_WORK_ROOT: join(dir, "tasks"),
				A2A_PIRI_CONFIG_DIR: configDir,
				A2A_PIRI_MODEL: "zai/glm-5.2",
				A2A_ANALYSIS_SOURCE_CARRIER_STATS: JSON.stringify({ sourceFiles: 3, totalFiles: 3, totalBytes: 4096 }),
			},
		);
		assert.equal(child.status, 1);
		const detail = JSON.parse(child.stderr.split("\n").find((l) => l.startsWith("A2A_BRIDGE_ERROR=")).slice("A2A_BRIDGE_ERROR=".length));
		assert.equal(detail.code, "analysis_bridge_schema_unsatisfied");
		// requested/actual model split survives into the failure record.
		assert.equal(detail.requestedModel, "kimi-coding/k3");
		assert.equal(detail.requestedThinking, "low");
		assert.equal(detail.actualRuntimeModel, "zai/glm-5.2");
		assert.equal(detail.modelInheritanceMode, "bridge_env_pin");
		// source counts echo what the lane actually saw.
		assert.deepEqual(detail.sourceCarrierStats, { sourceFiles: 3, totalFiles: 3, totalBytes: 4096 });
		// execution telemetry incl. the classified schema-retry reasons.
		assert.equal(detail.executionTelemetry.schemaVersion, "a2a.analysis-execution-telemetry.v1");
		assert.equal(detail.executionTelemetry.source, "piri_progress_file");
		assert.equal(detail.executionTelemetry.schemaRetries, 2);
		assert.deepEqual(detail.executionTelemetry.schemaRetryReasons, { extra_property: 1, invalid_value: 1 });
		assert.equal(detail.executionTelemetry.modelRequests, 4);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("provider failure (piri exit 3) maps to analysis_bridge_provider_failure", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-bridge-"));
	try {
		const docker = makeFakeDocker(dir, { exitCode: 3, stderr: "Request error: 401 unauthorized\n" });
		const configDir = makeConfigDir(dir);
		const child = runBridge(
			["agent", "--local", "--message", sampleMessage({}), "--timeout", "30", "--json"],
			{ A2A_PIRI_DOCKER_BIN: docker, A2A_PIRI_WORK_ROOT: join(dir, "tasks"), A2A_PIRI_CONFIG_DIR: configDir },
		);
		assert.equal(child.status, 1);
		const detail = JSON.parse(child.stderr.split("\n").find((l) => l.startsWith("A2A_BRIDGE_ERROR=")).slice(17));
		assert.equal(detail.code, "analysis_bridge_provider_failure");
		assert.equal(detail.stage, "invoke");
		assert.equal(detail.failureShape, "provider_or_model_failure");
		assert.equal(detail.adapterClass, "piri");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("other non-zero exits (pre-contract piri exit 1) map to analysis_bridge_internal_error", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-bridge-"));
	try {
		const docker = makeFakeDocker(dir, { exitCode: 1, stderr: "unexpected failure\n" });
		const configDir = makeConfigDir(dir);
		const child = runBridge(
			["agent", "--local", "--message", sampleMessage({}), "--timeout", "30", "--json"],
			{ A2A_PIRI_DOCKER_BIN: docker, A2A_PIRI_WORK_ROOT: join(dir, "tasks"), A2A_PIRI_CONFIG_DIR: configDir },
		);
		assert.equal(child.status, 1);
		const detail = JSON.parse(child.stderr.split("\n").find((l) => l.startsWith("A2A_BRIDGE_ERROR=")).slice(17));
		assert.equal(detail.code, "analysis_bridge_internal_error");
		assert.equal(detail.stage, "invoke");
		assert.equal(detail.failureShape, "provider_or_model_failure");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("piri usage error (exit 2) maps to handler_artifact_failure", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-bridge-"));
	try {
		const docker = makeFakeDocker(dir, { exitCode: 2, stderr: "Invalid --output-schema\n" });
		const configDir = makeConfigDir(dir);
		const child = runBridge(
			["agent", "--local", "--message", sampleMessage({}), "--timeout", "30", "--json"],
			{ A2A_PIRI_DOCKER_BIN: docker, A2A_PIRI_WORK_ROOT: join(dir, "tasks"), A2A_PIRI_CONFIG_DIR: configDir },
		);
		assert.equal(child.status, 1);
		const detail = JSON.parse(child.stderr.split("\n").find((l) => l.startsWith("A2A_BRIDGE_ERROR=")).slice(17));
		assert.equal(detail.code, "analysis_bridge_invocation_invalid");
		assert.equal(detail.failureShape, "handler_artifact_failure");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("missing piri credential fails closed before docker invocation", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-bridge-"));
	try {
		const child = runBridge(
			["agent", "--local", "--message", sampleMessage({}), "--timeout", "30", "--json"],
			{ A2A_PIRI_DOCKER_BIN: "/nonexistent/docker", A2A_PIRI_WORK_ROOT: join(dir, "tasks"), A2A_PIRI_CONFIG_DIR: join(dir, "missing") },
		);
		assert.equal(child.status, 1);
		const detail = JSON.parse(child.stderr.split("\n").find((line) => line.startsWith("A2A_BRIDGE_ERROR=")).slice(17));
		assert.equal(detail.code, "analysis_bridge_credential_unavailable");
		assert.equal(detail.stage, "preflight");
		assert.equal(detail.failureShape, "handler_artifact_failure");
		// Pre-invocation failures still carry the resolved model fields but no
		// execution telemetry (the run never started).
		assert.equal(detail.actualRuntimeModel, "kimi-coding/k3");
		assert.equal(detail.modelInheritanceMode, "bridge_env_pin");
		assert.equal(detail.executionTelemetry, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("missing --message fails before any docker invocation", () => {
	const child = runBridge(["agent", "--local", "--json"], { A2A_PIRI_DOCKER_BIN: "/nonexistent/docker" });
	assert.equal(child.status, 1);
	assert.match(child.stderr, /missing --message/);
});

// ── Schema-retry reason telemetry (#1815 item 1) ─────────────────────────
// Bounded-enum classification of piri's output_schema_retry markers; the
// marker's validator errors are classified here, never relayed raw, so lane
// telemetry stays content-free while naming the dominant failure shape.

import {
	classifySchemaRetryErrors,
	piriExecutionTelemetry,
	normalizeAnalysisExecutionTelemetry,
	SCHEMA_RETRY_REASONS,
} from "./lib/analysis-execution-telemetry.mjs";

test("classifySchemaRetryErrors maps validator error shapes onto the bounded enum (#1815)", () => {
	// Empty error list: the model's text had no extractable JSON candidate at
	// all (markdown/wrapper shape).
	assert.equal(classifySchemaRetryErrors([]), "no_json_candidate");
	assert.equal(classifySchemaRetryErrors(undefined), "no_json_candidate");
	assert.equal(classifySchemaRetryErrors(["output candidate was not parseable JSON"]), "no_json_candidate");
	// additionalProperties:false violations.
	assert.equal(
		classifySchemaRetryErrors(["/ : Unexpected property", "/ : Unexpected external member"]),
		"extra_property",
	);
	// Deployed-field shapes: the pinned piri's TypeBox Compile emits "must not
	// have additional properties" — captured from retained worker-host
	// clinical-lane progress files (2026-08-16), where it is the DOMINANT retry
	// shape (every observed output_schema_retry carried it). Before this fix
	// those markers fell through the path-prefix match to invalid_value.
	assert.equal(
		classifySchemaRetryErrors(["/: must not have additional properties"]),
		"extra_property",
	);
	assert.equal(
		classifySchemaRetryErrors(["/: must not have additional properties", "/status: must be string"]),
		"extra_property",
	);
	// Root type mismatch (model returned a non-object root) stays invalid_value.
	assert.equal(classifySchemaRetryErrors(["/: must be object"]), "invalid_value");
	// required-field violations.
	assert.equal(classifySchemaRetryErrors(["/findings: Expected required property"]), "missing_field");
	// enum/type/value violations.
	assert.equal(
		classifySchemaRetryErrors(["/status: Expected union value", "/summary: Expected string"]),
		"invalid_value",
	);
	// provider-side failure text wins before shape classification.
	assert.equal(
		classifySchemaRetryErrors(["provider request failed after 3 attempts", "/status: Expected union value"]),
		"provider_failure",
	);
	// unknown shapes fall into other, still bounded.
	assert.equal(classifySchemaRetryErrors(["something novel happened"]), "other");
	assert.ok(SCHEMA_RETRY_REASONS.includes("other"));
});

test("piriExecutionTelemetry counts bounded retry reasons from progress markers (#1815)", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-retry-reasons-"));
	try {
		const progressPath = join(dir, "piri-progress.jsonl");
		writeFileSync(
			progressPath,
			[
				JSON.stringify({ ts: "t", type: "turn_start" }),
				JSON.stringify({ ts: "t", type: "marker", marker: "output_schema_retry", attempt: 1, maxAttempts: 3, errors: ["/ : Unexpected property"] }),
				JSON.stringify({ ts: "t", type: "marker", marker: "output_schema_retry", attempt: 2, maxAttempts: 3, errors: ["/status: Expected union value"] }),
				JSON.stringify({ ts: "t", type: "marker", marker: "output_schema_retry", attempt: 3, maxAttempts: 3, errors: [] }),
				JSON.stringify({ ts: "t", type: "marker", marker: "usage", requests: 4, inputTokens: 10, outputTokens: 5 }),
			].join("\n") + "\n",
		);
		const telemetry = piriExecutionTelemetry(progressPath, 1234);
		assert.equal(telemetry.schemaRetries, 3);
		assert.deepEqual(telemetry.schemaRetryReasons, { extra_property: 1, invalid_value: 1, no_json_candidate: 1 });

		// Round-trip through the task-handler normalizer keeps the bounded map
		// and drops nothing.
		const normalized = normalizeAnalysisExecutionTelemetry(telemetry);
		assert.deepEqual(normalized.schemaRetryReasons, telemetry.schemaRetryReasons);

		// A run with no retries stays clean — no empty map on the wire.
		writeFileSync(progressPath, JSON.stringify({ type: "turn_start" }) + "\n");
		const clean = piriExecutionTelemetry(progressPath, 10);
		assert.equal(clean.schemaRetries, 0);
		assert.equal(clean.schemaRetryReasons, undefined);
		assert.equal(normalizeAnalysisExecutionTelemetry(clean).schemaRetryReasons, undefined);

		// The normalizer rejects unknown enum keys instead of passing them on.
		const forged = normalizeAnalysisExecutionTelemetry({
			schemaVersion: "a2a.analysis-execution-telemetry.v1",
			source: "piri_progress_file",
			schemaRetryReasons: { not_an_enum_key: 2, invalid_value: "x", other: 1 },
		});
		assert.deepEqual(forged.schemaRetryReasons, { other: 1 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
