import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const docPath = join(repoRoot, 'docs', 'validation', 'team2-config-schema-parity-libero.md');
const manifestPath = join(repoRoot, 'packages', 'openclaw-plugin-a2a', 'openclaw.plugin.json');

async function doc() {
  return readFile(docPath, 'utf8');
}

async function manifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

test('Team2 config schema parity libero documents incident and fail-closed restart gates', async () => {
  const content = await doc();

  for (const phrase of [
    'a2a-plane#249',
    'openclaw-plugin-a2a#271',
    'a2a-config-schema-skew-prevention-20260511T120400Z',
    'Decision: `NO-GO / Waiting`',
    'schema/runtime parity',
    'additionalProperties',
    'openclaw status',
    'Docker runner/deploy automation validates plugin config',
  ]) {
    assert.match(content, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }

  assert.doesNotMatch(content, /Decision: `GO`|Gateway restart completed|live Telegram send|terminal ACK complete/i);
});

test('Team2 config schema parity libero keeps runtime/bootstrap deny paths explicit', async () => {
  const content = await doc();

  for (const denyPath of ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md', '.openclaw/**']) {
    assert.match(content, new RegExp(denyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(content, /Report exact repo-relative offending paths/i);
  assert.doesNotMatch(content, /OPENCLAW_CACHE_BOUNDARY|ghp_|github_pat_|Authorization:\s*Bearer/i);
});

test('plugin manifest registers incident-shaped operatorEvents.crossBrokers schema', async () => {
  const plugin = await manifest();
  const operatorEvents = plugin.configSchema?.properties?.operatorEvents;
  const crossBrokers = operatorEvents?.properties?.crossBrokers;
  const item = crossBrokers?.items;

  assert.equal(operatorEvents?.additionalProperties, false);
  assert.equal(crossBrokers?.type, 'array');
  assert.equal(item?.additionalProperties, false);
  assert.deepEqual(item?.required, ['baseUrl']);
  assert.equal(item?.properties?.baseUrl?.pattern, '^[Hh][Tt][Tt][Pp][Ss]?://');
  assert.equal(item?.properties?.edgeSecret?.type, 'string');
  assert.equal(item?.properties?.label?.type, 'string');
  assert.ok(plugin.uiHints?.['operatorEvents.crossBrokers']);
});
