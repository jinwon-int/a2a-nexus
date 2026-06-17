import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  commentIssue,
  createIssue,
  editIssue,
  withBodyFile,
} from './a2a-safe-body.mjs';
import { scanBodySafetyPaths } from './a2a-body-safety-scan.mjs';

const trickyMarkdown = [
  '# A2A body safety fixture',
  '',
  'Inline code: `literal $EDGE_SECRET`',
  '',
  '```bash',
  'echo "$EDGE_SECRET" | sed s/x/y/',
  '$(this-must-not-run)',
  '```',
  '',
  '| col | value |',
  '| --- | --- |',
  '| token-looking | $EDGE_SECRET |',
].join('\n');

test('withBodyFile writes literal Markdown bytes with 0600 mode and cleans up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-safe-body-test-'));
  let bodyPath;
  try {
    const result = await withBodyFile(trickyMarkdown, async (path) => {
      bodyPath = path;
      assert.equal(readFileSync(path, 'utf8'), trickyMarkdown);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      return 'ok';
    }, { dir });

    assert.equal(result, 'ok');
    assert.equal(existsSync(bodyPath), false, 'body file should be removed after callback');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gh wrappers pass body only through --body-file and clean up after spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-safe-body-gh-'));
  const calls = [];
  try {
    const spawnSyncImpl = (bin, args, options) => {
      calls.push({ bin, args, options });
      const bodyIndex = args.indexOf('--body-file');
      assert.notEqual(bodyIndex, -1, 'wrapper must use --body-file');
      const bodyPath = args[bodyIndex + 1];
      assert.equal(readFileSync(bodyPath, 'utf8'), trickyMarkdown);
      assert.equal(args.includes('--body'), false, 'wrapper must not use inline --body');
      assert.equal(args.includes(trickyMarkdown), false, 'body must not be present in argv');
      return { status: 0, stdout: 'https://github.example/comment\n', stderr: '' };
    };

    await createIssue({ repo: 'jinwon-int/a2a-nexus', title: 'title', body: trickyMarkdown }, { dir, spawnSyncImpl });
    await editIssue({ repo: 'jinwon-int/a2a-nexus', number: 870, body: trickyMarkdown }, { dir, spawnSyncImpl });
    await commentIssue({ repo: 'jinwon-int/a2a-nexus', number: 870, body: trickyMarkdown }, { dir, spawnSyncImpl });

    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => c.args.slice(0, 2)), [
      ['issue', 'create'],
      ['issue', 'edit'],
      ['issue', 'comment'],
    ]);
    for (const call of calls) {
      const bodyPath = call.args[call.args.indexOf('--body-file') + 1];
      assert.equal(existsSync(bodyPath), false, 'body file should be removed after gh call');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gh wrapper fails closed on gh non-zero and still removes body file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-safe-body-fail-'));
  let bodyPath;
  try {
    await assert.rejects(
      () => commentIssue({ repo: 'jinwon-int/a2a-nexus', number: 870, body: trickyMarkdown }, {
        dir,
        spawnSyncImpl: (_bin, args) => {
          bodyPath = args[args.indexOf('--body-file') + 1];
          assert.equal(existsSync(bodyPath), true);
          return { status: 2, stdout: '', stderr: 'gh failed' };
        },
      }),
      /gh issue comment failed/,
    );
    assert.equal(existsSync(bodyPath), false, 'body file should be removed even on gh failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('body safety scanner flags unquoted heredocs and inline gh --body, but accepts --body-file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a2a-body-scan-'));
  try {
    const bad = join(dir, 'bad.mjs');
    const good = join(dir, 'good.mjs');
    writeFileSync(bad, [
      'cat <<EOF',
      'gh issue comment 870 --body "`$EDGE_SECRET`"',
      'gh pr create --body "$BODY"',
    ].join('\n'));
    writeFileSync(good, 'gh issue comment 870 --body-file /tmp/body.md\n');

    const report = scanBodySafetyPaths([bad, good]);
    assert.equal(report.ok, false);
    assert.equal(report.violations.length, 3);
    assert.deepEqual(report.violations.map((v) => v.rule), [
      'unquoted-heredoc',
      'inline-gh-body',
      'inline-gh-body',
    ]);
    assert.equal(report.scannedFiles, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
