import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchor to the repo root (this script lives in scripts/) so the layout check is
// correct regardless of the caller's cwd; a bare cwd-relative existsSync falsely
// reported every path missing when run from a subdirectory (BUG-24).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'packages/broker',
  'packages/docker-runner',
  'contracts/a2a',
  'contracts/compatibility',
  'docs',
  'examples',
  'tsconfig.base.json',
];
const missing = required.filter((p) => !fs.existsSync(path.join(repoRoot, p)));
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
