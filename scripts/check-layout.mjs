import fs from 'node:fs';
import path from 'node:path';

const required = [
  'packages/broker',
  'packages/docker-runner',
  'contracts/a2a',
  'contracts/compatibility',
  'docs',
  'examples',
  'tsconfig.base.json',
];
const missing = required.filter((p) => !fs.existsSync(p));
if (missing.length) {
  console.error(`Missing required paths: ${missing.join(', ')}`);
  process.exit(1);
}

const defaultOnCore = 'packages/broker/src/core';
const defaultOnTopLevel = fs
  .readdirSync(defaultOnCore)
  .filter((entry) => /^terminal-brief-sidecar-default-on-.*\.ts$/.test(entry))
  .sort();
if (defaultOnTopLevel.length > 5) {
  console.error(
    `Terminal-brief default-on top-level module count regressed: ${defaultOnTopLevel.length}/5. ` +
      'Keep stage implementations under packages/broker/src/core/terminal-brief-sidecar-default-on/.',
  );
  process.exit(1);
}
const defaultOnBridge = path.join(defaultOnCore, 'terminal-brief-sidecar-default-on/index.ts');
if (!fs.existsSync(defaultOnBridge)) {
  console.error(`Missing terminal-brief default-on bridge: ${defaultOnBridge}`);
  process.exit(1);
}

console.log(
  `layout ok: ${required.length} paths; default-on top-level ${defaultOnTopLevel.length}/5`,
);
