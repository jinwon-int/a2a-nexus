import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLAIM_ENV,
  OPT_OUT_ENV,
  evaluateBuildRevision,
  formatReport,
  isOptOutEnabled,
  normalizeRevision,
  readGitContext,
  revisionsMatch,
  runPreflight,
  utcTimestamp,
} from './check-build-revision.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, 'check-build-revision.mjs');

const HEAD = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const STALE = '137da5527ac0a227bb3b72e1aaede3033ba0f846';

function gitContext(overrides = {}) {
  return { gitAvailable: true, head: HEAD, dirty: false, dirtyPaths: [], ...overrides };
}

function runCli(env = {}, argv = []) {
  return spawnSync(process.execPath, [SCRIPT, ...argv], {
    encoding: 'utf8',
    // A pristine env: the harness itself may have A2A_BROKER_* exported.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
}

describe('revision comparison primitives', () => {
  it('normalizes case and surrounding whitespace', () => {
    assert.equal(normalizeRevision(`  ${HEAD.toUpperCase()}\n`), HEAD);
    assert.equal(normalizeRevision(undefined), '');
  });

  it('accepts an abbreviated claim that prefixes HEAD', () => {
    assert.equal(revisionsMatch(HEAD.slice(0, 7), HEAD), true);
    assert.equal(revisionsMatch(HEAD.slice(0, 12), HEAD), true);
    assert.equal(revisionsMatch(HEAD, HEAD), true);
  });

  it('rejects abbreviations too short to be unambiguous and non-prefixes', () => {
    assert.equal(revisionsMatch(HEAD.slice(0, 6), HEAD), false);
    assert.equal(revisionsMatch(STALE, HEAD), false);
    assert.equal(revisionsMatch('', HEAD), false);
  });
});

describe('evaluateBuildRevision decision table', () => {
  it('passes when the claimed revision matches HEAD on a clean tree', () => {
    const result = evaluateBuildRevision({ claimed: HEAD, ...gitContext() });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'verified');
    assert.equal(result.verified, true);
    assert.equal(result.revision, HEAD);
  });

  it('fails closed when the claimed revision is a stale export', () => {
    const result = evaluateBuildRevision({ claimed: STALE, ...gitContext() });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'mismatch');
    assert.equal(result.verified, false);
    assert.match(result.reason, /does not match git HEAD/);
    assert.match(result.reason, new RegExp(HEAD));
  });

  it('fails closed when a clean SHA is claimed from a dirty tree', () => {
    const result = evaluateBuildRevision({
      claimed: HEAD,
      ...gitContext({ dirty: true, dirtyPaths: ['packages/broker/src/server.ts'] }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'dirty');
    assert.match(result.reason, /dirty tree cannot honestly claim a clean SHA/);
    assert.match(result.reason, /packages\/broker\/src\/server\.ts/);
  });

  it('fails closed when the claim is not a git SHA at all', () => {
    for (const claimed of ['unknown', 'v1.2.3', 'main', 'not-a-sha']) {
      const result = evaluateBuildRevision({ claimed, ...gitContext() });
      assert.equal(result.ok, false, `expected ${claimed} to fail`);
      assert.equal(result.status, 'malformed');
    }
  });

  it('derives a verified revision from a clean tree when no claim is made', () => {
    const result = evaluateBuildRevision({ claimed: '', ...gitContext() });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'derived');
    assert.equal(result.verified, true);
    assert.equal(result.revision, HEAD);
  });

  it('warns instead of failing for an unclaimed dirty build, and marks it -dirty', () => {
    const result = evaluateBuildRevision({
      claimed: undefined,
      ...gitContext({ dirty: true, dirtyPaths: ['README.md'] }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'dirty-unclaimed');
    assert.equal(result.verified, false);
    assert.equal(result.revision, `${HEAD}-dirty`);
  });

  it('truncates long dirty path lists rather than dumping the tree', () => {
    const dirtyPaths = Array.from({ length: 9 }, (_, i) => `file-${i}.ts`);
    const result = evaluateBuildRevision({ claimed: HEAD, ...gitContext({ dirty: true, dirtyPaths }) });
    assert.match(result.reason, /file-4\.ts, \+4 more/);
    assert.doesNotMatch(result.reason, /file-5\.ts/);
  });
});

describe('no git context degrades to a documented warning', () => {
  it('reports unverifiable and exits ok when git is unavailable', () => {
    const result = evaluateBuildRevision({
      claimed: STALE,
      ...gitContext({ gitAvailable: false, head: '' }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'unverifiable');
    assert.equal(result.verified, false);
    assert.equal(result.revision, STALE);
    assert.match(result.reason, /no git context/);
  });

  it('treats an empty HEAD as no git context even if the flag says otherwise', () => {
    const result = evaluateBuildRevision({ claimed: '', head: '', gitAvailable: true });
    assert.equal(result.status, 'unverifiable');
  });

  it('readGitContext returns gitAvailable:false when git throws', () => {
    const context = readGitContext({
      exec: () => {
        throw new Error('not a git repository');
      },
    });
    assert.deepEqual(context, { gitAvailable: false, head: '', dirty: false, dirtyPaths: [] });
  });

  it('readGitContext treats an unreadable status as dirty, never as clean', () => {
    const context = readGitContext({
      exec: (_cmd, argv) => {
        if (argv[0] === 'rev-parse') return `${HEAD}\n`;
        throw new Error('status failed');
      },
    });
    assert.equal(context.gitAvailable, true);
    assert.equal(context.head, HEAD);
    assert.equal(context.dirty, true);
  });

  it('readGitContext parses porcelain status into changed paths', () => {
    const context = readGitContext({
      exec: (_cmd, argv) => {
        if (argv[0] === 'rev-parse') return `${HEAD}\n`;
        return ' M packages/broker/src/server.ts\n?? scratch.txt\n';
      },
    });
    assert.equal(context.dirty, true);
    assert.deepEqual(context.dirtyPaths, ['packages/broker/src/server.ts', 'scratch.txt']);
  });
});

describe('explicit dev opt-out', () => {
  it('recognizes 1/true/yes and nothing else', () => {
    assert.equal(isOptOutEnabled({ [OPT_OUT_ENV]: '1' }), true);
    assert.equal(isOptOutEnabled({ [OPT_OUT_ENV]: 'true' }), true);
    assert.equal(isOptOutEnabled({ [OPT_OUT_ENV]: 'YES' }), true);
    assert.equal(isOptOutEnabled({ [OPT_OUT_ENV]: '0' }), false);
    assert.equal(isOptOutEnabled({}), false);
  });

  it('converts a failure into a non-fatal override that keeps verified=false', () => {
    const result = evaluateBuildRevision({ claimed: STALE, ...gitContext(), allowUnverified: true });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'override');
    assert.equal(result.verified, false);
    assert.equal(result.suppressed.status, 'mismatch');
  });

  it('does not downgrade a genuinely verified build', () => {
    const result = evaluateBuildRevision({ claimed: HEAD, ...gitContext(), allowUnverified: true });
    assert.equal(result.status, 'verified');
    assert.equal(result.verified, true);
  });

  it('renders a loud, unmissable banner naming the suppressed failure', () => {
    const result = evaluateBuildRevision({ claimed: STALE, ...gitContext(), allowUnverified: true });
    const report = formatReport(result);
    assert.match(report, /={20,}/);
    assert.match(report, /BUILD REVISION PREFLIGHT OVERRIDDEN/);
    assert.match(report, new RegExp(OPT_OUT_ENV));
    assert.match(report, /provenance is NOT verified/);
    assert.match(report, /Do not ship it to production/);
    assert.match(report, /issues\/1766/);
    assert.match(report, /mismatch/);
  });

  it('renders an actionable banner on failure, including the opt-out escape hatch', () => {
    const report = formatReport(evaluateBuildRevision({ claimed: STALE, ...gitContext() }));
    assert.match(report, /BUILD REVISION PREFLIGHT FAILED/);
    assert.match(report, new RegExp(`${OPT_OUT_ENV}=1`));
    assert.match(report, /git rev-parse HEAD/);
  });
});

describe('runPreflight wiring', () => {
  it('reads the claim from the environment', () => {
    const result = runPreflight({ env: { [CLAIM_ENV]: STALE }, git: gitContext() });
    assert.equal(result.status, 'mismatch');
  });

  it('honours the opt-out from the environment', () => {
    const result = runPreflight({
      env: { [CLAIM_ENV]: STALE, [OPT_OUT_ENV]: '1' },
      git: gitContext(),
    });
    assert.equal(result.status, 'override');
  });
});

describe('CLI exit codes against the real repository', () => {
  it('exits 0 with no claim (the CI / ordinary-build path)', () => {
    const run = runCli({}, ['--quiet']);
    assert.equal(run.status, 0, run.stderr);
  });

  it('exits 1 for a stale claim, printing the failure banner on stderr', () => {
    const run = runCli({ [CLAIM_ENV]: STALE });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /BUILD REVISION PREFLIGHT FAILED/);
  });

  it('exits 0 for a stale claim under the loud opt-out', () => {
    const run = runCli({ [CLAIM_ENV]: STALE, [OPT_OUT_ENV]: '1' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /BUILD REVISION PREFLIGHT OVERRIDDEN/);
  });

  it('exits 1 for a malformed claim', () => {
    const run = runCli({ [CLAIM_ENV]: 'unknown' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /malformed/);
  });

  it('emits a machine-readable verdict with --json', () => {
    const run = runCli({ [CLAIM_ENV]: STALE }, ['--json']);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.status, 'mismatch');
    assert.equal(payload.ok, false);
  });

  it('rejects unknown arguments instead of silently passing', () => {
    const run = runCli({}, ['--yolo']);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /unknown argument/);
  });
});

describe('generate-build-info applies the same evaluator (#1766 decision: fail, not warn, when git can prove the claim wrong)', () => {
  const GENERATOR = resolve(HERE, 'generate-build-info.mjs');

  function runGenerator(env, out) {
    return spawnSync(process.execPath, [GENERATOR, '--out', out], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    });
  }

  it('refuses to write build-info for a stale claim while git is available', (t) => {
    const out = resolve(t.tmpdir ?? '/tmp', `build-info-${process.pid}-fail.json`);
    const run = runGenerator({ [CLAIM_ENV]: STALE }, out);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /BUILD REVISION PREFLIGHT FAILED/);
    assert.doesNotMatch(run.stdout + run.stderr, /Generated .*build-info.*fail\.json/);
  });

  it('still lets an explicit claim win once the loud opt-out is set', (t) => {
    const out = resolve(t.tmpdir ?? '/tmp', `build-info-${process.pid}-override.json`);
    const run = runGenerator({ [CLAIM_ENV]: STALE, [OPT_OUT_ENV]: '1' }, out);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stderr, /BUILD REVISION PREFLIGHT OVERRIDDEN/);
    assert.match(run.stderr, new RegExp(`revision: ${STALE}`));
  });
});

describe('build timestamp helper', () => {
  it('emits second-precision RFC3339 UTC, matching the compose docs', () => {
    assert.equal(utcTimestamp(new Date('2026-08-08T12:34:56.789Z')), '2026-08-08T12:34:56Z');
  });
});
