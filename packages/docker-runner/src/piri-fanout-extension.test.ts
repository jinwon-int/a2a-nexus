/**
 * Unit tests for the baked piri fanout extension (piri fanout WS2, #1836).
 *
 * policy.js is dependency-free ESM, so these tests import it under plain
 * node (no piri install needed). index.js imports piri-provided modules and
 * is therefore covered by static source assertions plus the Dockerfile bake
 * contract, mirroring how hermes-runner-dockerfile.test.ts pins image
 * invariants.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const extensionDir = new URL("../docker/piri-fanout-extension/", import.meta.url);
const indexSource = readFileSync(new URL("index.js", extensionDir), "utf8");
const agentsSource = readFileSync(new URL("agents.js", extensionDir), "utf8");
const piriDockerfile = readFileSync(new URL("../docker/piri-runner.Dockerfile", import.meta.url), "utf8");

const validEnv = {
	A2A_CONTAINED_SUBAGENTS_ENABLED: "1",
	A2A_CONTAINED_SUBAGENTS_MAX: "4",
	A2A_CONTAINED_SUBAGENTS_ROLES: "explorer, verifier",
	A2A_CONTAINED_SUBAGENTS_OUTPUT_BYTES: "12000",
	A2A_CONTAINED_SUBAGENTS_REASONS: "parallel-read, bounded-write",
	A2A_PIRI_TIMEOUT_SEC: "3600",
};

test("policy: a valid injected budget parses with roles/reasons deduped and trimmed", async () => {
	const { parseSubagentBudget } = await import(new URL("policy.js", extensionDir).href);
	const parsed = parseSubagentBudget(validEnv);
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.budget.maxParallelTasks, 4);
	assert.equal(parsed.budget.concurrency, 4);
	assert.equal(parsed.budget.perTaskOutputBytes, 12000);
	assert.deepEqual(parsed.budget.roles, ["explorer", "verifier"]);
	assert.deepEqual(parsed.budget.reasons, ["parallel-read", "bounded-write"]);
	assert.equal(parsed.budget.parentTimeoutSec, 3600);
});

test("policy: refuses when the lane did not opt in (env-input gap 1)", async () => {
	const { parseSubagentBudget } = await import(new URL("policy.js", extensionDir).href);
	for (const enabled of [undefined, "0", "", "true", "yes"]) {
		const parsed = parseSubagentBudget({ ...validEnv, A2A_CONTAINED_SUBAGENTS_ENABLED: enabled });
		assert.equal(parsed.ok, false, `ENABLED=${String(enabled)} must refuse`);
		if (parsed.ok) return;
		assert.equal(parsed.refusal, "a2a_piri_fanout_refused");
	}
});

test("policy: refuses when any required budget env is absent or invalid", async () => {
	const { parseSubagentBudget } = await import(new URL("policy.js", extensionDir).href);
	const cases: Array<[string, Record<string, string | undefined>]> = [
		["max absent", { ...validEnv, A2A_CONTAINED_SUBAGENTS_MAX: undefined }],
		["max non-integer", { ...validEnv, A2A_CONTAINED_SUBAGENTS_MAX: "2.5" }],
		["max zero", { ...validEnv, A2A_CONTAINED_SUBAGENTS_MAX: "0" }],
		["output bytes absent", { ...validEnv, A2A_CONTAINED_SUBAGENTS_OUTPUT_BYTES: undefined }],
		["output bytes invalid", { ...validEnv, A2A_CONTAINED_SUBAGENTS_OUTPUT_BYTES: "many" }],
		["roles absent", { ...validEnv, A2A_CONTAINED_SUBAGENTS_ROLES: undefined }],
		["roles blank", { ...validEnv, A2A_CONTAINED_SUBAGENTS_ROLES: " , ," }],
		["reasons absent", { ...validEnv, A2A_CONTAINED_SUBAGENTS_REASONS: undefined }],
		["reasons blank", { ...validEnv, A2A_CONTAINED_SUBAGENTS_REASONS: "  " }],
	];
	for (const [name, env] of cases) {
		const parsed = parseSubagentBudget(env);
		assert.equal(parsed.ok, false, `${name} must refuse`);
		if (parsed.ok) continue;
		assert.equal(parsed.refusal, "a2a_piri_fanout_refused");
		assert.ok(parsed.detail.length > 0);
	}
});

test("policy: example constants are convenience upper bounds only — never expansions", async () => {
	const { parseSubagentBudget, EXAMPLE_MAX_PARALLEL_TASKS, EXAMPLE_PER_TASK_OUTPUT_CAP } = await import(
		new URL("policy.js", extensionDir).href
	);
	// Absurd injected ceilings must not expand the example bounds.
	const parsed = parseSubagentBudget({
		...validEnv,
		A2A_CONTAINED_SUBAGENTS_MAX: "64",
		A2A_CONTAINED_SUBAGENTS_OUTPUT_BYTES: "999999",
	});
	assert.equal(parsed.ok, true);
	if (parsed.ok) {
		assert.equal(parsed.budget.maxParallelTasks, EXAMPLE_MAX_PARALLEL_TASKS);
		assert.equal(parsed.budget.perTaskOutputBytes, EXAMPLE_PER_TASK_OUTPUT_CAP);
	}
	// The injected budget also shrinks concurrency below the cap of 4.
	const shrunk = parseSubagentBudget({ ...validEnv, A2A_CONTAINED_SUBAGENTS_MAX: "2" });
	assert.equal(shrunk.ok, true);
	if (shrunk.ok) {
		assert.equal(shrunk.budget.maxParallelTasks, 2);
		assert.equal(shrunk.budget.concurrency, 2);
	}
	// Missing parent timeout falls back to the lane default.
	const noTimeout = parseSubagentBudget({ ...validEnv, A2A_PIRI_TIMEOUT_SEC: undefined });
	assert.equal(noTimeout.ok, true);
	if (noTimeout.ok) assert.equal(noTimeout.budget.parentTimeoutSec, 3600);
});

test("policy: per-child timeout defaults to ceil(parent/(n+1)), override capped at parent (gap 3)", async () => {
	const { resolveChildTimeoutSec } = await import(new URL("policy.js", extensionDir).href);
	assert.equal(resolveChildTimeoutSec({ parentTimeoutSec: 3600, childCount: 1 }), 1800);
	assert.equal(resolveChildTimeoutSec({ parentTimeoutSec: 3600, childCount: 3 }), 900);
	assert.equal(resolveChildTimeoutSec({ parentTimeoutSec: 3600, childCount: 7 }), 450);
	// A single child still keeps a margin for the parent finalizer.
	assert.equal(resolveChildTimeoutSec({ parentTimeoutSec: 10, childCount: 1 }), 5);
	// Overrides: honored, floored at 1s, hard-capped at the parent timeout.
	assert.equal(
		resolveChildTimeoutSec({ parentTimeoutSec: 3600, childCount: 4, overrideSec: "60" }),
		60,
	);
	assert.equal(
		resolveChildTimeoutSec({ parentTimeoutSec: 3600, childCount: 1, overrideSec: "9999" }),
		3600,
	);
	assert.equal(
		resolveChildTimeoutSec({ parentTimeoutSec: 3600, childCount: 4, overrideSec: "0" }),
		720, // invalid override (0) falls back to the default share
	);
	assert.equal(resolveChildTimeoutSec({ parentTimeoutSec: 2, childCount: 9, overrideSec: undefined }), 1);
});

test("policy: output truncation respects the byte cap without splitting code points", async () => {
	const { truncateOutputBytes } = await import(new URL("policy.js", extensionDir).href);
	const ascii = "a".repeat(3000);
	const truncated = truncateOutputBytes(ascii, 1024);
	assert.ok(truncated.startsWith("a".repeat(1024)));
	assert.ok(truncated.includes("bytes omitted"));
	// Multibyte: never splits a code point at the cap boundary.
	const multibyte = "한".repeat(600); // 3 bytes each = 1800 bytes
	const cut = truncateOutputBytes(multibyte, 1024);
	assert.equal(Buffer.byteLength(cut.split("\n")[0], "utf8"), 1023); // 341 chars * 3
	// At or under the cap: unchanged.
	assert.equal(truncateOutputBytes("short", 1024), "short");
});

test("index.js pins agent scope to user and refuses project/both (gap 5)", () => {
	assert.match(indexSource, /agentScope must be pinned|pins agentScope to "user"/);
	assert.match(indexSource, /requestedScope !== "user"/);
	assert.match(indexSource, /agentScope="\$\{requestedScope\}" is not permitted/);
	// The example's project-agent confirmation path is gone: no UI prompt.
	assert.doesNotMatch(indexSource, /confirmProjectAgents/);
	assert.doesNotMatch(indexSource, /ctx\.ui\.confirm/);
});

test("index.js enforces the per-child timeout ladder and inherited env (gaps 1+3)", () => {
	// Budget refusal happens before any spawn.
	assert.match(indexSource, /parseSubagentBudget\(process\.env\)/);
	assert.match(indexSource, /error=\$\{parsed\.refusal\}/);
	// Per-child timeout wiring + SIGTERM -> 5s -> SIGKILL ladder.
	assert.match(indexSource, /resolveChildTimeoutSec\(\{/);
	assert.match(indexSource, /CHILD_TIMEOUT_EXIT_CODE = 124/);
	assert.match(indexSource, /SIGTERM/);
	assert.match(indexSource, /SIGKILL/);
	assert.match(indexSource, /KILL_GRACE_MS = 5000/);
	// Parallel clamp comes from the budget, not the example constant.
	assert.match(indexSource, /params\.tasks\.length > budget\.maxParallelTasks/);
	assert.match(indexSource, /budget\.concurrency/);
	assert.match(indexSource, /budget\.perTaskOutputBytes/);
	// Children: JSON mode, print mode, no session, and NO env override.
	assert.match(indexSource, /"--mode", "json", "-p", "--no-session"/);
	const spawnOptions = indexSource.match(/spawn\(invocation\.command,[\s\S]{0,400}/)?.[0] ?? "";
	assert.ok(spawnOptions.length > 0, "spawn call must exist");
	assert.doesNotMatch(spawnOptions, /env\s*:/);
	// piri has no --max-turns; the extension must not invent one.
	assert.doesNotMatch(indexSource, /["']--max-turns["']/);
});

test("agents.js discovers only the host-controlled user roster (gap 5)", () => {
	assert.match(agentsSource, /getAgentDir\(\)/);
	// The example's project-scope discovery walk is deleted, not just discouraged.
	assert.doesNotMatch(agentsSource, /findNearestProjectAgentsDir/);
	assert.doesNotMatch(agentsSource, /"project"/);
	assert.doesNotMatch(agentsSource, /"both"/);
	assert.doesNotMatch(agentsSource, /AgentScope/);
	assert.match(agentsSource, /source: "user"/);
});

test("piri runner image bakes the hardened extension at the stable path (WS2)", () => {
	assert.match(piriDockerfile, /COPY docker\/piri-fanout-extension \/opt\/a2a-runner\/piri-fanout-extension/);
	assert.match(piriDockerfile, /chmod -R a\+rX \/opt\/a2a-runner\/piri-fanout-extension/);
	assert.match(piriDockerfile, /a2a-nexus#1836/);
	// Credentials stay runtime-mounted; the extension bake adds no secrets.
	assert.doesNotMatch(piriDockerfile, /COPY\s+.*secrets/i);
	assert.doesNotMatch(piriDockerfile, /ADD\s+.*secrets/i);
});
