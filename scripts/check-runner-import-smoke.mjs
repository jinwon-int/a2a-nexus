import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const runnerDir = path.join(root, 'packages/docker-runner');
const manifestPath = path.join(runnerDir, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const failures = [];
function expect(condition, message) {
  if (!condition) failures.push(message);
}

expect(fs.existsSync(runnerDir), 'missing packages/docker-runner import path');
expect(fs.existsSync(manifestPath), 'missing packages/docker-runner/package.json');

if (fs.existsSync(manifestPath)) {
  const manifest = readJson(manifestPath);
  expect(manifest.name === '@openclaw/a2a-docker-runner', 'docker runner package name must stay @openclaw/a2a-docker-runner');
  expect(manifest.private === true, 'docker runner package must remain private until explicit package-publication approval');
  expect(manifest.bin?.['a2a-docker-runner'] === './dist/cli.js', 'docker runner bin must point to ./dist/cli.js');
  expect(manifest.type === 'module', 'docker runner package must stay ESM');
  expect(manifest.engines?.node === '>=22.5', 'docker runner package must require Node >=22.5');
  for (const script of ['build', 'check', 'test', 'lint']) {
    expect(Boolean(manifest.scripts?.[script]), `docker runner package missing ${script} script`);
  }
}

if (fs.existsSync(lockPath)) {
  const lock = readJson(lockPath);
  expect(Boolean(lock.packages?.['packages/docker-runner']), 'root package-lock missing packages/docker-runner workspace entry');
  expect(lock.packages?.['packages/docker-runner']?.name === '@openclaw/a2a-docker-runner', 'root package-lock runner entry has unexpected package name');
}

for (const docPath of ['README.md', 'contracts/compatibility/matrix.md']) {
  const text = fs.readFileSync(path.join(root, docPath), 'utf8');
  expect(text.includes('packages/docker-runner'), `${docPath} must document the current runner workspace path`);
  expect(text.includes('@openclaw/a2a-docker-runner') || text.includes('a2a-docker-runner'), `${docPath} must document the runner package identity`);
}

if (failures.length) {
  console.error(`runner import smoke failed:\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('runner import smoke ok: packages/docker-runner -> @openclaw/a2a-docker-runner');
