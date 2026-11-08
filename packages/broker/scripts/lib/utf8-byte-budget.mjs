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
 * Largest end index <= maxBytes that does not split a UTF-8 character.
 * A byte is a continuation byte iff (byte & 0xc0) === 0x80.
 * String input is measured and scanned as its UTF-8 bytes (#2524).
 */
export function utf8BoundaryEnd(buffer, maxBytes) {
	const bytes = typeof buffer === "string" ? Buffer.from(buffer, "utf8") : buffer;
	const length = Buffer.byteLength(bytes);
	let end = Math.min(byteBudget(maxBytes), length);
	while (end > 0 && end < length && (bytes[end] & 0xc0) === 0x80) end--;
	return end;
}

/**
 * Boundary-safe byte-capped slice. Returns a Buffer of at most maxBytes
 * bytes whose utf8 decoding never contains replacement characters caused
 * by the cut itself.
 */
export function sliceUtf8AtBoundary(buffer, maxBytes) {
	// Any byte view (Buffer, Uint8Array, DataView, ...) is cut as bytes; only
	// non-byte input is stringified. A plain Uint8Array used to go through
	// String() and be re-encoded as "234,176,128" text (#2524 review).
	const buf = Buffer.isBuffer(buffer)
		? buffer
		: ArrayBuffer.isView(buffer)
			? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
			: Buffer.from(String(buffer ?? ""), "utf8");
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
