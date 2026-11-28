#!/usr/bin/env node
/**
 * MCP Tasks server entry point — stdio (a2a-nexus #2591 design §4.1, step 3
 * preparation).
 *
 *   node dist/mcp-tasks-server/cli.js                 serve MCP over stdin/stdout
 *   node dist/mcp-tasks-server/cli.js --check-config  validate config, print a redacted summary, exit
 *
 * Configuration: environment variables in {@link CONFIG_ENV}; the edge secret
 * is read from the env file named by A2A_MCP_TASKS_ENV_FILE (design §4.2).
 * stdout carries JSON-RPC responses only; logs go to stderr as one JSON
 * object per line with closed-vocabulary fields.
 *
 * Exit codes: 0 stdin closed (or --check-config ok) · 2 configuration refused
 * · 1 unexpected failure. A refused configuration never serves a request.
 */
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";

import { JsonRpcBrokerClient, httpJsonRpcCall } from "./broker-client.js";
import { loadServerConfig, redactedConfigSummary, type McpTasksServerConfig } from "./config.js";
import { FileCreatedTaskStore } from "./created-task-store.js";
import { McpTasksServer, McpTasksServerConfigError } from "./server.js";
import { serveStdio } from "./stdio.js";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_CONFIG_REFUSED = 2;

export interface CliIo {
  env: Record<string, string | undefined>;
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  fetchImpl?: typeof fetch;
}

function logLine(stderr: Writable, record: Record<string, unknown>): void {
  stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
}

export function createServer(config: McpTasksServerConfig, io: Pick<CliIo, "stderr" | "fetchImpl">): McpTasksServer {
  const call = httpJsonRpcCall({
    baseUrl: config.brokerUrl,
    edgeSecret: config.edgeSecret,
    identity: config.identity,
    ...(io.fetchImpl ? { fetchImpl: io.fetchImpl } : {}),
  });
  return new McpTasksServer({
    broker: new JsonRpcBrokerClient(call),
    identity: config.identity,
    store: new FileCreatedTaskStore(config.stateDir, config.sessionId),
    allowedTargetNodeIds: config.allowedTargetNodeIds,
    log: (event) => logLine(io.stderr, { event: "mcp_tasks", ...event }),
  });
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const unknown = argv.filter((arg) => arg !== "--check-config");
  if (unknown.length > 0) {
    logLine(io.stderr, { event: "start_refused", reason: "unknown_argument" });
    return EXIT_CONFIG_REFUSED;
  }
  const checkOnly = argv.includes("--check-config");
  let config: McpTasksServerConfig;
  let server: McpTasksServer | undefined;
  try {
    config = loadServerConfig(io.env);
    // --check-config validates without side effects: no state directory, no store file.
    if (!checkOnly) server = createServer(config, io);
  } catch (error) {
    // Config errors name variables and file paths only — never a value read from the env file.
    const reason = error instanceof Error ? error.message : "configuration refused";
    logLine(io.stderr, { event: "start_refused", reason });
    return error instanceof McpTasksServerConfigError || (error instanceof Error && error.name === "CreatedTaskStoreError")
      ? EXIT_CONFIG_REFUSED
      : EXIT_FAILURE;
  }
  if (checkOnly || !server) {
    io.stderr.write(`${JSON.stringify({ event: "config_ok", config: redactedConfigSummary(config) })}\n`);
    return EXIT_OK;
  }
  logLine(io.stderr, { event: "started", identity: config.identity.id, role: config.identity.role, targets: config.allowedTargetNodeIds.length });
  await serveStdio(server, io.stdin, io.stdout);
  logLine(io.stderr, { event: "stopped", reason: "stdin_closed" });
  return EXIT_OK;
}

// Run only when executed directly (tests import runCli).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2), { env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr })
    .then((code) => { process.exitCode = code; })
    .catch(() => {
      process.stderr.write(`${JSON.stringify({ event: "crashed" })}\n`);
      process.exitCode = EXIT_FAILURE;
    });
}
