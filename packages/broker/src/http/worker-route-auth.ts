import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { BrokerError } from "../core/broker.js";

export function hasA2AHttpSignatureHeaders(req: IncomingMessage): boolean {
  return Boolean(headerValue(req, "signature-input") || headerValue(req, "signature"));
}

export function requestHeadersForA2AHttpSignature(req: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
}

export function assertA2AContentDigestMatches(req: IncomingMessage, rawBody: Buffer): void {
  const provided = headerValue(req, "content-digest");
  if (!provided) {
    throw new BrokerError("unauthorized", "a2a_signature_digest_required: content-digest is required");
  }
  const expected = `sha-256=:${createHash("sha256").update(rawBody).digest("base64")}:`;
  if (provided !== expected) {
    throw new BrokerError("unauthorized", "a2a_signature_digest_mismatch: content-digest does not match request body");
  }
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0]?.trim() || undefined;
  }
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  return undefined;
}
