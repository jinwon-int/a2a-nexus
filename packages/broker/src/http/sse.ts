import type { IncomingMessage, ServerResponse } from "node:http";

export function writeSseResponseHeaders(res: ServerResponse<IncomingMessage>): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store, no-transform",
    connection: "keep-alive",
    // Disable proxy buffering (nginx, Caddy, most ingresses) so events flush immediately.
    "x-accel-buffering": "no",
    // CORS for browser-based consumers (dashboards, dev tools).
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "Last-Event-ID, x-a2a-requester-id, x-a2a-edge-secret",
  });
  res.flushHeaders?.();

  // Send retry advisory: wait 3 seconds before reconnecting.
  res.write("retry: 3000\n\n");
}

// Fan-out payloads (operator events, replay buffers) hand the same frozen
// data object to every subscriber; memoize its serialization so one emit
// serializes once instead of once per connection. Emitted payloads are
// treated as immutable after emit, so the cached text stays valid.
const serializedSseData = new WeakMap<object, string>();

function serializeSseData(data: unknown): string {
  if (typeof data !== "object" || data === null) {
    return JSON.stringify(data);
  }
  let serialized = serializedSseData.get(data);
  if (serialized === undefined) {
    serialized = JSON.stringify(data);
    serializedSseData.set(data, serialized);
  }
  return serialized;
}

export function writeSseEvent(
  res: ServerResponse<IncomingMessage>,
  event: string,
  data: unknown,
  id?: string,
): void {
  if (res.writableEnded) {
    return;
  }
  // One write per event frame instead of three keeps syscalls down.
  const idLine = id ? `id: ${id}\n` : "";
  res.write(`${idLine}event: ${event}\ndata: ${serializeSseData(data)}\n\n`);
}
