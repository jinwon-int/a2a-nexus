import type { IncomingMessage } from "node:http";

import { BrokerError } from "../core/broker.js";

// Hard cap on any request body the broker buffers, so a single oversized POST
// cannot exhaust memory. Generous for JSON APIs (task/proposal payloads); large
// state transfers have their own bounded paths.
export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

// Cache the in-flight read, not its result: a request stream can only be
// consumed once, so two callers racing on the same IncomingMessage (signature
// verification and the route handler, say) must share one read. Caching the
// resolved Buffer alone let the second caller iterate an already-drained
// stream and cache an empty body over the real one.
const rawBodyCache = new WeakMap<IncomingMessage, Promise<Buffer>>();

export function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const cached = rawBodyCache.get(req);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        throw new BrokerError("bad_request", `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  })();

  // A failed read stays cached so every caller sees the same rejection rather
  // than retrying against a drained stream.
  rawBodyCache.set(req, pending);
  return pending;
}

export async function readJson<T = unknown>(req: IncomingMessage): Promise<T | null> {
  const raw = await readRawBody(req);
  if (raw.length === 0) {
    return null;
  }

  try {
    return JSON.parse(raw.toString("utf8")) as T;
  } catch {
    throw new BrokerError("bad_request", "invalid JSON body");
  }
}
