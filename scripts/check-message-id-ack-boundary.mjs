/**
 * Fail-closed scan for provider-message-id-as-ACK equivocation wording.
 *
 * Provider message id / send success is provider accepted-send evidence only,
 * not ACK evidence. This script scans tracked files for prohibited wording
 * that would treat provider acceptance as terminal ACK, operator-visible
 * receipt, or receipt confirmation.
 *
 * Safety: read-only scan. No deploy, no restart, no live send.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const skipDirs = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const SELF = 'scripts/check-message-id-ack-boundary.mjs';
const SELF_TEST = 'scripts/check-message-id-ack-boundary.test.mjs';

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((file) => !file.split('/').some((part) => skipDirs.has(part)))
      .sort();
  } catch {
    const out = [];
    function walk(dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (!skipDirs.has(ent.name)) walk(p);
        } else {
          out.push(path.relative(root, p).replaceAll('\\', '/'));
        }
      }
    }
    walk(root);
    return out.sort();
  }
}

/**
 * Prohibited wording patterns.
 *
 * Each pattern matches a positive claim that provider acceptance / message id /
 * send success constitutes ACK, receipt, or confirmation evidence.
 */
const prohibitedPatterns = [
  {
    label: 'provider-message-id-as-ACK',
    re: /\bprovider\s+message\s+(?:id|identifier).*\b(?:is|proves|confirms|constitutes|equals|serves\s+as|acts\s+as|functions\s+as|provides|delivers|guarantees)\b.*\b(?:ACK|receipt|acknowledgement|confirmation|proof)\b/i,
  },
  {
    label: 'send-success-is-ACK',
    re: /\b(?:provider|message)\s+send\s+success.*\b(?:is|proves|confirms|constitutes|equals|serves\s+as)\b.*\b(?:ACK|receipt|acknowledgement|confirmation|terminal)\b/i,
  },
  {
    label: 'messageId-is-ACK',
    re: /\bmessageId\b.*\b(?:is|proves|confirms|constitutes|equals|serves\s+as)\b.*\b(?:ACK|receipt|confirmation|proof)\b.*(?:evidence|signal|indicator)/i,
  },
  {
    label: 'providerAccepted-is-receipt',
    re: /\bproviderAccepted\b.*\b(?:is|proves|confirms|constitutes)\b.*\b(?:receipt|ACK|confirmation)\b/i,
  },
  {
    label: 'accepted-equals-acknowledged',
    re: /\bprovider\s+(?:accepted|acceptance)\b.*\b(?:equals|same\s+as|equivalent\s+to|means|implies)\b.*\b(?:acknowledged|ACK|receipt)\b/i,
  },
  {
    label: 'send-evidence-is-terminal-ACK',
    re: /\b(?:provider|send)\s+(?:success|accepted|sent)\b[^\n]*(?:is|proves|confirms|constitutes|equals|serves\s+as|acts\s+as|means|implies)\b[^\n]*(?:terminal|outbox)\s+ACK\b(?!\s+mutation)/i,
  },
];

/** Words that mark a line as a prohibition/negation/safe context. */
const negationTerms = /\b(?:cannot|can\s*not|do\s*not|does\s*not|must\s*not|should\s*not|will\s*not|may\s*not|is\s*not|are\s*not|not\b|isn['’]t|aren['’]t|don['’]t|doesn['’]t|won['’]t|without|never|non[_-]?ACK|fail[_-]?closed|unproven|insufficient)\b/i;

/**
 * Block-level rejection markers: headings or lead-in lines that introduce a
 * list/section of prohibited or unsafe patterns. When one of these is detected,
 * subsequent list items (bullet/dash/numbered) within a contiguous block are
 * treated as rejection-context.
 */
const blockRejectMarkers = [
  /\bUnsafe\s+bypass\s+patterns?\s+to\s+reject\b/i,
  /\bDo\s+not\s+merge\s+(?:or\s+run\s+)?changes?\b/i,
  /\bmust\s+not\s+do\s+any\s+of\s+the\s+following\b/i,
  /\bForbidden:?\s*$/i,
  /\bProhibited:?\s*$/i,
  /\bReject:?\s*$/i,
  /\bNO[_-]?GO\s+trigger[s]?\b/i,
];

const BULLET_RE = /^\s*(?:[-*•]|\d+[.)]\s)/;

/**
 * Build a boolean array parallel to `lines`: entry is true when the line at
 * that index is inside a rejection-context block (a bullet/list item following
 * a block-level rejection marker within the same contiguous block).
 */
function buildRejectionBlockMap(lines) {
  const map = new Array(lines.length).fill(false);
  let inRejectionBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Heading ends a rejection block
    if (/^#/.test(trimmed)) {
      inRejectionBlock = false;
    }

    // Non-empty non-bullet non-heading line that isn't a rejection marker ends the block.
    // Empty lines and bullet items preserve the current block state.
    if (trimmed !== '' && !BULLET_RE.test(lines[i]) && !/^#/.test(trimmed)) {
      let isMarker = false;
      for (const marker of blockRejectMarkers) {
        if (marker.test(lines[i])) {
          isMarker = true;
          inRejectionBlock = true;
          break;
        }
      }
      if (!isMarker) {
        inRejectionBlock = false;
      }
    }

    // Mark this line as in rejection context if it's a list item in a block
    if (inRejectionBlock && BULLET_RE.test(lines[i])) {
      map[i] = true;
    }
  }
  return map;
}

/**
 * Cheap literal prefilter: every prohibited pattern requires one of these
 * lowercase substrings ('provider', 'send', or 'messageid'), so any file or
 * line without them can skip the regex sweep — and the rejection-block map is
 * only built for files that still have a candidate line. Findings are
 * identical to the unfiltered sweep; this only skips lines that cannot match.
 */
const PREFILTER_LITERALS = ['provider', 'send', 'messageid'];

function hasCandidateLiteral(lowerText) {
  return PREFILTER_LITERALS.some((literal) => lowerText.includes(literal));
}

const findings = [];

for (const file of trackedFiles()) {
  // Exclude self and self-test
  if (file === SELF || file === SELF_TEST) continue;

  // Only scan text-like files
  if (!/\.(?:md|mjs|cjs|js|ts|mts|cts|json|ya?ml|toml|txt|css|html)$/.test(file)) continue;

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  if (!hasCandidateLiteral(text.toLowerCase())) continue;

  const lines = text.split(/\r?\n/);
  let rejectionBlock = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!hasCandidateLiteral(line.toLowerCase())) continue;

    // Skip lines that are themselves negated
    if (negationTerms.test(line)) continue;

    // Skip lines inside a rejection/prohibition block (map built lazily, only
    // for files that reach a candidate line)
    rejectionBlock ??= buildRejectionBlockMap(lines);
    if (rejectionBlock[i]) continue;

    for (const { label, re } of prohibitedPatterns) {
      if (re.test(line)) {
        findings.push({ kind: label, file, line: i + 1 });
      }
    }
  }
}

if (findings.length) {
  console.error(JSON.stringify({ ok: false, message: 'provider-message-id-as-ACK wording detected', findings }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, message: 'no provider-message-id-as-ACK wording found' }));
