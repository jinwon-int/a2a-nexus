/**
 * Allowlist CONNECT proxy for trusted patch-lane containers (#2395 stage 2,
 * design: `docs/egress-proxy-design.md` option A).
 *
 * This module is the proxy component only. Nothing in the runner starts it or
 * routes task containers through it yet; that wiring ships separately behind
 * `A2A_DOCKER_RUNNER_EGRESS_MODE` (default `off`).
 *
 * Behaviour:
 * - Only `CONNECT host:port` tunnels are served. Plain-HTTP proxy requests get
 *   `405` in every mode and are logged, so observe mode still shows the need.
 * - Internal destinations (RFC 1918, loopback, link-local incl. cloud metadata,
 *   ULA, Docker bridge ranges, `localhost`, `*.internal`) are denied in both
 *   modes. The proxy resolves DNS itself, rejects the target when *any*
 *   resolved address is internal, and connects to the pinned address it checked.
 * - `observe` allows every other host/port and records what `enforce` would
 *   have denied (`wouldDeny`). `enforce` allows only allowlisted hostnames on
 *   the allowed ports (443 by default).
 * - Every decision produces one structured record; tunnel records carry byte
 *   counts and duration. Records never contain credentials, headers, or bodies.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import { isDeniedInternalHostname, isDeniedInternalIp, type EgressResolvedAddress } from "./egress-allowlist-proxy.js";

export const EGRESS_PROXY_RECORD_SCHEMA = "a2a.egress.connect.v1" as const;
export const EGRESS_PROXY_LOG_TRUNCATED_SCHEMA = "a2a.egress.log-truncated.v1" as const;
export const DEFAULT_EGRESS_PROXY_PORT = 3128;
export const DEFAULT_EGRESS_PROXY_ALLOWED_PORTS: readonly number[] = [443];
export const DEFAULT_EGRESS_PROXY_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_EGRESS_PROXY_IDLE_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_EGRESS_PROXY_MAX_CONNECTIONS = 256;
export const DEFAULT_EGRESS_PROXY_LOG_MAX_FILE_BYTES = 16 * 1024 * 1024;

export type EgressProxyMode = "observe" | "enforce";

export type EgressProxyDenyReason =
  | "auth_required"
  | "auth_failed"
  | "method_not_allowed"
  | "bad_target"
  | "internal_host_denied"
  | "internal_ip_denied"
  | "host_not_allowed"
  | "port_not_allowed"
  | "dns_resolution_failed"
  | "upstream_connect_failed"
  | "capacity_exceeded";

export type EgressProxyPolicyDenyReason = "host_not_allowed" | "port_not_allowed";

export interface EgressProxyRecord {
  schema: typeof EGRESS_PROXY_RECORD_SCHEMA;
  ts: string;
  mode: EgressProxyMode;
  /** Run attributed through proxy credentials; null when auth is not configured or failed. */
  runId: string | null;
  method: string;
  host: string | null;
  port: number | null;
  decision: "allow" | "deny";
  reason?: EgressProxyDenyReason;
  /** observe mode only: the policy decision `enforce` would have made. */
  wouldDeny?: EgressProxyPolicyDenyReason;
  resolvedIp?: string;
  bytesUp?: number;
  bytesDown?: number;
  durationMs?: number;
}

/** Returns the run id the credentials belong to, or undefined when they are not valid. */
export type EgressProxyAuthenticator = (runId: string, token: string) => string | undefined;

export interface EgressProxyOptions {
  mode: EgressProxyMode;
  /** Exact hostnames permitted in `enforce`. Ignored for decisions in `observe` (used for `wouldDeny`). */
  allowlist?: readonly string[];
  allowedPorts?: readonly number[];
  /** When set, every CONNECT must carry valid `Proxy-Authorization: Basic` credentials. */
  authenticate?: EgressProxyAuthenticator;
  log: (record: EgressProxyRecord) => void;
  resolveHost?: (hostname: string) => Promise<EgressResolvedAddress[]>;
  connect?: (address: string, port: number, family: 4 | 6) => Socket;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxConnections?: number;
  now?: () => Date;
}

export class EgressProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressProxyConfigError";
  }
}

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/**
 * Proxy credentials are runner-generated random tokens, not human passwords.
 * The minimum length makes that assumption enforceable: a fast digest is only
 * appropriate for high-entropy input (32 random bytes encode to 43 chars).
 */
export const EGRESS_PROXY_MIN_RUN_TOKEN_LENGTH = 32;

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function isValidHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  return host.split(".").every((label) => HOSTNAME_LABEL.test(label));
}

/**
 * Validates and normalizes an allowlist. Entries must be exact, lowercase,
 * public hostnames: no IP literals, ports, wildcards, or internal names.
 */
export function normalizeEgressProxyAllowlist(hosts: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of hosts) {
    const host = normalizeHost(raw);
    if (host === "") continue;
    if (host !== raw.trim().replace(/\.$/, "")) {
      throw new EgressProxyConfigError(`egress proxy allowlist host must be lowercase: ${JSON.stringify(raw)}`);
    }
    if (isIP(host) !== 0) throw new EgressProxyConfigError(`egress proxy allowlist must not contain IP literals: ${JSON.stringify(raw)}`);
    if (!isValidHostname(host)) throw new EgressProxyConfigError(`invalid egress proxy allowlist host: ${JSON.stringify(raw)}`);
    if (isDeniedInternalHostname(host)) throw new EgressProxyConfigError(`egress proxy allowlist rejects internal host: ${JSON.stringify(raw)}`);
    if (seen.has(host)) throw new EgressProxyConfigError(`duplicate egress proxy allowlist host: ${host}`);
    seen.add(host);
    out.push(host);
  }
  return out;
}

export interface EgressConnectTarget {
  host: string;
  port: number;
  /** 0 for a hostname, 4/6 for an IP literal. */
  ipFamily: 0 | 4 | 6;
}

/** Parses a CONNECT request-target (`host:port` or `[v6]:port`). Returns undefined when malformed. */
export function parseConnectTarget(target: string | undefined): EgressConnectTarget | undefined {
  if (!target || target.length > 300) return undefined;
  let rawHost: string;
  let rawPort: string;
  const bracketed = /^\[([0-9A-Fa-f:.]+)\]:(\d{1,5})$/.exec(target);
  if (bracketed) {
    rawHost = bracketed[1]!;
    rawPort = bracketed[2]!;
    if (isIP(rawHost) !== 6) return undefined;
  } else {
    const plain = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(target);
    if (!plain) return undefined;
    rawHost = plain[1]!;
    rawPort = plain[2]!;
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  const host = normalizeHost(rawHost);
  const ipFamily = isIP(host) as 0 | 4 | 6;
  if (ipFamily === 0 && !isValidHostname(host)) return undefined;
  return { host, port, ipFamily };
}

/** Decodes `Proxy-Authorization: Basic <base64(runId:token)>`. */
export function parseProxyBasicAuth(header: string | string[] | undefined): { runId: string; token: string } | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match) return undefined;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep <= 0) return undefined;
  return { runId: decoded.slice(0, sep), token: decoded.slice(sep + 1) };
}

/** A fresh per-run proxy token: 32 random bytes, base64url (43 chars). */
export function generateEgressProxyRunToken(): string {
  return randomBytes(32).toString("base64url");
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Hex SHA-256 digest of a runner-generated run token, written to
 * `<runId>.sha256`. Throws for tokens shorter than
 * `EGRESS_PROXY_MIN_RUN_TOKEN_LENGTH`.
 */
export function egressProxyRunTokenDigest(token: string): string {
  if (token.length < EGRESS_PROXY_MIN_RUN_TOKEN_LENGTH) {
    throw new EgressProxyConfigError(`egress proxy run token must be at least ${EGRESS_PROXY_MIN_RUN_TOKEN_LENGTH} characters (use generateEgressProxyRunToken)`);
  }
  return tokenDigest(token).toString("hex");
}

/**
 * Per-run credentials stored as `<dir>/<runId>.sha256` (hex SHA-256 of the
 * run's random token). The runner writes one file per run and removes it
 * afterwards; the proxy only needs read access. The Basic username is the run id.
 */
export function createCredentialDirAuthenticator(dir: string): EgressProxyAuthenticator {
  return (runId, token) => {
    if (!RUN_ID_PATTERN.test(runId) || runId.includes("..")) return undefined;
    if (token.length < EGRESS_PROXY_MIN_RUN_TOKEN_LENGTH) return undefined;
    let expectedHex: string;
    try {
      expectedHex = readFileSync(join(dir, `${runId}.sha256`), "utf8").trim().toLowerCase();
    } catch {
      return undefined;
    }
    if (!/^[0-9a-f]{64}$/.test(expectedHex)) return undefined;
    return timingSafeEqual(tokenDigest(token), Buffer.from(expectedHex, "hex")) ? runId : undefined;
  };
}

async function defaultResolveHost(hostname: string): Promise<EgressResolvedAddress[]> {
  const rows = await lookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => ({ address: row.address, family: row.family as 4 | 6 }));
}

function defaultConnect(address: string, port: number, family: 4 | 6): Socket {
  return netConnect({ host: address, port, family });
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  405: "Method Not Allowed",
  407: "Proxy Authentication Required",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

const DENY_STATUS: Record<EgressProxyDenyReason, number> = {
  auth_required: 407,
  auth_failed: 407,
  method_not_allowed: 405,
  bad_target: 400,
  internal_host_denied: 403,
  internal_ip_denied: 403,
  host_not_allowed: 403,
  port_not_allowed: 403,
  dns_resolution_failed: 502,
  upstream_connect_failed: 502,
  capacity_exceeded: 503,
};

function writeRawDeny(socket: Duplex, reason: EgressProxyDenyReason): void {
  const status = DENY_STATUS[reason];
  const body = `${reason}\n`;
  const headers = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}`,
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
  ];
  if (status === 407) headers.push('Proxy-Authenticate: Basic realm="a2a-egress"');
  if (socket.writable) socket.end(`${headers.join("\r\n")}\r\n\r\n${body}`);
  else socket.destroy();
}

export interface EgressProxy {
  server: Server;
  /** Number of open tunnels (and tunnels being set up). */
  activeConnections(): number;
  /**
   * Destroys every open tunnel. CONNECT sockets leave the HTTP server's own
   * connection tracking, so `server.closeAllConnections()` does not reach them;
   * call this on shutdown or `server.close()` waits for tunnels to end.
   */
  closeTunnels(): void;
}

/** Creates (but does not start) the proxy server. Call `server.listen(...)`. */
export function createEgressProxy(options: EgressProxyOptions): EgressProxy {
  if (options.mode !== "observe" && options.mode !== "enforce") {
    throw new EgressProxyConfigError(`invalid egress proxy mode: ${JSON.stringify(options.mode)} (expected observe|enforce)`);
  }
  const allowlist = new Set(normalizeEgressProxyAllowlist(options.allowlist ?? []));
  const allowedPorts = new Set(options.allowedPorts ?? DEFAULT_EGRESS_PROXY_ALLOWED_PORTS);
  for (const port of allowedPorts) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new EgressProxyConfigError(`invalid egress proxy allowed port: ${port}`);
  }
  const resolveHost = options.resolveHost ?? defaultResolveHost;
  const connect = options.connect ?? defaultConnect;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_EGRESS_PROXY_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_EGRESS_PROXY_IDLE_TIMEOUT_MS;
  const maxConnections = options.maxConnections ?? DEFAULT_EGRESS_PROXY_MAX_CONNECTIONS;
  const now = options.now ?? (() => new Date());
  const mode = options.mode;
  let active = 0;
  const tunnelSockets = new Set<Duplex>();
  const track = (socket: Duplex): void => {
    tunnelSockets.add(socket);
    socket.once("close", () => tunnelSockets.delete(socket));
  };

  const emit = (record: Omit<EgressProxyRecord, "schema" | "ts" | "mode">): void => {
    try {
      options.log({ schema: EGRESS_PROXY_RECORD_SCHEMA, ts: now().toISOString(), mode, ...record });
    } catch {
      // Logging must never take the proxy down or change a decision.
    }
  };

  const policyDeny = (target: EgressConnectTarget): EgressProxyPolicyDenyReason | undefined => {
    if (target.ipFamily !== 0 || !allowlist.has(target.host)) return "host_not_allowed";
    if (!allowedPorts.has(target.port)) return "port_not_allowed";
    return undefined;
  };

  const authenticate = (req: IncomingMessage): { runId: string | null; reason?: EgressProxyDenyReason } => {
    if (!options.authenticate) return { runId: null };
    const creds = parseProxyBasicAuth(req.headers["proxy-authorization"]);
    if (!creds) return { runId: null, reason: "auth_required" };
    const runId = options.authenticate(creds.runId, creds.token);
    return runId ? { runId } : { runId: null, reason: "auth_failed" };
  };

  const server = createServer();

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/healthz") {
      const body = JSON.stringify({ ok: true, mode, allowlistSize: allowlist.size, activeConnections: active });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    let host: string | null = null;
    let port: number | null = null;
    try {
      const url = new URL(req.url ?? "");
      host = normalizeHost(url.hostname);
      port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    } catch {
      // origin-form or garbage: nothing to attribute.
    }
    const { runId } = authenticate(req);
    emit({ runId, method: req.method ?? "", host, port, decision: "deny", reason: "method_not_allowed" });
    const body = "method_not_allowed\n";
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(body), Connection: "close" });
    res.end(body);
  });

  server.on("clientError", (_err, socket: Duplex) => {
    socket.destroy();
  });

  server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
    const started = Date.now();
    const target = parseConnectTarget(req.url);
    const auth = authenticate(req);
    const base = { runId: auth.runId, method: "CONNECT", host: target?.host ?? null, port: target?.port ?? null };
    const deny = (reason: EgressProxyDenyReason, extra: Partial<EgressProxyRecord> = {}): void => {
      emit({ ...base, decision: "deny", reason, ...extra });
      writeRawDeny(client, reason);
    };
    client.on("error", () => client.destroy());
    track(client);

    if (auth.reason) return deny(auth.reason);
    if (!target) return deny("bad_target");
    if (target.ipFamily === 0 && isDeniedInternalHostname(target.host)) return deny("internal_host_denied");
    if (target.ipFamily !== 0 && isDeniedInternalIp(target.host)) return deny("internal_ip_denied");
    const policy = policyDeny(target);
    if (policy && mode === "enforce") return deny(policy);
    const wouldDeny = mode === "observe" ? policy : undefined;
    if (active >= maxConnections) return deny("capacity_exceeded", wouldDeny ? { wouldDeny } : {});

    active += 1;
    let released = false;
    const release = (): void => {
      if (!released) {
        released = true;
        active -= 1;
      }
    };
    client.once("close", release);

    void (async () => {
      let resolved: EgressResolvedAddress;
      if (target.ipFamily !== 0) {
        resolved = { address: target.host, family: target.ipFamily };
      } else {
        let rows: EgressResolvedAddress[];
        try {
          rows = await resolveHost(target.host);
        } catch {
          rows = [];
        }
        if (rows.length === 0) {
          release();
          return deny("dns_resolution_failed", wouldDeny ? { wouldDeny } : {});
        }
        const internal = rows.find((row) => isDeniedInternalIp(row.address));
        if (internal) {
          release();
          return deny("internal_ip_denied", { resolvedIp: internal.address });
        }
        resolved = rows[0]!;
      }
      if (client.destroyed) {
        release();
        return;
      }

      const upstream = connect(resolved.address, target.port, resolved.family);
      track(upstream);
      let established = false;
      let logged = false;
      const finish = (): void => {
        if (logged) return;
        logged = true;
        release();
        emit({
          ...base,
          decision: "allow",
          ...(wouldDeny ? { wouldDeny } : {}),
          resolvedIp: resolved.address,
          bytesUp: upstream.bytesWritten,
          bytesDown: upstream.bytesRead,
          durationMs: Date.now() - started,
        });
      };

      upstream.setTimeout(connectTimeoutMs, () => upstream.destroy(new Error("connect timeout")));
      upstream.once("connect", () => {
        established = true;
        upstream.setTimeout(idleTimeoutMs, () => {
          upstream.destroy();
          client.destroy();
        });
        if (client.destroyed) {
          upstream.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => {
        if (!established) {
          if (!logged) {
            logged = true;
            release();
            deny("upstream_connect_failed", { resolvedIp: resolved.address, ...(wouldDeny ? { wouldDeny } : {}) });
          }
          return;
        }
        client.destroy();
      });
      upstream.on("close", () => {
        if (established) {
          client.destroy();
          finish();
        }
      });
      client.on("close", () => {
        if (established) {
          upstream.destroy();
          finish();
        } else {
          upstream.destroy();
        }
      });
    })();
  });

  return {
    server,
    activeConnections: () => active,
    closeTunnels: () => {
      for (const socket of tunnelSockets) socket.destroy();
    },
  };
}

export interface JsonlEgressLogOptions {
  dir: string;
  maxFileBytes?: number;
  now?: () => Date;
}

/**
 * Appends records to `<dir>/egress-YYYY-MM-DD.jsonl` (UTC day, mode 0600).
 * Once a day's file reaches `maxFileBytes`, further records that day are
 * dropped and a single truncation marker is written, so a noisy task cannot
 * fill the disk.
 */
export function createJsonlEgressLog(options: JsonlEgressLogOptions): (record: EgressProxyRecord) => void {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_EGRESS_PROXY_LOG_MAX_FILE_BYTES;
  const now = options.now ?? (() => new Date());
  mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  let currentDay = "";
  let size = 0;
  let truncated = false;
  return (record) => {
    const day = now().toISOString().slice(0, 10);
    const file = join(options.dir, `egress-${day}.jsonl`);
    if (day !== currentDay) {
      currentDay = day;
      truncated = false;
      try {
        size = statSync(file).size;
      } catch {
        size = 0;
      }
    }
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    if (size + bytes > maxFileBytes) {
      if (!truncated) {
        truncated = true;
        const marker = `${JSON.stringify({ schema: EGRESS_PROXY_LOG_TRUNCATED_SCHEMA, ts: now().toISOString(), maxFileBytes })}\n`;
        appendFileSync(file, marker, { mode: 0o600 });
        size += Buffer.byteLength(marker);
      }
      return;
    }
    appendFileSync(file, line, { mode: 0o600 });
    size += bytes;
  };
}
