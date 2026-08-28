import assert from "node:assert/strict";
import test from "node:test";

import {
	sliceUtf8AtBoundary,
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
