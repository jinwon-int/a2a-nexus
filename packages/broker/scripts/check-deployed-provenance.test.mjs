import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateDeployedProvenance } from './check-deployed-provenance.mjs';

const SHA_A = '84a03fe3e6b6fb960891a28cb79ff5690dbcab9f';
const SHA_B = '137da5527ac0a227bb3b72e1aaede3033ba0f846';
const SHA_C = '638e5a1f6a310fb519c17b8e5aa08f0dea6101cd';
const SHA_D = 'e31f383aa119ac97ed87caffd11081b0fa4bb46a';

const codes = (result) => result.findings.map((f) => `${f.severity}:${f.code}`);

test('passes when label, container env and /health all agree', () => {
  const result = evaluateDeployedProvenance({
    labelRevision: SHA_A,
    envRevision: SHA_A,
    healthRevision: SHA_A,
    healthImageTag: 'vps7-github-84a03fe',
    revisionVerified: 'true',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.findings, []);
});

test('passes when nothing shadows the image and env is simply absent', () => {
  const result = evaluateDeployedProvenance({
    labelRevision: SHA_A,
    envRevision: undefined,
    healthRevision: SHA_A,
    revisionVerified: 'true',
  });
  assert.equal(result.ok, true);
});

/** The T2 (gwakga) case as observed on 2026-08-09, before #1772. */
test('fails when /health reports a revision the image was not built from (T2 shape)', () => {
  const result = evaluateDeployedProvenance({
    labelRevision: '76d143333c11cb96834fd1358af21da3ba98c681',
    envRevision: SHA_B,
    healthRevision: SHA_B,
    healthImageTag: 'vps7-github-137da55',
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('error:health_label_mismatch'));
  assert.ok(codes(result).includes('error:env_shadows_image'));
  const mismatch = result.findings.find((f) => f.code === 'health_label_mismatch');
  assert.match(mismatch.message, /advertising a commit its image was not built from/);
});

/** The T1 (seoseo, production) case: label, reported revision and tag all differ. */
test('fails on a three-way disagreement (T1 shape)', () => {
  const result = evaluateDeployedProvenance({
    labelRevision: SHA_C,
    envRevision: SHA_D,
    healthRevision: SHA_D,
    healthImageTag: 'github-03eba97a80c8',
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('error:health_label_mismatch'));
  assert.ok(codes(result).includes('warning:image_tag_mismatch'));
});

/**
 * After the #1772 code fix the broker ignores the stale env, so /health is
 * correct — but the stale line is still sitting in the deployment .env and
 * will mislead anyone reading it. Warn, do not fail.
 */
test('warns (does not fail) when a stale env is present but correctly ignored', () => {
  const result = evaluateDeployedProvenance({
    labelRevision: SHA_A,
    envRevision: SHA_B,
    healthRevision: SHA_A,
    revisionVerified: 'true',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(codes(result), ['warning:env_shadows_image']);
  assert.match(result.findings[0].message, /ignored by the broker since #1772/);
});

test('an unreadable /health is a gap, never treated as agreement', () => {
  const result = evaluateDeployedProvenance({ labelRevision: SHA_A, envRevision: SHA_A, healthRevision: undefined });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('error:health_unreadable'));
});

test('a missing image label fails closed', () => {
  const result = evaluateDeployedProvenance({ labelRevision: undefined, healthRevision: SHA_A });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('error:label_missing'));
});

test('flags an image built without the #1766 preflight', () => {
  const result = evaluateDeployedProvenance({
    labelRevision: SHA_A,
    envRevision: SHA_A,
    healthRevision: SHA_A,
    revisionVerified: 'false',
  });
  assert.equal(result.ok, true, 'unverified is a warning, not a hard failure');
  assert.deepEqual(codes(result), ['warning:unverified_build']);
});

test('does not flag an image tag that embeds the correct short sha', () => {
  const result = evaluateDeployedProvenance({
    labelRevision: SHA_A,
    envRevision: SHA_A,
    healthRevision: SHA_A,
    healthImageTag: 'vps7-github-84a03fe',
    revisionVerified: 'true',
  });
  assert.deepEqual(result.findings, []);
});

test('does not flag a tag with no embedded sha', () => {
  const result = evaluateDeployedProvenance({
    labelRevision: SHA_A,
    envRevision: SHA_A,
    healthRevision: SHA_A,
    healthImageTag: 'latest',
    revisionVerified: 'true',
  });
  assert.deepEqual(result.findings, []);
});
