/**
 * UTF-8-safe byte-budget helpers (#2005).
 *
 * Cutting a UTF-8 buffer at a raw byte offset can split a multi-byte
 * character; decoding that prefix with lossy `toString("utf8")` then emits
 * U+FFFD replacement characters. Reviewers downstream read those phantom
 * characters as source-text corruption and BLOCK otherwise-clean content.
 * Every byte-capped string/Buffer cut in the analysis bridges must go
 * through these helpers so the cut always lands on a character boundary.
 */

import { types } from "node:util";

/**
 * Normalize a byte budget to a whole number of bytes (#2524). A fractional
 * budget used to skip the continuation-byte check (`buffer[4.5]` is
 * undefined) while `subarray()` still floored the cut, splitting a
 * character. Non-numeric / NaN budgets mean zero; Infinity stays Infinity.
 */
export function byteBudget(maxBytes) {
	const value = Number(maxBytes);
	if (Number.isNaN(value)) return 0;
	return Math.max(0, Math.floor(value));
}

/**
 * View any input as the bytes a cut operates on (#2528). Buffers pass through;
 * every other ArrayBufferView (Uint8Array, DataView, Uint16Array, ...) and a
 * bare ArrayBuffer are viewed as their underlying bytes without copying;
 * strings and anything else become their UTF-8 encoding (null/undefined -> "").
 * Both exported cut helpers use this one rule, so they agree on every input.
 */
function toBytes(input) {
	if (Buffer.isBuffer(input)) return input;
	if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
	// isAnyArrayBuffer also covers SharedArrayBuffer and an ArrayBuffer from
	// another realm (vm context), which `instanceof ArrayBuffer` misses (#2529 review).
	if (types.isAnyArrayBuffer(input)) return Buffer.from(input);
	return Buffer.from(String(input ?? ""), "utf8");
}

/** A valid UTF-8 character has at most 3 continuation bytes after its lead. */
const MAX_CONTINUATION_BYTES = 3;

/**
 * Byte length of the UTF-8 sequence a lead byte starts, or 1 for ASCII and
 * for bytes that cannot start a valid multi-byte sequence (0xC0/0xC1
 * overlong leads, 0xF5-0xFF).
 */
function sequenceLength(lead) {
	if (lead >= 0xc2 && lead <= 0xdf) return 2;
	if (lead >= 0xe0 && lead <= 0xef) return 3;
	if (lead >= 0xf0 && lead <= 0xf4) return 4;
	return 1;
}

/**
 * Largest end index <= maxBytes that does not split a UTF-8 character.
 * A byte is a continuation byte iff (byte & 0xc0) === 0x80.
 * Input of any kind is measured and scanned as bytes (see toBytes), and the
 * result is a BYTE offset into those bytes - for a Uint16Array or other wide
 * typed array it is not an element index (use sliceUtf8AtBoundary to cut).
 *
 * When the cut lands on a continuation byte, look back at most 3 bytes for
 * the lead byte of that character and cut before it only if that lead really
 * starts a sequence that runs past the cut. Otherwise the bytes at the cut
 * are malformed (a stray continuation run, an invalid or overlong lead, a run
 * from index 0), and the cut stays at the budget (#2528, #2529 review): one
 * rule for every malformed case, never sliding back to drop valid text. On
 * valid UTF-8 this is the same cut as the unbounded back-off.
 */
export function utf8BoundaryEnd(buffer, maxBytes) {
	const bytes = toBytes(buffer);
	const length = bytes.length;
	const limit = Math.min(byteBudget(maxBytes), length);
	if (limit <= 0 || limit >= length) return limit;
	const isContinuation = (index) => (bytes[index] & 0xc0) === 0x80;
	if (!isContinuation(limit)) return limit;
	for (let back = 1; back <= MAX_CONTINUATION_BYTES && limit - back >= 0; back++) {
		const index = limit - back;
		if (isContinuation(index)) continue;
		return sequenceLength(bytes[index]) > back ? index : limit;
	}
	return limit;
}

/**
 * Boundary-safe byte-capped slice. Returns a Buffer of at most maxBytes
 * bytes whose utf8 decoding never contains replacement characters caused
 * by the cut itself. Input is viewed as bytes the same way as in
 * utf8BoundaryEnd (#2524 review, #2528). The result is a zero-copy view of
 * byte input: for a SharedArrayBuffer another thread may change the bytes
 * after the cut, which voids the guarantee - copy first if that can happen.
 */
export function sliceUtf8AtBoundary(buffer, maxBytes) {
	const buf = toBytes(buffer);
	const budget = byteBudget(maxBytes);
	if (buf.length <= budget) return buf;
	return buf.subarray(0, utf8BoundaryEnd(buf, budget));
}

/**
 * Boundary-safe string truncation to a byte budget. The returned string is
 * always decodable-clean and at most maxBytes long in utf8.
 */
export function truncateUtf8ToBytesSafe(text, maxBytes) {
	const value = String(text ?? "");
	const budget = byteBudget(maxBytes);
	if (Buffer.byteLength(value, "utf8") <= budget) return value;
	return sliceUtf8AtBoundary(Buffer.from(value, "utf8"), budget).toString("utf8");
}
