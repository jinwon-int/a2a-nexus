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
	messageForPrompt,
	normalizePromptViewTelemetry,
	payloadForPrompt,
	payloadFromStructuredEnv,
	promptViewTelemetry,
	sourceCarrierBytes,
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

// #2301: the prompt-side payload view keeps structure but never file content.
test("payloadForPrompt replaces every source carrier's content with a summary", () => {
	const content = "export const secretless = 1;\n".repeat(40);
	const payload = {
		mode: "analysis-only",
		focus: "x",
		sourceBundle: { files: [{ repo: "o/r", path: "src/a.mjs", content, truncated: true }], note: "kept" },
		sourceFiles: [{ path: "b.txt", text: content }],
		sourceEvidence: ["c.txt"],
		embeddedSourceEvidence: [{ path: "d.txt", contentRef: { path: "payload-files/d.txt" } }],
	};
	const before = JSON.stringify(payload);
	const view = payloadForPrompt(payload);
	assert.equal(JSON.stringify(payload), before, "input payload is not mutated");
	assert.equal(view.mode, "analysis-only");
	assert.equal(view.focus, "x");
	assert.equal(view.sourceBundle.note, "kept");
	assert.deepEqual(view.sourceBundle.files, [{ repo: "o/r", path: "src/a.mjs", bytes: Buffer.byteLength(content), hasContent: true, truncated: true }]);
	assert.deepEqual(view.sourceFiles, [{ path: "b.txt", bytes: Buffer.byteLength(content), hasContent: true }]);
	assert.deepEqual(view.sourceEvidence, [{ path: "c.txt", bytes: 0, hasContent: false }]);
	assert.equal(view.embeddedSourceEvidence[0].hasContent, false);
	assert.equal(typeof view.embeddedSourceEvidence[0].contentRef, "string");
	for (const key of ["sourceBundle", "sourceFiles", "sourceEvidence", "embeddedSourceEvidence"]) {
		assert.ok(!JSON.stringify(view[key]).includes("secretless"), `${key} carries no content`);
	}
	assert.match(JSON.stringify(view), /content omitted here/);
	assert.deepEqual(payloadForPrompt(null), {});
	assert.deepEqual(payloadForPrompt({ plain: true }), { plain: true });
});

test("messageForPrompt rewrites only the embedded Payload JSON block", () => {
	const content = "line of source\n".repeat(50);
	const payload = { repo: "o/r", sourceBundle: { files: [{ repo: "o/r", path: "a.txt", content }] } };
	const json = JSON.stringify(payload, null, 2);
	const message = `Task id: t1\n\nPayload JSON (full; ${json.length} chars):\n${json}\n\nTask message:\nreview a.txt`;
	const rewritten = messageForPrompt(message, payload);
	// #2303 item 4: the handler's label sizes the original payload; the
	// rewrite replaces it with the size of the block actually shown.
	const summarized = `Payload JSON (summarized; ${JSON.stringify(payloadForPrompt(payload), null, 2).length} chars):`;
	assert.ok(rewritten.startsWith(`Task id: t1\n\n${summarized}`), "prefix kept, label rewritten to the summarized size");
	assert.ok(!rewritten.includes(`Payload JSON (full; ${json.length} chars)`), "the stale original-size label is gone");
	assert.ok(rewritten.endsWith("\n\nTask message:\nreview a.txt"), "suffix kept");
	assert.ok(!rewritten.includes("line of source"), "file content removed from the message");
	assert.match(rewritten, /"path": "a\.txt"/);
	assert.match(rewritten, /"bytes": \d+/);
	// The excerpt form is also recognized (label kept — it carries no stale
	// number); a truncated (unbalanced) block and a message without the marker
	// pass through unchanged.
	const excerpt = `Payload JSON excerpt (10 chars max; full payload is in A2A_ANALYSIS_PAYLOAD_FILE):\n${json}`;
	const excerptRewritten = messageForPrompt(excerpt, payload);
	assert.ok(!excerptRewritten.includes("line of source"));
	assert.ok(excerptRewritten.startsWith("Payload JSON excerpt (10 chars max;"), "excerpt label kept");
	const truncated = `Payload JSON (full; 9 chars):\n${json.slice(0, 40)}`;
	assert.equal(messageForPrompt(truncated, payload), truncated);
	assert.equal(messageForPrompt("no payload here", payload), "no payload here");
	assert.equal(messageForPrompt(undefined, payload), "");
});

// #2303 item 1: object-form carriers summarize exactly like arrays — the old
// array-only guard let `{ files: [...] }` (and a single carrier object) carry
// raw content through the payload section and the message block.
test("payloadForPrompt summarizes object-form and single-object carriers (#2303)", () => {
	const content = "object form\n".repeat(30);
	const bytes = Buffer.byteLength(content, "utf8");
	const payload = {
		sourceFiles: { files: [{ repo: "o/r", path: "a.txt", content }], note: "kept" },
		sourceEvidence: { repo: "o/r", path: "b.txt", content },
	};
	const before = JSON.stringify(payload);
	const view = payloadForPrompt(payload);
	assert.equal(JSON.stringify(payload), before, "input payload is not mutated");
	assert.ok(!JSON.stringify(view).includes("object form"), "no carrier content survives");
	assert.deepEqual(
		view.sourceFiles,
		{
			files: [{ repo: "o/r", path: "a.txt", bytes, hasContent: true }],
			note: "kept",
			contentOmitted: "source content omitted here; it is shown exactly once in the Read-only source bundle sections",
		},
	);
	assert.deepEqual(view.sourceEvidence, [{ repo: "o/r", path: "b.txt", bytes, hasContent: true }]);
	assert.equal(view.sourceEvidenceContentOmitted, "source content omitted here; it is shown exactly once in the Read-only source bundle sections");
});

// #2303 item 2: carriers at unlisted positions used to pass straight through.
test("payloadForPrompt rewrites carriers at unlisted nested positions (#2303)", () => {
	const content = "nested\n".repeat(40);
	const bytes = Buffer.byteLength(content, "utf8");
	const payload = {
		task: { sourceFiles: [{ path: "t.txt", content }], note: "kept" },
		items: [
			{ repo: "o/r", path: "i.txt", content },
			{ deep: { sourceEvidence: [{ path: "d.txt", text: content }] } },
		],
	};
	const view = payloadForPrompt(payload);
	assert.ok(!JSON.stringify(view).includes("nested\n"), "no nested carrier content survives");
	assert.equal(view.task.note, "kept");
	assert.deepEqual(view.task.sourceFiles, [{ path: "t.txt", bytes, hasContent: true }]);
	assert.deepEqual(view.items[0], { repo: "o/r", path: "i.txt", bytes, hasContent: true });
	assert.deepEqual(view.items[1].deep.sourceEvidence, [{ path: "d.txt", bytes, hasContent: true }]);
});

// The nested walk is shape-targeted: only known carrier keys and carrier-shaped
// items are rewritten, so an unrelated long string anywhere else survives.
test("the nested walk leaves non-carrier long strings untouched (#2303)", () => {
	const body = "long prose\n".repeat(50);
	const payload = { brief: { title: "x", content: body }, notes: [body] };
	const view = payloadForPrompt(payload);
	assert.equal(view.brief.content, body);
	assert.deepEqual(view.notes, [body]);
});

// #2303 item 3: an empty `content` must not hide a populated `text`.
test("an empty content field does not hide a populated text field (#2303)", () => {
	const payload = { sourceFiles: [{ path: "a.txt", content: "", text: "real body" }] };
	const view = payloadForPrompt(payload);
	assert.deepEqual(view.sourceFiles, [{ path: "a.txt", bytes: Buffer.byteLength("real body"), hasContent: true }]);
	assert.equal(sourceCarrierBytes(payload), Buffer.byteLength("real body"));
});

// #2303 item 5: content-free byte counters over every carrier shape.
test("sourceCarrierBytes and promptViewTelemetry count every carrier shape once (#2303)", () => {
	const content = "x".repeat(100);
	const payload = {
		sourceBundle: { files: [{ repo: "o/r", path: "a.txt", content }] },
		sourceFiles: { files: [{ path: "b.txt", text: content }] },
		task: { sourceEvidence: [{ path: "c.txt", content }] },
		items: [{ repo: "o/r", path: "d.txt", content }],
	};
	assert.equal(sourceCarrierBytes(payload), 400);
	assert.equal(sourceCarrierBytes({}), 0);
	assert.equal(sourceCarrierBytes(null), 0);
	assert.deepEqual(promptViewTelemetry(payload, "프롬프트"), {
		promptBytes: Buffer.byteLength("프롬프트", "utf8"),
		sourceBytes: 400,
	});
	// normalizePromptViewTelemetry: bounded integer record in, junk out.
	assert.deepEqual(normalizePromptViewTelemetry({ promptBytes: 10, sourceBytes: 400 }), { promptBytes: 10, sourceBytes: 400 });
	assert.deepEqual(normalizePromptViewTelemetry({ promptBytes: 10, junk: "x" }), { promptBytes: 10 });
	assert.equal(normalizePromptViewTelemetry({ junk: true }), undefined);
	assert.equal(normalizePromptViewTelemetry("nope"), undefined);
});
