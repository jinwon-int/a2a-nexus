import fs from 'node:fs';
import path from 'node:path';

const required = [
  'packages/broker',
  'packages/openclaw-plugin-a2a',
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

const pluginRoot = 'packages/openclaw-plugin-a2a';
const allowedPluginRootTs = new Set([
  'api.ts',
  'config.ts',
  'index.ts',
  'plugin-id.ts',
  'standalone-broker-client.ts',
  'terminal-brief-hermes-mobileAlpha.ts',
  'terminal-brief-openclaw-message.ts',
  'terminal-brief-sidecar.ts',
  'type-mapping.ts',
  'plugin-id.test.ts',
  'standalone-broker-client.test.ts',
  'type-mapping.test.ts',
]);
const rootTs = fs
  .readdirSync(pluginRoot)
  .filter((entry) => entry.endsWith('.ts'))
  .sort();
const unexpectedRootTs = rootTs.filter((entry) => !allowedPluginRootTs.has(entry));
if (unexpectedRootTs.length > 0) {
  console.error(
    `Plugin root TypeScript layout regressed: ${unexpectedRootTs.map((entry) => path.join(pluginRoot, entry)).join(', ')}. ` +
      'Move new source to src/ and tests to tests/ or update the explicit migration allowlist with justification.',
  );
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
  `layout ok: ${required.length} paths; plugin root ts allowlist ${rootTs.length}/${allowedPluginRootTs.size}; ` +
    `default-on top-level ${defaultOnTopLevel.length}/5`,
);
