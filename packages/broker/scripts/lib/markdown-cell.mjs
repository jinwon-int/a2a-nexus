/**
 * Common Markdown table-cell encoder (a2a-nexus#1502, criterion 3).
 *
 * Escapes the characters that can break out of, or inject into, a Markdown
 * table cell:
 *   - pipe `|`   -> `\|`   (an unescaped pipe would open a new column)
 *   - CR / LF    -> `<br>` (a raw newline would break the table row)
 *   - C0 control chars (except TAB) and DEL -> dropped
 *
 * The encoder is PURE and IDEMPOTENT:
 *   encodeMarkdownCell(encodeMarkdownCell(x)) === encodeMarkdownCell(x)
 * The pipe rule (`/\\?\|/g` -> `\|`) rewrites an already-escaped `\|` back to
 * `\|`, so re-encoding does not double-escape. (This tolerates a single level
 * of prior escaping — the standard behavior for a cell encoder.)
 *
 * Coercion mirrors the broker report renderers' `asText()` so the four
 * renderers that adopt this stay behavior-neutral for already-safe inputs.
 *
 * Safety: pure string transform; no I/O, no network, no side effects.
 */

// C0 control characters except TAB (\x09); LF/CR are already normalized to
// <br> before this runs, so they are excluded too. DEL (\x7F) is dropped.
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function encodeMarkdownCell(value) {
  if (value === null || value === undefined) return '';
  let text;
  if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    text = String(value);
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
    if (typeof text !== 'string') text = String(value);
  }
  return text
    .replace(/\r\n|\r|\n/g, '<br>')
    .replace(CONTROL_CHARS, '')
    .replace(/\\?\|/g, '\\|');
}
