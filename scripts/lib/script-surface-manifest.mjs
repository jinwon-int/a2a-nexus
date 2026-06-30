#!/usr/bin/env node
/**
 * Script surface tier manifest guard (#1150).
 *
 * This is additive: it does not delete/rename scripts. It makes the existing
 * npm/script validation surface explicit so later cleanup PRs can prove that
 * release/safety gates were not silently dropped.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_MANIFEST = join(REPO_ROOT, 'docs/ops/script-surface-tier-manifest.json');
const VALID_SCRIPT_KINDS = new Set(['required-gate', 'standard-gate', 'manual-ops', 'diagnostic', 'approval-gated', 'test-helper']);

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`cannot read JSON ${path}: ${err.message}`);
  }
}

function compileRule(rule, context) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail(`${context}: rule must be an object`);
  if (typeof rule.id !== 'string' || !rule.id) fail(`${context}: rule.id must be a non-empty string`);
  if (typeof rule.tier !== 'string' || !rule.tier) fail(`${context}: rule.tier must be a non-empty string`);
  if (typeof rule.kind !== 'string' || !VALID_SCRIPT_KINDS.has(rule.kind)) {
    fail(`${context}: rule.kind must be one of ${[...VALID_SCRIPT_KINDS].join(', ')}`);
  }
  if (typeof rule.pattern !== 'string' || !rule.pattern) fail(`${context}: rule.pattern must be a non-empty regex string`);
  let regex;
  try {
    regex = new RegExp(rule.pattern);
  } catch (err) {
    fail(`${context}: invalid regex ${rule.pattern}: ${err.message}`);
  }
  if (typeof rule.note !== 'string' || rule.note.length < 20) fail(`${context}: rule.note must explain the tier`);
  return { ...rule, regex };
}

function classifyScript(name, rules) {
  return rules.find((rule) => rule.regex.test(name)) ?? null;
}

function validatePackage(entry, manifest, { repoRoot = REPO_ROOT } = {}) {
  const failures = [];
  const packagePath = join(repoRoot, entry.packageJson);
  const pkg = readJson(packagePath);
  const scripts = pkg.scripts ?? {};
  const rules = entry.rules.map((rule, index) => compileRule(rule, `${entry.id}.rules[${index}]`));
  const tierCounts = Object.create(null);
  const kindCounts = Object.create(null);
  const unclassified = [];
  const classified = [];

  for (const [name, command] of Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b))) {
    const rule = classifyScript(name, rules);
    if (!rule) {
      unclassified.push(name);
      continue;
    }
    tierCounts[rule.tier] = (tierCounts[rule.tier] ?? 0) + 1;
    kindCounts[rule.kind] = (kindCounts[rule.kind] ?? 0) + 1;
    classified.push({ name, command, tier: rule.tier, kind: rule.kind, rule: rule.id });
  }

  if (unclassified.length) failures.push(`${entry.id}: ${unclassified.length} unclassified script(s): ${unclassified.join(', ')}`);

  for (const required of entry.requiredScripts ?? []) {
    if (typeof required !== 'string' || !required) failures.push(`${entry.id}: requiredScripts contains an invalid value`);
    if (!Object.prototype.hasOwnProperty.call(scripts, required)) failures.push(`${entry.id}: missing required script ${required}`);
  }

  for (const gate of entry.requiredGateScripts ?? []) {
    const item = classified.find((script) => script.name === gate);
    if (!item) {
      failures.push(`${entry.id}: required gate ${gate} is not classified`);
      continue;
    }
    if (!['required-gate', 'standard-gate'].includes(item.kind)) {
      failures.push(`${entry.id}: required gate ${gate} classified as ${item.kind}, expected required-gate/standard-gate`);
    }
  }

  if ((entry.minScripts ?? 0) > Object.keys(scripts).length) {
    failures.push(`${entry.id}: script count ${Object.keys(scripts).length} is below minScripts ${entry.minScripts}`);
  }

  return {
    id: entry.id,
    packageJson: entry.packageJson,
    scriptCount: Object.keys(scripts).length,
    tierCounts,
    kindCounts,
    classified,
    failures,
  };
}

export function validateScriptSurfaceManifest({ manifestPath = DEFAULT_MANIFEST, repoRoot = REPO_ROOT } = {}) {
  const manifest = readJson(manifestPath);
  const failures = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) failures.push('manifest must be an object');
  if (manifest.generatedFrom !== 'scripts/lib/script-surface-manifest.mjs') {
    failures.push('manifest.generatedFrom must be scripts/lib/script-surface-manifest.mjs');
  }
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) failures.push('manifest.packages must be a non-empty array');
  const packageResults = [];
  for (const [index, entry] of (manifest.packages ?? []).entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      failures.push(`packages[${index}] must be an object`);
      continue;
    }
    if (typeof entry.id !== 'string' || !entry.id) failures.push(`packages[${index}].id must be a non-empty string`);
    if (typeof entry.packageJson !== 'string' || !entry.packageJson) failures.push(`${entry.id ?? `packages[${index}]`}: packageJson must be a non-empty string`);
    if (!Array.isArray(entry.rules) || entry.rules.length === 0) failures.push(`${entry.id ?? `packages[${index}]`}: rules must be a non-empty array`);
    if (failures.length) continue;
    const result = validatePackage(entry, manifest, { repoRoot });
    packageResults.push(result);
    failures.push(...result.failures);
  }
  return { ok: failures.length === 0, failures, packages: packageResults };
}

function main() {
  const options = new Set(process.argv.slice(2));
  const json = options.has('--json');
  const result = validateScriptSurfaceManifest();
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const pkg of result.packages) {
      console.log(`${pkg.id}: ${pkg.scriptCount} script(s), tiers=${JSON.stringify(pkg.tierCounts)}, kinds=${JSON.stringify(pkg.kindCounts)}`);
    }
  }
  if (!result.ok) {
    for (const failure of result.failures) console.error(`script-surface: ${failure}`);
    process.exit(1);
  }
  if (!json) console.log('script surface manifest ok');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
