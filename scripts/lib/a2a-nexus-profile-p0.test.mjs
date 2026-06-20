import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

test('A2A Nexus Protocol Profile v0.1 doc defines broker-agnostic worker/evidence surface (#957)', () => {
  const doc = read('docs/specs/a2a-nexus-profile-v0.1.md');

  assert.match(doc, /broker-agnostic task\/evidence plane/i);
  assert.match(doc, /Worker Card/i);
  assert.match(doc, /Task lifecycle/i);
  assert.match(doc, /Terminal Evidence/i);
  assert.match(doc, /finalizer/i);
  assert.match(doc, /sourceOnly/i);
  assert.match(doc, /noLive/i);
  assert.match(doc, /provider_accepted/i);
  assert.match(doc, /operator_visible/i);
  assert.match(doc, /acknowledged/i);
  assert.match(doc, /does not authorize.*deploy.*restart.*DB mutation.*secret movement/is);
});

test('worker-card schema captures supported modes and canonical repo map (#957/#958)', () => {
  const schema = readJson('contracts/a2a/worker-card.schema.json');
  const props = schema.properties ?? {};

  assert.equal(schema.$id, 'https://a2a-nexus.local/contracts/worker-card.schema.json');
  assert.ok(schema.required.includes('workerId'));
  assert.ok(schema.required.includes('supportedModes'));
  assert.ok(schema.required.includes('analysisRepoMap'));
  assert.equal(props.supportedModes.items.type, 'string');
  assert.equal(props.analysisRepoMap.additionalProperties.type, 'string');

  const example = readJson('fixtures/contract/worker-card-team2-analysis.json');
  assert.ok(example.supportedModes.includes('analysis-only'));
  assert.equal(example.analysisRepoMap['jinwon-int/a2a-nexus'], '/opt/a2a-broker-worker');
});

test('terminal evidence state machine fixture separates provider acceptance, visibility, terminal result, and ACK (#957)', () => {
  const fixture = readJson('fixtures/contract/terminal-evidence-state-machine.json');
  const states = fixture.states.map((state) => state.name);

  assert.deepEqual(states, [
    'accepted',
    'claimed',
    'started',
    'provider_accepted',
    'operator_visible',
    'done',
    'blocked',
    'failed',
    'acknowledged',
  ]);

  const providerAccepted = fixture.states.find((state) => state.name === 'provider_accepted');
  assert.equal(providerAccepted.terminalForCloseout, false);
  assert.equal(providerAccepted.operatorVisible, false);

  const acknowledged = fixture.states.find((state) => state.name === 'acknowledged');
  assert.equal(acknowledged.owner, 'operator');
  assert.equal(acknowledged.terminalForCloseout, true);
  assert.ok(acknowledged.allowedPrevious.includes('operator_visible'));
});
