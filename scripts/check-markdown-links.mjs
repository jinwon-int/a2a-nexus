#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';

const root = resolve(process.argv[2] || process.cwd());
const skipDirs = new Set(['.git', 'node_modules', 'dist', 'coverage', '.tmp', 'tmp']);
const markdownExts = new Set(['.md', '.mdx']);
const linkPattern = /(!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\))|(<a\s+[^>]*href=["']([^"']+)["'][^>]*>)/gi;

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!skipDirs.has(ent.name)) out.push(...walk(join(dir, ent.name)));
      continue;
    }
    if (ent.isFile() && markdownExts.has(extname(ent.name).toLowerCase())) out.push(join(dir, ent.name));
  }
  return out;
}

function isExternal(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|#|mailto:|tel:)/i.test(target);
}

function stripAnchor(target) {
  const hash = target.indexOf('#');
  return hash >= 0 ? target.slice(0, hash) : target;
}

const failures = [];
for (const file of walk(root)) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const match of line.matchAll(linkPattern)) {
      const raw = match[2] || match[4] || '';
      const decoded = decodeURI(raw).trim();
      if (!decoded || isExternal(decoded)) continue;
      const withoutAnchor = stripAnchor(decoded);
      if (!withoutAnchor) continue;
      const target = normalize(resolve(dirname(file), withoutAnchor));
      if (!target.startsWith(root)) {
        failures.push(`${relative(root, file)}:${index + 1} -> ${raw} (escapes repo root)`);
        continue;
      }
      if (!existsSync(target)) {
        failures.push(`${relative(root, file)}:${index + 1} -> ${raw}`);
        continue;
      }
      try {
        statSync(target);
      } catch {
        failures.push(`${relative(root, file)}:${index + 1} -> ${raw}`);
      }
    }
  });
}

if (failures.length) {
  console.error(`markdown link check failed: ${failures.length} broken relative link(s)`);
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log('markdown link check ok');
