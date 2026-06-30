import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('./conformance-inspector.mjs', import.meta.url).pathname;

test('conformance inspector bridge validates agent cards and writes artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inspector-'));
  const cardPath = join(dir, 'agent-card.json');
  const out = join(dir, 'report.json');
  writeFileSync(cardPath, JSON.stringify({
    name: 'A2A Nexus', description: 'local', url: 'http://127.0.0.1:8787/a2a/jsonrpc', version: '0.1.0', protocolVersion: '1.0',
    capabilities: { streaming: true, pushNotifications: false }, supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: 'http://127.0.0.1:8787/a2a/jsonrpc' }], skills: [{ id: 'analyze', name: 'Analyze', description: 'Analyze tasks' }]
  }));
  const report = JSON.parse(execFileSync(process.execPath, [script, '--agent-card', cardPath, '--out', out], { encoding: 'utf8' }));
  assert.equal(report.ok, true);
  assert.equal(report.harness, 'a2aproject/a2a-inspector');
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).schemaVersion, 'a2a-inspector-bridge.v1');
});
