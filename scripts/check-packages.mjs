import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// --manifests-only validates package manifests without compiling: the always-on
// check job runs the full `npm -w <pkg> run check` surface (and the release-gate
// `packages` entry runs this script unflagged), so callers that run alongside
// that job — the ci.yml `layout` job — use this flag to avoid a second (cold,
// discarded) tsc compile of every package (#2085).
const manifestsOnly = process.argv.includes('--manifests-only');

const root = process.cwd();
const packageRoot = path.join(root, 'packages');
if (!fs.existsSync(packageRoot)) {
  console.log('package checks skipped: packages/ missing');
  process.exit(0);
}

const packages = fs
  .readdirSync(packageRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join('packages', entry.name))
  .filter((dir) => fs.existsSync(path.join(root, dir, 'package.json')))
  .sort();

if (!packages.length) {
  console.error('package checks failed: no package manifests found under packages/');
  process.exit(1);
}

const missingChecks = [];
const manifestFailures = [];
const runnable = [];
for (const dir of packages) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
  if (!manifest.scripts?.check) {
    missingChecks.push(dir);
  } else {
    runnable.push(dir);
  }

  if (manifest.private !== true) manifestFailures.push(`${dir}: private must be true until explicit package-publication approval`);
  if (!manifest.repository || typeof manifest.repository !== 'object') {
    manifestFailures.push(`${dir}: repository object is required`);
  } else {
    if (manifest.repository.type !== 'git') manifestFailures.push(`${dir}: repository.type must be git`);
    if (manifest.repository.url !== 'git+https://github.com/jinwon-int/a2a-nexus.git') manifestFailures.push(`${dir}: repository.url must point at a2a-nexus`);
    if (manifest.repository.directory !== dir) manifestFailures.push(`${dir}: repository.directory must be ${dir}`);
  }
  if (!manifest.homepage || typeof manifest.homepage !== 'string') manifestFailures.push(`${dir}: homepage is required`);
  if (!manifest.bugs || manifest.bugs.url !== 'https://github.com/jinwon-int/a2a-nexus/issues') manifestFailures.push(`${dir}: bugs.url must point at a2a-nexus issues`);

  // #2084 item 2: scripts must not shell out through `npx <pkg>` — that is an
  // unpinned, registry-dependent execution path outside the lockfile. The
  // former `npx tsx --test` scripts run their compiled dist tests instead.
  for (const [script, command] of Object.entries(manifest.scripts ?? {})) {
    if (typeof command === 'string' && command.split(/\s+/).includes('npx')) {
      manifestFailures.push(`${dir}: script "${script}" must not invoke npx (unpinned registry execution); run the lockfile-installed binary or a compiled dist test instead`);
    }
  }

  // #2084 item 4: runtime dependency allowlist. Runtime dependencies are
  // limited to zod plus in-repo workspace packages; anything new requires a
  // deliberate update to this gate (and usually a supply-chain review).
  const RUNTIME_DEPENDENCY_ALLOWLIST = new Set([
    'zod',
    'a2a-attestation',
    'a2a-nclex-evaluation',
    'a2a-policy-referee',
  ]);
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (!RUNTIME_DEPENDENCY_ALLOWLIST.has(name)) {
      manifestFailures.push(`${dir}: runtime dependency "${name}" is outside the allowlist (zod + in-repo workspaces); update check-packages.mjs deliberately (#2084)`);
    }
  }
}

if (manifestFailures.length) {
  console.error(`package checks failed:\n${manifestFailures.map((m) => `  - ${m}`).join('\n')}`);
  process.exit(1);
}

// Package checks are independent (each compiles into its own dist/), so run
// them concurrently to cut wall-clock time. Output is buffered per package and
// flushed in deterministic package order once all finish so logs stay readable.
function runCheck(dir) {
  return new Promise((resolve) => {
    const child = spawn('npm', ['--workspace', dir, 'run', 'check'], { cwd: root });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('error', (err) => resolve({ dir, status: 1, output: `${err.message}\n` }));
    child.on('close', (code) => resolve({ dir, status: code ?? 1, output: Buffer.concat(chunks).toString('utf8') }));
  });
}

const results = manifestsOnly
  ? []
  : await Promise.all(runnable.map(runCheck));

let failed = 0;
for (const { dir, status, output } of results) {
  console.log(`package check: ${dir}${status === 0 ? '' : ' (FAILED)'}`);
  if (output.length) process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  if (status !== 0) failed = status;
}

if (missingChecks.length) {
  console.error(`package checks failed: missing check script in ${missingChecks.join(', ')}`);
  process.exit(1);
}

if (failed !== 0) process.exit(failed);

console.log(
  `package checks ok: ${packages.length} packages${manifestsOnly ? ' (manifests-only)' : ''}`,
);
