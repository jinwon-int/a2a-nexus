/**
 * Contract + adversarial regression suite for the #2196 Phase A corpus
 * validation slice (scripts/lib/a2a-routing-corpus.mjs).
 *
 * Coverage:
 *   - execution of the WHOLE public development fixture
 *     (fixtures/a2a-routing-advice/development-corpus.json) with the floors
 *     >= 80 groups / >= 160 base variants / >= 8 candidate-subset paired
 *     groups, all required coverage categories, no group leakage, and the
 *     required exposure/draft truth;
 *   - closed envelope schema: unknown/missing keys at every layer (root,
 *     record, input, hostContext, label, outcome), invalid versions, types,
 *     nonfinite values and improper bounds;
 *   - integrity rules: duplicate case ids, group split/exposure conflicts,
 *     same-variant text/context/language drift, order-insensitive duplicate
 *     candidate pairs, cross-group normalized-text leaks (Unicode NFKC and
 *     whitespace variants);
 *   - exposure/label-status gates: public holdout promotion, draft
 *     calibration, author self-review, duplicate aliases, disputed
 *     constraints, draft-with-reviewers;
 *   - outcome contract reuse: candidate-missing/empty recommend,
 *     wrong-context recommend, mixed decision/reason/null matrices;
 *   - deterministic full-content digest: key-order independence, sensitivity
 *     to every label/input/metadata field, candidate-order significance, and
 *     no digest for an invalid corpus;
 *   - judgment-input projection: label/metadata exclusion, mutation
 *     isolation, standalone validation;
 *   - no body reflection of synthetic sentinel keys/text in any error result.
 *
 * A tiny private reviewed corpus appears ONLY as inline synthetic test data
 * to prove the calibration/holdout gates. It is NOT an actual blind-set
 * claim. No model benchmark is run anywhere in this suite; the suite reads
 * only the fixtures and source files. Offline, synchronous, no network.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  COVERAGE_TAG_VOCABULARY,
  CORPUS_EXPOSURES,
  CORPUS_LABEL_STATUSES,
  CORPUS_LANGUAGES,
  CORPUS_SPLITS,
  DIGEST_ALGORITHM,
  MAX_ACCEPTABLE_OUTCOMES,
  MAX_ALIAS_CODEPOINTS,
  MAX_CORPUS_RECORDS,
  MAX_IDENTIFIER_CODEPOINTS,
  MAX_REVIEWER_ALIASES,
  MIN_CORPUS_RECORDS,
  ROUTING_CORPUS_SCHEMA_VERSION,
  ROUTING_CORPUS_VALIDATOR_MODEL_VERSION,
  projectCorpusJudgmentInput,
  routingCorpusDigest,
  validateCorpusRecord,
  validateRoutingCorpus,
} from './a2a-routing-corpus.mjs';
import {
  ROUTING_INPUT_SCHEMA_VERSION,
  ROUTING_CATALOG_VERSION,
  ROUTING_TEMPLATE_IDS,
  validateRoutingInput,
} from './a2a-routing-advice.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const FIXTURE_PATH = resolve(REPO_ROOT, 'fixtures/a2a-routing-advice/development-corpus.json');
const CONTRACTS_PATH = resolve(REPO_ROOT, 'fixtures/a2a-routing-advice/contracts.json');
const MODULE_PATH = resolve(HERE, 'a2a-routing-corpus.mjs');

// ─── Test-data helpers (synthetic, minimal, valid by construction) ──────────

const WRITE = Object.freeze({ interaction: 'user_request', operation: 'new_task', access: 'write_allowed' });
const READ_ONLY = Object.freeze({ interaction: 'user_request', operation: 'new_task', access: 'read_only' });

/** @returns {object} draft record, unique per call unless overridden */
function makeRecord({
  caseId = 'case-1',
  groupId = 'group-1',
  variantId = 'ko-1',
  split = 'development',
  exposure = 'public_development',
  language = 'ko',
  coverageTags = ['new_patch'],
  requestText = '고유한 합성 요청 문장입니다.',
  candidateTemplateIds = ['new_patch'],
  hostContext = WRITE,
  input: inputOverride,
  label: labelOverride,
} = {}) {
  return {
    caseId,
    groupId,
    variantId,
    split,
    exposure,
    language,
    coverageTags,
    input: inputOverride ?? {
      schemaVersion: ROUTING_INPUT_SCHEMA_VERSION,
      requestText,
      catalogVersion: ROUTING_CATALOG_VERSION,
      candidateTemplateIds,
      hostContext,
    },
    label: {
      status: 'draft',
      authorAlias: 'corpus-author',
      reviewerAliases: [],
      acceptableOutcomes: [{ decision: 'recommend', templateId: 'new_patch', reasonCode: 'matched' }],
      ...(labelOverride ?? {}),
      ...(labelOverride?.acceptableOutcomes ? { acceptableOutcomes: labelOverride.acceptableOutcomes } : {}),
    },
  };
}

function makeCorpus(records, overrides = {}) {
  return {
    schemaVersion: ROUTING_CORPUS_SCHEMA_VERSION,
    corpusVersion: 'test-corpus.1',
    catalogVersion: ROUTING_CATALOG_VERSION,
    records,
    ...overrides,
  };
}

const rec = (...args) => makeRecord(...args);

function expectOk(result, label = 'result') {
  if (!result.ok) {
    assert.fail(`${label} expected ok, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

/** Digest results carry `digest` at the top level (no `value` wrapper). */
function expectDigestOk(result, label = 'digest result') {
  if (!result.ok) {
    assert.fail(`${label} expected ok, got errors: ${JSON.stringify(result.errors)}`);
  }
  return result;
}

function expectCodes(result, codes, label = 'result') {
  assert.equal(result.ok, false, `${label} expected rejection, got ok`);
  const actual = new Set(result.errors.map((e) => e.code));
  for (const code of codes) {
    assert.ok(actual.has(code), `${label} expected code ${code}; got ${JSON.stringify(result.errors.map((e) => e.code))}`);
  }
}

function strip(key) {
  return (o) => {
    const copy = structuredClone(o);
    delete copy[key];
    return copy;
  };
}

function twoGroupCorpus() {
  return makeCorpus([
    rec({ caseId: 'c1', groupId: 'g1', variantId: 'ko-1', language: 'ko', requestText: '첫 번째 고유 요청입니다.' }),
    rec({ caseId: 'c2', groupId: 'g2', variantId: 'en-1', language: 'en', requestText: 'The second unique synthetic request.' }),
  ]);
}

// Tiny private reviewed corpus — SYNTHETIC TEST FIXTURE ONLY, not a blind-set
// claim. Proves the calibration/holdout gates (private_unexposed + reviewed).
function privateReviewedCorpus() {
  return makeCorpus(
    [
      rec({
        caseId: 'p1', groupId: 'pg1', split: 'calibration', exposure: 'private_unexposed',
        language: 'ko', coverageTags: ['new_analysis'],
        requestText: '사설 검토 코퍼스용 합성 분석 요청입니다.',
        candidateTemplateIds: ['new_analysis'], hostContext: READ_ONLY,
        label: {
          status: 'reviewed', authorAlias: 'corpus-author', reviewerAliases: ['independent-reviewer-1'],
          acceptableOutcomes: [
            { decision: 'recommend', templateId: 'new_analysis', reasonCode: 'matched' },
            { decision: 'defer', templateId: null, reasonCode: 'uncertain' },
          ],
        },
      }),
      rec({
        caseId: 'p2', groupId: 'pg2', split: 'holdout', exposure: 'private_unexposed',
        language: 'en', coverageTags: ['observe_existing'],
        requestText: 'Synthetic observe request for the sealed test fixture.',
        candidateTemplateIds: ['observe_existing'],
        hostContext: { interaction: 'user_request', operation: 'observe_existing', access: 'read_only' },
        label: {
          status: 'reviewed', authorAlias: 'corpus-author', reviewerAliases: ['independent-reviewer-1'],
          acceptableOutcomes: [{ decision: 'recommend', templateId: 'observe_existing', reasonCode: 'matched' }],
        },
      }),
    ],
    { corpusVersion: 'test-private-reviewed.1' },
  );
}

// ─── Module purity and exported surface ─────────────────────────────────────

describe('module purity (node:crypto + frozen foundation only; no I/O, clock, process)', () => {
  const source = readFileSync(MODULE_PATH, 'utf8');

  it('imports only node:crypto and the frozen advice foundation', () => {
    const specifiers = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]).sort();
    assert.deepEqual(specifiers, ['./a2a-routing-advice.mjs', 'node:crypto']);
    assert.equal(source.match(/^import /gm)?.length, 2, 'exactly two import statements');
  });

  it('touches no filesystem, network, process or clock surface', () => {
    for (const forbidden of [
      'readFileSync', 'writeFileSync', 'fetch(', 'Date.now', 'new Date(',
      'process.env', 'setTimeout', 'spawn', 'execSync', 'require(',
    ]) {
      assert.equal(source.includes(forbidden), false, `module must not reference ${forbidden}`);
    }
    assert.equal(/node:(fs|net|http|child_process|os|path|url)/.test(source), false);
  });

  it('exports the documented surface (docs/manual expose only existing functions)', () => {
    for (const name of ['validateRoutingCorpus', 'routingCorpusDigest', 'projectCorpusJudgmentInput', 'validateCorpusRecord']) {
      const mod = { validateRoutingCorpus, routingCorpusDigest, projectCorpusJudgmentInput, validateCorpusRecord };
      assert.equal(typeof mod[name], 'function', `${name} must be exported`);
    }
    assert.equal(ROUTING_CORPUS_SCHEMA_VERSION, 'a2a.routing-corpus.v1');
    assert.equal(ROUTING_CORPUS_VALIDATOR_MODEL_VERSION, 'routing-corpus-validator.v1');
    assert.equal(DIGEST_ALGORITHM, 'sha256');
    assert.ok(MIN_CORPUS_RECORDS >= 1 && MAX_CORPUS_RECORDS === 2000);
    assert.equal(MAX_IDENTIFIER_CODEPOINTS, 64);
    assert.equal(MAX_ALIAS_CODEPOINTS, 64);
    assert.equal(MAX_REVIEWER_ALIASES, 16);
    assert.equal(MAX_ACCEPTABLE_OUTCOMES, 8);
    // Closed vocabularies: seven templates + ten situation tags.
    assert.deepEqual([...COVERAGE_TAG_VOCABULARY], [
      ...ROUTING_TEMPLATE_IDS,
      'negation', 'quote_injection', 'ambiguous', 'compound', 'missing_context',
      'unsupported_candidate', 'control', 'external_event', 'attachment', 'typo',
    ]);
    assert.deepEqual([...CORPUS_SPLITS], ['development', 'calibration', 'holdout']);
    assert.deepEqual([...CORPUS_EXPOSURES], ['public_development', 'private_unexposed']);
    assert.deepEqual([...CORPUS_LANGUAGES], ['ko', 'en']);
    assert.deepEqual([...CORPUS_LABEL_STATUSES], ['draft', 'reviewed', 'disputed']);
  });
});

// ─── Whole public development fixture ───────────────────────────────────────

describe('whole public development fixture (fixtures/a2a-routing-advice/development-corpus.json)', () => {
  const corpus = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const result = validateRoutingCorpus(corpus);
  const value = result.ok ? result.value : null;

  it('validates the entire envelope without errors', () => {
    expectOk(result, 'development corpus');
  });

  it('meets the floors: >= 80 groups, >= 160 base variants, >= 8 paired groups', () => {
    assert.ok(value.summary.groups >= 80, `expected >= 80 groups, got ${value.summary.groups}`);
    assert.ok(value.summary.variants >= 160, `expected >= 160 group+variant pairs, got ${value.summary.variants}`);
    const variantCounts = new Map();
    for (const r of value.records) {
      const key = `${r.groupId}\u0000${r.variantId}`;
      variantCounts.set(key, (variantCounts.get(key) ?? 0) + 1);
    }
    const pairedVariants = [...variantCounts.values()].filter((n) => n > 1);
    const pairedGroups = new Set(
      value.records.filter((r) => (variantCounts.get(`${r.groupId}\u0000${r.variantId}`) ?? 0) > 1).map((r) => r.groupId),
    );
    assert.ok(pairedVariants.length >= 8, `expected >= 8 paired variants, got ${pairedVariants.length}`);
    assert.ok(pairedGroups.size >= 8, `expected >= 8 paired groups, got ${pairedGroups.size}`);
    // Pairs are same-text candidate-subset extras: same group+variant keeps
    // byte-identical text, language and context (validator enforces; recheck).
    const byVariant = new Map();
    for (const r of value.records) {
      const key = `${r.groupId}\u0000${r.variantId}`;
      const prior = byVariant.get(key);
      if (prior) {
        assert.equal(prior.input.requestText, r.input.requestText, key);
        assert.deepEqual(prior.input.hostContext, r.input.hostContext, key);
        assert.equal(prior.language, r.language, key);
        const a = [...prior.input.candidateTemplateIds].sort().join('|');
        const b = [...r.input.candidateTemplateIds].sort().join('|');
        assert.notEqual(a, b, `paired records must differ in candidate set: ${key}`);
      } else {
        byVariant.set(key, r);
      }
    }
  });

  it('carries every required coverage category (7 templates + all situation tags)', () => {
    for (const tag of COVERAGE_TAG_VOCABULARY) {
      assert.ok(value.summary.coverageTags[tag] >= 1, `coverage tag ${tag} must appear at least once`);
    }
    for (const templateId of ROUTING_TEMPLATE_IDS) {
      assert.ok(value.summary.acceptableOutcomeTemplates[templateId] >= 1, `template ${templateId} must appear as a recommend outcome`);
    }
  });

  it('asserts the required exposure/draft truth (public exposed development, draft, no reviewers)', () => {
    for (const r of value.records) {
      assert.equal(r.split, 'development', r.caseId);
      assert.equal(r.exposure, 'public_development', r.caseId);
      assert.equal(r.label.status, 'draft', r.caseId);
      assert.equal(r.label.authorAlias, 'corpus-author', r.caseId);
      assert.deepEqual(r.label.reviewerAliases, [], r.caseId);
    }
    assert.equal(value.summary.bySplit.development, value.summary.records);
    assert.equal(value.summary.byExposure.public_development, value.summary.records);
    assert.equal(value.summary.byLabelStatus.draft, value.summary.records);
    // Bilingual: every group has at least one ko and one en record.
    const langs = new Map();
    for (const r of value.records) {
      const set = langs.get(r.groupId) ?? new Set();
      set.add(r.language);
      langs.set(r.groupId, set);
    }
    for (const [groupId, set] of langs) {
      assert.ok(set.has('ko') && set.has('en'), `group ${groupId} must be bilingual`);
    }
    assert.ok(value.summary.byLanguage.ko >= 80 && value.summary.byLanguage.en >= 80);
  });

  it('reports a body-free coverage summary with explicit denominators and no score', () => {
    assert.deepEqual(Object.keys(value.summary).sort(), [
      'acceptableOutcomeDecisions', 'acceptableOutcomeTemplates', 'byExposure',
      'byLabelStatus', 'byLanguage', 'bySplit', 'coverageTags', 'groups',
      'records', 'variants',
    ]);
    assert.equal(value.summary.records, value.records.length);
    const noScore = JSON.stringify(value.summary);
    assert.equal(/accuracy|score|percent|latency|quality/i.test(noScore), false, 'summary must not carry performance claims');
    // Multi-outcome/tag denominators: outcome+tag instances may exceed records.
    const outcomeTotal = Object.values(value.summary.acceptableOutcomeDecisions).reduce((a, b) => a + b, 0);
    const tagTotal = Object.values(value.summary.coverageTags).reduce((a, b) => a + b, 0);
    assert.ok(outcomeTotal >= value.summary.records);
    assert.ok(tagTotal >= value.summary.records);
  });

  it('is independent of the illustrative contracts.json fixture (no shared groups)', () => {
    const contracts = JSON.parse(readFileSync(CONTRACTS_PATH, 'utf8'));
    assert.equal(contracts.caseCount, contracts.cases.length);
    const contractGroups = new Set(contracts.cases.map((c) => c.group));
    for (const r of value.records) {
      assert.equal(contractGroups.has(r.groupId), false, `group ${r.groupId} must not collide with illustrative contract groups`);
    }
  });

  it('produces a stable digest for the fixture and projects every record', () => {
    const d1 = expectDigestOk(routingCorpusDigest(corpus), 'fixture digest');
    assert.match(d1.digest, /^[0-9a-f]{64}$/);
    const d2 = expectDigestOk(routingCorpusDigest(corpus), 'fixture digest re-run');
    assert.equal(d1.digest, d2.digest);

    const seenTexts = new Set();
    for (const record of corpus.records) {
      const projected = expectOk(projectCorpusJudgmentInput(record), record.caseId);
      assert.deepEqual(Object.keys(projected).sort(), [
        'candidateTemplateIds', 'catalogVersion', 'hostContext', 'requestText', 'schemaVersion',
      ]);
      assert.equal('label' in projected, false);
      assert.equal('caseId' in projected, false);
      assert.equal('coverageTags' in projected, false);
      assert.equal(validateRoutingInput(projected).ok, true, record.caseId);
      seenTexts.add(projected.requestText);
      if (seenTexts.size === 1) {
        // Mutation isolation on the first projection.
        projected.requestText = 'tampered';
        projected.hostContext.interaction = 'control';
        const again = expectOk(projectCorpusJudgmentInput(corpus.records[0]), 're-projection');
        assert.notEqual(again.requestText, 'tampered');
        assert.equal(again.hostContext.interaction, 'user_request');
      }
    }
  });
});

// ─── Envelope schema: layers, versions, types, bounds ───────────────────────

describe('closed envelope schema (unknown/missing keys nested at every layer)', () => {
  it('rejects non-object corpora without throwing', () => {
    for (const garbage of [null, undefined, 42, 'corpus', [], true]) {
      const result = validateRoutingCorpus(garbage);
      assert.equal(result.ok, false);
    }
  });

  it('rejects unknown and missing keys at the root', () => {
    expectCodes(validateRoutingCorpus({ ...twoGroupCorpus(), sentinelUnknownKey42: 1 }), ['unknown_field']);
    expectCodes(validateRoutingCorpus(strip('schemaVersion')(twoGroupCorpus())), ['missing_field']);
    expectCodes(validateRoutingCorpus(strip('corpusVersion')(twoGroupCorpus())), ['missing_field']);
    expectCodes(validateRoutingCorpus(strip('catalogVersion')(twoGroupCorpus())), ['missing_field']);
    expectCodes(validateRoutingCorpus(strip('records')(twoGroupCorpus())), ['missing_field']);
  });

  it('rejects wrong versions at root and pinned catalog mismatches', () => {
    expectCodes(validateRoutingCorpus(makeCorpus(twoGroupCorpus().records, { schemaVersion: 'a2a.routing-corpus.v2' })), ['invalid_schema_version']);
    expectCodes(validateRoutingCorpus(makeCorpus(twoGroupCorpus().records, { corpusVersion: 42 })), ['invalid_corpus_version']);
    expectCodes(validateRoutingCorpus(makeCorpus(twoGroupCorpus().records, { corpusVersion: 'spaces spaces' })), ['invalid_corpus_version']);
    expectCodes(validateRoutingCorpus(makeCorpus(twoGroupCorpus().records, { catalogVersion: 'a2a.routing-templates.v2' })), ['invalid_catalog_version']);
  });

  it('rejects non-array, empty, and over-limit record arrays', () => {
    expectCodes(validateRoutingCorpus(makeCorpus('nope')), ['invalid_records']);
    expectCodes(validateRoutingCorpus(makeCorpus([])), ['no_records']);
    const flood = Array.from({ length: MAX_CORPUS_RECORDS + 1 }, (_, i) =>
      rec({ caseId: `c${i}`, groupId: `g${i}`, requestText: `Unique synthetic request number ${i}.` }));
    expectCodes(validateRoutingCorpus(makeCorpus(flood)), ['record_limit_exceeded']);
    const atLimit = flood.slice(0, MAX_CORPUS_RECORDS);
    assert.equal(validateRoutingCorpus(makeCorpus(atLimit)).ok, true, `${MAX_CORPUS_RECORDS} records must be allowed`);
  });

  it('rejects unknown/missing keys and bad identifiers at the record layer', () => {
    expectCodes(validateRoutingCorpus(makeCorpus([{ ...rec(), sentinelUnknownKey42: true }])), ['unknown_field']);
    expectCodes(validateRoutingCorpus(makeCorpus([strip('caseId')(rec())])), ['missing_field']);
    expectCodes(validateRoutingCorpus(makeCorpus([strip('label')(rec())])), ['missing_field']);
    expectCodes(validateRoutingCorpus(makeCorpus([null])), ['invalid_record_shape']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ caseId: 'bad id!' })])), ['invalid_case_id']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ caseId: '-leading' })])), ['invalid_case_id']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ groupId: 'x'.repeat(MAX_IDENTIFIER_CODEPOINTS + 1) })])), ['invalid_group_id']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ variantId: 7 })])), ['invalid_variant_id']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ split: 'public' })])), ['invalid_split']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ exposure: 'public' })])), ['invalid_exposure']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ language: 'fr' })])), ['invalid_language']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ coverageTags: [] })])), ['invalid_coverage_tags']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ coverageTags: ['new_patch', 'new_patch'] })])), ['duplicate_coverage_tag']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ coverageTags: ['sentinel_tag'] })])), ['unknown_coverage_tag']);
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ coverageTags: [...COVERAGE_TAG_VOCABULARY, 'extra'] })])),
      ['unknown_coverage_tag'],
    );
  });

  it('enforces the input contract by passing through the frozen foundation validator', () => {
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ input: { ...rec().input, sentinelUnknownKey42: 1 } })])), ['unknown_field']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ input: strip('requestText')(rec().input) })])), ['missing_field']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ input: strip('hostContext')(rec().input) })])), ['missing_field']);
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ input: { ...rec().input, hostContext: { ...WRITE, sentinelUnknownKey42: 1 } } })])),
      ['unknown_field'],
    );
    // Label-shaped contamination inside the input is an unknown field there.
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ input: { ...rec().input, label: { status: 'draft' } } })])),
      ['unknown_field'],
    );
    // requestText codepoint bound (4000 ok / 4001 rejected), multibyte safe.
    const fourThousand = '가'.repeat(4000);
    assert.equal(validateRoutingCorpus(makeCorpus([rec({ requestText: fourThousand })])).ok, true);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ requestText: `${'가'.repeat(4000)}가` })])), ['invalid_request_text']);
  });

  it('enforces finite bounds on aliases, reviewers, outcomes and tags', () => {
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ label: { authorAlias: 'x'.repeat(MAX_ALIAS_CODEPOINTS + 1) } })])), ['invalid_author_alias']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ label: { authorAlias: '' } })])), ['invalid_author_alias']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ label: { authorAlias: Infinity } })])), ['invalid_author_alias']);
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ label: { reviewerAliases: Array.from({ length: MAX_REVIEWER_ALIASES + 1 }, (_, i) => `r${i}`) } })])),
      ['reviewer_alias_limit_exceeded'],
    );
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ label: { acceptableOutcomes: Array.from({ length: MAX_ACCEPTABLE_OUTCOMES + 1 }, () => ({ decision: 'defer', templateId: null, reasonCode: 'uncertain' })) } })])),
      ['outcome_limit_exceeded', 'duplicate_outcome'],
    );
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ label: { acceptableOutcomes: [] } })])), ['empty_acceptable_outcomes']);
  });

  it('rejects unknown/missing keys at the label and outcome layers', () => {
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ label: { sentinelUnknownKey42: 1 } })])), ['unknown_field']);
    const arrayLabelRecord = rec();
    arrayLabelRecord.label = [];
    expectCodes(validateRoutingCorpus(makeCorpus([arrayLabelRecord])), ['invalid_label_shape']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ label: { status: 'draft', authorAlias: 'a', reviewerAliases: [], acceptableOutcomes: [{ decision: 'recommend', templateId: 'new_patch', reasonCode: 'matched', sentinelUnknownKey42: 1 }] } })])), ['unknown_field']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ label: { status: 'draft', authorAlias: 'a', reviewerAliases: [], acceptableOutcomes: [{ decision: 'recommend', templateId: 'new_patch' }] } })])), ['missing_field']);
    expectCodes(validateRoutingCorpus(makeCorpus([rec({ label: { status: 'bogus', authorAlias: 'a', reviewerAliases: [], acceptableOutcomes: [{ decision: 'recommend', templateId: 'new_patch', reasonCode: 'matched' }] } })])), ['invalid_label_status']);
  });
});

// ─── Integrity injections ────────────────────────────────────────────────────

describe('integrity rules (ids, group/variant stability, duplicates, leaks)', () => {
  it('rejects duplicate case ids', () => {
    const corpus = makeCorpus([
      rec({ caseId: 'dup', groupId: 'g1', requestText: 'First text.' }),
      rec({ caseId: 'dup', groupId: 'g2', requestText: 'Second text.' }),
    ]);
    expectCodes(validateRoutingCorpus(corpus), ['duplicate_case_id']);
  });

  it('rejects a group spanning two splits or two exposures', () => {
    expectCodes(
      validateRoutingCorpus(makeCorpus([
        rec({ caseId: 'c1', groupId: 'g1', requestText: 'Text one.' }),
        rec({ caseId: 'c2', groupId: 'g1', split: 'calibration', exposure: 'private_unexposed', label: { status: 'reviewed', reviewerAliases: ['rev-1'] }, requestText: 'Text two.' }),
      ])),
      ['group_split_conflict', 'group_exposure_conflict'],
    );
    expectCodes(
      validateRoutingCorpus(makeCorpus([
        rec({ caseId: 'c1', groupId: 'g1', requestText: 'Text one.' }),
        rec({ caseId: 'c2', groupId: 'g1', exposure: 'private_unexposed', requestText: 'Text two.' }),
      ])),
      ['group_exposure_conflict'],
    );
  });

  it('rejects same-variant text, context or language drift but allows candidate-subset pairs', () => {
    const base = rec({ caseId: 'c1', groupId: 'g1', variantId: 'ko-1', requestText: '같은 변형 문장입니다.' });
    expectCodes(
      validateRoutingCorpus(makeCorpus([base, { ...structuredClone(base), caseId: 'c2', input: { ...base.input, requestText: '다른 변형 문장입니다.' } }])),
      ['variant_text_conflict'],
    );
    expectCodes(
      validateRoutingCorpus(makeCorpus([base, { ...structuredClone(base), caseId: 'c2', language: 'en' }])),
      ['variant_language_conflict'],
    );
    // Context drift: both records individually valid, differing only in the
    // trusted host context.
    const driftBase = rec({ caseId: 'c1', groupId: 'g1', variantId: 'ko-1', requestText: '같은 변형 문장입니다.' });
    const drifted = {
      ...structuredClone(driftBase),
      caseId: 'c2',
      language: 'ko',
      coverageTags: ['new_analysis'],
      input: { ...structuredClone(driftBase).input, hostContext: READ_ONLY, candidateTemplateIds: ['new_analysis'] },
      label: {
        status: 'draft', authorAlias: 'corpus-author', reviewerAliases: [],
        acceptableOutcomes: [{ decision: 'recommend', templateId: 'new_analysis', reasonCode: 'matched' }],
      },
    };
    expectCodes(validateRoutingCorpus(makeCorpus([driftBase, drifted])), ['variant_context_conflict']);
    // Candidate-subset pair on the same group+variant: valid (the pair's
    // label carries an outcome valid for its own candidate list).
    const pair = makeCorpus([
      base,
      {
        ...structuredClone(base),
        caseId: 'c2',
        input: { ...structuredClone(base).input, candidateTemplateIds: [] },
        label: {
          status: 'draft', authorAlias: 'corpus-author', reviewerAliases: [],
          acceptableOutcomes: [{ decision: 'defer', templateId: null, reasonCode: 'no_candidate' }],
        },
      },
    ]);
    expectOk(validateRoutingCorpus(pair), 'subset pair');
    // Exact repeat of the same candidate set, even reordered: rejected.
    expectCodes(
      validateRoutingCorpus(makeCorpus([
        rec({ caseId: 'c1', groupId: 'g1', requestText: 'Pair text.', candidateTemplateIds: ['new_patch', 'docs_patch'] }),
        rec({ caseId: 'c2', groupId: 'g1', requestText: 'Pair text.', candidateTemplateIds: ['docs_patch', 'new_patch'] }),
      ])),
      ['duplicate_variant_input'],
    );
  });

  it('rejects normalized-identical text across different groups (NFKC, case, whitespace)', () => {
    const variants = [
      ['Fix the login bug now.', 'Fix the login bug now.'],
      ['Fix  the  login bug now.', 'fix the login bug now.'],
      ['  fix the login bug now.  ', 'Fix the login bug now.'],
      ['Ｆｉｘ ｔｈｅ ｌｏｇｉｎ ｂｕｇ.', 'Fix the login bug.'],
      ['로그인 버그를 고쳐 주세요.', '로그인  버그를  고쳐 주세요.'],
    ];
    for (const [a, b] of variants) {
      const result = validateRoutingCorpus(makeCorpus([
        rec({ caseId: 'c1', groupId: 'g1', requestText: a }),
        rec({ caseId: 'c2', groupId: 'g2', requestText: b }),
      ]));
      expectCodes(result, ['cross_group_text_leak'], JSON.stringify([a, b]));
    }
    // Same group: normalized-identical text across variants is not the leak rule.
    expectOk(
      validateRoutingCorpus(makeCorpus([
        rec({ caseId: 'c1', groupId: 'g1', variantId: 'ko-1', requestText: 'Same normalized text.' }),
        rec({ caseId: 'c2', groupId: 'g1', variantId: 'en-1', requestText: 'same normalized TEXT.' }),
      ])),
      'same-group variants',
    );
  });
});

// ─── Exposure / split / label-status gates ──────────────────────────────────

describe('exposure, split and label-status gates', () => {
  it('rejects public_development outside the development split (holdout promotion)', () => {
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ caseId: 'c1', split: 'holdout', exposure: 'public_development' })])),
      ['exposure_split_mismatch', 'nondevelopment_requires_reviewed'],
    );
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ caseId: 'c1', split: 'calibration', exposure: 'public_development' })])),
      ['exposure_split_mismatch', 'nondevelopment_requires_reviewed'],
    );
  });

  it('rejects draft or disputed labels outside the development split (draft calibration)', () => {
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ caseId: 'c1', split: 'calibration', exposure: 'private_unexposed' })])),
      ['nondevelopment_requires_reviewed'],
    );
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ caseId: 'c1', split: 'holdout', exposure: 'private_unexposed', label: { status: 'disputed', acceptableOutcomes: [{ decision: 'defer', templateId: null, reasonCode: 'uncertain' }, { decision: 'not_a2a', templateId: null, reasonCode: 'not_applicable' }] } })])),
      ['nondevelopment_requires_reviewed'],
    );
  });

  it('allows development split with private exposure, reviewed or disputed development records', () => {
    expectOk(validateRoutingCorpus(makeCorpus([
      rec({ caseId: 'c1', exposure: 'private_unexposed', requestText: 'Private development record one.' }),
    ])), 'private development draft');
    expectOk(validateRoutingCorpus(makeCorpus([
      rec({ caseId: 'c2', requestText: 'Reviewed development record.', label: { status: 'reviewed', reviewerAliases: ['rev-1'] } }),
    ])), 'reviewed development');
    expectOk(validateRoutingCorpus(makeCorpus([
      rec({
        caseId: 'c3', requestText: 'Disputed development record.',
        label: {
          status: 'disputed', reviewerAliases: ['rev-1'],
          acceptableOutcomes: [
            { decision: 'recommend', templateId: 'new_patch', reasonCode: 'matched' },
            { decision: 'defer', templateId: null, reasonCode: 'uncertain' },
          ],
        },
      }),
    ])), 'disputed development');
  });

  it('accepts the tiny synthetic private reviewed corpus (fixture only, no blind-set claim)', () => {
    const value = expectOk(validateRoutingCorpus(privateReviewedCorpus()), 'private reviewed corpus');
    assert.equal(value.summary.bySplit.calibration, 1);
    assert.equal(value.summary.bySplit.holdout, 1);
    assert.equal(value.summary.byExposure.private_unexposed, 2);
    assert.equal(value.summary.byLabelStatus.reviewed, 2);
    assert.ok(routingCorpusDigest(privateReviewedCorpus()).ok);
  });
});

// ─── Label reviewer/alias rules ─────────────────────────────────────────────

describe('label reviewer rules (declared provenance only)', () => {
  it('rejects draft labels claiming reviewers', () => {
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ label: { reviewerAliases: ['rev-1'] } })])),
      ['draft_has_reviewers'],
    );
  });

  it('rejects reviewed labels without a distinct non-author reviewer (author self-review)', () => {
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ label: { status: 'reviewed' } })])),
      ['review_requires_reviewer'],
    );
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ label: { status: 'reviewed', reviewerAliases: ['corpus-author'] } })])),
      ['author_as_reviewer'],
    );
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ label: { status: 'disputed', acceptableOutcomes: [{ decision: 'defer', templateId: null, reasonCode: 'uncertain' }, { decision: 'not_a2a', templateId: null, reasonCode: 'not_applicable' }] } })])),
      ['review_requires_reviewer'],
    );
  });

  it('rejects duplicate reviewer aliases and disputed labels without two distinct alternatives', () => {
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ label: { status: 'reviewed', reviewerAliases: ['rev-1', 'rev-1'] } })])),
      ['duplicate_reviewer_alias'],
    );
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ label: { status: 'disputed', reviewerAliases: ['rev-1'], acceptableOutcomes: [{ decision: 'defer', templateId: null, reasonCode: 'uncertain' }] } })])),
      ['disputed_requires_alternatives'],
    );
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({
        label: {
          status: 'disputed', reviewerAliases: ['rev-1'],
          acceptableOutcomes: [{ decision: 'defer', templateId: null, reasonCode: 'uncertain' }, { decision: 'defer', templateId: null, reasonCode: 'uncertain' }],
        },
      })])),
      ['duplicate_outcome', 'disputed_requires_alternatives'],
    );
    expectOk(validateRoutingCorpus(makeCorpus([rec({
      caseId: 'c9', requestText: 'A valid disputed record with alternatives.',
      label: {
        status: 'disputed', reviewerAliases: ['rev-1'],
        acceptableOutcomes: [
          { decision: 'recommend', templateId: 'new_patch', reasonCode: 'matched' },
          { decision: 'not_a2a', templateId: null, reasonCode: 'not_applicable' },
        ],
      },
    })])), 'valid disputed');
  });
});

// ─── Outcome contract (frozen foundation reuse) ─────────────────────────────

describe('acceptable outcomes reuse the frozen advisory contract', () => {
  it('rejects recommend missing from candidates and empty-candidate recommend', () => {
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ candidateTemplateIds: ['docs_patch'], coverageTags: ['docs_patch'], label: { acceptableOutcomes: [{ decision: 'recommend', templateId: 'new_patch', reasonCode: 'matched' }] } })])),
      ['outcome_invalid'],
    );
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ candidateTemplateIds: [], coverageTags: ['unsupported_candidate'], label: { acceptableOutcomes: [{ decision: 'recommend', templateId: 'new_patch', reasonCode: 'matched' }] } })])),
      ['outcome_invalid'],
    );
  });

  it('rejects context-blocked recommends (read-only access, control interaction, unspecified operation)', () => {
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({ hostContext: READ_ONLY, label: { acceptableOutcomes: [{ decision: 'recommend', templateId: 'new_patch', reasonCode: 'matched' }] } })])),
      ['outcome_context_blocked'],
    );
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({
        hostContext: { interaction: 'control', operation: 'unspecified', access: 'read_only' },
        candidateTemplateIds: ['observe_existing'],
        coverageTags: ['control'],
        label: { acceptableOutcomes: [{ decision: 'recommend', templateId: 'observe_existing', reasonCode: 'matched' }] },
      })])),
      ['outcome_context_blocked'],
    );
    expectCodes(
      validateRoutingCorpus(makeCorpus([rec({
        hostContext: { interaction: 'user_request', operation: 'unspecified', access: 'read_only' },
        coverageTags: ['missing_context', 'new_analysis'],
        candidateTemplateIds: ['new_analysis'],
        label: { acceptableOutcomes: [{ decision: 'recommend', templateId: 'new_analysis', reasonCode: 'matched' }] },
      })])),
      ['outcome_context_blocked'],
    );
  });

  it('rejects mixed decision/reason/null-template matrices (foundation contract preserved)', () => {
    const bad = [
      { decision: 'defer', templateId: null, reasonCode: 'matched' },
      { decision: 'recommend', templateId: 'new_patch', reasonCode: 'not_applicable' },
      { decision: 'not_a2a', templateId: 'new_patch', reasonCode: 'not_applicable' },
      { decision: 'defer', templateId: 'new_patch', reasonCode: 'uncertain' },
      { decision: 'not_a2a', templateId: null, reasonCode: 'uncertain' },
      { decision: 'recommend', templateId: null, reasonCode: 'matched' },
      { decision: 'defer', templateId: null, reasonCode: 'no_such_reason' },
    ];
    for (const outcome of bad) {
      expectCodes(
        validateRoutingCorpus(makeCorpus([rec({ label: { acceptableOutcomes: [outcome] } })])),
        ['outcome_invalid'],
        JSON.stringify(outcome),
      );
    }
  });

  it('accepts every valid decision/reason combination', () => {
    const good = [
      { decision: 'recommend', templateId: 'new_patch', reasonCode: 'matched' },
      { decision: 'not_a2a', templateId: null, reasonCode: 'not_applicable' },
      ...['ambiguous', 'insufficient_context', 'no_candidate', 'unsupported_template', 'uncertain'].map((reasonCode) => ({
        decision: 'defer', templateId: null, reasonCode,
      })),
    ];
    for (const outcome of good) {
      expectOk(
        validateRoutingCorpus(makeCorpus([rec({ caseId: `c-${outcome.reasonCode}`, requestText: `Valid outcome case ${outcome.reasonCode}.`, label: { acceptableOutcomes: [outcome] } })])),
        JSON.stringify(outcome),
      );
    }
  });
});

// ─── Digest determinism, sensitivity, and fail-closed behavior ──────────────

describe('routingCorpusDigest (full-content, key-order independent, fail-closed)', () => {
  it('is independent of JSON object insertion order at every layer', () => {
    const ordered = twoGroupCorpus();
    const reordered = {
      records: [
        {
          label: { acceptableOutcomes: [{ reasonCode: 'matched', templateId: 'new_patch', decision: 'recommend' }], reviewerAliases: [], authorAlias: 'corpus-author', status: 'draft' },
          input: { hostContext: { access: WRITE.access, operation: WRITE.operation, interaction: WRITE.interaction }, candidateTemplateIds: ['new_patch'], catalogVersion: ROUTING_CATALOG_VERSION, requestText: ordered.records[0].input.requestText, schemaVersion: ROUTING_INPUT_SCHEMA_VERSION },
          coverageTags: ['new_patch'],
          language: 'ko',
          exposure: 'public_development',
          split: 'development',
          variantId: 'ko-1',
          groupId: 'g1',
          caseId: 'c1',
        },
        {
          label: { acceptableOutcomes: [{ reasonCode: 'matched', templateId: 'new_patch', decision: 'recommend' }], reviewerAliases: [], authorAlias: 'corpus-author', status: 'draft' },
          input: { hostContext: { access: WRITE.access, operation: WRITE.operation, interaction: WRITE.interaction }, candidateTemplateIds: ['new_patch'], catalogVersion: ROUTING_CATALOG_VERSION, requestText: ordered.records[1].input.requestText, schemaVersion: ROUTING_INPUT_SCHEMA_VERSION },
          coverageTags: ['new_patch'],
          language: 'en',
          exposure: 'public_development',
          split: 'development',
          variantId: 'en-1',
          groupId: 'g2',
          caseId: 'c2',
        },
      ],
      catalogVersion: ROUTING_CATALOG_VERSION,
      corpusVersion: 'test-corpus.1',
      schemaVersion: ROUTING_CORPUS_SCHEMA_VERSION,
    };
    const d1 = expectDigestOk(routingCorpusDigest(ordered));
    const d2 = expectDigestOk(routingCorpusDigest(reordered));
    assert.equal(d1.digest, d2.digest);
    assert.equal(d1.algorithm, 'sha256');
    assert.match(d1.digest, /^[0-9a-f]{64}$/);
  });

  it('senses every metadata, input and label field (each mutation changes the digest)', () => {
    const base = twoGroupCorpus();
    const baseDigest = expectDigestOk(routingCorpusDigest(base)).digest;
    const mutations = {
      'corpusVersion': (c) => { c.corpusVersion = 'test-corpus.2'; },
      'caseId': (c) => { c.records[0].caseId = 'case-1-renamed'; },
      'groupId': (c) => { c.records[0].groupId = 'group-1-renamed'; },
      'variantId': (c) => { c.records[0].variantId = 'ko-2'; },
      'language': (c) => { c.records[0].language = 'en'; },
      'coverageTags': (c) => { c.records[0].coverageTags = ['new_patch', 'typo']; },
      'requestText': (c) => { c.records[0].input.requestText = '변경된 고유 요청 문장입니다.'; },
      'candidateTemplateIds': (c) => { c.records[0].input.candidateTemplateIds = ['new_patch', 'docs_patch']; },
      'hostContext': (c) => { c.records[0].input.hostContext = READ_ONLY; c.records[0].input.candidateTemplateIds = ['new_analysis']; c.records[0].coverageTags = ['new_analysis']; c.records[0].label.acceptableOutcomes = [{ decision: 'recommend', templateId: 'new_analysis', reasonCode: 'matched' }]; },
      'label.status': (c) => { c.records[0].label.status = 'reviewed'; c.records[0].label.reviewerAliases = ['rev-1']; },
      'authorAlias': (c) => { c.records[0].label.authorAlias = 'other-author'; },
      'acceptableOutcomes': (c) => { c.records[0].label.acceptableOutcomes = [{ decision: 'recommend', templateId: 'new_patch', reasonCode: 'matched' }, { decision: 'defer', templateId: null, reasonCode: 'uncertain' }]; },
    };
    for (const [name, mutate] of Object.entries(mutations)) {
      const copy = structuredClone(base);
      mutate(copy);
      const result = routingCorpusDigest(copy);
      assert.ok(result.ok, `${name} mutation must stay valid`);
      assert.notEqual(result.digest, baseDigest, `digest must sense ${name}`);
    }
    // Candidate ORDER is hashed as given (canonical array order) even though
    // duplicate DETECTION is order-insensitive: reordering changes the digest.
    const reordered = structuredClone(base);
    reordered.records[0].input.candidateTemplateIds = ['new_patch'];
    reordered.records[0].input.candidateTemplateIds = ['docs_patch', 'new_patch'];
    reordered.records[0].input.candidateTemplateIds = ['new_patch', 'docs_patch'];
    // (restore same SET, different order than base)
    const swap = structuredClone(base);
    swap.records[0].input.candidateTemplateIds = ['new_patch'];
    swap.records[0].input.candidateTemplateIds = ['new_patch'];
    const withTwo = structuredClone(base);
    withTwo.records[0].input.candidateTemplateIds = ['docs_patch', 'new_patch'];
    const withTwoReordered = structuredClone(base);
    withTwoReordered.records[0].input.candidateTemplateIds = ['new_patch', 'docs_patch'];
    const dWithTwo = expectDigestOk(routingCorpusDigest(withTwo)).digest;
    const dReordered = expectDigestOk(routingCorpusDigest(withTwoReordered)).digest;
    assert.notEqual(dWithTwo, dReordered, 'candidate array order is part of the canonical digest');
    assert.notEqual(dWithTwo, baseDigest);
    assert.notEqual(dReordered, baseDigest);
  });

  it('never returns a digest for an invalid corpus (validated data only)', () => {
    const invalid = twoGroupCorpus();
    invalid.records[1].caseId = 'c1';
    const result = routingCorpusDigest(invalid);
    expectCodes(result, ['duplicate_case_id']);
    assert.equal('digest' in result, false);
    assert.equal(routingCorpusDigest(null).ok, false);
  });

  it('senses label status and split on the private reviewed corpus', () => {
    const base = privateReviewedCorpus();
    const baseDigest = expectDigestOk(routingCorpusDigest(base)).digest;
    const moved = structuredClone(base);
    moved.records[0].split = 'holdout';
    assert.notEqual(expectDigestOk(routingCorpusDigest(moved)).digest, baseDigest);
    const reviewer = structuredClone(base);
    reviewer.records[0].label.reviewerAliases = ['independent-reviewer-2'];
    assert.notEqual(expectDigestOk(routingCorpusDigest(reviewer)).digest, baseDigest);
  });
});

// ─── Judgment-input projection ──────────────────────────────────────────────

describe('projectCorpusJudgmentInput (label-free, defensively copied, standalone)', () => {
  it('returns exactly the five closed input fields and nothing else', () => {
    const record = rec({
      caseId: 'proj-1', groupId: 'gproj', split: 'development', exposure: 'public_development',
      coverageTags: ['new_patch', 'typo'],
      label: { acceptableOutcomes: [{ decision: 'recommend', templateId: 'new_patch', reasonCode: 'matched' }] },
    });
    const result = projectCorpusJudgmentInput(record);
    const value = expectOk(result);
    assert.deepEqual(Object.keys(value).sort(), [
      'candidateTemplateIds', 'catalogVersion', 'hostContext', 'requestText', 'schemaVersion',
    ]);
    const serialized = JSON.stringify(value);
    for (const forbidden of ['caseId', 'groupId', 'variantId', 'split', 'exposure', 'coverageTags', 'label', 'authorAlias', 'reviewerAliases', 'acceptableOutcomes', 'status', 'draft']) {
      assert.equal(serialized.includes(`"${forbidden}"`), false, `projection must not carry ${forbidden}`);
    }
    assert.equal(validateRoutingInput(value).ok, true);
  });

  it('is mutation-isolated in both directions and stable across calls', () => {
    const record = rec({ hostContext: { ...WRITE } });
    const baseline = expectOk(projectCorpusJudgmentInput(record));
    // Caller-side tampering of a returned projection...
    const tampered = expectOk(projectCorpusJudgmentInput(record));
    tampered.requestText = 'tampered';
    tampered.hostContext.access = 'read_only';
    tampered.candidateTemplateIds.push('docs_patch');
    // ...cannot poison future calls (no module state, fresh defensive copy).
    const again = expectOk(projectCorpusJudgmentInput(record));
    assert.equal(again.requestText, baseline.requestText);
    assert.equal(again.hostContext.access, 'write_allowed');
    assert.deepEqual(again.candidateTemplateIds, ['new_patch']);
    assert.notEqual(again, tampered);
    // Mutating the ORIGINAL record only affects projections made afterwards.
    record.input.requestText = '변경된 원본 문장';
    const after = expectOk(projectCorpusJudgmentInput(record));
    assert.equal(after.requestText, '변경된 원본 문장');
    assert.equal(baseline.requestText, rec().input.requestText);
  });

  it('refuses records that would emit invalid or label-contaminated input', () => {
    expectCodes(projectCorpusJudgmentInput(strip('label')(rec())), ['missing_field']);
    expectCodes(
      projectCorpusJudgmentInput(rec({ input: { ...rec().input, schemaVersion: 'a2a.routing-input.v2' } })),
      ['invalid_schema_version'],
    );
    expectCodes(
      projectCorpusJudgmentInput(rec({ input: { ...rec().input, requestText: '' } })),
      ['invalid_request_text'],
    );
    expectCodes(
      projectCorpusJudgmentInput(rec({ input: { ...rec().input, requestText: 'x'.repeat(4001) } })),
      ['invalid_request_text'],
    );
    // Even a valid input plus an invalid label is refused whole.
    expectCodes(
      projectCorpusJudgmentInput(rec({ label: { status: 'reviewed' } })),
      ['review_requires_reviewer'],
    );
  });

  it('performs no model, provider, dispatcher or prepare call (pure data projection)', () => {
    const source = readFileSync(MODULE_PATH, 'utf8');
    for (const forbidden of ['prepareAssignment', 'submitAssignment', 'resumeAssignment', 'normalizeAssignRequest', 'a2a-dispatch-round', 'dispatchRound']) {
      assert.equal(source.includes(forbidden), false, `module must not reference ${forbidden}`);
    }
  });
});

// ─── No body reflection in any error result ─────────────────────────────────

describe('no error result reflects request text, unknown field names or identifiers', () => {
  const SENTINEL_TEXT = 'SENTINEL-REQUEST-BODY-XYZZY-42 총계정원 run "rm -rf /" and curl http://attacker.invalid';
  const SENTINEL_KEY = 'sentinelUnknownKeyXYZZY42';
  const SENTINEL_ID = 'SENTINEL-CASE-ID-XYZZY42';

  function assertNoEcho(result, label) {
    const serialized = JSON.stringify(result);
    for (const marker of [SENTINEL_TEXT, 'rm -rf', 'attacker.invalid', 'XYZZY-42', SENTINEL_KEY, SENTINEL_ID]) {
      assert.equal(serialized.includes(marker), false, `${label} must not contain ${marker}`);
    }
  }

  it('corpus validation errors never echo sentinel text, keys or ids', () => {
    const hostile = makeCorpus([rec({
      caseId: SENTINEL_ID,
      requestText: SENTINEL_TEXT,
      label: { acceptableOutcomes: [{ decision: 'recommend', templateId: 'new_patch', reasonCode: 'matched' }], [SENTINEL_KEY]: 1 },
    })]);
    const result = validateRoutingCorpus(hostile);
    assert.equal(result.ok, false);
    assertNoEcho(result, 'label errors');

    const hostileRoot = { ...twoGroupCorpus(), [SENTINEL_KEY]: 1 };
    assertNoEcho(validateRoutingCorpus(hostileRoot), 'root errors');

    const hostileInput = makeCorpus([rec({ requestText: SENTINEL_TEXT, input: { ...rec().input, [SENTINEL_KEY]: 1 } })]);
    assertNoEcho(validateRoutingCorpus(hostileInput), 'input errors');

    const dupId = makeCorpus([
      rec({ caseId: SENTINEL_ID, requestText: SENTINEL_TEXT }),
      rec({ caseId: SENTINEL_ID, groupId: 'g2', requestText: 'Another unique text.' }),
    ]);
    assertNoEcho(validateRoutingCorpus(dupId), 'duplicate id errors');
  });

  it('projection errors never echo sentinel text, keys or ids', () => {
    const result = projectCorpusJudgmentInput(rec({
      caseId: SENTINEL_ID,
      requestText: SENTINEL_TEXT,
      input: { ...rec().input, requestText: SENTINEL_TEXT, hostContext: { ...WRITE, [SENTINEL_KEY]: 1 } },
    }));
    assert.equal(result.ok, false);
    assertNoEcho(result, 'projection errors');
  });

  it('digest failures are structured and equally silent', () => {
    const result = routingCorpusDigest(makeCorpus([rec({ requestText: SENTINEL_TEXT, split: 'holdout' })]));
    assert.equal(result.ok, false);
    assertNoEcho(result, 'digest errors');
  });
});

// ─── Standalone record validation surface ───────────────────────────────────

describe('validateCorpusRecord (single-record surface used by the projection)', () => {
  it('validates a standalone record and freezes the normalized value', () => {
    const record = rec();
    const result = validateCorpusRecord(record);
    const value = expectOk(result);
    assert.equal(value.caseId, 'case-1');
    assert.equal(Object.isFrozen(value), true);
    assert.equal(Object.isFrozen(value.label), true);
    assert.throws(() => { value.caseId = 'changed'; }, TypeError);
  });

  it('uses structural paths only (indexes, never data values)', () => {
    const result = validateRoutingCorpus(makeCorpus([rec({ caseId: '' }), rec({ caseId: '' })]));
    assert.equal(result.ok, false);
    for (const e of result.errors) {
      assert.match(e.path, /^(corpus|records\[\d+\]|record)(\.|$)/, `path must be structural: ${e.path}`);
    }
  });
});

// Append only surviving regression cases to final worker test file; imports are aliases to avoid collisions.
import { test as corpusFinalizerTest } from 'node:test';
import corpusFinalizerAssert from 'node:assert/strict';
import {
  validateRoutingCorpus as corpusFinalizerValidate,
  routingCorpusDigest as corpusFinalizerDigest,
  projectCorpusJudgmentInput as corpusFinalizerProject,
} from './a2a-routing-corpus.mjs';
const corpusFinalizerRecord = () => ({
  caseId: 'finalizer-case', groupId: 'finalizer-group', variantId: 'en',
  split: 'development', exposure: 'public_development', language: 'en', coverageTags: ['new_analysis'],
  input: {
    schemaVersion: 'a2a.routing-input.v1', catalogVersion: 'a2a.routing-templates.v1',
    requestText: 'Ask an A2A worker to investigate the parser failure without code changes.',
    candidateTemplateIds: ['new_analysis'],
    hostContext: { interaction: 'user_request', operation: 'new_task', access: 'read_only' },
  },
  label: { status: 'draft', authorAlias: 'synthetic-author', reviewerAliases: [],
    acceptableOutcomes: [{ decision: 'recommend', templateId: 'new_analysis', reasonCode: 'matched' }] },
});
const corpusFinalizerEnvelope = record => ({ schemaVersion: 'a2a.routing-corpus.v1', corpusVersion: 'finalizer-v1', catalogVersion: 'a2a.routing-templates.v1', records: [record] });
corpusFinalizerTest('finalizer: label shape errors cannot be dropped or normalized away', () => {
  for (const mutate of [
    label => { label.synthetic_unknown_field = 'synthetic marker'; },
    label => { delete label.status; },
    label => { delete label.authorAlias; },
    label => { delete label.reviewerAliases; },
    label => { delete label.acceptableOutcomes; },
  ]) {
    const r = corpusFinalizerRecord(); mutate(r.label);
    for (const fn of [corpusFinalizerValidate, corpusFinalizerDigest]) {
      let out;
      corpusFinalizerAssert.doesNotThrow(() => { out = fn(corpusFinalizerEnvelope(r)); });
      corpusFinalizerAssert.equal(out.ok, false);
      corpusFinalizerAssert.equal('digest' in out, false);
    }
    let projection;
    corpusFinalizerAssert.doesNotThrow(() => { projection = corpusFinalizerProject(r); });
    corpusFinalizerAssert.equal(projection.ok, false);
    corpusFinalizerAssert.equal('value' in projection, false);
  }
});
corpusFinalizerTest('finalizer: standalone judgment projection preserves split and exposure gates', () => {
  for (const split of ['calibration', 'holdout']) {
    const publicRecord = corpusFinalizerRecord();
    publicRecord.split = split;
    publicRecord.label.status = 'reviewed'; publicRecord.label.reviewerAliases = ['independent-reviewer'];
    corpusFinalizerAssert.equal(corpusFinalizerValidate(corpusFinalizerEnvelope(publicRecord)).ok, false);
    corpusFinalizerAssert.equal(corpusFinalizerProject(publicRecord).ok, false);
    const privateDraft = corpusFinalizerRecord();
    privateDraft.split = split; privateDraft.exposure = 'private_unexposed';
    corpusFinalizerAssert.equal(corpusFinalizerValidate(corpusFinalizerEnvelope(privateDraft)).ok, false);
    corpusFinalizerAssert.equal(corpusFinalizerProject(privateDraft).ok, false);
    privateDraft.label.status = 'reviewed'; privateDraft.label.reviewerAliases = ['independent-reviewer'];
    corpusFinalizerAssert.deepEqual(corpusFinalizerProject(privateDraft), { ok: true, value: privateDraft.input });
  }
});

corpusFinalizerTest('finalizer: malformed nested outcome values reject before canonical hashing', () => {
  const nested = JSON.parse('{"nested":'.repeat(3000) + 'null' + '}'.repeat(3000));
  for (const field of ['decision', 'templateId', 'reasonCode']) {
    for (const status of ['draft', 'disputed']) {
      for (const validInput of [true, false]) {
        const r = corpusFinalizerRecord();
        if (!validInput) r.input.hostContext.operation = 'invalid-operation';
        if (status === 'disputed') {
          r.label.status = status;
          r.label.reviewerAliases = ['independent-reviewer'];
          r.label.acceptableOutcomes.push({ decision: 'defer', templateId: null, reasonCode: 'uncertain' });
        }
        r.label.acceptableOutcomes[0][field] = nested;
        for (const fn of [corpusFinalizerValidate, corpusFinalizerDigest]) {
          let result;
          corpusFinalizerAssert.doesNotThrow(() => { result = fn(corpusFinalizerEnvelope(r)); });
          corpusFinalizerAssert.equal(result.ok, false);
          corpusFinalizerAssert.equal('digest' in result, false);
        }
        let projection;
        corpusFinalizerAssert.doesNotThrow(() => { projection = corpusFinalizerProject(r); });
        corpusFinalizerAssert.equal(projection.ok, false);
      }
    }
  }
});
