import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const REPO_ROOT = resolve(HERE, '../..');
export const DEFAULT_INVENTORY_PATH = join(REPO_ROOT, 'docs/ops/release-gate-step-inventory.json');
export const DEFAULT_TIERS = ['core', 'public-readiness'];
export const VALID_RETIREMENT = new Set(['keep', 'candidate-after-review', 'manual-approval-required']);

function fail(message) {
  throw new Error(message);
}

function requireString(value, field, context) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${context}: ${field} must be a non-empty string`);
  }
}

export function loadReleaseGateInventory(inventoryPath = DEFAULT_INVENTORY_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  } catch (err) {
    fail(`cannot load release-gate inventory at ${inventoryPath}: ${err.message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('release-gate inventory must be a JSON object');
  }
  if (parsed.generatedFrom !== 'scripts/release-gate.mjs') {
    fail('release-gate inventory generatedFrom must be scripts/release-gate.mjs');
  }
  if (!Array.isArray(parsed.tiers) || parsed.tiers.length === 0) {
    fail('release-gate inventory tiers must be a non-empty array');
  }
  if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
    fail('release-gate inventory entries must be a non-empty array');
  }

  const validTiers = new Set(parsed.tiers);
  const seen = new Set();
  for (const [index, entry] of parsed.entries.entries()) {
    const context = `release-gate inventory entry #${index}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`${context} must be an object`);
    }
    requireString(entry.name, 'name', context);
    requireString(entry.command, 'command', context);
    if (seen.has(entry.name)) fail(`duplicate release-gate step ${entry.name}`);
    seen.add(entry.name);
    if (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== 'string')) {
      fail(`${context}: args must be an array of strings`);
    }
    if (!validTiers.has(entry.tier)) fail(`${entry.name}: invalid tier ${entry.tier}`);
    if (!VALID_RETIREMENT.has(entry.retirement)) {
      fail(`${entry.name}: invalid retirement ${entry.retirement}`);
    }
    if (typeof entry.note !== 'string' || entry.note.length < 20) {
      fail(`${entry.name}: note must explain classification`);
    }
  }

  return parsed;
}

export function parseReleaseGateArgs(argv) {
  const selectedTiers = new Set(DEFAULT_TIERS);
  let all = false;
  let list = false;
  let replaceDefaultTiers = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') {
      all = true;
      continue;
    }
    if (arg === '--list') {
      list = true;
      continue;
    }
    if (arg === '--tier') {
      const tier = argv[i + 1];
      if (!tier) fail('--tier requires a tier name');
      selectedTiers.add(tier);
      i += 1;
      continue;
    }
    if (arg === '--only-tier') {
      const tier = argv[i + 1];
      if (!tier) fail('--only-tier requires a tier name');
      if (!replaceDefaultTiers) {
        selectedTiers.clear();
        replaceDefaultTiers = true;
      }
      selectedTiers.add(tier);
      i += 1;
      continue;
    }
    if (arg.startsWith('--tier=')) {
      selectedTiers.add(arg.slice('--tier='.length));
      continue;
    }
    if (arg.startsWith('--only-tier=')) {
      if (!replaceDefaultTiers) {
        selectedTiers.clear();
        replaceDefaultTiers = true;
      }
      selectedTiers.add(arg.slice('--only-tier='.length));
      continue;
    }
    fail(`unknown release-gate argument: ${arg}`);
  }

  return { all, list, tiers: [...selectedTiers] };
}

export function selectReleaseGateEntries(inventory, { all = false, tiers = DEFAULT_TIERS } = {}) {
  const validTiers = new Set(inventory.tiers);
  const requested = all ? validTiers : new Set(tiers);
  for (const tier of requested) {
    if (!validTiers.has(tier)) fail(`unknown release-gate tier: ${tier}`);
  }
  const entries = inventory.entries.filter((entry) => requested.has(entry.tier));
  if (entries.length === 0) fail(`no release-gate entries selected for tiers: ${[...requested].join(', ')}`);
  return entries;
}

export function summarizeReleaseGateEntries(entries) {
  return entries.reduce((summary, entry) => {
    summary[entry.tier] = (summary[entry.tier] ?? 0) + 1;
    return summary;
  }, {});
}
