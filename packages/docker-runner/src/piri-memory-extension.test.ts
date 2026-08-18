/**
 * Unit tests for the baked piri memory-injection extension
 * (a2a-nexus#1797 item 3a — nunchi/MemPalace memory injection porting).
 *
 * policy.js is dependency-free ESM, so these tests import it under plain
 * node (no piri install needed). index.js imports piri-provided modules and
 * is therefore covered by static source assertions plus the Dockerfile bake
 * contract, mirroring piri-fanout-extension.test.ts.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const extensionDir = new URL("../docker/piri-memory-extension/", import.meta.url);
const indexSource = readFileSync(new URL("index.js", extensionDir), "utf8");
const piriDockerfile = readFileSync(new URL("../docker/piri-runner.Dockerfile", import.meta.url), "utf8");

test("policy: refuses unless the lane explicitly opted in", async () => {
	const { parseMemoryConfig } = await import(new URL("policy.js", extensionDir).href);
	for (const enabled of [undefined, "0", "", "true", "yes"]) {
		const parsed = parseMemoryConfig({ A2A_PIRI_MEMORY_ENABLED: enabled });
		assert.equal(parsed.ok, false, `ENABLED=${String(enabled)} must refuse`);
		if (parsed.ok) return;
		assert.equal(parsed.refusal, "a2a_piri_memory_refused");
	}
});

test("policy: opt-in with defaults yields the default bounded contract", async () => {
	const { parseMemoryConfig, DEFAULT_MEMORY_FILE, DEFAULT_MAX_BYTES } = await import(
		new URL("policy.js", extensionDir).href
	);
	const parsed = parseMemoryConfig({ A2A_PIRI_MEMORY_ENABLED: "1" });
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.config.file, DEFAULT_MEMORY_FILE);
	assert.equal(parsed.config.maxBytes, DEFAULT_MAX_BYTES);
	assert.equal(DEFAULT_MEMORY_FILE, "/work/memory.md");
});

test("policy: custom file and max-bytes parse when valid", async () => {
	const { parseMemoryConfig } = await import(new URL("policy.js", extensionDir).href);
	const parsed = parseMemoryConfig({
		A2A_PIRI_MEMORY_ENABLED: "1",
		A2A_PIRI_MEMORY_FILE: "/run/secrets/piri-memory/MEMORY.md",
		A2A_PIRI_MEMORY_MAX_BYTES: "65536",
	});
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.config.file, "/run/secrets/piri-memory/MEMORY.md");
	assert.equal(parsed.config.maxBytes, 65536);
});

test("policy: memory file must stay under an allowlisted root (no secret or system paths)", async () => {
	const { parseMemoryConfig } = await import(new URL("policy.js", extensionDir).href);
	const refused = [
		"/etc/passwd",
		"/run/secrets/piri-dir/agent/auth.json",
		"/run/secrets/other/x",
		"relative/memory.md",
		"/work/../etc/shadow",
		"/workx/memory.md",
	];
	for (const file of refused) {
		const parsed = parseMemoryConfig({ A2A_PIRI_MEMORY_ENABLED: "1", A2A_PIRI_MEMORY_FILE: file });
		assert.equal(parsed.ok, false, `file=${file} must refuse`);
		if (parsed.ok) continue;
		assert.equal(parsed.refusal, "a2a_piri_memory_file_refused");
	}
	for (const file of ["/work/memory.md", "/work/nested/MEMORY.md", "/run/secrets/piri-memory/MEMORY.md"]) {
		const parsed = parseMemoryConfig({ A2A_PIRI_MEMORY_ENABLED: "1", A2A_PIRI_MEMORY_FILE: file });
		assert.equal(parsed.ok, true, `file=${file} must be accepted`);
	}
});

test("policy: max-bytes clamps to the hard ceiling and refuses non-numeric values", async () => {
	const { parseMemoryConfig, MAX_BYTES_CEILING } = await import(new URL("policy.js", extensionDir).href);
	const clamped = parseMemoryConfig({
		A2A_PIRI_MEMORY_ENABLED: "1",
		A2A_PIRI_MEMORY_MAX_BYTES: String(MAX_BYTES_CEILING * 4),
	});
	assert.equal(clamped.ok, true);
	if (clamped.ok) assert.equal(clamped.config.maxBytes, MAX_BYTES_CEILING);

	for (const bad of ["abc", "0", "-5", "1.5"]) {
		const parsed = parseMemoryConfig({
			A2A_PIRI_MEMORY_ENABLED: "1",
			A2A_PIRI_MEMORY_MAX_BYTES: bad,
		});
		assert.equal(parsed.ok, false, `MAX_BYTES=${JSON.stringify(bad)} must refuse`);
		if (!parsed.ok) assert.equal(parsed.refusal, "a2a_piri_memory_max_bytes_refused");
	}
});

test("index: injects via before_agent_start with bounded provenance-wrapped content", () => {
	// The extension appends the snapshot to the assembled system prompt with an
	// explicit boundary + provenance header, and never writes to stdout (the
	// print/json lane stdout is the machine-readable event stream).
	assert.match(indexSource, /before_agent_start/);
	assert.match(indexSource, /systemPrompt/);
	assert.match(indexSource, /<a2a-memory /);
	assert.match(indexSource, /<\/a2a-memory>/);
	assert.match(indexSource, /sha256/);
	assert.match(indexSource, /bytes=/);
	assert.doesNotMatch(indexSource, /process\.stdout\.write/);
});

test("index: degraded states are no-op with an artifact marker, never fatal", () => {
	// Absent/oversized/unreadable snapshots must not kill the task: the
	// extension stays inert and records the reason for the evidence stream.
	assert.match(indexSource, /piri-memory\.json/);
	assert.match(indexSource, /"absent"/);
	assert.match(indexSource, /"oversized"/);
	assert.match(indexSource, /"unreadable"/);
	assert.doesNotMatch(indexSource, /process\.exit/);
});

test("index: read is bounded — never buffers more than maxBytes + 1", () => {
	// Oversize detection must not read the whole file into memory unbounded.
	assert.match(indexSource, /maxBytes \+ 1/);
});

test("dockerfile: piri image bakes the memory extension read-only", () => {
	assert.match(piriDockerfile, /COPY docker\/piri-memory-extension \/opt\/a2a-runner\/piri-memory-extension/);
	assert.match(piriDockerfile, /chmod -R a\+rX \/opt\/a2a-runner\/piri-memory-extension/);
});
