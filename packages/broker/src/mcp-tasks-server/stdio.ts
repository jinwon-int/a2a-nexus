/**
 * stdio transport for the MCP Tasks server (a2a-nexus #2591 design §4.1):
 * newline-delimited JSON-RPC on stdin/stdout, no socket, no port. The MCP
 * client launches the server as a subprocess, so the trust boundary is the
 * local OS account. Batches are refused; a line that is not JSON gets a
 * parse error with a null id. Nothing but JSON-RPC responses goes to stdout.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { JSONRPC_INVALID_REQUEST, JSONRPC_PARSE_ERROR, type JsonRpcResponse, type McpTasksServer } from "./server.js";

export const STDIO_MAX_LINE_LENGTH = 1_000_000;

export async function handleStdioLine(server: McpTasksServer, line: string): Promise<JsonRpcResponse | undefined> {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > STDIO_MAX_LINE_LENGTH) {
    return { jsonrpc: "2.0", id: null, error: { code: JSONRPC_INVALID_REQUEST, message: "message too large" } };
  }
  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return { jsonrpc: "2.0", id: null, error: { code: JSONRPC_PARSE_ERROR, message: "parse error" } };
  }
  if (Array.isArray(message)) {
    return { jsonrpc: "2.0", id: null, error: { code: JSONRPC_INVALID_REQUEST, message: "batches are not supported" } };
  }
  return server.handle(message);
}

/** Serves requests in arrival order until `input` ends. Resolves when the stream closes. */
export async function serveStdio(server: McpTasksServer, input: Readable, output: Writable): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const response = await handleStdioLine(server, line);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
}
