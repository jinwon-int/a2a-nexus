#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const distDir = path.join(root, 'dist');
fs.mkdirSync(distDir, { recursive: true });

function read(command) {
  try {
    return execSync(command, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const buildInfo = {
  package: 'a2a-broker',
  source: 'a2a-plane monorepo package CI',
  generatedAt: new Date().toISOString(),
  gitCommit: read('git rev-parse HEAD'),
};

fs.writeFileSync(path.join(distDir, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);
console.log('broker build-info generated');
