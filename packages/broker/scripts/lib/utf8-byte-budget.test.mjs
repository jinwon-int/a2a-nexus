import assert from "node:assert/strict";
import test from "node:test";

import {
	byteBudget,
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
