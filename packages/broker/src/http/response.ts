import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Truncate a message to `maxLen` characters, appending "..." if truncated.
 * Returns the original message unchanged when it fits within the limit.
 */
export function truncateMessage(msg: string, maxLen: number): string {
  if (msg.length <= maxLen) return msg;
  return `${msg.slice(0, Math.max(0, maxLen - 3))}...`;
}

export function sendJson(
  res: ServerResponse<IncomingMessage>,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
}
