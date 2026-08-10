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

test("normalizeResponse enforces the operative contract shape", () => {
	const ok = __test.normalizeResponse({
		status: "done",
		summary: "s",
		findings: ["f"],
		risks: [],
		recommendations: ["r"],
		evidenceRefs: ["#1"],
		confidence: "high", // dropped
	});
	assert.deepEqual(ok, { status: "done", summary: "s", findings: ["f"], risks: [], recommendations: ["r"], evidenceRefs: ["#1"] });
	assert.throws(() => __test.normalizeResponse({ status: "maybe", summary: "s" }), /done\|blocked/);
});

test("full flow emits the OpenClaw envelope around schema-valid piri output", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-bridge-"));
	try {
		const contract = { status: "done", summary: "분석 완료", findings: ["f1"], risks: [], recommendations: ["r1"], evidenceRefs: ["#1745"] };
		const docker = makeFakeDocker(dir, {
			argsFile: join(dir, "docker-args.json"),
			stdout: `${JSON.stringify(contract)}\n`,
			progressLines: [
				JSON.stringify({ type: "turn_start" }),
				JSON.stringify({ type: "tool_execution_start", tool: "read" }),
				JSON.stringify({ type: "turn_start" }),
				JSON.stringify({ type: "marker", marker: "output_schema_retry" }),
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
		assert.deepEqual(
			Object.fromEntries(Object.keys(contract).map((key) => [key, response[key]])),
			contract,
		);
		assert.equal(response.bridgeAdapter, "piri");
		assert.equal(response.requestedModel, "m");
		assert.equal(response.actualRuntimeModel, "kimi-coding/k3");
		assert.equal(response.modelInheritanceMode, "bridge_env_pin");
		assert.equal(response.executionTelemetry.source, "piri_progress_file");
		assert.equal(response.executionTelemetry.modelRequests, 2);
		assert.equal(response.executionTelemetry.toolCalls, 1);
		assert.equal(response.executionTelemetry.schemaRetries, 1);
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

test("schema exhaustion maps to a structured provider_or_model_failure", () => {
	const dir = mkdtempSync(join(tmpdir(), "piri-bridge-"));
	try {
		const docker = makeFakeDocker(dir, { exitCode: 1, stderr: "--output-schema not satisfied after 3 attempt(s)\n" });
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
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("missing --message fails before any docker invocation", () => {
	const child = runBridge(["agent", "--local", "--json"], { A2A_PIRI_DOCKER_BIN: "/nonexistent/docker" });
	assert.equal(child.status, 1);
	assert.match(child.stderr, /missing --message/);
});
