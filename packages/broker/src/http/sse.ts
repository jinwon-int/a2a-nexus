import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * #2256 A5: SSE CORS is opt-in per origin. Every SSE route sits behind the
 * edge-secret gate and the broker answers no CORS preflight, so the former
 * `access-control-allow-origin: *` (plus advertising `x-a2a-edge-secret` as an
 * allowed header) served no working cross-origin consumer and only invited
 * embedding the shared secret in browser JS. Now: no CORS headers by default
 * (same-origin only); an exact origin listed in `A2A_SSE_ALLOWED_ORIGINS`
 * (comma-separated, e.g. `https://dashboard.example`) is echoed back with
 * `Vary: Origin`. The edge secret is never advertised as an allowed header.
 */
export function resolveSseCorsOrigin(
  requestOrigin: string | string[] | undefined,
  allowedOrigins: string | undefined = process.env.A2A_SSE_ALLOWED_ORIGINS,
): string | undefined {
  if (typeof requestOrigin !== "string" || !allowedOrigins) return undefined;
  const origin = requestOrigin.trim();
  if (!origin || origin === "null") return undefined;
  const allowed = allowedOrigins.split(",").map((entry) => entry.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : undefined;
}

export function writeSseResponseHeaders(res: ServerResponse<IncomingMessage>): void {
  const corsOrigin = resolveSseCorsOrigin(res.req?.headers?.origin);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store, no-transform",
    connection: "keep-alive",
    // Disable proxy buffering (nginx, Caddy, most ingresses) so events flush immediately.
    "x-accel-buffering": "no",
    ...(corsOrigin
      ? {
          "access-control-allow-origin": corsOrigin,
          "access-control-allow-headers": "Last-Event-ID",
          vary: "Origin",
        }
      : {}),
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
