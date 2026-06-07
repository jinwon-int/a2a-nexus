#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const get = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
};

const version = get('--version') || '0.1.0';
const output = get('--output');
const dryRun = args.includes('--dry-run');

if (!dryRun) {
  console.error('tag-release-candidate is disabled in monorepo package CI without --dry-run');
  process.exit(2);
}

const evidence = {
  ok: true,
  dryRun: true,
  version,
  actions: {
    tagCreated: false,
    releaseCreated: false,
    npmPublished: false,
    dockerPublished: false,
    deployed: false,
    providerSend: false,
    terminalAckReplay: false,
    credentialMovement: false,
  },
};

const text = `${JSON.stringify(evidence, null, 2)}\n`;
if (output) {
  fs.mkdirSync(path.dirname(path.resolve(process.cwd(), output)), { recursive: true });
  fs.writeFileSync(output, text);
}
process.stdout.write(text);
