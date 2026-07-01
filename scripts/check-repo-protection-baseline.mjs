/**
 * Repo Protection Baseline Check
 *
 * Checks file-representable repository protections for A2A repos.
 * This script is read-only — it validates repo-file protections and
 * records what GitHub settings protections would be needed.
 *
 * Usage: node scripts/check-repo-protection-baseline.mjs
 *
 * Exit codes:
 *   0 - All file-representable protections present
 *   1 - One or more file-representable protections missing
 */

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

/** Protections that can be validated from repo files */
const fileChecks = [
  {
    id: 'codeowners',
    name: 'CODEOWNERS file',
    required: true,
    test: () => {
      const paths = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];
      const found = paths.find((p) => fs.existsSync(p));
      return { ok: !!found, detail: found ? `Found at ${found}` : 'Not found in standard locations' };
    },
  },
  {
    id: 'issue-templates',
    name: 'Issue templates',
    required: true,
    test: () => {
      const dir = path.join(root, '.github/ISSUE_TEMPLATE');
      if (!fs.existsSync(dir)) return { ok: false, detail: '.github/ISSUE_TEMPLATE/ directory not found' };
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml') || f.endsWith('.md'));
      const formFiles = files.filter((f) => (f.endsWith('.yml') || f.endsWith('.yaml')) && f !== 'config.yml');
      const invalidForms = [];
      for (const file of formFiles) {
        const body = fs.readFileSync(path.join(dir, file), 'utf8');
        const hasName = /^name:\s*\S/m.test(body);
        const hasDescription = /^description:\s*\S/m.test(body);
        const hasTitle = /^title:\s*".+"/m.test(body);
        const hasLegacyAbout = /^about:/m.test(body);
        const hasBody = /^body:\s*$/m.test(body);
        if (!hasName || !hasDescription || !hasTitle || hasLegacyAbout || !hasBody) invalidForms.push(file);
      }
      if (invalidForms.length > 0) {
        return { ok: false, detail: `Issue Forms missing GitHub-renderable metadata: ${invalidForms.join(', ')}` };
      }
      return { ok: files.length > 0, detail: `${files.length} template(s) found; ${formFiles.length} Issue Form(s) renderable` };
    },
  },
  {
    id: 'pr-template',
    name: 'PR template',
    required: true,
    test: () => {
      const paths = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md'];
      const found = paths.find((p) => fs.existsSync(p));
      return { ok: !!found, detail: found ? `Found at ${found}` : 'Not found in standard locations' };
    },
  },
  {
    id: 'security-md',
    name: 'SECURITY.md',
    required: true,
    test: () => {
      const found = fs.existsSync(path.join(root, 'SECURITY.md'));
      return { ok: found, detail: found ? 'Present' : 'Missing root SECURITY.md' };
    },
  },
  {
    id: 'contributing-md',
    name: 'CONTRIBUTING.md',
    required: false,
    test: () => {
      const found = fs.existsSync(path.join(root, 'CONTRIBUTING.md'));
      return { ok: found, detail: found ? 'Present' : 'Missing (optional but recommended)' };
    },
  },
  {
    id: 'license-file',
    name: 'LICENSE file',
    required: true,
    test: () => {
      const paths = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'];
      const found = paths.find((p) => fs.existsSync(p));
      return { ok: !!found, detail: found ? `Found at ${found}` : 'Not found in standard locations' };
    },
  },
  {
    id: 'ci-workflow',
    name: 'CI workflow file',
    required: true,
    test: () => {
      const dir = path.join(root, '.github/workflows');
      if (!fs.existsSync(dir)) return { ok: false, detail: '.github/workflows/ directory not found' };
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
      return { ok: files.length > 0, detail: `${files.length} workflow file(s) found` };
    },
  },
  {
    id: 'public-readiness-scan',
    name: 'Public-readiness scan config in CI',
    required: false,
    test: () => {
      // Check if the CI workflow or available scripts include public-readiness scanning
      const pkgPath = path.join(root, 'package.json');
      if (!fs.existsSync(pkgPath)) return { ok: false, detail: 'No root package.json to check' };
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scripts = pkg.scripts || {};
      const hasReadinessScan = 'scan:public-readiness' in scripts;
      const hasReleaseGate = 'release-gate' in scripts || 'check' in scripts;
      return {
        ok: hasReadinessScan,
        detail: hasReadinessScan
          ? 'scan:public-readiness script configured'
          : 'No scan:public-readiness script (recommended for public repos)',
      };
    },
  },
  {
    id: 'gitignore',
    name: '.gitignore file',
    required: true,
    test: () => {
      const found = fs.existsSync(path.join(root, '.gitignore'));
      return { ok: found, detail: found ? 'Present' : 'Missing' };
    },
  },
  {
    id: 'dockerignore',
    name: '.dockerignore file (if Docker present)',
    required: false,
    test: () => {
      const dockerfilePaths = ['Dockerfile', 'Dockerfile.dev', 'Dockerfile.prod'];
      const hasDockerfile = dockerfilePaths.some((p) => fs.existsSync(path.join(root, p)));
      const hasDockerignore = fs.existsSync(path.join(root, '.dockerignore'));
      if (!hasDockerfile) return { ok: true, detail: 'No Dockerfile found, .dockerignore not required' };
      return { ok: hasDockerignore, detail: hasDockerignore ? 'Present' : 'Missing (Dockerfile present but no .dockerignore)' };
    },
  },
];

/** Requires — protections that can be documented but require GitHub settings changes */
const settingsRequires = [
  {
    id: 'branch-protection',
    name: 'Main branch protection',
    description: 'Protected default branch with required status checks and PR reviews',
    settingsOnly: true,
  },
  {
    id: 'rulesets',
    name: 'Rulesets for critical paths',
    description: 'Rulesets to guard .github/workflows/, packages/, scripts/',
    settingsOnly: true,
  },
  {
    id: 'required-reviews',
    name: 'Required PR reviews',
    description: 'At least one approved review required before merging',
    settingsOnly: true,
  },
  {
    id: 'codeowners-review',
    name: 'CODEOWNERS review enforcement',
    description: 'Require CODEOWNERS review for matching paths (requires both CODEOWNERS file and branch protection)',
    settingsOnly: true,
  },
];

async function main() {
  const fileResults = [];
  let allFilePass = true;

  console.log('--- Repo Protection Baseline Check ---\n');
  console.log(`Repository: ${path.basename(root)}\n`);

  // File-representable checks
  console.log('=== File-representable protections ===\n');
  for (const check of fileChecks) {
    const result = check.test();
    fileResults.push({ id: check.id, name: check.name, ...result, required: check.required });
    const mark = result.ok ? '✅' : '❌';
    const requiredLabel = check.required ? ' [REQUIRED]' : ' [RECOMMENDED]';
    console.log(`${mark} ${check.name}${requiredLabel}: ${result.detail}`);
    if (!result.ok && check.required) allFilePass = false;
  }

  // Settings-only requirements. This script is intentionally repo-file-only:
  // live GitHub settings must be approved and verified with the GitHub API.
  console.log('\n=== Settings-change requirements (verify with GitHub API after approval) ===\n');
  for (const req of settingsRequires) {
    console.log(`ℹ️ ${req.name}: ${req.description} (GitHub settings only; not asserted by this file check)`);
  }

  // Summary
  const requiredPresent = fileResults.filter((r) => r.required && r.ok).length;
  const requiredMissing = fileResults.filter((r) => r.required && !r.ok).length;
  const recommendedMissing = fileResults.filter((r) => !r.required && !r.ok).length;

  console.log('\n--- Summary ---');
  console.log(`Required protections present: ${requiredPresent}`);
  console.log(`Required protections missing: ${requiredMissing}`);
  console.log(`Recommended protections missing: ${recommendedMissing}`);
  console.log(`Settings-only protections listed for live API verification: ${settingsRequires.length}`);
  console.log(`\nAggregate decision: ${allFilePass ? 'All file-representable checks pass' : 'One or more required file-representable checks FAIL'}`);
  console.log('Settings-change protections: verify separately through approved GitHub API readback; this script does not mutate or assert live settings.\n');

  if (!allFilePass) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
