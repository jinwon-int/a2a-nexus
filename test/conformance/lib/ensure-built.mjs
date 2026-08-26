/**
 * Shared dist-build prerequisite helper for the conformance suite.
 *
 * The dist-dependent checks (check-trace-propagation.mjs,
 * check-three-component-e2e.mjs) verify behavior against compiled package
 * output. run-conformance.mjs builds every needed package once, sequentially,
 * BEFORE fanning the checks out, so the per-check ensureBuilt calls reduce to
 * existsSync probes that never spawn a build. Standalone invocation of a
 * single check still self-builds, but two concurrently spawned checks can no
 * longer race `npm run build -w` into the same dist on a cold cache.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Union of every dist entry the dist-dependent conformance checks import,
 * grouped by workspace package. One missing entry rebuilds its whole package,
 * so probing the union also repairs partially built dist trees.
 */
export const CONFORMANCE_DIST_PREREQS = [
  {
    pkg: 'broker',
    entries: [
      'packages/broker/dist/core/broker.js',
      'packages/broker/dist/a2a/task-projection.js',
      'packages/broker/dist/worker.js',
      'packages/broker/dist/server.js',
      'packages/broker/dist/core/store.js',
      'packages/broker/dist/client/broker-client.js',
    ],
  },
  {
    pkg: 'docker-runner',
    entries: ['packages/docker-runner/dist/runner.js'],
  },
];

/**
 * Build packages/<pkg> unless every listed dist entry already exists. With
 * quiet: true the build output is captured and only replayed to stderr on
 * failure (keeps --json runner output machine-readable on a cold cache).
 */
export function ensureBuilt(root, pkg, entries, { quiet = false } = {}) {
  if (entries.every((entry) => existsSync(path.join(root, entry)))) return;
  const res = spawnSync(
    'npm',
    ['run', 'build', '-w', `packages/${pkg}`],
    quiet ? { cwd: root, encoding: 'utf8' } : { cwd: root, stdio: 'inherit' },
  );
  if (res.status !== 0) {
    if (quiet) {
      if (res.stdout) process.stderr.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
    }
    throw new Error(`failed to build packages/${pkg} for the conformance suite`);
  }
}

/** Build every dist prerequisite once, sequentially — never concurrently. */
export function buildConformancePrereqs(root, options = {}) {
  for (const { pkg, entries } of CONFORMANCE_DIST_PREREQS) {
    ensureBuilt(root, pkg, entries, options);
  }
}
