import fs from 'node:fs';

const matrixPath = 'contracts/compatibility/matrix.md';
const text = fs.readFileSync(matrixPath, 'utf8');

const requiredRows = new Map([
  ['Broker', /^\| Broker \|[^\n]*\|\s*`[0-9a-f]{40}`\s*\|/m],
  ['OpenClaw plugin', /^\| OpenClaw plugin \|[^\n]*\|\s*`[0-9a-f]{40}`\s*\|/m],
  ['Docker runner', /^\| Docker runner \|[^\n]*\|\s*`[0-9a-f]{40}`\s*\|/m],
  ['Shared contracts', /^\| Shared contracts \|[^\n]*\|\s*`r[0-9]+-[a-z0-9.-]+`\s*\|/m],
  ['OpenClaw core', /^\| OpenClaw core \|[^\n]*\|\s*`[^`]+`\s*\|/m],
]);

const findings = [];
for (const [component, pattern] of requiredRows) {
  if (!pattern.test(text)) {
    findings.push(`${component}: missing exact current baseline`);
  }
}

const requiredSplitRepoRows = new Map([
  ['a2a-plane', /^\| `a2a-plane` \(internal tracker, private\) \|[^\n]*\|\s*`[0-9a-f]{40}`\s*\|[^\n]*\|\s*`[0-9a-f]{40}`\s*\|/m],
  ['a2a-broker', /^\| \[`a2a-broker`\]\([^)]+\) \|[^\n]*\|\s*`[0-9a-f]{40}`\s*\|[^\n]*\|\s*`[0-9a-f]{40}`\s*\|/m],
  ['openclaw-plugin-a2a', /^\| \[`openclaw-plugin-a2a`\]\([^)]+\) \|[^\n]*\|\s*`[0-9a-f]{40}`\s*\|[^\n]*\|\s*`[0-9a-f]{40}`\s*\|/m],
  ['a2a-docker-runner', /^\| \[`a2a-docker-runner`\]\([^)]+\) \|[^\n]*\|\s*`[0-9a-f]{40}`\s*\|[^\n]*\|\s*`[0-9a-f]{40}`\s*\|/m],
]);

for (const [repo, pattern] of requiredSplitRepoRows) {
  if (!pattern.test(text)) {
    findings.push(`${repo}: missing exact split-repo baseline and source-public marker`);
  }
}

if (!/source-public-20260511` markers are source\s+review markers only/.test(text)) {
  findings.push('source-public marker rationale is missing');
}

const unsupported = [
  /\bpending\b/i,
  /\btbd\b/i,
  /\bto be decided\b/i,
  /\bunknown\b/i,
  /\bgap\b/i,
];
for (const pattern of unsupported) {
  if (pattern.test(text)) {
    findings.push(`unsupported baseline wording matched ${pattern}`);
  }
}

if (!/A public release candidate must update this table with exact source commits\/tags/.test(text)) {
  findings.push('release rule must require exact source commits/tags');
}

if (findings.length) {
  console.error(JSON.stringify({ ok: false, findings }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, matrix: matrixPath, checked: [...requiredRows.keys()] }));
