#!/usr/bin/env node
/**
 * Entry point for the egress proxy container (#2395, design option A).
 * Configuration comes only from the proxy container's own environment, never
 * from a task:
 *
 * - `A2A_EGRESS_PROXY_MODE`            `observe` | `enforce` (required; no default)
 * - `A2A_EGRESS_PROXY_LISTEN`          `host:port` (default `0.0.0.0:3128`)
 * - `A2A_EGRESS_PROXY_ALLOWLIST`       comma-separated exact hostnames
 * - `A2A_EGRESS_PROXY_ALLOWED_PORTS`   comma-separated ports (default `443`)
 * - `A2A_EGRESS_PROXY_CREDENTIALS_DIR` directory of `<runId>.sha256` files (required
 *                                      unless `A2A_EGRESS_PROXY_ALLOW_UNAUTHENTICATED=1`)
 * - `A2A_EGRESS_PROXY_LOG_DIR`         JSONL log directory (default: records go to stdout)
 * - `A2A_EGRESS_PROXY_LOG_MAX_FILE_BYTES` per-day log cap
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  createCredentialDirAuthenticator,
  createEgressProxy,
  createJsonlEgressLog,
  DEFAULT_EGRESS_PROXY_ALLOWED_PORTS,
  DEFAULT_EGRESS_PROXY_LOG_MAX_FILE_BYTES,
  DEFAULT_EGRESS_PROXY_PORT,
  EgressProxyConfigError,
  normalizeEgressProxyAllowlist,
  type EgressProxyMode,
  type EgressProxyOptions,
  type EgressProxyRecord,
} from "./egress-proxy.js";

export interface EgressProxyEnvConfig {
  mode: EgressProxyMode;
  listenHost: string;
  listenPort: number;
  allowlist: string[];
  allowedPorts: number[];
  credentialsDir?: string;
  logDir?: string;
  logMaxFileBytes: number;
}

function parseList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parsePort(raw: string, name: string): number {
  if (!/^\d{1,5}$/.test(raw)) throw new EgressProxyConfigError(`${name}: invalid port ${JSON.stringify(raw)}`);
  const port = Number(raw);
  if (port < 1 || port > 65_535) throw new EgressProxyConfigError(`${name}: port out of range ${JSON.stringify(raw)}`);
  return port;
}

export function parseEgressProxyEnv(env: NodeJS.ProcessEnv): EgressProxyEnvConfig {
  const modeRaw = (env.A2A_EGRESS_PROXY_MODE ?? "").trim();
  if (modeRaw !== "observe" && modeRaw !== "enforce") {
    throw new EgressProxyConfigError(`A2A_EGRESS_PROXY_MODE must be observe or enforce (got ${JSON.stringify(modeRaw)})`);
  }

  const listen = (env.A2A_EGRESS_PROXY_LISTEN ?? "").trim() || `0.0.0.0:${DEFAULT_EGRESS_PROXY_PORT}`;
  const listenMatch = /^(.+):(\d{1,5})$/.exec(listen);
  if (!listenMatch) throw new EgressProxyConfigError(`A2A_EGRESS_PROXY_LISTEN must be host:port (got ${JSON.stringify(listen)})`);
  const listenHost = listenMatch[1]!.replace(/^\[(.*)\]$/, "$1");
  const listenPort = parsePort(listenMatch[2]!, "A2A_EGRESS_PROXY_LISTEN");

  const allowlist = normalizeEgressProxyAllowlist(parseList(env.A2A_EGRESS_PROXY_ALLOWLIST));
  const portsRaw = parseList(env.A2A_EGRESS_PROXY_ALLOWED_PORTS);
  const allowedPorts = portsRaw.length > 0 ? portsRaw.map((p) => parsePort(p, "A2A_EGRESS_PROXY_ALLOWED_PORTS")) : [...DEFAULT_EGRESS_PROXY_ALLOWED_PORTS];

  const credentialsDir = (env.A2A_EGRESS_PROXY_CREDENTIALS_DIR ?? "").trim() || undefined;
  const allowUnauthenticated = (env.A2A_EGRESS_PROXY_ALLOW_UNAUTHENTICATED ?? "").trim() === "1";
  if (!credentialsDir && !allowUnauthenticated) {
    throw new EgressProxyConfigError("A2A_EGRESS_PROXY_CREDENTIALS_DIR is required (set A2A_EGRESS_PROXY_ALLOW_UNAUTHENTICATED=1 only for a local PoC)");
  }

  const logDir = (env.A2A_EGRESS_PROXY_LOG_DIR ?? "").trim() || undefined;
  const capRaw = (env.A2A_EGRESS_PROXY_LOG_MAX_FILE_BYTES ?? "").trim();
  let logMaxFileBytes = DEFAULT_EGRESS_PROXY_LOG_MAX_FILE_BYTES;
  if (capRaw) {
    if (!/^\d+$/.test(capRaw) || Number(capRaw) <= 0 || !Number.isSafeInteger(Number(capRaw))) {
      throw new EgressProxyConfigError(`A2A_EGRESS_PROXY_LOG_MAX_FILE_BYTES must be a positive integer (got ${JSON.stringify(capRaw)})`);
    }
    logMaxFileBytes = Number(capRaw);
  }

  return {
    mode: modeRaw,
    listenHost,
    listenPort,
    allowlist,
    allowedPorts,
    ...(credentialsDir ? { credentialsDir } : {}),
    ...(logDir ? { logDir } : {}),
    logMaxFileBytes,
  };
}

export function egressProxyOptionsFromConfig(config: EgressProxyEnvConfig): EgressProxyOptions {
  const log: (record: EgressProxyRecord) => void = config.logDir
    ? createJsonlEgressLog({ dir: config.logDir, maxFileBytes: config.logMaxFileBytes })
    : (record) => {
        process.stdout.write(`${JSON.stringify(record)}\n`);
      };
  return {
    mode: config.mode,
    allowlist: config.allowlist,
    allowedPorts: config.allowedPorts,
    ...(config.credentialsDir ? { authenticate: createCredentialDirAuthenticator(config.credentialsDir) } : {}),
    log,
  };
}

export function main(env: NodeJS.ProcessEnv = process.env): void {
  let config: EgressProxyEnvConfig;
  try {
    config = parseEgressProxyEnv(env);
  } catch (error) {
    process.stderr.write(`a2a-egress-proxy: ${(error as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  const { server, closeTunnels } = createEgressProxy(egressProxyOptionsFromConfig(config));
  server.once("error", (error) => {
    process.stderr.write(`a2a-egress-proxy: cannot listen on ${config.listenHost}:${config.listenPort}: ${(error as NodeJS.ErrnoException).code ?? error.message}\n`);
    process.exitCode = 2;
    server.close();
  });
  server.listen(config.listenPort, config.listenHost, () => {
    process.stderr.write(
      `a2a-egress-proxy: listening on ${config.listenHost}:${config.listenPort} mode=${config.mode} allowlist=${config.allowlist.length} auth=${config.credentialsDir ? "credentials-dir" : "none"} log=${config.logDir ? "dir" : "stdout"}\n`,
    );
  });
  const stop = (): void => {
    server.close();
    server.closeAllConnections();
    closeTunnels();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
