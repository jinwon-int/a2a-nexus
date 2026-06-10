#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
const jsonOutput = args.has('--json');
const callerAudit = args.has('--caller-audit');
const packageJsonPath = process.env.PACKAGE_JSON_PATH || 'package.json';
const repoRoot = resolve(process.env.REPO_ROOT || process.cwd());
const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const scripts = pkg.scripts ?? {};

const GROUPS = [
  ['terminal_brief_sidecar', /^terminal_brief_sidecar/],
  ['terminal_brief', /^terminal_brief/],
  ['orchestration_intelligence', /^orchestration_intelligence/],
  ['worker_orchestration', /^(worker_|complexity_|operator_|adaptive_|work_mode_)/],
  ['a2a_rounds', /^(team1_|team2_|a2a_|round_)/],
  ['tests', /^(test|smoke:)/],
  ['release_public_readiness', /^(release_|source_public_|scan:public-readiness)/],
  ['core', /^(build|start|dev|export:|docker_|rollout_|migration_|reconcile_)/],
];

const DEFAULT_CALLER_INCLUDE_EXTENSIONS = new Set([
  '.md', '.mdx', '.yml', '.yaml', '.json', '.jsonc', '.sh', '.bash', '.mjs', '.js', '.ts', '.tsx', '.toml', '.txt',
]);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'venv', 'coverage']);
const SKIP_FILES = new Set(['package.json', 'package-lock.json']);

function groupFor(name) {
  for (const [group, re] of GROUPS) {
    if (re.test(name)) return group;
  }
  return 'other';
}

function stageFor(name) {
  if (name.includes('approval')) return 'approval';
  if (name.includes('evidence') || name.includes('ingestor')) return 'evidence';
  if (name.includes('gate') || name.includes('preflight')) return 'gate';
  if (name.includes('executor') || name.includes('execution') || name.includes('dispatch')) return 'execution';
  if (name.includes('review') || name.includes('finalizer') || name.includes('closeout')) return 'review-closeout';
  if (name.includes('dry_run') || name.includes('rehearsal')) return 'dry-run';
  return 'uncategorized';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function walkFiles(root) {
  const files = [];
  function walk(dir) {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const path = join(dir, entry.name);
      const rel = relative(root, path).replace(/\\/g, '/');
      if (SKIP_FILES.has(rel)) continue;
      const dot = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.')) : '';
      if (!DEFAULT_CALLER_INCLUDE_EXTENSIONS.has(dot)) continue;
      try {
        if (statSync(path).size > 512 * 1024) continue;
      } catch {
        continue;
      }
      files.push({ path, rel });
    }
  }
  walk(root);
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function findCallerRefs(scriptNames, root) {
  const refs = new Map(scriptNames.map((name) => [name, []]));
  const patterns = scriptNames.map((name) => ({
    name,
    re: new RegExp(`(?:npm|pnpm|yarn)\\s+(?:run\\s+)?${escapeRegExp(name)}(?:\\s|$|\\\\|` + '`' + `)`, 'g'),
  }));
  for (const file of walkFiles(root)) {
    let content = '';
    try {
      content = readFileSync(file.path, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const { name, re } of patterns) {
        re.lastIndex = 0;
        if (!re.test(line)) continue;
        refs.get(name)?.push({ path: file.rel, line: index + 1, text: line.trim().slice(0, 240) });
      }
    });
  }
  return refs;
}

const items = Object.entries(scripts).map(([name, command]) => ({
  name,
  command,
  group: groupFor(name),
  stage: stageFor(name),
  repeatsBuildThenNode: new RegExp('^npm run build && node scripts/').test(command),
  scriptFile: command.match(new RegExp('node (?:dist/[^ ]+|scripts/[^ ]+)'))?.[0]?.replace(/^node /, ''),
}));
items.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));

let callerRefsByName = new Map();
if (callerAudit) {
  callerRefsByName = findCallerRefs(items.map((item) => item.name), repoRoot);
  for (const item of items) {
    item.callerRefs = callerRefsByName.get(item.name) ?? [];
    item.callerRefCount = item.callerRefs.length;
  }
}

const groups = {};
for (const item of items) {
  groups[item.group] ??= { count: 0, buildThenNode: 0, stages: {}, callerRefs: 0, scriptsWithCallerRefs: 0 };
  groups[item.group].count += 1;
  if (item.repeatsBuildThenNode) groups[item.group].buildThenNode += 1;
  groups[item.group].stages[item.stage] = (groups[item.group].stages[item.stage] ?? 0) + 1;
  if (callerAudit) {
    groups[item.group].callerRefs += item.callerRefCount;
    if (item.callerRefCount > 0) groups[item.group].scriptsWithCallerRefs += 1;
  }
}

const summary = {
  package: pkg.name ?? basename(process.cwd()),
  total: items.length,
  groups,
  highChurnFamilies: Object.fromEntries(
    Object.entries(groups)
      .filter(([, value]) => value.count >= 10)
      .map(([key, value]) => [key, value.count]),
  ),
  callerAudit: callerAudit ? {
    repoRoot: relative(process.cwd(), repoRoot) || '.',
    searchedFiles: walkFiles(repoRoot).length,
    scriptsWithCallerRefs: items.filter((item) => item.callerRefCount > 0).length,
    totalCallerRefs: items.reduce((sum, item) => sum + item.callerRefCount, 0),
  } : undefined,
  safeNextStep:
    'Do not bulk-delete scripts. Use this inventory to map runbook/cron/CI callers, consolidate duplicate stage runners, then deprecate wrappers before removal.',
};

if (jsonOutput) {
  console.log(JSON.stringify({ summary, items }, null, 2));
} else {
  console.log(`# npm scripts inventory for ${summary.package}`);
  console.log('');
  console.log(`Total scripts: ${summary.total}`);
  console.log('');
  for (const [group, value] of Object.entries(groups).sort((a, b) => b[1].count - a[1].count)) {
    const stages = Object.entries(value.stages)
      .sort((a, b) => b[1] - a[1])
      .map(([stage, count]) => `${stage}:${count}`)
      .join(', ');
    const callerText = callerAudit ? `; caller refs ${value.callerRefs} across ${value.scriptsWithCallerRefs} scripts` : '';
    console.log(`- ${group}: ${value.count} scripts (${value.buildThenNode} build+node wrappers; stages ${stages}${callerText})`);
  }
  console.log('');
  console.log('High-churn families:');
  for (const [group, count] of Object.entries(summary.highChurnFamilies)) {
    console.log(`- ${group}: ${count}`);
  }
  if (callerAudit) {
    console.log('');
    console.log('Caller audit:');
    console.log(`- searched files: ${summary.callerAudit.searchedFiles}`);
    console.log(`- scripts with caller refs: ${summary.callerAudit.scriptsWithCallerRefs}`);
    console.log(`- total caller refs: ${summary.callerAudit.totalCallerRefs}`);
    const referenced = items.filter((item) => item.callerRefCount > 0);
    if (referenced.length > 0) {
      console.log('');
      console.log('Referenced scripts:');
      for (const item of referenced) {
        console.log(`- ${item.name}: ${item.callerRefCount}`);
        for (const ref of item.callerRefs.slice(0, 5)) {
          console.log(`  - ${ref.path}:${ref.line} ${ref.text}`);
        }
      }
    }
  }
  console.log('');
  console.log(`Safe next step: ${summary.safeNextStep}`);
}
