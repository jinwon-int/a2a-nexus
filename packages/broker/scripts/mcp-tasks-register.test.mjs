// mcp-tasks-register.sh (a2a-nexus #2591 step 3 preparation): dry run by default,
// refuses privileged roles / open env files / non-loopback http, and never puts the
// edge secret in the registration. `claude` is a stub that records its argv.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'mcp-tasks-register.sh');
const ENTRY = join(HERE, '..', 'dist', 'mcp-tasks-server', 'cli.js');
const SECRET = 'EDGE-SECRET-VALUE-91aa';

const dirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-tasks-register-'));
  dirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup(mode = 0o600) {
  const dir = tempDir();
  const envFile = join(dir, 'broker.env');
  writeFileSync(envFile, `A2A_BROKER_EDGE_SECRET=${SECRET}\n`, { mode });
  chmodSync(envFile, mode);
  const log = join(dir, 'claude-argv.log');
  const stub = join(dir, 'claude');
  writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${log}"\n`, { mode: 0o755 });
  return { dir, envFile, log, stub };
}

function run(args, ctx) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: ctx.dir, CLAUDE_BIN: ctx.stub },
  });
}

function base(ctx, extra = []) {
  return ['--broker-url', 'http://127.0.0.1:18080', '--env-file', ctx.envFile, '--requester-id', 'node-a',
    '--role', 'analyst', '--targets', 'worker-a', '--state-dir', join(ctx.dir, 'state'), ...extra];
}

test('the entry point is built before this suite runs', () => {
  assert.ok(existsSync(ENTRY), ENTRY);
});

test('dry run prints the claude mcp add command, registers nothing, and never carries the secret', () => {
  const ctx = setup();
  const result = run(base(ctx), ctx);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# dry run — add --apply to register/);
  assert.match(result.stdout, /mcp add --scope user a2a-tasks/);
  assert.match(result.stdout, /A2A_MCP_TASKS_ENV_FILE=/);
  assert.match(result.stdout, /-- node \S+mcp-tasks-server\/cli\.js/);
  assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET));
  assert.equal(existsSync(ctx.log), false, 'claude was not invoked');
  assert.equal(existsSync(join(ctx.dir, 'state')), false, 'the config check creates no state');
});

test('--apply invokes claude with exactly the printed arguments, still without the secret', () => {
  const ctx = setup();
  const result = run(base(ctx, ['--apply']), ctx);
  assert.equal(result.status, 0, result.stderr);
  const argv = readFileSync(ctx.log, 'utf8').trim().split('\n');
  assert.deepEqual(argv.slice(0, 5), ['mcp', 'add', '--scope', 'user', 'a2a-tasks']);
  assert.ok(argv.includes(`A2A_MCP_TASKS_ENV_FILE=${ctx.envFile}`));
  assert.ok(argv.includes('A2A_MCP_TASKS_REQUESTER_ROLE=analyst'));
  assert.deepEqual(argv.slice(-3, -1), ['--', 'node']);
  assert.ok(!argv.join(' ').includes(SECRET));
});

test('privileged roles, open env files, non-loopback http, and relative paths are refused before any registration', () => {
  const ctx = setup();
  const open = setup(0o644);
  const cases = [
    base(ctx).map((v) => (v === 'analyst' ? 'operator' : v)),
    base(ctx).map((v) => (v === 'analyst' ? ' Hub ' : v)),
    base(open).map((v, i, a) => (a[i - 1] === '--env-file' ? open.envFile : v)),
    base(ctx).map((v) => (v === 'http://127.0.0.1:18080' ? 'http://10.0.0.5:18080' : v)),
    base(ctx).map((v) => (v === ctx.envFile ? 'broker.env' : v)),
    [...base(ctx), '--scope', 'global'],
    [...base(ctx), '--surprise'],
  ];
  for (const args of cases) {
    const result = run([...args, '--apply'], ctx);
    assert.equal(result.status, 2, `${args.join(' ')}\n${result.stderr}`);
    assert.match(result.stderr, /^refused: /);
    assert.equal(existsSync(ctx.log), false, 'claude was never invoked');
  }
});

test('--remove is a dry run unless --apply, and then calls claude mcp remove', () => {
  const ctx = setup();
  const dry = run(['--remove'], ctx);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /mcp remove --scope user a2a-tasks/);
  assert.equal(existsSync(ctx.log), false);
  const applied = run(['--remove', '--apply'], ctx);
  assert.equal(applied.status, 0, applied.stderr);
  assert.deepEqual(readFileSync(ctx.log, 'utf8').trim().split('\n'), ['mcp', 'remove', '--scope', 'user', 'a2a-tasks']);
});
