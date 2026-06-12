#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_TIMEOUT_MS = 20_000;

function parseArgs(argv) {
  const args = {
    worktree: process.cwd(),
    repo: '',
    pr: '',
    hermesHome: process.env.HERMES_HOME || join(homedir(), '.hermes'),
    logLines: 80,
    stash: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--worktree') args.worktree = argv[++i];
    else if (arg === '--repo') args.repo = argv[++i];
    else if (arg === '--pr') args.pr = argv[++i];
    else if (arg === '--hermes-home') args.hermesHome = argv[++i];
    else if (arg === '--log-lines') args.logLines = Number(argv[++i] || 80);
    else if (arg === '--stash') args.stash = true;
    else if (arg === '--json') args.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage: node scripts/pr-review-healthcheck.mjs [options]

Read-only by default. It summarizes Hermes PR-review risk, GitHub rate limits,
worktree cleanliness, open PRs via REST, optional PR REST details, and recent
Hermes timeout/rate-limit logs without printing secrets.

Options:
  --worktree PATH       Git worktree to inspect (default: cwd)
  --repo OWNER/REPO     GitHub repository (default: derived from origin remote)
  --pr NUMBER           Include REST details/files/checks for one PR
  --hermes-home PATH    Hermes home to inspect (default: ~/.hermes)
  --log-lines N         Max matching log lines per file (default: 80)
  --stash               If worktree is dirty, create a safety stash with -u
  --json                Emit JSON instead of text
  --help                Show this help

GraphQL note: when GraphQL remaining is 0 but REST core remains, use the REST
fallback endpoints reported by this tool instead of gh pr list/view/checks.

Exit codes:
  0 healthy/read-only completed
  2 dirty worktree detected and --stash was not provided
  3 GitHub REST/gh inventory failed
`;
}

function run(cmd, args = [], opts = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(cmd, args, {
        cwd: opts.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout?.toString?.() || '',
      stderr: error.stderr?.toString?.() || error.message,
      status: error.status ?? 1,
    };
  }
}

function runJson(cmd, args = [], opts = {}) {
  const result = run(cmd, args, opts);
  if (!result.ok) return { ok: false, error: result.stderr || result.stdout, status: result.status };
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `JSON parse failed: ${error.message}`, raw: result.stdout };
  }
}

function deriveRepo(worktree) {
  const remote = run('git', ['remote', 'get-url', 'origin'], { cwd: worktree });
  if (!remote.ok) return '';
  const url = remote.stdout.trim();
  const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
  return match ? match[1] : '';
}

function redact(text) {
  if (!text) return '';
  return text
    .replace(/([A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY|COOKIE|AUTH)[A-Za-z_]*\s*[:=]\s*)[^\s,'"]+/gi, '$1[REDACTED]')
    .replace(/(gh[pousr]_[A-Za-z0-9_]{20,})/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/(sk-[A-Za-z0-9_-]{20,})/g, '[REDACTED_API_KEY]')
    .replace(/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1[REDACTED]$2');
}

function hermesConfigSummary(hermesHome) {
  const configPath = join(hermesHome, 'config.yaml');
  if (!existsSync(configPath)) return { path: configPath, exists: false };
  const text = redact(readFileSync(configPath, 'utf8'));
  const lines = text.split(/\r?\n/);
  const wantedTop = new Set(['model', 'delegation', 'agent']);
  const summary = [];
  let current = null;
  for (const line of lines) {
    const top = line.match(/^([A-Za-z0-9_-]+):\s*$/);
    if (top) current = wantedTop.has(top[1]) ? top[1] : null;
    if (current) {
      if (/^\s*(default|provider|base_url|model|api_mode|child_timeout_seconds|max_concurrent_children|max_spawn_depth|max_iterations|api_max_retries|reasoning_effort|gateway_timeout):/.test(line) || line.startsWith(`${current}:`)) {
        summary.push(line);
      }
    }
  }
  return { path: configPath, exists: true, summary };
}

function dirtyState(worktree, shouldStash) {
  const status = run('git', ['status', '--porcelain=v1', '-uall'], { cwd: worktree });
  const lines = status.ok ? status.stdout.trim().split(/\r?\n/).filter(Boolean) : [];
  const dirty = lines.length > 0;
  let stash = null;
  if (dirty && shouldStash) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const message = `safety-stash-before-pr-review-${stamp}`;
    const pushed = run('git', ['stash', 'push', '-u', '-m', message], { cwd: worktree, timeoutMs: 60_000 });
    stash = { message, ok: pushed.ok, output: redact((pushed.stdout || '') + (pushed.stderr || '')) };
  }
  return { dirty, lines, stash };
}

function githubRateLimit() {
  const rate = runJson('gh', ['api', 'rate_limit']);
  if (!rate.ok) return rate;
  const resources = rate.data.resources || {};
  return {
    ok: true,
    core: resources.core,
    graphql: resources.graphql,
    search: resources.search,
    restFallbackRecommended: (resources.graphql?.remaining ?? 1) <= 0 && (resources.core?.remaining ?? 0) > 0,
  };
}

function openPullsRest(repo) {
  const pulls = runJson('gh', ['api', `repos/${repo}/pulls?state=open&per_page=100`]);
  if (!pulls.ok) return pulls;
  return {
    ok: true,
    count: pulls.data.length,
    pulls: pulls.data.map((pr) => ({
      number: pr.number,
      title: pr.title,
      draft: pr.draft,
      user: pr.user?.login,
      head: `${pr.head?.label || pr.head?.ref} @ ${pr.head?.sha?.slice(0, 12)}`,
      base: pr.base?.ref,
      mergeable_state: pr.mergeable_state || null,
      updated_at: pr.updated_at,
      html_url: pr.html_url,
    })),
  };
}

function prRestDetails(repo, number) {
  if (!number) return null;
  const pr = runJson('gh', ['api', `repos/${repo}/pulls/${number}`]);
  const files = runJson('gh', ['api', `repos/${repo}/pulls/${number}/files?per_page=100`]);
  if (!pr.ok) return { ok: false, error: pr.error };
  const sha = pr.data.head?.sha;
  const checks = sha ? runJson('gh', ['api', `repos/${repo}/commits/${sha}/check-runs`]) : { ok: false, error: 'missing head sha' };
  const statuses = sha ? runJson('gh', ['api', `repos/${repo}/commits/${sha}/status`]) : { ok: false, error: 'missing head sha' };
  return {
    ok: true,
    number: pr.data.number,
    title: pr.data.title,
    head_sha: sha,
    mergeable_state: pr.data.mergeable_state,
    files: files.ok ? files.data.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })) : { error: files.error },
    checks: checks.ok ? (checks.data.check_runs || []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })) : { error: checks.error },
    combined_status: statuses.ok ? { state: statuses.data.state, statuses: (statuses.data.statuses || []).map((s) => ({ context: s.context, state: s.state })) } : { error: statuses.error },
  };
}

function recentHermesLogs(hermesHome, maxLines) {
  const patterns = /(gpt-5\.5|openai-codex|Non-streaming API call stale|timed out after 90s|API call failed after 3 retries|stale_call_kill|GraphQL|rate limit|secondary rate|gh pr list|compression summary failed)/i;
  const files = [join(hermesHome, 'logs', 'agent.log'), join(hermesHome, 'logs', 'gateway.log'), join(hermesHome, 'agent.log')];
  const out = {};
  for (const file of files) {
    if (!existsSync(file)) continue;
    const matches = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => patterns.test(line)).slice(-maxLines).map(redact);
    out[file] = matches;
  }
  return out;
}

function renderText(report) {
  const lines = [];
  lines.push('# PR review healthcheck');
  lines.push(`repo: ${report.repo || '(unknown)'}`);
  lines.push(`worktree: ${report.worktree}`);
  lines.push('');
  lines.push('## Hermes config summary');
  if (!report.hermes.exists) lines.push(`missing: ${report.hermes.path}`);
  else lines.push(...report.hermes.summary.map((line) => `  ${line}`));
  lines.push('');
  lines.push('## GitHub rate limit');
  if (!report.rate.ok) lines.push(`ERROR: ${report.rate.error}`);
  else {
    lines.push(`core remaining: ${report.rate.core?.remaining}/${report.rate.core?.limit}`);
    lines.push(`graphql remaining: ${report.rate.graphql?.remaining}/${report.rate.graphql?.limit}`);
    lines.push(`search remaining: ${report.rate.search?.remaining}/${report.rate.search?.limit}`);
    if (report.rate.restFallbackRecommended) lines.push('REST fallback: REQUIRED (GraphQL exhausted, REST core available)');
  }
  lines.push('');
  lines.push('## Worktree dirty state');
  lines.push(`dirty: ${report.worktreeState.dirty}`);
  if (report.worktreeState.lines.length) lines.push(...report.worktreeState.lines.map((line) => `  ${line}`));
  if (report.worktreeState.stash) lines.push(`stash: ${report.worktreeState.stash.ok ? 'created' : 'failed'} ${report.worktreeState.stash.message}`);
  lines.push('');
  lines.push('## Open PR inventory (REST)');
  if (!report.openPulls.ok) lines.push(`ERROR: ${report.openPulls.error}`);
  else {
    lines.push(`open PRs: ${report.openPulls.count}`);
    for (const pr of report.openPulls.pulls) lines.push(`  #${pr.number} ${pr.title} [${pr.head} -> ${pr.base}] draft=${pr.draft} updated=${pr.updated_at}`);
  }
  if (report.prDetails) {
    lines.push('');
    lines.push(`## PR #${report.prDetails.number} REST details`);
    if (!report.prDetails.ok) lines.push(`ERROR: ${report.prDetails.error}`);
    else {
      lines.push(`title: ${report.prDetails.title}`);
      lines.push(`head: ${report.prDetails.head_sha}`);
      lines.push(`mergeable_state: ${report.prDetails.mergeable_state}`);
      lines.push('files:');
      for (const f of report.prDetails.files) lines.push(`  ${f.status} +${f.additions} -${f.deletions} ${f.filename}`);
      lines.push('check runs:');
      for (const c of report.prDetails.checks) lines.push(`  ${c.name}: ${c.status}/${c.conclusion || 'pending'}`);
      lines.push(`combined status: ${report.prDetails.combined_status.state}`);
    }
  }
  lines.push('');
  lines.push('## Recent Hermes timeout/rate-limit log matches');
  for (const [file, matches] of Object.entries(report.logs)) {
    lines.push(`### ${file}`);
    if (!matches.length) lines.push('  (none)');
    for (const line of matches) lines.push(`  ${line}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const worktree = resolve(args.worktree);
  const repo = args.repo || deriveRepo(worktree);
  const report = {
    repo,
    worktree,
    hermes: hermesConfigSummary(args.hermesHome),
    rate: githubRateLimit(),
    worktreeState: dirtyState(worktree, args.stash),
    openPulls: repo ? openPullsRest(repo) : { ok: false, error: 'repo not provided and could not derive from git remote' },
    prDetails: repo && args.pr ? prRestDetails(repo, args.pr) : null,
    logs: recentHermesLogs(args.hermesHome, args.logLines),
  };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderText(report));
  if (!report.openPulls.ok) return 3;
  if (report.worktreeState.dirty && !args.stash) return 2;
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(redact(error.stack || error.message));
  process.exit(1);
});
