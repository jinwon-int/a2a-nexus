#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const repoDir = args[args.indexOf('--repo-dir') + 1] || '.';
const root = path.resolve(process.cwd(), repoDir);
const forbidden = ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'HEARTBEAT.md', 'IDENTITY.md'];
const failures = [];

for (const name of forbidden) {
  if (fs.existsSync(path.join(root, name))) failures.push(name);
}
if (fs.existsSync(path.join(root, '.openclaw'))) failures.push('.openclaw/');

if (failures.length) {
  console.error(`pre-pr bootstrap guard failed: ${failures.join(', ')}`);
  process.exit(1);
}

console.log(`pre-pr bootstrap guard ok: ${path.relative(process.cwd(), root) || '.'}`);
