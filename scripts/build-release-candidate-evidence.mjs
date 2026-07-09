#!/usr/bin/env node
/**
 * Build a source-only release-candidate evidence packet (#1486).
 *
 * Safety: this script only reads local git/package metadata and writes local
 * evidence files. It does not run npm install/check, create tags/releases,
 * publish packages/images, deploy, restart services, send providers, mutate DB
 * or outbox state, move secrets, or change repository visibility.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const DEFAULT_OUT_DIR = 'artifacts/release-candidate';
const DEFAULT_PACKAGE_GLOB = 'packages/*';
const GENERATED_SCHEMA = 'a2a.release-candidate-evidence.v1';
const MAX_SUMMARY_FILES = 40;

const PROHIBITED_ACTIONS = [
  'GitHub Release creation',
  'tag creation or push',
  'npm publish',
  'Docker or GHCR build/push',
  'production deploy',
  'broker/Gateway/worker restart',
  'provider or Telegram send',
  'database/outbox/ACK/replay/prune/migration mutation',
  'secret or credential movement',
  'repository visibility change',
  'history rewrite or force push',
];

const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env($|[./])/,
  /(^|\/)\.openclaw($|\/)/,
  /(^|\/)(AGENTS|SOUL|USER|TOOLS|HEARTBEAT|IDENTITY)\.md$/,
  /(^|\/)node_modules($|\/)/,
  /(^|\/)\.git($|\/)/,
];

const PACKET_SECRET_PATTERNS = [
  { id: 'aws-access-key', regex: /AKIA[0-9A-Z]{16}/ },
  { id: 'github-token', regex: /gh[pousr]_[A-Za-z0-9_]{20,}/ },
  { id: 'slack-token', regex: /xox[baprs]-[A-Za-z0-9-]{20,}/ },
  { id: 'private-key', regex: /BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY/ },
  { id: 'absolute-root-path', regex: /(?:^|["'\s])\/root\// },
  { id: 'absolute-home-path', regex: /(?:^|["'\s])\/home\/[A-Za-z0-9._-]+\// },
  { id: 'telegram-chat-id', regex: /telegram:[-0-9]{6,}/i },
  { id: 'raw-session-id', regex: /session[_-]?id["'\s:=]+[A-Za-z0-9_-]{16,}/i },
];

function repoRootFromScript() {
  return path.resolve(fileURLToPath(new URL('..', import.meta.url)));
}

function parseArgs(argv) {
  const options = {
    repoRoot: repoRootFromScript(),
    outDir: DEFAULT_OUT_DIR,
    candidateRef: 'HEAD',
    packages: [],
    prUrl: process.env.GITHUB_PR_URL || process.env.PR_URL || null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--repo-root') options.repoRoot = argv[++i];
    else if (arg === '--out-dir') options.outDir = argv[++i];
    else if (arg === '--candidate-ref') options.candidateRef = argv[++i];
    else if (arg === '--package') options.packages.push(argv[++i]);
    else if (arg === '--pr-url') options.prUrl = argv[++i];
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/build-release-candidate-evidence.mjs [options]\n\nOptions:\n  --repo-root <path>       repository root (default: current repo)\n  --out-dir <path>         output directory (default: ${DEFAULT_OUT_DIR})\n  --candidate-ref <ref>    git ref to describe (default: HEAD)\n  --package <path>         package/workspace path to audit; repeatable\n  --pr-url <url>           candidate PR URL to record\n  --json                   print output paths as JSON`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  options.repoRoot = path.resolve(options.repoRoot);
  options.outDir = path.resolve(options.repoRoot, options.outDir);
  return options;
}

function runGit(repoRoot, args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function safeRelative(repoRoot, absPath) {
  const rel = path.relative(repoRoot, absPath).replaceAll(path.sep, '/');
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path escapes repo root: ${absPath}`);
  return rel || '.';
}

function sanitizeRemoteUrl(url) {
  if (!url) return null;
  let value = String(url).trim();
  value = value.replace(/^(https?:\/\/)([^/@:]+):[^/@]+@/i, '$1');
  const ssh = value.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (ssh) return `https://github.com/${ssh[1].replace(/\.git$/, '')}`;
  const https = value.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (https) return `https://github.com/${https[1].replace(/\.git$/, '')}`;
  return '[redacted-or-non-github-remote]';
}

function packagePatterns(rootPackage) {
  const raw = rootPackage.workspaces ?? [DEFAULT_PACKAGE_GLOB];
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.packages)) return raw.packages;
  return [DEFAULT_PACKAGE_GLOB];
}

function expandWorkspacePattern(repoRoot, pattern) {
  if (!pattern.endsWith('/*')) {
    const candidate = path.join(repoRoot, pattern);
    return fs.existsSync(path.join(candidate, 'package.json')) ? [safeRelative(repoRoot, candidate)] : [];
  }
  const base = path.join(repoRoot, pattern.slice(0, -2));
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(base, entry.name, 'package.json')))
    .map((entry) => safeRelative(repoRoot, path.join(base, entry.name)))
    .sort();
}

function discoverPackageDirs(repoRoot, requestedPackages = []) {
  if (requestedPackages.length) {
    return requestedPackages.map((pkg) => safeRelative(repoRoot, path.resolve(repoRoot, pkg))).sort();
  }
  const rootPkgPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(rootPkgPath)) return [];
  const rootPkg = readJson(rootPkgPath);
  return [...new Set(packagePatterns(rootPkg).flatMap((pattern) => expandWorkspacePattern(repoRoot, pattern)))].sort();
}

function isSensitivePath(relPath) {
  if (/(^|\/)\.env\.example$/.test(relPath)) return false;
  return SENSITIVE_PATH_PATTERNS.some((regex) => regex.test(relPath));
}

function recursiveFiles(repoRoot, dirRel) {
  const root = path.join(repoRoot, dirRel);
  const out = [];
  function walk(abs) {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name);
      const rel = safeRelative(repoRoot, child);
      if (entry.isDirectory()) {
        if (!isSensitivePath(`${rel}/`)) walk(child);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

function collectTrackedFiles(repoRoot, packageDir) {
  const gitOut = runGit(repoRoot, ['ls-files', '--', packageDir]);
  const candidates = gitOut ? gitOut.split('\n').filter(Boolean).sort() : recursiveFiles(repoRoot, packageDir);
  const included = [];
  const excludedByPolicy = [];
  for (const rel of candidates) {
    if (isSensitivePath(rel)) excludedByPolicy.push(rel);
    else included.push(rel);
  }
  return { included, excludedByPolicy, method: gitOut ? 'git-ls-files' : 'recursive-filesystem-fallback' };
}

function buildPackageContentsAudit(repoRoot, packageDirs) {
  const packages = [];
  for (const packageDir of packageDirs) {
    const pkgPath = path.join(repoRoot, packageDir, 'package.json');
    const pkg = fs.existsSync(pkgPath) ? readJson(pkgPath) : {};
    const { included, excludedByPolicy, method } = collectTrackedFiles(repoRoot, packageDir);
    const riskFindings = excludedByPolicy.map((rel) => ({
      path: rel,
      reason: 'sensitive package path is present in the candidate surface; remove or explicitly keep it outside release/package evidence',
    }));
    packages.push({
      path: packageDir,
      name: pkg.name ?? null,
      version: pkg.version ?? null,
      private: pkg.private === true,
      auditMethod: method,
      includedFileCount: included.length,
      includedFiles: included,
      excludedByPolicy,
      riskFindings,
      installOrRunSmoke: {
        status: 'not_run_by_design',
        reason: 'The evidence builder is source-only and does not install, execute package scripts, publish, or deploy. Run the listed validation commands separately for candidate sign-off.',
      },
    });
  }
  return {
    method: 'workspace package.json + tracked-file inventory; no npm pack/publish invocation',
    packages,
    excludedPathPolicy: SENSITIVE_PATH_PATTERNS.map((regex) => regex.source),
    riskFindingCount: packages.reduce((sum, pkg) => sum + pkg.riskFindings.length, 0),
  };
}

function commandEvidence() {
  return [
    ['clean-install', 'npm ci --ignore-scripts --include=dev'],
    ['root-check', 'npm run check'],
    ['quickstart-smoke', 'npm run smoke:quickstart'],
    ['markdown-links', 'npm run check:markdown-links'],
    ['public-readiness', 'npm run scan:public-readiness'],
    ['external-secrets', 'npm run scan:external-secrets'],
  ].map(([id, command]) => ({
    id,
    command,
    status: 'not_run_by_design',
    reason: 'Recorded as required candidate evidence; this source-only builder does not execute validation commands.',
  }));
}

export function buildEvidence(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? repoRootFromScript());
  const candidateRef = options.candidateRef ?? 'HEAD';
  const rootPackagePath = path.join(repoRoot, 'package.json');
  const rootPackage = fs.existsSync(rootPackagePath) ? readJson(rootPackagePath) : {};
  const sha = runGit(repoRoot, ['rev-parse', candidateRef]);
  const branch = runGit(repoRoot, ['branch', '--show-current']);
  const commitDate = runGit(repoRoot, ['log', '-1', '--format=%cI', candidateRef]);
  const dirty = (runGit(repoRoot, ['status', '--short']) ?? '').length > 0;
  const remote = sanitizeRemoteUrl(runGit(repoRoot, ['config', '--get', 'remote.origin.url']));
  const packageDirs = discoverPackageDirs(repoRoot, options.packages ?? []);
  const evidence = {
    schemaVersion: GENERATED_SCHEMA,
    generatedAt: new Date().toISOString(),
    sourceOnly: true,
    noLiveActionsPerformed: true,
    candidate: {
      repository: remote,
      ref: candidateRef,
      sha,
      branch: branch || null,
      prUrl: options.prUrl ?? null,
      commitDate,
      workingTreeDirty: dirty,
    },
    rootPackage: {
      name: rootPackage.name ?? null,
      private: rootPackage.private === true,
      workspaces: packagePatterns(rootPackage),
      packageManager: rootPackage.packageManager ?? null,
    },
    validationCommands: commandEvidence(),
    packageContentsAudit: buildPackageContentsAudit(repoRoot, packageDirs),
    knownLimitations: [
      'This packet records source-state evidence and package contents inventory only.',
      'Validation commands are listed but not executed by this source-only builder.',
      'Package contents are approximated from workspace package.json plus git tracked-file inventory; this intentionally does not invoke npm pack or lifecycle hooks.',
      'No GitHub Release, tag, npm package, Docker/GHCR image, deployment, provider send, DB/outbox/ACK mutation, secret movement, or visibility change is performed.',
      'A final release/publication decision still requires explicit operator approval and fresh validation output for the exact candidate commit.',
    ],
    rollbackNote: `Delete the generated ${DEFAULT_OUT_DIR} directory or regenerate it for a different candidate ref; no live state is changed.`,
    prohibitedActions: PROHIBITED_ACTIONS,
  };
  assertPublicSafeEvidence(evidence);
  return evidence;
}

export function assertPublicSafeEvidence(evidence) {
  const serialized = JSON.stringify(evidence, null, 2);
  const hits = PACKET_SECRET_PATTERNS
    .filter(({ regex }) => regex.test(serialized))
    .map(({ id }) => id);
  const packageRisks = evidence?.packageContentsAudit?.riskFindingCount ?? 0;
  if (hits.length || packageRisks > 0) {
    throw new Error(`release candidate evidence is not public-safe: ${[...hits, packageRisks ? `${packageRisks} package risk finding(s)` : null].filter(Boolean).join(', ')}`);
  }
  return true;
}

export function renderSummary(evidence) {
  const packages = evidence.packageContentsAudit.packages;
  const packageRows = packages.length
    ? packages.map((pkg) => `| \`${pkg.path}\` | \`${pkg.name ?? 'unknown'}\` | ${pkg.includedFileCount} | ${pkg.riskFindings.length} |`).join('\n')
    : '| _none_ | _none_ | 0 | 0 |';
  const commandRows = evidence.validationCommands
    .map((cmd) => `| \`${cmd.command}\` | ${cmd.status} | ${cmd.reason} |`)
    .join('\n');
  const sampleFiles = packages
    .flatMap((pkg) => pkg.includedFiles.slice(0, MAX_SUMMARY_FILES).map((file) => `- \`${file}\``))
    .slice(0, MAX_SUMMARY_FILES)
    .join('\n');
  return `# Release-candidate evidence summary\n\nGenerated: ${evidence.generatedAt}\n\n## Candidate\n\n| Field | Value |\n|---|---|\n| Repository | ${evidence.candidate.repository ?? 'unknown'} |\n| Ref | \`${evidence.candidate.ref}\` |\n| SHA | \`${evidence.candidate.sha ?? 'unknown'}\` |\n| Branch | \`${evidence.candidate.branch ?? 'unknown'}\` |\n| PR URL | ${evidence.candidate.prUrl ?? '_not recorded_'} |\n| Working tree dirty | ${evidence.candidate.workingTreeDirty ? 'yes' : 'no'} |\n\n## Validation commands\n\nThese commands are recorded as candidate evidence requirements. They were **not** executed by the source-only evidence builder.\n\n| Command | Status | Reason |\n|---|---|---|\n${commandRows}\n\n## Package contents audit\n\nMethod: ${evidence.packageContentsAudit.method}\n\n| Package path | Package name | Included files | Risk findings |\n|---|---:|---:|---:|\n${packageRows}\n\n### Sample included files\n\n${sampleFiles || '_No package files discovered._'}\n\n## Safety boundary\n\nNo GitHub Release, tag, npm publish, Docker/GHCR push, deployment, broker/Gateway/worker restart, provider/Telegram send, DB/outbox/ACK/replay/prune/migration mutation, secret movement, repository visibility change, history rewrite, or force push was performed.\n\n## Known limitations\n\n${evidence.knownLimitations.map((item) => `- ${item}`).join('\n')}\n`;
}

export function writeEvidenceFiles(evidence, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const evidencePath = path.join(outDir, 'evidence.json');
  const summaryPath = path.join(outDir, 'summary.md');
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  fs.writeFileSync(summaryPath, renderSummary(evidence));
  return { evidencePath, summaryPath };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const evidence = buildEvidence(options);
  const written = writeEvidenceFiles(evidence, options.outDir);
  if (options.json) {
    console.log(JSON.stringify(written, null, 2));
  } else {
    console.log(`release-candidate evidence written: ${path.relative(options.repoRoot, written.evidencePath)}`);
    console.log(`release-candidate summary written: ${path.relative(options.repoRoot, written.summaryPath)}`);
    console.log('source-only: no release/tag/publish/deploy/restart/provider/DB/secret/visibility action performed');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`release-candidate evidence failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
