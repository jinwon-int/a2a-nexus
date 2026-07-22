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
 * Safety: source-only validation. No network, no writes.
 *
 * Usage: node scripts/check-broker-policy.mjs [path/to/broker-policy.json]
 */
import fs from 'node:fs';
import path from 'node:path';

export const BROKER_POLICY_SCHEMA = 'a2a.broker.policy.v1';
export const MODES = ['warn', 'enforce'];
export const DEFAULT_ACTIONS = ['allow', 'deny'];
export const WORKER_CLASSES = ['mobile', 'vps', 'source-only', 'unclassified'];

const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DOCUMENT_FIELDS = new Set(['schemaVersion', 'mode', 'defaultAction', 'rules']);
const RULE_FIELDS = new Set(['id', 'workerClass', 'allowIntents', 'denyModes', 'requireApproval', 'maxTasksPerDay']);

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
  }
  return errors;
}

function main(argv) {
  const target = argv[0] ?? path.join('docs', 'ops', 'broker-policy.json');
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
