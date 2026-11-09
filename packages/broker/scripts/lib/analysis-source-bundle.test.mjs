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
	positiveIntegerEnv,
	promptViewTelemetry,
	sourceCarrierBytes,
} from "./analysis-source-bundle.mjs";
// Namespace view so a test-only export that does not exist yet fails only
// the tests that need it.
import * as sourceBundleModule from "./analysis-source-bundle.mjs";

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

// #2528 B7: same rule as the hermes/piri analysis parsers (#2524): a value
// must floor to at least 1, otherwise the fallback is used - "0.5" used to
// floor to 0 and silently disable a limit.
test("positiveIntegerEnv falls back unless the value floors to >= 1 (#2528)", () => {
	for (const value of ["0.5", "0.99", "0", "-1", "-0.5", "abc", "", undefined, null, "Infinity", "NaN"]) {
		assert.equal(positiveIntegerEnv(value, 7), 7, `value ${JSON.stringify(value)}`);
	}
	assert.equal(positiveIntegerEnv("1", 7), 1);
	assert.equal(positiveIntegerEnv("1.9", 7), 1);
	assert.equal(positiveIntegerEnv("24576", 7), 24576);
	assert.equal(positiveIntegerEnv(3, 7), 3);
	// A caller that passes 0 as the fallback (danso) still gets 0 for junk.
	assert.equal(positiveIntegerEnv("0.5", 0), 0);
});

function captureStderr(fn) {
	const original = process.stderr.write;
	let captured = "";
	process.stderr.write = (chunk, ...rest) => {
		captured += String(chunk);
		const callback = rest.find((arg) => typeof arg === "function");
		if (callback) callback();
		return true;
	};
	try {
		fn();
	} finally {
		process.stderr.write = original;
	}
	return captured;
}

function sharedEnvWarningLineRe() {
	const re = sourceBundleModule.ENV_WARNING_LINE_RE;
	assert.ok(re instanceof RegExp, "the env-warning line shape is exported once from the lib (#2535)");
	return re;
}

function resetEnvWarnings() {
	assert.equal(typeof sourceBundleModule.__resetEnvWarningsForTest, "function", "test-only warn-once reset is exported");
	sourceBundleModule.__resetEnvWarningsForTest();
}

// #2531/#2533 D1: a rejected, named value is reported once per name on stderr
// (name and default only, never the value); return values are unchanged.
test("positiveIntegerEnv warns once per name for a rejected named value, never printing the value (#2533)", () => {
	resetEnvWarnings();
	const out = captureStderr(() => {
		assert.equal(positiveIntegerEnv("0.5-secretish", 7, "A2A_TEST_LIMIT_A"), 7);
		assert.equal(positiveIntegerEnv("-3", 7, "A2A_TEST_LIMIT_A"), 7, "same name again: still the fallback");
		assert.equal(positiveIntegerEnv("abc", 9, "A2A_TEST_LIMIT_B"), 9);
		assert.equal(positiveIntegerEnv("5", 9, "A2A_TEST_LIMIT_C"), 5, "accepted values are silent");
	});
	const lines = out.split("\n").filter(Boolean);
	assert.deepEqual(lines, [
		"a2a-analysis-source-bundle: ignoring A2A_TEST_LIMIT_A (not a positive integer); falling back to the default 7",
		"a2a-analysis-source-bundle: ignoring A2A_TEST_LIMIT_B (not a positive integer); falling back to the default 9",
	]);
	for (const value of ["0.5-secretish", "-3", "abc"]) assert.equal(out.includes(value), false, `value ${value} never printed`);
	resetEnvWarnings();
	const again = captureStderr(() => positiveIntegerEnv("0", 7, "A2A_TEST_LIMIT_A"));
	assert.match(again, /ignoring A2A_TEST_LIMIT_A /, "the reset re-arms the warning");
	resetEnvWarnings();
});

test("positiveIntegerEnv stays silent for blank/unset values and when no name is given (#2533)", () => {
	resetEnvWarnings();
	const out = captureStderr(() => {
		for (const value of ["", "   ", undefined, null]) {
			assert.equal(positiveIntegerEnv(value, 7, "A2A_TEST_LIMIT_BLANK"), 7);
		}
		assert.equal(positiveIntegerEnv("abc", 7), 7, "no name: silent");
		assert.equal(positiveIntegerEnv("0.5", 0), 0, "no name, fallback 0: silent");
	});
	assert.equal(out, "");
	resetEnvWarnings();
});

// #2533 review item 3: the warning prefix names the reporting bridge. The
// line must keep the shape the task handler moves after the real failure.
test("positiveIntegerEnv uses the { source } prefix for its warning, default a2a-analysis-source-bundle (#2533)", () => {
	// #2535: the shared line shape the task handler also imports, not a copy.
	const ENV_WARNING_LINE_RE = sharedEnvWarningLineRe();
	resetEnvWarnings();
	const out = captureStderr(() => {
		assert.equal(positiveIntegerEnv("junk", 30, "A2A_TEST_SOURCE_A", { source: "danso-a2a-analysis-bridge" }), 30);
		assert.equal(positiveIntegerEnv("junk", 31, "A2A_TEST_SOURCE_B", {}), 31);
		assert.equal(positiveIntegerEnv("junk", 32, "A2A_TEST_SOURCE_C"), 32);
		assert.equal(positiveIntegerEnv("12", 33, "A2A_TEST_SOURCE_D", { source: "danso-a2a-analysis-bridge" }), 12);
	});
	const lines = out.split("\n").filter(Boolean);
	assert.deepEqual(lines, [
		"danso-a2a-analysis-bridge: ignoring A2A_TEST_SOURCE_A (not a positive integer); falling back to the default 30",
		"a2a-analysis-source-bundle: ignoring A2A_TEST_SOURCE_B (not a positive integer); falling back to the default 31",
		"a2a-analysis-source-bundle: ignoring A2A_TEST_SOURCE_C (not a positive integer); falling back to the default 32",
	]);
	for (const line of lines) assert.match(line, ENV_WARNING_LINE_RE);
	resetEnvWarnings();
});

// #2533 D2: collectSourceBundle names the variable it actually read.
test("collectSourceBundle warns with the prefixed name when set, else the A2A_HERMES_ANALYSIS_ name (#2533)", () => {
	resetEnvWarnings();
	const prefixed = captureStderr(() => {
		const bundle = collectSourceBundle({}, { A2A_DANSO_ANALYSIS_MAX_FILES: "zero", A2A_HERMES_ANALYSIS_MAX_FILES: "3" }, { prefix: "A2A_DANSO_ANALYSIS" });
		assert.equal(bundle.limits.maxFiles, 16, "a rejected prefixed value falls back to the default, as before");
	});
	assert.equal(prefixed, "a2a-analysis-source-bundle: ignoring A2A_DANSO_ANALYSIS_MAX_FILES (not a positive integer); falling back to the default 16\n");
	const hermesOnly = captureStderr(() => {
		const bundle = collectSourceBundle({}, { A2A_HERMES_ANALYSIS_MAX_TREE_ENTRIES: "0.5" }, { prefix: "A2A_DANSO_ANALYSIS" });
		assert.equal(bundle.limits.maxTreeEntries, 80);
	});
	assert.equal(hermesOnly, "a2a-analysis-source-bundle: ignoring A2A_HERMES_ANALYSIS_MAX_TREE_ENTRIES (not a positive integer); falling back to the default 80\n");
	assert.equal(hermesOnly.includes("0.5"), false);
	const silent = captureStderr(() => collectSourceBundle({}, { A2A_DANSO_ANALYSIS_MAX_FILES: "4" }, { prefix: "A2A_DANSO_ANALYSIS" }));
	assert.equal(silent, "");
	resetEnvWarnings();
});

// #2535 item 1: the warning prefix is validated against the same character
// class the shared line regex uses; anything else falls back to the default
// prefix instead of producing a line the task handler would not recognise.
test("positiveIntegerEnv falls back to the default prefix for an invalid source and accepts a null options argument (#2535)", () => {
	resetEnvWarnings();
	const invalidSources = ["a b", "x:y", "", 42, "line\nbreak", "tab\there", null, {}];
	const out = captureStderr(() => {
		invalidSources.forEach((source, index) => {
			assert.equal(positiveIntegerEnv("junk", 5, `A2A_TEST_BAD_SOURCE_${index}`, { source }), 5);
		});
		assert.doesNotThrow(() => positiveIntegerEnv("junk", 6, "A2A_TEST_NULL_OPTIONS", null));
		assert.equal(positiveIntegerEnv("junk", 7, "A2A_TEST_UNDEFINED_OPTIONS", undefined), 7);
		assert.equal(positiveIntegerEnv("8", 9, "A2A_TEST_NULL_OPTIONS_OK", null), 8, "accepted value with null options");
	});
	const lines = out.split("\n").filter(Boolean);
	assert.deepEqual(lines, [
		...invalidSources.map((_, index) => `a2a-analysis-source-bundle: ignoring A2A_TEST_BAD_SOURCE_${index} (not a positive integer); falling back to the default 5`),
		"a2a-analysis-source-bundle: ignoring A2A_TEST_NULL_OPTIONS (not a positive integer); falling back to the default 6",
		"a2a-analysis-source-bundle: ignoring A2A_TEST_UNDEFINED_OPTIONS (not a positive integer); falling back to the default 7",
	]);
	resetEnvWarnings();
});

test("every line positiveIntegerEnv writes matches the shared env-warning regex (#2535)", () => {
	const ENV_WARNING_LINE_RE = sharedEnvWarningLineRe();
	assert.equal(sourceBundleModule.ENV_WARNING_DEFAULT_SOURCE, "a2a-analysis-source-bundle");
	assert.ok(sourceBundleModule.ENV_WARNING_SOURCE_RE instanceof RegExp, "the source pattern is exported");
	resetEnvWarnings();
	const validSources = ["a2a-analysis-source-bundle", "danso-a2a-analysis-bridge", "x.y_z-9", "A"];
	const out = captureStderr(() => {
		validSources.forEach((source, index) => positiveIntegerEnv("junk", 3, `A2A_TEST_GOOD_SOURCE_${index}`, { source }));
		positiveIntegerEnv("junk", 3, "A2A_TEST_DEFAULT_SOURCE");
		positiveIntegerEnv("junk", 3, "A2A_TEST_FALLBACK_SOURCE", { source: "not valid" });
	});
	const lines = out.split("\n").filter(Boolean);
	assert.equal(lines.length, validSources.length + 2, out);
	validSources.forEach((source, index) => {
		assert.ok(lines[index].startsWith(`${source}: ignoring A2A_TEST_GOOD_SOURCE_${index} `), lines[index]);
		assert.ok(sourceBundleModule.ENV_WARNING_SOURCE_RE.test(source), `${source} is a valid prefix`);
	});
	for (const line of lines) assert.match(line, ENV_WARNING_LINE_RE);
	// The formatter is the single writer of the line shape.
	assert.equal(typeof sourceBundleModule.formatEnvWarningLine, "function");
	assert.equal(
		sourceBundleModule.formatEnvWarningLine("x.y_z-9", "A2A_TEST_FORMAT", 4),
		"x.y_z-9: ignoring A2A_TEST_FORMAT (not a positive integer); falling back to the default 4",
	);
	assert.equal(
		sourceBundleModule.formatEnvWarningLine("x:y", "A2A_TEST_FORMAT", 4),
		"a2a-analysis-source-bundle: ignoring A2A_TEST_FORMAT (not a positive integer); falling back to the default 4",
	);
	// Prefixes outside the class never match, so they can never be produced.
	for (const source of ["a b", "x:y", ""]) {
		assert.equal(sourceBundleModule.ENV_WARNING_SOURCE_RE.test(source), false, JSON.stringify(source));
		assert.equal(ENV_WARNING_LINE_RE.test(`${source}: ignoring A2A_TEST_X (not a positive integer)`), false, JSON.stringify(source));
	}
	resetEnvWarnings();
});

// #2535 item 2: collectSourceBundle passes an optional { source } to its limit
// warnings so a bridge sees one prefix for all of its env warnings.
test("collectSourceBundle names the given { source } in its limit warnings, default a2a-analysis-source-bundle (#2535)", () => {
	resetEnvWarnings();
	const named = captureStderr(() => {
		const bundle = collectSourceBundle({}, { A2A_DANSO_ANALYSIS_MAX_FILES: "zero", A2A_HERMES_ANALYSIS_MAX_TOTAL_BYTES: "0.5" }, {
			prefix: "A2A_DANSO_ANALYSIS",
			source: "danso-a2a-analysis-bridge",
		});
		assert.equal(bundle.limits.maxFiles, 16);
	});
	assert.equal(named, [
		"danso-a2a-analysis-bridge: ignoring A2A_DANSO_ANALYSIS_MAX_FILES (not a positive integer); falling back to the default 16",
		"danso-a2a-analysis-bridge: ignoring A2A_HERMES_ANALYSIS_MAX_TOTAL_BYTES (not a positive integer); falling back to the default 163840",
		"",
	].join("\n"));
	resetEnvWarnings();
	const unnamed = captureStderr(() => collectSourceBundle({}, { A2A_DANSO_ANALYSIS_MAX_FILES: "zero" }, { prefix: "A2A_DANSO_ANALYSIS" }));
	assert.equal(unnamed, "a2a-analysis-source-bundle: ignoring A2A_DANSO_ANALYSIS_MAX_FILES (not a positive integer); falling back to the default 16\n");
	resetEnvWarnings();
	const invalid = captureStderr(() => collectSourceBundle({}, { A2A_DANSO_ANALYSIS_MAX_FILES: "zero" }, { prefix: "A2A_DANSO_ANALYSIS", source: "bad source" }));
	assert.equal(invalid, "a2a-analysis-source-bundle: ignoring A2A_DANSO_ANALYSIS_MAX_FILES (not a positive integer); falling back to the default 16\n");
	resetEnvWarnings();
});

// #2536 review: the env NAME is part of the line contract too. A prefix that
// would build names outside the class is a caller bug and throws; a malformed
// name passed straight to positiveIntegerEnv prints nothing rather than a line
// the task handler would not recognise.
test("collectSourceBundle rejects an env prefix outside /^[A-Z][A-Z0-9_]*$/ (#2536)", () => {
	for (const prefix of ["a2a_danso_analysis", "A2A-DANSO-ANALYSIS", "A2A DANSO", "_A2A", "9A2A", "A2A_danso", "", 42, null, undefined]) {
		assert.throws(() => collectSourceBundle({}, {}, { prefix }), /collectSourceBundle requires an env prefix/, `prefix ${JSON.stringify(prefix)}`);
	}
	assert.doesNotThrow(() => collectSourceBundle({}, {}, { prefix: "A2A_DANSO_ANALYSIS" }));
	assert.doesNotThrow(() => collectSourceBundle({}, {}, { prefix: "X9" }));
});

test("positiveIntegerEnv prints nothing for a name outside the env-name class (#2536)", () => {
	assert.ok(sourceBundleModule.ENV_WARNING_NAME_RE instanceof RegExp, "the env-name pattern is exported");
	resetEnvWarnings();
	const out = captureStderr(() => {
		for (const name of ["a2a_lower", "A2A-DASHED", "A2A SPACE", "A2A_X\nB", "A2A_X:Y", "Ä2A"]) {
			assert.equal(positiveIntegerEnv("junk", 4, name, { source: "danso-a2a-analysis-bridge" }), 4, `fallback unchanged for ${JSON.stringify(name)}`);
		}
	});
	assert.equal(out, "");
	for (const name of ["a2a_lower", "A2A-DASHED"]) {
		assert.equal(sourceBundleModule.formatEnvWarningLine("danso-a2a-analysis-bridge", name, 4), "", `formatter refuses ${name}`);
	}
	resetEnvWarnings();
});

test("every line the lib can print for an env warning matches the shared regex (#2536)", () => {
	const ENV_WARNING_LINE_RE = sharedEnvWarningLineRe();
	const sources = ["a2a-analysis-source-bundle", "danso-a2a-analysis-bridge", "x.y_z-9", "a b", "x:y", "", "line\nbreak", 42, null, undefined, {}];
	const names = ["A2A_OK", "A", "_", "9", "a2a_lower", "A2A-DASHED", "A2A SPACE", "A2A_X\nB", "", "A2A_X:Y"];
	const fallbacks = [0, 7, 24576, "1\nforged-line", "2\r\nx"];
	let index = 0;
	let printed = 0;
	resetEnvWarnings();
	for (const source of sources) {
		for (const name of names) {
			for (const fallback of fallbacks) {
				const formatted = sourceBundleModule.formatEnvWarningLine(source, name, fallback);
				assert.equal(/[\r\n]/.test(formatted), false, "the formatter returns a single line");
				if (formatted) assert.match(formatted, ENV_WARNING_LINE_RE);
				// Re-armed after every call so the warn-once set never hides a case.
				const out = captureStderr(() => positiveIntegerEnv("junk", fallback, name, { source }));
				resetEnvWarnings();
				index += 1;
				if (!out) continue;
				printed += 1;
				assert.ok(out.endsWith("\n"), "one newline-terminated line");
				const lines = out.slice(0, -1).split("\n");
				assert.equal(lines.length, 1, `exactly one line: ${JSON.stringify(out)}`);
				assert.match(lines[0], ENV_WARNING_LINE_RE, JSON.stringify(out));
			}
		}
	}
	assert.ok(index > 0 && printed > 0, "the corpus exercises printing cases");
	resetEnvWarnings();
});
