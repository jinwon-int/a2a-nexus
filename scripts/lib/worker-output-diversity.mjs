// Pairwise worker-output diversity for finalizer reports (#2394, harness2
// benchmarking A2A 2/2).
//
// Quorum counts agreeing workers, but three near-identical outputs from the
// same model and prompt are one opinion, not three. harness2 records pairwise
// line Jaccard between parallel candidates (core/tree.py diversity) and treats
// agreement as support, never as independent proof. This module only MEASURES
// and LABELS; it never changes a quorum verdict (weighting is an owner
// decision tracked separately).
//
// Comparison unit: the whitespace-normalized lines of
// findings ∪ risks ∪ recommendations of each counted lane, as a set.
// Pure and offline: no broker build, no network, no filesystem.

export const DIVERSITY_METRIC = 'line_jaccard';
export const DIVERSITY_DEFAULT_THRESHOLD = 0.9;
export const DIVERSITY_MAX_PAIRS = 200;

const LINE_FIELDS = ['findings', 'risks', 'recommendations'];

function itemText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(itemText).join(' ');
  if (typeof value === 'object') return Object.values(value).map(itemText).join(' ');
  return '';
}

export function normalizeOutputLine(value) {
  return itemText(value).replace(/\s+/g, ' ').trim();
}

export function outputLineSet(output) {
  const lines = new Set();
  if (!output || typeof output !== 'object') return lines;
  for (const field of LINE_FIELDS) {
    if (!Array.isArray(output[field])) continue;
    for (const item of output[field]) {
      const line = normalizeOutputLine(item);
      if (line) lines.add(line);
    }
  }
  return lines;
}

// Two empty sets are identical (1.0): two lanes that both said nothing did
// not disagree, and nothing in them is independent evidence either.
export function lineJaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const line of a) if (b.has(line)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function mean(values) {
  return values.length ? round4(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function runtimeLabel(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text || null;
}

function pairRelation(a, b) {
  if (!a.runtime || !b.runtime) return 'unknown_runtime';
  return a.runtime === b.runtime ? 'same_runtime' : 'cross_runtime';
}

/**
 * entries: [{ id, runtime?, model?, output }]
 * Returns { metric, basis, threshold, n, n_distinct, mean_line_jaccard,
 *   independence, similarPairCount, byRelation, pairs, pairsTruncated? }.
 * independence: 'not_applicable' (n < 2), 'low' (any pair >= threshold),
 * otherwise 'ok'.
 */
export function computeWorkerOutputDiversity(entries, { threshold = DIVERSITY_DEFAULT_THRESHOLD } = {}) {
  const lanes = (Array.isArray(entries) ? entries : []).map((entry, index) => ({
    id: String(entry?.id ?? `lane-${index + 1}`),
    runtime: runtimeLabel(entry?.runtime),
    model: String(entry?.model ?? '').trim() || null,
    lines: outputLineSet(entry?.output),
  }));
  const distinct = new Set(lanes.map((lane) => [...lane.lines].sort().join('\n')));
  const pairs = [];
  let similarPairCount = 0;
  const byRelation = { same_runtime: [], cross_runtime: [], unknown_runtime: [] };
  for (let i = 0; i < lanes.length; i += 1) {
    for (let j = i + 1; j < lanes.length; j += 1) {
      const a = lanes[i];
      const b = lanes[j];
      const raw = lineJaccard(a.lines, b.lines);
      const relation = pairRelation(a, b);
      byRelation[relation].push(raw);
      // The threshold is applied to the unrounded value; only the report rounds.
      if (raw >= threshold) similarPairCount += 1;
      pairs.push({ a: a.id, b: b.id, jaccard: round4(raw), relation, aRuntime: a.runtime, bRuntime: b.runtime });
    }
  }
  const result = {
    metric: DIVERSITY_METRIC,
    basis: 'findings+risks+recommendations lines (whitespace-normalized set)',
    threshold,
    n: lanes.length,
    n_distinct: distinct.size,
    mean_line_jaccard: mean([...byRelation.same_runtime, ...byRelation.cross_runtime, ...byRelation.unknown_runtime]),
    independence: lanes.length < 2 ? 'not_applicable' : (similarPairCount > 0 ? 'low' : 'ok'),
    similarPairCount,
    byRelation: Object.fromEntries(Object.entries(byRelation).map(([relation, values]) => [
      relation,
      { pairs: values.length, mean_line_jaccard: mean(values) },
    ])),
    pairs: pairs.slice(0, DIVERSITY_MAX_PAIRS),
  };
  if (pairs.length > DIVERSITY_MAX_PAIRS) result.pairsTruncated = true;
  return result;
}

export function renderDiversityLine(diversity) {
  if (!diversity) return '';
  const meanText = diversity.mean_line_jaccard == null ? 'n/a' : diversity.mean_line_jaccard.toFixed(4);
  const relation = (key) => {
    const entry = diversity.byRelation?.[key];
    return entry?.pairs ? `${key}=${entry.mean_line_jaccard.toFixed(4)}(${entry.pairs})` : `${key}=n/a`;
  };
  return `Diversity (report-only, quorum unchanged): n=${diversity.n} n_distinct=${diversity.n_distinct} `
    + `mean_line_jaccard=${meanText} independence=${diversity.independence} `
    + `similarPairs=${diversity.similarPairCount}@>=${diversity.threshold} `
    + `${relation('same_runtime')} ${relation('cross_runtime')}`;
}
