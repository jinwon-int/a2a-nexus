import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateChangelogReleaseDrift,
  extractUnreleasedBody,
  hasReleasedSection,
} from './check-changelog-release-drift.mjs';

const ARMED = { latestRelease: { version: 'v0.1.0-alpha', date: '2026-07-05' }, enforcement: { armed: true } };
const UNARMED = { latestRelease: { version: 'v0.1.0-alpha', date: '2026-07-05' }, enforcement: { armed: false } };

const EMPTY_UNRELEASED = [
  '# Changelog',
  '',
  '## Unreleased',
  '',
  'No unreleased changes yet.',
  '',
  '## v0.1.0-alpha — 2026-07-05',
  '',
  '### Added — something (#1)',
].join('\n');

const POPULATED_UNRELEASED = [
  '# Changelog',
  '',
  '## Unreleased',
  '',
  '### Added — broker sub-agent fanout (#1537)',
  '',
  '## v0.1.0-alpha — 2026-07-05',
  '',
  '### Added — something (#1)',
].join('\n');

test('RED: armed + empty placeholder Unreleased beneath a released section fails', () => {
  const failures = evaluateChangelogReleaseDrift(EMPTY_UNRELEASED, ARMED);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /"## Unreleased" is an empty placeholder/);
  assert.match(failures[0], /since v0\.1\.0-alpha/);
});

test('GREEN: unarmed enforcement passes even with an empty placeholder', () => {
  assert.deepEqual(evaluateChangelogReleaseDrift(EMPTY_UNRELEASED, UNARMED), []);
});

test('GREEN: armed + populated Unreleased passes', () => {
  assert.deepEqual(evaluateChangelogReleaseDrift(POPULATED_UNRELEASED, ARMED), []);
});

test('GREEN: armed + empty Unreleased but NOTHING released yet passes (no drift baseline)', () => {
  const preRelease = ['# Changelog', '', '## Unreleased', '', 'No unreleased changes yet.'].join('\n');
  assert.deepEqual(evaluateChangelogReleaseDrift(preRelease, ARMED), []);
});

test('edge: missing inputs are reported, not thrown', () => {
  assert.deepEqual(evaluateChangelogReleaseDrift(null, ARMED), ['missing CHANGELOG.md']);
  assert.deepEqual(evaluateChangelogReleaseDrift(EMPTY_UNRELEASED, null), ['missing docs/ops/release-state-snapshot.json']);
});

test('edge: armed + no Unreleased section at all fails', () => {
  const noSection = ['# Changelog', '', '## v0.1.0-alpha — 2026-07-05', '', '### Added (#1)'].join('\n');
  const failures = evaluateChangelogReleaseDrift(noSection, ARMED);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no "## Unreleased" section found/);
});

test('extractUnreleasedBody strips placeholders and blank lines', () => {
  assert.deepEqual(extractUnreleasedBody(EMPTY_UNRELEASED), { found: true, bodyLines: [] });
  const { found, bodyLines } = extractUnreleasedBody(POPULATED_UNRELEASED);
  assert.equal(found, true);
  assert.deepEqual(bodyLines, ['### Added — broker sub-agent fanout (#1537)']);
});

test('extractUnreleasedBody stops at the next section heading', () => {
  const { bodyLines } = extractUnreleasedBody(
    ['## Unreleased', '- keep this', '## v1.0.0 — 2026-01-01', '- not this'].join('\n'),
  );
  assert.deepEqual(bodyLines, ['- keep this']);
});

test('hasReleasedSection detects a versioned heading', () => {
  assert.equal(hasReleasedSection(EMPTY_UNRELEASED), true);
  assert.equal(hasReleasedSection('## Unreleased\n\nNo unreleased changes yet.'), false);
});
