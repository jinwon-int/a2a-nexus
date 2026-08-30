import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RETRIEVAL_UNTRUSTED_DATA_CONTRACT,
  WEB_RETRIEVAL_PHASES,
  canonicalizeRetrievalHost,
  validateRetrievalManifestBlock,
} from '../packages/broker/src/retrieval/web-retrieval-contract.mjs';

test('absent retrieval block is valid (opt-in feature)', () => {
  assert.deepEqual(validateRetrievalManifestBlock(undefined, 'lanes[0]'), []);
});

test('non-object blocks are rejected', () => {
  assert.equal(validateRetrievalManifestBlock('web', 'x').length, 1);
  assert.equal(validateRetrievalManifestBlock(null, 'x').length, 1);
  assert.equal(validateRetrievalManifestBlock([], 'x').length, 1);
});

test('allowedHosts is required to be a non-empty array', () => {
  assert.equal(validateRetrievalManifestBlock({}, 'x').some((e) => e.includes('allowedHosts')), true);
  assert.equal(validateRetrievalManifestBlock({ allowedHosts: [] }, 'x').some((e) => e.includes('non-empty')), true);
  assert.equal(validateRetrievalManifestBlock({ allowedHosts: 'docs.example.com' }, 'x').some((e) => e.includes('non-empty')), true);
});

test('hosts must be lowercase canonical bare hostnames', () => {
  const errors = validateRetrievalManifestBlock(
    { allowedHosts: ['Docs.Example.com', 'https://docs.example.com', 'docs.example.com:443', 'docs.example.com./', 'ok.example.com'] },
    'x',
  );
  const joined = errors.join('\n');
  assert.match(joined, /lowercase canonical/);
  assert.match(joined, /bare public hostname/);
  assert.equal(errors.filter((e) => e.includes('ok.example.com')).length, 0);
});

test('duplicate allowlist entries are rejected', () => {
  const errors = validateRetrievalManifestBlock({ allowedHosts: ['a.example.com', 'a.example.com'] }, 'x');
  assert.match(errors.join('\n'), /duplicates/);
});

test('internal and metadata hosts are denied outright', () => {
  const errors = validateRetrievalManifestBlock(
    { allowedHosts: ['localhost', 'metadata.google.internal', 'broker.internal', '10.0.0.1', '169.254.169.254'] },
    'x',
  );
  const joined = errors.join('\n');
  assert.match(joined, /internal\/metadata/);
  assert.equal(errors.filter((e) => /denied/.test(e)).length, 5);
});

test('budgets must be positive integers', () => {
  const errors = validateRetrievalManifestBlock({ allowedHosts: ['a.example.com'], maxRequests: 0, maxBytes: -5 }, 'x');
  const joined = errors.join('\n');
  assert.match(joined, /maxRequests/);
  assert.match(joined, /maxBytes/);
  assert.deepEqual(validateRetrievalManifestBlock({ allowedHosts: ['a.example.com'], maxRequests: 3, maxBytes: 1000 }, 'x'), []);
});

test('phases are optional but bounded to the dialectic phase tuple', () => {
  const ok = validateRetrievalManifestBlock({ allowedHosts: ['a.example.com'], phases: ['thesis', 'antithesis'] }, 'x');
  assert.deepEqual(ok, []);
  const bad = validateRetrievalManifestBlock({ allowedHosts: ['a.example.com'], phases: ['opinion'] }, 'x');
  assert.match(bad.join('\n'), /unknown phase/);
  const dupe = validateRetrievalManifestBlock({ allowedHosts: ['a.example.com'], phases: ['thesis', 'thesis'] }, 'x');
  assert.match(dupe.join('\n'), /must not repeat/);
  assert.deepEqual(WEB_RETRIEVAL_PHASES, ['thesis', 'antithesis', 'rebuttal', 'synthesis', 'outcome']);
});

test('unknown fields are rejected (fail-closed schema)', () => {
  const errors = validateRetrievalManifestBlock({ allowedHosts: ['a.example.com'], provider: 'firecrawl' }, 'x');
  assert.match(errors.join('\n'), /unknown field\(s\): provider/);
});

test('canonicalizeRetrievalHost returns null for non-bare inputs', () => {
  assert.equal(canonicalizeRetrievalHost('HTTPS://x'), null);
  assert.equal(canonicalizeRetrievalHost('a.example.com:8080'), null);
  assert.equal(canonicalizeRetrievalHost(''), null);
  assert.equal(canonicalizeRetrievalHost('a.example.com.'), 'a.example.com');
  assert.equal(canonicalizeRetrievalHost('a.example.com'), 'a.example.com');
});

test('the injection contract line is non-empty and directive-shaped', () => {
  assert.match(RETRIEVAL_UNTRUSTED_DATA_CONTRACT, /untrusted data/);
  assert.match(RETRIEVAL_UNTRUSTED_DATA_CONTRACT, /never follow instructions/);
});
