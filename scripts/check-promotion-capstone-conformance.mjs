#!/usr/bin/env node
/**
 * Promotion capstone conformance check.
 *
 * Safety: read-only validation. No deploy, no restart, no live send, no
 * provider/Telegram traffic, and no production broker assumptions.
 */
import { createDocCheckContext } from './lib/doc-check.mjs';

const { root, failures, fail, expect, readRel } = createDocCheckContext();

function parseJson(rel) {
  const text = readRel(rel);
  if (!text) {
    fail(`missing ${rel}`);
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${rel}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function expectMatch(text, regex, message) {
  expect(Boolean(text && regex.test(text)), message);
}

const capstonePath = 'docs/promotion-capstone.md';
const capstone = readRel(capstonePath);
expect(capstone !== null, `missing ${capstonePath}`);

if (capstone) {
  expectMatch(capstone, /Promotion-ready quickstart capstone/i, 'capstone: missing title');
  expectMatch(capstone, /5-minute path/i, 'capstone: missing 5-minute path');
  expectMatch(capstone, /20-minute path/i, 'capstone: missing 20-minute path');
  expectMatch(capstone, /fresh checkout/i, 'capstone: missing fresh checkout language');
  expectMatch(capstone, /npm ci --ignore-scripts --include=dev/, 'capstone: missing deterministic install command');
  expectMatch(capstone, /npm run smoke:quickstart/, 'capstone: missing smoke:quickstart command');
  expectMatch(capstone, /127\.0\.0\.1:8787/, 'capstone: missing loopback broker URL');
  expectMatch(capstone, /local-echo-worker/, 'capstone: missing echo worker id');

  for (const rel of [
    'packages/broker',
    'packages/openclaw-plugin-a2a',
    'packages/docker-runner',
    'docs/external-harness-quickstart.md',
    'fixtures/external-harness/no-live-conformance.json',
  ]) {
    expect(capstone.includes(rel), `capstone: missing package/doc boundary ${rel}`);
  }

  for (const marker of [
    /no-live/i,
    /local-only/i,
    /no production deploy/i,
    /no Gateway\/broker\/worker restart/i,
    /no Telegram send/i,
    /no provider send/i,
    /placeholder-only/i,
    /Stable/i,
    /Experimental/i,
    /#649/,
    /#663/,
    /#665/,
    /stale split docs/i,
    /missing env/i,
    /broker-id routing/i,
    /no-live evidence-only tasks/i,
  ]) {
    expectMatch(capstone, marker, `capstone: missing marker ${marker}`);
  }

  const urls = capstone.match(/https?:\/\/[^\s)]+/g) || [];
  const suspicious = urls.filter((url) => !url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost') && !url.startsWith('https://github.com/jinwon-int/a2a-nexus'));
  expect(suspicious.length === 0, `capstone: live/external URLs not allowed: ${suspicious.join(', ')}`);
}

const pkg = parseJson('package.json');
expectMatch(pkg.scripts?.['check:promotion-capstone'] ?? '', /check-promotion-capstone-conformance\.mjs/, 'package.json: missing check:promotion-capstone script');
expectMatch(pkg.scripts?.['smoke:quickstart'] ?? '', /check:promotion-capstone/, 'package.json: smoke:quickstart must include capstone check');

const ci = readRel('.github/workflows/ci.yml');
expect(ci !== null, 'missing .github/workflows/ci.yml');
if (ci) {
  expectMatch(ci, /promotion-capstone:/, 'ci: missing promotion-capstone job');
  expectMatch(ci, /npm run check:promotion-capstone/, 'ci: promotion-capstone job must run capstone check');
  expectMatch(ci, /npm run smoke:quickstart/, 'ci: promotion-capstone job must run five-minute smoke path');
}

const quickstart = readRel('docs/quickstart.md');
if (quickstart) {
  expectMatch(quickstart, /docs\/promotion-capstone\.md/, 'quickstart: must link promotion capstone');
}

if (failures.length) {
  console.error(`promotion capstone conformance failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('promotion capstone conformance ok: docs, no-live boundaries, package script, and named CI lane validated');
