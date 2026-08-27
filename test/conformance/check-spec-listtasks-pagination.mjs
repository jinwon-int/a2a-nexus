#!/usr/bin/env node
/**
 * Spec-path ListTasks vocabulary + bounded pagination conformance check
 * (#1912 D2+D3, #1997).
 *
 * Safety: read-only validation of source constants, test coverage markers, the
 * compatibility fixture, and the compatibility doc. No live broker, edge
 * secret, provider token, database mutation, deploy/restart, or secret
 * exposure.
 *
 * Fail-closed contract: this check fails if any of the pinned invariants below
 * drifts — the fixture, the implementation constants, the doc table, and the
 * test suites must agree or the conformance gate is red.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const parserRel = 'packages/broker/src/a2a/list-tasks-spec-filters.ts';
const parserTestsRel = 'packages/broker/src/a2a/list-tasks-spec-filters.test.ts';
const paginationTestsRel = 'packages/broker/src/a2a/list-tasks-spec-pagination.test.ts';
const jsonRpcRel = 'packages/broker/src/a2a/json-rpc.ts';
const fixtureRel = 'packages/broker/src/fixtures/a2a-protocol-compatibility.ts';
const docRel = 'packages/broker/docs/protocol-compatibility.md';

// ---------------------------------------------------------------------------
// 1. Implementation constants pin the v1.0.1 proto contract (a2a.proto L675-700)
// ---------------------------------------------------------------------------
const parser = read(parserRel);

assert.match(
  parser,
  /export const SPEC_PAGE_SIZE_DEFAULT = 50;/,
  'D3: ListTasks pageSize default must be 50 (proto: "If unspecified, at most 50 tasks will be returned")',
);
assert.match(
  parser,
  /export const SPEC_PAGE_SIZE_MAX = 100;/,
  'D3: ListTasks pageSize maximum must be 100 (proto: "The maximum value is 100")',
);
assert.match(
  parser,
  /pageSize = Math\.min\(pageSizeField\.value, SPEC_PAGE_SIZE_MAX\)/,
  'D3: oversized pageSize requests must clamp, never serve more than the maximum',
);
assert.match(
  parser,
  /pageSizeField\.value < 1/,
  'D3: pageSize below the proto minimum of 1 must reject',
);

// ---------------------------------------------------------------------------
// 2. Unknown spec-path keys fail closed; legacy envelope keeps its own parser
// ---------------------------------------------------------------------------
assert.match(
  parser,
  /unknown ListTasks parameter/,
  'D2: unknown ListTasks keys must reject with the key named (no silent drops, #1924 precedent)',
);
assert.match(
  read(jsonRpcRel),
  /options\.responseShape === "spec" \? parseSpecListTaskFilters\(params\) : undefined/,
  'D2: the strict parser must apply only to the spec response shape',
);
assert.match(
  read(jsonRpcRel),
  /parseListTaskFilters\(params\)/,
  'D2: the headerless legacy envelope must keep its historical internal-vocabulary parser',
);

// ---------------------------------------------------------------------------
// 3. Cursors are checksummed and scope-bound; stale seek fails closed
// ---------------------------------------------------------------------------
assert.match(
  parser,
  /fnv1a32\(payload\) !== checksum/,
  'D3: cursor integrity must be verified before interpreting any field',
);
assert.match(
  parser,
  /belongs to a different query scope/,
  'D3: cursors must reject replay under a different filter scope',
);
assert.match(
  parser,
  /stale cursor\): re-query from the first page/,
  'D3: a cursor whose anchor task left the result must fail closed (no skip-ahead)',
);

// ---------------------------------------------------------------------------
// 4. Status matching happens at the projection boundary (D1/D9 subtleties)
// ---------------------------------------------------------------------------
assert.match(
  parser,
  /TASK_STATE_INPUT_REQUIRED: "input-required"/,
  'D2: the TASK_STATE_* vocabulary table must cover the full projected spelling set',
);
assert.match(
  read(jsonRpcRel),
  /projectBrokerTask\(task\)\.status\.state === wanted/,
  'D2: status filtering must compare against the projected state, not raw internal status',
);

// ---------------------------------------------------------------------------
// 5. The documented D4 deviation stays explicit until elision lands
// ---------------------------------------------------------------------------
assert.match(
  parser,
  /elision for false remains the documented D4 gap/,
  'D4: includeArtifacts=false acceptance must keep pointing at the documented artifact-elision gap',
);
const doc = read(docRel);
assert.match(
  doc,
  /includeArtifacts=false` is accepted but artifacts are still returned/,
  'D4: protocol-compatibility.md must record the artifact-elision deviation',
);
assert.match(
  doc,
  /clamps to the documented maximum of 100/,
  'D3: protocol-compatibility.md must document the pageSize clamp',
);

// ---------------------------------------------------------------------------
// 6. The compatibility fixture carries the same stance (drift-watch surface)
// ---------------------------------------------------------------------------
const fixture = read(fixtureRel);
assert.match(fixture, /listTaskFilters:/, 'fixture must declare the listTaskFilters stance');
assert.match(fixture, /defaultPageSize: 50/, 'fixture must pin the default page size');
assert.match(fixture, /maxPageSize: 100/, 'fixture must pin the maximum page size');
assert.match(
  fixture,
  /scope-mismatched reject -32602/,
  'fixture must record the fail-closed cursor policy',
);

// ---------------------------------------------------------------------------
// 7. The two test suites that pin behavior exist and cover the contract
// ---------------------------------------------------------------------------
const vocabularyTests = read(parserTestsRel);
const paginationTests = read(paginationTestsRel);
assert.match(
  vocabularyTests,
  /TASK_STATE_INPUT_REQUIRED.*\["interrupted"\]/,
  'vocabulary tests must pin the checkpoint-interrupt projected state',
);
assert.match(
  vocabularyTests,
  /legacy envelope parser is unchanged/,
  'vocabulary tests must pin legacy-envelope invariance',
);
assert.match(
  paginationTests,
  /default pageSize is 50 when unspecified/,
  'pagination tests must pin the default page size',
);
assert.match(
  paginationTests,
  /larger requests clamp instead of erroring/,
  'pagination tests must pin the 100-task maximum clamp',
);
assert.match(
  paginationTests,
  /pagination walks every task exactly once across pages/,
  'pagination tests must prove walk completeness (no loss, no duplicates)',
);
assert.match(
  paginationTests,
  /forged or tampered page tokens fail closed/,
  'pagination tests must pin cursor fail-closed behavior',
);
assert.match(
  paginationTests,
  /the legacy envelope is unaffected by bounded pagination/,
  'pagination tests must pin legacy-envelope invariance',
);

console.log('check-spec-listtasks-pagination: ok');
console.log('  pinned: pageSize default 50 / max 100 clamp, scope-bound fail-closed cursors,');
console.log('  projected-state status matching, legacy invariance, documented D4 deviation.');
