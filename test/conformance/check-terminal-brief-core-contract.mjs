import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const contractPath = path.join(root, 'contracts/a2a/terminal-brief-core-contract.md');
const contractText = fs.readFileSync(contractPath, 'utf8');

let failures = [];
let passes = 0;

function assert(label, condition, detail) {
  if (condition) {
    passes++;
  } else {
    failures.push({ label, detail });
    process.stderr.write(`FAIL: ${label}${detail ? ` — ${detail}` : ''}\n`);
  }
}

// File presence
assert('Contract file exists', fs.existsSync(contractPath));

// --- Structure sections ---
assert('Contains title format section', /## 1\. Title format/.test(contractText));

// Title format rules
assert('Contains default known-total format',
  /A2A Terminal Brief.*worker.*N/.test(contractText) || /default.*known.total/i.test(contractText));
assert('Contains canonical raw compact title example',
  /A2A Terminal Brief 완료: yukson\(완료 3\/7\)/.test(contractText));
assert('Contains unknown-total fallback',
  /unknown-total fallback|unknown total/i.test(contractText) || /no denominator/.test(contractText));
assert('Contains 80 char max constraint', /80 characters|80 chars/.test(contractText));
assert('Contains forbidden title content', /forbidden title content/i.test(contractText));

// Ownership matrix
assert('Contains ownership matrix section', /## 2\. Ownership matrix|Ownership matrix/.test(contractText));
assert('Contains 4 routing cases', /Case.*\|.*Initiator/.test(contractText) || /Case 1.*seoseo/g.test(contractText));
assert('Contains finalizer assignment', /finalizer assignment|Finalizer of record/i.test(contractText));
assert('Contains network of ownership', /Network of ownership/.test(contractText));

// Handoff metadata
assert('Contains handoff metadata section', /## 3\. Parent-owned handoff metadata|Parent-owned handoff metadata/.test(contractText));
assert('Contains parentRoundId field', /parentRoundId/.test(contractText));
assert('Contains originBrokerId field', /originBrokerId/.test(contractText));
assert('Contains parentBrokerId field', /parentBrokerId/.test(contractText));
assert('Contains handoffBrokerId field', /handoffBrokerId/.test(contractText));
assert('Contains no-local-send rule', /no-local-send|no local send/i.test(contractText));
assert('Contains body/evidence separation', /body.evidence separation|separate fields/i.test(contractText));

// ACK eligibility
assert('Contains ACK eligibility section', /## 4\. ACK eligibility rules|ACK eligibility/.test(contractText));
assert('Contains 4 receipt levels with ACK-safe column',
  /Level.*\|.*Name.*\|.*ACK/.test(contractText) ||
  /\| 1.*accepted-send.*No/.test(contractText));
assert('Contains non-ACK invariants', /non-ACK invariants/i.test(contractText));
assert('Contains ACK-safe requirements', /manual_operator_receipt|current_session_visible/.test(contractText));

// Legacy residue
assert('Contains legacy residue handling section', /## 5\. Legacy residue handling|Legacy residue/.test(contractText));
assert('Contains legacy residue definition', /pre-v0|v0.*v1.*transition|quarantine/i.test(contractText));
assert('Contains residue classes', /Pre-v0 metadata|Stale projection|Orphan projection/.test(contractText));
assert('Contains quarantine lifecycle', /quarantine.*lifecycle|quarantine.*window|2026-06-22/i.test(contractText));

// Source-to-deploy checklist
assert('Contains source-to-deploy section', /## 6\. Source-to-deploy verification checklist|Source-to-deploy/.test(contractText));
assert('Contains pre-PR gates', /Pre-PR gates|P1.*P2.*P3/i.test(contractText));
assert('Contains pre-deploy gates', /Pre-deploy gates|D1.*D2.*D3/i.test(contractText));
assert('Contains post-deploy verification', /Post-deploy verification|V1.*V2.*V3/i.test(contractText));

// Safety
assert('Contains safety section', /## 7\. Safety gate|## \d+\. Safety/.test(contractText));
assert('Contains prohibited actions table', /prohibited actions/i.test(contractText));
assert('Contains safety confirmation block', /safety confirmation block/i.test(contractText));
assert('Contains runtime/bootstrap hygiene check', /hygiene.*AGENTS|hygiene.*SOUL|guard path/i.test(contractText));

// Hygiene scan
assert('Contains hygiene scan section', /## 8\. Hygiene scan|guard path scan/i.test(contractText));

// Conformance
assert('Contains conformance section', /## \d+\. Conformance|node test.conformance/i.test(contractText));

// Residual risk
assert('Contains residual risk section', /## 10\. Residual risk|Residual risk/i.test(contractText));

// --- Cross-reference map ---
assert('References parent-terminal-brief-aggregation.md',
  /parent-terminal-brief-aggregation/.test(contractText));
assert('References terminal-semantics.md',
  /terminal-semantics/.test(contractText));
assert('References broker-handoff-protocol.md',
  /broker-handoff-protocol/.test(contractText));

// --- Secret/redaction checks ---
const secretPatterns = [
  /ghp_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]+/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/,
  /\/home\/[A-Za-z0-9._-]+\//,
  /\/Users\/[A-Za-z0-9._-]+\//,
];

for (const pattern of secretPatterns) {
  assert(`No secret pattern: ${pattern}`, !pattern.test(contractText));
}

// --- OpenClaw runtime/bootstrap path guard ---
const forbiddenRuntimePaths = [
  'AGENTS.md',
  'SOUL.md',
  'USER.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  '.openclaw/',
];

// Forbidden OpenClaw runtime paths are legitimate inside fenced code blocks
// (the hygiene-scan find command) and as inline code (`AGENTS.md`) in the gate
// table, but must never appear as bare prose where they read like an
// instruction to create them. Track fenced code blocks and flag any bare
// (non-backticked) prose reference.
{
  const lines = contractText.split('\n');
  let inFence = false;
  const proseOffenders = [];
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const forbiddenPath of forbiddenRuntimePaths) {
      if (line.includes(forbiddenPath) && !line.includes('`' + forbiddenPath)) {
        proseOffenders.push(`${forbiddenPath}: ${line.trim().slice(0, 80)}`);
      }
    }
  }
  assert(
    'OpenClaw runtime paths appear only in code/inline-code, never bare prose',
    proseOffenders.length === 0,
    proseOffenders.length ? proseOffenders.join(' | ') : undefined,
  );
}

// --- Summary ---
const total = passes + failures.length;
const result = {
  ok: failures.length === 0,
  checkedContract: 'contracts/a2a/terminal-brief-core-contract.md',
  passes,
  failures: failures.length,
  total,
};

if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.length}/${total} checks failed`);
  process.exit(1);
}

console.log(JSON.stringify(result, null, 2));
