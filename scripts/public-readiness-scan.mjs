import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const strictInternal = process.env.PUBLIC_READINESS_STRICT_INTERNAL === '1' || process.argv.includes('--strict-internal');
const deny = [
  { kind: 'runtime-bootstrap', severity: 'fail', re: /^(AGENTS|SOUL|USER|TOOLS|HEARTBEAT|IDENTITY)\.md$/ },
  { kind: 'openclaw-state', severity: 'fail', re: /^\.openclaw\// },
  { kind: 'secret-assignment', severity: 'fail', re: /^\s*(?:export\s+)?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Z0-9_]*\s*=\s*['"]?(?!<|\\?\$\{|YOUR_|\/path\/to\/)[^'"\s#]{12,}/ },
  { kind: 'github-token-shape', severity: 'fail', re: /\b(ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { kind: 'old-monorepo-surface', severity: 'fail', re: /(?:github\.com\/jinwon-int\/a2a(?:[\/#]|$)|\bjinwon-int\/a2a(?:[#\s`]|$)|@jinwon-int\/a2a-monorepo\b)/ },
  { kind: 'private-a2a-plane-link', severity: 'fail', re: /(?:https?:\/\/github\.com\/)?jinwon-int\/a2a-plane(?:[\/#]|$)/i },
  { kind: 'operator-personal-name', severity: 'fail', re: /\bSeo\s+Jin\s+On\b|\uC11C\uC9C4\uC6D0/ },
  { kind: 'operator-private-channel', severity: 'fail', re: /Telegram\s+DM|private\s+DM\s+from/i },
  { kind: 'internal-node-identifier', severity: strictInternal ? 'fail' : 'warn', re: /\b(?:seoseo|nosuk|sogyo|bangtong|yukson|dungae|jingun|soonwook|daegyo|gwakga|gongmyoung|gongyung)\b/i },
  {
    kind: 'post-78261-readiness-claim', severity: 'fail',
    re: /\b(?:openclaw\/openclaw#)?78261(?:\s+(?:closure|close|closed))?\s+(?:unblocks?|greenlights?|authori[sz]es|approves?)\s+(?:terminal brief\s+or\s+)?public[- ]readiness\b/i,
  },
];
const skipDirs = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const allowWarningPaths = [/^scripts\/public-readiness-scan(?:\.test)?\.mjs$/, /^docs\/history\//, /^fixtures\//, /^contracts\//, /^packages\/broker\/fixtures\//, /^docs\/validation\//, /^docs\/roadmap\//, /^docs\/approval-rehearsal\//, /^docs\/dry-run\//, /^docs\/execution-orchestrator\//, /^docs\/final-approval\//];

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    const rel = path.relative(process.cwd(), p).replaceAll('\\', '/');
    if (ent.isDirectory()) {
      if (!skipDirs.has(ent.name)) out.push(...walk(p));
    } else out.push(rel);
  }
  return out;
}

function candidateFiles() {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).filter(Boolean)
      .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile())
      .filter((file) => !file.split('/').some((part) => skipDirs.has(part)))
      .filter((file) => !/(^|\/)(?:test|tests|__tests__)\//.test(file))
      .filter((file) => !/\.(?:test|spec)\.(?:ts|mts|cts|js|mjs|cjs)$/.test(file))
      .sort();
  } catch { return walk(process.cwd()).sort(); }
}

function isAllowedWarning(file) { return allowWarningPaths.some((re) => re.test(file)); }
const findings = [];
for (const file of candidateFiles()) {
  for (const rule of deny) {
    if (rule.re.test(file)) findings.push({ kind: rule.kind, severity: rule.severity, file });
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  text.split(/\r?\n/).forEach((line, i) => {
    for (const rule of deny.slice(2)) {
      if (!rule.re.test(line)) continue;
      const severity = (rule.kind === 'internal-node-identifier' && isAllowedWarning(file))
        || (rule.kind === 'operator-personal-name' && file === 'LICENSE')
        ? 'warn'
        : rule.severity;
      findings.push({ kind: rule.kind, severity, file, line: i + 1 });
    }
  });
}
const failures = findings.filter((f) => f.severity !== 'warn');
if (failures.length) {
  console.error(JSON.stringify({ ok: false, findings, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, findings, warnings: findings.filter((f) => f.severity === 'warn') }));
