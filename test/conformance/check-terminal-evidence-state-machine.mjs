import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const fixturePath = path.join(root, 'fixtures', 'contract', 'terminal-evidence-state-machine.json');
const schemaPath = path.join(root, 'contracts', 'a2a', 'terminal-evidence.schema.json');
const docsPath = path.join(root, 'docs', 'specs', 'terminal-evidence-state-machine.md');

const fixtureText = fs.readFileSync(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText);
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const docs = fs.readFileSync(docsPath, 'utf8');

const expectedStates = ['accepted', 'claimed', 'started', 'provider_accepted', 'operator_visible', 'done', 'blocked', 'failed', 'acknowledged'];
const expectedOwners = ['broker', 'worker', 'runner', 'plugin', 'provider', 'finalizer', 'operator'];
const stateByName = new Map(fixture.states.map((state) => [state.name, state]));

assert.deepEqual(fixture.states.map((state) => state.name), expectedStates);
assert.deepEqual(schema.$defs.terminalEvidenceState.enum, expectedStates);
assert.deepEqual(schema.$defs.terminalEvidenceOwner.enum, expectedOwners);
assert.equal(fixture.contract, 'contracts/a2a/terminal-evidence.schema.json');
assert.equal(fixture.docs, 'docs/specs/terminal-evidence-state-machine.md');
assert.equal(fixture.safety.providerAcceptedIsTerminalAck, false);
assert.equal(fixture.safety.providerAcceptedCountsForCloseout, false);
assert.equal(fixture.safety.operatorVisibleCountsAsTerminalAck, false);
assert.equal(fixture.safety.acknowledgedRequiresOperatorEvidence, true);

for (const state of fixture.states) {
  assert.ok(expectedOwners.includes(state.owner), `${state.name} owner must be known`);
  assert.ok(Array.isArray(state.allowedPrevious), `${state.name} allowedPrevious must be array`);
  assert.ok(Array.isArray(state.allowedNext), `${state.name} allowedNext must be array`);
  assert.ok(Array.isArray(state.requiredEvidence), `${state.name} requiredEvidence must be array`);
  for (const previous of state.allowedPrevious) assert.ok(stateByName.has(previous), `${state.name} unknown previous ${previous}`);
  for (const next of state.allowedNext) assert.ok(stateByName.has(next), `${state.name} unknown next ${next}`);
}

assert.equal(stateByName.get('provider_accepted').terminalForCloseout, false);
assert.equal(stateByName.get('provider_accepted').operatorVisible, false);
assert.deepEqual(stateByName.get('provider_accepted').requiredEvidence.sort(), ['providerMessageId', 'providerName'].sort());
assert.equal(stateByName.get('operator_visible').terminalForCloseout, false);
assert.equal(stateByName.get('operator_visible').operatorVisible, true);
assert.deepEqual(stateByName.get('operator_visible').requiredEvidence.sort(), ['operatorFacingOwner', 'terminalBriefId'].sort());
assert.equal(stateByName.get('acknowledged').owner, 'operator');
assert.equal(stateByName.get('acknowledged').terminalForCloseout, true);
assert.deepEqual(stateByName.get('acknowledged').requiredEvidence.sort(), ['ackEvidence', 'ackOwner'].sort());

const examples = new Map(fixture.examples.map((example) => [example.kind, example]));
for (const kind of ['done', 'blocked', 'pr', 'provider_accepted', 'operator_visible', 'acknowledged']) {
  assert.ok(examples.has(kind), `missing example ${kind}`);
}
assert.equal(examples.get('provider_accepted').isTerminalAck, false);
assert.equal(examples.get('provider_accepted').countsForCloseout, false);
assert.equal(examples.get('operator_visible').isTerminalAck, false);
assert.equal(examples.get('operator_visible').countsForCloseout, false);
assert.equal(examples.get('acknowledged').isTerminalAck, true);
assert.equal(examples.get('acknowledged').countsForCloseout, true);
assert.equal(examples.get('pr').terminalEvidenceKind, 'pr');

for (const phrase of [
  'provider_accepted is not terminal ACK',
  'operator_visible is not terminal ACK',
  'acknowledged is the only operator-owned terminal ACK state',
  'finalizerOwner',
  'Done',
  'Block',
  'PR',
]) {
  assert.ok(docs.includes(phrase), `docs missing phrase: ${phrase}`);
}
