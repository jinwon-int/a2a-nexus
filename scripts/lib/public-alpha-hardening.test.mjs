#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const repoRoot = new URL('../..', import.meta.url).pathname;

function read(rel) {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

function exists(rel) {
  return existsSync(join(repoRoot, rel));
}

test('public alpha hardening evidence documents fresh-clone smoke and approval boundaries', () => {
  assert.equal(exists('docs/public-alpha-hardening.md'), true, 'missing docs/public-alpha-hardening.md');
  const doc = read('docs/public-alpha-hardening.md');

  assert.match(doc, /#1163/);
  assert.match(doc, /fresh clone smoke/i);
  assert.match(doc, /npm ci --ignore-scripts --include=dev/);
  assert.match(doc, /npm run check/);
  assert.match(doc, /npm run test:conformance/);
  assert.match(doc, /npm run scan:public-readiness/);
  assert.match(doc, /npm run scan:external-secrets/);
  assert.match(doc, /synthetic fixture findings only/i);
  assert.match(doc, /README quickstart/i);
  assert.match(doc, /repo settings/i);
  assert.match(doc, /separate explicit approval/i);
  assert.match(doc, /docs\/external-listings\.md/);
  assert.match(doc, /#1160/);

  assert.doesNotMatch(doc, /production deploys? (were|was) performed/i);
  assert.doesNotMatch(doc, /repository visibility change (was|were) performed/i);
  assert.doesNotMatch(doc, /provider\/Telegram send (was|were) performed/i);
});

test('promotion copy reflects now-public alpha without weakening gated actions', () => {
  const promotion = read('docs/promotion-announcement.md');
  assert.doesNotMatch(promotion, /repository remains private/i);
  assert.doesNotMatch(promotion, /before public visibility/i);
  assert.match(promotion, /public alpha/i);
  assert.match(promotion, /stable release/i);
  assert.match(promotion, /npm\/Docker publication/i);
  assert.match(promotion, /explicit operator approval/i);

  const readme = read('README.md');
  assert.match(readme, /This repository is now public and remains an alpha project/);
  assert.match(readme, /future visibility transfer remain separate approval-gated actions/);
});

test('issue templates cover bug, feature, security contact, and public-readiness feedback', () => {
  assert.equal(exists('.github/ISSUE_TEMPLATE/bug_report.yml'), true);
  assert.equal(exists('.github/ISSUE_TEMPLATE/feature_request.yml'), true, 'missing general feature request template');
  assert.equal(exists('.github/ISSUE_TEMPLATE/readiness_task.yml'), true);
  assert.equal(exists('.github/ISSUE_TEMPLATE/config.yml'), true);

  const feature = read('.github/ISSUE_TEMPLATE/feature_request.yml');
  assert.match(feature, /name:\s*Feature request/i);
  assert.match(feature, /labels:\s*\[.*enhancement.*\]/i);
  assert.match(feature, /public-safe/i);
  assert.match(feature, /no secrets/i);
  assert.match(feature, /production deploy/i);
  assert.match(feature, /separate explicit approval/i);

  const config = read('.github/ISSUE_TEMPLATE/config.yml');
  assert.match(config, /blank_issues_enabled:\s*false/);
  assert.match(config, /Security reports/);
  assert.match(config, /security\/policy/);

  const readiness = read('.github/ISSUE_TEMPLATE/readiness_task.yml');
  assert.match(readiness, /Public-readiness task/);
  assert.match(readiness, /promotion-readiness/);
});

test('release gate includes the public alpha hardening documentation guard', () => {
  const inventory = JSON.parse(read('docs/ops/release-gate-step-inventory.json'));
  const entry = inventory.entries.find((item) => item.name === 'public-alpha-hardening');
  assert.ok(entry, 'missing public-alpha-hardening release-gate entry');
  assert.equal(entry.tier, 'public-readiness');
  assert.deepEqual(entry.command === 'node' ? entry.args : [], ['--test', 'scripts/lib/public-alpha-hardening.test.mjs']);
});
