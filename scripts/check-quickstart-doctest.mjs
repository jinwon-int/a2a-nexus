#!/usr/bin/env node
/**
 * Executable quickstart doctest (#1505 acceptance criterion 2).
 *
 * Unlike scripts/check-quickstart-conformance.mjs (which only checks that the
 * docs and fixtures are structurally sound via regex), this script GENUINELY
 * RUNS the documented quickstart command path end to end, fully on loopback,
 * with no network beyond 127.0.0.1 and no live provider/secret assumptions:
 *
 *   docs/quickstart.md §1  ->  boot broker via `npm run start:local`
 *   docs/quickstart.md §2  ->  start echo worker via `npm run worker:echo`
 *   docs/quickstart.md §2a ->  poll GET /health for {"ok":true,"service":"a2a-broker"}
 *   docs/quickstart.md §4  ->  POST examples/local/local-quickstart-task.json to /tasks
 *   docs/quickstart.md §4  ->  poll GET /tasks/:id until terminal Done (succeeded)
 *   docs/quickstart.md §6  ->  teardown: kill children, rm -rf packages/broker/.local
 *
 * Auth decision (verified against source, not guessed):
 *   `start:local` in packages/broker/package.json sets HOST=127.0.0.1 and does
 *   NOT set EDGE_SECRET/A2A_EDGE_SECRET. In packages/broker/src/server.ts the
 *   edge secret resolves to undefined (createBrokerServer, ~L357), and
 *   validateBrokerStartupSecurity (packages/broker/src/startup-security.ts L42)
 *   permits an unsecured bind on a loopback host. assertEdgeSecret
 *   (packages/broker/src/core/request-security.ts L748-765) returns early when
 *   the expected secret is undefined. Therefore the documented curl in §4 with
 *   NO x-a2a-edge-secret header is correct, and this doctest submits with no
 *   secret -- faithful to the docs. No deviation.
 *
 * Terminal shape (verified): POST /tasks returns 201 with a `queued` task;
 * GET /tasks/:id returns the task record whose terminal status is `succeeded`
 * (packages/broker/src/core/types.ts TaskStatus). The builtin echo handler
 * (packages/broker/src/worker.ts createBuiltinWorkerHandler) sets
 * result.summary to the task message. §4 calls this "Done with a short echoed
 * result"; `succeeded` + non-empty result.summary is that Done evidence.
 *
 * Safety: no deploy, no restart of any managed service, no live send, no secret
 * exposure. Binds only the documented loopback port and refuses to run if the
 * port is already occupied. Designed for CI.
 */
import path from 'node:path';
import net from 'node:net';
import { existsSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const brokerDir = path.join(root, 'packages', 'broker');
const localStateDir = path.join(brokerDir, '.local');

// Documented loopback endpoint from docs/quickstart.md and start:local.
// The default port (8787) runs the documented `npm run start:local` verbatim,
// which is the CI path. QUICKSTART_DOCTEST_PORT overrides the port ONLY for
// constrained local environments where 8787 is already occupied (e.g. a host
// that permanently runs a managed broker on 8787). In that override case the
// broker is booted via `npm run start` (the same `node dist/server.js` that
// start:local wraps) with the equivalent env on the chosen port. Unset/default
// keeps the faithful documented path so CI exercises the real documented block.
const HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const parsedOverride = Number.parseInt(process.env.QUICKSTART_DOCTEST_PORT ?? '', 10);
const PORT =
  Number.isInteger(parsedOverride) && parsedOverride > 0 && parsedOverride < 65536
    ? parsedOverride
    : DEFAULT_PORT;
const USING_DOCUMENTED_PORT = PORT === DEFAULT_PORT;
const BASE_URL = `http://${HOST}:${PORT}`;
const WORKER_ID = 'local-echo-worker'; // WORKER_ID default per worker:echo script.
const TASK_FIXTURE = path.join(root, 'examples', 'local', 'local-quickstart-task.json');

// Timeouts (ms).
const HEALTH_TIMEOUT_MS = 30_000;
const WORKER_REGISTER_TIMEOUT_MS = 20_000;
const TERMINAL_TIMEOUT_MS = 40_000;
const OVERALL_TIMEOUT_MS = 90_000;
const PORT_RELEASE_TIMEOUT_MS = 10_000;

const log = (msg) => process.stderr.write(`[quickstart-doctest] ${msg}\n`);

// Tracked child processes for guaranteed teardown.
const children = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Self-build (mirrors test/conformance/check-three-component-e2e.mjs) ------
function ensureBuilt(pkg, distEntry) {
  if (existsSync(path.join(root, distEntry))) return;
  log(`building packages/${pkg} (missing ${distEntry})`);
  const res = spawnSync('npm', ['run', 'build', '-w', `packages/${pkg}`], { cwd: root, stdio: 'inherit' });
  if (res.status !== 0) {
    throw new Error(`failed to build packages/${pkg} for the quickstart doctest`);
  }
}

// --- Port helpers -------------------------------------------------------------
function isPortFree(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

async function waitForPortReleased(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortFree(port, host)) return true;
    await sleep(200);
  }
  return false;
}

// --- Child process lifecycle --------------------------------------------------
function spawnDocumented(name, script, extraEnv) {
  // detached so we own the whole process group and can signal children the
  // documented npm script itself spawns (npm -> node dist/*.js).
  const child = spawn('npm', ['run', script], {
    cwd: brokerDir,
    env: { ...process.env, ...extraEnv },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.__name = name;
  children.push(child);
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  child.on('error', (err) => log(`${name} spawn error: ${err.message}`));
  return child;
}

function killChild(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  try {
    // Negative pid signals the whole detached process group.
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

async function teardownChildren() {
  for (const child of children) killChild(child);
  await sleep(1500);
  for (const child of children) {
    if (child.exitCode === null && !child.killed && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
}

// --- HTTP helpers (loopback only) ---------------------------------------------
async function httpGetJson(url) {
  const res = await fetch(url, { method: 'GET' });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { __raw: text.slice(0, 200) }; }
  return { status: res.status, body };
}

async function pollHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastErr = 'no response';
  while (Date.now() < deadline) {
    try {
      const { status, body } = await httpGetJson(`${BASE_URL}/health`);
      if (status === 200 && body?.ok === true && body?.service === 'a2a-broker') {
        return body;
      }
      lastErr = `status ${status} body.ok=${body?.ok} body.service=${body?.service}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(300);
  }
  throw new Error(`broker /health did not report {ok:true,service:"a2a-broker"} within ${HEALTH_TIMEOUT_MS}ms (last: ${lastErr})`);
}

async function pollWorkerRegistered() {
  // Confirm the echo worker registered by reading GET /workers. Best-effort:
  // if the endpoint is unavailable we proceed (the task target is fixed).
  const deadline = Date.now() + WORKER_REGISTER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const { status, body } = await httpGetJson(`${BASE_URL}/workers`);
      if (status === 200) {
        const items = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : [];
        const found = items.some((w) => (w?.nodeId ?? w?.id ?? w?.workerId) === WORKER_ID);
        if (found) return true;
      }
    } catch {
      // fall through to retry
    }
    await sleep(400);
  }
  log(`worker ${WORKER_ID} not confirmed via GET /workers within ${WORKER_REGISTER_TIMEOUT_MS}ms; proceeding (task target is fixed)`);
  return false;
}

async function submitTask() {
  const { readFileSync } = await import('node:fs');
  const bodyRaw = readFileSync(TASK_FIXTURE, 'utf8');
  // Documented headers from docs/quickstart.md §4 (NO edge secret; see header note).
  const res = await fetch(`${BASE_URL}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-A2A-Requester-Id': 'local-operator',
      'X-A2A-Requester-Kind': 'node',
      'X-A2A-Requester-Role': 'operator',
    },
    body: bodyRaw,
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { __raw: text.slice(0, 300) }; }
  if (res.status !== 201 && res.status !== 202) {
    throw new Error(`POST /tasks expected 201/202, got ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  const task = body?.task ?? body;
  if (!task || typeof task.id !== 'string') {
    throw new Error(`POST /tasks did not return a task id: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return task;
}

async function pollTerminal(taskId) {
  const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
  const terminalStatuses = new Set(['succeeded', 'failed', 'canceled', 'cancelled', 'dead_letter']);
  let lastStatus = 'unknown';
  while (Date.now() < deadline) {
    const { status, body } = await httpGetJson(`${BASE_URL}/tasks/${encodeURIComponent(taskId)}`);
    if (status === 200 && body && typeof body.status === 'string') {
      lastStatus = body.status;
      if (terminalStatuses.has(body.status)) return body;
    }
    await sleep(300);
  }
  throw new Error(`task ${taskId} did not reach a terminal status within ${TERMINAL_TIMEOUT_MS}ms (last status: ${lastStatus})`);
}

// --- Main ---------------------------------------------------------------------
async function run() {
  ensureBuilt('broker', 'packages/broker/dist/server.js');
  ensureBuilt('broker', 'packages/broker/dist/worker.js');

  // Pre-check: the documented port must be free. Fail clearly if occupied so we
  // never collide with or disturb any already-running broker on 8787.
  if (!(await isPortFree(PORT, HOST))) {
    throw new Error(
      `port ${PORT} on ${HOST} is already in use; the quickstart doctest needs the documented loopback port free. ` +
        `Stop whatever is bound to ${HOST}:${PORT} (or free it) and re-run.`,
    );
  }

  // Clean any stale local state before booting (start:local writes .local/state.json).
  rmSync(localStateDir, { recursive: true, force: true });

  // §1 Boot broker. Default path runs the DOCUMENTED `npm run start:local`
  // verbatim (HOST/PORT/STATE_FILE fixed by the npm script) — the CI path. When
  // a non-default port override is set for a constrained local host, boot the
  // same underlying `node dist/server.js` via `npm run start` with the
  // equivalent env on the chosen port. STALE_REAPER_ENABLED=0 keeps it
  // deterministic.
  if (USING_DOCUMENTED_PORT) {
    log('booting broker: npm run start:local');
    spawnDocumented('broker', 'start:local', { STALE_REAPER_ENABLED: '0' });
  } else {
    log(`booting broker: npm run start (local port override :${PORT}; documented 8787 occupied on this host)`);
    spawnDocumented('broker', 'start', {
      HOST,
      PORT: String(PORT),
      PUBLIC_BASE_URL: BASE_URL,
      STATE_FILE: '.local/state.json',
      STALE_REAPER_ENABLED: '0',
    });
  }

  // §2a Health gate.
  const health = await pollHealth();
  log(`broker healthy (version ${health.version ?? 'n/a'}, uptimeSec ${health.uptimeSec ?? 'n/a'})`);

  // §2 Start echo worker via the DOCUMENTED command with the default worker id.
  log('starting echo worker: npm run worker:echo');
  spawnDocumented('worker', 'worker:echo', {
    LOCAL_A2A_BROKER_URL: BASE_URL,
    // WORKER_ID defaults to local-echo-worker inside worker:echo; leave it default.
  });
  const registered = await pollWorkerRegistered();

  // §4 Submit the checked-in fixture with the documented headers (no secret).
  const created = await submitTask();
  log(`submitted task ${created.id} (status ${created.status})`);

  // §4 Poll to terminal and assert Done / succeeded with an echoed result.
  const terminal = await pollTerminal(created.id);
  if (terminal.status !== 'succeeded') {
    throw new Error(
      `terminal evidence is not Done: task ${terminal.id} reached status "${terminal.status}" ` +
        `(expected succeeded / Done). ${terminal.error ? `error: ${JSON.stringify(terminal.error).slice(0, 200)}` : ''}`,
    );
  }
  const summary = terminal.result?.summary;
  if (typeof summary !== 'string' || summary.length === 0) {
    throw new Error(`terminal task ${terminal.id} succeeded but has no echoed result.summary: ${JSON.stringify(terminal.result).slice(0, 200)}`);
  }

  const workerNote = registered ? 'registered' : 'assumed';
  process.stdout.write(
    `quickstart doctest ok (broker :${PORT}, worker ${WORKER_ID} ${workerNote}, task ${terminal.id} -> ${terminal.status}, echoed result present)\n`,
  );
}

async function main() {
  let overallTimer;
  const overall = new Promise((_, reject) => {
    overallTimer = setTimeout(
      () => reject(new Error(`overall quickstart doctest timeout after ${OVERALL_TIMEOUT_MS}ms`)),
      OVERALL_TIMEOUT_MS,
    );
    overallTimer.unref?.();
  });

  try {
    await Promise.race([run(), overall]);
  } finally {
    clearTimeout(overallTimer);
    // Teardown ALWAYS runs (§6): kill children, remove .local, verify port free.
    log('teardown: stopping broker + worker child processes');
    await teardownChildren();
    log('teardown: removing packages/broker/.local');
    rmSync(localStateDir, { recursive: true, force: true });
    const released = await waitForPortReleased(PORT, HOST, PORT_RELEASE_TIMEOUT_MS);
    if (!released) {
      log(`WARNING: port ${PORT} on ${HOST} was not released within ${PORT_RELEASE_TIMEOUT_MS}ms after teardown`);
    } else {
      log(`teardown complete: port ${PORT} released, .local removed`);
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`quickstart doctest FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
