import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { check, isDeclared, undeclaredKoreanDocs } from './check-public-language.mjs';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'public-language-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, files: Object.keys(files) };
}

const KO = '운영 절차를 설명합니다.';

test('declarations near the top are recognised; late or absent ones are not', () => {
  assert.ok(isDeclared(`# Runbook\n\n> Language: Korean (operator runbook)\n\n${KO}`));
  assert.ok(isDeclared(`# Runbook\n언어: 한국어\n${KO}`));
  assert.ok(isDeclared(`# Guide\n> **한국어 / English terms** — ${KO}`));
  assert.ok(isDeclared('# Spec\n\nThis is a bilingual document.\n'));
  assert.equal(isDeclared(`# Runbook\n${KO}`), false);
  assert.equal(isDeclared(`${'\n'.repeat(12)}Language: Korean\n${KO}`), false);
});

test('only undeclared Korean docs outside history and fixtures count', () => {
  const { root, files } = fixture({
    'docs/en.md': '# English only\n',
    'docs/ko.md': `# Runbook\n${KO}\n`,
    'docs/ko-declared.md': `# Runbook\n> Language: Korean\n${KO}\n`,
    'docs/history/old.md': `# Record\n${KO}\n`,
    'fixtures/sample.md': `${KO}\n`,
    'packages/x/fixtures/case.md': `${KO}\n`,
    'notes.txt': `${KO}\n`,
  });
  try {
    assert.deepEqual(undeclaredKoreanDocs(root, files), ['docs/ko.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the ratchet fails above the baseline, passes at or below it, and rejects a bad baseline', () => {
  const { root, files } = fixture({ 'a.md': `${KO}\n`, 'b.md': `${KO}\n` });
  try {
    assert.equal(check({ root, files, baseline: { undeclaredKoreanDocs: 1 } }).ok, false);
    assert.equal(check({ root, files, baseline: { undeclaredKoreanDocs: 2 } }).ok, true);
    const lower = check({ root, files, baseline: { undeclaredKoreanDocs: 5 } });
    assert.equal(lower.ok, true);
    assert.match(lower.message, /lower the baseline to 2/);
    assert.equal(check({ root, files, baseline: {} }).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
