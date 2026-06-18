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
expect(typeof pkg.scripts?.['release-gate'] === 'string', 'root package.json missing release-gate script');
const brokerPkg = JSON.parse(readRel('packages/broker/package.json') || '{}');
expect(typeof brokerPkg.scripts?.['start:local'] === 'string', 'broker package.json missing start:local script');
expect(typeof brokerPkg.scripts?.['worker:echo'] === 'string', 'broker package.json missing worker:echo script');
expect(/127\.0\.0\.1:8787/.test(brokerPkg.scripts?.['start:local'] || ''), 'start:local must bind loopback broker URL');
expect(/WORKER_HANDLER_BUILTIN=echo/.test(brokerPkg.scripts?.['worker:echo'] || ''), 'worker:echo must use built-in echo handler');

// ── Release gate must include public-readiness scan ─────────────────────────

const releaseGate = readRel('scripts/release-gate.mjs');
expect(releaseGate !== null, 'missing scripts/release-gate.mjs');
if (releaseGate) {
  expect(/scan:public-readiness/.test(releaseGate), 'release-gate must include public-readiness scan');
  expect(/check:layout/.test(releaseGate), 'release-gate must include layout check');
  expect(/check:packages/.test(releaseGate), 'release-gate must include package checks');
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
