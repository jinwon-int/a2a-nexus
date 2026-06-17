#!/usr/bin/env node
/**
 * Classify A2A/A2AD worker evidence before broker finalization.
 *
 * This is intentionally conservative: wrapper/plumbing outputs and source-root
 * bridge failures are not substantive worker opinions. Finalizers can still
 * report them as evidence, but must not count them as design/code review votes.
 *
 * Safety: local/offline JSON/text classifier only. No broker writes, no provider
 * sends, no GitHub mutation, no live network calls.
 */
import { readFileSync } from 'node:fs';

const SOURCE_BLOCKED_PATTERNS = [
  /analysis bridge blocked/i,
  /source root (?:unavailable|missing|not found)/i,
  /repo(?:sitory)? root (?:unavailable|missing|not found)/i,
  /A2A_ANALYSIS_REPO_MAP_JSON/i,
  /no mapped repo(?:sitory)?/i,
  /missing mapped repo(?:sitory)?/i,
  /unable to read source/i,
  /source bundle .*failed/i,
  /openclaw_analysis_failed/i,
  /Hermes analysis bridge response did not contain valid JSON/i,
  /Hermes exited with null/i,
  /handler_exit_nonzero/i,
  /source_blocked/i,
  /GitHub PR source unavailable/i,
  /PR diff .*unavailable/i,
  /gh pr (?:diff|view) failed/i,
  /pull request source .*unavailable/i,
];

const HARD_DEGRADED_PATTERNS = [
  /^\s*(?:echo handled task|echo fallback handled task)\b/i,
];

const WRAPPER_ONLY_PATTERNS = [
  /^\s*analysis-only completed\s*$/i,
  /^\s*analysis bridge done\s*$/i,
  /Hermes reference worker completed local dry-run evidence/i,
  /local dry-run evidence/i,
  /wrapper-only/i,
  /structured wrapper/i,
  /plumbing evidence/i,
  /echo handled task/i,
  /no substantive findings/i,
];

const READ_ONLY_VALIDATION_CHANGED_REPO_PATTERNS = [
  /read_only_validation_changed_repo/i,
  /read[- ]only .*repo(?:sitory)? .*changed/i,
  /read[- ]only .*github-verify .*write/i,
];

const HANDLER_ARTIFACT_FAILURE_PATTERNS = [
  /handler_artifact_failure/i,
  /docker_runner_failed/i,
  /without PR\/Done\/Block evidence/i,
  /canonical evidence is available/i,
  /missing_evidence/i,
];

const SUBSTANTIVE_MARKERS = [
  /recommendation/i,
  /GO|NO-GO|NO_GO|GO_CANDIDATE/i,
  /risk/i,
  /blocker/i,
  /evidence ref/i,
  /source evidence/i,
  /diff/i,
  /CI/i,
  /rollback/i,
  /acceptance/i,
  /trade[- ]?off/i,
  /implementation/i,
  /schema/i,
  /test/i,
];

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function collectText(value, acc = []) {
  if (value == null) return acc;
  if (typeof value === 'string') {
    acc.push(value);
    return acc;
  }
  if (typeof value !== 'object') {
    acc.push(String(value));
    return acc;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, acc);
    return acc;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/secret|token|authorization|password/i.test(key)) continue;
    collectText(item, acc);
  }
  return acc;
}

function classifyHardDegradedText(text) {
  const normalized = asText(text).trim();
  return HARD_DEGRADED_PATTERNS.filter((pattern) => pattern.test(normalized)).map((pattern) => pattern.source);
}

function matchPatternSources(patterns, text) {
  return patterns.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
}

function nonSubstantiveClassification(classification, blocker, reasons) {
  return {
    classification,
    substantive: false,
    countsAsWorkerOpinion: false,
    blockers: [blocker],
    reasons,
  };
}

function classifyEvidenceContractFailure(text) {
  const normalized = asText(text).trim();
  const readOnlyRepoMutation = matchPatternSources(READ_ONLY_VALIDATION_CHANGED_REPO_PATTERNS, normalized);
  if (readOnlyRepoMutation.length) {
    return nonSubstantiveClassification(
      'read_only_validation_changed_repo',
      'read-only evidence contract was violated by repository mutation; report as blocker, not worker opinion',
      readOnlyRepoMutation,
    );
  }

  const handlerArtifactFailure = matchPatternSources(HANDLER_ARTIFACT_FAILURE_PATTERNS, normalized);
  if (handlerArtifactFailure.length) {
    return nonSubstantiveClassification(
      'handler_artifact_failure',
      'handler/runner failed before canonical evidence was available; report as blocker, not worker opinion',
      handlerArtifactFailure,
    );
  }
  return null;
}

function hasGithubCommentLedger(value) {
  if (value == null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasGithubCommentLedger(item));
  const ledger = value.commentLedger;
  if (ledger && typeof ledger === 'object') {
    const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
    if (entries.length || /evidence ledger entries/i.test(asText(ledger.disclaimer))) return true;
  }
  return Object.values(value).some((item) => hasGithubCommentLedger(item));
}

export function classifyEvidenceText(text) {
  const normalized = asText(text).trim();
  if (!normalized) {
    return {
      classification: 'empty',
      substantive: false,
      countsAsWorkerOpinion: false,
      blockers: ['empty worker output'],
      reasons: ['no output text'],
    };
  }

  const sourceBlocked = SOURCE_BLOCKED_PATTERNS.filter((pattern) => pattern.test(normalized)).map((pattern) => pattern.source);
  if (sourceBlocked.length) {
    return {
      classification: 'source_blocked',
      substantive: false,
      countsAsWorkerOpinion: false,
      blockers: ['source mapping/analysis bridge failure must be resolved or supplemented before finalizer counts worker opinion'],
      reasons: sourceBlocked,
    };
  }

  const hardDegraded = classifyHardDegradedText(normalized);
  if (hardDegraded.length) {
    return {
      classification: 'wrapper_only',
      substantive: false,
      countsAsWorkerOpinion: false,
      blockers: ['wrapper/plumbing output must not be counted as substantive worker reasoning'],
      reasons: hardDegraded,
    };
  }

  const wrapperOnly = WRAPPER_ONLY_PATTERNS.filter((pattern) => pattern.test(normalized)).map((pattern) => pattern.source);
  const markers = SUBSTANTIVE_MARKERS.filter((pattern) => pattern.test(normalized)).map((pattern) => pattern.source);
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;

  if (wrapperOnly.length && markers.length < 2) {
    return {
      classification: 'wrapper_only',
      substantive: false,
      countsAsWorkerOpinion: false,
      blockers: ['wrapper/plumbing output must not be counted as substantive worker reasoning'],
      reasons: wrapperOnly,
    };
  }

  if (wordCount < 30 && markers.length < 4) {
    return {
      classification: 'thin',
      substantive: false,
      countsAsWorkerOpinion: false,
      blockers: ['worker output is too thin to count as substantive A2AD evidence'],
      reasons: [`wordCount=${wordCount}`, `markerCount=${markers.length}`],
    };
  }

  if (markers.length < 2) {
    return {
      classification: 'thin',
      substantive: false,
      countsAsWorkerOpinion: false,
      blockers: ['worker output is too thin to count as substantive A2AD evidence'],
      reasons: [`wordCount=${wordCount}`, `markerCount=${markers.length}`],
    };
  }

  return {
    classification: 'substantive',
    substantive: true,
    countsAsWorkerOpinion: true,
    blockers: [],
    reasons: markers,
  };
}

export function classifyEvidenceRecord(record, index = 0) {
  const workerId = record?.workerId ?? record?.assignedWorkerId ?? record?.worker?.id ?? record?.worker ?? record?.task?.assignedWorkerId ?? `record-${index + 1}`;
  const taskId = record?.taskId ?? record?.id ?? record?.task?.id ?? null;
  const directOutputReasons = classifyHardDegradedText(record?.output ?? record?.result?.output ?? record?.result?.summary);
  if (directOutputReasons.length) {
    return {
      workerId,
      taskId,
      classification: 'wrapper_only',
      substantive: false,
      countsAsWorkerOpinion: false,
      blockers: ['wrapper/plumbing output must not be counted as substantive worker reasoning'],
      reasons: directOutputReasons,
    };
  }
  const text = collectText({
    status: record?.status,
    result: record?.result,
    output: record?.output,
    body: record?.body,
    summary: record?.summary,
    analysis: record?.analysis,
    error: record?.error,
  }).join('\n');

  const contractFailure = classifyEvidenceContractFailure(text);
  if (contractFailure) {
    return {
      workerId,
      taskId,
      ...contractFailure,
    };
  }

  const ledgerMarkers = SUBSTANTIVE_MARKERS.filter((pattern) => pattern.test(text));
  if (hasGithubCommentLedger(record) && ledgerMarkers.length < 2) {
    return {
      workerId,
      taskId,
      ...nonSubstantiveClassification(
        'runner_ledger_only',
        'runner/GitHub comment ledger is reportable evidence but does not contain substantive worker findings',
        ['github comment ledger without substantive findings'],
      ),
    };
  }

  const classification = classifyEvidenceText(text);
  return {
    workerId,
    taskId,
    ...classification,
  };
}

export function classifyEvidenceBundle(input) {
  const records = Array.isArray(input)
    ? input
    : Array.isArray(input?.results)
      ? input.results
      : Array.isArray(input?.tasks)
        ? input.tasks
        : Array.isArray(input?.items)
          ? input.items
          : [input];
  const classifications = records.map((record, index) => classifyEvidenceRecord(record, index));
  const counts = classifications.reduce((acc, item) => {
    acc[item.classification] = (acc[item.classification] ?? 0) + 1;
    return acc;
  }, { substantive: 0 });
  const finalizerBlockers = classifications
    .filter((item) => !item.countsAsWorkerOpinion)
    .flatMap((item) => item.blockers.map((blocker) => `${item.workerId}: ${blocker}`));
  return {
    ok: counts.substantive > 0,
    counts,
    classifications,
    finalizerBlockers,
  };
}

function parseArgs(argv) {
  const options = { requireSubstantive: false, minSubstantive: 1, input: null, text: null, markdown: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') options.input = argv[++i];
    else if (arg === '--text') options.text = argv[++i];
    else if (arg === '--markdown') options.markdown = true;
    else if (arg === '--require-substantive') options.requireSubstantive = true;
    else if (arg === '--min-substantive') options.minSubstantive = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

function markdownCell(value) {
  return asText(value)
    .replace(/\r?\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim() || '—';
}

export function renderMarkdownReport(report) {
  const lines = [
    '| worker | classification | counts | blocker |',
    '| --- | --- | --- | --- |',
  ];
  for (const item of report.classifications) {
    lines.push(`| ${markdownCell(item.workerId)} | ${markdownCell(item.classification)} | ${item.countsAsWorkerOpinion ? 'yes' : 'no'} | ${markdownCell(item.blockers?.[0] ?? '')} |`);
  }
  lines.push('');
  lines.push(`substantive=${report.counts.substantive ?? 0}; finalizerBlockers=${report.finalizerBlockers.length}`);
  return `${lines.join('\n')}\n`;
}

function usage() {
  return `Usage: node scripts/a2ad-evidence-classifier.mjs --input results.json [--require-substantive] [--min-substantive N] [--markdown]\n       node scripts/a2ad-evidence-classifier.mjs --text "worker output" --require-substantive\n\nClassifies A2A/A2AD worker evidence as substantive, source_blocked, wrapper_only, read_only_validation_changed_repo, handler_artifact_failure, runner_ledger_only, thin, or empty.\nsource_blocked/wrapper_only/read_only_validation_changed_repo/handler_artifact_failure/runner_ledger_only/thin/empty evidence is reportable but must not be counted as a worker opinion.\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || (!options.input && !options.text)) {
    console.log(usage());
    process.exit(options.help ? 0 : 1);
  }
  const raw = options.text ?? readFileSync(options.input, 'utf8');
  const parsed = options.text ? { output: raw } : JSON.parse(raw);
  const report = classifyEvidenceBundle(parsed);
  console.log(options.markdown ? renderMarkdownReport(report) : JSON.stringify(report, null, 2));
  if (options.requireSubstantive && (report.counts.substantive ?? 0) < options.minSubstantive) {
    console.error(`a2ad evidence classifier blocked finalization: substantive=${report.counts.substantive ?? 0}, required=${options.minSubstantive}`);
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`a2ad evidence classifier failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
