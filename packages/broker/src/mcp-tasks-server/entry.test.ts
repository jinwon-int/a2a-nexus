// MCP Tasks server entry point and start-up config (a2a-nexus #2591 design §4, step 3 preparation).

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import assert from "node:assert/strict";

import {
  CONFIG_ENV,
  McpTasksServerConfigError,
  assertBrokerUrl,
  defaultStateDir,
  loadServerConfig,
  readEdgeSecret,
  redactedConfigSummary,
} from "./index.js";
import { EXIT_CONFIG_REFUSED, EXIT_OK, runCli } from "./cli.js";

const SECRET = "EDGE-SECRET-VALUE-5f1c";
const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-tasks-entry-"));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function envFile(body = `# node env\nexport A2A_BROKER_EDGE_SECRET="${SECRET}"\nOTHER=1\n`, mode = 0o600): string {
  const file = join(tempDir(), "broker.env");
  writeFileSync(file, body, { mode });
  chmodSync(file, mode);
  return file;
}

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    [CONFIG_ENV.brokerUrl]: "http://127.0.0.1:18080",
    [CONFIG_ENV.envFile]: envFile(),
    [CONFIG_ENV.requesterId]: "node-a",
    [CONFIG_ENV.requesterRole]: "analyst",
    [CONFIG_ENV.allowedTargets]: "worker-a, worker-b",
    [CONFIG_ENV.stateDir]: join(tempDir(), "state"),
    HOME: tempDir(),
    ...overrides,
  };
}

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk) => chunks.push(String(chunk)));
  return { stream, text: () => chunks.join("") };
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

test("a valid configuration loads, and the redacted summary never contains the secret", () => {
  const config = loadServerConfig(baseEnv());
  assert.equal(config.edgeSecret, SECRET);
  assert.deepEqual(config.allowedTargetNodeIds, ["worker-a", "worker-b"]);
  assert.deepEqual(config.identity, { id: "node-a", kind: "node", role: "analyst" });
  assert.equal(config.sessionId, "default");
  const summary = JSON.stringify(redactedConfigSummary(config));
  assert.ok(!summary.includes(SECRET));
  assert.match(summary, /"key":"A2A_BROKER_EDGE_SECRET"/);
});

test("the secret is read only from the env file, never from the process environment", () => {
  const file = envFile("OTHER=1\n");
  const saved = { a: process.env.A2A_BROKER_EDGE_SECRET, b: process.env.A2A_EDGE_SECRET };
  process.env.A2A_BROKER_EDGE_SECRET = SECRET;
  process.env.A2A_EDGE_SECRET = SECRET;
  try {
    assert.throws(
      () => loadServerConfig(baseEnv({ [CONFIG_ENV.envFile]: file, A2A_BROKER_EDGE_SECRET: SECRET, A2A_EDGE_SECRET: SECRET })),
      (error: Error) => error instanceof McpTasksServerConfigError && !error.message.includes(SECRET),
    );
  } finally {
    for (const [key, value] of [["A2A_BROKER_EDGE_SECRET", saved.a], ["A2A_EDGE_SECRET", saved.b]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(readEdgeSecret(envFile(`A2A_EDGE_SECRET='${SECRET}'\n`)).key, "A2A_EDGE_SECRET");
});

test("an env file that is open to others, a symlink, or missing is refused without echoing its content", () => {
  const open = envFile(undefined, 0o644);
  const target = envFile();
  const link = join(tempDir(), "link.env");
  symlinkSync(target, link);
  for (const file of [open, link, join(tempDir(), "missing.env")]) {
    assert.throws(() => readEdgeSecret(file), (error: Error) => error instanceof McpTasksServerConfigError && !error.message.includes(SECRET), file);
  }
});

test("broker URL: https anywhere, http only to loopback, never credentials", () => {
  for (const ok of ["https://broker.example", "http://127.0.0.1:18080/", "http://localhost:9000", "http://[::1]:8080"]) {
    assert.doesNotThrow(() => assertBrokerUrl(ok), ok);
  }
  for (const bad of ["http://10.0.0.5:18080", "http://broker.example", "https://u:p@broker.example", "https://b.example/?k=v", "ftp://b", "nope"]) {
    assert.throws(() => assertBrokerUrl(bad), McpTasksServerConfigError, bad);
  }
});

test("missing values, a privileged role, a bad kind, or empty targets refuse to start", () => {
  const cases: Array<Record<string, string | undefined>> = [
    { [CONFIG_ENV.brokerUrl]: undefined },
    { [CONFIG_ENV.envFile]: undefined },
    { [CONFIG_ENV.requesterId]: "" },
    { [CONFIG_ENV.requesterRole]: "operator" },
    { [CONFIG_ENV.requesterRole]: "Hub" },
    { [CONFIG_ENV.requesterKind]: "agent" },
    { [CONFIG_ENV.allowedTargets]: " , " },
  ];
  for (const overrides of cases) {
    assert.throws(() => loadServerConfig(baseEnv(overrides)), McpTasksServerConfigError, JSON.stringify(overrides));
  }
});

test("default state dir follows XDG_STATE_HOME, then HOME", () => {
  assert.equal(defaultStateDir({ XDG_STATE_HOME: "/x/state", HOME: "/h" }), "/x/state/a2a-mcp-tasks");
  assert.equal(defaultStateDir({ HOME: "/h" }), "/h/.local/state/a2a-mcp-tasks");
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

test("--check-config validates, prints a redacted summary to stderr, and creates nothing", async () => {
  const env = baseEnv();
  const out = sink();
  const err = sink();
  const code = await runCli(["--check-config"], { env, stdin: new PassThrough(), stdout: out.stream, stderr: err.stream });
  assert.equal(code, EXIT_OK);
  assert.equal(out.text(), "", "stdout is reserved for JSON-RPC");
  assert.match(err.text(), /"event":"config_ok"/);
  assert.ok(!err.text().includes(SECRET));
  assert.equal(existsSync(env[CONFIG_ENV.stateDir]!), false, "no state directory on a check");
});

test("a refused configuration or an unknown argument exits 2 and serves nothing", async () => {
  for (const [argv, env] of [
    [[], baseEnv({ [CONFIG_ENV.requesterRole]: "operator" })],
    [["--serve-http"], baseEnv()],
  ] as const) {
    const out = sink();
    const err = sink();
    const stdin = new PassThrough();
    stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    const code = await runCli(argv, { env, stdin, stdout: out.stream, stderr: err.stream });
    assert.equal(code, EXIT_CONFIG_REFUSED, JSON.stringify(argv));
    assert.equal(out.text(), "");
    assert.match(err.text(), /"event":"start_refused"/);
    assert.ok(!err.text().includes(SECRET));
  }
});

test("serving: stdout carries only JSON-RPC, the secret goes only to the broker header", async () => {
  const seen: Array<{ path: string; secret: string | undefined }> = [];
  const fakeFetch = (async (input: URL | string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    seen.push({ path: new URL(String(input)).pathname, secret: (init?.headers as Record<string, string>)["x-a2a-edge-secret"] });
    const task = { id: randomUUID(), status: { state: "TASK_STATE_SUBMITTED", timestamp: "2026-11-28T00:00:00.000Z" } };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { task } }), { status: 200 });
  }) as typeof fetch;
  const env = baseEnv();
  const out = sink();
  const err = sink();
  const stdin = new PassThrough();
  const caps = { _meta: { "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/tasks": {} } } } };
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { ...caps, name: "a2a_dispatch_analysis", arguments: { prompt: "why", targetNodeId: "worker-a" } } })}\n`);
  stdin.end();
  const code = await runCli([], { env, stdin, stdout: out.stream, stderr: err.stream, fetchImpl: fakeFetch });
  assert.equal(code, EXIT_OK);
  const lines = out.text().trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.id), [1, 2]);
  assert.equal(lines[1].result.resultType, "task");
  assert.deepEqual(seen, [{ path: "/a2a/jsonrpc", secret: SECRET }]);
  assert.ok(!out.text().includes(SECRET) && !err.text().includes(SECRET), "the secret never reaches stdout or logs");
  for (const line of err.text().trim().split("\n")) assert.doesNotThrow(() => JSON.parse(line), line);
  assert.equal(existsSync(join(env[CONFIG_ENV.stateDir]!, "mcp-tasks", "default.json")), true, "the session store was written");
});
