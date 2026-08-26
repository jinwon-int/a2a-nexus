#!/usr/bin/env node
/**
 * Quickstart conformance check (no live network/provider assumptions).
 *
 * Validates that the quickstart guide and supporting docs/examples
 * are structurally sound and reference only deterministic, local-safe paths.
 *
 * Safety: read-only doc validation. No deploy, no restart, no live send,
 * no secret exposure. Designed for CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createDocCheckContext } from './lib/doc-check.mjs';

const { root, failures, fail, expect, readRel } = createDocCheckContext();

function fileExists(rel) {
  return fs.existsSync(path.join(root, rel));
}

// ── Quickstart doc ──────────────────────────────────────────────────────────

const quickstartPath = 'docs/quickstart.md';
const quickstart = readRel(quickstartPath);

expect(quickstart !== null, `missing ${quickstartPath}`);
if (quickstart) {
  // Structural markers
  expect(/Five-minute local quickstart/i.test(quickstart), 'quickstart: missing title');
  expect(/Prerequisites/i.test(quickstart), 'quickstart: missing Prerequisites section');
  expect(/Run the local A2A Nexus broker/i.test(quickstart), 'quickstart: missing broker section');
  expect(/Start a dummy or echo worker/i.test(quickstart), 'quickstart: missing worker section');
  expect(/Connect the reference OpenClaw plugin locally/i.test(quickstart), 'quickstart: missing plugin section');
  expect(/Submit a no-live test task/i.test(quickstart), 'quickstart: missing test task section');
  expect(/Verify public-readiness checks/i.test(quickstart), 'quickstart: missing verification section');
  expect(/Safety checklist/i.test(quickstart), 'quickstart: missing safety checklist');

  // Deterministic commands only (no live network URLs)
  expect(/127\.0\.0\.1:8787/.test(quickstart), 'quickstart: must use loopback broker URL');
  expect(/npm ci --ignore-scripts --include=dev/.test(quickstart), 'quickstart: must reference deterministic install command');
  expect(/npm run check/.test(quickstart), 'quickstart: must reference npm run check for verification');
  expect(/npm run smoke:quickstart/.test(quickstart), 'quickstart: must reference npm run smoke:quickstart pre-flight');
  expect(/npm run (build|check)/.test(quickstart), 'quickstart: must reference build/check commands');

  // No live provider assumptions
  const liveUrls = quickstart.match(/https?:\/\/(?!(127\.0\.0\.1|localhost|github\.com\/jinwon-int))[^\s)]+/g);
  if (liveUrls) {
    const suspicious = liveUrls.filter((u) => !u.startsWith('http://127.0.0.1') && !u.startsWith('http://localhost'));
    if (suspicious.length) {
      fail(`quickstart: references non-local URLs: ${suspicious.join(', ')}`);
    }
  }

  // Safety language
  expect(/Do not point this path at production/i.test(quickstart), 'quickstart: must warn against production use');
  expect(/no production deploy/i.test(quickstart), 'quickstart: must mention no production deploy');
  expect(/Never include real tokens/i.test(quickstart), 'quickstart: must warn against tokens in examples');

  // Post-78261: accepted-send non-ACK
  expect(/accepted-send evidence only/i.test(quickstart), 'quickstart: must state accepted-send is non-ACK evidence');
  expect(/not requester-visible receipt/i.test(quickstart), 'quickstart: must clarify accepted-send is not requester-visible receipt');
  expect(/(is not|not).*terminal ACK/i.test(quickstart), 'quickstart: must clarify accepted-send is not terminal ACK');

  // Post-78261: replay-safe expectations
  expect(/replay-safe/i.test(quickstart), 'quickstart: must mention replay-safe expectations');
  expect(/idempotent/i.test(quickstart), 'quickstart: must reference idempotent replay');

  // #1505 criterion 3: no angle-bracket placeholders that a shell interprets as redirection
  expect(!/<local-echo-worker>/.test(quickstart), 'quickstart: worker id must be the literal local-echo-worker, not a <...> placeholder');
  expect(!/=<[A-Za-z]/.test(quickstart), 'quickstart: command examples must not assign =<...> angle-bracket placeholders (shell redirection hazard)');
  expect(/LOCAL_A2A_WORKER_ID=local-echo-worker/.test(quickstart), 'quickstart: worker block must use literal LOCAL_A2A_WORKER_ID=local-echo-worker');

  // #1505 criterion 4: source-only is the only supported install path
  expect(/only supported install path/i.test(quickstart), 'quickstart: must state source-only is the only supported install path');
  expect(/no supported `npm install`/i.test(quickstart), 'quickstart: must state there is no supported npm install/Docker/GHCR path');

  // #1505 criterion 5: known limitations and TCK compatibility linked together
  expect(/## Limitations and compatibility/i.test(quickstart), 'quickstart: must have a Limitations and compatibility section');
  expect(/known-limitations\.md/.test(quickstart), 'quickstart: must link known limitations');
  expect(/compatibility\/matrix\.md/.test(quickstart), 'quickstart: must link the compatibility matrix');
  expect(/a2a-tck-and-v0-to-v1-compatibility-plan\.md/.test(quickstart), 'quickstart: must link the A2A TCK compatibility plan');

  // #1505 criterion 2: quickstart references the executable doctest
  expect(/check:quickstart-doctest/.test(quickstart), 'quickstart: must reference the executable doctest (npm run check:quickstart-doctest)');
}

// ── Canonical demo doc ──────────────────────────────────────────────────────

const demoPath = 'docs/canonical-demo.md';
const demo = readRel(demoPath);

expect(demo !== null, `missing ${demoPath}`);
if (demo) {
  expect(/Canonical A2A Demo/i.test(demo), 'demo: missing title');
  expect(/No-live safety boundary/i.test(demo), 'demo: missing safety boundary section');
  expect(/Expected terminal evidence/i.test(demo), 'demo: missing terminal evidence section');
  expect(/must not perform production deploys/i.test(demo), 'demo: missing production-safety language');
  expect(/PR|Done|Block/.test(demo), 'demo: must reference PR/Done/Block evidence states');
}

// ── Canonical demo task example ─────────────────────────────────────────────

const examplePath = 'examples/canonical-demo-task.json';
expect(fileExists(examplePath), `missing ${examplePath}`);
expect(fileExists('examples/local/README.md'), 'missing examples/local/README.md');
expect(fileExists('examples/local/local-quickstart-task.json'), 'missing examples/local/local-quickstart-task.json');

const localExample = readRel('examples/local/README.md');
if (localExample) {
  expect(/npm run start:local/.test(localExample), 'local example: missing start:local command');
  expect(/npm run worker:echo/.test(localExample), 'local example: missing worker:echo command');
  expect(/local-quickstart-task\.json/.test(localExample), 'local example: missing task fixture reference');
  expect(/Do not use production brokers/i.test(localExample), 'local example: missing production safety boundary');
}

const localTask = readRel('examples/local/local-quickstart-task.json');
if (localTask) {
  try {
    const parsed = JSON.parse(localTask);
    expect(parsed.assignedWorkerId === 'local-echo-worker', 'local task: assignedWorkerId must be local-echo-worker');
    expect(parsed.payload?.noLive === true, 'local task: payload.noLive must be true');
    expect(parsed.payload?.replaySafe === true, 'local task: payload.replaySafe must be true');
  } catch (error) {
    fail(`local task: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── Quickstart references release-gate ─────────────────────────────────────

expect(fileExists('scripts/release-gate.mjs'), 'missing scripts/release-gate.mjs (release gate orchestrator)');
expect(fileExists('scripts/check-layout.mjs'), 'missing scripts/check-layout.mjs (layout check)');
expect(fileExists('scripts/check-compatibility-baselines.mjs'), 'missing scripts/check-compatibility-baselines.mjs (compatibility baseline check)');

// Quickstart says run "npm run check" which maps to release-gate
const pkg = JSON.parse(readRel('package.json') || '{}');
expect(pkg.scripts?.check === 'npm run release-gate', 'root package.json check script must point to release-gate');
expect(pkg.scripts?.build === 'npm run build -ws', 'root package.json must have workspace-scoped build script');
expect(typeof pkg.scripts?.['smoke:quickstart'] === 'string', 'root package.json missing smoke:quickstart script');
expect(/build/.test(pkg.scripts?.['smoke:quickstart'] || ''), 'smoke:quickstart must include build step');
expect(/check:quickstart-conformance/.test(pkg.scripts?.['smoke:quickstart'] || ''), 'smoke:quickstart must include quickstart conformance check');
expect(/test:release-gate/.test(pkg.scripts?.['smoke:quickstart'] || ''), 'smoke:quickstart must include release-gate tests');

// #1505 criterion 2: executable doctest exists and is wired into smoke:quickstart (which CI runs)
expect(fileExists('scripts/check-quickstart-doctest.mjs'), 'missing scripts/check-quickstart-doctest.mjs (executable quickstart doctest)');
expect(typeof pkg.scripts?.['check:quickstart-doctest'] === 'string', 'root package.json missing check:quickstart-doctest script');
expect(/check:quickstart-doctest/.test(pkg.scripts?.['smoke:quickstart'] || ''), 'smoke:quickstart must include the executable quickstart doctest');
expect(typeof pkg.scripts?.['release-gate'] === 'string', 'root package.json missing release-gate script');
const brokerPkg = JSON.parse(readRel('packages/broker/package.json') || '{}');
expect(typeof brokerPkg.scripts?.['start:local'] === 'string', 'broker package.json missing start:local script');
expect(typeof brokerPkg.scripts?.['worker:echo'] === 'string', 'broker package.json missing worker:echo script');
expect(/127\.0\.0\.1:8787/.test(brokerPkg.scripts?.['start:local'] || ''), 'start:local must bind loopback broker URL');
expect(/WORKER_HANDLER_BUILTIN=echo/.test(brokerPkg.scripts?.['worker:echo'] || ''), 'worker:echo must use built-in echo handler');

const startLocalScript = brokerPkg.scripts?.['start:local'] || '';
const usesLocalState = /STATE_FILE=\.local\/state\.json/.test(startLocalScript);
if (usesLocalState) {
  for (const [doc, text] of [
    ['docs/quickstart.md', quickstart],
    ['docs/demo/README.md', readRel('docs/demo/README.md')],
  ]) {
    expect(/rm -rf packages\/broker\/\.local/.test(text || ''), `${doc}: teardown must remove packages/broker/.local when start:local uses .local/state.json`);
    expect(!/rm -f \/tmp\/a2a-broker-state\.json/.test(text || ''), `${doc}: teardown must not point start:local cleanup at stale /tmp state file`);
  }
}

// ── Compose examples must be copy-safe by default ───────────────────────────

for (const composePath of [
  'packages/broker/examples/docker-compose.smoke.yml',
  'packages/broker/examples/docker-compose.trading-partners.yml',
]) {
  const compose = readRel(composePath) || '';
  expect(/A2A_BROKER_REVISION:\s*\$\{A2A_BROKER_REVISION:\?/.test(compose), `${composePath}: build revision must fail fast instead of defaulting to unknown`);
  expect(/A2A_BROKER_CREATED:\s*\$\{A2A_BROKER_CREATED:\?/.test(compose), `${composePath}: build created timestamp must fail fast instead of defaulting empty`);
}

const tradingCompose = readRel('packages/broker/examples/docker-compose.trading-partners.yml') || '';
expect(/127\.0\.0\.1:8787:8787/.test(tradingCompose), 'trading compose: broker port must bind loopback by default');
expect(!/"8787:8787"/.test(tradingCompose), 'trading compose: must not publish broker on all interfaces by default');
expect(!/\/srv\/trading\/.+:rw/.test(tradingCompose), 'trading compose: must not mount live /srv/trading paths read-write by default');
expect(/operator-only override/i.test(tradingCompose), 'trading compose: must tell operators to use an override for live host paths');

// ── Canonical issue routing must match a2a-nexus source of truth ────────────

const publicUmbrella = readRel('docs/quickstart/public-umbrella.md') || '';
const issueRouting = readRel('docs/issue-routing.md') || '';
for (const [doc, text] of [
  ['docs/quickstart/public-umbrella.md', publicUmbrella],
  ['docs/issue-routing.md', issueRouting],
]) {
  expect(/a2a-nexus/.test(text), `${doc}: must name a2a-nexus as canonical implementation source`);
  expect(/open unclear or cross-repo issues in `a2a-nexus` first/i.test(text), `${doc}: ambiguous/cross-repo issues must route to a2a-nexus first`);
  expect(!/Open unclear or cross-repo issues in `a2a-plane` first/.test(text), `${doc}: must not route new unclear work to legacy a2a-plane first`);
  expect(!/split repo issues and PRs remain authoritative/i.test(text), `${doc}: must not describe split repos as authoritative for new work`);
}

// ── Release gate must keep public-readiness and package checks ──────────────

const releaseGateInventory = JSON.parse(readRel('docs/ops/release-gate-step-inventory.json') || '{}');
expect(Array.isArray(releaseGateInventory.entries), 'missing release-gate step inventory entries');
if (Array.isArray(releaseGateInventory.entries)) {
  const byName = new Map(releaseGateInventory.entries.map((entry) => [entry.name, entry]));
  const publicReadiness = byName.get('public-readiness');
  const layout = byName.get('layout');
  const packages = byName.get('packages');
  // The inventory invokes these gate scripts directly (node <script>) rather
  // than through their npm aliases, which stay in package.json for humans.
  expect(Boolean(publicReadiness), 'release-gate inventory must include public-readiness scan');
  expect(publicReadiness?.tier === 'public-readiness', 'public-readiness scan must stay in public-readiness tier');
  expect(JSON.stringify(publicReadiness?.args) === JSON.stringify(['scripts/public-readiness-scan.mjs', '--strict-internal']), 'public-readiness release-gate args must invoke the strict public-readiness scan');
  expect(Boolean(layout), 'release-gate inventory must include layout check');
  expect(layout?.tier === 'core', 'layout check must stay in core tier');
  expect(JSON.stringify(layout?.args) === JSON.stringify(['scripts/check-layout.mjs']), 'layout release-gate args must invoke the layout check');
  expect(Boolean(packages), 'release-gate inventory must include package checks');
  expect(packages?.tier === 'core', 'package checks must stay in core tier');
  expect(JSON.stringify(packages?.args) === JSON.stringify(['scripts/check-packages.mjs']), 'package release-gate args must invoke the package checks');
}

// ── Compatibility baseline doc ──────────────────────────────────────────────

expect(fileExists('contracts/compatibility/matrix.md'), 'missing contracts/compatibility/matrix.md');

// ── No-live safety language across key docs ─────────────────────────────────

const safetyDocs = ['docs/quickstart.md', 'docs/canonical-demo.md', 'CONTRIBUTING.md'];
for (const doc of safetyDocs) {
  const text = readRel(doc);
  if (text) {
    const hasSafety =
      /no (production|live) (deploy|send|restart)/i.test(text) ||
      /safety/i.test(text);
    expect(hasSafety, `${doc}: missing safety language`);
  }
}

// ── Result ──────────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(`quickstart conformance failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log(`quickstart conformance ok: quickstart docs, examples, release gate, and package CIs validated`);
