#!/usr/bin/env node
/**
 * Official A2A TCK harness (opt-in measurement lane).
 *
 * Boots a local broker on an ephemeral loopback port and runs the official
 * A2A Technology Compatibility Kit (https://github.com/a2aproject/a2a-tck)
 * against it, producing a compliance report.
 *
 * This is NOT a release gate: the broker's documented deviations from the
 * A2A 1.0 spec (see src/fixtures/a2a-protocol-compatibility.ts) mean some
 * mandatory TCK tests are expected to fail today. The harness exists so
 * compliance is *measured* against the official kit instead of asserted —
 * run it after protocol-surface changes and track the report deltas.
 *
 * Usage:
 *   node scripts/a2a-tck-harness.mjs --self-check
 *     Boot the broker, verify the agent card + JSON-RPC surface respond,
 *     and exit. No Python required; safe anywhere.
 *
 *   A2A_TCK_DIR=/path/to/a2a-tck node scripts/a2a-tck-harness.mjs [--level must] [--transport jsonrpc]
 *     Boot the broker and invoke the TCK from a local clone:
 *       git clone https://github.com/a2aproject/a2a-tck
 *       cd a2a-tck && uv venv && . .venv/bin/activate && uv pip install -e .
 *     The TCK's run_tck.py is executed with --sut-host pointed at the local
 *     broker. Reports land in the TCK's report output directory.
 *
 * Safety: loopback only, ephemeral state, no live sends, no deploy, no ACK.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";

const args = process.argv.slice(2);
const selfCheck = args.includes("--self-check");
const levelIndex = args.indexOf("--level");
const level = levelIndex >= 0 ? args[levelIndex + 1] : "must";
const transportIndex = args.indexOf("--transport");
const transport = transportIndex >= 0 ? args[transportIndex + 1] : "jsonrpc";

const { createBrokerServer } = await import("../dist/server.js");
const { mkdtempSync } = await import("node:fs");
const { tmpdir } = await import("node:os");

async function reserveLoopbackPort() {
  const probe = createNetServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  if (!port) {
    throw new Error("failed to reserve a loopback port for the TCK harness");
  }
  return port;
}

// Ephemeral state file so the run never touches real broker state.
const stateDir = mkdtempSync(join(tmpdir(), "a2a-tck-state-"));
const port = await reserveLoopbackPort();
const baseUrl = `http://127.0.0.1:${port}`;
const runtime = createBrokerServer({
  host: "127.0.0.1",
  port,
  stateFile: join(stateDir, "state.json"),
  publicBaseUrl: baseUrl,
  // TCK clients do not send broker requester-identity headers.
  enforceRequesterIdentity: false,
  staleReaperEnabled: false,
  // The TCK drives many requests in a tight loop from one client. Rate
  // limiting is deployment policy, not a protocol-conformance concern, so
  // raise the caps far above the suite's burst to avoid false failures.
  rateLimitMaxRequests: 100000,
  rateLimitWindowSec: 1,
  workerRateLimitMaxRequests: 100000,
  workerRateLimitWindowSec: 1,
});
runtime.server.listen(port, "127.0.0.1");
await once(runtime.server, "listening");
console.log(`[tck-harness] broker listening at ${baseUrl} (loopback, ephemeral)`);

async function shutdown(code) {
  runtime.stopStaleReaper?.();
  runtime.server.close();
  runtime.server.closeAllConnections?.();
  process.exit(code);
}

// Always do the self-check probes first — they catch a broken boot before
// the TCK produces confusing transport-level failures.
const cardRes = await fetch(`${baseUrl}/.well-known/agent-card.json`);
if (cardRes.status !== 200) {
  console.error(`[tck-harness] agent card probe failed: HTTP ${cardRes.status}`);
  await shutdown(1);
}
const card = await cardRes.json();
if (JSON.stringify(card).includes("127.0.0.1:0")) {
  console.error("[tck-harness] agent card contains unresolved port 0 URL");
  await shutdown(1);
}
console.log(`[tck-harness] agent card ok: ${card.name} (protocolVersion ${card.protocolVersion})`);

const rpcRes = await fetch(`${baseUrl}/a2a/jsonrpc`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: "tck-probe", method: "ListTasks", params: {} }),
});
const rpcBody = await rpcRes.json();
if (rpcRes.status !== 200 || rpcBody.error) {
  console.error(`[tck-harness] JSON-RPC probe failed: HTTP ${rpcRes.status} ${JSON.stringify(rpcBody.error ?? {})}`);
  await shutdown(1);
}
console.log("[tck-harness] JSON-RPC surface ok (ListTasks)");

if (selfCheck) {
  console.log("[tck-harness] self-check passed");
  await shutdown(0);
}

const tckDir = process.env.A2A_TCK_DIR;
if (!tckDir) {
  console.error(
    "[tck-harness] A2A_TCK_DIR is not set.\n" +
      "  git clone https://github.com/a2aproject/a2a-tck\n" +
      "  cd a2a-tck && uv venv && . .venv/bin/activate && uv pip install -e .\n" +
      "  A2A_TCK_DIR=$(pwd) node scripts/a2a-tck-harness.mjs --level must --transport jsonrpc",
  );
  await shutdown(2);
}
const runTck = join(tckDir, "run_tck.py");
if (!existsSync(runTck)) {
  console.error(`[tck-harness] ${runTck} not found — is A2A_TCK_DIR a TCK checkout?`);
  await shutdown(2);
}

console.log(`[tck-harness] running TCK level "${level}" transport "${transport}" against ${baseUrl}`);
const tck = spawn("python3", [runTck, "--sut-host", baseUrl, "--transport", transport, "--level", level], {
  cwd: tckDir,
  stdio: "inherit",
});
const [tckCode] = await once(tck, "exit");
console.log(`[tck-harness] TCK exited with code ${tckCode}`);
await shutdown(tckCode ?? 1);
