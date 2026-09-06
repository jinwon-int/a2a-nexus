#!/usr/bin/env node
/**
 * Broker policy document gate (#1355 G1-a).
 *
 * Validates docs/ops/broker-policy.json fail-closed BEFORE it can reach a
 * broker: unknown fields anywhere are an error (a typo like `denyIntents`
 * must never silently no-op a safety rule), rule ids must be unique, and the
 * match axis is restricted to the closed ANONYMOUS worker-class enum — a
 * concrete worker name can never appear in the committed policy document.
 *
 * The broker runtime performs the same validation at startup
 * (packages/policy-referee/src/broker-policy.ts — the canonical TS validator);
 * this standalone gate lets CI and operators check a document without
 * building the broker. Keep the two rule sets in lockstep via the contract:
 * contracts/a2a/broker-policy.md
 *
 * Deployment path (#2064). This script is also the single CLI that owns the
 * document's lifecycle, so validation and deployment cannot drift apart:
 *   validate  (default)  schema gate on the committed document — CI-safe
 *   drift                compare a broker's live document to the canonical one
 *   sync                 deploy the canonical document to a broker's live path
 * The drift/sync mechanics live in scripts/lib/broker-policy-deployment.mjs.
 *
 * Why drift/sync are node-local and not a CI gate: CI runners have no route to
 * a broker host (the brokers sit behind private tunnels) and no fleet ssh
 * credentials. Giving CI those credentials to read one file would be a larger
 * standing risk than the drift it detects, and the repo may not name fleet
 * nodes at all (scripts/public-readiness-scan.mjs --strict-internal fails on
 * node identifiers). So the split is: CI keeps the schema gate plus the unit
 * tests below it, and the liveness comparison runs on each broker node, where
 * the live file actually is. See contracts/a2a/broker-policy.md §4.1.
 *
 * Safety: `validate` and `drift` are read-only source/file inspection with no
 * network. `sync` is dry-run by default; only `sync --apply` writes, and it
 * writes exactly two files (the live policy document and a backup of the
 * previous one). Nothing here restarts, reloads or dispatches to a broker.
 *
 * Usage:
 *   node scripts/check-broker-policy.mjs [path/to/broker-policy.json]
 *   node scripts/check-broker-policy.mjs drift [--live PATH] [--canonical PATH]
 *   node scripts/check-broker-policy.mjs sync  [--live PATH] [--canonical PATH] [--apply]
 */
import fs from 'node:fs';

import {
  DEFAULT_CANONICAL_POLICY_PATH,
  DEFAULT_LIVE_POLICY_PATH,
  applyPolicySync,
  formatDeploymentReport,
  formatSyncReport,
  inspectPolicyDeployment,
} from './lib/broker-policy-deployment.mjs';

export const BROKER_POLICY_SCHEMA = 'a2a.broker.policy.v1';
export const MODES = ['warn', 'enforce'];
export const DEFAULT_ACTIONS = ['allow', 'deny'];
export const WORKER_CLASSES = ['mobile', 'vps', 'source-only', 'unclassified'];

const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DOCUMENT_FIELDS = new Set(['schemaVersion', 'mode', 'defaultAction', 'rules']);
// Keep in lockstep with RULE_FIELDS in packages/policy-referee/src/broker-policy.ts.
// Both sets are fail-closed on unknown fields, so a field added to only one of
// them makes the other reject every document that uses it. The parity is
// asserted by scripts/check-broker-policy.test.mjs.
export const RULE_FIELDS = new Set([
  'id',
  'workerClass',
  'allowIntents',
  'denyModes',
  'requireApproval',
  'maxTasksPerDay',
  'requireImplementationCapability',
]);

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

/** Returns a list of violation strings; empty = valid. */
export function validatePolicyDocument(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return ['document must be a JSON object'];
  }
  for (const key of Object.keys(doc)) {
    if (!DOCUMENT_FIELDS.has(key)) errors.push(`unknown field '${key}' (fail-closed)`);
  }
  if (doc.schemaVersion !== BROKER_POLICY_SCHEMA) errors.push(`schemaVersion must be '${BROKER_POLICY_SCHEMA}'`);
  if (!MODES.includes(doc.mode)) errors.push(`mode must be one of ${MODES.join(' | ')}`);
  if (!DEFAULT_ACTIONS.includes(doc.defaultAction)) errors.push(`defaultAction must be one of ${DEFAULT_ACTIONS.join(' | ')}`);
  if (!Array.isArray(doc.rules)) {
    errors.push('rules must be an array');
    return errors;
  }
  const seen = new Set();
  for (const [index, rule] of doc.rules.entries()) {
    const where = `rules[${index}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      errors.push(`${where} must be an object`);
      continue;
    }
    for (const key of Object.keys(rule)) {
      if (!RULE_FIELDS.has(key)) errors.push(`${where} has unknown field '${key}' (fail-closed)`);
    }
    if (typeof rule.id !== 'string' || !RULE_ID_PATTERN.test(rule.id)) {
      errors.push(`${where}.id must match ${RULE_ID_PATTERN}`);
    } else if (seen.has(rule.id)) {
      errors.push(`duplicate rule id '${rule.id}'`);
    } else {
      seen.add(rule.id);
    }
    if (rule.workerClass !== '*' && !WORKER_CLASSES.includes(rule.workerClass)) {
      errors.push(`${where}.workerClass '${rule.workerClass}' is not an anonymous worker class (${WORKER_CLASSES.join(' | ')} | *) — worker names are rejected`);
    }
    if (rule.allowIntents !== undefined && !isStringArray(rule.allowIntents)) {
      errors.push(`${where}.allowIntents must be an array of non-empty strings`);
    }
    if (rule.denyModes !== undefined && !isStringArray(rule.denyModes)) {
      errors.push(`${where}.denyModes must be an array of non-empty strings`);
    }
    if (rule.requireApproval !== undefined && typeof rule.requireApproval !== 'boolean') {
      errors.push(`${where}.requireApproval must be a boolean`);
    }
    if (rule.maxTasksPerDay !== undefined && (!Number.isInteger(rule.maxTasksPerDay) || rule.maxTasksPerDay < 1)) {
      errors.push(`${where}.maxTasksPerDay must be a positive integer`);
    }
    if (rule.requireImplementationCapability !== undefined && typeof rule.requireImplementationCapability !== 'boolean') {
      errors.push(`${where}.requireImplementationCapability must be a boolean`);
    }
  }
  return errors;
}

const SUBCOMMANDS = new Set(['validate', 'drift', 'sync']);

function parseFlags(argv) {
  const flags = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') flags.apply = true;
    else if (arg === '--live') flags.live = argv[++i];
    else if (arg === '--canonical') flags.canonical = argv[++i];
    else if (arg.startsWith('--live=')) flags.live = arg.slice('--live='.length);
    else if (arg.startsWith('--canonical=')) flags.canonical = arg.slice('--canonical='.length);
    else return { error: `unknown argument '${arg}'` };
  }
  return flags;
}

/** drift: fail when a broker's live document differs from the canonical one. Never repairs. */
function driftCommand(argv) {
  const flags = parseFlags(argv);
  if (flags.error) {
    process.stderr.write(`${flags.error}\n`);
    return 2;
  }
  const result = inspectPolicyDeployment({
    canonicalPath: flags.canonical ?? DEFAULT_CANONICAL_POLICY_PATH,
    livePath: flags.live ?? DEFAULT_LIVE_POLICY_PATH,
    validate: validatePolicyDocument,
  });
  for (const line of formatDeploymentReport(result)) process.stdout.write(`${line}\n`);
  if (result.status === 'ok') return 0;
  // 2 = could not read/parse one side (fail-closed, never "assumed equal");
  // 1 = a real policy difference that needs an operator decision.
  return result.status === 'drift' ? 1 : 2;
}

/** sync: deploy the canonical document to a live path. Dry-run unless --apply. */
function syncCommand(argv) {
  const flags = parseFlags(argv);
  if (flags.error) {
    process.stderr.write(`${flags.error}\n`);
    return 2;
  }
  const result = applyPolicySync({
    canonicalPath: flags.canonical ?? DEFAULT_CANONICAL_POLICY_PATH,
    livePath: flags.live ?? DEFAULT_LIVE_POLICY_PATH,
    apply: flags.apply,
    validate: validatePolicyDocument,
  });
  for (const line of formatSyncReport(result)) process.stdout.write(`${line}\n`);
  if (result.refused || result.status === 'verify-failed') return 2;
  return 0;
}

function main(argv) {
  if (argv[0] && SUBCOMMANDS.has(argv[0])) {
    if (argv[0] === 'drift') return driftCommand(argv.slice(1));
    if (argv[0] === 'sync') return syncCommand(argv.slice(1));
    return validateCommand(argv.slice(1));
  }
  return validateCommand(argv);
}

function validateCommand(argv) {
  const target = argv[0] ?? DEFAULT_CANONICAL_POLICY_PATH;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (err) {
    process.stderr.write(`cannot read policy document '${target}': ${err.message}\n`);
    return 2;
  }
  const errors = validatePolicyDocument(doc);
  if (errors.length > 0) {
    for (const e of errors) process.stdout.write(`FAIL  ${e}\n`);
    process.stdout.write(`broker policy gate: ${errors.length} violation(s) in ${target} (fail-closed)\n`);
    return 1;
  }
  process.stdout.write(`broker policy gate ok: ${target} (mode=${doc.mode}, defaultAction=${doc.defaultAction}, rules=${doc.rules.length})\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
