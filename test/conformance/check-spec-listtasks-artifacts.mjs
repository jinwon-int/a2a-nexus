#!/usr/bin/env node
/**
 * Spec-path ListTasks includeArtifacts elision conformance check
 * (#1912 D4, #2002).
 *
 * Safety: read-only validation of source constants, test coverage markers, the
 * compatibility fixture, and the compatibility doc. No live broker, edge
 * secret, provider token, database mutation, deploy/restart, or secret
 * exposure.
 *
 * Fail-closed contract: this check fails if any of the pinned invariants below
 * drifts — the implementation, the fixture, the doc table, and the test
 * suites must agree or the conformance gate is red.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const parserRel = 'packages/broker/src/a2a/list-tasks-spec-filters.ts';
const parserTestsRel = 'packages/broker/src/a2a/list-tasks-spec-filters.test.ts';
const jsonRpcRel = 'packages/broker/src/a2a/json-rpc.ts';
const fixtureRel = 'packages/broker/src/fixtures/a2a-protocol-compatibility.ts';
const docRel = 'packages/broker/docs/protocol-compatibility.md';

// ---------------------------------------------------------------------------
// 1. The parser normalizes the proto default (absent = false) and rejects junk
// ---------------------------------------------------------------------------
const parser = read(parserRel);

assert.match(
  parser,
  /includeArtifacts = artifactsField\.value;/,
  'D4: the parser must capture the explicit boolean instead of dropping it',
);
assert.match(
  parser,
  /must be a boolean/,
  'D4: a non-boolean includeArtifacts must reject -32602',
);
assert.match(
  parser,
  /includeArtifacts: includeArtifacts === true,/,
  'D4: the parsed filters must carry the resolved boolean (absent normalizes to false)',
);
assert.match(
  parser,
  /it cannot change membership/,
  'D4: the parser must record that the flag is shape-only and never joins the cursor scopeKey',
);

// ---------------------------------------------------------------------------
// 2. The projection elides the key entirely; GetTask keeps artifacts
// ---------------------------------------------------------------------------
const jsonRpc = read(jsonRpcRel);

assert.match(
  jsonRpc,
  /includeArtifacts: specFilters\?\.includeArtifacts === true/,
  'D4: the ListTasks spec path must pass the resolved flag into the projection',
);
assert.match(
  jsonRpc,
  /options\?\.includeArtifacts === false\s*\?\s*\{\}\s*:\s*\{\s*artifacts: specTaskArtifacts/,
  'D4: false must elide the artifacts key entirely — never [] or null; absent options (GetTask) keep artifacts',
);

// ---------------------------------------------------------------------------
// 3. The fixture and the doc describe implemented elision, not a gap
// ---------------------------------------------------------------------------
const fixture = read(fixtureRel);
assert.match(
  fixture,
  /proto default false — absent or explicit false elides the artifacts key/,
  'D4: the compatibility fixture must pin the elision contract',
);
assert.doesNotMatch(fixture, /D4 gap/, 'fixture must not describe elision as a gap');
assert.doesNotMatch(read(parserTestsRel), /D4 gap/, 'test names must not describe elision as a gap');

const doc = read(docRel);
assert.match(
  doc,
  /elides the `artifacts` key from every returned task entirely/,
  'D4: protocol-compatibility.md must document the elision default',
);
assert.doesNotMatch(doc, /D4 gap/, 'protocol-compatibility.md must not describe elision as a gap');

// ---------------------------------------------------------------------------
// 4. The test suite pins both sides of the flag contract
// ---------------------------------------------------------------------------
const vocabularyTests = read(parserTestsRel);
assert.match(
  vocabularyTests,
  /includeArtifacts elides the artifacts key by default and on explicit false/,
  'tests must pin elision for the proto default and explicit false (never [] or null)',
);
assert.match(
  vocabularyTests,
  /includeArtifacts=true always carries the artifacts key/,
  'tests must pin that true always carries the key',
);
assert.match(
  vocabularyTests,
  /paging can flip it without changing membership/,
  'tests must pin that the flag is shape-only across cursor pages',
);
assert.match(
  vocabularyTests,
  /spec GetTask keeps artifacts — it has no includeArtifacts proto field/,
  'tests must pin that GetTask is out of D4 scope',
);
assert.match(
  vocabularyTests,
  /Object\.hasOwn\(entry, "artifacts"\)/,
  'tests must pin key absence structurally (Object.hasOwn), not by value comparison',
);

console.log('check-spec-listtasks-artifacts: ok');
console.log('  pinned: includeArtifacts proto default false, full key elision (never []/null),');
console.log('  true always carries the key, shape-only cursor scope, GetTask out of scope.');
