import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Truncate a message to `maxLen` characters, appending "..." if truncated.
 * Returns the original message unchanged when it fits within the limit.
 */
export function truncateMessage(msg: string, maxLen: number): string {
  if (msg.length <= maxLen) return msg;
  return `${msg.slice(0, Math.max(0, maxLen - 3))}...`;
}

// Compact serialization by default: indented output is slower to produce and
// 20-40% larger on the wire across every JSON route. Humans debugging with
// curl can opt back in per process (or pipe through `python3 -m json.tool`).
const PRETTY_JSON_RESPONSES = process.env.A2A_HTTP_PRETTY_JSON === "1";

export function sendJson(
  res: ServerResponse<IncomingMessage>,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const json = PRETTY_JSON_RESPONSES ? JSON.stringify(body, null, 2) : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
}
