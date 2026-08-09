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

// The terminal-brief default-on layout checks retired with the ceremony they
// guarded (#1665): they capped the top-level default-on module count at five and
// required a terminal-brief-sidecar-default-on/index.ts barrel. Both modules and
// barrel are gone, so the checks had nothing left to constrain.

console.log(
  `layout ok: ${required.length} paths`,
);
