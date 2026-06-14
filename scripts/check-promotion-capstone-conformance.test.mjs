/**
 * Promotion capstone conformance tests.
 *
 * Safety: read-only doc/CI validation. No deploy, no restart, no live provider
 * send, no Telegram send, and no production broker assumptions.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const capstonePath = join(repoRoot, 'docs', 'promotion-capstone.md');

async function capstone() {
  return readFile(capstonePath, 'utf8');
}

test('promotion capstone doc exists', () => {
  assert.ok(existsSync(capstonePath));
});

test('promotion capstone defines canonical five-minute local loopback smoke path', async () => {
  const content = await capstone();
  assert.match(content, /5-minute path/i);
  assert.match(content, /fresh checkout/i);
  assert.match(content, /npm ci --ignore-scripts --include=dev/);
  assert.match(content, /npm run smoke:quickstart/);
  assert.match(content, /127\.0\.0\.1:8787/);
  assert.match(content, /local-echo-worker/);
  assert.match(content, /packages\/broker/);
});

test('promotion capstone defines twenty-minute package-boundary path', async () => {
  const content = await capstone();
  assert.match(content, /20-minute path/i);
  assert.match(content, /packages\/broker/);
  assert.match(content, /packages\/openclaw-plugin-a2a/);
  assert.match(content, /packages\/docker-runner/);
  assert.match(content, /docs\/external-harness-quickstart\.md/);
  assert.match(content, /fixtures\/external-harness\/no-live-conformance\.json/);
});

test('promotion capstone is explicitly no-live and secret-free', async () => {
  const content = await capstone();
  assert.match(content, /no-live/i);
  assert.match(content, /local-only/i);
  assert.match(content, /no production deploy/i);
  assert.match(content, /no Gateway\/broker\/worker restart/i);
  assert.match(content, /no Telegram send/i);
  assert.match(content, /no provider send/i);
  assert.match(content, /placeholder-only/i);
  const urls = content.match(/https?:\/\/[^\s)]+/g) || [];
  const suspicious = urls.filter(
    (url) =>
      !url.startsWith('http://127.0.0.1') &&
      !url.startsWith('http://localhost') &&
      !url.startsWith('https://github.com/jinwon-int/a2a-nexus')
  );
  assert.strictEqual(suspicious.length, 0, `live URLs in capstone: ${suspicious.join(', ')}`);
});

test('promotion capstone marks stable vs experimental and links parent trackers', async () => {
  const content = await capstone();
  assert.match(content, /Stable/i);
  assert.match(content, /Experimental/i);
  assert.match(content, /#649/);
  assert.match(content, /#663/);
  assert.match(content, /#665/);
});

test('promotion capstone has required troubleshooting topics', async () => {
  const content = await capstone();
  for (const topic of [
    /stale split docs/i,
    /missing env/i,
    /broker-id routing/i,
    /no-live evidence-only tasks/i,
  ]) {
    assert.match(content, topic);
  }
});

test('root package exposes named promotion capstone check', async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  assert.match(pkg.scripts?.['check:promotion-capstone'] ?? '', /check-promotion-capstone-conformance\.mjs/);
});

test('ci exposes named promotion-capstone lane for the five-minute path', async () => {
  const ci = await readFile(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(ci, /promotion-capstone:/);
  assert.match(ci, /npm run check:promotion-capstone/);
  assert.match(ci, /npm run smoke:quickstart/);
});
