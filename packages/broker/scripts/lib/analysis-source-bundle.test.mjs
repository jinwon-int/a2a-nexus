// #2295: lib/analysis-source-bundle.mjs is lifted from the piri analysis bridge
// so the danso bridge does not grow a third private copy. Until the piri bridge
// is migrated onto the lib, these tests pin the two implementations to the same
// observable behavior: same payload parsing, same bundle for the same inputs
// when only the env prefix differs.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __test as piri } from "../piri-a2a-analysis-bridge.mjs";
import {
	collectSourceBundle,
	declaredRequiredCarrierPath,
	extractPayload,
	payloadFromStructuredEnv,
} from "./analysis-source-bundle.mjs";

function withRepo(fn) {
	const dir = mkdtempSync(join(tmpdir(), "analysis-source-bundle-"));
	try {
		const repo = join(dir, "repo");
		mkdirSync(join(repo, "src", "nested"), { recursive: true });
		writeFileSync(join(repo, "README.md"), "# readme\n", "utf8");
		writeFileSync(join(repo, "package.json"), '{"name":"x"}\n', "utf8");
		writeFileSync(join(repo, "src", "a.mjs"), "export const a = 1;\n", "utf8");
		writeFileSync(join(repo, "src", "nested", "b.mjs"), `export const b = "${"한".repeat(4000)}";\n`, "utf8");
		const payloadDir = join(dir, "payload");
		mkdirSync(join(payloadDir, "payload-files"), { recursive: true });
		const detached = join(payloadDir, "payload-files", "big.txt");
		writeFileSync(detached, "detached ".repeat(3000), "utf8");
		const payloadFile = join(payloadDir, "payload.json");
		writeFileSync(payloadFile, "{}", "utf8");
		fn({ dir, repo, detached, payloadFile });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Rename A2A_PIRI_ANALYSIS_* to the danso prefix, leaving everything else. */
function asDansoEnv(env) {
	return Object.fromEntries(Object.entries(env).map(([key, value]) => [
		key.replace(/^A2A_PIRI_ANALYSIS_/, "A2A_DANSO_ANALYSIS_"),
		value,
	]));
}

test("payload parsing matches the piri bridge", () => {
	const messages = [
		'x Payload JSON: {"assignment":"a","repo":"o/r"} trailing',
		"no payload marker at all",
		'Payload JSON:\n{"nested":{"s":"} still string {"}}',
		"A2A_PAYLOAD_CARRIER_REQUIRED=/tmp/p.json rest",
	];
	for (const message of messages) {
		assert.deepEqual(extractPayload(message), piri.extractPayload(message), message);
		assert.equal(declaredRequiredCarrierPath(message), piri.declaredRequiredCarrierPath(message), message);
	}
	assert.throws(() => extractPayload("Payload JSON: [1,2]"), /could not parse task Payload JSON/);
	assert.throws(() => piri.extractPayload("Payload JSON: [1,2]"), /could not parse task Payload JSON/);
	assert.equal(payloadFromStructuredEnv({}), piri.payloadFromStructuredEnv({}));
});

test("collectSourceBundle matches the piri bridge across repo, tree, embedded, contentRef and limit cases", () => {
	withRepo(({ repo, detached, payloadFile }) => {
		const cases = [
			{
				name: "default paths from repo root",
				payload: { repo: "o/r", assignment: "look" },
				env: { A2A_ANALYSIS_REPO_ROOT: repo },
			},
			{
				name: "explicit file + directory walk with byte cap",
				payload: { repo: "o/r", paths: ["README.md", "src", "../escape", "/abs"] },
				env: { A2A_ANALYSIS_REPO_ROOT: repo, A2A_PIRI_ANALYSIS_MAX_FILE_BYTES: "500" },
			},
			{
				name: "repo map + bridge-prefixed file limit",
				payload: { repos: [{ repo: "o/r", paths: ["src"] }], evidenceRefs: ["repo:o/other#1"] },
				env: { A2A_ANALYSIS_REPO_MAP_JSON: JSON.stringify({ "o/r": repo }), A2A_PIRI_ANALYSIS_MAX_FILES: "1" },
			},
			{
				name: "hermes-family limit fallback",
				payload: { repo: "o/r", paths: ["src"] },
				env: { A2A_ANALYSIS_REPO_ROOT: repo, A2A_HERMES_ANALYSIS_MAX_TOTAL_BYTES: "700" },
			},
			{
				name: "embedded + detached contentRef",
				payload: {
					repo: "o/r",
					sourceBundle: {
						files: [
							{ path: "inline.txt", content: "inline" },
							{ path: "detached.txt", contentRef: { path: detached, bytes: 27000 } },
							{ path: "../bad", content: "x" },
							"malformed",
						],
					},
				},
				env: { A2A_ANALYSIS_PAYLOAD_FILE: payloadFile },
			},
		];
		for (const { name, payload, env } of cases) {
			const expected = piri.collectSourceBundle(payload, env);
			const actual = collectSourceBundle(payload, asDansoEnv(env), { prefix: "A2A_DANSO_ANALYSIS" });
			assert.deepEqual(actual, expected, name);
		}
	});
});

test("contentRef failures stay fail-closed exactly like the piri bridge", () => {
	withRepo(({ dir, payloadFile }) => {
		const outside = join(dir, "outside.txt");
		writeFileSync(outside, "secret-ish", "utf8");
		const payload = { sourceBundle: { files: [{ path: "x.txt", contentRef: { path: outside } }] } };
		const env = { A2A_ANALYSIS_PAYLOAD_FILE: payloadFile };
		assert.throws(() => piri.collectSourceBundle(payload, env), /escapes the payload directory/);
		assert.throws(() => collectSourceBundle(payload, env, { prefix: "A2A_DANSO_ANALYSIS" }), /escapes the payload directory/);
		assert.throws(() => collectSourceBundle(payload, {}, { prefix: "A2A_DANSO_ANALYSIS" }), /requires the payload-file carrier/);
	});
});

test("collectSourceBundle requires an explicit env prefix", () => {
	assert.throws(() => collectSourceBundle({}, {}, {}), /requires an env prefix/);
});
