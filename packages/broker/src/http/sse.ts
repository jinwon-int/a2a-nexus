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

export function writeSseEvent(
  res: ServerResponse<IncomingMessage>,
  event: string,
  data: unknown,
  id?: string,
): void {
  if (res.writableEnded) {
    return;
  }
  if (id) {
    res.write(`id: ${id}\n`);
  }
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
