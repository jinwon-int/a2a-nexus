#!/usr/bin/env node
/**
 * Blind finalizer view (#2396, harness2 benchmarking A2A 3/3).
 *
 * The A2A finalizer is the hub agent session; when a plan round asks it to
 * "select the best candidate" it reads lanes whose records name the worker,
 * runtime, and model. harness2 picks between candidates blind: non-responders
 * are dropped before anonymisation, the rest get seed-shuffled ids, the pick
 * must be a strict block naming a runner-up, and a malformed pick is a FLAGGED
 * fallback, never a silent default.
 *
 * Offline and broker-independent like a2ad-finalizer-gate.mjs:
 *
 * Usage: node scripts/lib/a2ad-blind-view.mjs <build|resolve> …
 *
 *   build    --tasks <records.json> --round <parentRoundId> [--target <key>] --out <dir>
 *            Writes <dir>/blind-bundle.md (what the finalizer reads) and
 *            <dir>/id-map.json (0600; do not open before judging).
 *   resolve  --out <dir> --verdict <file> [--named-pick <laneId>] [--shadow-ledger <file>]
 *            Parses the ```pick``` block, maps the blind id back to the lane
 *            and worker (dialectic-lite / gate attribution stays intact), and
 *            with --named-pick appends one anonymous shadow record.
 *
 * Measurement only: nothing here changes a gate or dialectic-lite verdict.
 * Needs full task records (GET /tasks/:id or ?detail=full) for the #2393
 * completion marker, same as the gate.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { laneCompletion, laneOutput, readTasks, targetKey } from '../a2ad-finalizer-gate.mjs';
import { forbiddenIdentifierViolation, maskForbiddenIdentifiers } from '../check-lane-reliability-ledger.mjs';

export const BLIND_VIEW_SCHEMA = 'a2a.finalizer.blind-view.v1';
export const BLIND_SHADOW_SCHEMA = 'a2a.finalizer.blind-shadow.v1';
export const PICK_FIELDS = ['id', 'criterion', 'runnerUp', 'runnerUpLoss'];

const CONTENT_ARRAYS = ['findings', 'risks', 'recommendations', 'blockerFindings', 'nonBlockingFindings', 'evidenceRefs'];

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function itemText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(itemText).join(' ');
  if (typeof value === 'object') return Object.values(value).map(itemText).join(' ');
  return '';
}

function laneStatus(lane) {
  return String(lane.status ?? lane.result?.status ?? '').trim().toLowerCase();
}

/** Blind ids: A..Z, then A1..Z1, … */
export function blindLabel(index) {
  const letter = String.fromCharCode(65 + (index % 26));
  const cycle = Math.floor(index / 26);
  return cycle === 0 ? letter : `${letter}${cycle}`;
}

/**
 * Deterministic, label-order-independent order: sort by sha1(seed|laneId).
 * The same task key and round always give the same ids (cache-stable reruns);
 * the ids carry no information about worker, runtime, or dispatch order.
 */
export function blindOrder(laneIds, seed) {
  return [...laneIds]
    .map((id) => ({ id, key: createHash('sha1').update(`${seed}|${id}`).digest('hex') }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : 1))
    .map((entry) => entry.id);
}

/** Why a lane is excluded before anonymisation, or '' when it is a candidate. */
export function dropReason(lane) {
  const status = laneStatus(lane);
  if (status !== 'succeeded') return `status:${status || 'unknown'}`;
  const completion = laneCompletion(lane);
  if (completion.state === 'unmarked') return `unmarked${completion.reason ? `:${completion.reason}` : ''}`;
  const output = laneOutput(lane);
  const summary = itemText(output.analysisSummary ?? output.summary).trim();
  const anyItems = CONTENT_ARRAYS.some((key) => Array.isArray(output[key]) && output[key].length > 0);
  if (!summary && !anyItems) return 'empty';
  return '';
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskAll(value, counter) {
  let { text, count } = maskForbiddenIdentifiers(itemText(value).replace(/\s+/g, ' ').trim());
  // Task ids can name the lane's role or node; outputs sometimes echo them.
  if (counter.laneIdPattern) {
    text = text.replace(counter.laneIdPattern, () => {
      count += 1;
      return '[lane]';
    });
  }
  counter.count += count;
  return text;
}

/** Candidate body: content only, identity masked. No worker/runtime/model/harness fields. */
export function renderCandidate(blindId, lane, counter) {
  const output = laneOutput(lane);
  const lines = [`## Candidate ${blindId}`, '', 'COMPLETE -- nothing trimmed', ''];
  const summary = maskAll(output.analysisSummary ?? output.summary, counter);
  if (summary) lines.push(`Summary: ${summary}`, '');
  if (hasText(output.verdict)) lines.push(`Verdict: ${maskAll(output.verdict, counter)}`, '');
  for (const key of CONTENT_ARRAYS) {
    if (!Array.isArray(output[key]) || output[key].length === 0) continue;
    lines.push(`${key}:`);
    for (const item of output[key]) {
      const text = maskAll(item, counter);
      if (text) lines.push(`- ${text}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const JUDGE_INSTRUCTIONS = [
  'Pick the candidate that best answers the round, judging the outputs only. The ids are arbitrary.',
  'Order of criteria: DELIVERY (answers what was asked) → CONFORMANCE (respects stated boundaries) →',
  'FIDELITY (claims match the cited source) → CONSISTENCY → OPERATIONAL FITNESS → FINISH.',
  'Length and polish are not merits. Prefer a candidate that says the source is silent when it is.',
  'This records which output looked best, not which edit would work.',
  'Answer with exactly one fenced block:',
  '',
  '```pick',
  '{"id": "<blind id>", "criterion": "<deciding criterion>", "runnerUp": "<blind id or null>", "runnerUpLoss": "<why the runner-up lost>"}',
  '```',
].join('\n');

export function buildBlindView(tasks, { round, target } = {}) {
  if (!hasText(round)) throw new Error('--round <parentRoundId> is required');
  let lanes = tasks.filter((t) => String((t.payload || {}).parentRoundId || '') === String(round));
  if (lanes.length === 0) throw new Error(`no lanes with payload.parentRoundId=${round}`);
  const targets = [...new Set(lanes.map(targetKey))].sort();
  if (hasText(target)) {
    lanes = lanes.filter((lane) => targetKey(lane) === target);
    if (lanes.length === 0) throw new Error(`no lanes for --target ${target}; targets: ${targets.join(', ')}`);
  } else if (targets.length > 1) {
    throw new Error(`round has ${targets.length} targets; choose one with --target (${targets.join(', ')})`);
  }
  const effectiveTarget = hasText(target) ? target : targets[0];

  const dropped = [];
  const candidates = [];
  for (const lane of lanes) {
    const reason = dropReason(lane);
    if (reason) dropped.push({ laneId: lane.id, reason });
    else candidates.push(lane);
  }
  const seed = `${effectiveTarget}|${round}`;
  const ordered = blindOrder(candidates.map((lane) => lane.id), seed);
  const byId = new Map(candidates.map((lane) => [lane.id, lane]));
  const laneIds = lanes.map((lane) => String(lane.id)).filter(Boolean).sort((a, b) => b.length - a.length);
  const counter = { count: 0, laneIdPattern: laneIds.length ? new RegExp(laneIds.map(escapeRegExp).join('|'), 'g') : null };
  const idMap = {};
  const sections = [];
  ordered.forEach((laneId, index) => {
    const blindId = blindLabel(index);
    const lane = byId.get(laneId);
    idMap[blindId] = {
      laneId,
      workerId: lane.assignedWorkerId || lane.targetNodeId || lane.target?.id || null,
      completion: laneCompletion(lane).state,
    };
    sections.push(renderCandidate(blindId, lane, counter));
  });
  const legacyCount = ordered.filter((id) => laneCompletion(byId.get(id)).state === 'legacy').length;

  const header = [
    `# Blind finalizer view — round ${maskForbiddenIdentifiers(round).text}`,
    '',
    `schema: ${BLIND_VIEW_SCHEMA}`,
    `candidates: ${ordered.length} · dropped before anonymisation: ${dropped.length} · identity tokens masked: ${counter.count}` +
      (legacyCount ? ` · pre-#2393 lanes without a completion marker: ${legacyCount}` : ''),
    '',
    JUDGE_INSTRUCTIONS,
    '',
  ].join('\n');
  const bundle = `${header}\n${sections.join('\n')}`;
  // The bundle must be identity-free. Masking is token-based, so re-check the
  // whole rendered text fail-closed rather than trusting it.
  const leak = forbiddenIdentifierViolation(bundle.replace(/(?:https?:\/\/|github\.com\/)\S*/g, ''));
  if (leak) throw new Error(`blind bundle still carries an identity token after masking: ${leak}`);

  return {
    bundle,
    idMap: {
      schema: BLIND_VIEW_SCHEMA,
      round,
      target: effectiveTarget,
      seed: createHash('sha1').update(seed).digest('hex'),
      candidates: idMap,
      dropped,
      maskCount: counter.count,
    },
  };
}

/**
 * Strict pick parsing: exactly one ```pick``` block holding a JSON object whose
 * id (and runnerUp, when given) are known blind ids. Anything else is a
 * flagged fallback — never a silent default.
 */
export function parsePick(text, knownIds) {
  const blocks = [...String(text ?? '').matchAll(/```pick[ \t]*\r?\n([\s\S]*?)```/g)];
  const fail = (reason) => ({ fallback: true, fallbackReason: reason, pick: null });
  if (blocks.length === 0) return fail('no_pick_block');
  if (blocks.length > 1) return fail('multiple_pick_blocks');
  let parsed;
  try {
    parsed = JSON.parse(blocks[0][1].trim());
  } catch {
    return fail('pick_not_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('pick_not_object');
  const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
  if (!knownIds.includes(id)) return fail('unknown_id');
  if (!hasText(parsed.criterion)) return fail('missing_criterion');
  const runnerUp = parsed.runnerUp == null || parsed.runnerUp === '' ? null : String(parsed.runnerUp).trim();
  if (knownIds.length > 1) {
    if (!runnerUp) return fail('missing_runner_up');
    if (!knownIds.includes(runnerUp) || runnerUp === id) return fail('invalid_runner_up');
    if (!hasText(parsed.runnerUpLoss)) return fail('missing_runner_up_loss');
  }
  return {
    fallback: false,
    fallbackReason: null,
    pick: {
      id,
      criterion: parsed.criterion.trim().slice(0, 200),
      runnerUp,
      runnerUpLoss: hasText(parsed.runnerUpLoss) ? parsed.runnerUpLoss.trim().slice(0, 500) : null,
    },
  };
}

export function resolvePick(idMap, verdictText) {
  const knownIds = Object.keys(idMap.candidates ?? {});
  const parsed = parsePick(verdictText, knownIds);
  if (parsed.fallback) return { ...parsed, resolved: null };
  const chosen = idMap.candidates[parsed.pick.id];
  const runnerUp = parsed.pick.runnerUp ? idMap.candidates[parsed.pick.runnerUp] : null;
  return {
    ...parsed,
    resolved: {
      laneId: chosen.laneId,
      workerId: chosen.workerId,
      runnerUpLaneId: runnerUp?.laneId ?? null,
      runnerUpWorkerId: runnerUp?.workerId ?? null,
    },
  };
}

/** Anonymous shadow record: counts and agreement only — no lane, worker, or model ids. */
export function shadowRecord(idMap, resolution, namedPickLaneId, now = new Date()) {
  if (forbiddenIdentifierViolation(idMap.round)) throw new Error('round id carries an identity token; not recording it');
  const blindLaneId = resolution.resolved?.laneId ?? null;
  return {
    schema: BLIND_SHADOW_SCHEMA,
    recordedAt: now.toISOString(),
    round: idMap.round,
    candidateCount: Object.keys(idMap.candidates ?? {}).length,
    droppedCount: (idMap.dropped ?? []).length,
    droppedReasons: [...new Set((idMap.dropped ?? []).map((d) => d.reason.split(':')[0]))].sort(),
    maskCount: idMap.maskCount ?? 0,
    fallback: resolution.fallback,
    fallbackReason: resolution.fallbackReason,
    agree: resolution.fallback ? null : blindLaneId === namedPickLaneId,
    criterion: resolution.pick?.criterion ?? null,
  };
}

function writeFileMode(file, content, mode) {
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}

function usage() {
  return [
    'usage:',
    '  a2ad-blind-view.mjs build --tasks <records.json> --round <parentRoundId> [--target <key>] --out <dir>',
    '  a2ad-blind-view.mjs resolve --out <dir> --verdict <file> [--named-pick <laneId>] [--shadow-ledger <file>]',
  ].join('\n');
}

export function main(argv) {
  const [command, ...rest] = argv;
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        tasks: { type: 'string' },
        round: { type: 'string' },
        target: { type: 'string' },
        out: { type: 'string' },
        verdict: { type: 'string' },
        'named-pick': { type: 'string' },
        'shadow-ledger': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    return 2;
  }
  if (values.help || !command || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return command ? 0 : 2;
  }
  if (!hasText(values.out)) {
    process.stderr.write('error: --out <dir> is required\n');
    return 2;
  }
  try {
    if (command === 'build') {
      if (!hasText(values.tasks)) throw new Error('--tasks <file> is required');
      const view = buildBlindView(readTasks(values.tasks), { round: values.round, target: values.target });
      fs.mkdirSync(values.out, { recursive: true, mode: 0o700 });
      writeFileMode(path.join(values.out, 'blind-bundle.md'), view.bundle, 0o644);
      writeFileMode(path.join(values.out, 'id-map.json'), `${JSON.stringify(view.idMap, null, 2)}\n`, 0o600);
      process.stdout.write(`${JSON.stringify({
        ok: true,
        bundle: path.join(values.out, 'blind-bundle.md'),
        candidates: Object.keys(view.idMap.candidates).length,
        dropped: view.idMap.dropped,
        maskCount: view.idMap.maskCount,
      })}\n`);
      return 0;
    }
    if (command === 'resolve') {
      if (!hasText(values.verdict)) throw new Error('--verdict <file> is required');
      const idMap = JSON.parse(fs.readFileSync(path.join(values.out, 'id-map.json'), 'utf8'));
      if (idMap.schema !== BLIND_VIEW_SCHEMA) throw new Error(`id-map schema mismatch: ${idMap.schema}`);
      const resolution = resolvePick(idMap, fs.readFileSync(values.verdict, 'utf8'));
      let shadow = null;
      if (hasText(values['named-pick'])) {
        shadow = shadowRecord(idMap, resolution, values['named-pick'].trim());
        if (hasText(values['shadow-ledger'])) {
          fs.appendFileSync(values['shadow-ledger'], `${JSON.stringify(shadow)}\n`);
        }
      }
      process.stdout.write(`${JSON.stringify({ ...resolution, ...(shadow ? { shadow } : {}) })}\n`);
      return resolution.fallback ? 1 : 0;
    }
    throw new Error(`unknown command '${command}'`);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    return 2;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
