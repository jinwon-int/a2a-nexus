#!/usr/bin/env node
/**
 * brokerAlpha A2A skill guard — executable guardpack checks for recurring
 * A2A/A2AD closeout rules.
 *
 * Read-only: no broker/GitHub writes, no deploy/restart/DB/provider side effects.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function itemsOf(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (isPlainObject(parsed) && Array.isArray(parsed.items)) return parsed.items;
  if (isPlainObject(parsed) && Array.isArray(parsed.tasks)) return parsed.tasks;
  return [];
}

function mergedPayload(manifest, lane) {
  const defaults = isPlainObject(manifest.defaults) ? manifest.defaults : {};
  return {
    ...(isPlainObject(defaults.payload) ? defaults.payload : {}),
    ...(isPlainObject(lane.payload) ? lane.payload : {}),
  };
}

function mergedIntent(manifest, lane) {
  const defaults = isPlainObject(manifest.defaults) ? manifest.defaults : {};
  return hasText(lane.intent) ? lane.intent : defaults.intent;
}

function checkManifest(manifest, mode, options = {}) {
  const errors = [];
  const lanes = Array.isArray(manifest.lanes) ? manifest.lanes : [];
  const maxArtifactChars = Number.isFinite(options.maxArtifactChars) ? options.maxArtifactChars : 24_000;
  if (lanes.length === 0) errors.push('manifest.lanes must be a non-empty array');

  lanes.forEach((lane, index) => {
    const tag = `lanes[${index}]`;
    const intent = mergedIntent(manifest, lane);
    const payload = mergedPayload(manifest, lane);
    const payloadMode = payload.mode;

    if (mode === 'a2ad') {
      if (payload.sourceOnly !== true || payload.noGitHubWrites !== true) {
        errors.push(`${tag}: source-only A2AD lanes must set sourceOnly=true and noGitHubWrites=true (#1035)`);
      }
      if (intent !== 'analyze' || payloadMode !== 'analysis-only') {
        errors.push(`${tag}: source-only A2AD lanes must use intent=analyze and payload.mode=analysis-only (#1035)`);
      }
    }

    if (mode === 'github-patch') {
      if (intent !== 'propose_patch' || payloadMode !== 'github-propose-patch') {
        errors.push(`${tag}: GitHub patch lanes must use intent=propose_patch and payload.mode=github-propose-patch (#1035)`);
      }
      if (payload.sourceOnly === true || payload.noGitHubWrites === true || payload.allowGitHubWrites === false) {
        errors.push(`${tag}: GitHub patch lanes must not be declared source-only/noGitHubWrites (#1035)`);
      }
    }

    const files = Array.isArray(payload.sourceBundle?.files) ? payload.sourceBundle.files : [];
    files.forEach((file, fileIndex) => {
      const content = hasText(file?.content) ? file.content : file?.contentText;
      if (hasText(content) && content.length > maxArtifactChars && !hasText(file.contentSummary)) {
        errors.push(`${tag}.payload.sourceBundle.files[${fileIndex}] ${file.path || '(unknown)'} exceeds raw artifact cap ${maxArtifactChars}; provide bounded content or contentSummary (#1027/#1035)`);
      }
    });
  });

  return { ok: errors.length === 0, errors, report: { command: 'manifest', mode, lanes: lanes.length, maxArtifactChars } };
}

function taskRound(task) {
  return task?.payload?.parentRoundId ?? task?.parentRoundId ?? '';
}

function isTerminal(status) {
  return ['succeeded', 'failed', 'blocked', 'canceled', 'timeout'].includes(String(status || '').toLowerCase());
}

function isSubstantiveSucceeded(task) {
  if (String(task?.status || '').toLowerCase() !== 'succeeded') return false;
  return classifyTaskEvidence(task).countsTowardScore === true;
}

function checkFormalEvidence(tasksInput, round, draft, baselineInput = null) {
  const tasks = itemsOf(tasksInput).filter((task) => !hasText(round) || taskRound(task) === round);
  const errors = [];
  const succeeded = tasks.filter(isSubstantiveSucceeded);
  const nonTerminal = tasks.filter((task) => !isTerminal(task.status));
  const claimsFormal = /formal\s+A2A|A2AD|quorum|consensus|succeeded/i.test(draft);

  if (claimsFormal && succeeded.length === 0) {
    errors.push('formal A2A/A2AD finalizer draft claims quorum/consensus but has no substantive succeeded task evidence (#1035)');
  }
  if (claimsFormal && succeeded.length > 0 && !succeeded.some((task) => draft.includes(task.id))) {
    errors.push('formal A2A/A2AD finalizer draft must cite succeeded task id(s) before claiming quorum (#1035)');
  }
  if (nonTerminal.length > 0) {
    errors.push(`formal A2A/A2AD finalizer draft has ${nonTerminal.length} non-terminal lane(s); finality is blocked (#1035)`);
  }

  const protectedIds = Array.isArray(baselineInput?.protectedAcceptedTaskIds) ? baselineInput.protectedAcceptedTaskIds : [];
  for (const taskId of protectedIds) {
    const regressionPattern = new RegExp(`${taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\n]*(?:rejected|failed|regress|downgraded|no-go)`, 'i');
    if (regressionPattern.test(draft)) {
      errors.push(`verifier regression detected for protected accepted task ${taskId} (#1027)`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    report: { command: 'formal-evidence', round, tasks: tasks.length, substantiveSucceeded: succeeded.map((task) => task.id), nonTerminal: nonTerminal.map((task) => task.id), protectedAcceptedTaskIds: protectedIds },
  };
}

function checkPrBodyBoundary(body, mode) {
  const errors = [];
  if (mode === 'pr-only-live-validation') {
    const match = body.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i);
    if (match) {
      errors.push(`PR-only live-validation body must use Refs #${match[1]} instead of closure keywords (#1035)`);
    }
    if (/deploy(?:ed)?|restart(?:ed)?|provider\s+send|terminal\s+ACK|DB\s+mutation/i.test(body)) {
      errors.push('PR-only live-validation body must not claim deploy/restart/provider/ACK/DB side effects (#1035)');
    }
  }
  return { ok: errors.length === 0, errors, report: { command: 'pr-body-boundary', mode } };
}

function checkRepoSweepCloseout(issuesInput, prsInput) {
  const issues = itemsOf(issuesInput).filter((issue) => String(issue.state || '').toUpperCase() !== 'CLOSED');
  const prs = itemsOf(prsInput).filter((pr) => String(pr.state || '').toUpperCase() !== 'CLOSED' && String(pr.state || '').toUpperCase() !== 'MERGED');
  const errors = [];
  if (issues.length > 0) errors.push(`repo sweep closeout blocked: open issues: ${issues.length} (#1035)`);
  if (prs.length > 0) errors.push(`repo sweep closeout blocked: open PRs: ${prs.length} (#1035)`);
  return { ok: errors.length === 0, errors, report: { command: 'repo-sweep-closeout', openIssues: issues.map((i) => i.number), openPrs: prs.map((p) => p.number) } };
}

function nestedText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(nestedText).join(' ');
  if (typeof value === 'object') return Object.values(value).map(nestedText).join(' ');
  return '';
}

function classifyTaskEvidence(task) {
  const text = nestedText({ output: task?.output, error: task?.error, status: task?.status });
  const status = String(task?.status || '').toLowerCase();
  if (/docker_runner_failed|public safe-default|token file exposure|handler_exit_nonzero|provider_or_model_failure/i.test(text)) {
    return { evidenceClass: 'infra_blocker', countsTowardScore: false };
  }
  if (/generic\s+a2ad-review\s+task\s+accepted|wrapper_only|prompt echo|analysis-only completed/i.test(text)) {
    return { evidenceClass: 'wrapper_only', countsTowardScore: false };
  }
  if (/sourceBundle\.files\[\]|source projection|0\s+files|prompt budget|truncat/i.test(text)) {
    return { evidenceClass: 'source_projection_blocked', countsTowardScore: false };
  }
  if (status === 'succeeded') return { evidenceClass: 'substantive', countsTowardScore: true };
  if (status === 'running' || status === 'queued' || status === 'claimed') return { evidenceClass: 'missing_evidence', countsTowardScore: false };
  return { evidenceClass: status || 'unknown', countsTowardScore: false };
}

function numericValue(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function buildScorecard(tasksInput) {
  const tasks = itemsOf(tasksInput);
  const rows = tasks.map((task) => ({ id: task.id, status: task.status, ...classifyTaskEvidence(task) }));
  const counts = rows.reduce((acc, row) => {
    acc[row.evidenceClass] = (acc[row.evidenceClass] ?? 0) + 1;
    return acc;
  }, {});
  const totalCostUsd = tasks.reduce((sum, task) => sum + numericValue(task.costUsd, task.estimatedCostUsd, task.output?.costUsd, task.output?.estimatedCostUsd), 0);
  const acceptedChanges = tasks.reduce((sum, task) => {
    const evidence = classifyTaskEvidence(task);
    if (!evidence.countsTowardScore) return sum;
    return sum + numericValue(task.acceptedChanges, task.output?.acceptedChanges, task.output?.acceptedChangeCount, 1);
  }, 0);
  const costPerAcceptedChangeUsd = acceptedChanges > 0 ? totalCostUsd / acceptedChanges : null;
  return { ok: true, errors: [], report: { command: 'scorecard', rows, counts, cost: { totalCostUsd, acceptedChanges, costPerAcceptedChangeUsd } } };
}

function runGuard(argv) {
  const command = argv[0];
  try {
    if (command === 'manifest') {
      const { values } = parseArgs({ args: argv.slice(1), options: { manifest: { type: 'string' }, mode: { type: 'string', default: 'a2ad' }, 'max-artifact-chars': { type: 'string', default: '24000' } } });
      const maxArtifactChars = Number.parseInt(values['max-artifact-chars'], 10);
      return checkManifest(readJson(values.manifest), values.mode, { maxArtifactChars });
    }
    if (command === 'formal-evidence') {
      const { values } = parseArgs({ args: argv.slice(1), options: { 'round-status': { type: 'string' }, round: { type: 'string', default: '' }, 'finalizer-draft': { type: 'string' }, baseline: { type: 'string', default: '' } } });
      const baseline = hasText(values.baseline) ? readJson(values.baseline) : null;
      return checkFormalEvidence(readJson(values['round-status']), values.round, readText(values['finalizer-draft']), baseline);
    }
    if (command === 'pr-body-boundary') {
      const { values } = parseArgs({ args: argv.slice(1), options: { body: { type: 'string' }, mode: { type: 'string', default: 'pr-only-live-validation' } } });
      return checkPrBodyBoundary(readText(values.body), values.mode);
    }
    if (command === 'repo-sweep-closeout') {
      const { values } = parseArgs({ args: argv.slice(1), options: { issues: { type: 'string' }, prs: { type: 'string' } } });
      return checkRepoSweepCloseout(readJson(values.issues), readJson(values.prs));
    }
    if (command === 'scorecard') {
      const { values } = parseArgs({ args: argv.slice(1), options: { tasks: { type: 'string' } } });
      return buildScorecard(readJson(values.tasks));
    }
    return { ok: false, errors: [`unknown command '${command || ''}'`], report: null };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)], report: null };
  }
}

function main() {
  const outcome = runGuard(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  process.exit(outcome.ok ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('a2a-skill-guard.mjs')) {
  main();
}

export {
  runGuard,
  classifyTaskEvidence,
  checkManifest,
  checkFormalEvidence,
  checkPrBodyBoundary,
  checkRepoSweepCloseout,
  buildScorecard,
};
