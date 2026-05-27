import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const script = path.join(root, 'scripts/check-compatibility-baselines.mjs');

function runWithMatrix(matrix) {
  const dir = mkdtempSync(path.join(tmpdir(), 'a2a-compat-'));
  cpSync(path.join(root, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  cpSync(path.join(root, 'contracts'), path.join(dir, 'contracts'), { recursive: true });
  writeFileSync(path.join(dir, 'contracts/compatibility/matrix.md'), matrix);
  return spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
}

const validMatrix = `# Compatibility Matrix

The \`source-public-20260511\` markers are source
review markers only.

| Repository | Public source role | Current \`main\` baseline | CI evidence | \`source-public-20260511\` marker | Promotion status |
|---|---|---|---|---|---|
| [\`a2a-plane\`](https://github.com/jinwon-int/a2a-plane) | Umbrella | \`5b4f7f1e0616fba2810144e9a4ab7bbab4f1d488\` | CI succeeded. | \`83bc1519ebc4b45d9c1ddc4be2a9011fb4b210b4\` | NO-GO / waiting. |
| [\`a2a-broker\`](https://github.com/jinwon-int/a2a-broker) | Broker | \`2609c8ddab8948512aa688f057f5c5267512ba1e\` | CI succeeded. | \`929a1a8eeb2d242115589b8d701a4e097ff7598d\` | NO-GO / waiting. |
| [\`openclaw-plugin-a2a\`](https://github.com/jinwon-int/openclaw-plugin-a2a) | Plugin | \`345a2dda01291865dbce6c1d9b89371dc688bfd6\` | CI succeeded. | \`b474c63f76abc63986f6e49054b39726cead44e9\` | NO-GO / waiting. |
| [\`a2a-docker-runner\`](https://github.com/jinwon-int/a2a-docker-runner) | Runner | \`70c8ad078fd9dd4da346189cd4c8cfad480e71cb\` | CI succeeded. | \`f17072e5c2c40cf5d0ba7fc277ccd76e4d856a31\` | NO-GO / waiting. |

| Component | Source | Candidate path | Current baseline | Required evidence before public release | Notes |
|---|---|---|---|---|---|
| Broker | \`repo\` | \`packages/broker\` | \`a6096882a781fb13c68ec526fee897a00724f9a0\` | package build/test | Imported by sanitized/squash copy. |
| OpenClaw plugin | \`repo\` | \`packages/openclaw-plugin-a2a\` | \`3c12b937f727a874174b172cf34de65d771177f2\` | package build/test | Fixture peer baseline. |
| Docker runner | \`repo\` | \`packages/docker-runner\` | \`d223612cb027bf493b6b74e60a7bc04db1b9b6ae\` | package build/test | Trusted operator mode. |
| Shared contracts | monorepo | \`contracts/a2a\` | \`r2-initial-contracts\` | contract review | Public contract candidate. |
| OpenClaw core | upstream fixture | external | \`0.0.0-test-peer\` | plugin SDK seam evidence | Fixture only. |

## Release rule

A public release candidate must update this table with exact source commits/tags for every imported package and link the CI run that validated the candidate commit.
`;

test('accepts exact compatibility baselines', () => {
  const result = runWithMatrix(validMatrix);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"ok":true/);
});

test('fails closed on pending compatibility baselines', () => {
  const result = runWithMatrix(validMatrix.replace('`0.0.0-test-peer`', 'pending decision'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /OpenClaw core|pending/i);
});

test('fails closed on non-SHA imported package baselines', () => {
  const result = runWithMatrix(validMatrix.replace('`a6096882a781fb13c68ec526fee897a00724f9a0`', '`main`'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Broker/);
});

test('fails closed on missing split-repo source-public marker', () => {
  const result = runWithMatrix(validMatrix.replace('`929a1a8eeb2d242115589b8d701a4e097ff7598d`', 'source marker omitted'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /a2a-broker/);
});
