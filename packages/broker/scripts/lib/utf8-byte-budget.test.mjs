import assert from "node:assert/strict";
import test from "node:test";

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	byteBudget,
	readUtf8FilePrefix,
	sliceUtf8AtBoundary,
	truncateUtf16Safe,
	truncateUtf8ToBytesSafe,
	utf8BoundaryEnd,
} from "./utf8-byte-budget.mjs";

const REPLACEMENT = "\uFFFD";

test("no truncation needed returns input unchanged", () => {
	const value = "짧은 한국어 문자열";
	assert.equal(truncateUtf8ToBytesSafe(value, 1024), value);
	const buf = Buffer.from(value, "utf8");
	assert.equal(sliceUtf8AtBoundary(buf, 1024).toString("utf8"), value);
});

test("cut on a 3-byte character boundary never emits U+FFFD (#2005)", () => {
	// '돼' is 3 bytes (EB 8F BC). Cut so the byte budget ends mid-character.
	const prefix = "걸어가도 "; // 4×3 + 1 = 13 bytes
	const value = `${prefix}돼요. 나머지 내용`;
	const prefixBytes = Buffer.byteLength(prefix, "utf8"); // 13
	for (const budget of [prefixBytes + 1, prefixBytes + 2]) {
		const out = truncateUtf8ToBytesSafe(value, budget);
		assert.ok(!out.includes(REPLACEMENT), `budget ${budget} must not produce U+FFFD`);
		assert.equal(out, prefix, `budget ${budget} backs off to the character boundary`);
		assert.ok(Buffer.byteLength(out, "utf8") <= budget);
	}
});

test("exact boundary cut keeps the full prefix", () => {
	const value = "가나다"; // 9 bytes
	assert.equal(truncateUtf8ToBytesSafe(value, 6), "가나");
	assert.equal(truncateUtf8ToBytesSafe(value, 9), value);
});

test("2-byte and 4-byte characters are backed off correctly", () => {
	const two = "é"; // 2 bytes
	const four = "😀"; // 4 bytes
	assert.equal(truncateUtf8ToBytesSafe(`a${two}b`, 2), "a");
	assert.equal(truncateUtf8ToBytesSafe(`a${two}b`, 3), `a${two}`);
	assert.equal(truncateUtf8ToBytesSafe(`a${four}b`, 2), "a");
	assert.equal(truncateUtf8ToBytesSafe(`a${four}b`, 4), "a");
	assert.equal(truncateUtf8ToBytesSafe(`a${four}b`, 5), `a${four}`);
});

test("zero and negative budgets produce an empty string", () => {
	assert.equal(truncateUtf8ToBytesSafe("한국어", 0), "");
	assert.equal(truncateUtf8ToBytesSafe("한국어", -5), "");
	assert.equal(utf8BoundaryEnd(Buffer.from("한국어", "utf8"), 0), 0);
});

test("ascii fast path", () => {
	assert.equal(truncateUtf8ToBytesSafe("abcdef", 3), "abc");
	assert.equal(truncateUtf8ToBytesSafe("", 0), "");
});

test("sliceUtf8AtBoundary accepts non-buffer input", () => {
	const out = sliceUtf8AtBoundary("걸어가도 돼요", 15); // 15 ends mid-'돼' (bytes 14–16)
	assert.equal(out.toString("utf8"), "걸어가도 ");
});

// #2524: a non-integer budget used to skip the continuation-byte check
// (buffer[4.5] is undefined) while subarray() still floored the cut.
test("fractional budgets are floored before the boundary check (#2524)", () => {
	const buf = Buffer.from("가나", "utf8"); // 6 bytes, boundary at 3
	for (const budget of [1.5, 3.5, 4.5, 5.9]) {
		const sliced = sliceUtf8AtBoundary(buf, budget).toString("utf8");
		assert.ok(!sliced.includes(REPLACEMENT), `slice budget ${budget} must not produce U+FFFD`);
		const truncated = truncateUtf8ToBytesSafe("가나", budget);
		assert.ok(!truncated.includes(REPLACEMENT), `truncate budget ${budget} must not produce U+FFFD`);
		assert.ok(Buffer.byteLength(truncated, "utf8") <= budget);
	}
	assert.equal(truncateUtf8ToBytesSafe("가나", 4.5), "가");
	assert.equal(utf8BoundaryEnd(buf, 4.5), 3);
	assert.ok(Number.isInteger(utf8BoundaryEnd(buf, 2.5)));
});

test("utf8BoundaryEnd measures string input in bytes (#2524)", () => {
	const value = "가나"; // 6 bytes
	assert.equal(utf8BoundaryEnd(value, 4), utf8BoundaryEnd(Buffer.from(value, "utf8"), 4));
	assert.equal(utf8BoundaryEnd(value, 4), 3);
	assert.equal(utf8BoundaryEnd(value, 6), 6);
});

test("NaN, non-numeric, negative and -Infinity budgets behave like a zero budget (#2524)", () => {
	const buf = Buffer.from("가나", "utf8");
	for (const budget of [Number.NaN, undefined, "abc", -1, -2.5, Number.NEGATIVE_INFINITY]) {
		assert.equal(utf8BoundaryEnd(buf, budget), 0);
		assert.equal(sliceUtf8AtBoundary(buf, budget).length, 0);
		assert.equal(truncateUtf8ToBytesSafe("가나", budget), "");
	}
});

test("Infinity keeps the whole input (#2524)", () => {
	assert.equal(truncateUtf8ToBytesSafe("가나", Number.POSITIVE_INFINITY), "가나");
	assert.equal(sliceUtf8AtBoundary(Buffer.from("가나", "utf8"), Number.POSITIVE_INFINITY).toString("utf8"), "가나");
});

test("sliceUtf8AtBoundary cuts a plain Uint8Array as bytes, like utf8BoundaryEnd (#2524 review)", () => {
	const bytes = new Uint8Array(Buffer.from("가나", "utf8")); // not a Buffer
	assert.equal(Buffer.isBuffer(bytes), false);
	assert.equal(sliceUtf8AtBoundary(bytes, 4).toString("utf8"), "가");
	assert.equal(sliceUtf8AtBoundary(bytes, 6).toString("utf8"), "가나");
	assert.equal(utf8BoundaryEnd(bytes, 4), 3);
	const view = new Uint8Array(Buffer.from("x가나", "utf8")).subarray(1); // non-zero byteOffset view
	assert.equal(view.byteOffset, 1);
	assert.equal(sliceUtf8AtBoundary(view, 5).toString("utf8"), "가");
});

test("byteBudget normalizes budgets to whole bytes (#2524)", () => {
	assert.equal(byteBudget(4.9), 4);
	assert.equal(byteBudget("7"), 7);
	assert.equal(byteBudget(-3), 0);
	assert.equal(byteBudget(Number.NaN), 0);
	assert.equal(byteBudget(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
});

// #2528 A1: one byte normalization for both exported cut helpers.
test("utf8BoundaryEnd and sliceUtf8AtBoundary agree on every byte container (#2528)", () => {
	const utf8 = Buffer.from("가나", "utf8"); // boundary at 3
	const arrayBuffer = utf8.buffer.slice(utf8.byteOffset, utf8.byteOffset + utf8.byteLength);
	const inputs = {
		Buffer: utf8,
		Uint8Array: new Uint8Array(utf8),
		DataView: new DataView(arrayBuffer),
		ArrayBuffer: arrayBuffer,
		string: "가나",
	};
	for (const [kind, input] of Object.entries(inputs)) {
		assert.equal(utf8BoundaryEnd(input, 4), 3, `${kind}: utf8BoundaryEnd backs off to the boundary`);
		assert.equal(utf8BoundaryEnd(input, 6), 6, `${kind}: whole input fits`);
		assert.equal(sliceUtf8AtBoundary(input, 4).toString("utf8"), "가", `${kind}: slice cuts as bytes`);
	}
});

test("a non-Uint8 typed array is cut by its underlying bytes (#2528)", () => {
	const utf8 = Buffer.from("가나", "utf8"); // 6 bytes = three 16-bit elements
	const wide = new Uint16Array(utf8.buffer.slice(utf8.byteOffset, utf8.byteOffset + 6));
	assert.equal(utf8BoundaryEnd(wide, 4), 3);
	assert.equal(sliceUtf8AtBoundary(wide, 4).toString("utf8"), "가");
});

test("non-byte, non-string input is measured as its string form (#2528)", () => {
	assert.equal(utf8BoundaryEnd(12345, 3), 3);
	assert.equal(sliceUtf8AtBoundary(12345, 3).toString("utf8"), "123");
	assert.equal(utf8BoundaryEnd(null, 3), 0);
});

// #2528 B6: a valid UTF-8 character has at most 3 continuation bytes, so the
// back-off never needs more than 3 steps. On malformed input (a long run of
// continuation bytes) the cut used to fall back to 0 and drop everything.
test("back-off is bounded to 3 bytes on malformed input (#2528)", () => {
	const malformed = Buffer.from([0x61, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
	assert.equal(utf8BoundaryEnd(malformed, 6), 6, "no lead byte within 3 steps: cut at the budget");
	assert.equal(sliceUtf8AtBoundary(malformed, 6).length, 6);
	// Valid 4-byte characters still back off the full 3 bytes.
	const emoji = Buffer.from("a😀", "utf8"); // 1 + 4 bytes
	assert.equal(utf8BoundaryEnd(emoji, 4), 1);
	assert.equal(utf8BoundaryEnd(emoji, 2), 1);
	assert.equal(utf8BoundaryEnd(emoji, 5), 5);
});

test("SharedArrayBuffer and a cross-realm ArrayBuffer are cut as bytes (#2529 review)", async () => {
	const utf8 = Buffer.from("가나", "utf8");
	const shared = new SharedArrayBuffer(utf8.length);
	new Uint8Array(shared).set(utf8);
	assert.equal(utf8BoundaryEnd(shared, 4), 3);
	assert.equal(sliceUtf8AtBoundary(shared, 4).toString("utf8"), "가");
	const { runInNewContext } = await import("node:vm");
	const foreign = runInNewContext("new Uint8Array([0xEA,0xB0,0x80,0xEB,0x82,0x98]).buffer");
	assert.equal(foreign instanceof ArrayBuffer, false, "fixture really is from another realm");
	assert.equal(utf8BoundaryEnd(foreign, 4), 3);
	assert.equal(sliceUtf8AtBoundary(foreign, 4).toString("utf8"), "가");
});

test("malformed bytes at the cut keep the cut at the budget, one rule for every case (#2529 review)", () => {
	// Stray continuation run after complete ASCII: never drop the valid 'aa'.
	const strayAfterAscii = Buffer.from([0x61, 0x61, 0x80, 0x80, 0x80, 0x80]);
	for (let budget = 1; budget <= 5; budget++) {
		assert.equal(utf8BoundaryEnd(strayAfterAscii, budget), budget, `stray run, budget ${budget}`);
	}
	// A continuation run starting at index 0: same rule, no drop to 0.
	const runFromStart = Buffer.alloc(8, 0x80);
	for (let budget = 1; budget <= 7; budget++) {
		assert.equal(utf8BoundaryEnd(runFromStart, budget), budget, `run from start, budget ${budget}`);
	}
	// Invalid (0xF8) and overlong (0xC0) leads do not start a sequence.
	assert.equal(utf8BoundaryEnd(Buffer.from([0x61, 0xf8, 0x80, 0x80]), 2), 2);
	assert.equal(utf8BoundaryEnd(Buffer.from([0xc0, 0x80, 0x61]), 1), 1);
	// A complete character followed by a stray continuation byte is kept.
	assert.equal(utf8BoundaryEnd(Buffer.from([0xc3, 0xa9, 0x80, 0x61]), 2), 2);
	// A lead whose sequence is shorter than the distance back is not "the" lead:
	// 2-byte lead, then 3 continuation bytes (one stray) - the cut stays.
	assert.equal(utf8BoundaryEnd(Buffer.from([0xc3, 0xa9, 0x80, 0x80, 0x61]), 3), 3);
	// A complete 4-byte character followed by a stray continuation byte: the
	// 3-step look-back finds no lead (index 0 is 4 back, beyond the bound), so
	// the cut stays at the budget and the complete emoji is kept.
	assert.equal(utf8BoundaryEnd(Buffer.from([0xf0, 0x9f, 0x98, 0x80, 0x80, 0x61]), 4), 4);
	// The result never exceeds the budget.
	for (const buf of [strayAfterAscii, runFromStart]) {
		for (let budget = 0; budget <= buf.length + 1; budget++) {
			assert.ok(utf8BoundaryEnd(buf, budget) <= budget);
		}
	}
});

test("on valid UTF-8 the bounded back-off matches the unbounded one at every cut (#2529 review)", () => {
	// Reference: the pre-#2528 unbounded back-off.
	const unbounded = (bytes, limit) => {
		let end = Math.min(limit, bytes.length);
		while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
		return end;
	};
	const alphabet = ["a", "é", "가", "😀", "ࠀ", "�", "\u{10FFFF}"];
	// 32-bit LCG in exact integer arithmetic (Math.imul); a plain double
	// multiply loses the low bits past 2^53 (#2529 review). Use the high bits.
	let seed = 2529;
	const next = () => {
		seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
		return seed >>> 16;
	};
	const lengths = new Set();
	for (let round = 0; round < 200; round++) {
		let text = "";
		const len = 1 + (next() % 12);
		lengths.add(len);
		for (let i = 0; i < len; i++) text += alphabet[next() % alphabet.length];
		const bytes = Buffer.from(text, "utf8");
		for (let budget = 0; budget <= bytes.length; budget++) {
			const cut = utf8BoundaryEnd(bytes, budget);
			assert.equal(cut, unbounded(bytes, budget), `${JSON.stringify(text)} budget ${budget}`);
			// Lossless prefix: decoding and re-encoding the kept bytes gives the
			// same bytes, so the cut produced no replacement character (this also
			// holds when the text itself contains a literal U+FFFD).
			const prefix = bytes.subarray(0, cut);
			assert.ok(Buffer.from(prefix.toString("utf8"), "utf8").equals(prefix), `${JSON.stringify(text)} budget ${budget}: lossless prefix`);
		}
	}
	assert.equal(lengths.size, 12, "the generator covers every text length 1..12");
});

// #2528 A4: diagnostics are cut by UTF-16 code units (.slice(0, n)); a cut
// between a surrogate pair leaves a lone high surrogate that becomes U+FFFD
// once the text is written as UTF-8.
test("truncateUtf16Safe never leaves a lone high surrogate at the cut (#2528)", () => {
	const text = `x${"😀".repeat(10)}`; // pairs start at odd indices
	for (let limit = 0; limit <= text.length; limit++) {
		const out = truncateUtf16Safe(text, limit);
		assert.ok(out.length <= limit, `limit ${limit}`);
		assert.ok(!/[\uD800-\uDBFF]$/.test(out), `limit ${limit}: no trailing high surrogate`);
		assert.ok(Buffer.from(out, "utf8").toString("utf8") === out, `limit ${limit}: lossless as UTF-8`);
	}
	assert.equal(truncateUtf16Safe(text, 2), "x");
	assert.equal(truncateUtf16Safe(text, 3), "x😀");
	assert.equal(truncateUtf16Safe("abc", 2), "ab");
	assert.equal(truncateUtf16Safe("abc", 10), "abc");
	assert.equal(truncateUtf16Safe("abc", 1.9), "a");
	assert.equal(truncateUtf16Safe(null, 5), "");
});

// #2528 B5: the bounded read decides truncation from the bytes it actually
// read, not from a fstat size that can be stale (file rewritten between stat
// and read) or wrong (procfs reports 0).
test("readUtf8FilePrefix cuts on-disk text on a UTF-8 boundary from the bytes actually read (#2528)", () => {
	const dir = mkdtempSync(join(tmpdir(), "utf8-file-prefix-"));
	try {
		const file = join(dir, "k.txt");
		writeFileSync(file, `ab${"가".repeat(5)}`); // 2 + 15 bytes
		assert.deepEqual(readUtf8FilePrefix(file, 4), { content: "ab", truncated: true, bytes: 17 });
		assert.deepEqual(readUtf8FilePrefix(file, 5), { content: "ab가", truncated: true, bytes: 17 });
		assert.deepEqual(readUtf8FilePrefix(file, 17), { content: `ab${"가".repeat(5)}`, truncated: false, bytes: 17 });
		assert.deepEqual(readUtf8FilePrefix(file, 16), { content: `ab${"가".repeat(4)}`, truncated: true, bytes: 17 });
		assert.deepEqual(readUtf8FilePrefix(file, 4.9), { content: "ab", truncated: true, bytes: 17 });
		assert.deepEqual(readUtf8FilePrefix(file, 0), { content: "", truncated: true, bytes: 17 });
		assert.deepEqual(readUtf8FilePrefix(file, Number.POSITIVE_INFINITY), { content: `ab${"가".repeat(5)}`, truncated: false, bytes: 17 });
		const empty = join(dir, "empty.txt");
		writeFileSync(empty, "");
		assert.deepEqual(readUtf8FilePrefix(empty, 10), { content: "", truncated: false, bytes: 0 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readUtf8FilePrefix reads a file whose fstat size is wrong (procfs reports 0) (#2528)", { skip: !existsSync("/proc/self/status") }, () => {
	const whole = readUtf8FilePrefix("/proc/self/status", Number.POSITIVE_INFINITY);
	assert.ok(whole.content.length > 0, "content is read even though fstat says 0 bytes");
	assert.equal(whole.truncated, false);
	const cut = readUtf8FilePrefix("/proc/self/status", 20);
	assert.equal(cut.truncated, true, "truncation is decided from the bytes read");
	assert.ok(Buffer.byteLength(cut.content, "utf8") <= 20 && cut.content.length > 0);
	assert.ok(cut.bytes >= 21, "reported size is at least what was seen");
});
