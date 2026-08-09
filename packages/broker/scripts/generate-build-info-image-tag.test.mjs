import test from 'node:test';
import assert from 'node:assert/strict';

import { getImageTag, shortRevision } from './generate-build-info.mjs';

const SHA = '59cc0093a65c98859f6bf0d50ec656d143deb229';

test('shortRevision takes the leading 7 hex chars', () => {
  assert.equal(shortRevision(SHA), '59cc009');
  assert.equal(shortRevision('84A03FE3E6B6FB960891A28CB79FF5690DBCAB9F'), '84a03fe');
});

test('shortRevision preserves the -dirty marker', () => {
  assert.equal(shortRevision(`${SHA}-dirty`), '59cc009-dirty');
});

test('shortRevision refuses anything that is not a SHA', () => {
  for (const value of ['unknown', 'redacted', '', undefined, 'not-a-sha', 'abc123', 'v1.2.3']) {
    assert.equal(shortRevision(value), undefined, `expected no short form for ${JSON.stringify(value)}`);
  }
});

/** The two conventions actually in use on the fleet. */
test('getImageTag composes <prefix>-<short sha>, matching existing fleet tags', () => {
  assert.equal(getImageTag({ A2A_BROKER_IMAGE_TAG_PREFIX: 'vps7-github' }, {}, SHA), 'vps7-github-59cc009');
  assert.equal(getImageTag({ A2A_BROKER_IMAGE_TAG_PREFIX: 'github' }, {}, SHA), 'github-59cc009');
});

test('getImageTag falls back to the bare short revision when no prefix is configured', () => {
  assert.equal(getImageTag({}, {}, SHA), '59cc009');
  assert.equal(getImageTag({ A2A_BROKER_IMAGE_TAG_PREFIX: '   ' }, {}, SHA), '59cc009');
});

test('getImageTag prefers an explicit CLI prefix over the environment', () => {
  assert.equal(
    getImageTag({ A2A_BROKER_IMAGE_TAG_PREFIX: 'fromenv' }, { imageTagPrefix: 'fromcli' }, SHA),
    'fromcli-59cc009',
  );
});

/**
 * #1774's whole point: the sha half cannot be set by hand, so it cannot drift.
 * The T1 failure was `github-03eba97a80c8` on an image built from `638e5a1`.
 */
test('getImageTag derives the sha from the revision, so a stale tag is unrepresentable', () => {
  const built = '638e5a1f6a310fb519c17b8e5aa08f0dea6101cd';
  assert.equal(getImageTag({ A2A_BROKER_IMAGE_TAG_PREFIX: 'github' }, {}, built), 'github-638e5a1');
  // No input exists that would make it report the old 03eba97 tag.
  assert.doesNotMatch(getImageTag({ A2A_BROKER_IMAGE_TAG_PREFIX: 'github' }, {}, built), /03eba97/);
});

test('getImageTag invents no tag when the revision could not be established', () => {
  assert.equal(getImageTag({ A2A_BROKER_IMAGE_TAG_PREFIX: 'github' }, {}, 'unknown'), undefined);
  assert.equal(getImageTag({ A2A_BROKER_IMAGE_TAG_PREFIX: 'github' }, {}, 'redacted'), undefined);
});

test('getImageTag carries the -dirty marker into the tag', () => {
  assert.equal(getImageTag({ A2A_BROKER_IMAGE_TAG_PREFIX: 'vps7-github' }, {}, `${SHA}-dirty`), 'vps7-github-59cc009-dirty');
});

test('getImageTag accepts tag-legal prefixes', () => {
  for (const prefix of ['vps7-github', 'github', 'a', 'A.b_c-1', '0start']) {
    assert.equal(getImageTag({ A2A_BROKER_IMAGE_TAG_PREFIX: prefix }, {}, SHA), `${prefix}-59cc009`);
  }
});
