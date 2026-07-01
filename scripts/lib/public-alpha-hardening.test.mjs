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
  assert.match(readiness, /labels:\s*\[a2a-public,\s*promotion-readiness\]/);
  assert.doesNotMatch(readiness, /labels:\s*\[public-readiness\]/);
});

test('external publicization roadmap captures A2AD evidence, local-first path, and gated settings', () => {
  assert.equal(exists('docs/publicization-roadmap.md'), true, 'missing docs/publicization-roadmap.md');
  const doc = read('docs/publicization-roadmap.md');

  assert.match(doc, /#1166/);
  assert.match(doc, /#1160/);
  assert.match(doc, /nexus-open-issues-publicization-r2-20260701T030930Z/);
  assert.match(doc, /GO_WITH_CHANGES/);
  assert.match(doc, /npm run check:quickstart-conformance/);
  assert.match(doc, /npm run scan:public-readiness/);
  assert.match(doc, /npm run scan:external-secrets/);
  assert.match(doc, /ai-boost\/awesome-a2a#138`:\s*open/i);
  assert.match(doc, /pab1it0\/awesome-a2a#71`:\s*open/i);
  assert.match(doc, /sing1ee\/a2a-directory#35`:\s*merged/i);
  assert.match(doc, /settings mutation/i);
  assert.match(doc, /separate operator-approved settings task/i);
  assert.match(doc, /1166 승인/);
  assert.match(doc, /agent-to-agent/);
  assert.match(doc, /delete_branch_on_merge:\s*true/);
  assert.match(doc, /secret_scanning\.status:\s*enabled/);
  assert.match(doc, /one approval/i);
  assert.match(doc, /paths-filter/);
  assert.match(doc, /promotion-capstone/);
  assert.match(doc, /Keep open until all three external-directory PRs have final states/i);
  assert.match(doc, /#1172/);
  assert.match(doc, /#1173/);
  assert.match(doc, /#1174/);
  assert.match(doc, /clone\/view attribution/i);
  assert.match(doc, /homepage\/docs-site posture/i);
  assert.match(doc, /public-externalization-followups\.md/);
  assert.match(doc, /clone traffic as `uncertain`/);

  assert.doesNotMatch(doc, /GitHub Release was created/i);
  assert.doesNotMatch(doc, /branch protection was enabled/i);
});

test('public externalization follow-up closeout records contribution, traffic, and homepage decisions', () => {
  assert.equal(exists('docs/public-externalization-followups.md'), true, 'missing docs/public-externalization-followups.md');
  const doc = read('docs/public-externalization-followups.md');

  assert.match(doc, /#1172/);
  assert.match(doc, /#1173/);
  assert.match(doc, /#1174/);
  assert.match(doc, /nexus-open-issues-a2a-process-20260701T084019Z/);
  assert.match(doc, /nexus-open-issues-a2a-process-r2-20260701T084710Z/);
  assert.match(doc, /nexus-open-issues-a2a-process-r3-1174-20260701T085251Z/);
  assert.match(doc, /source-projection blocked/);
  assert.match(doc, /issueTemplates=\[\]/);
  assert.match(doc, /isBlankIssuesEnabled=true/);
  assert.match(doc, /Discussions remain disabled/);
  assert.match(doc, /CODEOWNERS review remains optional/);
  assert.match(doc, /classify clone traffic as `uncertain`/i);
  assert.match(doc, /exclude it from organic promotion evidence/i);
  assert.match(doc, /keep the GitHub homepage field blank/i);
  assert.match(doc, /No repository metadata mutation/i);
  assert.match(doc, /#1160.*remains open/i);

  assert.doesNotMatch(doc, /GitHub Release was created/i);
  assert.doesNotMatch(doc, /Discussions were enabled/i);
  assert.doesNotMatch(doc, /homepageUrl was set/i);
});

test('public externalization next-action docs cover README, architecture, entry points, release readiness, and landing draft', () => {
  const readme = read('README.md');
  assert.match(readme, /For external readers, start here first/);
  assert.match(readme, /docs\/architecture\.md/);
  assert.match(readme, /docs\/contribution-entry-points\.md/);
  assert.match(readme, /docs\/release-readiness\.md/);
  assert.match(readme, /docs\/public-alpha-landing\.md/);
  assert.match(readme, /homepage\/docs-site launch/);

  const architecture = read('docs/architecture.md');
  assert.match(architecture, /conceptual architecture map/i);
  assert.match(architecture, /broker\/worker\/finalizer\/evidence/i);
  assert.match(architecture, /Mermaid/i);
  assert.match(architecture, /private hostnames/i);
  assert.match(architecture, /live broker URLs/i);
  assert.doesNotMatch(architecture, /seoyoon-family\.com/i);
  assert.doesNotMatch(architecture, /hook\.seoyoon-family\.com/i);

  const entryPoints = read('docs/contribution-entry-points.md');
  assert.match(entryPoints, /#1179/);
  assert.match(entryPoints, /Candidate 1/);
  assert.match(entryPoints, /Candidate 2/);
  assert.match(entryPoints, /Candidate 3/);
  assert.match(entryPoints, /good first issue/);
  assert.match(entryPoints, /npm run check:quickstart-conformance/);
  assert.match(entryPoints, /#1160.*remains the external directory listing tracker/i);

  const releaseReadiness = read('docs/release-readiness.md');
  assert.match(releaseReadiness, /#1180/);
  assert.match(releaseReadiness, /Readiness vs publication/);
  assert.match(releaseReadiness, /npm run smoke:quickstart/);
  assert.match(releaseReadiness, /package contents audit/i);
  assert.match(releaseReadiness, /GitHub Release creation, tag creation, npm publication, Docker build\/push, GHCR push/);

  const landing = read('docs/public-alpha-landing.md');
  assert.match(landing, /#1181/);
  assert.match(landing, /operator-gated A2A task and evidence control plane/);
  assert.match(landing, /not affiliated with or endorsed by a2aproject/);
  assert.match(landing, /#1160/);
  assert.match(landing, /homepage metadata/);
  assert.match(landing, /repository homepage field should remain blank/i);

  const roadmap = read('docs/publicization-roadmap.md');
  assert.match(roadmap, /#1177/);
  assert.match(roadmap, /#1178/);
  assert.match(roadmap, /#1179/);
  assert.match(roadmap, /#1180/);
  assert.match(roadmap, /#1181/);
  assert.match(roadmap, /Architecture and quickstart/);
});

test('public feedback intake records issue form and monitoring follow-up boundaries', () => {
  assert.equal(exists('docs/public-feedback-intake.md'), true, 'missing docs/public-feedback-intake.md');
  const doc = read('docs/public-feedback-intake.md');

  assert.match(doc, /#1169/);
  assert.match(doc, /issueTemplates:\s*\[\]/);
  assert.match(doc, /isBlankIssuesEnabled:\s*true/);
  assert.match(doc, /github-bounded-poller/);
  assert.match(doc, /not_started/);
  assert.match(doc, /GO_WITH_CHANGES/);
  assert.match(doc, /zero_files/);
  assert.match(doc, /Repository webhook list now has one active webhook/i);
  assert.match(doc, /last_response\.code=200/);
  assert.match(doc, /skippedReason:\s*"no_assignment_command"/);
  assert.match(doc, /Close as completed after this evidence is merged/i);
  assert.match(doc, /ai-boost\/awesome-a2a#138`:\s*open/i);
  assert.match(doc, /pab1it0\/awesome-a2a#71`:\s*open/i);
  assert.match(doc, /bounded reconcile polling.*separately gated/i);
});

test('release gate includes the public alpha hardening documentation guard', () => {
  const inventory = JSON.parse(read('docs/ops/release-gate-step-inventory.json'));
  const entry = inventory.entries.find((item) => item.name === 'public-alpha-hardening');
  assert.ok(entry, 'missing public-alpha-hardening release-gate entry');
  assert.equal(entry.tier, 'public-readiness');
  assert.deepEqual(entry.command === 'node' ? entry.args : [], ['--test', 'scripts/lib/public-alpha-hardening.test.mjs']);
});
