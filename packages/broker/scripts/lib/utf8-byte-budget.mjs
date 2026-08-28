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
 * Largest end index <= maxBytes that does not split a UTF-8 character.
 * A byte is a continuation byte iff (byte & 0xc0) === 0x80.
 */
export function utf8BoundaryEnd(buffer, maxBytes) {
	const length = Buffer.byteLength(buffer);
	const limit = Math.max(0, Math.min(Number(maxBytes) || 0, length));
	let end = limit;
	while (end > 0 && end < length && (buffer[end] & 0xc0) === 0x80) end--;
	return end;
}

/**
 * Boundary-safe byte-capped slice. Returns a Buffer of at most maxBytes
 * bytes whose utf8 decoding never contains replacement characters caused
 * by the cut itself.
 */
export function sliceUtf8AtBoundary(buffer, maxBytes) {
	const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ""), "utf8");
	if (buf.length <= maxBytes) return buf;
	return buf.subarray(0, utf8BoundaryEnd(buf, maxBytes));
}

/**
 * Boundary-safe string truncation to a byte budget. The returned string is
 * always decodable-clean and at most maxBytes long in utf8.
 */
export function truncateUtf8ToBytesSafe(text, maxBytes) {
	const value = String(text ?? "");
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	return sliceUtf8AtBoundary(Buffer.from(value, "utf8"), maxBytes).toString("utf8");
}
