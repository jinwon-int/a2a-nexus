#!/usr/bin/env node
/**
 * Static guard for A2A GitHub body automation.
 *
 * Flags shell heredocs and inline gh --body usage in JavaScript/MJS/TS automation
 * files. gh --body-file is allowed. This scanner is intentionally conservative:
 * exact dangerous tokens fail closed and operators can pass explicit paths for a
 * focused scan.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import process from 'node:process';

const DEFAULT_SCAN_ROOTS = [
  'scripts',
  'packages/broker/scripts',
  'packages/docker-runner/src',
  'packages/policy-referee/src',
  'packages/attestation/src',
];

const SCANNED_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.sh', '.bash']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', 'tmp']);

const RULES = [
  {
    rule: 'unquoted-heredoc',
    // cat <<EOF / tee <<EOF are the body-construction forms that corrupted A2A
    // GitHub Markdown bodies. Embedded node/python heredocs used for local
    // config generation are intentionally out of scope for this guard.
    pattern: /\b(?:cat|tee)\s+<<-?\s*['"]?[A-Za-z0-9_:-]+['"]?/,
    message: 'use a literal body file helper instead of heredoc body construction',
  },
  {
    rule: 'inline-gh-body',
    // Match gh issue/pr create/edit/comment ... --body VALUE but not --body-file.
    pattern: /\bgh\s+(?:issue|pr)\s+(?:create|edit|comment)\b[^\n]*\s--body(?!-file)\b/,
    message: 'use gh --body-file with scripts/a2a-safe-body.mjs; never inline --body',
  },
];

function shouldScanFile(path) {
  if (/\.test\.[mc]?[jt]s$/.test(path)) return false;
  return SCANNED_EXTENSIONS.has(extname(path));
}

// Explicit/top-level paths (and symlinked entries, which dirent types cannot
// classify) resolve their type with a single stat; missing or unreadable paths
// are skipped, as the former existsSync guard did.
function collectFiles(path, out = []) {
  let st;
  try {
    st = statSync(path, { throwIfNoEntry: false });
  } catch {
    return out;
  }
  if (!st) return out;
  if (st.isFile()) {
    if (shouldScanFile(path)) out.push(path);
    return out;
  }
  if (!st.isDirectory()) return out;
  return collectDir(path, out);
}

// Directory recursion reads each level once with withFileTypes, so regular
// entries need no per-child stat; symlinks fall back to the stat-following
// collectFiles above.
function collectDir(dir, out) {
  const base = dir.split(/[\\/]/).pop();
  if (SKIP_DIRS.has(base)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isSymbolicLink()) collectFiles(child, out);
    else if (entry.isFile()) {
      if (shouldScanFile(child)) out.push(child);
    } else if (entry.isDirectory()) collectDir(child, out);
  }
  return out;
}

function lineViolations(file, content) {
  const out = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || /a2a-body-safety-scan: allow/.test(line)) return;
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        out.push({
          file,
          line: index + 1,
          rule: rule.rule,
          message: rule.message,
          content: line.trim().slice(0, 240),
        });
      }
    }
  });
  return out;
}

export function scanBodySafetyPaths(paths = DEFAULT_SCAN_ROOTS, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const files = [];
  for (const input of paths.length ? paths : DEFAULT_SCAN_ROOTS) {
    collectFiles(input, files);
  }
  const uniqueFiles = [...new Set(files)].sort();
  const violations = [];
  for (const file of uniqueFiles) {
    const content = readFileSync(file, 'utf8');
    violations.push(...lineViolations(file, content));
  }
  return {
    ok: violations.length === 0,
    scannedFiles: uniqueFiles.length,
    violations: violations.map((v) => ({ ...v, file: relative(cwd, v.file) || v.file })),
  };
}

function renderReport(report) {
  if (report.ok) {
    return `A2A body safety scan ok: ${report.scannedFiles} file(s) scanned\n`;
  }
  const lines = [`A2A body safety scan failed: ${report.violations.length} violation(s) in ${report.scannedFiles} file(s)`, ''];
  for (const v of report.violations) {
    lines.push(`${v.file}:${v.line}: ${v.rule}: ${v.message}`);
    lines.push(`  ${v.content}`);
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && process.argv[1].endsWith('a2a-body-safety-scan.mjs')) {
  const paths = process.argv.slice(2);
  const report = scanBodySafetyPaths(paths.length ? paths : DEFAULT_SCAN_ROOTS);
  process.stdout.write(renderReport(report));
  if (!report.ok) process.exitCode = 1;
}
