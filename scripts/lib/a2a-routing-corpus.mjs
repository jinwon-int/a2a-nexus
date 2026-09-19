/**
 * A2A routing corpus validation — pure, synchronous, no-I/O corpus library
 * (#2196, Phase A corpus-validation slice 2).
 *
 * This module validates a versioned, closed corpus envelope
 * (`a2a.routing-corpus.v1`), produces a body-free coverage summary and a
 * deterministic SHA-256 integrity digest over the FULL corpus content, and
 * projects one record to a label-free judgment input.
 *
 * Boundaries:
 *   - Reuses the frozen foundation library `./a2a-routing-advice.mjs` for
 *     input validation (`a2a.routing-input.v1`), outcome validation
 *     (`a2a.routing-advice.v1` synthesized with a fixed validator model
 *     version) and the trusted-context eligibility gate. No contract rule
 *     from that foundation is reimplemented here.
 *   - `node:crypto` (SHA-256) is the only Node built-in used. No filesystem,
 *     network, process, or clock effects; fully synchronous; no model,
 *     provider, dispatcher, or prepare/normalize call of any kind.
 *   - Validation operates on plain JSON data only. This is a data boundary,
 *     NOT a getter/proxy sandbox; no code is evaluated.
 *   - Error results use stable codes with generic fixed messages and
 *     structural paths. They NEVER echo request text, unknown field names,
 *     or arbitrary identifier values.
 *   - `exposure` values are caller assertions, not blinding proof. This
 *     format cannot attest that a private record was unseen or that a review
 *     occurred; alias lists are declared provenance only.
 *   - The digest proves INTEGRITY only — not semantic correctness, label
 *     correctness, or group independence. An invalid corpus never yields a
 *     digest.
 *
 * Source contract: docs/specs/a2a-routing-classifier/spec.md (corpus slice
 * section). Exercised offline by scripts/lib/a2a-routing-corpus.test.mjs.
 */

import { createHash } from 'node:crypto';

import {
  ROUTING_ADVICE_SCHEMA_VERSION,
  ROUTING_CATALOG_VERSION,
  ROUTING_POLICY_VERSION,
  ROUTING_TEMPLATE_IDS,
  isRecommendationEligible,
  validateRoutingAdviceOutput,
  validateRoutingInput,
} from './a2a-routing-advice.mjs';

// ─── Versioned contract constants ───────────────────────────────────────────

/** Versioned closed corpus envelope contract. */
export const ROUTING_CORPUS_SCHEMA_VERSION = 'a2a.routing-corpus.v1';

/** Fixed model version synthesized to validate outcomes via the foundation. */
export const ROUTING_CORPUS_VALIDATOR_MODEL_VERSION = 'routing-corpus-validator.v1';

/** Finite corpus bounds. */
export const MIN_CORPUS_RECORDS = 1;
export const MAX_CORPUS_RECORDS = 2000;
/** Bounded identifier / alias lengths, counted in Unicode codepoints. */
export const MAX_IDENTIFIER_CODEPOINTS = 64;
export const MAX_ALIAS_CODEPOINTS = 64;
export const MAX_REVIEWER_ALIASES = 16;
export const MAX_ACCEPTABLE_OUTCOMES = 8;

/** Digest parameters (documented contract values). */
export const DIGEST_ALGORITHM = 'sha256';
export const DIGEST_CANONICALIZATION =
  'recursive-object-key-sort-utf16-code-unit-order/arrays-preserved/utf8';

/** Closed split vocabulary. */
export const CORPUS_SPLITS = Object.freeze(['development', 'calibration', 'holdout']);
/** Closed exposure vocabulary (caller assertions, never blinding proof). */
export const CORPUS_EXPOSURES = Object.freeze(['public_development', 'private_unexposed']);
/** Closed language vocabulary. */
export const CORPUS_LANGUAGES = Object.freeze(['ko', 'en']);
/** Closed label status vocabulary. */
export const CORPUS_LABEL_STATUSES = Object.freeze(['draft', 'reviewed', 'disputed']);

/**
 * Closed coverage-tag vocabulary: the seven template ids plus situation
 * descriptors. Tags are descriptive metadata ONLY; they never authorize or
 * produce anything and never substitute for validated label outcomes.
 */
export const COVERAGE_TAG_VOCABULARY = Object.freeze(Object.freeze([
  ...ROUTING_TEMPLATE_IDS,
  'negation',
  'quote_injection',
  'ambiguous',
  'compound',
  'missing_context',
  'unsupported_candidate',
  'control',
  'external_event',
  'attachment',
  'typo',
]));

/** Bounded identifier grammar (corpusVersion, caseId, groupId, variantId). */
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const ROOT_FIELDS = Object.freeze([
  'schemaVersion',
  'corpusVersion',
  'catalogVersion',
  'records',
]);

const RECORD_FIELDS = Object.freeze([
  'caseId',
  'groupId',
  'variantId',
  'split',
  'exposure',
  'language',
  'coverageTags',
  'input',
  'label',
]);

const LABEL_FIELDS = Object.freeze([
  'status',
  'authorAlias',
  'reviewerAliases',
  'acceptableOutcomes',
]);

const OUTCOME_FIELDS = Object.freeze(['decision', 'templateId', 'reasonCode']);

// ─── Local pure helpers ──────────────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codepointLength(s) {
  return [...s].length;
}

function isBoundedIdentifier(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    IDENTIFIER_PATTERN.test(value) &&
    codepointLength(value) <= MAX_IDENTIFIER_CODEPOINTS
  );
}

function isBoundedAlias(value) {
  return typeof value === 'string' && value.trim().length > 0 && codepointLength(value) <= MAX_ALIAS_CODEPOINTS;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * Canonical JSON: object keys recursively sorted (lexicographic UTF-16 code
 * unit order), array order preserved. Insertion order of objects can never
 * change the output; array order is the documented canonical order.
 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Order-insensitive candidate-set key (duplicate-pair detection ONLY). */
function candidateSetKey(candidateTemplateIds) {
  return [...candidateTemplateIds].sort().join('\u0000');
}

/**
 * Normalized text form for the cross-group leak rule: NFKC, trim, collapse
 * whitespace runs to a single space, lower-case. Used ONLY for integrity
 * checks, never stored or echoed.
 */
function normalizeTextForLeakCheck(text) {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function error(code, path, message) {
  return { code, path, message };
}

/** Rewrite a foundation error path (`input.x`) under a record input path. */
function remapFoundationPath(foundationPath, inputPath) {
  const prefix = 'input.';
  return foundationPath.startsWith(prefix)
    ? `${inputPath}.${foundationPath.slice(prefix.length)}`
    : inputPath;
}

function countInto(counter, key) {
  counter[key] = (counter[key] ?? 0) + 1;
}

// ─── Label + acceptable-outcome validation ──────────────────────────────────

/**
 * Validate one acceptable outcome by synthesizing an `a2a.routing-advice.v1`
 * output (fixed validator modelVersion) and reusing the frozen foundation
 * validator, then enforcing the context gate on recommends. Pushes into the
 * caller-provided label-local error array and returns a canonical
 * duplicate-detection key over the exact three closed fields, or undefined
 * when no key can be derived. Never echoes request text or identifiers.
 */
function validateAcceptableOutcome(outcome, outcomePath, validatedInput, outcomeErrors) {
  if (!isPlainObject(outcome)) {
    outcomeErrors.push(error('invalid_outcome_shape', outcomePath, 'acceptableOutcome must be a plain object'));
    return undefined;
  }
  let shapeOk = true;
  for (const key of Object.keys(outcome)) {
    if (!OUTCOME_FIELDS.includes(key)) {
      outcomeErrors.push(error('unknown_field', outcomePath, 'unexpected field'));
      shapeOk = false;
    }
  }
  for (const field of OUTCOME_FIELDS) {
    if (!(field in outcome)) {
      outcomeErrors.push(error('missing_field', outcomePath, 'required outcome field is missing'));
      shapeOk = false;
    }
  }
  if (!shapeOk) return undefined;

  const outcomeKey = canonicalJson({
    decision: outcome.decision,
    templateId: outcome.templateId,
    reasonCode: outcome.reasonCode,
  });
  if (!isPlainObject(validatedInput)) return outcomeKey;

  // Reuse the frozen foundation: validate a synthesized
  // `a2a.routing-advice.v1` output against the record's validated input with
  // the fixed validator modelVersion. This preserves the existing
  // decision/reason/templateId contract verbatim (including the
  // empty-candidate case, where recommend can never validate).
  const foundation = validateRoutingAdviceOutput(
    {
      schemaVersion: ROUTING_ADVICE_SCHEMA_VERSION,
      decision: outcome.decision,
      templateId: outcome.templateId,
      reasonCode: outcome.reasonCode,
      catalogVersion: validatedInput.catalogVersion,
      modelVersion: ROUTING_CORPUS_VALIDATOR_MODEL_VERSION,
      policyVersion: ROUTING_POLICY_VERSION,
    },
    { input: validatedInput, expectedModelVersion: ROUTING_CORPUS_VALIDATOR_MODEL_VERSION },
  );
  if (!foundation.ok) {
    outcomeErrors.push(error('outcome_invalid', outcomePath, 'acceptableOutcome was rejected by the frozen routing advice foundation contract'));
    return outcomeKey;
  }
  if (
    foundation.value.decision === 'recommend' &&
    !isRecommendationEligible(validatedInput, foundation.value.templateId)
  ) {
    outcomeErrors.push(error('outcome_context_blocked', outcomePath, 'recommend outcome is not eligible under the trusted host context'));
  }
  return outcomeKey;
}

/**
 * Validate the closed label object of one record. Alias rules are structural
 * only; alias presence is declared provenance, never proof of review.
 */
function validateLabel(label, labelPath, inputPath, validatedInput, recordErrors) {
  // Label-local error array: label validation must run to completion even
  // when earlier record-level errors exist, so its shape gate below can
  // never be tripped by unrelated record errors.
  const errors = [];
  if (!isPlainObject(label)) {
    recordErrors.push(error('invalid_label_shape', labelPath, 'label must be a plain object with exactly status, authorAlias, reviewerAliases and acceptableOutcomes'));
    return;
  }
  for (const key of Object.keys(label)) {
    if (!LABEL_FIELDS.includes(key)) {
      errors.push(error('unknown_field', labelPath, 'unexpected field'));
    }
  }
  for (const field of LABEL_FIELDS) {
    if (!(field in label)) {
      errors.push(error('missing_field', `${labelPath}.${field}`, 'required label field is missing'));
    }
  }
  if (errors.length > 0) {
    recordErrors.push(...errors);
    return;
  }

  if (!CORPUS_LABEL_STATUSES.includes(label.status)) {
    errors.push(error('invalid_label_status', `${labelPath}.status`, `label.status must be one of ${CORPUS_LABEL_STATUSES.join('|')}`));
  }
  if (!isBoundedAlias(label.authorAlias)) {
    errors.push(error('invalid_author_alias', `${labelPath}.authorAlias`, `authorAlias must be a nonblank string of at most ${MAX_ALIAS_CODEPOINTS} codepoints`));
  }

  const reviewers = label.reviewerAliases;
  if (!Array.isArray(reviewers)) {
    errors.push(error('invalid_reviewer_aliases', `${labelPath}.reviewerAliases`, 'reviewerAliases must be an array of distinct alias strings (empty allowed)'));
  } else {
    if (reviewers.length > MAX_REVIEWER_ALIASES) {
      errors.push(error('reviewer_alias_limit_exceeded', `${labelPath}.reviewerAliases`, `reviewerAliases must contain at most ${MAX_REVIEWER_ALIASES} entries`));
    }
    const seenReviewers = new Set();
    reviewers.forEach((alias, i) => {
      if (!isBoundedAlias(alias)) {
        errors.push(error('invalid_reviewer_alias', `${labelPath}.reviewerAliases[${i}]`, `reviewer aliases must be nonblank strings of at most ${MAX_ALIAS_CODEPOINTS} codepoints`));
        return;
      }
      if (seenReviewers.has(alias)) {
        errors.push(error('duplicate_reviewer_alias', `${labelPath}.reviewerAliases[${i}]`, 'reviewerAliases must be distinct'));
      }
      seenReviewers.add(alias);
      if (typeof label.authorAlias === 'string' && alias === label.authorAlias) {
        errors.push(error('author_as_reviewer', `${labelPath}.reviewerAliases[${i}]`, 'the author alias can never appear as a reviewer alias'));
      }
    });
  }

  const outcomes = label.acceptableOutcomes;
  if (!Array.isArray(outcomes)) {
    errors.push(error('invalid_acceptable_outcomes', `${labelPath}.acceptableOutcomes`, 'acceptableOutcomes must be an array of outcome objects'));
  } else {
    if (outcomes.length < 1) {
      errors.push(error('empty_acceptable_outcomes', `${labelPath}.acceptableOutcomes`, 'at least one acceptableOutcome is required'));
    }
    if (outcomes.length > MAX_ACCEPTABLE_OUTCOMES) {
      errors.push(error('outcome_limit_exceeded', `${labelPath}.acceptableOutcomes`, `acceptableOutcomes must contain at most ${MAX_ACCEPTABLE_OUTCOMES} entries`));
    }
    const seenOutcomeKeys = new Set();
    const inputOk = isPlainObject(validatedInput);
    outcomes.forEach((outcome, i) => {
      const outcomePath = `${labelPath}.acceptableOutcomes[${i}]`;
      const outcomeKey = validateAcceptableOutcome(outcome, outcomePath, inputOk ? validatedInput : null, errors);
      if (outcomeKey !== undefined) {
        if (seenOutcomeKeys.has(outcomeKey)) {
          errors.push(error('duplicate_outcome', outcomePath, 'acceptableOutcomes must be distinct'));
        }
        seenOutcomeKeys.add(outcomeKey);
      }
    });
  }

  // Status-dependent structural rules.
  const status = label.status;
  if (CORPUS_LABEL_STATUSES.includes(status)) {
    const reviewerCount = Array.isArray(reviewers)
      ? reviewers.filter((r) => typeof r === 'string' && r.trim().length > 0).length
      : 0;
    if (status === 'draft' && reviewers !== undefined && Array.isArray(reviewers) && reviewers.length > 0) {
      errors.push(error('draft_has_reviewers', `${labelPath}.reviewerAliases`, 'a draft label must not claim reviewers'));
    }
    if ((status === 'reviewed' || status === 'disputed') && reviewerCount < 1 && Array.isArray(reviewers)) {
      errors.push(error('review_requires_reviewer', `${labelPath}.reviewerAliases`, 'reviewed and disputed labels require at least one reviewer alias'));
    }
    if (status === 'disputed' && Array.isArray(outcomes)) {
      const distinct = new Set(
        outcomes
          .filter((o) => isPlainObject(o) && OUTCOME_FIELDS.every((f) => f in o))
          .map((o) => canonicalJson({ decision: o.decision, templateId: o.templateId, reasonCode: o.reasonCode })),
      );
      if (distinct.size < 2) {
        errors.push(error('disputed_requires_alternatives', `${labelPath}.acceptableOutcomes`, 'a disputed label requires at least two distinct acceptableOutcomes'));
      }
    }
  }
  recordErrors.push(...errors);
}

// ─── Record validation ───────────────────────────────────────────────────────

/**
 * Validate ONE corpus record (standalone or as part of a corpus). Returns
 * `{ ok, value?, errors? }` where value is a frozen normalized record.
 * `path` is the structural prefix used in error paths (e.g. `records[3]` or
 * `record`), never a data value.
 */
export function validateCorpusRecord(record, path = 'record') {
  const errors = [];
  if (!isPlainObject(record)) {
    return { ok: false, errors: [error('invalid_record_shape', path, 'record must be a plain object')] };
  }
  for (const key of Object.keys(record)) {
    if (!RECORD_FIELDS.includes(key)) {
      errors.push(error('unknown_field', path, 'unexpected field'));
    }
  }
  for (const field of RECORD_FIELDS) {
    if (!(field in record)) {
      errors.push(error('missing_field', `${path}.${field}`, 'required record field is missing'));
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  for (const [field, code] of [
    ['caseId', 'invalid_case_id'],
    ['groupId', 'invalid_group_id'],
    ['variantId', 'invalid_variant_id'],
  ]) {
    if (!isBoundedIdentifier(record[field])) {
      errors.push(error(code, `${path}.${field}`, `record ${field} must be a bounded identifier (nonblank, at most ${MAX_IDENTIFIER_CODEPOINTS} codepoints, pattern ${IDENTIFIER_PATTERN.source})`));
    }
  }
  if (!CORPUS_SPLITS.includes(record.split)) {
    errors.push(error('invalid_split', `${path}.split`, `split must be one of ${CORPUS_SPLITS.join('|')}`));
  }
  if (!CORPUS_EXPOSURES.includes(record.exposure)) {
    errors.push(error('invalid_exposure', `${path}.exposure`, `exposure must be one of ${CORPUS_EXPOSURES.join('|')}`));
  }
  if (!CORPUS_LANGUAGES.includes(record.language)) {
    errors.push(error('invalid_language', `${path}.language`, `language must be one of ${CORPUS_LANGUAGES.join('|')}`));
  }

  const tags = record.coverageTags;
  if (!Array.isArray(tags) || tags.length < 1) {
    errors.push(error('invalid_coverage_tags', `${path}.coverageTags`, 'coverageTags must be a nonempty array of known coverage tags'));
  } else {
    if (tags.length > COVERAGE_TAG_VOCABULARY.length) {
      errors.push(error('tag_limit_exceeded', `${path}.coverageTags`, `coverageTags must contain at most ${COVERAGE_TAG_VOCABULARY.length} entries`));
    }
    const seenTags = new Set();
    tags.forEach((tag, i) => {
      if (typeof tag !== 'string' || !COVERAGE_TAG_VOCABULARY.includes(tag)) {
        errors.push(error('unknown_coverage_tag', `${path}.coverageTags[${i}]`, 'coverage tag is not in the closed vocabulary'));
        return;
      }
      if (seenTags.has(tag)) {
        errors.push(error('duplicate_coverage_tag', `${path}.coverageTags[${i}]`, 'coverageTags must be unique'));
      }
      seenTags.add(tag);
    });
  }

  // Input: EXACT existing routing-input.v1 contract, validated by the frozen
  // foundation validator (never reimplemented here).
  const inputPath = `${path}.input`;
  let validatedInput = null;
  const inputResult = validateRoutingInput(record.input);
  if (!inputResult.ok) {
    for (const foundationError of inputResult.errors) {
      errors.push(error(foundationError.code, remapFoundationPath(foundationError.path, inputPath), foundationError.message));
    }
  } else {
    validatedInput = inputResult.value;
  }

  validateLabel(record.label, `${path}.label`, inputPath, validatedInput, errors);

  // Exposure / split / label-status gates. These are record-local (they need
  // no cross-record context), so they are enforced even when other record
  // errors exist.
  if (record.exposure === 'public_development' && record.split !== 'development') {
    errors.push(error('exposure_split_mismatch', `${path}.exposure`, 'public_development exposure is only allowed with the development split'));
  }
  if (record.split !== 'development' && record.label?.status !== 'reviewed') {
    errors.push(error('nondevelopment_requires_reviewed', `${path}.label.status`, 'calibration and holdout splits require private_unexposed exposure and a reviewed label'));
  }

  if (errors.length > 0) return { ok: false, errors };

  const value = deepFreeze({
    caseId: record.caseId,
    groupId: record.groupId,
    variantId: record.variantId,
    split: record.split,
    exposure: record.exposure,
    language: record.language,
    coverageTags: Object.freeze([...tags]),
    input: validatedInput,
    label: deepFreeze({
      status: record.label.status,
      authorAlias: record.label.authorAlias,
      reviewerAliases: Object.freeze([...record.label.reviewerAliases]),
      acceptableOutcomes: Object.freeze(
        record.label.acceptableOutcomes.map((o) => Object.freeze({
          decision: o.decision,
          templateId: o.templateId,
          reasonCode: o.reasonCode,
        })),
      ),
    }),
  });
  return { ok: true, value };
}

// ─── Corpus validation (`a2a.routing-corpus.v1`) ────────────────────────────

/**
 * Validate the versioned closed corpus envelope. Batched structured errors;
 * never throws for ordinary malformed data; error text never echoes request
 * text, unknown field names, or identifier values.
 *
 * Success value (frozen): `{ schemaVersion, corpusVersion, catalogVersion,
 * records, summary }` where `records` are frozen normalized records and
 * `summary` is a body-free coverage summary (counts only; explicit
 * denominators; outcome/tag counts may exceed the record count; no accuracy
 * or performance metric).
 *
 * @param {object} corpus candidate corpus envelope
 * @returns {{ok:true,value:object}|{ok:false,errors:object[]}}
 */
export function validateRoutingCorpus(corpus) {
  if (!isPlainObject(corpus)) {
    return { ok: false, errors: [error('invalid_corpus_shape', 'corpus', 'corpus must be a plain object')] };
  }
  const errors = [];
  for (const key of Object.keys(corpus)) {
    if (!ROOT_FIELDS.includes(key)) {
      errors.push(error('unknown_field', 'corpus', 'unexpected field'));
    }
  }
  for (const field of ROOT_FIELDS) {
    if (!(field in corpus)) {
      errors.push(error('missing_field', `corpus.${field}`, 'required field is missing'));
    }
  }
  if (corpus.schemaVersion !== undefined && corpus.schemaVersion !== ROUTING_CORPUS_SCHEMA_VERSION) {
    errors.push(error('invalid_schema_version', 'corpus.schemaVersion', `schemaVersion must be exactly ${ROUTING_CORPUS_SCHEMA_VERSION}`));
  }
  if (corpus.corpusVersion !== undefined && !isBoundedIdentifier(corpus.corpusVersion)) {
    errors.push(error('invalid_corpus_version', 'corpus.corpusVersion', `corpusVersion must be a bounded identifier (nonblank, at most ${MAX_IDENTIFIER_CODEPOINTS} codepoints, pattern ${IDENTIFIER_PATTERN.source})`));
  }
  if (corpus.catalogVersion !== undefined && corpus.catalogVersion !== ROUTING_CATALOG_VERSION) {
    errors.push(error('invalid_catalog_version', 'corpus.catalogVersion', `catalogVersion must be exactly ${ROUTING_CATALOG_VERSION}`));
  }

  const records = corpus.records;
  let recordsUsable = false;
  if (!Array.isArray(records)) {
    errors.push(error('invalid_records', 'corpus.records', 'records must be an array of corpus records'));
  } else if (records.length < MIN_CORPUS_RECORDS) {
    errors.push(error('no_records', 'corpus.records', `records must contain at least ${MIN_CORPUS_RECORDS} record`));
  } else if (records.length > MAX_CORPUS_RECORDS) {
    errors.push(error('record_limit_exceeded', 'corpus.records', `records must contain at most ${MAX_CORPUS_RECORDS} records`));
  } else {
    recordsUsable = true;
  }
  if (!recordsUsable) return { ok: false, errors };

  // Per-record validation (batched, deterministic order).
  const validatedRecords = [];
  const invalidIndexes = new Set();
  records.forEach((record, i) => {
    const result = validateCorpusRecord(record, `records[${i}]`);
    if (!result.ok) {
      invalidIndexes.add(i);
      errors.push(...result.errors);
    } else {
      validatedRecords[i] = result.value;
    }
  });

  // ─── Integrity pass (valid records only) ─────────────────────────────────
  const seenCaseIds = new Set();
  const groupInfo = new Map(); // groupId → { split, exposure }
  const variantInfo = new Map(); // `groupId\u0000variantId` → { text, language, contextKey, candidateKeys:Set }
  const normalizedTextOwner = new Map(); // normalized requestText → groupId
  const byLanguage = emptyCounter(CORPUS_LANGUAGES);
  const bySplit = emptyCounter(CORPUS_SPLITS);
  const byExposure = emptyCounter(CORPUS_EXPOSURES);
  const byLabelStatus = emptyCounter(CORPUS_LABEL_STATUSES);
  const byOutcomeDecision = emptyCounter(['recommend', 'not_a2a', 'defer']);
  const byOutcomeTemplate = emptyCounter(ROUTING_TEMPLATE_IDS);
  const byTag = emptyCounter(COVERAGE_TAG_VOCABULARY);
  const groupIds = new Set();
  const variantKeys = new Set();

  for (let i = 0; i < records.length; i += 1) {
    if (invalidIndexes.has(i)) continue;
    const record = validatedRecords[i];
    const path = `records[${i}]`;

    if (seenCaseIds.has(record.caseId)) {
      errors.push(error('duplicate_case_id', `${path}.caseId`, 'caseId must be unique across the corpus'));
    }
    seenCaseIds.add(record.caseId);

    const group = groupInfo.get(record.groupId);
    if (group === undefined) {
      groupInfo.set(record.groupId, { split: record.split, exposure: record.exposure });
    } else {
      if (group.split !== record.split) {
        errors.push(error('group_split_conflict', `${path}.split`, 'all records of one group must share the same split'));
      }
      if (group.exposure !== record.exposure) {
        errors.push(error('group_exposure_conflict', `${path}.exposure`, 'all records of one group must share the same exposure'));
      }
    }
    groupIds.add(record.groupId);

    const variantKey = `${record.groupId}\u0000${record.variantId}`;
    const contextKey = canonicalJson(record.input.hostContext);
    const candidateKey = candidateSetKey(record.input.candidateTemplateIds);
    const variant = variantInfo.get(variantKey);
    if (variant === undefined) {
      variantInfo.set(variantKey, {
        text: record.input.requestText,
        language: record.language,
        contextKey,
        candidateKeys: new Set([candidateKey]),
      });
      variantKeys.add(variantKey);
    } else {
      // Variant stability: EXACT same requestText, language and hostContext;
      // candidate sets may differ (candidate-subset pairs) but an
      // order-insensitive exact repeat is a duplicate pair.
      if (variant.text !== record.input.requestText) {
        errors.push(error('variant_text_conflict', `${path}.input.requestText`, 'records sharing group and variantId must carry the exact same requestText'));
      }
      if (variant.language !== record.language) {
        errors.push(error('variant_language_conflict', `${path}.language`, 'records sharing group and variantId must carry the same language'));
      }
      if (variant.contextKey !== contextKey) {
        errors.push(error('variant_context_conflict', `${path}.input.hostContext`, 'records sharing group and variantId must carry an identical hostContext'));
      }
      if (variant.candidateKeys.has(candidateKey)) {
        errors.push(error('duplicate_variant_input', `${path}.input.candidateTemplateIds`, 'records sharing group and variantId must not repeat the same candidate set (order-insensitive)'));
      }
      variant.candidateKeys.add(candidateKey);
    }

    // Cross-group leak rule: normalized-identical text in two DIFFERENT
    // groups is rejected regardless of split/exposure.
    const normalized = normalizeTextForLeakCheck(record.input.requestText);
    const owner = normalizedTextOwner.get(normalized);
    if (owner === undefined) {
      normalizedTextOwner.set(normalized, record.groupId);
    } else if (owner !== record.groupId) {
      errors.push(error('cross_group_text_leak', `${path}.input.requestText`, 'normalized-identical request text appears in two different groups'));
    }

    // Coverage counters (integrity and gates already passed above).
    countInto(byLanguage, record.language);
    countInto(bySplit, record.split);
    countInto(byExposure, record.exposure);
    countInto(byLabelStatus, record.label.status);
    for (const tag of record.coverageTags) countInto(byTag, tag);
    for (const outcome of record.label.acceptableOutcomes) {
      countInto(byOutcomeDecision, outcome.decision);
      if (outcome.decision === 'recommend' && typeof outcome.templateId === 'string') {
        countInto(byOutcomeTemplate, outcome.templateId);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const value = deepFreeze({
    schemaVersion: corpus.schemaVersion,
    corpusVersion: corpus.corpusVersion,
    catalogVersion: corpus.catalogVersion,
    records: Object.freeze(validatedRecords),
    summary: deepFreeze({
      records: records.length,
      groups: groupIds.size,
      variants: variantKeys.size,
      byLanguage: deepFreeze(byLanguage),
      bySplit: deepFreeze(bySplit),
      byExposure: deepFreeze(byExposure),
      byLabelStatus: deepFreeze(byLabelStatus),
      acceptableOutcomeDecisions: deepFreeze(byOutcomeDecision),
      acceptableOutcomeTemplates: deepFreeze(byOutcomeTemplate),
      coverageTags: deepFreeze(byTag),
    }),
  });
  return { ok: true, value };
}

function emptyCounter(vocabulary) {
  const counter = {};
  for (const key of vocabulary) counter[key] = 0;
  return counter;
}

// ─── Deterministic integrity digest ──────────────────────────────────────────

/**
 * Deterministic SHA-256 integrity digest over the FULL validated corpus
 * content (schemaVersion, corpusVersion, catalogVersion, every record with
 * all label/split/exposure/id/text/candidate/context fields). Canonical form:
 * object keys recursively sorted (UTF-16 code-unit order), array order
 * preserved — so JSON insertion order can never change the digest, while
 * candidate-list array order is intentionally hashed as given (candidate-set
 * order-insensitivity exists only for duplicate-pair detection). No field is
 * omitted; there is no selective hash.
 *
 * An invalid corpus NEVER produces a digest: the structured error result is
 * returned instead. The digest proves integrity only — never semantic
 * correctness, label correctness, or group independence.
 *
 * @param {object} corpus candidate corpus envelope
 * @returns {{ok:true,digest:string,algorithm:string,canonicalization:string}|{ok:false,errors:object[]}}
 */
export function routingCorpusDigest(corpus) {
  const result = validateRoutingCorpus(corpus);
  if (!result.ok) return { ok: false, errors: result.errors };
  const canonical = canonicalJson({
    schemaVersion: result.value.schemaVersion,
    corpusVersion: result.value.corpusVersion,
    catalogVersion: result.value.catalogVersion,
    records: result.value.records,
  });
  const digest = createHash(DIGEST_ALGORITHM).update(canonical, 'utf8').digest('hex');
  return { ok: true, digest, algorithm: DIGEST_ALGORITHM, canonicalization: DIGEST_CANONICALIZATION };
}

// ─── Judgment-input projection ───────────────────────────────────────────────

/**
 * Project ONE standalone record to its judgment input: a fresh, unfrozen,
 * defensive-copied `a2a.routing-input.v1` object containing ONLY the five
 * closed input fields. Labels, caseId/groupId/variantId, split, exposure and
 * coverage tags are structurally incapable of appearing (the closed input
 * contract rejects unknown fields, and the record must fully validate first).
 *
 * The record is validated with the full standalone record contract
 * (including input, label and outcome checks), so the projection can never
 * emit a structurally invalid or label-contaminated input. No model,
 * provider, dispatcher or prepare call is made.
 *
 * @param {object} record candidate corpus record
 * @returns {{ok:true,value:object}|{ok:false,errors:object[]}}
 */
export function projectCorpusJudgmentInput(record) {
  const result = validateCorpusRecord(record, 'record');
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true, value: structuredClone(result.value.input) };
}
