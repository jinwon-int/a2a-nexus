#!/usr/bin/env node
/**
 * Package matrix gate (a2a-nexus#1501, current-state slice).
 *
 * Keeps the README package/visibility documentation a single-source projection
 * of the actual package manifests. Fails when:
 *   - a real packages/<dir> is missing from the README "Package Map" block or
 *     the "Repository Map" canonical row (documentation drift on add),
 *   - the "Package Map" lists a packages/<dir> that no longer exists (drift on
 *     remove/rename),
 *   - the README states every package is private/unpublished but a manifest is
 *     not `private` (visibility drift — the exact class that would leak an
 *     accidentally-publishable package past the "source-only install" claim).
 *
 * Fully OFFLINE / source-only: reads README.md and the package manifests only.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createDocCheckContext } from './doc-check.mjs';

const README = 'README.md';

function extractPackageMapDirs(readmeText) {
  const block = readmeText.match(/##\s+Package Map[\s\S]*?```[a-z]*\n([\s\S]*?)```/i);
  const body = block ? block[1] : '';
  return new Set([...body.matchAll(/^packages\/([a-z0-9][a-z0-9-]*)\//gm)].map((m) => m[1]));
}

function extractRepoMapCanonicalDirs(readmeText) {
  const section = readmeText.match(/##\s+Repository Map[\s\S]*?(?=\n##\s|$)/i);
  const body = section ? section[0] : '';
  const canonicalLine = body.split('\n').find((l) => /\*\*Canonical\*\*/.test(l)) || '';
  return new Set([...canonicalLine.matchAll(/packages\/([a-z0-9][a-z0-9-]*)/g)].map((m) => m[1]));
}

/**
 * Pure evaluator so tests drive it without the filesystem.
 * @param {Array<{dir:string,name:string,private:boolean}>} packages
 * @param {string|null} readmeText
 * @returns {string[]} failures (empty === clean)
 */
export function evaluatePackageMatrix(packages, readmeText) {
  if (readmeText == null) return [`missing ${README}`];
  const failures = [];
  const actualDirs = new Set(packages.map((p) => p.dir));
  const pkgMapDirs = extractPackageMapDirs(readmeText);
  const canonicalDirs = extractRepoMapCanonicalDirs(readmeText);
  const claimsAllPrivate = /all packages are `?private`?\s*\/\s*unpublished/i.test(readmeText);

  for (const p of packages) {
    if (!pkgMapDirs.has(p.dir)) {
      failures.push(`${README} "Package Map" does not list packages/${p.dir}/ (real package ${p.name})`);
    }
    if (!canonicalDirs.has(p.dir)) {
      failures.push(`${README} "Repository Map" canonical row does not reference packages/${p.dir}`);
    }
  }
  for (const dir of pkgMapDirs) {
    if (!actualDirs.has(dir)) {
      failures.push(`${README} "Package Map" lists packages/${dir}/ but no such package exists`);
    }
  }
  if (!claimsAllPrivate) {
    failures.push(
      `${README} must state package publish visibility (expected an "all packages are private/unpublished" claim projected from the manifests)`,
    );
  } else {
    for (const p of packages) {
      if (p.private !== true) {
        failures.push(
          `${README} claims all packages are private/unpublished, but packages/${p.dir} (${p.name}) manifest is not private:true`,
        );
      }
    }
  }
  return failures;
}

function discoverPackages(root) {
  const dir = path.join(root, 'packages');
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    try {
      const j = JSON.parse(readFileSync(path.join(dir, name.name, 'package.json'), 'utf8'));
      out.push({ dir: name.name, name: j.name ?? name.name, private: j.private === true });
    } catch {
      /* not a package dir */
    }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

function main() {
  const { root, readRel, fail, finish } = createDocCheckContext({ name: 'package matrix' });
  const readme = readRel(README);
  const packages = discoverPackages(root);
  if (readme === null) fail(`missing ${README}`);
  else for (const message of evaluatePackageMatrix(packages, readme)) fail(message);
  finish(
    `package matrix ok: ${packages.length} packages projected consistently into README Package/Repository Map and the all-private claim`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
