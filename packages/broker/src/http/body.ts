import type { IncomingMessage } from "node:http";

import { BrokerError } from "../core/broker.js";

// Hard cap on any request body the broker buffers, so a single oversized POST
// cannot exhaust memory. Generous for JSON APIs (task/proposal payloads); large
// state transfers have their own bounded paths.
export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

export async function readRawBody(req: IncomingMessage): Promise<Buffer> {
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
