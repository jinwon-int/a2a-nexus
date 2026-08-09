import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!['node_modules', 'dist', 'coverage'].includes(ent.name)) out.push(...walk(p));
    } else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(ent.name)) {
      out.push(path.relative(root, p).replaceAll('\\', '/'));
    }
  }
  return out;
}

// Scan every surface that can route a Terminal Brief outward. The OpenClaw
// plugin package used to be one of them; it was retired, and the per-harness
// bridges under packages/broker/scripts took its place, so they are scanned now.
const harnessBridges = fs
  .readdirSync(path.join(root, 'packages/broker/scripts'), { withFileTypes: true })
  .filter((ent) => ent.isFile() && /-a2a-analysis-bridge\.mjs$/.test(ent.name))
  .map((ent) => path.join('packages/broker/scripts', ent.name));

// Scope: surfaces that can route a Terminal Brief *outward*. Broker runtime, the
// per-harness bridges that replaced the retired OpenClaw plugin, and the runner.
// Deliberately not all of packages/broker/scripts: operator CLIs there call the
// broker's own HTTP API with curl, which is not outward delivery and is not what
// this guard is about.
const routingFiles = [
  ...walk(path.join(root, 'packages/broker/src')),
  ...harnessBridges,
  ...walk(path.join(root, 'packages/docker-runner/src')),
].filter((file) => !/\.test\.(?:ts|js|mjs)$/.test(file));

const directDeliveryPatterns = [
  { name: 'Telegram Bot API URL', re: /api\.telegram\.org/i },
  { name: 'Telegram sendMessage primitive', re: /\bsendMessage\b/ },
  { name: 'curl process spawn', re: /\b(?:execFile|execFileSync|spawn|spawnSync|exec|execSync)\s*\([^\n;]*(?:['"]curl['"]|`curl\b)/ },
];

for (const file of routingFiles) {
  const text = read(file);
  for (const { name, re } of directDeliveryPatterns) {
    if (re.test(text)) {
      fail(`${file}: production Terminal Brief routing must not use direct ${name}; route through a harness adapter, never a transport primitive`);
    }
  }
}

// The per-file guards that used to assert receipt/ACK strings inside
// packages/openclaw-plugin-a2a/src/{operator-notification-adapter,operator-event-bridge}.ts
// retire with that package. The invariant they protected is not dropped: the
// ACK boundary is enforced by test/conformance/check-terminal-evidence-ack-boundary.mjs
// (wired into run-conformance.mjs, so it runs in CI) and by the core-tier
// message-id-ack-boundary gate, neither of which is harness-specific.

if (failures.length) {
  console.error(`terminal brief routing guard failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log(`terminal brief routing guard ok: ${routingFiles.length} production routing files checked; direct Telegram/curl sends blocked; provider acceptance remains non-ACK`);
