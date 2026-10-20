import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect as netConnect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import type { EgressResolvedAddress } from "./egress-allowlist-proxy.js";
import {
  createCredentialDirAuthenticator,
  createEgressProxy,
  createJsonlEgressLog,
  EGRESS_PROXY_LOG_TRUNCATED_SCHEMA,
  EgressProxyConfigError,
  egressProxyRunTokenDigest,
  EGRESS_PROXY_MIN_RUN_TOKEN_LENGTH,
  generateEgressProxyRunToken,
  normalizeEgressProxyAllowlist,
  parseConnectTarget,
  type EgressProxyOptions,
  type EgressProxyRecord,
} from "./egress-proxy.js";
import { parseEgressProxyEnv } from "./egress-proxy-main.js";

const trackedTempDirs: string[] = [];
function trackTempDir(dir: string): string {
  trackedTempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of trackedTempDirs) rmSync(dir, { recursive: true, force: true });
});

// Documentation-range addresses (RFC 5737) stand in for public upstreams; the
// test connector maps them onto local listeners so no traffic leaves the host.
const PUBLIC_A = "203.0.113.10";
const PUBLIC_B = "203.0.113.11";
const PUBLIC_REFUSED = "203.0.113.99";

const DNS: Record<string, EgressResolvedAddress[]> = {
  "allowed.example": [{ address: PUBLIC_A, family: 4 }],
  "other.example": [{ address: PUBLIC_B, family: 4 }],
  "refused.example": [{ address: PUBLIC_REFUSED, family: 4 }],
  "meta.example": [{ address: "169.254.169.254", family: 4 }],
  "mixed.example": [
    { address: PUBLIC_A, family: 4 },
    { address: "10.0.0.5", family: 4 },
  ],
  "loop6.example": [{ address: "::ffff:127.0.0.1", family: 6 }],
  "2130706433": [{ address: "127.0.0.1", family: 4 }],
};

interface Harness {
  port: number;
  records: EgressProxyRecord[];
  dnsCalls: string[];
  connectCalls: string[];
  close(): Promise<void>;
}

async function startEcho(): Promise<{ port: number; server: NetServer; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, server, sockets };
}

async function closedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startProxy(options: Partial<EgressProxyOptions> & Pick<EgressProxyOptions, "mode">): Promise<Harness> {
  const echo = await startEcho();
  const refused = await closedPort();
  const records: EgressProxyRecord[] = [];
  const dnsCalls: string[] = [];
  const connectCalls: string[] = [];
  const upstreamPorts: Record<string, number> = { [PUBLIC_A]: echo.port, [PUBLIC_B]: echo.port, [PUBLIC_REFUSED]: refused };
  const proxy = createEgressProxy({
    log: (record) => records.push(record),
    resolveHost: async (hostname) => {
      dnsCalls.push(hostname);
      const rows = DNS[hostname];
      if (!rows) throw new Error("ENOTFOUND");
      return rows;
    },
    connect: (address, port) => {
      connectCalls.push(`${address}:${port}`);
      return netConnect({ host: "127.0.0.1", port: upstreamPorts[address] ?? refused });
    },
    ...options,
  });
  await new Promise<void>((resolve) => proxy.server.listen(0, "127.0.0.1", resolve));
  return {
    port: (proxy.server.address() as AddressInfo).port,
    records,
    dnsCalls,
    connectCalls,
    close: async () => {
      proxy.closeTunnels();
      for (const socket of echo.sockets) socket.destroy();
      proxy.server.closeAllConnections();
      await new Promise<void>((resolve) => proxy.server.close(() => resolve()));
      await new Promise<void>((resolve) => echo.server.close(() => resolve()));
    },
  };
}

interface ConnectResult {
  status: number;
  headers: string;
  socket: Socket;
  rest: Buffer;
}

function connectVia(proxyPort: number, target: string, opts: { auth?: string; early?: string } = {}): Promise<ConnectResult> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port: proxyPort });
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      const headers = buf.subarray(0, end).toString("latin1");
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(headers)?.[1] ?? 0);
      resolve({ status, headers, socket, rest: buf.subarray(end + 4) });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
    if (opts.auth) lines.push(`Proxy-Authorization: Basic ${Buffer.from(opts.auth).toString("base64")}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n${opts.early ?? ""}`);
  });
}

function readExactly(socket: Socket, bytes: number, initial: Buffer = Buffer.alloc(0)): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = initial;
    if (buf.length >= bytes) return resolve(buf.subarray(0, bytes).toString("utf8"));
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= bytes) {
        socket.off("data", onData);
        resolve(buf.subarray(0, bytes).toString("utf8"));
      }
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function closeAndAwaitRecord(harness: Harness, socket: Socket): Promise<EgressProxyRecord> {
  socket.end();
  return waitFor(() => harness.records.find((r) => r.decision === "allow"));
}

test("observe tunnels a non-allowlisted host and records what enforce would deny", async () => {
  const h = await startProxy({ mode: "observe", allowlist: ["allowed.example"] });
  try {
    const res = await connectVia(h.port, "other.example:443");
    assert.equal(res.status, 200);
    res.socket.write("ping");
    assert.equal(await readExactly(res.socket, 4, res.rest), "ping");
    const record = await closeAndAwaitRecord(h, res.socket);
    assert.equal(record.mode, "observe");
    assert.equal(record.host, "other.example");
    assert.equal(record.port, 443);
    assert.equal(record.wouldDeny, "host_not_allowed");
    assert.equal(record.resolvedIp, PUBLIC_B);
    assert.equal(record.bytesUp, 4);
    assert.equal(record.bytesDown, 4);
    assert.equal(record.schema, "a2a.egress.connect.v1");
    assert.ok(typeof record.durationMs === "number");
  } finally {
    await h.close();
  }
});

test("observe records a non-default port as wouldDeny port_not_allowed", async () => {
  const h = await startProxy({ mode: "observe", allowlist: ["allowed.example"] });
  try {
    const res = await connectVia(h.port, "allowed.example:8443");
    assert.equal(res.status, 200);
    const record = await closeAndAwaitRecord(h, res.socket);
    assert.equal(record.wouldDeny, "port_not_allowed");
  } finally {
    await h.close();
  }
});

test("enforce tunnels an allowlisted host on 443 and forwards bytes sent with the CONNECT", async () => {
  const h = await startProxy({ mode: "enforce", allowlist: ["allowed.example"] });
  try {
    const res = await connectVia(h.port, "Allowed.Example.:443", { early: "early" });
    assert.equal(res.status, 200);
    assert.equal(await readExactly(res.socket, 5, res.rest), "early");
    const record = await closeAndAwaitRecord(h, res.socket);
    assert.equal(record.host, "allowed.example");
    assert.equal(record.wouldDeny, undefined);
    assert.deepEqual(h.connectCalls, [`${PUBLIC_A}:443`]);
  } finally {
    await h.close();
  }
});

test("enforce denies non-allowlisted hosts and ports without resolving or connecting", async () => {
  const h = await startProxy({ mode: "enforce", allowlist: ["allowed.example"] });
  try {
    const host = await connectVia(h.port, "other.example:443");
    assert.equal(host.status, 403);
    host.socket.destroy();
    const port = await connectVia(h.port, "allowed.example:80");
    assert.equal(port.status, 403);
    port.socket.destroy();
    const ipLiteral = await connectVia(h.port, `${PUBLIC_A}:443`);
    assert.equal(ipLiteral.status, 403);
    ipLiteral.socket.destroy();
    assert.deepEqual(
      h.records.map((r) => [r.host, r.decision, r.reason]),
      [
        ["other.example", "deny", "host_not_allowed"],
        ["allowed.example", "deny", "port_not_allowed"],
        [PUBLIC_A, "deny", "host_not_allowed"],
      ],
    );
    assert.deepEqual(h.dnsCalls, []);
    assert.deepEqual(h.connectCalls, []);
  } finally {
    await h.close();
  }
});

for (const mode of ["observe", "enforce"] as const) {
  test(`${mode} denies internal destinations by literal, name, and resolved address`, async () => {
    const h = await startProxy({ mode, allowlist: ["meta.example", "mixed.example", "loop6.example"] });
    try {
      const cases: Array<[string, string]> = [
        ["169.254.169.254:80", "internal_ip_denied"],
        ["127.0.0.1:443", "internal_ip_denied"],
        ["10.1.2.3:443", "internal_ip_denied"],
        ["172.17.0.1:443", "internal_ip_denied"],
        ["[::1]:443", "internal_ip_denied"],
        ["[::ffff:127.0.0.1]:443", "internal_ip_denied"],
        ["[fd00::1]:443", "internal_ip_denied"],
        ["localhost:443", "internal_host_denied"],
        ["metadata.google.internal:80", "internal_host_denied"],
        ["meta.example:443", "internal_ip_denied"],
        ["mixed.example:443", "internal_ip_denied"],
        ["loop6.example:443", "internal_ip_denied"],
      ];
      if (mode === "observe") cases.push(["2130706433:443", "internal_ip_denied"]);
      for (const [target, reason] of cases) {
        const res = await connectVia(h.port, target);
        assert.equal(res.status, 403, target);
        res.socket.destroy();
        const record = h.records.at(-1);
        assert.equal(record?.decision, "deny", target);
        assert.equal(record?.reason, reason, target);
      }
      assert.deepEqual(h.connectCalls, []);
    } finally {
      await h.close();
    }
  });
}

test("proxy credentials are required, checked per run, and never logged", async () => {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), "egress-proxy-creds-")));
  const secret = generateEgressProxyRunToken();
  const shortToken = "short-token";
  writeFileSync(join(dir, "run-1.sha256"), `${egressProxyRunTokenDigest(secret)}\n`);
  writeFileSync(join(dir, "run-short.sha256"), `${createHash("sha256").update(shortToken).digest("hex")}\n`);
  const h = await startProxy({ mode: "observe", authenticate: createCredentialDirAuthenticator(dir) });
  try {
    const none = await connectVia(h.port, "other.example:443");
    assert.equal(none.status, 407);
    assert.match(none.headers, /Proxy-Authenticate: Basic realm="a2a-egress"/);
    none.socket.destroy();
    for (const auth of ["run-1:wrong", "run-2:" + secret, "../run-1:" + secret, `run-short:${shortToken}`, "run-1"]) {
      const bad = await connectVia(h.port, "other.example:443", { auth });
      assert.equal(bad.status, 407, auth);
      bad.socket.destroy();
    }
    const ok = await connectVia(h.port, "other.example:443", { auth: `run-1:${secret}` });
    assert.equal(ok.status, 200);
    const record = await closeAndAwaitRecord(h, ok.socket);
    assert.equal(record.runId, "run-1");
    assert.deepEqual(
      h.records.filter((r) => r.decision === "deny").map((r) => r.reason),
      ["auth_required", "auth_failed", "auth_failed", "auth_failed", "auth_failed", "auth_required"],
    );
    assert.ok(h.records.every((r) => r.runId === null || r.runId === "run-1"));
    assert.ok(!JSON.stringify(h.records).includes(secret));
    assert.deepEqual(h.dnsCalls, ["other.example"]);
  } finally {
    await h.close();
  }
});

test("malformed CONNECT targets are rejected", async () => {
  const h = await startProxy({ mode: "observe" });
  try {
    for (const target of ["nohost", "a..b:443", "host:0", "host:99999", "-bad.example:443", "under_score.example:443", "[not-v6]:443"]) {
      const res = await connectVia(h.port, target);
      assert.equal(res.status, 400, target);
      res.socket.destroy();
    }
    assert.ok(h.records.every((r) => r.reason === "bad_target"));
    assert.deepEqual(h.dnsCalls, []);
  } finally {
    await h.close();
  }
});

test("plain HTTP proxy requests are refused and logged; /healthz answers", async () => {
  const h = await startProxy({ mode: "observe", allowlist: ["allowed.example"] });
  try {
    const plain = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: h.port, method: "GET", path: "http://example.com/x" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(plain, 405);
    assert.deepEqual(
      h.records.map((r) => [r.method, r.host, r.port, r.reason]),
      [["GET", "example.com", 80, "method_not_allowed"]],
    );
    const health = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: h.port, method: "GET", path: "/healthz" }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true, mode: "observe", allowlistSize: 1, activeConnections: 0 });
  } finally {
    await h.close();
  }
});

test("DNS failures and refused upstreams return 502 with a named reason", async () => {
  const h = await startProxy({ mode: "observe" });
  try {
    const nx = await connectVia(h.port, "nx.example:443");
    assert.equal(nx.status, 502);
    nx.socket.destroy();
    const refused = await connectVia(h.port, "refused.example:443");
    assert.equal(refused.status, 502);
    refused.socket.destroy();
    assert.deepEqual(
      h.records.map((r) => r.reason),
      ["dns_resolution_failed", "upstream_connect_failed"],
    );
    assert.equal(h.records[1]?.resolvedIp, PUBLIC_REFUSED);
  } finally {
    await h.close();
  }
});

test("connection cap returns 503 and frees the slot when a tunnel closes", async () => {
  const h = await startProxy({ mode: "observe", maxConnections: 1 });
  try {
    const first = await connectVia(h.port, "other.example:443");
    assert.equal(first.status, 200);
    const second = await connectVia(h.port, "other.example:443");
    assert.equal(second.status, 503);
    second.socket.destroy();
    await closeAndAwaitRecord(h, first.socket);
    const third = await connectVia(h.port, "other.example:443");
    assert.equal(third.status, 200);
    third.socket.destroy();
  } finally {
    await h.close();
  }
});

test("allowlist validation rejects non-canonical, IP, port, wildcard, internal, and duplicate entries", () => {
  assert.deepEqual(normalizeEgressProxyAllowlist(["api.github.com", " github.com ", ""]), ["api.github.com", "github.com"]);
  for (const bad of [["API.github.com"], ["1.2.3.4"], ["github.com:443"], ["*.github.com"], ["localhost"], ["x.internal"], ["a.com", "a.com"]]) {
    assert.throws(() => normalizeEgressProxyAllowlist(bad), EgressProxyConfigError, JSON.stringify(bad));
  }
  assert.throws(() => createEgressProxy({ mode: "off" as never, log: () => {} }), EgressProxyConfigError);
  assert.throws(() => createEgressProxy({ mode: "enforce", allowedPorts: [0], log: () => {} }), EgressProxyConfigError);
});

test("parseConnectTarget normalizes case and trailing dots", () => {
  assert.deepEqual(parseConnectTarget("API.GitHub.com.:443"), { host: "api.github.com", port: 443, ipFamily: 0 });
  assert.deepEqual(parseConnectTarget("[2001:db8::1]:443"), { host: "2001:db8::1", port: 443, ipFamily: 6 });
  assert.deepEqual(parseConnectTarget("198.51.100.7:443"), { host: "198.51.100.7", port: 443, ipFamily: 4 });
  assert.equal(parseConnectTarget(undefined), undefined);
});

test("JSONL log writes 0600 day files and caps them with one truncation marker", () => {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), "egress-proxy-log-")));
  const now = () => new Date("2026-10-20T03:00:00Z");
  const log = createJsonlEgressLog({ dir: join(dir, "egress"), maxFileBytes: 400, now });
  const record: EgressProxyRecord = {
    schema: "a2a.egress.connect.v1",
    ts: now().toISOString(),
    mode: "observe",
    runId: "run-1",
    method: "CONNECT",
    host: "api.github.com",
    port: 443,
    decision: "allow",
  };
  for (let i = 0; i < 10; i += 1) log(record);
  const files = readdirSync(join(dir, "egress"));
  assert.deepEqual(files, ["egress-2026-10-20.jsonl"]);
  const file = join(dir, "egress", files[0]!);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { schema: string });
  const markers = lines.filter((line) => line.schema === EGRESS_PROXY_LOG_TRUNCATED_SCHEMA);
  assert.equal(markers.length, 1);
  assert.ok(lines.length >= 2 && lines.length < 10);
});

test("parseEgressProxyEnv requires an explicit mode and proxy credentials", () => {
  assert.throws(() => parseEgressProxyEnv({}), /A2A_EGRESS_PROXY_MODE/);
  assert.throws(() => parseEgressProxyEnv({ A2A_EGRESS_PROXY_MODE: "off" }), /A2A_EGRESS_PROXY_MODE/);
  assert.throws(() => parseEgressProxyEnv({ A2A_EGRESS_PROXY_MODE: "observe" }), /CREDENTIALS_DIR/);
  assert.deepEqual(parseEgressProxyEnv({ A2A_EGRESS_PROXY_MODE: "observe", A2A_EGRESS_PROXY_ALLOW_UNAUTHENTICATED: "1" }), {
    mode: "observe",
    listenHost: "0.0.0.0",
    listenPort: 3128,
    allowlist: [],
    allowedPorts: [443],
    logMaxFileBytes: 16 * 1024 * 1024,
  });
  const parsed = parseEgressProxyEnv({
    A2A_EGRESS_PROXY_MODE: "enforce",
    A2A_EGRESS_PROXY_LISTEN: "[::]:8080",
    A2A_EGRESS_PROXY_ALLOWLIST: "api.github.com,github.com",
    A2A_EGRESS_PROXY_ALLOWED_PORTS: "443,8443",
    A2A_EGRESS_PROXY_CREDENTIALS_DIR: "/run/egress-creds",
    A2A_EGRESS_PROXY_LOG_DIR: "/var/log/egress",
  });
  assert.equal(parsed.listenHost, "::");
  assert.equal(parsed.listenPort, 8080);
  assert.deepEqual(parsed.allowedPorts, [443, 8443]);
  assert.equal(parsed.credentialsDir, "/run/egress-creds");
  assert.throws(() => parseEgressProxyEnv({ A2A_EGRESS_PROXY_MODE: "enforce", A2A_EGRESS_PROXY_ALLOW_UNAUTHENTICATED: "1", A2A_EGRESS_PROXY_ALLOWED_PORTS: "70000" }), /port/);
  assert.throws(() => parseEgressProxyEnv({ A2A_EGRESS_PROXY_MODE: "enforce", A2A_EGRESS_PROXY_ALLOW_UNAUTHENTICATED: "1", A2A_EGRESS_PROXY_ALLOWLIST: "10.0.0.1" }), EgressProxyConfigError);
});

test("run tokens are long random values and short tokens are refused", () => {
  const a = generateEgressProxyRunToken();
  const b = generateEgressProxyRunToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= EGRESS_PROXY_MIN_RUN_TOKEN_LENGTH);
  assert.match(egressProxyRunTokenDigest(a), /^[0-9a-f]{64}$/);
  assert.throws(() => egressProxyRunTokenDigest("x".repeat(EGRESS_PROXY_MIN_RUN_TOKEN_LENGTH - 1)), EgressProxyConfigError);
});
