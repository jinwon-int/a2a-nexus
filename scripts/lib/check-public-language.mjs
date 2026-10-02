#!/usr/bin/env node
// Public language ratchet (#2258 C7, decision 5B).
//
// CONTRIBUTING.md ("Public language policy") makes English the default for
// public docs. A Markdown file may be written (partly) in Korean when it says
// so near the top — a `Language: …` / `언어: …` line, the word "bilingual", or
// the `한국어 / English` form used by docs/ecosystem-guide.md, within the first
// DECLARATION_LINES lines. Historical records (docs/history/) and fixtures are
// exempt.
//
// Undeclared Korean docs existed before this gate, so it ratchets instead of
// failing on them: the count may never exceed docs/readiness/
// public-language-baseline.json, and the baseline should be lowered whenever a
// file is declared or translated. Offline; reads only tracked files.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DECLARATION_LINES = 10;
const HANGUL = /[가-힣]/;
const DECLARATION = /^\s*>?\s*[*_]*\s*(?:language|언어)\s*[*_]*\s*:|\bbilingual\b|한국어\s*\/\s*English/im;
const EXEMPT = [/^docs\/history\//, /(^|\/)fixtures\//, /(^|\/)node_modules\//];

export function isDeclared(text) {
  return DECLARATION.test(text.split('\n').slice(0, DECLARATION_LINES).join('\n'));
}

export function undeclaredKoreanDocs(root, files) {
  return files
    .filter((f) => f.endsWith('.md') && !EXEMPT.some((re) => re.test(f)))
    .filter((f) => {
      const text = readFileSync(join(root, f), 'utf8');
      return HANGUL.test(text) && !isDeclared(text);
    })
    .sort();
}

export function check({ root, files, baseline }) {
  const offenders = undeclaredKoreanDocs(root, files);
  const limit = baseline?.undeclaredKoreanDocs;
  if (!Number.isInteger(limit) || limit < 0) {
    return { ok: false, offenders, message: 'baseline undeclaredKoreanDocs must be a non-negative integer' };
  }
  if (offenders.length > limit) {
    return { ok: false, offenders, message: `undeclared Korean docs ${offenders.length} exceed baseline ${limit}: add a "Language: …" declaration near the top, translate, or move historical records to docs/history/` };
  }
  const hint = offenders.length < limit ? ` (lower the baseline to ${offenders.length})` : '';
  return { ok: true, offenders, message: `public language ok: ${offenders.length}/${limit} undeclared Korean docs${hint}` };
}

function main() {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const files = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const baseline = JSON.parse(readFileSync(join(root, 'docs/readiness/public-language-baseline.json'), 'utf8'));
  const result = check({ root, files, baseline });
  if (process.argv.includes('--list') || !result.ok) for (const f of result.offenders) console.log(`  ${f}`);
  (result.ok ? console.log : console.error)(result.message);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
