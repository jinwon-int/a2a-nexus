#!/usr/bin/env node
/**
 * Source-only package CI parity runner for a2a-plane#536.
 *
 * This runs package-local checks that mirror or exceed the split-repo CI
 * command surface. It never refreshes package mirrors, imports history,
 * publishes artifacts, deploys services, sends provider traffic, mutates DBs,
 * replays Terminal ACKs, or moves credentials.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const surface = process.argv[2];
const tmpDir = path.join(root, 'tmp', 'monorepo-package-ci-parity');

export const PACKAGE_CI_SURFACES = {
  broker: {
    packageDir: 'packages/broker',
    commands: [
      ['npm', ['run', 'check:source-quality-floors']],
      ['npm', ['test', '-w', 'packages/broker']],
      ['npm', ['run', 'coverage:baseline', '-w', 'packages/broker']],
    ],
    metadata: {
      private: true,
      requiredScripts: ['build', 'check', 'test', 'scan:public-readiness', 'coverage:baseline'],
      requiredFiles: [
        'scripts/generate-build-info.mjs',
        'scripts/team1-dispatch-wrapper.mjs',
        'scripts/a2a-dispatch-helper.mjs',
        'scripts/cross-broker-terminal-brief-receiver.mjs',
        'scripts/coverage-baseline-report.mjs',
      ],
    },
  },
  'docker-runner': {
    packageDir: 'packages/docker-runner',
    commands: [
      ['npm', ['run', 'check:source-quality-floors']],
      ['npm', ['run', 'check', '-w', 'packages/docker-runner']],
      ['npm', ['run', 'build', '-w', 'packages/docker-runner']],
      ['npm', ['run', 'lint', '-w', 'packages/docker-runner']],
      ['npm', ['test', '-w', 'packages/docker-runner']],
      ['node', ['packages/docker-runner/scripts/pre-pr-bootstrap-guard.mjs', '--repo-dir', 'packages/docker-runner']],
      ['npm', ['run', 'chaos:e2e', '-w', 'packages/docker-runner']],
      ['npm', ['run', 'coverage:baseline', '-w', 'packages/docker-runner']],
      ['sh', ['-lc', 'cd packages/docker-runner && node scripts/release-candidate-parity-audit.mjs']],
    ],
    metadata: {
      private: true,
      license: 'MIT',
      requiredScripts: ['build', 'check', 'lint', 'test', 'chaos:e2e', 'coverage:baseline'],
      requiredFiles: [
        'scripts/pre-pr-bootstrap-guard.mjs',
        'scripts/release-candidate-parity-audit.mjs',
        'scripts/coverage-baseline-report.mjs',
      ],
      requiredBin: ['a2a-docker-runner'],
    },
  },
  'attestation': {
    packageDir: 'packages/attestation',
    commands: [
      ['npm', ['run', 'check:source-quality-floors']],
      ['npm', ['run', 'check', '-w', 'packages/attestation']],
      ['npm', ['run', 'build', '-w', 'packages/attestation']],
      ['npm', ['test', '-w', 'packages/attestation']],
      ['npm', ['run', 'coverage:baseline', '-w', 'packages/attestation']],
    ],
    metadata: {
      private: true,
      license: 'MIT',
      requiredScripts: ['build', 'check', 'test', 'coverage:baseline'],
      requiredFiles: ['README.md', 'scripts/coverage-baseline-report.mjs'],
    },
  },
  'policy-referee': {
    packageDir: 'packages/policy-referee',
    commands: [
      ['npm', ['run', 'check:source-quality-floors']],
      ['npm', ['run', 'check', '-w', 'packages/policy-referee']],
      ['npm', ['run', 'build', '-w', 'packages/policy-referee']],
      ['npm', ['test', '-w', 'packages/policy-referee']],
      ['npm', ['run', 'coverage:baseline', '-w', 'packages/policy-referee']],
    ],
    metadata: {
      private: true,
      license: 'MIT',
      requiredScripts: ['build', 'check', 'test', 'coverage:baseline'],
      requiredFiles: ['README.md', 'scripts/coverage-baseline-report.mjs'],
    },
  },
  'openclaw-plugin-a2a': {
    packageDir: 'packages/openclaw-plugin-a2a',
    commands: [
      ['npm', ['run', 'check:source-quality-floors']],
      ['npm', ['run', 'scan:public-readiness', '-w', 'packages/openclaw-plugin-a2a']],
      ['npm', ['run', 'smoke:a2a-conformance', '-w', 'packages/openclaw-plugin-a2a']],
      ['npm', ['test', '-w', 'packages/openclaw-plugin-a2a']],
      ['npm', ['run', 'coverage:baseline', '-w', 'packages/openclaw-plugin-a2a']],
      ['npm', ['run', 'prepack', '-w', 'packages/openclaw-plugin-a2a']],
    ],
    metadata: {
      private: true,
      peerDependencies: ['openclaw'],
      requiredScripts: ['build', 'check', 'test', 'prepack', 'scan:public-readiness', 'smoke:a2a-conformance', 'coverage:baseline'],
      requiredFiles: ['scripts/scan-public-readiness.sh', 'scripts/smoke-a2a-conformance.sh', 'openclaw.plugin.json', 'scripts/coverage-baseline-report.mjs'],
      requiredExports: ['./openclaw.plugin.json', './package.json'],
    },
  },
};

function fail(message) {
  console.error(`package CI parity failed: ${message}`);
  process.exit(1);
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function assertPackageMetadata(config) {
  const manifestPath = path.join(config.packageDir, 'package.json');
  const manifest = readJson(manifestPath);
  const meta = config.metadata;

  if (meta.private !== undefined && manifest.private !== meta.private) {
    fail(`${manifestPath}: expected private=${meta.private}`);
  }
  if (meta.license && manifest.license !== meta.license) {
    fail(`${manifestPath}: expected license ${meta.license}`);
  }
  for (const script of meta.requiredScripts || []) {
    if (!manifest.scripts?.[script]) fail(`${manifestPath}: missing script ${script}`);
  }
  for (const file of meta.requiredFiles || []) {
    if (!fs.existsSync(path.join(root, config.packageDir, file))) {
      fail(`${config.packageDir}: missing ${file}`);
    }
  }
  for (const name of meta.requiredBin || []) {
    if (!manifest.bin?.[name]) fail(`${manifestPath}: missing bin ${name}`);
  }
  for (const name of meta.peerDependencies || []) {
    if (!manifest.peerDependencies?.[name]) fail(`${manifestPath}: missing peer dependency ${name}`);
  }
  for (const exportPath of meta.requiredExports || []) {
    if (!manifest.exports?.[exportPath]) fail(`${manifestPath}: missing export ${exportPath}`);
  }
}

function main() {
  if (!surface || !PACKAGE_CI_SURFACES[surface]) {
    fail(`usage: node scripts/run-monorepo-package-ci-parity.mjs <${Object.keys(PACKAGE_CI_SURFACES).join('|')}>`);
  }

  fs.mkdirSync(tmpDir, { recursive: true });

  const config = PACKAGE_CI_SURFACES[surface];
  assertPackageMetadata(config);
  for (const [command, args] of config.commands) run(command, args);
  run('npm', ['pack', '--workspace', config.packageDir, '--dry-run', '--json']);

  console.log(`monorepo package CI parity ok: ${surface}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
